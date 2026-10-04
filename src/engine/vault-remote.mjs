// Remote search for a store registered with `search: "remote"` (vault-stores.json v2).
//
// The server holds the index and answers `POST /v1/stores/<id>/search`; this side adds the
// read-your-writes guarantee. The server's answer is as of its `indexedCommit`, so anything this
// clone changed after that point — commits not yet pushed or indexed, and uncommitted edits — is
// searched locally with the same analyzer, the server's hits for those paths are dropped, and
// the local hits take their place. A deleted path simply drops out.
//
// Failure is loud: an unreachable or refusing server is an error that names `--local`; the
// search never switches to the local copy on its own (No Silent Fallback).

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  analyzeVaultDocument,
  crossesSecretDir,
  extractSearchTerms,
  isSearchCorpusPath,
  projectSearchHit,
  resolveSearchScope,
} from "./vault-search.mjs";
import { resolveHomeRelative } from "./vault-stores.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const SUPPLEMENT_HEADROOM = 64;

export class RemoteSearchError extends Error {
  constructor(message) {
    super(message);
    this.code = "VAULT_REMOTE_SEARCH";
  }
}

function remoteFailure(reason) {
  return new RemoteSearchError(`서버 검색 불가(${reason}). 맥 사본에서 찾으려면 --local`);
}

/** Bearer token for a store: KUMA_VAULT_TOKEN, else `remote.tokenFile` (plain text or JSON `{ token }`). */
export function resolveRemoteToken(entry, env = process.env) {
  if (typeof env.KUMA_VAULT_TOKEN === "string" && env.KUMA_VAULT_TOKEN.trim()) return env.KUMA_VAULT_TOKEN.trim();
  const file = entry.remote?.tokenFile;
  if (!file) return null;
  const text = readFileSync(resolve(resolveHomeRelative(file)), "utf8").trim();
  if (text.startsWith("{")) {
    const token = JSON.parse(text).token;
    if (typeof token !== "string" || !token) throw new Error(`${file}: no "token" field`);
    return token;
  }
  return text;
}

export async function remoteRequest(entry, path, { method = "GET", body, env = process.env, timeoutMs } = {}) {
  const url = `${entry.remote.server}/v1/stores/${entry.remote.store}/${path}`;
  const headers = { Accept: "application/json" };
  const token = resolveRemoteToken(entry, env);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const limitMs = timeoutMs ?? (Number(env.KUMA_VAULT_REMOTE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(limitMs),
    });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.name ?? "network";
    throw remoteFailure(`${entry.remote.server} 연결 실패: ${cause}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = text.trim();
    try {
      message = JSON.parse(text).message ?? message;
    } catch {
      // not JSON
    }
    throw remoteFailure(`HTTP ${response.status}: ${message.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw remoteFailure("응답이 JSON 이 아님");
  }
}

function git(cwd, args) {
  return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args).toString("utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Paths (tree-relative) this clone changed after `indexedCommit`: committed since the merge-base
 * of the indexed commit and HEAD, plus every uncommitted change (untracked included). When the
 * indexed commit has not been fetched yet, the remote-tracking main stands in for it.
 */
export function localChangesSince(rootDir, indexedCommit) {
  const root = realpathSync(rootDir);
  const top = git(root, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  const prefix = relative(realpathSync(top), root).split("\\").join("/");
  const scope = prefix ? `${prefix}/` : "";
  const toTree = (repoPath) => (scope && repoPath.startsWith(scope) ? repoPath.slice(scope.length) : scope ? null : repoPath);
  const paths = new Set();
  let base = null;
  let baseSource = "indexed-commit";
  if (indexedCommit && tryGit(top, ["cat-file", "-e", `${indexedCommit}^{commit}`]) !== null) base = indexedCommit;
  if (!base) {
    const tracking = tryGit(top, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]);
    if (tracking) {
      base = tracking;
      baseSource = "origin/main";
    }
  }
  const head = tryGit(top, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (base && head) {
    const mergeBase = tryGit(top, ["merge-base", base, head]);
    if (mergeBase && mergeBase !== head) {
      const out = git(top, ["-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", mergeBase, head, "--", scope || "."]);
      for (const p of out.toString("utf8").split("\0")) if (p) paths.add(p);
    }
  } else if (head) {
    baseSource = "none";
  }
  const status = git(top, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", scope || "."]);
  for (const record of status.toString("utf8").split("\0")) {
    if (record.length > 3) paths.add(record.slice(3));
  }
  const treePaths = new Set();
  for (const p of paths) {
    const t = toTree(p);
    if (t) treePaths.add(t);
  }
  return { paths: treePaths, base, baseSource };
}

function compareDocuments(a, b) {
  return (
    b.entityMatchCount - a.entityMatchCount
    || b.contentMatchCount - a.contentMatchCount
    || a.path.localeCompare(b.path)
  );
}

/**
 * Search one remote store with the read-your-writes supplement. Returns the engine's result
 * shape (`engine: "remote"`) plus `remote: { server, store, indexedCommit, supplementFiles,
 * supplementHits, base, ms }`.
 */
export async function searchRemoteStore({ rootDir, entry, query, mode = "search", limit = 20, env = process.env }) {
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) throw new Error("vault-search requires a non-empty query.");
  const started = Date.now();
  let request = limit + SUPPLEMENT_HEADROOM;
  let server = await remoteRequest(entry, "search", { method: "POST", body: { q: normalizedQuery, limit: request, mode }, env });
  const changes = localChangesSince(rootDir, server.indexedCommit);
  if (changes.paths.size > SUPPLEMENT_HEADROOM && server.hits.length >= request) {
    request = Math.min(limit + changes.paths.size, 1000);
    server = await remoteRequest(entry, "search", { method: "POST", body: { q: normalizedQuery, limit: request, mode }, env });
  }

  const { profile } = resolveSearchScope(rootDir);
  const terms = extractSearchTerms(normalizedQuery);
  const local = [];
  for (const path of changes.paths) {
    if (!isSearchCorpusPath(path, profile) || crossesSecretDir(path)) continue;
    const full = resolve(rootDir, path);
    if (!existsSync(full) || !lstatSync(full).isFile()) continue;
    const document = analyzeVaultDocument(path, await readFile(full, "utf8"), terms);
    if (document) local.push(projectSearchHit(document, mode));
  }

  const kept = server.hits.filter((hit) => !changes.paths.has(hit.path) && !crossesSecretDir(hit.path));
  const merged = local.length > 0 ? [...kept, ...local].sort(compareDocuments) : kept;
  const hits = merged.slice(0, limit);
  return {
    mode,
    engine: "remote",
    engineReason: `server ${server.engine}${server.engineReason ? ` (${server.engineReason})` : ""}`,
    query: normalizedQuery,
    vaultDir: resolve(rootDir),
    corpusFiles: server.corpusFiles,
    candidateFiles: server.candidateFiles,
    scannedFiles: server.corpusFiles,
    entityMatchCount: hits.reduce((n, h) => n + h.entityMatchCount, 0),
    contentMatchCount: hits.reduce((n, h) => n + h.contentMatchCount, 0),
    limit,
    ...(server.droppedTerms ? { droppedTerms: server.droppedTerms } : {}),
    remote: {
      server: entry.remote.server,
      store: entry.remote.store,
      indexedCommit: server.indexedCommit,
      supplementFiles: changes.paths.size,
      supplementHits: local.length,
      base: changes.baseSource,
      serverMs: server.ms ?? null,
      ms: Date.now() - started,
    },
    hits,
  };
}

/** The footer line the design asks for: `색인 기준 <sha 9자> · 로컬 보충 N파일`. */
export function formatRemoteFooter(remote) {
  return `색인 기준 ${String(remote.indexedCommit ?? "").slice(0, 9)} · 로컬 보충 ${remote.supplementFiles}파일`;
}

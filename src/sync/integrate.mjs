// FETCH, INTEGRATE and PUSH of one tick (design 2.2-2.4).
//
// Integration is a merge, never a rebase: local commits keep their sha (agents write a commit's
// sha into plan evidence right after committing). The branch only ever moves by
// `git merge --ff-only`, which moves the ref atomically and refuses — changing nothing — when it
// would overwrite a dirty work-tree file; the daemon then waits until that file is quiet and
// autosaved. A diverged branch is merged with `merge-tree --write-tree` into a commit M built
// off to the side; conflicts are settled by rule (2.4) so the server's version keeps the path
// and the local version is committed next to it under `_sync-conflicts/`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileGitignore } from "../server/gitignore-match.mjs";
import { DAEMON_SUBJECT } from "./context.mjs";
import { git, gitEnv, gitRetry, isAncestor, revParse, splitNul } from "./git.mjs";

const NULL_SHA = "0000000000000000000000000000000000000000";
const INDEX_START = "<!-- vault-index:start -->"; // engine vault-ingest.mjs VAULT_INDEX_START_MARKER
const INDEX_END = "<!-- vault-index:end -->";
const DERIVED_GRAPH = compileGitignore(["plans/**/*.graph.json"], { ignoreCase: true });

/** What a failed fetch/push says about the link: offline | auth | other. */
export function classifyTransportError(text) {
  if (/returned error: 40[13]|Authentication failed|could not read Username|could not read Password|terminal prompts disabled/i.test(text)) return "auth";
  if (/Could not resolve host|Failed to connect|Connection refused|Couldn'?t connect|timed out|Empty reply from server|Connection reset|returned error: 50[0234]|Recv failure|Network is unreachable|No route to host|Connection closed|unexpected disconnect|the remote end hung up|LFS: .*(dial tcp|connection refused|EOF)|dial tcp|batch response:/i.test(text)) return "offline";
  return "other";
}

function remoteLines(text) {
  return String(text)
    .split("\n")
    .filter((l) => /^remote:/.test(l))
    .map((l) => l.replace(/^remote:\s*/, "").trim())
    .filter(Boolean);
}

export async function fetchOrigin(ctx) {
  const result = await gitRetry(["fetch", "--quiet", "--no-tags", "origin"], { cwd: ctx.repo, allowFail: true });
  if (result.code === 0) return { ok: true };
  return { ok: false, kind: classifyTransportError(result.stderr), message: result.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400) };
}

/** `git merge --ff-only <target>`; `{ ok }` or `{ ok:false, dirty:true }` when a dirty file is in the way. */
export async function fastForward(ctx, target) {
  const result = await gitRetry(["merge", "--ff-only", "--quiet", "--no-edit", target], { cwd: ctx.repo, allowFail: true });
  if (result.code === 0) return { ok: true };
  const text = `${result.stdout.toString("utf8")}\n${result.stderr}`;
  if (/would be overwritten|untracked working tree files would be|Your local changes/i.test(text)) return { ok: false, dirty: true, message: text.trim().slice(0, 400) };
  if (/Not possible to fast-forward|not something we can merge|Diverging branches/i.test(text)) return { ok: false, moved: true, message: text.trim().slice(0, 400) };
  return { ok: false, message: text.trim().slice(0, 400) };
}

function parseMergeTree(stdout) {
  const tokens = splitNul(stdout);
  const tree = tokens[0];
  const entries = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t([\s\S]*)$/.exec(tokens[i]);
    if (!match) break;
    entries.push({ mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] });
  }
  return { tree, entries };
}

async function blobText(ctx, oid) {
  return (await git(["cat-file", "blob", oid], { cwd: ctx.repo })).stdout;
}

async function hashBlob(ctx, content) {
  return (await git(["hash-object", "-w", "--stdin"], { cwd: ctx.repo, input: content })).stdout.toString("utf8").trim();
}

async function attr(ctx, path, name) {
  const out = (await git(["check-attr", "-z", name, "--", path], { cwd: ctx.repo })).stdout;
  const parts = splitNul(out);
  return parts[2] ?? "unspecified";
}

function stripIndexRegions(text) {
  let out = "";
  let rest = text;
  for (;;) {
    const start = rest.indexOf(INDEX_START);
    if (start < 0) return out + rest;
    const end = rest.indexOf(INDEX_END, start);
    if (end < 0) return out + rest;
    out += rest.slice(0, start + INDEX_START.length);
    rest = rest.slice(end);
  }
}

async function unionMerge(ctx, stages) {
  const dir = mkdtempSync(join(tmpdir(), "vault-syncd-union-"));
  try {
    const files = {};
    for (const [name, stage] of [["base", 1], ["ours", 2], ["theirs", 3]]) {
      files[name] = join(dir, name);
      writeFileSync(files[name], stages[stage] ? await blobText(ctx, stages[stage].oid) : "");
    }
    const result = await git(["merge-file", "--union", "-p", files.ours, files.base, files.theirs], { cwd: ctx.repo, allowFail: true });
    if (result.code < 0 || result.code > 127) throw new Error(`git merge-file --union failed: ${result.stderr}`);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function localStamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** ISO-8601 with the local UTC offset (`2026-10-05T03:15:12+09:00`). */
export function isoLocal(ms) {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${p(offset / 60)}:${p(offset % 60)}`;
}

export function conflictsDir(ctx) {
  return `${ctx.treeRel ? `${ctx.treeRel}/` : ""}_sync-conflicts`;
}

/**
 * Merge diverged L and R into a commit M (parents L, R) without touching the work tree or the
 * index. Returns `{ commit, records }` — the conflict records written into M.
 */
export async function buildMerge(ctx, L, R, { clock = Date.now } = {}) {
  const mt = await git(["merge-tree", "--write-tree", "-z", L, R], { cwd: ctx.repo, allowFail: true });
  if (mt.code !== 0 && mt.code !== 1) throw new Error(`git merge-tree failed (${mt.code}): ${mt.stderr.trim()}`);
  const { tree, entries } = parseMergeTree(mt.stdout);
  if (!/^[0-9a-f]{40,64}$/.test(tree ?? "")) throw new Error(`git merge-tree gave no tree: ${mt.stderr.trim()}`);

  const now = clock();
  const date = new Date(now);
  const stamp = localStamp(date);
  const dir = conflictsDir(ctx);
  const ledgerPath = `${dir}/conflicts.jsonl`;
  const groups = new Map();
  for (const e of entries) {
    const g = groups.get(e.path) ?? {};
    g[e.stage] = e;
    groups.set(e.path, g);
  }

  const updates = []; // index-info lines
  const records = [];
  let ledgerUnion = null;
  // ids continue from the ledger, so two merges within one second never reuse an id
  const ledgerAtTree = await git(["cat-file", "blob", `${tree}:${ledgerPath}`], { cwd: ctx.repo, allowFail: true });
  const idPrefix = `c-${stamp}-${ctx.host}-`;
  const usedIds = new Set();
  if (ledgerAtTree.code === 0) {
    for (const line of ledgerAtTree.stdout.toString("utf8").split("\n")) {
      try {
        const id = JSON.parse(line)?.id;
        if (typeof id === "string" && id.startsWith(idPrefix)) usedIds.add(id);
      } catch {
        // not a record line
      }
    }
  }
  let n = usedIds.size;
  const copyRoot = `${dir}/${stamp}-${ctx.host}${n ? `-${n}` : ""}`;
  const record = (path, cls, kept, copy, status = "open") => {
    n += 1;
    records.push({
      id: `c-${stamp}-${ctx.host}-${n}`,
      ts: isoLocal(now),
      host: ctx.host,
      path,
      class: cls,
      localCommit: L,
      remoteCommit: R,
      kept,
      copy,
      status,
    });
  };

  for (const [path, stages] of groups) {
    const ours = stages[2];
    const theirs = stages[3];
    const treePath = ctx.treePath(path);
    if (path === ledgerPath || (await attr(ctx, path, "merge")) === "union") {
      const merged = await unionMerge(ctx, stages);
      const oid = await hashBlob(ctx, merged);
      if (path === ledgerPath) ledgerUnion = merged;
      updates.push(`${(theirs ?? ours).mode} ${oid}\t${path}`);
      continue;
    }
    if (treePath !== null && DERIVED_GRAPH(treePath)) {
      updates.push(theirs ? `${theirs.mode} ${theirs.oid}\t${path}` : `0 ${NULL_SHA}\t${path}`);
      record(path, "derived", "remote", null, "resolved");
      continue;
    }
    if (ours && theirs && /(^|\/)README\.md$/i.test(path) && stages[1]) {
      const base = (await blobText(ctx, stages[1].oid)).toString("utf8");
      const mine = (await blobText(ctx, ours.oid)).toString("utf8");
      if (stripIndexRegions(base) === stripIndexRegions(mine)) {
        // local only touched the generated index region: the next `vault sync` regenerates it
        updates.push(`${theirs.mode} ${theirs.oid}\t${path}`);
        record(path, "derived", "remote", null, "resolved");
        continue;
      }
    }
    if (ours && theirs) {
      const copy = `${copyRoot}/${path}`;
      updates.push(`${theirs.mode} ${theirs.oid}\t${path}`);
      updates.push(`${ours.mode} ${ours.oid}\t${copy}`);
      record(path, "general", "remote", copy);
      continue;
    }
    if (ours && !theirs) {
      updates.push(`${ours.mode} ${ours.oid}\t${path}`); // remote deleted, local changed: keep the change
      record(path, "delete-modify", "local", null);
      continue;
    }
    if (theirs && !ours) {
      updates.push(`${theirs.mode} ${theirs.oid}\t${path}`); // local deleted, remote changed: keep the change
      record(path, "delete-modify", "remote", null);
    }
  }

  if (records.length > 0) {
    let ledger = ledgerUnion;
    if (ledger === null) ledger = ledgerAtTree.code === 0 ? ledgerAtTree.stdout : Buffer.alloc(0);
    let text = ledger.toString("utf8");
    if (text && !text.endsWith("\n")) text += "\n";
    text += records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    updates.push(`100644 ${await hashBlob(ctx, text)}\t${ledgerPath}`);
  }

  let finalTree = tree;
  if (updates.length > 0) {
    const indexFile = join(ctx.gitDir, "vault-syncd.merge-index");
    const env = gitEnv({ GIT_INDEX_FILE: indexFile });
    try {
      await git(["read-tree", tree], { cwd: ctx.repo, env });
      await git(["update-index", "-z", "--index-info"], { cwd: ctx.repo, env, input: `${updates.join("\0")}\0` });
      finalTree = (await git(["write-tree"], { cwd: ctx.repo, env })).stdout.toString("utf8").trim();
    } finally {
      rmSync(indexFile, { force: true });
    }
  }
  const body = records.length ? `\n\n${records.length} conflict(s) kept under ${copyRoot}` : "";
  const commit = (
    await git(["commit-tree", finalTree, "-p", L, "-p", R, "-m", `${DAEMON_SUBJECT}merge ${ctx.host}${body}`], { cwd: ctx.repo })
  ).stdout.toString("utf8").trim();
  return { commit, records };
}

/**
 * Bring local main and origin/main together. Returns
 * `{ action: "none"|"push"|"ff"|"merged"|"wait-dirty"|"retry", records? }`.
 */
export async function integrate(ctx, { clock = Date.now } = {}) {
  const L = await revParse(ctx.repo, "refs/heads/main");
  const R = await revParse(ctx.repo, "refs/remotes/origin/main");
  if (!R) return { action: L ? "push" : "none" };
  if (!L) {
    const ff = await fastForward(ctx, R);
    return ff.ok ? { action: "ff" } : { action: ff.dirty ? "wait-dirty" : "retry", message: ff.message };
  }
  if (L === R) return { action: "none" };
  if (await isAncestor(ctx.repo, R, L)) return { action: "push" };
  if (await isAncestor(ctx.repo, L, R)) {
    const ff = await fastForward(ctx, R);
    if (ff.ok) return { action: "ff" };
    return { action: ff.dirty ? "wait-dirty" : "retry", message: ff.message };
  }
  const { commit, records } = await buildMerge(ctx, L, R, { clock });
  const ff = await fastForward(ctx, commit);
  if (ff.ok) return { action: "merged", commit, records };
  return { action: ff.dirty ? "wait-dirty" : "retry", message: ff.message, records: [] };
}

/** Upload LFS objects, then push main. */
export async function pushMain(ctx) {
  const lfs = await gitRetry(["lfs", "push", "origin", "main"], { cwd: ctx.repo, allowFail: true });
  if (lfs.code !== 0) {
    const kind = classifyTransportError(lfs.stderr);
    return { ok: false, kind: kind === "other" ? "lfs" : kind, message: `LFS 올리기 실패: ${lfs.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` };
  }
  const result = await gitRetry(["push", "--porcelain", "origin", "refs/heads/main:refs/heads/main"], { cwd: ctx.repo, allowFail: true });
  if (result.code === 0) return { ok: true };
  const text = `${result.stdout.toString("utf8")}\n${result.stderr}`;
  if (/\[rejected\].*(fetch first|non-fast-forward)|\(fetch first\)|\(non-fast-forward\)/.test(text)) return { ok: false, kind: "nonff" };
  if (/\[remote rejected\]|pre-receive hook declined/.test(text)) {
    const lines = remoteLines(text).filter((l) => !/^kuma-vault: push 를 받지 않습니다/.test(l));
    return { ok: false, kind: "rejected", message: `막힘: ${(lines.join(" / ") || "서버가 push 를 거부").slice(0, 400)}` };
  }
  const kind = classifyTransportError(text);
  return { ok: false, kind, message: text.trim().split("\n").slice(-3).join(" | ").slice(0, 400) };
}

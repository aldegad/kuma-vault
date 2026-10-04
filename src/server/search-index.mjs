// Server-side search index of a served store (docs/server.md "Search").
//
// The index is built from git OBJECTS of `origin.git`, never from the `tree/` checkout: a pushed
// tree may carry symlinks (receive rule 3 accepts link targets, even ones pointing outside the
// store), and anything read through the filesystem would follow them. Reading `ls-tree` + blobs
// means a symlink is just a mode-120000 entry that is skipped, and nothing outside the object
// store is ever opened. The same holds at query time: candidate documents are re-read as
// `<indexed commit>:<path>` blobs, so a hit always matches the commit the index claims.
//
//   <store>/index/vault-fts.db   SQLite FTS5 (trigram), same rows as the engine's local `.fts/`
//   <store>/state/index.json     { indexedCommit, lastSeq, indexedAt, docCount, mode, ms }
//   <store>/state/index.lock     one indexer at a time (serve's loop or `vault server reindex`)
//
// The index lives beside `state/`, not inside `tree/` (an attacker-shaped checkout) and not
// inside `state/` (backed up — the index is rebuildable).
//
// Increments: post-receive appends ref events to `state/events.jsonl`; the indexer consumes the
// events after `lastSeq`, diffs `indexedCommit..main` and re-indexes only those paths. A history
// that does not descend from the indexed commit, a changed declaration, or a schema bump is a
// full rebuild (built aside and renamed in).
//
// Excluded from the corpus (and refused again on output): `_credentials/`, `_sync-conflicts/`
// (any depth, any case), everything the engine's corpus walk excludes, and non-regular entries
// (symlinks, gitlinks). LFS pointers are never Markdown, so they never enter.

import { createRequire } from "node:module";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { resolveDeclaredProfile, parseVaultDeclaration } from "../engine/vault-config.mjs";
import {
  analyzeVaultDocument,
  computeCanonicalId,
  crossesSecretDir,
  extractSearchTerms,
  isSearchCorpusPath,
  parseFrontmatterSearchBridge,
  projectSearchHit,
} from "../engine/vault-search.mjs";
import { readLastSeq } from "./post-receive.mjs";
import { runGit, storePaths } from "./store-layout.mjs";

const SCHEMA_VERSION = "srv-2";
const TRIGRAM_MIN_LENGTH = 3;
const REGULAR_MODES = new Set(["100644", "100755"]);
const BATCH = 1000;
const ANALYSE_BATCH = 64;

let sqlite = null;
function openDatabase(path, options) {
  sqlite ??= createRequire(import.meta.url)("node:sqlite");
  return options === undefined ? new sqlite.DatabaseSync(path) : new sqlite.DatabaseSync(path, options);
}

export function indexPaths(storeRoot) {
  const paths = storePaths(storeRoot);
  return {
    dir: join(storeRoot, "index"),
    db: join(storeRoot, "index", "vault-fts.db"),
    state: join(paths.state, "index.json"),
    lock: join(paths.state, "index.lock"),
    events: paths.events,
    gitDir: paths.gitDir,
  };
}

function gitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return { ...env, LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
}

async function git(gitDir, args, options = {}) {
  return runGit(["--git-dir", gitDir, ...args], { env: gitEnv(), ...options });
}

export async function mainHead(gitDir) {
  const { stdout, code } = await git(gitDir, ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"], { allowFail: true });
  return code === 0 ? stdout.toString("utf8").trim() : null;
}

async function isAncestor(gitDir, ancestor, descendant) {
  const { code } = await git(gitDir, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true });
  return code === 0;
}

/** Read blobs by object name (`<sha>` or `<commit>:<path>`). Returns Map<name, Buffer>; missing names are absent. */
export async function readObjects(gitDir, names) {
  const out = new Map();
  for (let i = 0; i < names.length; i += BATCH) {
    const chunk = names.slice(i, i + BATCH);
    const { stdout } = await git(gitDir, ["cat-file", "--batch"], { input: `${chunk.join("\n")}\n` });
    let offset = 0;
    let k = 0;
    while (offset < stdout.length && k < chunk.length) {
      const newline = stdout.indexOf(0x0a, offset);
      if (newline < 0) break;
      const header = stdout.subarray(offset, newline).toString("utf8");
      const name = chunk[k];
      k += 1;
      if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
        offset = newline + 1;
        continue;
      }
      const [, type, size] = header.split(" ");
      const length = Number(size);
      if (type === "blob") out.set(name, stdout.subarray(newline + 1, newline + 1 + length));
      offset = newline + 1 + length + 1;
    }
  }
  return out;
}

/**
 * Where the declared tree sits in the repo at `commit`: "" (vault.config.json at the root) or
 * "vault/" (the brain layout). Returns `{ prefix, declarationSha, profile }` or null.
 */
export async function resolveTreeAt(gitDir, commit) {
  for (const prefix of ["", "vault/"]) {
    const { stdout } = await git(gitDir, ["ls-tree", "-z", commit, "--", `${prefix}vault.config.json`]);
    const line = stdout.toString("utf8").split("\0").find(Boolean);
    if (!line) continue;
    const [meta] = line.split("\t");
    const [mode, type, sha] = meta.split(" ");
    if (type !== "blob" || !REGULAR_MODES.has(mode)) continue;
    const text = (await readObjects(gitDir, [sha])).get(sha)?.toString("utf8");
    if (text === undefined) continue;
    const declaration = parseVaultDeclaration(text, `${commit.slice(0, 9)}:${prefix}vault.config.json`);
    return { prefix, declarationSha: sha, profile: resolveDeclaredProfile(declaration) };
  }
  return null;
}

/** Regular-file corpus entries of the tree at `commit`: [{ path (tree-relative), sha }]. */
async function listCorpus(gitDir, commit, tree) {
  const args = ["ls-tree", "-r", "-z", "--full-tree", commit];
  if (tree.prefix) args.push("--", tree.prefix);
  const { stdout } = await git(gitDir, args);
  const entries = [];
  for (const record of stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    const repoPath = record.slice(tab + 1);
    if (type !== "blob" || !REGULAR_MODES.has(mode) || repoPath.includes("\n")) continue;
    const path = repoPath.slice(tree.prefix.length);
    if (!isSearchCorpusPath(path, tree.profile) || crossesSecretDir(path)) continue;
    entries.push({ path, sha });
  }
  return entries;
}

function corpusRow(path, content) {
  const { frontmatterFields, lines, bodyStartIndex } = parseFrontmatterSearchBridge(content);
  return {
    path,
    canonicalId: computeCanonicalId(path),
    frontmatter: frontmatterFields.map((field) => field.value).filter(Boolean).join("\n"),
    body: lines.slice(bodyStartIndex).join("\n"),
  };
}

function createSchema(db) {
  db.exec("CREATE VIRTUAL TABLE vault_fts USING fts5(path UNINDEXED, canonical_id, frontmatter, body, tokenize='trigram');");
  db.exec("CREATE TABLE fts_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  // path -> FTS rowid: an increment deletes by rowid. `path` is an UNINDEXED FTS column, so a
  // DELETE ... WHERE path = ? would scan every row for each changed path.
  db.exec("CREATE TABLE fts_paths(path TEXT PRIMARY KEY, rid INTEGER NOT NULL);");
}

function setMeta(db, values) {
  const stmt = db.prepare("INSERT INTO fts_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [key, value] of Object.entries(values)) stmt.run(key, String(value));
}

export function readIndexMeta(dbPath) {
  if (!existsSync(dbPath)) return null;
  let db;
  try {
    db = openDatabase(dbPath, { readOnly: true });
    const meta = {};
    for (const row of db.prepare("SELECT key, value FROM fts_meta").all()) meta[row.key] = row.value;
    return meta;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function insertDocuments(db, gitDir, entries) {
  const insert = db.prepare("INSERT INTO vault_fts(path, canonical_id, frontmatter, body) VALUES (?, ?, ?, ?)");
  const remember = db.prepare("INSERT INTO fts_paths(path, rid) VALUES (?, ?)");
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    const blobs = await readObjects(gitDir, chunk.map((e) => e.sha));
    for (const entry of chunk) {
      const blob = blobs.get(entry.sha);
      if (!blob) throw new Error(`index: blob ${entry.sha} (${entry.path}) is missing from the store`);
      const row = corpusRow(entry.path, blob.toString("utf8"));
      const { lastInsertRowid } = insert.run(row.path, row.canonicalId, row.frontmatter, row.body);
      remember.run(row.path, lastInsertRowid);
    }
  }
}

async function buildFull(paths, commit, tree) {
  mkdirSync(paths.dir, { recursive: true, mode: 0o750 });
  const entries = await listCorpus(paths.gitDir, commit, tree);
  const temp = `${paths.db}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  try {
    const db = openDatabase(temp);
    try {
      createSchema(db);
      db.exec("BEGIN");
      await insertDocuments(db, paths.gitDir, entries);
      setMeta(db, { schema_version: SCHEMA_VERSION, indexed_commit: commit, prefix: tree.prefix, declaration_sha: tree.declarationSha, doc_count: entries.length });
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    renameSync(temp, paths.db);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { mode: "full", docCount: entries.length, changed: entries.length };
}

async function applyIncrement(paths, from, to, tree) {
  const args = ["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to];
  if (tree.prefix) args.push("--", tree.prefix);
  const { stdout } = await git(paths.gitDir, args);
  const tokens = stdout.toString("utf8").split("\0");
  const removed = new Set();
  const added = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith(":")) continue;
    const [, newMode, , newSha] = token.slice(1).split(" ");
    const path = tokens[i + 1].slice(tree.prefix.length);
    i += 1;
    removed.add(path);
    if (!path.includes("\n") && REGULAR_MODES.has(newMode) && !/^0+$/.test(newSha) && isSearchCorpusPath(path, tree.profile) && !crossesSecretDir(path)) {
      added.push({ path, sha: newSha });
    }
  }
  const db = openDatabase(paths.db);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      const find = db.prepare("SELECT rid FROM fts_paths WHERE path = ?");
      const del = db.prepare("DELETE FROM vault_fts WHERE rowid = ?");
      const forget = db.prepare("DELETE FROM fts_paths WHERE path = ?");
      for (const path of removed) {
        const row = find.get(path);
        if (!row) continue;
        del.run(row.rid);
        forget.run(path);
      }
      await insertDocuments(db, paths.gitDir, added);
      const count = Number(db.prepare("SELECT count(*) AS n FROM fts_paths").get().n);
      setMeta(db, { indexed_commit: to, doc_count: count });
      db.exec("COMMIT");
      return { mode: "incremental", docCount: count, changed: removed.size };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** One indexer per store. A lock whose holder process is gone (same host) is taken over. */
function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o640);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
      if (Number.isInteger(holder) && processAlive(holder)) return false;
      rmSync(lockPath, { force: true });
    }
  }
  return false;
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeState(path, state) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o640 });
  renameSync(temp, path);
}

/**
 * Bring the store's index up to `refs/heads/main`. `force` rebuilds from scratch.
 * Returns `{ status: "busy" | "empty" | "current" | "indexed", ... }`.
 */
export async function ensureIndexed(storeRoot, { force = false } = {}) {
  const paths = indexPaths(storeRoot);
  if (!acquireLock(paths.lock)) return { status: "busy" };
  try {
    const lastSeq = readLastSeq(paths.events);
    const head = await mainHead(paths.gitDir);
    if (!head) return { status: "empty" };
    const meta = force ? null : readIndexMeta(paths.db);
    const state = readState(paths.state);
    if (meta && meta.schema_version === SCHEMA_VERSION && meta.indexed_commit === head) {
      if (state.lastSeq !== lastSeq || state.indexedCommit !== head) writeState(paths.state, { ...state, indexedCommit: head, lastSeq });
      return { status: "current", indexedCommit: head, lastSeq, docCount: Number(meta.doc_count) };
    }
    const tree = await resolveTreeAt(paths.gitDir, head);
    if (!tree) throw new Error(`index: no vault.config.json at the root or under vault/ in ${head}`);
    const started = Date.now();
    let result;
    const incremental = meta
      && meta.schema_version === SCHEMA_VERSION
      && meta.prefix === tree.prefix
      && meta.declaration_sha === tree.declarationSha
      && await isAncestor(paths.gitDir, meta.indexed_commit, head);
    result = incremental ? await applyIncrement(paths, meta.indexed_commit, head, tree) : await buildFull(paths, head, tree);
    const record = { indexedCommit: head, lastSeq, indexedAt: new Date().toISOString(), docCount: result.docCount, mode: result.mode, changed: result.changed, ms: Date.now() - started };
    writeState(paths.state, record);
    return { status: "indexed", ...record };
  } finally {
    rmSync(paths.lock, { force: true });
  }
}

/**
 * Event consumer for `vault serve`: every `intervalMs` (5s — the design's batching window), index
 * each vault store whose events log moved past the recorded `lastSeq` (or whose index is absent).
 */
export function startIndexer({ getConfig, intervalMs = 5000, log = () => {} }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const [id, store] of Object.entries(getConfig().stores)) {
        if (store.kind !== "vault") continue;
        const paths = indexPaths(store.path);
        if (!existsSync(paths.gitDir)) continue;
        const state = readState(paths.state);
        let lastSeq;
        try {
          lastSeq = readLastSeq(paths.events);
        } catch (error) {
          log({ event: "index-failed", store: id, error: error.message });
          continue;
        }
        if (existsSync(paths.db) && state.lastSeq === lastSeq) continue;
        try {
          const result = await ensureIndexed(store.path);
          if (result.status === "indexed") log({ event: "indexed", store: id, ...result });
        } catch (error) {
          log({ event: "index-failed", store: id, error: error.message });
        }
      }
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

// ── query ────────────────────────────────────────────────────────────────────

function codePointLength(value) {
  return [...String(value ?? "")].length;
}

function matchExpression(terms) {
  const serviceable = [...new Set(terms.filter((t) => codePointLength(t) >= TRIGRAM_MIN_LENGTH))];
  return serviceable.map((t) => `"${t.replace(/"/gu, '""')}"`).join(" OR ");
}

export class IndexNotReadyError extends Error {}

/**
 * Search the store's index. Hits are re-analysed against the indexed commit's blobs with the
 * engine's own analyzer, so their fields are those of a local search. When the trigram index
 * cannot represent a term (two-syllable Korean words), an empty FTS answer falls back to a scan
 * of the indexed commit's corpus and says so (`engineReason`), like the local engine does.
 */
export async function searchStoreIndex(storeRoot, { query, mode = "search", limit = 20 }) {
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) throw new Error("query required");
  if (mode !== "search" && mode !== "timeline") throw new Error(`unsupported mode ${mode}`);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw new Error("limit must be 1..1000");
  const paths = indexPaths(storeRoot);
  const meta = readIndexMeta(paths.db);
  if (!meta || meta.schema_version !== SCHEMA_VERSION) throw new IndexNotReadyError("색인 준비 중 — 첫 색인이 아직 끝나지 않았습니다");
  const commit = meta.indexed_commit;
  const prefix = meta.prefix;
  const terms = extractSearchTerms(normalizedQuery);
  const dropped = terms.filter((t) => codePointLength(t) < TRIGRAM_MIN_LENGTH);
  const expression = matchExpression(terms);

  let candidates = [];
  let corpusFiles;
  let engine = "fts";
  let engineReason = "server-index";
  const db = openDatabase(paths.db, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    corpusFiles = Number(db.prepare("SELECT count(*) AS n FROM vault_fts").get().n);
    if (expression) {
      candidates = db.prepare("SELECT path FROM vault_fts WHERE vault_fts MATCH ? ORDER BY bm25(vault_fts), path").all(expression).map((r) => r.path);
    }
  } finally {
    db.close();
  }

  const analyse = async (candidatePaths) => {
    const safe = candidatePaths.filter((p) => !crossesSecretDir(p));
    const blobs = await readObjects(paths.gitDir, safe.map((p) => `${commit}:${prefix}${p}`));
    const documents = [];
    for (const p of safe) {
      const blob = blobs.get(`${commit}:${prefix}${p}`);
      if (!blob) continue;
      const document = analyzeVaultDocument(p, blob.toString("utf8"), terms);
      if (document) documents.push(document);
    }
    return documents;
  };

  // FTS: candidates come in bm25 order, and that order is the answer's order. Confirm them in
  // batches and stop once `limit` are confirmed — a common word has thousands of candidates,
  // and reading every one from the object store is what made a query take seconds.
  let documents = [];
  let analysed = 0;
  for (let i = 0; i < candidates.length && documents.length < limit; i += ANALYSE_BATCH) {
    const batch = candidates.slice(i, i + ANALYSE_BATCH);
    documents.push(...await analyse(batch));
    analysed += batch.length;
  }
  if (!expression || (dropped.length > 0 && documents.length === 0)) {
    // The trigram index cannot represent a term this short. Scan semantics instead: every
    // indexed document holding any term, ranked by match counts. SQLite narrows the corpus with
    // a substring filter first (LIKE folds ASCII case only — the analyzer, which lowercases
    // fully, confirms each candidate), so only documents that can match are read.
    const db2 = openDatabase(paths.db, { readOnly: true });
    try {
      db2.exec("PRAGMA busy_timeout = 5000");
      const like = (t) => `%${t.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
      const clauses = terms.map(() => "(canonical_id LIKE ? ESCAPE '\\' OR frontmatter LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      const params = terms.flatMap((t) => [like(t), like(t), like(t)]);
      candidates = clauses.length === 0 ? [] : db2.prepare(`SELECT path FROM vault_fts WHERE ${clauses.join(" OR ")}`).all(...params).map((r) => r.path);
    } finally {
      db2.close();
    }
    documents = await analyse(candidates);
    analysed = candidates.length;
    documents.sort((a, b) =>
      (b.entityMatches.length + b.contentMatches.length) - (a.entityMatches.length + a.contentMatches.length)
      || b.entityMatches.length - a.entityMatches.length
      || a.path.localeCompare(b.path));
    engine = "scan";
    engineReason = expression ? `fts-dropped-short-terms: ${dropped.join(", ")}` : "query-below-trigram-min";
  }

  const hits = documents.slice(0, limit).map((d) => projectSearchHit(d, mode));
  return {
    mode,
    engine,
    engineReason,
    query: normalizedQuery,
    indexedCommit: commit,
    corpusFiles,
    candidateFiles: candidates.length,
    // counts are over the documents confirmed so far (`analysedFiles` of `candidateFiles`)
    analysedFiles: analysed,
    entityMatchCount: documents.reduce((n, d) => n + d.entityMatches.length, 0),
    contentMatchCount: documents.reduce((n, d) => n + d.contentMatches.length, 0),
    limit,
    ...(dropped.length > 0 ? { droppedTerms: dropped } : {}),
    hits,
  };
}

// ── file API ────────────────────────────────────────────────────────────────

const DOTGIT = /^(\.git[. ]*|git~1)$/i;
const REV = /^(main|HEAD|[0-9a-f]{7,40})$/;

export class FileRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Validate a tree-relative path for the file API. Throws FileRequestError. */
export function checkServedPath(path) {
  if (typeof path !== "string" || !path) throw new FileRequestError(400, "path required");
  if (path !== path.normalize("NFC")) throw new FileRequestError(400, "path must be NFC");
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) throw new FileRequestError(400, "path must be tree-relative");
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new FileRequestError(400, "path must not contain empty, . or .. components");
  if (parts.some((p) => DOTGIT.test(p))) throw new FileRequestError(403, "path is not served");
  if (crossesSecretDir(path)) throw new FileRequestError(403, "path is not served");
  return path;
}

/**
 * Read one regular file of the tree at `rev` (default main) from git objects. Symlinks,
 * gitlinks and directories are refused; `rev` must be main or an ancestor of it.
 * Returns `{ commit, mode, sha, size, content }`.
 */
export async function readServedFile(storeRoot, { path, rev = "main" }) {
  checkServedPath(path);
  if (!REV.test(rev)) throw new FileRequestError(400, "rev must be main, HEAD or a commit sha");
  const { gitDir } = indexPaths(storeRoot);
  const head = await mainHead(gitDir);
  if (!head) throw new FileRequestError(404, "store is empty");
  const name = rev === "main" || rev === "HEAD" ? head : rev;
  const { stdout, code } = await git(gitDir, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`], { allowFail: true });
  if (code !== 0) throw new FileRequestError(404, `no commit ${rev}`);
  const commit = stdout.toString("utf8").trim();
  if (commit !== head && !(await isAncestor(gitDir, commit, head))) throw new FileRequestError(404, `no commit ${rev} on main`);
  const tree = await resolveTreeAt(gitDir, commit);
  const prefix = tree ? tree.prefix : "";
  const listing = await git(gitDir, ["ls-tree", "-z", "--full-tree", commit, "--", `${prefix}${path}`]);
  const record = listing.stdout.toString("utf8").split("\0").find(Boolean);
  if (!record) throw new FileRequestError(404, `not found: ${path}`);
  const tab = record.indexOf("\t");
  const [mode, type, sha] = record.slice(0, tab).split(" ");
  if (record.slice(tab + 1) !== `${prefix}${path}`) throw new FileRequestError(404, `not found: ${path}`);
  if (type !== "blob" || !REGULAR_MODES.has(mode)) throw new FileRequestError(403, `not a regular file: ${path} (${mode})`);
  const content = (await readObjects(gitDir, [sha])).get(sha);
  if (!content) throw new FileRequestError(500, `blob ${sha} unreadable`);
  return { commit, mode, sha, size: content.length, content };
}

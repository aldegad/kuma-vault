// SQLite FTS5 (BM25) search index for the Kuma vault.
//
// The FTS index is a **pure derivative** of the vault's canonical markdown, exactly like the
// README vault-index lines and binary sidecars (DEC vault-compiler-pipeline). It is never a
// second source of truth: every row is reproducible by re-reading the leaf documents, and the
// whole index is rebuilt from scratch on demand (`kuma vault sync`). The index accelerates the
// existing linear scan (`vault-search`) with BM25 ranking over a trigram tokenizer — chosen so
// that substring recall matches the scan's `.includes` semantics for both ASCII and CJK text,
// which have no whitespace word boundaries (audit H recall parity).
//
// Invariants (8원칙):
//  - SSoT (1): canonical truth = leaf markdown. The `.fts/` DB is a rebuildable cache; on a
//    miss the search entry point self-heals by scanning the live tree (observable via the
//    `engine` field on every result — never a silent fallback, 원칙 6).
//  - Idempotency (5): a rebuild is a pure function of source. A corpus signature (sorted
//    path→content-hash) is stamped into the DB; a second `sync` with an unchanged tree is a
//    genuine no-op (`rebuilt: false`), and a forced rebuild yields logically identical rows.
//  - Atomicity (4): the index is built into a sibling `*.tmp` DB and renamed over the target,
//    so a reader never observes a half-written index.
//  - Isolation (8): concurrent builders are expected (several agent sessions share one vault
//    tree, and the commit-boundary gate heals the cache inline). The named strategy is
//    **per-builder scratch file + atomic rename, last writer wins**: every build writes to a
//    tmp path unique to its process/call, so two builders can never share a half-written file,
//    and the rename publishes one complete index. Both builders derive from the same canonical
//    markdown, so either published index is a valid cache; whichever loses the race is
//    re-derived by the next heal. There is no lock — a cache does not need one.
//
// Backend: Node's built-in `node:sqlite` (DatabaseSync + FTS5) — zero native dependency, no build
// step, matching the repo's repo-agnostic tooling goal. It is an experimental API (Node ≥ 22.5),
// so the first index open emits one `ExperimentalWarning` on stderr; that is deliberate and
// stdout stays clean for `--json` consumers. It loads on first USE, not on import: a static
// import loaded it while every importer's module graph linked, so any host CLI that merely
// reached `kuma-vault` for frontmatter or path helpers printed the warning ahead of its own
// operator message (kuma-studio, 2026-09-23 — kuma cron, kuma dispatch, kuma katok).

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { resolveVaultDir } from "./path-resolver.mjs";
import {
  analyzeVaultDocument,
  computeCanonicalId,
  extractSearchTerms,
  parseFrontmatterSearchBridge,
  projectSearchHit,
  resolveSearchScope,
  walkVaultMarkdownFiles,
} from "./vault-search.mjs";

// node:sqlite on first use (see the Backend note above).
let sqlite = null;
function openDatabase(path, options) {
  sqlite ??= createRequire(import.meta.url)("node:sqlite");
  return options === undefined ? new sqlite.DatabaseSync(path) : new sqlite.DatabaseSync(path, options);
}

// Bumped whenever the on-disk FTS schema (columns / tokenizer) changes so a stale-schema DB is
// treated as drift and rebuilt rather than queried with the wrong shape.
const FTS_SCHEMA_VERSION = "1";

// Trigram tokenizer minimum match length. A quoted trigram term shorter than this can never
// match, so `auto` routes such queries back to the canonical scan (self-heal, reported).
const TRIGRAM_MIN_LENGTH = 3;

const FTS_DIR_NAME = ".fts";
const FTS_DB_NAME = "vault-fts.db";

// Per-process build counter — combined with the pid it names a scratch database no other
// builder (in this process or another) can be writing at the same time.
let buildSequence = 0;
function nextBuildSequence() {
  buildSequence += 1;
  return buildSequence;
}

const SCRATCH_SUFFIX = ".tmp";
const SCRATCH_NAME_PATTERN = /\.(?<pid>\d+)\.\d+\.tmp$/u;

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else — alive, and not ours to clean up.
    return error?.code === "EPERM";
  }
}

// Reclaim scratch databases abandoned by dead builders. A build interrupted mid-flight (a
// cancelled `git commit`, a killed session) cannot run its own cleanup, and its scratch name is
// unique, so nothing else would ever reclaim it — on a large vault that is ~90MB of garbage per
// interruption. Only this database's own scratch files are considered, and only those whose
// owning process is gone: a live pid is left alone, which keeps this safe to run while other
// builders are mid-build (원칙 8).
function reapAbandonedScratchFiles(indexDir, dbFileName) {
  let entries;
  try {
    entries = readdirSync(indexDir);
  } catch {
    // No index directory yet — nothing to reclaim.
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(`${dbFileName}.`) || !name.endsWith(SCRATCH_SUFFIX)) {
      continue;
    }
    const owner = SCRATCH_NAME_PATTERN.exec(name)?.groups?.pid;
    // A scratch file with no owner in its name predates per-builder naming: no live builder can
    // be holding it, because the current scheme never mints that name.
    if (owner && processIsAlive(Number(owner))) {
      continue;
    }
    rmSync(join(indexDir, name), { force: true });
  }
}

export function resolveFtsDbPath(vaultDir = resolveVaultDir()) {
  return join(resolve(vaultDir), FTS_DIR_NAME, FTS_DB_NAME);
}

function codePointLength(value) {
  return [...String(value ?? "")].length;
}

// A trigram MATCH expression that OR-s each search term as a quoted substring phrase, mirroring
// the scan's "matches any extracted term" recall. Terms below the trigram minimum are dropped
// (they cannot match); returns "" when nothing is serviceable.
export function buildFtsMatchExpression(searchTerms) {
  const serviceable = (Array.isArray(searchTerms) ? searchTerms : [])
    .filter((term) => codePointLength(term) >= TRIGRAM_MIN_LENGTH);
  if (serviceable.length === 0) {
    return "";
  }

  const phrases = Array.from(new Set(serviceable)).map(
    (term) => `"${String(term).replace(/"/gu, '""')}"`,
  );
  return phrases.join(" OR ");
}

export function ftsQueryServiceable(searchTerms) {
  return buildFtsMatchExpression(searchTerms) !== "";
}

// Terms the trigram index physically cannot match. Two-code-point Korean words
// (인수 · 약속 · 카톡 …) fall here constantly, and dropping them silently makes FTS
// answer a narrower question than the one asked while reporting "no matches" as if
// the corpus held nothing. Callers surface this and fall back to scan.
export function unserviceableFtsTerms(searchTerms) {
  return (Array.isArray(searchTerms) ? searchTerms : []).filter(
    (term) => codePointLength(term) < TRIGRAM_MIN_LENGTH,
  );
}

export function ftsIndexAvailable(vaultDir = resolveVaultDir(), dbPath) {
  return existsSync(dbPath ?? resolveFtsDbPath(vaultDir));
}

// Collapse a document into the exact text surfaces the scan searches (canonical id + every
// frontmatter field value + body), so FTS recall is aligned with the linear scan by construction.
function buildFtsCorpusRow(relativePath, content) {
  const { frontmatterFields, lines, bodyStartIndex } = parseFrontmatterSearchBridge(content);
  const canonicalId = computeCanonicalId(relativePath);
  const frontmatter = frontmatterFields.map((field) => field.value).filter(Boolean).join("\n");
  const body = lines.slice(bodyStartIndex).join("\n");
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  return { path: relativePath, canonicalId, frontmatter, body, contentHash };
}

function computeCorpusSignature(rows) {
  const hash = createHash("sha256");
  hash.update(`schema:${FTS_SCHEMA_VERSION}\n`);
  for (const row of rows) {
    hash.update(`${row.path}\t${row.contentHash}\n`);
  }
  return hash.digest("hex");
}

async function collectCorpus(vaultDir, profile = null) {
  // Corpus scope = the shared search walk's scope: the tree's declared contract (or the
  // historical kuma-vault default for an undeclared tree). `profile` lets the composed
  // sync pass its already-resolved contract instead of re-reading the declaration.
  const files = await walkVaultMarkdownFiles(vaultDir, vaultDir, profile ? resolveSearchScope(vaultDir, profile) : null);
  const rows = [];
  for (const file of files) {
    const content = await readFile(file.fullPath, "utf8");
    rows.push(buildFtsCorpusRow(file.relativePath, content));
  }
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return rows;
}

function readStoredMeta(dbPath) {
  if (!existsSync(dbPath)) {
    return null;
  }
  let db;
  try {
    db = openDatabase(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT key, value FROM fts_meta").all();
    const meta = {};
    for (const row of rows) {
      meta[row.key] = row.value;
    }
    return meta;
  } catch {
    // A DB we cannot read as our schema is stale/corrupt — treat as absent so it is rebuilt
    // rather than trusted (No Silent Fallback: staleness is surfaced as a rebuild, not masked).
    return null;
  } finally {
    db?.close();
  }
}

// Build (or reuse) the FTS index. Idempotent: unchanged corpus → no-op (`rebuilt: false`).
export async function buildFtsIndex({ vaultDir = resolveVaultDir(), dbPath, force = false, profile = null } = {}) {
  const resolvedVaultDir = resolve(vaultDir);
  if (!existsSync(resolvedVaultDir)) {
    throw new Error(`Vault directory not found: ${resolvedVaultDir}`);
  }
  const resolvedDbPath = dbPath ?? resolveFtsDbPath(resolvedVaultDir);

  const rows = await collectCorpus(resolvedVaultDir, profile);
  const signature = computeCorpusSignature(rows);

  if (!force) {
    const meta = readStoredMeta(resolvedDbPath);
    if (meta && meta.schema_version === FTS_SCHEMA_VERSION && meta.signature === signature) {
      return {
        rebuilt: false,
        docCount: rows.length,
        signature,
        dbPath: resolvedDbPath,
        vaultDir: resolvedVaultDir,
      };
    }
  }

  mkdirSync(dirname(resolvedDbPath), { recursive: true });
  reapAbandonedScratchFiles(dirname(resolvedDbPath), basename(resolvedDbPath));
  // Scratch file unique to this builder (원칙 8). A shared `<db>.tmp` would let one process
  // delete or overwrite another's half-written database and publish the wreckage; a per-builder
  // name plus the atomic rename below makes concurrent builds independent by construction.
  const tmpPath = `${resolvedDbPath}.${process.pid}.${nextBuildSequence()}.tmp`;

  try {
    const db = openDatabase(tmpPath);
    try {
      db.exec(
        "CREATE VIRTUAL TABLE vault_fts USING fts5(" +
          "path UNINDEXED, canonical_id, frontmatter, body, tokenize='trigram');",
      );
      db.exec("CREATE TABLE fts_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);");

      const insert = db.prepare(
        "INSERT INTO vault_fts(path, canonical_id, frontmatter, body) VALUES (?, ?, ?, ?)",
      );
      db.exec("BEGIN");
      for (const row of rows) {
        insert.run(row.path, row.canonicalId, row.frontmatter, row.body);
      }
      const meta = db.prepare("INSERT INTO fts_meta(key, value) VALUES (?, ?)");
      meta.run("schema_version", FTS_SCHEMA_VERSION);
      meta.run("signature", signature);
      meta.run("doc_count", String(rows.length));
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    // Atomic publish: readers see either the old index or the fully-built new one, never a partial.
    renameSync(tmpPath, resolvedDbPath);
  } catch (error) {
    // A build that failed must not leave its scratch database behind — the name is unique to
    // this builder, so nothing else would ever reclaim it.
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { force: true });
    }
    throw error;
  }

  return {
    rebuilt: true,
    docCount: rows.length,
    signature,
    dbPath: resolvedDbPath,
    vaultDir: resolvedVaultDir,
  };
}

// Check-mode counterpart: report whether a rebuild would run, without writing.
export async function checkFtsIndex({ vaultDir = resolveVaultDir(), dbPath, profile = null } = {}) {
  const resolvedVaultDir = resolve(vaultDir);
  if (!existsSync(resolvedVaultDir)) {
    throw new Error(`Vault directory not found: ${resolvedVaultDir}`);
  }
  const resolvedDbPath = dbPath ?? resolveFtsDbPath(resolvedVaultDir);

  const rows = await collectCorpus(resolvedVaultDir, profile);
  const signature = computeCorpusSignature(rows);
  const meta = readStoredMeta(resolvedDbPath);
  const present = Boolean(meta);
  const inSync = present && meta.schema_version === FTS_SCHEMA_VERSION && meta.signature === signature;

  return {
    rebuilt: false,
    wouldRebuild: !inSync,
    present,
    docCount: rows.length,
    signature,
    dbPath: resolvedDbPath,
    vaultDir: resolvedVaultDir,
  };
}

// Self-heal entry point — THE way a boundary reconciles the FTS cache with the live tree.
//
// The `.fts/` database is a derived cache that lives outside the committed tree, so its
// staleness is never a fact about the tree: it is a fact about the cache. 원칙 1's self-heal
// clause says such a miss recovers from the live truth instead of stopping and calling a human,
// which is why every boundary (commit gate included) heals rather than reports here. The heal
// is the same `buildFtsIndex` every other caller uses — one engine, no per-boundary rebuilder.
//
// Observability (원칙 6): the outcome is always named — `healed:false` (cache already matched
// the tree), `healed:true` (rebuilt from live truth), `raced:true` (another builder published
// between our rename and our verification — benign, both indexes derive from the same canonical
// markdown). What is NOT tolerated is an unverifiable publish: if our own freshly renamed
// database cannot be read back, that is surfaced as an error, never swallowed.
export async function healFtsIndex({ vaultDir = resolveVaultDir(), dbPath, profile = null, force = false } = {}) {
  // `buildFtsIndex` is already signature-gated: an in-sync cache is a genuine no-op, so this
  // single call covers both "nothing to do" and "rebuild", with one corpus walk either way.
  const build = await buildFtsIndex({ vaultDir, dbPath, profile, force });
  if (!build.rebuilt) {
    return { ...build, healed: false, verified: true, raced: false };
  }

  // Re-judge the heal against what is actually on disk. This reads the meta table only (no
  // second corpus walk), so it stays cheap enough for a commit-boundary gate.
  const published = readStoredMeta(build.dbPath);
  if (!published) {
    throw new Error(
      `FTS self-heal published ${build.dbPath} but the index could not be read back — ` +
      `the cache is unusable and was not left in a known state.`,
    );
  }
  const raced =
    published.schema_version !== FTS_SCHEMA_VERSION || published.signature !== build.signature;

  return {
    ...build,
    healed: true,
    verified: !raced,
    raced,
    publishedSignature: published.signature,
  };
}

// Query the FTS index and return hits in the exact shape `searchVault` (scan) produces. FTS
// selects and BM25-ranks candidates; each candidate is then re-analyzed with the shared scan
// analyzer so snippet/count/source fields are byte-identical to the scan path (only the ordering
// — BM25 vs match-count — differs). Ordering is deterministic (bm25 then path tiebreak).
export async function searchFtsIndex({
  query,
  vaultDir = resolveVaultDir(),
  limit,
  mode = "search",
  searchTerms,
  dbPath,
  engineReason = "forced",
} = {}) {
  const resolvedVaultDir = resolve(vaultDir);
  const resolvedDbPath = dbPath ?? resolveFtsDbPath(resolvedVaultDir);
  if (!existsSync(resolvedDbPath)) {
    throw new Error(
      `FTS index not found: ${resolvedDbPath}. Run \`kuma vault sync\` to build it.`,
    );
  }

  const normalizedQuery = String(query ?? "").trim();
  const terms = Array.isArray(searchTerms) ? searchTerms : extractSearchTerms(normalizedQuery);
  const matchExpression = buildFtsMatchExpression(terms);

  const baseResult = {
    mode,
    engine: "fts",
    engineReason,
    query: normalizedQuery,
    vaultDir: resolvedVaultDir,
    limit,
  };

  const db = openDatabase(resolvedDbPath, { readOnly: true });
  let corpusFiles;
  let candidatePaths = [];
  try {
    corpusFiles = Number(db.prepare("SELECT count(*) AS count FROM vault_fts").get().count);
    if (corpusFiles === 0) {
      throw new Error(
        "FTS search corpus is empty: the index contains zero documents. " +
          "Check the vault path and scope, then run `vault sync --root <tree>` to rebuild it.",
      );
    }
    if (matchExpression) {
      candidatePaths = db
        .prepare(
          "SELECT path FROM vault_fts WHERE vault_fts MATCH ? ORDER BY bm25(vault_fts), path",
        )
        .all(matchExpression)
        .map((row) => row.path);
    }
  } finally {
    db.close();
  }

  const documents = [];
  let entityMatchCount = 0;
  let contentMatchCount = 0;
  for (const relativePath of candidatePaths) {
    const fullPath = join(resolvedVaultDir, relativePath);
    if (!existsSync(fullPath)) {
      // The source was deleted after the index was built (stale row). Skip it rather than
      // surface a dangling hit — the next `sync` rebuild drops it (self-heal, reported by count).
      continue;
    }
    const content = await readFile(fullPath, "utf8");
    const document = analyzeVaultDocument(relativePath, content, terms);
    if (!document) {
      // Trigram recalled a candidate the exact scan analyzer does not confirm (e.g. a match that
      // straddles a field boundary). Drop it so precision never regresses below the scan.
      continue;
    }
    entityMatchCount += document.entityMatches.length;
    contentMatchCount += document.contentMatches.length;
    documents.push(document);
  }

  return {
    ...baseResult,
    corpusFiles,
    candidateFiles: candidatePaths.length,
    scannedFiles: corpusFiles,
    entityMatchCount,
    contentMatchCount,
    hits: documents.slice(0, limit).map((document) => projectSearchHit(document, mode)),
  };
}

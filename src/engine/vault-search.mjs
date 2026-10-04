import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { resolveVaultDir } from "./path-resolver.mjs";
import { loadVaultDeclaration, resolveDeclaredProfile } from "./vault-config.mjs";
import { STORE_ID_PATTERN, findStoreByRoot, loadStoreRegistry } from "./vault-stores.mjs";
import {
  isDirInTrackedScope,
  isPlansSlotPath,
  parseFrontmatterDocument,
  resolveNavScopeTrackedDirs,
} from "./vault-ingest.mjs";
import { VAULT_PROFILE } from "./vault-profile.mjs";
import { SECRET_DIR_NAMES, crossesSecretDir, isSecretDirName } from "../server/secret-dirs.mjs";

const DEFAULT_LIMIT = 20;
const MARKDOWN_EXTENSION = ".md";
const MAX_TIMELINE_SNIPPETS = 3;
const TIMELINE_CONTEXT_RADIUS = 2;
const WALK_SKIP_DIRS = new Set([".git", "images", "node_modules"]);
const SEARCH_QUERY_PREFIX_STOPWORDS = new Set(["내", "내가", "내것", "제", "제가", "제것", "우리", "우리의", "나", "저", "저의"]);
const SEARCH_QUERY_SUFFIX_STOPWORDS = new Set([
  "알려",
  "알려줘",
  "알려줘요",
  "알려주세요",
  "알려주라",
  "찾아",
  "찾아줘",
  "찾아줘요",
  "찾아주세요",
  "보여",
  "보여줘",
  "보여줘요",
  "보여주세요",
  "말해",
  "말해줘",
  "말해줘요",
  "말해주세요",
  "궁금해",
  "궁금합니다",
]);

function normalizeLineEndings(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function normalizeSearchText(value) {
  return normalizeLineEndings(value).toLowerCase();
}

function normalizeRelativePath(value) {
  return String(value ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function normalizeSearchToken(value) {
  return String(value ?? "")
    .replace(/^[^\p{L}\p{N}\p{Extended_Pictographic}@._/-]+/gu, "")
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}@._/-]+$/gu, "")
    .trim();
}

export function extractSearchTerms(query) {
  const normalizedQuery = normalizeSearchText(query).replace(/[^\p{L}\p{N}\p{Extended_Pictographic}@._/-]+/gu, " ").trim();
  if (!normalizedQuery) {
    return [];
  }

  const tokens = normalizedQuery
    .split(/\s+/u)
    .map(normalizeSearchToken)
    .filter(Boolean);

  let start = 0;
  while (start < tokens.length && SEARCH_QUERY_PREFIX_STOPWORDS.has(tokens[start])) {
    start += 1;
  }

  let end = tokens.length;
  while (end > start && SEARCH_QUERY_SUFFIX_STOPWORDS.has(tokens[end - 1])) {
    end -= 1;
  }

  const coreTokens = tokens.slice(start, end);
  if (coreTokens.length === 0) {
    return [normalizedQuery];
  }

  const terms = [normalizedQuery];
  const corePhrase = coreTokens.join(" ");
  if (corePhrase && corePhrase !== normalizedQuery) {
    terms.push(corePhrase);
  }

  // Emit the individual words too, not just the phrase. Downstream ORs these terms,
  // so a phrase-only term makes a multi-word query a literal substring search: it finds
  // documents where those words sit adjacent and nothing else. That is how a real lookup
  // failed (2026-09-15) — "케이스마텍 숨은참조" matched only a page that happened to carry
  // that exact string in an alias list, while the document actually holding the rule used
  // the two words paragraphs apart and scored zero.
  //
  // Recall does not cost precision here because ranking is by match count: a document
  // carrying the phrase matches the phrase term AND every word term, so it still outranks
  // one that carries a single word. Words below the trigram minimum are dropped by the FTS
  // match builder, and the scan path applies the same "matches any term" rule.
  if (coreTokens.length > 1) {
    terms.push(...coreTokens);
  }

  return Array.from(new Set(terms.filter(Boolean)));
}

function trimExcerpt(value, limit = 160) {
  const singleLine = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (singleLine.length <= limit) {
    return singleLine;
  }

  return `${singleLine.slice(0, limit - 3)}...`;
}

function compareMatches(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    left.lineNumber - right.lineNumber ||
    left.fieldKind.localeCompare(right.fieldKind)
  );
}

function compareDocumentMatches(left, right) {
  return (
    (right.entityMatches.length + right.contentMatches.length) - (left.entityMatches.length + left.contentMatches.length) ||
    right.entityMatches.length - left.entityMatches.length ||
    left.path.localeCompare(right.path)
  );
}

// Resolve the corpus scope context (profile + optional git-tracked dir bound) for a tree
// root. Callers that already resolved a contract pass it explicitly; otherwise the tree's
// own `vault.config.json` declaration decides, and an undeclared tree keeps the historical
// default (the kuma-vault profile, "all" scope) so existing consumers stay byte-identical.
export function resolveSearchScope(rootDir, profile = null) {
  const resolvedProfile = profile
    ?? (() => {
      const declaration = loadVaultDeclaration(rootDir);
      return declaration ? resolveDeclaredProfile(declaration) : VAULT_PROFILE;
    })();
  return {
    profile: resolvedProfile,
    trackedDirs: resolveNavScopeTrackedDirs(rootDir, resolvedProfile),
  };
}

// Directories no search surface ever enters (`_credentials/`, `_sync-conflicts/`): one resolver,
// shared with the server and the sync client, in ../server/secret-dirs.mjs.
export const SEARCH_EXCLUDED_DIR_NAMES = SECRET_DIR_NAMES;
export { crossesSecretDir, isSecretDirName };

function isSkippedDirName(name) {
  return name.startsWith(".") || WALK_SKIP_DIRS.has(name) || isSecretDirName(name);
}

/**
 * Path form of the corpus walk below, for callers that list a tree from git objects instead of
 * the filesystem (the server index). Same decisions, by construction: a skipped directory
 * component, the plans slot, a root non-nav ledger, or a non-Markdown file is out.
 */
export function isSearchCorpusPath(relativePath, profile = VAULT_PROFILE) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/");
  const fileName = parts.pop();
  if (!fileName || extname(fileName).toLowerCase() !== MARKDOWN_EXTENSION) return false;
  for (let index = 0; index < parts.length; index += 1) {
    if (isSkippedDirName(parts[index])) return false;
    if (isPlansSlotPath(parts.slice(0, index + 1).join("/"), profile)) return false;
  }
  return !profile.rootNonNavFiles.includes(normalized);
}

export async function walkVaultMarkdownFiles(rootDir, currentDir = rootDir, ctx = null) {
  const activeCtx = ctx ?? resolveSearchScope(rootDir);
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      // Skip dot-directories (`.git`, the `.fts/` index cache) and known non-content dirs so the
      // search corpus and the FTS corpus (which reuses this walk) stay identical to the generator's
      // navigable set — no derived-cache artifacts leak into either index.
      if (isSkippedDirName(entry.name)) {
        continue;
      }

      // Prune the `plans/` slot from the search corpus (DEC vault-compiler step 15). Plan
      // documents are owned by `kuma plan lint`, edited outside the vault boundary (plan CLI /
      // panel), and are excluded from the index generator + lint (steps 1/13). Including them in
      // the scan / FTS corpus would let out-of-band plan edits perpetually stale the FTS signature,
      // breaking the canonical `kuma vault sync` no-op invariant (원칙 3 Consistency, 원칙 5
      // Idempotency). Both the scan and the FTS index reuse this walk, so pruning here keeps their
      // recall identical by construction (parity). Plan search is the plan tool's own concern.
      const dirRelativePath = normalizeRelativePath(relative(rootDir, fullPath));
      if (isPlansSlotPath(dirRelativePath, activeCtx.profile)) {
        continue;
      }

      // Under a git-tracked nav scope, an untracked subtree (vendored/secret material) is
      // outside the managed tree: it must never enter the scan or FTS corpus (원칙 3
      // Consistency with the index generator's scope).
      if (!isDirInTrackedScope(dirRelativePath, activeCtx.trackedDirs)) {
        continue;
      }

      files.push(...await walkVaultMarkdownFiles(rootDir, fullPath, activeCtx));
      continue;
    }

    if (!entry.isFile() || extname(entry.name).toLowerCase() !== MARKDOWN_EXTENSION) {
      continue;
    }

    const relativePath = normalizeRelativePath(relative(rootDir, fullPath));

    // Prune the machine-event runtime ledgers (`dispatch-log.md`, `log.md`) from the search corpus
    // (DEC vault-compiler step 16, same-series follow-up to step 15's plans-slot prune). These are
    // append-only ledgers declared non-navigable (VAULT_ROOT_NON_NAV_FILES — the generated root
    // vault-index already excludes them). Every dispatch / ingest event appends to them, so keeping
    // them in the scan / FTS corpus perpetually staled the FTS signature, re-breaking the canonical
    // `kuma vault sync` no-op invariant (원칙 3 Consistency, 원칙 5 Idempotency). Both the scan and
    // the FTS index reuse this walk, so pruning here keeps their recall identical by construction
    // (parity). Ledger reads are the `kuma vault timeline` tool's own concern. The set holds root
    // basenames and these ledgers only live at the vault root, so matching the full relative path
    // scopes the exclusion to the root ledgers exactly (mirrors vault-enrich's non-nav check).
    if (activeCtx.profile.rootNonNavFiles.includes(relativePath)) {
      continue;
    }

    files.push({
      fullPath,
      relativePath,
    });
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

function resolveFrontmatterBoundary(lines) {
  if (lines[0]?.trim() !== "---") {
    return {
      closingIndex: -1,
      bodyStartIndex: 0,
    };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    return {
      closingIndex: -1,
      bodyStartIndex: 0,
    };
  }

  return {
    closingIndex,
    bodyStartIndex: closingIndex + 1,
  };
}

function normalizeFrontmatterSearchValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .join(", ");
  }

  return String(value ?? "").trim();
}

function matchesAnySearchTerm(value, searchTerms) {
  const normalizedValue = normalizeSearchText(value);
  return searchTerms.some((term) => term && normalizedValue.includes(term));
}

export function parseFrontmatterSearchBridge(content = "") {
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split("\n");
  const { frontmatter } = parseFrontmatterDocument(normalized);
  const { closingIndex, bodyStartIndex } = resolveFrontmatterBoundary(lines);

  if (closingIndex === -1) {
    return {
      frontmatter,
      lines,
      bodyStartIndex,
      frontmatterFields: [],
    };
  }

  const arrayValueQueues = new Map();
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      arrayValueQueues.set(key, [...value]);
    }
  }

  const frontmatterFields = [];
  let currentArrayKey = null;

  for (let index = 1; index < closingIndex; index += 1) {
    const rawLine = lines[index];
    const trimmedLine = rawLine.trimEnd();
    const arrayItem = trimmedLine.match(/^\s*-\s*(.+)$/u);
    if (currentArrayKey && arrayItem) {
      const normalizedValue = normalizeFrontmatterSearchValue(arrayValueQueues.get(currentArrayKey)?.shift());
      if (!normalizedValue) {
        continue;
      }

      frontmatterFields.push({
        key: currentArrayKey,
        value: normalizedValue,
        lineNumber: index + 1,
        excerpt: trimmedLine.trim(),
      });
      continue;
    }

    const keyMatch = trimmedLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (!keyMatch) {
      currentArrayKey = null;
      continue;
    }

    const [, key, rawValue] = keyMatch;
    const parsedValue = frontmatter[key];
    if (rawValue.trim() === "") {
      currentArrayKey = Array.isArray(parsedValue) ? key : null;
      continue;
    }

    currentArrayKey = null;
    const normalizedValue = normalizeFrontmatterSearchValue(parsedValue);
    if (!normalizedValue) {
      continue;
    }

    frontmatterFields.push({
      key,
      value: normalizedValue,
      lineNumber: index + 1,
      excerpt: trimmedLine.trim(),
    });
  }

  return {
    frontmatter,
    lines,
    bodyStartIndex: closingIndex + 1,
    frontmatterFields,
  };
}

function formatTimelineSnippet(lines, lineNumber) {
  const startLine = Math.max(1, lineNumber - TIMELINE_CONTEXT_RADIUS);
  const endLine = Math.min(lines.length, lineNumber + TIMELINE_CONTEXT_RADIUS);
  const text = lines
    .slice(startLine - 1, endLine)
    .map((line, offset) => `L${startLine + offset}: ${trimExcerpt(line, 220) || "(blank)"}`)
    .join("\n");

  return {
    lineNumber,
    startLine,
    endLine,
    text,
  };
}

function chooseSearchSnippet(title, entityMatches, contentMatches) {
  const firstContent = contentMatches[0];
  if (firstContent?.excerpt) {
    return trimExcerpt(firstContent.excerpt);
  }

  const firstEntity = entityMatches.find((match) => match.fieldKind !== "title") ?? entityMatches[0];
  if (firstEntity?.excerpt) {
    return trimExcerpt(firstEntity.excerpt);
  }

  return trimExcerpt(title);
}

function buildTimelineSnippets(lines, entityMatches, contentMatches) {
  const uniqueLineNumbers = [];
  const seen = new Set();
  const orderedMatches = [
    ...contentMatches,
    ...entityMatches,
  ];

  for (const match of orderedMatches) {
    if (seen.has(match.lineNumber)) {
      continue;
    }
    seen.add(match.lineNumber);
    uniqueLineNumbers.push(match.lineNumber);
    if (uniqueLineNumbers.length >= MAX_TIMELINE_SNIPPETS) {
      break;
    }
  }

  return uniqueLineNumbers.map((lineNumber) => formatTimelineSnippet(lines, lineNumber));
}

// The stable identity of a page: the folder name for a README, else the file stem. Shared with
// the FTS indexer so both search engines key documents identically (원칙 3 Consistency).
export function computeCanonicalId(relativePath) {
  return basename(relativePath) === "README.md"
    ? basename(dirname(relativePath))
    : basename(relativePath, extname(relativePath));
}

export function analyzeVaultDocument(relativePath, content, searchTerms) {
  const canonicalId = computeCanonicalId(relativePath);
  const { frontmatter, lines, bodyStartIndex, frontmatterFields } = parseFrontmatterSearchBridge(content);
  const entityMatches = [];
  const contentMatches = [];

  if (matchesAnySearchTerm(canonicalId, searchTerms)) {
    entityMatches.push({
      path: relativePath,
      lineNumber: 1,
      fieldKind: "canonical_id",
      excerpt: canonicalId,
    });
  }

  for (const field of frontmatterFields) {
    if (!field.value || !matchesAnySearchTerm(field.value, searchTerms)) {
      continue;
    }

    entityMatches.push({
      path: relativePath,
      lineNumber: field.lineNumber,
      fieldKind: field.key === "title" ? "title" : `frontmatter:${field.key}`,
      excerpt: field.excerpt,
    });
  }

  for (let index = bodyStartIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || !matchesAnySearchTerm(line, searchTerms)) {
      continue;
    }

    contentMatches.push({
      path: relativePath,
      lineNumber: index + 1,
      fieldKind: "body",
      excerpt: trimExcerpt(line),
    });
  }

  entityMatches.sort(compareMatches);
  contentMatches.sort(compareMatches);

  if (entityMatches.length === 0 && contentMatches.length === 0) {
    return null;
  }

  const title = normalizeFrontmatterSearchValue(frontmatter.title) || canonicalId;
  // Provenance for derived pages (e.g. binary sidecars carry `source: <name>.<ext>`). Surfaced
  // on the hit so a token match on a sidecar's extracted text reveals which binary it came from
  // at the search entry point (DEC vault-compiler step 5, audit D). Undefined for hand-authored
  // pages without a source, so their hit shape is unchanged.
  const source = normalizeFrontmatterSearchValue(frontmatter.source) || undefined;

  return {
    id: relativePath,
    path: relativePath,
    title,
    source,
    entityMatches,
    contentMatches,
    snippet: chooseSearchSnippet(title, entityMatches, contentMatches),
    snippets: buildTimelineSnippets(lines, entityMatches, contentMatches),
  };
}

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("vault-search limit must be a positive integer.");
  }
}

export function projectSearchHit(document, mode) {
  // `source` is additive — only present for pages that declare frontmatter.source (sidecars), so
  // the hit shape stays byte-identical for every hand-authored page (existing strict-equality
  // tests unaffected). `snippets` is timeline-only, as before.
  return {
    id: document.id,
    path: document.path,
    title: document.title,
    snippet: document.snippet,
    entityMatchCount: document.entityMatches.length,
    contentMatchCount: document.contentMatches.length,
    ...(document.source ? { source: document.source } : {}),
    ...(mode === "timeline" ? { snippets: document.snippets } : {}),
  };
}

// Decide which engine serves a query. The FTS index is a rebuildable derivative; on a miss the
// canonical scan self-heals from the live tree (원칙 1), and the choice is always reported on the
// result's `engine`/`engineReason` fields so it is observable, never a silent fallback (원칙 6).
async function resolveSearchEngine(engine, resolvedVaultDir, searchTerms) {
  if (engine === "scan") {
    return { engine: "scan", reason: "forced" };
  }
  if (engine !== "auto" && engine !== "fts") {
    throw new Error(`Unsupported vault-search engine: ${engine}`);
  }

  const { ftsIndexAvailable, ftsQueryServiceable } = await import("./vault-fts.mjs");
  if (engine === "fts") {
    if (!ftsIndexAvailable(resolvedVaultDir)) {
      throw new Error(
        "FTS engine requested but no index exists: run `kuma vault sync` first " +
          "(refusing to silently scan — No Silent Fallback).",
      );
    }
    return { engine: "fts", reason: "forced" };
  }

  // auto
  if (!ftsIndexAvailable(resolvedVaultDir)) {
    return { engine: "scan", reason: "fts-index-absent" };
  }
  if (!ftsQueryServiceable(searchTerms)) {
    return { engine: "scan", reason: "query-below-trigram-min" };
  }
  return { engine: "fts", reason: "auto" };
}

async function scanVault({ normalizedQuery, resolvedVaultDir, limit, mode, searchTerms, engineReason }) {
  const files = await walkVaultMarkdownFiles(resolvedVaultDir);
  if (files.length === 0) {
    throw new Error(
      "Vault search corpus is empty: no searchable Markdown files were found. " +
        "Check --vault-dir and the vault.config.json scope before treating this as no matches.",
    );
  }
  const documents = [];
  let entityMatchCount = 0;
  let contentMatchCount = 0;

  for (const file of files) {
    const content = await readFile(file.fullPath, "utf8");
    const document = analyzeVaultDocument(file.relativePath, content, searchTerms);
    if (!document) {
      continue;
    }

    entityMatchCount += document.entityMatches.length;
    contentMatchCount += document.contentMatches.length;
    documents.push(document);
  }

  documents.sort(compareDocumentMatches);

  return {
    mode,
    engine: "scan",
    engineReason,
    query: normalizedQuery,
    vaultDir: resolvedVaultDir,
    corpusFiles: files.length,
    candidateFiles: files.length,
    scannedFiles: files.length,
    entityMatchCount,
    contentMatchCount,
    limit,
    hits: documents.slice(0, limit).map((document) => projectSearchHit(document, mode)),
  };
}

export async function searchVault({
  query,
  vaultDir = resolveVaultDir(),
  limit = DEFAULT_LIMIT,
  mode = "search",
  engine = "auto",
} = {}) {
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) {
    throw new Error("vault-search requires a non-empty query.");
  }

  if (mode !== "search" && mode !== "timeline") {
    throw new Error(`Unsupported vault-search mode: ${mode}`);
  }

  validateLimit(limit);

  const resolvedVaultDir = resolve(vaultDir);
  if (!existsSync(resolvedVaultDir)) {
    throw new Error(`Vault directory not found: ${resolvedVaultDir}`);
  }

  const searchTerms = extractSearchTerms(normalizedQuery);
  const decision = await resolveSearchEngine(engine, resolvedVaultDir, searchTerms);

  if (decision.engine === "fts") {
    const { searchFtsIndex, unserviceableFtsTerms } = await import("./vault-fts.mjs");
    const droppedTerms = unserviceableFtsTerms(searchTerms);
    const ftsResult = await searchFtsIndex({
      query: normalizedQuery,
      vaultDir: resolvedVaultDir,
      limit,
      mode,
      searchTerms,
      engineReason: decision.reason,
    });

    // The trigram index cannot represent every term, so an empty FTS answer here is not
    // evidence the corpus is empty of the query — it is evidence we asked a narrower
    // question. Scan can answer the real one, so spend the walk rather than report a
    // false "no matches" (원칙 6: unknown is not a pass). The fast path is unaffected:
    // this only runs when FTS found nothing AND terms were actually dropped.
    if (droppedTerms.length > 0 && ftsResult.hits.length === 0) {
      const scanned = await scanVault({
        normalizedQuery,
        resolvedVaultDir,
        limit,
        mode,
        searchTerms,
        engineReason: `fts-dropped-short-terms: ${droppedTerms.join(", ")}`,
      });
      return { ...scanned, droppedTerms };
    }

    return droppedTerms.length > 0 ? { ...ftsResult, droppedTerms } : ftsResult;
  }

  return scanVault({
    normalizedQuery,
    resolvedVaultDir,
    limit,
    mode,
    searchTerms,
    engineReason: decision.reason,
  });
}

// Cross-store search. `searchVault` above stays single-store on purpose: it is a
// public export (src/index.mjs), the diagnostic script's entry, and what every
// existing test asserts. This wrapper is the multi-store layer on top of it.
//
// Why it exists: the store registry (`vault-stores.json`) has been the machine's
// id -> root map since the cross-store pointer work, but only `graph` and `lint`
// ever read it. Search did not, so a rule living in a second registered tree was
// unreachable from `vault search` — the finder only ever returned the pointer page
// in the primary vault, and the reader had to hop stores by hand. That hop was
// skipped in a live incident (2026-09-15, 케이스마텍 메일 숨은참조 규칙).
function realPathOrResolve(target) {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

function resolvePrimaryStoreId(registry, primaryDir) {
  const primaryReal = realPathOrResolve(primaryDir);
  if (registry) {
    for (const [id, entry] of registry.stores) {
      if (entry.status === "ok" && realPathOrResolve(entry.rootDir) === primaryReal) return id;
    }
  }
  const base = basename(primaryDir);
  return base === "vault" ? "kuma-brain" : base;
}

// Cross-store ranking cannot use the per-engine score: FTS orders by bm25 and scan
// by match counts, and those numbers are not comparable across stores. The projected
// hit fields are, so they decide. The primary store gets no positional advantage on
// purpose — ranking it first is what buries an exact hit in a second store, which is
// the failure this whole change exists to remove.
function compareMergedHits(a, b) {
  if (b.entityMatchCount !== a.entityMatchCount) return b.entityMatchCount - a.entityMatchCount;
  if (b.contentMatchCount !== a.contentMatchCount) return b.contentMatchCount - a.contentMatchCount;
  if (a.storeId !== b.storeId) return a.storeId < b.storeId ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// One store, routed by its registry entry: `search: "remote"` asks the store's server (with the
// read-your-writes supplement, vault-remote.mjs) unless `local` is set, which scans this clone's
// copy without an index. A store with no entry, or a local one, is the engine's own search.
export async function searchOneStore({ root, entry = null, query, limit = DEFAULT_LIMIT, mode = "search", engine = "auto", local = false, env = process.env }) {
  if (entry?.search === "remote") {
    if (local) {
      const scanned = await searchVault({ query, vaultDir: root, limit, mode, engine: "scan" });
      return { ...scanned, engineReason: "local-copy (--local)" };
    }
    const { searchRemoteStore } = await import("./vault-remote.mjs");
    return searchRemoteStore({ rootDir: root, entry, query, mode, limit, env });
  }
  return searchVault({ query, vaultDir: root, limit, mode, engine });
}

/** Search the tree at `vaultDir` only, routed by its registry entry when it has one. */
export async function searchVaultTree({ vaultDir, env = process.env, ...rest }) {
  const registry = loadStoreRegistry(env);
  const found = registry.present && !registry.invalid ? findStoreByRoot(registry, vaultDir) : null;
  return searchOneStore({ root: resolve(vaultDir), entry: found?.entry ?? null, env, ...rest });
}

export async function searchVaultStores({
  query,
  vaultDir = resolveVaultDir(),
  limit = DEFAULT_LIMIT,
  mode = "search",
  engine = "auto",
  storeId: onlyStoreId = undefined,
  local = false,
  env = process.env,
} = {}) {
  const primaryDir = resolve(vaultDir);
  const registry = loadStoreRegistry(env);
  const registryOk = registry.present && !registry.invalid;

  if (onlyStoreId) {
    if (!registryOk) {
      throw new Error(
        `--store ${onlyStoreId} requires a usable store registry: ${registry.invalid ? `${registry.path} is invalid (${registry.invalid})` : `none at ${registry.path}`}`,
      );
    }
    const entry = registry.stores.get(onlyStoreId);
    if (!entry) throw new Error(`Unknown store id "${onlyStoreId}" — not in ${registry.path}.`);
    if (entry.status !== "ok") {
      throw new Error(`Store "${onlyStoreId}" is not usable on this machine (${entry.status}: ${entry.rootDir}).`);
    }
    return searchOneStore({ root: entry.rootDir, entry, query, limit, mode, engine, local, env });
  }

  // Registry absent means this machine never opted into cross-store resolution
  // (vault-stores.mjs contract), so degrade to the single store instead of throwing —
  // but say so in the result. `graph --all-stores` throws because union was asked for
  // there explicitly; here union is the default, and a hard failure would break every
  // search on a machine without a registry.
  const storesSkipReason = registryOk
    ? null
    : registry.invalid
      ? `store registry invalid: ${registry.invalid}`
      : `no store registry at ${registry.path}`;

  const primaryId = resolvePrimaryStoreId(registryOk ? registry : null, primaryDir);
  const primaryEntry = registryOk ? registry.stores.get(primaryId) ?? null : null;
  const storeSpecs = [{ storeId: primaryId, root: primaryDir, primary: true, entry: primaryEntry }];
  if (registryOk) {
    const primaryReal = realPathOrResolve(primaryDir);
    for (const [id, entry] of registry.stores) {
      if (entry.status !== "ok") continue;
      if (realPathOrResolve(entry.rootDir) === primaryReal) continue;
      storeSpecs.push({ storeId: id, root: entry.rootDir, primary: false, entry });
    }
  }

  const union = storeSpecs.length > 1;
  const stores = [];
  const merged = [];

  for (const spec of storeSpecs) {
    // Per-store isolation: `scanVault` throws on an empty corpus and `searchVault`
    // throws on a missing root. One unusable store must not take the search down.
    try {
      const result = await searchOneStore({ root: spec.root, entry: spec.entry, query, limit, mode, engine, local, env });
      stores.push({
        storeId: spec.storeId,
        root: spec.root,
        primary: spec.primary,
        engine: result.engine,
        engineReason: result.engineReason,
        corpusFiles: result.corpusFiles,
        candidateFiles: result.candidateFiles,
        hits: result.hits.length,
        ...(result.droppedTerms ? { droppedTerms: result.droppedTerms } : {}),
        ...(result.remote ? { remote: result.remote } : {}),
      });
      for (const hit of result.hits) {
        merged.push({
          ...hit,
          storeId: spec.storeId,
          id: union ? `${spec.storeId}:${hit.path}` : hit.id,
        });
      }
    } catch (error) {
      // A remote store's server failure is not a degraded union: the caller asked that store's
      // server, and silently answering from the other stores would hide that it was not asked
      // (No Silent Fallback). Local-store failures stay isolated as before.
      if (error?.code === "VAULT_REMOTE_SEARCH") throw error;
      stores.push({
        storeId: spec.storeId,
        root: spec.root,
        primary: spec.primary,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!stores.some((store) => !store.error)) {
    // Every store failed — this is a real failure, not a degraded result.
    const detail = stores.map((store) => `${store.storeId}: ${store.error}`).join("; ");
    throw new Error(`Vault search failed in every registered store — ${detail}`);
  }

  merged.sort(compareMergedHits);
  const sum = (field) => stores.reduce((total, store) => total + (store[field] ?? 0), 0);
  const hits = merged.slice(0, limit);
  const droppedTerms = [...new Set(stores.flatMap((store) => store.droppedTerms ?? []))];

  return {
    mode,
    engine: union ? "multi-store" : (stores[0].engine ?? "scan"),
    engineReason: union ? "stores-union" : stores[0].engineReason,
    query: String(query ?? "").trim(),
    vaultDir: primaryDir,
    union,
    stores,
    storesSkipReason,
    ...(!union && stores[0]?.remote ? { remote: stores[0].remote } : {}),
    ...(droppedTerms.length > 0 ? { droppedTerms } : {}),
    corpusFiles: sum("corpusFiles"),
    candidateFiles: sum("candidateFiles"),
    scannedFiles: sum("corpusFiles"),
    entityMatchCount: hits.reduce((total, hit) => total + hit.entityMatchCount, 0),
    contentMatchCount: hits.reduce((total, hit) => total + hit.contentMatchCount, 0),
    limit,
    hits,
  };
}

// `<store-id>:<relative/path>` — the cross-store pointer grammar the repo already
// uses. Search emits hit ids in this form under union so that `vault get` can round
// trip them; without this resolution the documented search -> get protocol dead-ends
// on exactly the hits this change made reachable.
function resolveCrossStorePointer(rawTarget, env) {
  const value = String(rawTarget ?? "").trim();
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const storeId = value.slice(0, separator);
  const relativePath = value.slice(separator + 1);
  if (!STORE_ID_PATTERN.test(storeId) || !relativePath) return null;

  const registry = loadStoreRegistry(env);
  if (!registry.present) {
    throw new Error(`Cross-store id "${storeId}" cannot be resolved: no store registry at ${registry.path}.`);
  }
  if (registry.invalid) {
    throw new Error(`Cross-store id "${storeId}" cannot be resolved: ${registry.invalid}`);
  }
  const entry = registry.stores.get(storeId);
  if (!entry) {
    throw new Error(`Unknown store id "${storeId}" — not in ${registry.path}.`);
  }
  if (entry.status !== "ok") {
    throw new Error(`Store "${storeId}" is not usable on this machine (${entry.status}: ${entry.rootDir}).`);
  }
  return { storeId, rootDir: entry.rootDir, target: relativePath };
}

function resolveVaultDocumentTarget(vaultDir, rawTarget) {
  const normalizedTarget = normalizeRelativePath(String(rawTarget ?? "").trim());
  if (!normalizedTarget) {
    throw new Error("vault-get requires at least one id or path.");
  }

  if (normalizedTarget.endsWith(MARKDOWN_EXTENSION) && !existsSync(resolve(vaultDir, normalizedTarget))) {
    throw new Error(`Vault document not found: ${normalizedTarget}`);
  }

  const directPath = resolve(vaultDir, normalizedTarget);
  if (existsSync(directPath)) {
    const readmePath = resolve(directPath, "README.md");
    if (existsSync(readmePath)) {
      const relativePath = normalizeRelativePath(relative(vaultDir, readmePath));
      return {
        id: relativePath,
        path: relativePath,
        fullPath: readmePath,
      };
    }
    return {
      id: normalizedTarget,
      path: normalizedTarget,
      fullPath: directPath,
    };
  }

  const withDefaultExtension = normalizedTarget.endsWith(MARKDOWN_EXTENSION)
    ? normalizedTarget
    : `${normalizedTarget}${MARKDOWN_EXTENSION}`;
  const candidatePaths = [withDefaultExtension];

  for (const relativePath of candidatePaths) {
    const fullPath = resolve(vaultDir, relativePath);
    if (existsSync(fullPath)) {
      return {
        id: relativePath,
        path: relativePath,
        fullPath,
      };
    }
  }

  throw new Error(`Vault document not found: ${normalizedTarget}`);
}

export async function getVaultDocuments({ ids = [], vaultDir = resolveVaultDir(), env = process.env } = {}) {
  const resolvedVaultDir = resolve(vaultDir);
  if (!existsSync(resolvedVaultDir)) {
    throw new Error(`Vault directory not found: ${resolvedVaultDir}`);
  }

  const normalizedIds = Array.isArray(ids)
    ? ids.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  if (normalizedIds.length === 0) {
    throw new Error("vault-get requires at least one id or path.");
  }

  const hits = [];
  for (const rawId of normalizedIds) {
    const pointer = resolveCrossStorePointer(rawId, env);
    const rootDir = pointer ? pointer.rootDir : resolvedVaultDir;
    const target = resolveVaultDocumentTarget(rootDir, pointer ? pointer.target : rawId);
    const content = await readFile(target.fullPath, "utf8");
    // A large file in a remote store is an LFS pointer on this clone until it is fetched.
    const lfs = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/u.exec(content);
    const { frontmatter } = parseFrontmatterDocument(content);
    const fallbackTitle = basename(target.path) === "README.md"
      ? basename(dirname(target.path))
      : basename(target.path, extname(target.path));
    hits.push({
      id: pointer ? `${pointer.storeId}:${target.path}` : target.id,
      path: target.path,
      title: normalizeFrontmatterSearchValue(frontmatter.title) || fallbackTitle,
      ...(pointer ? { storeId: pointer.storeId, storeRoot: pointer.rootDir } : {}),
      ...(lfs ? { lfsPointer: { oid: lfs[1], size: Number(lfs[2]) } } : {}),
      content,
    });
  }

  return {
    mode: "get",
    vaultDir: resolvedVaultDir,
    hits,
  };
}

export function formatVaultSearchText(result) {
  const commandName = result.mode === "timeline" ? "/vault timeline" : "/vault search";
  const lines = [
    `# ${commandName}`,
    "",
    `query: ${result.query}`,
    `vault_dir: ${result.vaultDir}`,
    `engine: ${result.engine}${result.engineReason ? ` (${result.engineReason})` : ""}`,
    `corpus_files: ${result.corpusFiles ?? result.scannedFiles}`,
    `candidate_files: ${result.candidateFiles ?? result.scannedFiles}`,
    `entity_match_count: ${result.entityMatchCount}`,
    `content_match_count: ${result.contentMatchCount}`,
    `limit: ${result.limit}`,
  ];

  // Store lines only appear once the search actually spans stores, so a single-store
  // run prints byte-identical output to before this change.
  if (result.union && Array.isArray(result.stores)) {
    const describe = (store) =>
      store.error
        ? `${store.storeId}(error: ${store.error})`
        : `${store.storeId}(${store.engine}, ${store.corpusFiles}${store.remote ? `, ${String(store.remote.indexedCommit ?? "").slice(0, 9)}+${store.remote.supplementFiles}` : ""})`;
    lines.push(`stores: ${result.stores.map(describe).join(" · ")}`);
  }
  if (result.storesSkipReason) {
    lines.push(`stores_skipped: ${result.storesSkipReason}`);
  }
  // Never let a narrowed query look like a complete one.
  if (Array.isArray(result.droppedTerms) && result.droppedTerms.length > 0) {
    lines.push(`terms_too_short_for_index: ${result.droppedTerms.join(", ")}`);
  }

  lines.push("", "## Hits");

  // Remote stores: what the server's answer is as of, and how much this clone supplemented.
  const remotes = result.remote
    ? [result.remote]
    : (result.stores ?? []).map((store) => store.remote).filter(Boolean);
  const footer = remotes.map((remote) => `${remote.store}: 색인 기준 ${String(remote.indexedCommit ?? "").slice(0, 9)} · 로컬 보충 ${remote.supplementFiles}파일`);

  if (result.hits.length === 0) {
    lines.push("no matches");
    if (footer.length > 0) lines.push("", ...footer);
    return `${lines.join("\n")}\n`;
  }

  for (const hit of result.hits) {
    lines.push(`- id: ${hit.id}`);
    lines.push(`  title: ${hit.title}`);
    if (result.union && hit.storeId) lines.push(`  store: ${hit.storeId}`);
    lines.push(`  path: ${hit.path}`);
    lines.push(`  counts: entity=${hit.entityMatchCount} content=${hit.contentMatchCount}`);
    lines.push(`  snippet: ${hit.snippet || "(blank)"}`);

    if (result.mode === "timeline") {
      for (const [index, snippet] of (hit.snippets ?? []).entries()) {
        lines.push(`  timeline_${index + 1}: L${snippet.startLine}-L${snippet.endLine}`);
        lines.push(...snippet.text.split("\n").map((line) => `    ${line}`));
      }
    }

    lines.push("");
  }

  if (footer.length > 0) lines.push(...footer);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function formatVaultGetText(result) {
  const lines = ["# /vault get", ""];

  for (const [index, hit] of result.hits.entries()) {
    if (index > 0) {
      lines.push("", "---", "");
    }

    lines.push(`## ${hit.title}`);
    lines.push(`id: ${hit.id}`);
    lines.push(`path: ${hit.path}`);
    if (hit.lfsPointer) {
      lines.push(`lfs: pointer (${hit.lfsPointer.size}B, sha256 ${hit.lfsPointer.oid.slice(0, 12)}…) — 내용은 서버에 있다: vault blob get ${hit.path}`);
    }
    lines.push("");
    lines.push(hit.content.trimEnd());
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

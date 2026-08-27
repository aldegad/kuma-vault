import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { resolveVaultDir } from "./path-resolver.mjs";
import { loadVaultDeclaration, resolveDeclaredProfile } from "./vault-config.mjs";
import {
  isDirInTrackedScope,
  isPlansSlotPath,
  parseFrontmatterDocument,
  resolveNavScopeTrackedDirs,
} from "./vault-ingest.mjs";
import { VAULT_PROFILE } from "./vault-profile.mjs";

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

  if ((start > 0 || end < tokens.length) && coreTokens.length > 1) {
    terms.push(coreTokens[0]);
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
      if (entry.name.startsWith(".") || WALK_SKIP_DIRS.has(entry.name)) {
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
    const { searchFtsIndex } = await import("./vault-fts.mjs");
    return searchFtsIndex({
      query: normalizedQuery,
      vaultDir: resolvedVaultDir,
      limit,
      mode,
      searchTerms,
      engineReason: decision.reason,
    });
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

export async function getVaultDocuments({ ids = [], vaultDir = resolveVaultDir() } = {}) {
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
    const target = resolveVaultDocumentTarget(resolvedVaultDir, rawId);
    const content = await readFile(target.fullPath, "utf8");
    const { frontmatter } = parseFrontmatterDocument(content);
    const fallbackTitle = basename(target.path) === "README.md"
      ? basename(dirname(target.path))
      : basename(target.path, extname(target.path));
    hits.push({
      id: target.id,
      path: target.path,
      title: normalizeFrontmatterSearchValue(frontmatter.title) || fallbackTitle,
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
    "",
    "## Hits",
  ];

  if (result.hits.length === 0) {
    lines.push("no matches");
    return `${lines.join("\n")}\n`;
  }

  for (const hit of result.hits) {
    lines.push(`- id: ${hit.id}`);
    lines.push(`  title: ${hit.title}`);
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
    lines.push("");
    lines.push(hit.content.trimEnd());
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

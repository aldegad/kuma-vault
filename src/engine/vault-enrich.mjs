// LLM metadata enrichment for the Compiler Vault pipeline (DEC vault-compiler step 6).
//
// The vault-index README lines are *pure functions* of each
// leaf page's frontmatter. This pass fills a small, fixed allowlist of leaf-page frontmatter
// fields — `description`, `tags`, `aliases` — from a single injected model call, stamping each
// field it writes with the body content hash so a second run over an unchanged tree is a no-op.
// It is the ONE place a model is ever allowed to write in the vault — never a README, a sidecar,
// or a log.
//
//   - `description` — the canonical one-line synopsis (the folder README index line derives from it).
//   - `tags`        — bounded-vocab topic tags (the enrich prompt is seeded with the tree's existing
//                     tag pool so the model reuses tags instead of minting a synonym every run).
//   - `aliases`     — human-memory / cross-language search handles ("readable embedding": the synonym
//                     bridge a vector index would give, as auditable text).
//
// Invariants:
//   - WRITE ALLOWLIST: the only file paths this pass writes are leaf knowledge-page markdown files,
//     and within each it only rewrites the enrich fields it owns + their per-field hash stamps
//     (`description`/`description_hash`, `tags`/`tags_hash`, `aliases`/`aliases_hash`). The body is
//     preserved byte-for-byte and every other frontmatter line is preserved verbatim (audit C).
//     README index pages, sidecars, and logs are never touched.
//   - IDEMPOTENT: each field is gated on its `<field>_hash` (sha256 of the body content). A field is
//     (re)generated only when it is absent, or carries a stamp that no longer matches its body. A
//     field with a matching stamp is left as-is, so a second sync regenerates nothing.
//   - NEVER CLOBBER A HUMAN VALUE: a field that is present but carries NO stamp is hand-authored — it
//     is left untouched. This holds per field: a page may have a machine `description` and a
//     hand-written `tags` list; the model refills only the machine-owned/absent fields.
//   - ONE CALL PER PAGE: a page that needs ANY field (re)generated is sent to the model exactly once;
//     the single response supplies all three fields. A field the page already owns (human, or a fresh
//     machine stamp) is never re-derived — so an already-`description`-stamped page gets its missing
//     tags/aliases backfilled without re-generating its description.
//   - BACKWARD-COMPATIBLE FIELD SET: the field set defaults to `["description"]` (the historical
//     contract), so a consumer that injects a plain description-string generator keeps its exact prior
//     behavior. The vault's own CLI opts into the full `["description","tags","aliases"]` set.
//   - NO SILENT FALLBACK: a model failure (or an empty `description` when a description is needed) is
//     reported per file and the file is left untouched; it is never written with partial metadata.
//   - SECRETS NEVER REACH A MODEL: a path that crosses a secret directory (`_credentials/`,
//     `_sync-conflicts/` — the one resolver in ../server/secret-dirs.mjs) is never a target, whatever
//     prefix the tree declares for its owner-local buckets.
//   - A PAGE EDITED MEANWHILE IS NOT OVERWRITTEN: the file is read again just before the write; when
//     it changed while the model ran, the page is reported `raced` and left as its writer left it.
//
// `paths` narrows a run to the named pages (the sync daemon passes the pages its clone committed).
// Every named path goes through the same target resolver as the walk, must be a regular file
// reached without a symlink, and is reported `excluded` with its reason when it is not a target.
// A `paths` run writes its pages together, after its last model call: a page with a new description
// under a README not yet regenerated is a tree the commit gate refuses for every writer in the
// clone, and the caller's index pass comes right after this one. A walk writes each page as it is
// described, so a long run that is stopped keeps what it has paid for.

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { compileGitignore } from "../server/gitignore-match.mjs";
import { crossesSecretDir, isSecretDirName } from "../server/secret-dirs.mjs";
import { resolveVaultDir } from "./path-resolver.mjs";
import {
  formatFrontmatterValue,
  isArchiveTreeRelativePath,
  isDirInTrackedScope,
  isOwnerLocalBucketPath,
  isPlansSlotPath,
  isSidecarPath,
  parseFrontmatterDocument,
  resolveNavScopeTrackedDirs,
} from "./vault-ingest.mjs";
import { VAULT_PROFILE, resolveProfile } from "./vault-profile.mjs";

const ENRICH_WALK_SKIP_DIRS = new Set(["node_modules"]);

// The three leaf-frontmatter fields the enrich pass owns, in the order they are appended to a
// page's frontmatter. Each field `f` carries an idempotency stamp `f_hash` = sha256 of the body
// content it was derived from. Body change -> stamp goes stale -> re-enrich. Kept distinct from the
// sidecar's `sha256` (which stamps a binary source), so a page and a sidecar never collide.
export const ENRICH_FIELDS_ALL = ["description", "tags", "aliases"];
// Historical default: description only. A consumer keeps its prior behavior unless it opts up.
export const DEFAULT_ENRICH_FIELDS = ["description"];
// The array-valued enrich fields (serialized as inline arrays; the rest are single-line strings).
const ENRICH_ARRAY_FIELDS = new Set(["tags", "aliases"]);

export function enrichStampField(field) {
  return `${field}_hash`;
}
// Retained export: the original single-field stamp name other tools may reference.
export const ENRICH_HASH_FIELD = enrichStampField("description");

// A single-line synopsis; cap generously (1~2 lines collapsed) but bounded so a runaway model
// response can't bloat frontmatter.
const DESCRIPTION_MAX_CHARS = 240;
// Tags are short topic handles; aliases are search phrases (may be multi-word / cross-language).
const TAG_MAX_CHARS = 40;
const MAX_TAGS = 8;
const ALIAS_MAX_CHARS = 60;
const MAX_ALIASES = 12;

function normalizePathSeparators(value) {
  return String(value ?? "").split("\\").join("/");
}

function isMarkdownFileName(name) {
  return name.toLowerCase().endsWith(".md");
}

// A leaf knowledge page eligible for enrichment: a hand-authored markdown page a human navigates
// to. Excludes every DERIVED or NON-NAV markdown class so the model only ever writes canonical
// source pages:
//   - README.md / index.md  -> derived nav index (owned by the sync index pass)
//   - `<name>.<ext>.md`      -> generated sidecar (owned by the sidecar pass)
//   - plans/ slot            -> owned by `kuma plan lint`
//   - owner-local `_*` bucket -> evidence/asset holder, not a nav page
//   - archive tree           -> not part of nav topology
//   - root log.md/dispatch-log.md -> curated root prose only
//   - a secret directory      -> `_credentials/`, `_sync-conflicts/` at any depth, any case
//   - a hidden or vendored directory -> `.obsidian/`, `node_modules/` (the walk never enters one)
//   - a page the tree declares out    -> `enrichExclude` (gitignore syntax, tree-relative): the
//                                        files a person alone writes, such as decision ledgers
// Every predicate is imported from the vault-ingest topology SSoT and the secret-dirs resolver
// (원칙 3 Consistency). This is the one resolver: the walk, a `paths` run and the sync daemon's
// queue all ask it.
// The compiled `enrichExclude` list of a profile, compiled once per profile object.
const enrichExcludeMatchers = new WeakMap();

/** The `enrichExclude` pattern of the tree's declaration that covers `relativePath`, or null. */
export function enrichExcludedBy(relativePath, profile = VAULT_PROFILE) {
  let match = enrichExcludeMatchers.get(profile);
  if (!match) {
    match = compileGitignore(profile.enrichExclude ?? [], { ignoreCase: true });
    enrichExcludeMatchers.set(profile, match);
  }
  return match(normalizePathSeparators(relativePath).replace(/^\.\//u, ""));
}

export function isEnrichTargetPath(relativePath, profile = VAULT_PROFILE) {
  const normalized = normalizePathSeparators(relativePath).replace(/^\.\//u, "");
  if (!normalized || !isMarkdownFileName(normalized) || crossesSecretDir(normalized)) {
    return false;
  }
  const parts = normalized.split("/");
  const name = parts.pop() ?? "";
  if (parts.some((dir) => dir.startsWith(".") || ENRICH_WALK_SKIP_DIRS.has(dir))) {
    return false;
  }
  if (name === "README.md" || name === "index.md") {
    return false;
  }
  if (profile.rootNonNavFiles.includes(normalized)) {
    return false;
  }
  if (isSidecarPath(normalized, profile)) {
    return false;
  }
  if (isPlansSlotPath(normalized, profile) || isOwnerLocalBucketPath(normalized, profile)) {
    return false;
  }
  if (enrichExcludedBy(normalized, profile)) {
    return false;
  }
  return !isArchiveTreeRelativePath(normalized, profile);
}

// --- Hashing + value shaping -----------------------------------------------------------

function bodyContentHash(body) {
  return createHash("sha256").update(String(body ?? "").trim(), "utf8").digest("hex");
}

// The model returns free text; keep only the first non-empty line, drop wrapping quotes and
// markdown noise, collapse whitespace, cap length. Returns "" for unusable output (caller
// treats "" as a failure — No Silent Fallback).
export function sanitizeDescription(value) {
  const firstLine = String(value ?? "")
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return "";
  }
  return firstLine
    .replace(/^[>#\-*\s]+/u, "")
    .replace(/^["'`]+|["'`]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, DESCRIPTION_MAX_CHARS);
}

// Coerce a model list value (a real array, or a comma/newline-separated string) into a clean,
// deduped, bounded string array. Each token is stripped of the characters that would break the
// naive inline-array parser (brackets/commas/newlines) and wrapping quotes; empties are dropped,
// duplicates removed case-insensitively (first spelling wins), and the list capped.
function toItemList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? ""));
  }
  return String(value ?? "").split(/[\n,]/u);
}

function sanitizeToken(raw, maxChars) {
  return String(raw ?? "")
    .replace(/[[\]\n\r,]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/gu, "")
    .trim()
    .slice(0, maxChars);
}

function sanitizeTokenList(value, { max, maxChars }) {
  const seen = new Set();
  const out = [];
  for (const raw of toItemList(value)) {
    const token = sanitizeToken(raw, maxChars);
    if (!token) {
      continue;
    }
    const key = token.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(token);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

export function sanitizeTags(value) {
  return sanitizeTokenList(value, { max: MAX_TAGS, maxChars: TAG_MAX_CHARS });
}

export function sanitizeAliases(value) {
  return sanitizeTokenList(value, { max: MAX_ALIASES, maxChars: ALIAS_MAX_CHARS });
}

// --- Surgical frontmatter write --------------------------------------------------------

// Rewrite ONLY the given frontmatter keys, preserving the body byte-for-byte and every other
// frontmatter line verbatim (audit C: enrich touches nothing but its own fields + hash stamps).
// Array values are serialized through the canonical vault-ingest formatter (inline flow syntax).
// When a rewritten key previously held a multi-line array value, its continuation `- ` lines are
// dropped so a malformed multi-line value cleanly becomes a single inline line. A page with no
// frontmatter block gets a minimal one minted ahead of its body.
export function upsertFrontmatterFields(content, fields) {
  const normalized = String(content ?? "").replace(/\r\n/gu, "\n");
  const orderedKeys = Object.keys(fields);
  const renderField = (key) => `${key}: ${formatFrontmatterValue(fields[key])}`;

  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    const block = orderedKeys.map(renderField).join("\n");
    const body = normalized.replace(/^\n+/u, "");
    return `---\n${block}\n---\n\n${body}`;
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    // Malformed (unterminated) frontmatter: don't guess — mint a fresh block above it.
    const block = orderedKeys.map(renderField).join("\n");
    return `---\n${block}\n---\n\n${normalized.replace(/^---\n?/u, "")}`;
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const bodyLines = lines.slice(closingIndex + 1);
  const remaining = new Set(orderedKeys);
  const out = [];

  for (let i = 0; i < frontmatterLines.length; i += 1) {
    const line = frontmatterLines[i];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (match && remaining.has(match[1])) {
      out.push(renderField(match[1]));
      remaining.delete(match[1]);
      // Skip continuation array-item lines that belonged to the replaced key.
      while (i + 1 < frontmatterLines.length && /^\s*-\s+/u.test(frontmatterLines[i + 1])) {
        i += 1;
      }
      continue;
    }
    out.push(line);
  }

  for (const key of orderedKeys) {
    if (remaining.has(key)) {
      out.push(renderField(key));
    }
  }

  return `---\n${out.join("\n")}\n---\n${bodyLines.join("\n")}`;
}

// --- Walk ------------------------------------------------------------------------------

async function collectEnrichTargets(vaultDir, ctx, currentDir = vaultDir, out = []) {
  const { profile, trackedDirs } = ctx;
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relativePath = normalizePathSeparators(relative(vaultDir, fullPath));
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || ENRICH_WALK_SKIP_DIRS.has(entry.name) || isSecretDirName(entry.name)) {
        continue;
      }
      // Prune whole non-nav subtrees so the walk never descends into plans/bucket/archive —
      // and, under a git-tracked nav scope, untracked subtrees (vendored/secret material is
      // never sent to a model; 원칙 3 Consistency with the index generator's scope).
      if (
        isPlansSlotPath(relativePath, profile) ||
        isOwnerLocalBucketPath(relativePath, profile) ||
        isArchiveTreeRelativePath(relativePath, profile) ||
        !isDirInTrackedScope(relativePath, trackedDirs)
      ) {
        continue;
      }
      await collectEnrichTargets(vaultDir, ctx, fullPath, out);
      continue;
    }
    if (!entry.isFile() || !isEnrichTargetPath(relativePath, profile)) {
      continue;
    }
    out.push({ absolutePath: fullPath, relativePath });
  }
  return out;
}

// The named pages of a `paths` run, each judged by the walk's own rules: a target path, inside the
// tracked scope, a regular file whose real path is the named one (no symlinked file or directory
// on the way — a link must not carry a model into a place the walk never enters). Returns
// `{ targets, excluded }`; `excluded` rows carry the reason.
async function resolveNamedTargets(vaultDir, ctx, paths) {
  const { profile, trackedDirs } = ctx;
  const realRoot = await realpath(vaultDir);
  const targets = [];
  const excluded = [];
  const seen = new Set();
  for (const raw of paths) {
    const relativePath = normalizePathSeparators(raw).replace(/^\.\//u, "");
    if (!relativePath || seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    const parts = relativePath.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      excluded.push({ path: relativePath, reason: "not-a-tree-path" });
      continue;
    }
    if (!isEnrichTargetPath(relativePath, profile)) {
      excluded.push({ path: relativePath, reason: enrichExcludedBy(relativePath, profile) ? "declared-exclude" : "not-a-target" });
      continue;
    }
    const dirs = parts.slice(0, -1);
    const outOfScope = dirs.some((_, index) => !isDirInTrackedScope(dirs.slice(0, index + 1).join("/"), trackedDirs));
    if (outOfScope) {
      excluded.push({ path: relativePath, reason: "outside-scope" });
      continue;
    }
    const absolutePath = join(vaultDir, ...parts);
    let real;
    try {
      const stat = await lstat(absolutePath);
      if (!stat.isFile()) {
        excluded.push({ path: relativePath, reason: "not-a-file" });
        continue;
      }
      real = await realpath(absolutePath);
    } catch {
      excluded.push({ path: relativePath, reason: "missing" });
      continue;
    }
    if (real !== join(realRoot, ...parts)) {
      excluded.push({ path: relativePath, reason: "symlinked" });
      continue;
    }
    targets.push({ absolutePath, relativePath });
  }
  return { targets, excluded };
}

// --- Enrich ----------------------------------------------------------------------------

// Is a frontmatter field currently populated with a usable human/machine value?
//   - description: a non-empty string (a non-string value is malformed -> treated as absent).
//   - tags/aliases: an array carrying at least one non-empty item (an empty [] counts as absent).
function fieldHasContent(field, value) {
  if (ENRICH_ARRAY_FIELDS.has(field)) {
    if (Array.isArray(value)) {
      return value.some((item) => String(item ?? "").trim().length > 0);
    }
    return typeof value === "string" && value.trim().length > 0;
  }
  return typeof value === "string" && value.trim().length > 0;
}

// Per-field enrich decision:
//   - stamped + stamp matches body           -> null   (machine, up to date)
//   - stamped + stamp no longer matches body -> "hash-stale" (machine, regenerate)
//   - no stamp + has content                 -> null   (human-owned, never clobbered)
//   - no stamp + absent                       -> "missing" (fill)
function classifyFieldNeed(field, frontmatter, bodyHash) {
  const stampValue = frontmatter[enrichStampField(field)];
  const stamp = typeof stampValue === "string" ? stampValue.trim() : "";
  if (stamp) {
    return stamp === bodyHash ? null : "hash-stale";
  }
  return fieldHasContent(field, frontmatter[field]) ? null : "missing";
}

// A page needs a model call when ANY active field needs (re)generation. The page-level reason is
// "missing" if any field is absent, else "hash-stale". Returns null when the page is fully in sync.
function classifyPageEnrichNeed({ frontmatter, body }, activeFields) {
  const bodyHash = bodyContentHash(body);
  const needFields = [];
  let pageReason = null;
  for (const field of activeFields) {
    const reason = classifyFieldNeed(field, frontmatter, bodyHash);
    if (!reason) {
      continue;
    }
    needFields.push(field);
    if (reason === "missing") {
      pageReason = "missing";
    } else if (!pageReason) {
      pageReason = "hash-stale";
    }
  }
  if (needFields.length === 0) {
    return { reason: null, bodyHash, needFields };
  }
  return { reason: pageReason, bodyHash, needFields };
}

// Normalize whatever the injected generator returns into { description, tags, aliases }. A bare
// string is the legacy description-only contract; an object supplies all three (missing keys ->
// undefined, sanitized to empty by the field writers).
function normalizeGeneratedMetadata(raw) {
  if (typeof raw === "string") {
    return { description: raw, tags: undefined, aliases: undefined };
  }
  if (raw && typeof raw === "object") {
    return { description: raw.description, tags: raw.tags, aliases: raw.aliases };
  }
  return { description: undefined, tags: undefined, aliases: undefined };
}

function resolveActiveFields(fields) {
  const requested = Array.isArray(fields) && fields.length > 0 ? fields : DEFAULT_ENRICH_FIELDS;
  // Preserve canonical order and reject anything outside the owned set (write-allowlist at the
  // field level: the pass can never be asked to write a frontmatter key it does not own).
  return ENRICH_FIELDS_ALL.filter((field) => requested.includes(field));
}

// Collect the existing tag vocabulary across every readable target page, deduped case-insensitively
// (first spelling wins) and sorted for a stable prompt. Feeds bounded-vocab tag reuse.
function collectTagPool(parsedTargets) {
  const seen = new Set();
  const pool = [];
  for (const { frontmatter } of parsedTargets) {
    const tags = frontmatter?.tags;
    if (!Array.isArray(tags)) {
      continue;
    }
    for (const tag of tags) {
      const token = String(tag ?? "").trim();
      if (!token) {
        continue;
      }
      const key = token.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pool.push(token);
    }
  }
  return pool.sort((left, right) => left.localeCompare(right));
}

// Idempotent leaf-frontmatter enrichment.
//
// `generateDescription({ relativePath, title, body, tagPool })` must resolve to either a synopsis
// string (legacy: description only) or `{ description, tags, aliases }`. It is INJECTED so the engine
// stays pure and side-effect-free in tests; the CLI wires the provider tool-model generator.
//
// `check: true` never writes and never calls the model — it reports which pages (and which fields)
// WOULD be enriched (the dry-run / drift gate). `maxFiles` bounds how many pages one write run may
// enrich; the overflow is reported (`capped`/`remaining`), never silently dropped. `fields` selects
// the enrich field set (default: description only). `paths` (tree-relative) narrows the run to
// those pages and writes them together after the last model call; `null` walks the tree and writes
// each page as it is described. `modelCalls` counts the generator calls the run made.
export async function enrichVaultDescriptions({
  vaultDir,
  check = false,
  generateDescription,
  maxFiles = Infinity,
  fields,
  profile = VAULT_PROFILE,
  paths = null,
} = {}) {
  const activeVaultDir = vaultDir ?? resolveVaultDir();
  if (!check && typeof generateDescription !== "function") {
    throw new Error("enrichVaultDescriptions requires a generateDescription function in write mode.");
  }
  const activeFields = resolveActiveFields(fields);
  const activeFieldSet = new Set(activeFields);

  const resolvedProfile = resolveProfile(profile);
  const ctx = {
    profile: resolvedProfile,
    trackedDirs: resolveNavScopeTrackedDirs(activeVaultDir, resolvedProfile),
  };
  const named = Array.isArray(paths) ? await resolveNamedTargets(activeVaultDir, ctx, paths) : null;
  const targets = named ? named.targets : await collectEnrichTargets(activeVaultDir, ctx);
  targets.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const enriched = [];
  const skipped = [];
  const failed = [];
  const raced = [];
  const pending = [];
  const parsedTargets = [];
  let modelCalls = 0;

  for (const target of targets) {
    let raw;
    try {
      raw = await readFile(target.absolutePath, "utf8");
    } catch (error) {
      failed.push({ path: target.relativePath, error: `read failed: ${error.message}` });
      continue;
    }

    const parsed = parseFrontmatterDocument(raw);
    parsedTargets.push(parsed);
    const need = classifyPageEnrichNeed(parsed, activeFields);
    if (!need.reason) {
      skipped.push(target.relativePath);
      continue;
    }
    pending.push({ ...target, raw, parsed, ...need });
  }

  const limit = Number.isFinite(maxFiles) ? Math.max(0, Math.floor(maxFiles)) : pending.length;
  const selected = pending.slice(0, limit);
  const overflow = pending.slice(limit);

  // Bounded vocabulary: seed the model with the tree's existing tags so it reuses them. A `paths`
  // run reads the tree's pages for it only when it is about to call the model.
  let tagPool = [];
  if (activeFieldSet.has("tags")) {
    if (!named) {
      tagPool = collectTagPool(parsedTargets);
    } else if (!check && selected.length > 0) {
      tagPool = collectTagPool(await readTagPoolPages(activeVaultDir, ctx));
    }
  }
  const tagPoolSet = new Set(tagPool.map((tag) => tag.toLowerCase()));

  // Write one described page — unless whoever writes it saved it while the model ran. Their bytes
  // win: the page is left as they wrote it and is enriched when it is collected again.
  const writeDescribed = async ({ item, next, row }) => {
    let current;
    try {
      current = await readFile(item.absolutePath, "utf8");
    } catch (error) {
      failed.push({ path: item.relativePath, error: `read failed: ${error.message}` });
      return;
    }
    if (current !== item.raw) {
      raced.push({ path: item.relativePath });
      return;
    }
    try {
      await writeFile(item.absolutePath, next, "utf8");
    } catch (error) {
      failed.push({ path: item.relativePath, error: `write failed: ${error.message}` });
      return;
    }
    enriched.push(row);
  };
  const described = []; // a `paths` run: written together below, once the model is done

  for (const item of selected) {
    if (check) {
      enriched.push({ path: item.relativePath, reason: item.reason, fields: item.needFields, wrote: false });
      continue;
    }

    const title = typeof item.parsed.frontmatter.title === "string" && item.parsed.frontmatter.title.trim()
      ? item.parsed.frontmatter.title.trim()
      : (item.relativePath.split("/").pop() ?? item.relativePath).replace(/\.md$/iu, "");

    let generated;
    modelCalls += 1;
    try {
      generated = await generateDescription({
        relativePath: item.relativePath,
        title,
        body: item.parsed.body,
        tagPool,
      });
    } catch (error) {
      failed.push({ path: item.relativePath, error: `model failed: ${error.message}` });
      continue;
    }

    const meta = normalizeGeneratedMetadata(generated);
    const writes = {};
    const writtenFields = [];
    let newTags = [];
    let descriptionFailed = false;

    // Build the write set in canonical field order; only the fields THIS page needs are (re)written,
    // so a fresh machine field or a hand-authored value is never overwritten (atomic per page).
    for (const field of ENRICH_FIELDS_ALL) {
      if (!activeFieldSet.has(field) || !item.needFields.includes(field)) {
        continue;
      }
      if (field === "description") {
        const description = sanitizeDescription(meta.description);
        if (!description) {
          descriptionFailed = true;
          break;
        }
        writes.description = description;
      } else if (field === "tags") {
        const tags = sanitizeTags(meta.tags);
        newTags = tags.filter((tag) => !tagPoolSet.has(tag.toLowerCase()));
        writes.tags = tags;
      } else if (field === "aliases") {
        writes.aliases = sanitizeAliases(meta.aliases);
      }
      writes[enrichStampField(field)] = item.bodyHash;
      writtenFields.push(field);
    }

    if (descriptionFailed) {
      // No Silent Fallback: a needed description that came back empty fails the whole page; the
      // file is left untouched rather than written with partial metadata.
      failed.push({ path: item.relativePath, error: "model returned an empty description" });
      continue;
    }

    const page = {
      item,
      next: upsertFrontmatterFields(item.raw, writes),
      row: { path: item.relativePath, reason: item.reason, fields: writtenFields, newTags, wrote: true },
    };
    if (named) {
      described.push(page);
    } else {
      await writeDescribed(page);
    }
  }
  for (const page of described) {
    await writeDescribed(page);
  }

  return {
    vaultDir: activeVaultDir,
    check,
    fields: activeFields,
    total: targets.length,
    candidateCount: pending.length,
    enrichedCount: enriched.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    capped: overflow.length > 0,
    remaining: overflow.length,
    tagPoolSize: tagPool.length,
    modelCalls,
    enriched,
    skipped,
    failed,
    raced,
    ...(named ? { excluded: named.excluded } : {}),
    overflow: overflow.map((item) => ({ path: item.relativePath, reason: item.reason })),
    ok: failed.length === 0,
  };
}

// Every target page's frontmatter, for the tag pool of a `paths` run (unreadable pages are skipped:
// the pool is a prompt hint, and the walk run reports read failures itself).
async function readTagPoolPages(vaultDir, ctx) {
  const parsed = [];
  for (const target of await collectEnrichTargets(vaultDir, ctx)) {
    try {
      parsed.push(parseFrontmatterDocument(await readFile(target.absolutePath, "utf8")));
    } catch {
      // not a pool source
    }
  }
  return parsed;
}

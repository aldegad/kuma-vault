import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { resolveVaultDir } from "./path-resolver.mjs";
import {
  VAULT_INDEX_END_MARKER,
  VAULT_INDEX_START_MARKER,
  encodeVaultLinkTarget,
  extractSummary,
  extractTitle,
  isArchiveTreeRelativePath,
  isOwnerLocalBucketPath,
  isPlansSlotPath,
  isSidecarPath,
  resolveGitTrackedDirs,
  rewriteCrossReferenceBullet,
} from "./vault-ingest.mjs";
import { resolveTreeContract } from "./vault-config.mjs";
import { loadStoreRegistry } from "./vault-stores.mjs";

// Nav context: the resolved profile plus the (optional) git-tracked directory set,
// resolved once per lint run and threaded through every tree walk so lint and the
// index generator stay in lockstep on scope (원칙 3 Consistency; DEC step 8).
// The contract comes from the tree's own declaration (`resolveTreeContract`), so every
// caller — the CLI, ingest, the lifecycle hook, self-heal, a host importing the engine —
// lints a tree under the contract it declares without having to pass it.
function buildLintNavContext(vaultDir, profile) {
  const resolved = resolveTreeContract(vaultDir, profile);
  const trackedDirs = resolved.navScope === "git-tracked" ? resolveGitTrackedDirs(vaultDir) : null;
  return { profile: resolved, trackedDirs };
}

// Is a tree-relative directory within the managed nav scope? (always true for
// "all" scope; git-tracked scope keeps only directories with tracked content.)
function isDirInLintNavScope(relativePath, ctx) {
  if (!ctx || !ctx.trackedDirs) {
    return true;
  }
  const normalized = normalizeRelativePath(relativePath);
  return ctx.trackedDirs.has(normalized === "" ? "." : normalized);
}

const DEFAULT_SPECIAL_VAULT_FILES = Object.freeze([
  "dispatch-log.md",
  "decisions.md",
]);

const SPECIAL_VAULT_FILE_SPECS = Object.freeze({
  "dispatch-log.md": {
    frontmatter: {
      title: { type: "string", exact: "Dispatch Log" },
      type: { type: "string", exact: "special/dispatch-log" },
      updated: { type: "iso-datetime" },
      entry_format: { type: "string", exact: "append-only-ledger" },
      source_of_truth: { type: "string", exact: "kuma-dispatch-lifecycle" },
      boot_priority: { type: "integer", exact: 1 },
    },
    requiredSections: ["Entries"],
    schemaType: "special/dispatch-log",
    schemaWriter: "kuma-dispatch lifecycle hook",
    structuralChecks: ["ledger"],
  },
  "decisions.md": {
    frontmatter: {
      title: { type: "string", exact: "Decisions" },
      type: { type: "string", exact: "special/decisions" },
      updated: { type: "iso-datetime" },
      entry_rule: { type: "string", exact: "explicit-user-decision-only" },
      source_of_truth: { type: "string", exact: "user-direct" },
      boot_priority: { type: "integer", exact: 3 },
    },
    requiredSections: ["About", "Decisions"],
    schemaType: "special/decisions",
    schemaWriter: "user-direct",
    structuralChecks: [],
  },
});

const PLACEHOLDER_PATTERN = /^\(.*\)$/su;
const LEDGER_LINE_PATTERN = /^- \d{4}-\d{2}-\d{2}T[^|]+\| .+/u;
const SECTION_HEADING_PATTERN = /^##\s+/u;
// Labels may contain one level of nested brackets (mail-subject titles like "[미머디] …"),
// so the label class accepts complete `[…]` groups as well as plain characters — otherwise
// such links are silently invisible to link validation and the reachability walker.
const MARKDOWN_LINK_PATTERN = /(?<!\\)\[(?:[^\][\n]|\[[^\]\n]*\])+\]\(([^)\n]+)\)/gu;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ARRAY_LITERAL_PATTERN = /^\[.*\]$/su;
const RESULT_SOURCE_PATTERN = /(?:^|\/)results\/[^/]+\.result\.md$|\.result\.md$/u;
const RESULT_ARCHIVE_FILE_PATTERN = /^results\/.+\.md$/u;
const FENCED_CODE_PATTERN = /^\s*(?:```|~~~)/u;
// Archive-tree slots and the full-scan skip set are profile-owned now
// (profile.archiveTreeDirs) so lint honors the same non-nav contract as the
// generator for every tree (DEC step 8).
// The domain tree's shape holds no vault's names: every top-level `domains/<category>/` directory
// is a category with a README entry point, and the only top-level `domains/<name>.md` pages are
// the persona-memory pages the tree declares (profile.personaMemoryPages).
const DOMAIN_ASSET_DIR_NAMES = new Set([
  "_assets",
  "_attachments",
  "_media",
  "landing-v1",
  "raw",
  "recolored",
]);

function normalize(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatter(contents) {
  const lines = String(contents ?? "").replace(/\r/gu, "").split("\n");
  if (lines[0] !== "---") {
    return null;
  }

  const frontmatter = {};
  let currentArrayKey = null;
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "---") {
      index += 1;
      break;
    }

    const arrayItem = line.match(/^\s*-\s*(.+)$/u);
    if (currentArrayKey && arrayItem) {
      frontmatter[currentArrayKey].push(arrayItem[1].trim());
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1) {
      currentArrayKey = null;
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value === "") {
      frontmatter[key] = [];
      currentArrayKey = key;
      continue;
    }

    currentArrayKey = null;
    frontmatter[key] = value;
  }

  if (index > lines.length) {
    return null;
  }

  return {
    frontmatter,
    body: lines.slice(index).join("\n").replace(/^\n+/u, ""),
  };
}

function parseSections(body) {
  const sections = {};
  const lines = String(body ?? "").replace(/\r/gu, "").split("\n");
  let currentTitle = "";
  let buffer = [];

  function flush() {
    if (!currentTitle) return;
    sections[currentTitle] = buffer.join("\n").replace(/^\n+/u, "").replace(/\n+$/u, "");
  }

  for (const line of lines) {
    if (SECTION_HEADING_PATTERN.test(line)) {
      flush();
      currentTitle = line.slice(3).trim();
      buffer = [];
      continue;
    }

    if (currentTitle) {
      buffer.push(line);
    }
  }

  flush();
  return sections;
}

function parseLedgerLines(sectionText) {
  const text = normalize(sectionText);
  if (!text || PLACEHOLDER_PATTERN.test(text)) {
    return [];
  }

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

function parseInlineArray(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!ARRAY_LITERAL_PATTERN.test(value)) {
    return [];
  }

  const inner = value.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  return inner
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (
        (item.startsWith('"') && item.endsWith('"')) ||
        (item.startsWith("'") && item.endsWith("'"))
      ) {
        return item.slice(1, -1);
      }
      return item;
    });
}

function isArrayFrontmatterValue(value) {
  return Array.isArray(value) || ARRAY_LITERAL_PATTERN.test(String(value ?? "").trim());
}

function hasSection(sections, expectedTitle) {
  return Object.keys(sections).some((section) => section === expectedTitle || section.startsWith(`${expectedTitle} `));
}

function hasPersonaTimelineSection(sections) {
  return Object.keys(sections).some((section) => {
    const normalizedSection = section.toLowerCase();
    return normalizedSection === "timeline" || normalizedSection.includes("timeline") || section.includes("일지");
  });
}

function isProjectSummaryPage(fileName) {
  return fileName.startsWith("projects/") && !fileName.endsWith(".project-decisions.md");
}

function isMemoPage(fileName) {
  return fileName.startsWith("memos/");
}

function isLearningPage(fileName) {
  return /^learnings\/.+\.md$/u.test(fileName);
}

function isLessonPage(fileName) {
  return /^lessons\/.+\.md$/u.test(fileName);
}

function isResultArchivePage(fileName) {
  return RESULT_ARCHIVE_FILE_PATTERN.test(fileName);
}

function isCalendarPage(fileName) {
  return /^calendar\/.+\.md$/u.test(fileName);
}

function isProjectDecisionPage(fileName) {
  return /^projects\/[^/]+\.project-decisions\.md$/u.test(fileName);
}

function isTopLevelDomainPage(fileName) {
  return /^domains\/[^/]+\.md$/u.test(fileName);
}

// Persona-memory pages are the only top-level `domains/<name>.md` pages, and the tree names them
// itself (`personaMemoryPages` in its vault.config.json declaration, default none): no page shape
// tells a persona page from a topic page left at the top level.
function isPersonaMemoryPage(fileName, profile) {
  return (profile.personaMemoryPages ?? []).includes(fileName);
}

function isOperationalRulePage(fileName) {
  return /^operational-rules\/(?:README|[^/]+)\.md$/u.test(fileName);
}

function isNestedReferenceDocPage(fileName) {
  return (
    fileName.startsWith("docs/") ||
    /^domains\/[^/]+\/.+\.md$/u.test(fileName) ||
    /^projects\/[^/]+\/.+\.md$/u.test(fileName)
  );
}

function walkVaultMarkdownFileNames(vaultDir, currentDir = vaultDir, ctx) {
  const { profile } = ctx;
  const fileNames = [];

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const dirRelativePath = normalizeRelativePath(relative(vaultDir, join(currentDir, entry.name)));
      // Skip machine/vcs dirs, the profile's archive slots, the plans slot,
      // owner-local buckets, and (git-tracked scope) untracked subtrees — the
      // same non-nav set the generator prunes (원칙 3 Consistency).
      if (
        // Dot-directories (`.git`, `.fts/`, `.claude/`, …) are machine/config artifacts,
        // never knowledge pages — same parity skip as the index generator's descent.
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        isArchiveTreeRelativePath(dirRelativePath, profile) ||
        isPlansSlotPath(dirRelativePath, profile) ||
        isOwnerLocalBucketPath(dirRelativePath, profile) ||
        !isDirInLintNavScope(dirRelativePath, ctx)
      ) {
        continue;
      }
      fileNames.push(...walkVaultMarkdownFileNames(vaultDir, join(currentDir, entry.name), ctx));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    fileNames.push(resolve(currentDir, entry.name).slice(resolve(vaultDir).length + 1).replace(/\\/gu, "/"));
  }

  return fileNames.sort((left, right) => left.localeCompare(right));
}

function normalizeRequestedFiles(files, { vaultDir, mode, ctx } = {}) {
  if (!files) {
    if (mode === "full") {
      return walkVaultMarkdownFileNames(vaultDir, vaultDir, ctx);
    }
    return [...DEFAULT_SPECIAL_VAULT_FILES];
  }

  const rawItems = Array.isArray(files)
    ? files
    : String(files)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  if (rawItems.length === 0) {
    return [...DEFAULT_SPECIAL_VAULT_FILES];
  }

  return [...new Set(rawItems.map((item) => {
    const normalizedPath = item.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
    if (!normalizedPath.endsWith(".md")) {
      throw new Error(`Unsupported vault file: ${item}`);
    }
    return normalizedPath;
  }))];
}

function isIsoDateTime(value) {
  return Boolean(value) && /\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value));
}

function isIsoDate(value) {
  return ISO_DATE_PATTERN.test(String(value ?? "").trim()) && !Number.isNaN(Date.parse(`${String(value).trim()}T00:00:00Z`));
}

function validateFrontmatterValue(fileName, key, rule, rawValue) {
  const value = normalize(rawValue);
  if (!value) {
    return {
      code: "missing-frontmatter-field",
      message: `${fileName}: missing frontmatter field "${key}"`,
    };
  }

  if (rule.type === "string") {
    if (rule.exact && value !== String(rule.exact)) {
      return {
        code: "frontmatter-value-mismatch",
        message: `${fileName}: expected ${key}=${rule.exact}, received ${value}`,
      };
    }
    return null;
  }

  if (rule.type === "iso-datetime") {
    if (!isIsoDateTime(value)) {
      return {
        code: "frontmatter-type-mismatch",
        message: `${fileName}: frontmatter "${key}" must be an ISO datetime`,
      };
    }
    return null;
  }

  if (rule.type === "integer") {
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) {
      return {
        code: "frontmatter-type-mismatch",
        message: `${fileName}: frontmatter "${key}" must be an integer`,
      };
    }
    if (rule.min != null && numeric < rule.min) {
      return {
        code: "frontmatter-value-mismatch",
        message: `${fileName}: frontmatter "${key}" must be >= ${rule.min}`,
      };
    }
    if (rule.exact != null && numeric !== rule.exact) {
      return {
        code: "frontmatter-value-mismatch",
        message: `${fileName}: expected ${key}=${rule.exact}, received ${numeric}`,
      };
    }
    return null;
  }

  return {
    code: "unsupported-rule",
    message: `${fileName}: unsupported lint rule for "${key}"`,
  };
}

function stripMarkdownCode(contents) {
  let inFence = false;
  return String(contents ?? "")
    .replace(/\r/gu, "")
    .split("\n")
    .map((line) => {
      if (FENCED_CODE_PATTERN.test(line)) {
        inFence = !inFence;
        return "";
      }
      if (inFence) {
        return "";
      }
      return line.replace(/`[^`]*`/gu, "");
    })
    .join("\n");
}

function collectMarkdownLinks(contents) {
  const links = [];
  for (const match of stripMarkdownCode(contents).matchAll(MARKDOWN_LINK_PATTERN)) {
    const rawTarget = normalize(match[1]);
    if (!rawTarget) {
      continue;
    }
    links.push(rawTarget);
  }
  return links;
}

// A link target carrying a URI scheme (RFC 3986: scheme = ALPHA *( ALPHA / DIGIT
// / "+" / "-" / "." ) ":") is not a repo-relative file path: data: inline images
// (base64), mailto:, tel:, http(s):, obsidian:, etc. Repo-relative links
// (./foo.md, ../bar/baz.md, foo.md) never carry a scheme, so any scheme-prefixed
// target — plus pure #fragment links — must be skipped by the broken-link and
// reachability checks. Without this, base64 `![img](data:image/png;base64,…)`
// targets resolve as relative files and get reported as dead links — a large
// false-positive class on docs trees that embed inline images. The scheme must
// start with a letter and precede the first "/", so a digit-leading or
// path-embedded colon (2026-07-04:notes.md, dir/a:b.md) stays a relative path
// and is still checked.
const NON_FILE_URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;

function isExternalLink(target) {
  return target.startsWith("#") || NON_FILE_URI_SCHEME_PATTERN.test(target);
}

function cleanLinkTarget(target) {
  const cleaned = target
    .replace(/\s+".*"$/u, "")
    .replace(/\s+'.*'$/u, "")
    .split("#")[0]
    .trim();
  // Generated index links percent-encode parser-hostile characters
  // (encodeVaultLinkTarget); decode so the resolver sees the on-disk name. A
  // malformed escape in a hand-authored link keeps its raw form (never throw).
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}

const SPECIAL_FILES_HEADING_PATTERN = /^## Special Files(?:\s*\([^)]+\))?\s*$/mu;

function extractSchemaSections(schemaContents) {
  const specialMatch = schemaContents.match(SPECIAL_FILES_HEADING_PATTERN);
  if (!specialMatch) {
    return {};
  }

  const specialSlice = schemaContents.slice(specialMatch.index);
  const sections = {};
  let currentFile = null;
  let buffer = [];

  function flush() {
    if (!currentFile) {
      return;
    }
    sections[currentFile] = buffer.join("\n").trim();
  }

  for (const line of specialSlice.split("\n")) {
    const headingMatch = line.match(/^### \d+\) `([^`]+)`$/u);
    if (headingMatch) {
      flush();
      currentFile = headingMatch[1];
      buffer = [];
      continue;
    }

    if (currentFile && /^## /u.test(line)) {
      flush();
      currentFile = null;
      buffer = [];
      break;
    }

    if (currentFile) {
      buffer.push(line);
    }
  }

  flush();
  return sections;
}

function lintSchemaRegistration(fileName, spec, schemaSections) {
  const section = schemaSections[fileName];
  if (!section) {
    return [{
      code: "schema-missing-file",
      message: `${fileName}: schema.md is missing the ${fileName} special-file section`,
    }];
  }

  const issues = [];

  if (!section.includes(`type: ${spec.schemaType}`)) {
    issues.push({
      code: "schema-type-mismatch",
      message: `${fileName}: schema.md does not declare type: ${spec.schemaType}`,
    });
  }

  if (!section.includes(spec.schemaWriter)) {
    issues.push({
      code: "schema-writer-mismatch",
      message: `${fileName}: schema.md does not declare primary writer "${spec.schemaWriter}"`,
    });
  }

  return issues;
}

function lintStructuralRules(fileName, spec, sections) {
  const issues = [];

  if (spec.structuralChecks.includes("ledger")) {
    const lines = parseLedgerLines(sections["Entries"]);
    for (const line of lines) {
      if (!LEDGER_LINE_PATTERN.test(line)) {
        issues.push({
          code: "ledger-line-invalid",
          message: `${fileName}: invalid ledger line "${line}"`,
        });
      }
    }
  }

  return issues;
}

function lintRelativeLinks(fileName, absolutePath, contents) {
  const issues = [];
  const baseDir = realpathSync(dirname(absolutePath));
  for (const rawTarget of collectMarkdownLinks(contents)) {
    if (isExternalLink(rawTarget)) {
      continue;
    }

    const target = cleanLinkTarget(rawTarget);
    if (!target) {
      continue;
    }

    const resolvedTarget = resolve(baseDir, target);
    if (!existsSync(resolvedTarget)) {
      issues.push({
        code: "broken-link",
        message: `${fileName}: linked file does not exist: ${rawTarget}`,
      });
    }
  }
  return issues;
}

function normalizeRelativePath(value) {
  return String(value ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function stripMarkdownStem(fileName) {
  return fileName.replace(/\.md$/iu, "");
}

function extractTitleFromParsed(parsed, fallback) {
  const frontmatterTitle = normalize(parsed?.frontmatter?.title);
  if (frontmatterTitle) {
    return frontmatterTitle;
  }
  return extractTitle(parsed?.body ?? "", fallback);
}

function extractSummaryFromParsed(parsed, fallback) {
  const sections = parseSections(parsed?.body ?? "");
  const summary = normalize(sections.Summary);
  if (summary && !PLACEHOLDER_PATTERN.test(summary)) {
    return summary.replace(/\s+/gu, " ");
  }
  return extractSummary(parsed?.body ?? "", fallback);
}

function extractReadmeIntroSummary(body) {
  const lines = String(body ?? "").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("<!--")) {
      continue;
    }
    if (/^##\s+Vault Index\b/u.test(line) || /^##\s+Cross References\b/u.test(line)) {
      break;
    }
    return line.replace(/\s+/gu, " ");
  }
  return "";
}

function isArchiveRelativePath(relativePath, profile) {
  // Delegate to the generator's predicate so lint and vault-ingest share one
  // archive-slot contract per profile (SSoT #1; DEC step 8).
  return isArchiveTreeRelativePath(relativePath, profile);
}

// `isPlansSlotPath` and `isOwnerLocalBucketPath` (plans-slot delegation + owner-local
// bucket non-nav contracts) are owned by vault-ingest — the module that defines the
// generated README topology — and imported here so lint and the index generator share a
// single predicate and cannot drift apart (SSoT #1; 원칙 3 Consistency; DEC vault-compiler
// step 12/13).

function readVaultIndexChildSync(vaultDir, folderPath, entry, ctx) {
  const { profile } = ctx;
  const childPath = join(folderPath, entry.name);
  const relativePath = normalizeRelativePath(relative(vaultDir, childPath));

  if (entry.isDirectory()) {
    // Non-nav slots (plans store, owner-local buckets, and — under git-tracked
    // scope — untracked subtrees) are never part of the generated README
    // topology, so they must never appear as an expected index child either —
    // otherwise lint's index-region builder would disagree with the generator
    // (vault-ingest) and declare a correct region stale. Keep the two builders in
    // lockstep via the shared predicates + scope (원칙 3 Consistency; DEC step 13/8).
    if (
      isPlansSlotPath(relativePath, profile) ||
      isOwnerLocalBucketPath(relativePath, profile) ||
      !isDirInLintNavScope(relativePath, ctx)
    ) {
      return null;
    }
    const readmePath = join(childPath, "README.md");
    if (!existsSync(readmePath)) {
      return null;
    }
    const parsed = parseFrontmatter(readFileSync(readmePath, "utf8"));
    const label = `${entry.name}/`;
    const summary = (
      normalize(parseSections(parsed?.body ?? "").Summary) ||
      extractReadmeIntroSummary(parsed?.body ?? "") ||
      "Vault folder."
    ).replace(/\s+/gu, " ");
    return {
      path: normalizeRelativePath(relative(folderPath, readmePath)),
      label,
      summary,
      sortPath: `${entry.name}/README.md`,
      directory: true,
    };
  }

  if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") {
    return null;
  }
  if (entry.name === "README.md" || entry.name === "index.md") {
    return null;
  }
  // Mirror vault-ingest: root-level ledgers / agent-instruction files are not
  // navigation (profile.rootNonNavFiles).
  if (normalizeRelativePath(relative(vaultDir, folderPath)) === "" && profile.rootNonNavFiles.includes(entry.name)) {
    return null;
  }
  if (relativePath && isArchiveRelativePath(relativePath, profile)) {
    return null;
  }

  const parsed = parseFrontmatter(readFileSync(childPath, "utf8"));
  return {
    path: normalizeRelativePath(relative(folderPath, childPath)),
    label: extractTitleFromParsed(parsed, stripMarkdownStem(entry.name)),
    summary: extractSummaryFromParsed(parsed, stripMarkdownStem(entry.name)).replace(/\s+/gu, " "),
    sortPath: entry.name,
    directory: false,
  };
}

function buildVaultIndexRegionSync(vaultDir, readmePath, ctx) {
  const folderPath = dirname(readmePath);
  const folderRelativePath = normalizeRelativePath(relative(vaultDir, folderPath));
  if (folderRelativePath && isArchiveRelativePath(folderRelativePath, ctx.profile)) {
    return "";
  }

  const children = readdirSync(folderPath, { withFileTypes: true })
    .map((entry) => readVaultIndexChildSync(vaultDir, folderPath, entry, ctx))
    .filter(Boolean)
    .sort((left, right) => (
      Number(left.directory) - Number(right.directory) ||
      left.sortPath.localeCompare(right.sortPath)
    ));

  return children
    .map((entry) => `- [${entry.label}](${encodeVaultLinkTarget(entry.path)}) — ${rewriteCrossReferenceBullet(entry.summary, {
      filePath: resolve(dirname(readmePath), entry.path),
      relativePath: normalizeRelativePath(relative(vaultDir, resolve(dirname(readmePath), entry.path))),
    }, readmePath, vaultDir)}`)
    .join("\n");
}

function extractMarkerRegion(contents, startMarker, endMarker) {
  const pattern = new RegExp(
    `${startMarker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n?([\\s\\S]*?)\\n?${endMarker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
    "u",
  );
  const match = String(contents ?? "").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").match(pattern);
  return match ? match[1].trim() : null;
}

function extractRegionLinkTargets(regionMarkdown) {
  // Labels may legally contain `]` (e.g. a mail-subject title like "[미머디] …"), so a
  // naive [^\]]+ label class silently drops those lines and mis-reports the region as
  // stale. Lazy-match the label and anchor the link close on the generator's " — summary"
  // separator (or end of line) instead.
  return [...String(regionMarkdown ?? "").matchAll(/^\s*-\s+\[.+?\]\(([^)]+)\)(?=\s+—|\s*$)/gmu)]
    .map((match) => cleanLinkTarget(match[1]))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function lintReadmePage(fileName, absolutePath, mode, vaultDir, ctx) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");

  if (!contents.includes(VAULT_INDEX_START_MARKER) || !contents.includes(VAULT_INDEX_END_MARKER)) {
    issues.push({
      code: "missing-vault-index-region",
      message: `${fileName}: missing ${VAULT_INDEX_START_MARKER}/${VAULT_INDEX_END_MARKER} region`,
    });
  }

  if (mode === "full") {
    const actualRegion = extractMarkerRegion(contents, VAULT_INDEX_START_MARKER, VAULT_INDEX_END_MARKER);
    if (actualRegion != null) {
      // Validate only the generated navigation links. Curated prose carries
      // source-relative / external refs that are not navigation topology.
      issues.push(...lintRelativeLinks(fileName, absolutePath, actualRegion));
      const expectedRegion = buildVaultIndexRegionSync(vaultDir, absolutePath, ctx).trim();
      const actualLinks = extractRegionLinkTargets(actualRegion);
      const expectedLinks = extractRegionLinkTargets(expectedRegion);
      if (JSON.stringify(actualLinks) !== JSON.stringify(expectedLinks)) {
        issues.push({
          code: "vault-index-region-stale",
          message: `${fileName}: vault-index region is stale; rerun vault ingest to regenerate README topology`,
        });
      }
    }

  }

  // README/index pages route here BEFORE the type dispatch + the enforcePageFrontmatter gate,
  // so the deprecated-`domain` block would otherwise never reach category / calendar / folder
  // README pages, silently letting the retired field back in (원칙 6 No Silent Fallback). Apply
  // it here too, gated to the same profile as the leaf-page rules (kuma-vault only; the docs
  // profile lints READMEs on topology alone and never enforces frontmatter).
  if (ctx.profile.enforcePageFrontmatter) {
    const parsedReadme = parseFrontmatter(contents);
    if (parsedReadme) {
      issues.push(...lintDeprecatedDomainField(fileName, parsedReadme.frontmatter));
    }
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintProjectPageCanonicalDrift(fileName, parsed) {
  const issues = [];

  if (!isProjectSummaryPage(fileName)) {
    return issues;
  }

  if (String(parsed.body ?? "").includes("<!-- ingest:")) {
    issues.push({
      code: "project-ingest-marker",
      message: `${fileName}: project summary pages must not contain legacy ingest marker blocks`,
    });
  }

  const resultSources = parseInlineArray(parsed.frontmatter.sources)
    .filter((source) => RESULT_SOURCE_PATTERN.test(String(source ?? "").trim().replace(/\\/gu, "/")));
  if (resultSources.length > 0) {
    issues.push({
      code: "project-result-sources",
      message: `${fileName}: project summary pages must not keep result archives in frontmatter.sources`,
    });
  }

  return issues;
}

function scanCanonicalDrift(vaultDir) {
  const issues = [];

  const projectsDir = join(vaultDir, "projects");
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.endsWith(".project-decisions.md")) {
        continue;
      }

      const relativePath = `projects/${entry.name}`;
      const absolutePath = join(projectsDir, entry.name);
      const parsed = parseFrontmatter(readFileSync(absolutePath, "utf8"));
      if (!parsed) {
        continue;
      }
      issues.push(...lintProjectPageCanonicalDrift(relativePath, parsed).map((issue) => ({
        file: relativePath,
        ...issue,
      })));
    }

    // Invariant #9: a project's owner-local buckets (_evidence/_sources/_assets/...)
    // must live under projects/<slug>/, never as a shared bucket directly under
    // projects/. A shared bucket holding multiple projects' material is the
    // cross-owner split #9/#10 forbid.
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("_")) {
        continue;
      }
      const relativePath = `projects/${entry.name}`;
      issues.push({
        file: relativePath,
        code: "project-shared-evidence-bucket",
        message: `${relativePath}: project material must be co-located under projects/<slug>/${entry.name}, not a shared bucket directly under projects/ (invariant #9). Fold each project into its own folder and move its ${entry.name} inside, then remove ${relativePath}.`,
      });
    }
  }

  const inboxDir = join(vaultDir, "inbox");
  if (existsSync(inboxDir)) {
    for (const entry of readdirSync(inboxDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const relativePath = `inbox/${entry.name}`;
      const absolutePath = join(inboxDir, entry.name);
      const parsed = parseFrontmatter(readFileSync(absolutePath, "utf8"));
      if (!parsed) {
        continue;
      }

      const source = normalize(parsed.frontmatter.source).replace(/\\/gu, "/");
      if (!source.startsWith("skills/")) {
        continue;
      }

      issues.push({
        file: relativePath,
        code: "managed-skill-inbox",
        message: `${relativePath}: managed skill documents must not be staged in inbox/`,
      });
    }
  }

  const legacyRawMemosDir = join(vaultDir, "raw", "memos");
  if (existsSync(legacyRawMemosDir)) {
    const legacyEntries = readdirSync(legacyRawMemosDir, { withFileTypes: true });
    const hasLegacyMemoFiles = legacyEntries.some((entry) => entry.isFile() && entry.name.endsWith(".md"));
    const imagesEntry = legacyEntries.find((entry) => entry.isDirectory() && entry.name === "images");
    const hasLegacyMemoImages =
      Boolean(imagesEntry) &&
      readdirSync(join(legacyRawMemosDir, "images"), { withFileTypes: true })
        .some((entry) => entry.isFile());

    if (hasLegacyMemoFiles || hasLegacyMemoImages) {
      issues.push({
        file: "raw/memos",
        code: "legacy-raw-memos",
        message: "raw/memos: legacy memo artifacts must be migrated into memos/ and images/",
      });
    }
  }

  return issues;
}

function scanSpecialFileSetMismatch(schemaSections) {
  const runtimeFiles = new Set(DEFAULT_SPECIAL_VAULT_FILES);
  const schemaFiles = new Set(Object.keys(schemaSections ?? {}));
  const missingFromSchema = [...runtimeFiles].filter((fileName) => !schemaFiles.has(fileName));
  const extraInSchema = [...schemaFiles].filter((fileName) => !runtimeFiles.has(fileName));

  if (missingFromSchema.length === 0 && extraInSchema.length === 0) {
    return [];
  }

  const fragments = [];
  if (missingFromSchema.length > 0) {
    fragments.push(`missing in schema: ${missingFromSchema.sort((a, b) => a.localeCompare(b)).join(", ")}`);
  }
  if (extraInSchema.length > 0) {
    fragments.push(`unknown in schema: ${extraInSchema.sort((a, b) => a.localeCompare(b)).join(", ")}`);
  }

  return [{
    file: "schema.md",
    code: "schema-runtime-special-file-mismatch",
    message: `schema.md: special-file set diverges from runtime canonical set (${fragments.join("; ")})`,
  }];
}

function hasAssetDirectorySegment(relativePath) {
  return relativePath.split("/").some((segment) => (
    DOMAIN_ASSET_DIR_NAMES.has(segment) || segment.startsWith("_")
  ));
}

function scanDomainTreeDrift(vaultDir, profile) {
  const issues = [];
  const domainsDir = join(vaultDir, "domains");
  if (!existsSync(domainsDir)) {
    return issues;
  }

  for (const entry of readdirSync(domainsDir, { withFileTypes: true })) {
    const relativePath = `domains/${entry.name}`;
    if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      relativePath !== "domains/README.md" &&
      !isPersonaMemoryPage(relativePath, profile)
    ) {
      issues.push({
        file: relativePath,
        code: "domain-top-level-drift",
        message: `${relativePath}: top-level domain pages must be persona-memory pages declared in vault.config.json personaMemoryPages; put topics under a category directory`,
      });
      continue;
    }

    if (entry.isDirectory() && !entry.name.startsWith("_") && !existsSync(join(domainsDir, entry.name, "README.md"))) {
      issues.push({
        file: relativePath,
        code: "domain-category-dir-drift",
        message: `${relativePath}: top-level domain directories must have a README category index`,
      });
    }
  }

  function walk(currentDir, relativeDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const childRelativeDir = `${relativeDir}/${entry.name}`;
      if (hasAssetDirectorySegment(childRelativeDir)) {
        continue;
      }

      const absoluteChildDir = join(currentDir, entry.name);
      const expectedIndex = join(absoluteChildDir, "README.md");
      if (!existsSync(expectedIndex)) {
        issues.push({
          file: childRelativeDir,
          code: "domain-folder-index-missing",
          message: `${childRelativeDir}: domain folders must have a README entry point`,
        });
      }
      walk(absoluteChildDir, childRelativeDir);
    }
  }

  walk(domainsDir, "domains");
  return issues;
}

function isMarkdownFileName(fileName) {
  return fileName.endsWith(".md");
}

function isExcludedFromReachability(relativePath, profile) {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (normalizedPath === "index.md") {
    return true;
  }
  // Root-level ledgers / agent-instruction files are evidence/config, not
  // navigation. They are excluded from the generated root vault-index, so they
  // must also be exempt from per-item reachability (profile.rootNonNavFiles).
  if (profile.rootNonNavFiles.includes(normalizedPath)) {
    return true;
  }
  // The plans slot is delegated to plan-lint and is not part of the knowledge navigation
  // topology, so its pages are neither required to be reachable nor valid nav targets here.
  if (isPlansSlotPath(normalizedPath, profile)) {
    return true;
  }
  // Owner-local buckets (_assets/_sources/_evidence/...) hold evidence and originals, not
  // navigable knowledge pages (schema.md Page Rules). They are exempt from reachability the
  // same way archive dirs and the plans slot are — a file-back evidence dump must not need a
  // README nav chain to count as reachable.
  if (isOwnerLocalBucketPath(normalizedPath, profile)) {
    return true;
  }
  return isArchiveRelativePath(normalizedPath, profile);
}

function walkReachableMarkdownFiles(vaultDir, currentDir = vaultDir, ctx) {
  const { profile } = ctx;
  const files = [];
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = join(currentDir, entry.name);
    const relativePath = normalizeRelativePath(relative(vaultDir, fullPath));
    if (entry.isDirectory()) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        isArchiveRelativePath(relativePath, profile) ||
        isPlansSlotPath(relativePath, profile) ||
        isOwnerLocalBucketPath(relativePath, profile) ||
        !isDirInLintNavScope(relativePath, ctx)
      ) {
        continue;
      }
      files.push(...walkReachableMarkdownFiles(vaultDir, fullPath, ctx));
      continue;
    }
    if (!entry.isFile() || !isMarkdownFileName(entry.name) || isExcludedFromReachability(relativePath, profile)) {
      continue;
    }
    files.push(relativePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function pathSegmentsMatchCase(absolutePath) {
  const resolvedPath = resolve(absolutePath);
  const root = resolve("/");
  let current = root;
  const segments = resolvedPath.slice(root.length).split("/").filter(Boolean);
  for (const segment of segments) {
    if (!existsSync(current)) {
      return true;
    }
    const names = readdirSync(current);
    if (!names.includes(segment)) {
      return false;
    }
    current = join(current, segment);
  }
  return true;
}

function resolveVaultLinkTarget(vaultRealDir, fromFile, rawTarget) {
  const target = cleanLinkTarget(rawTarget);
  if (!target) {
    return { skip: true };
  }

  const baseDir = dirname(fromFile);
  const initialPath = resolve(baseDir, target);
  const candidates = [initialPath];
  if (!extname(initialPath)) {
    candidates.push(`${initialPath}.md`);
  }
  if (existsSync(initialPath)) {
    try {
      const maybeReadme = join(initialPath, "README.md");
      if (realpathSync(initialPath).startsWith(vaultRealDir) && existsSync(maybeReadme)) {
        candidates.unshift(maybeReadme);
      }
    } catch {
      // handled by candidate validation below
    }
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const candidatePath = statSync(candidate).isDirectory() ? join(candidate, "README.md") : candidate;
    if (!existsSync(candidatePath)) {
      continue;
    }
    const realCandidate = realpathSync(candidatePath);
    if (realCandidate !== vaultRealDir && !realCandidate.startsWith(`${vaultRealDir}/`)) {
      return { error: "out-of-root", path: candidatePath };
    }
    if (!pathSegmentsMatchCase(candidatePath)) {
      return { error: "case-mismatch", path: candidatePath };
    }
    return { path: realCandidate };
  }

  if (!initialPath.startsWith(vaultRealDir)) {
    return { error: "out-of-root", path: initialPath };
  }
  return { error: "broken-link", path: initialPath };
}

function scanLegacyIndexFiles(vaultDir, ctx) {
  const { profile } = ctx;
  const issues = [];
  function walk(currentDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = join(currentDir, entry.name);
      const relativePath = normalizeRelativePath(relative(vaultDir, fullPath));
      if (entry.isDirectory()) {
        if (
          entry.name === ".git" ||
          entry.name === "node_modules" ||
          isPlansSlotPath(relativePath, profile) ||
          isOwnerLocalBucketPath(relativePath, profile) ||
          !isDirInLintNavScope(relativePath, ctx)
        ) {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "index.md") {
        issues.push({
          file: relativePath,
          code: "legacy-index-file",
          message: `${relativePath}: flat/folder index.md files are retired; use README.md`,
        });
      }
    }
  }
  walk(vaultDir);
  return issues;
}

function collectNavigationLinkTargets(filePath) {
  // The navigation topology is defined ONLY by links inside README vault-index
  // regions (generated child links). Content pages are topology leaves: their
  // body-prose cross-references and cross-reference provenance links are not
  // navigation edges and are out of scope for reachability (DEC-J, SoC). This
  // keeps the topology gate from failing on pre-existing content link rot.
  if (basename(filePath) !== "README.md") {
    return [];
  }
  const region = extractMarkerRegion(
    readFileSync(filePath, "utf8"),
    VAULT_INDEX_START_MARKER,
    VAULT_INDEX_END_MARKER,
  );
  if (!region) {
    return [];
  }
  return collectMarkdownLinks(region);
}

function scanReachability(vaultDir, ctx) {
  const { profile } = ctx;
  const issues = [];
  const vaultRealDir = realpathSync(vaultDir);
  const rootReadmePath = join(vaultDir, "README.md");
  if (!existsSync(rootReadmePath)) {
    return [{
      file: "README.md",
      code: "missing-root-readme",
      message: "README.md: root vault topology entry point is missing",
    }];
  }

  const allMarkdown = new Set(walkReachableMarkdownFiles(vaultDir, vaultDir, ctx));
  const visited = new Set();
  const queue = [realpathSync(rootReadmePath)];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath || visited.has(currentPath)) {
      continue;
    }
    visited.add(currentPath);

    const currentRelativePath = normalizeRelativePath(relative(vaultRealDir, currentPath));
    for (const rawTarget of collectNavigationLinkTargets(currentPath)) {
      if (isExternalLink(rawTarget)) {
        continue;
      }
      const resolved = resolveVaultLinkTarget(vaultRealDir, currentPath, rawTarget);
      if (resolved.skip) {
        continue;
      }
      if (resolved.error) {
        issues.push({
          file: currentRelativePath,
          code: resolved.error,
          message: `${currentRelativePath}: invalid vault-index navigation link "${rawTarget}" (${resolved.error})`,
        });
        continue;
      }
      const targetRelativePath = normalizeRelativePath(relative(vaultRealDir, resolved.path));
      if (isExcludedFromReachability(targetRelativePath, profile)) {
        continue;
      }
      if (allMarkdown.has(targetRelativePath) && !visited.has(resolved.path)) {
        queue.push(resolved.path);
      }
    }
  }

  const visitedRelative = new Set([...visited].map((filePath) => normalizeRelativePath(relative(vaultRealDir, filePath))));
  for (const fileName of allMarkdown) {
    if (!visitedRelative.has(fileName)) {
      issues.push({
        file: fileName,
        code: "unreachable-vault-page",
        message: `${fileName}: page is not reachable from root README topology`,
      });
    }
  }

  return issues;
}

// Lenient contract check for a generated binary sidecar: verify the stamp fields the sidecar
// generator writes (title, source, sha256, extractor) are present. This is not the human nav-page
// contract — a sidecar is a derived artifact, so authoring fields are intentionally not required.
function lintSidecarPage(fileName, absolutePath) {
  const issues = [];
  const parsed = parseFrontmatter(readFileSync(absolutePath, "utf8"));
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  for (const key of ["title", "source", "sha256", "extractor"]) {
    if (!normalize(parsed.frontmatter[key])) {
      issues.push({
        code: "sidecar-stamp-missing-field",
        message: `${fileName}: generated sidecar is missing frontmatter field "${key}"`,
      });
    }
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

// `domain:` frontmatter is a DEPRECATED field (2026-07-05 폐기 결정). A page's membership
// (소속) is declared solely by its path in the vault topology; cross-cutting classification
// uses `tags`. Any hand-authored page that still carries a `domain:` field is drift, so the
// lint flags it EXPLICITLY — it must not creep back in after the vault-wide migration that
// strips the field from existing leaf pages. Same profile gating as the other canonical-page
// frontmatter rules (enforcePageFrontmatter — kuma-vault profile only, docs profile skips).
function lintDeprecatedDomainField(fileName, frontmatter) {
  if (!normalize(frontmatter.domain)) {
    return [];
  }
  return [{
    code: "deprecated-frontmatter-domain",
    message: `${fileName}: frontmatter.domain is deprecated (2026-07-05 폐기 결정 — 소속은 경로가 선언, 교차분류는 tags); remove the domain field`,
  }];
}

function lintGenericPage(fileName, absolutePath, mode, profile) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  const frontmatter = parsed.frontmatter;
  if (!normalize(frontmatter.title)) {
    issues.push({
      code: "missing-frontmatter-title",
      message: `${fileName}: frontmatter.title is required`,
    });
  }
  issues.push(...lintDeprecatedDomainField(fileName, frontmatter));
  if (!isArrayFrontmatterValue(frontmatter.tags)) {
    issues.push({
      code: "frontmatter-tags-format",
      message: `${fileName}: frontmatter.tags must use inline array syntax`,
    });
  }
  if (!isIsoDate(frontmatter.created)) {
    issues.push({
      code: "frontmatter-created-format",
      message: `${fileName}: frontmatter.created must be YYYY-MM-DD`,
    });
  }
  if (!isIsoDate(frontmatter.updated)) {
    issues.push({
      code: "frontmatter-updated-format",
      message: `${fileName}: frontmatter.updated must be YYYY-MM-DD`,
    });
  }
  if (
    normalize(frontmatter.sources) &&
    !(
      Array.isArray(frontmatter.sources) ||
      ARRAY_LITERAL_PATTERN.test(String(frontmatter.sources ?? "").trim())
    )
  ) {
    issues.push({
      code: "frontmatter-sources-format",
      message: `${fileName}: frontmatter.sources must use inline array syntax`,
    });
  }

  const sections = parseSections(parsed.body);
  // The required body shape is profile-owned (genericPageSections): the brain vault
  // demands Summary/Details/Related on every canonical page; a heterogeneous knowledge
  // repo (evaluation reports, verbatim originals) declares `[]` to keep frontmatter
  // enforcement without demanding a body restructure.
  for (const section of profile.genericPageSections ?? ["Summary", "Details", "Related"]) {
    if (!hasSection(sections, section)) {
      issues.push({
        code: "missing-section",
        message: `${fileName}: missing required section "## ${section}"`,
      });
    }
  }

  if (mode === "full") {
    issues.push(...lintProjectPageCanonicalDrift(fileName, parsed));
    issues.push(...lintRelativeLinks(fileName, absolutePath, parsed.body));
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintMemoPage(fileName, absolutePath, mode) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  const frontmatter = parsed.frontmatter;
  if (!normalize(frontmatter.title)) {
    issues.push({
      code: "missing-frontmatter-title",
      message: `${fileName}: frontmatter.title is required`,
    });
  }
  if (!isIsoDateTime(frontmatter.created)) {
    issues.push({
      code: "frontmatter-created-format",
      message: `${fileName}: frontmatter.created must be an ISO datetime`,
    });
  }
  if (!isIsoDateTime(frontmatter.updated)) {
    issues.push({
      code: "frontmatter-updated-format",
      message: `${fileName}: frontmatter.updated must be an ISO datetime`,
    });
  }
  if (
    !(
      Array.isArray(frontmatter.images) ||
      ARRAY_LITERAL_PATTERN.test(String(frontmatter.images ?? "").trim())
    )
  ) {
    issues.push({
      code: "frontmatter-images-format",
      message: `${fileName}: frontmatter.images must be an array`,
    });
  }
  issues.push(...lintDeprecatedDomainField(fileName, frontmatter));

  if (mode === "full") {
    issues.push(...lintRelativeLinks(fileName, absolutePath, parsed.body));
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintLearningPage(fileName, absolutePath, mode) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  const title = normalize(parsed.frontmatter.title) || normalize(parsed.frontmatter.name);
  if (!title) {
    issues.push({
      code: "missing-frontmatter-title",
      message: `${fileName}: frontmatter.title or frontmatter.name is required`,
    });
  }
  if (normalize(parsed.frontmatter.tags) && !isArrayFrontmatterValue(parsed.frontmatter.tags)) {
    issues.push({
      code: "frontmatter-tags-format",
      message: `${fileName}: frontmatter.tags must be an array`,
    });
  }

  const created = normalize(parsed.frontmatter.created);
  if (created && !(isIsoDate(created) || isIsoDateTime(created))) {
    issues.push({
      code: "frontmatter-created-format",
      message: `${fileName}: frontmatter.created must be YYYY-MM-DD or an ISO datetime`,
    });
  }
  const updated = normalize(parsed.frontmatter.updated);
  if (updated && !(isIsoDate(updated) || isIsoDateTime(updated))) {
    issues.push({
      code: "frontmatter-updated-format",
      message: `${fileName}: frontmatter.updated must be YYYY-MM-DD or an ISO datetime`,
    });
  }

  if (!normalize(parsed.body)) {
    issues.push({
      code: "missing-body",
      message: `${fileName}: learning pages require body content`,
    });
  }
  issues.push(...lintDeprecatedDomainField(fileName, parsed.frontmatter));

  if (mode === "full") {
    issues.push(...lintRelativeLinks(fileName, absolutePath, parsed.body));
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintLessonPage(fileName, absolutePath, mode) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  if (!normalize(parsed.frontmatter.title)) {
    issues.push({
      code: "missing-frontmatter-title",
      message: `${fileName}: frontmatter.title is required`,
    });
  }
  if (normalize(parsed.frontmatter.type) && normalize(parsed.frontmatter.type) !== "lesson") {
    issues.push({
      code: "frontmatter-type-mismatch",
      message: `${fileName}: frontmatter.type must be lesson when present`,
    });
  }
  const created = normalize(parsed.frontmatter.created);
  if (created && !(isIsoDate(created) || isIsoDateTime(created))) {
    issues.push({
      code: "frontmatter-created-format",
      message: `${fileName}: frontmatter.created must be YYYY-MM-DD or an ISO datetime`,
    });
  }
  if (normalize(parsed.frontmatter.tags) && !isArrayFrontmatterValue(parsed.frontmatter.tags)) {
    issues.push({
      code: "frontmatter-tags-format",
      message: `${fileName}: frontmatter.tags must be an array`,
    });
  }
  if (!normalize(parsed.body)) {
    issues.push({
      code: "missing-body",
      message: `${fileName}: lesson pages require body content`,
    });
  }
  issues.push(...lintDeprecatedDomainField(fileName, parsed.frontmatter));

  if (mode === "full") {
    issues.push(...lintRelativeLinks(fileName, absolutePath, parsed.body));
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintManagedSkillPage(fileName, absolutePath) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  const frontmatter = parsed.frontmatter;
  if (!normalize(frontmatter.title)) {
    issues.push({
      code: "missing-frontmatter-title",
      message: `${fileName}: managed skill pages require frontmatter.title`,
    });
  }
  if (!normalize(frontmatter.source).startsWith("skills/")) {
    issues.push({
      code: "managed-skill-source",
      message: `${fileName}: managed skill pages require frontmatter.source starting with "skills/"`,
    });
  }
  if (!normalize(frontmatter.sourcePath)) {
    issues.push({
      code: "managed-skill-source-path",
      message: `${fileName}: managed skill pages require frontmatter.sourcePath`,
    });
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintOperationalRulePage(fileName, absolutePath, mode) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  const frontmatter = parsed.frontmatter;
  if (!normalize(frontmatter.title)) {
    issues.push({
      code: "missing-frontmatter-title",
      message: `${fileName}: frontmatter.title is required`,
    });
  }
  issues.push(...lintDeprecatedDomainField(fileName, frontmatter));
  if (normalize(frontmatter.moved_to)) {
    if (mode === "full") {
      issues.push(...lintRelativeLinks(fileName, absolutePath, parsed.body));
    }
    return {
      file: fileName,
      path: absolutePath,
      ok: issues.length === 0,
      issues,
    };
  }
  if (!isArrayFrontmatterValue(frontmatter.tags)) {
    issues.push({
      code: "frontmatter-tags-format",
      message: `${fileName}: frontmatter.tags must use inline array syntax`,
    });
  }

  const lastVerified = normalize(frontmatter.last_verified);
  const updated = normalize(frontmatter.updated);
  if (!lastVerified && !updated) {
    issues.push({
      code: "missing-frontmatter-verification",
      message: `${fileName}: operational rule pages require frontmatter.last_verified or frontmatter.updated`,
    });
  }
  if (lastVerified && !isIsoDate(lastVerified)) {
    issues.push({
      code: "frontmatter-last-verified-format",
      message: `${fileName}: frontmatter.last_verified must be YYYY-MM-DD`,
    });
  }
  if (updated && !isIsoDate(updated)) {
    issues.push({
      code: "frontmatter-updated-format",
      message: `${fileName}: frontmatter.updated must be YYYY-MM-DD`,
    });
  }

  const sections = parseSections(parsed.body);

  if (!hasSection(sections, "Summary")) {
    issues.push({
      code: "missing-section",
      message: `${fileName}: missing required section "## Summary"`,
    });
  }
  if (!hasSection(sections, "Related")) {
    issues.push({
      code: "missing-section",
      message: `${fileName}: missing required section "## Related"`,
    });
  }

  const additionalSections = Object.keys(sections).filter((section) => !["Summary", "Related"].includes(section));
  if (additionalSections.length === 0) {
    issues.push({
      code: "missing-section",
      message: `${fileName}: operational rule pages must include at least one rule/details section besides Summary and Related`,
    });
  }

  if (mode === "full") {
    issues.push(...lintRelativeLinks(fileName, absolutePath, parsed.body));
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintProjectDecisionPage(fileName, absolutePath, mode) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  const frontmatter = parsed.frontmatter;
  if (!normalize(frontmatter.title)) {
    issues.push({
      code: "missing-frontmatter-title",
      message: `${fileName}: frontmatter.title is required`,
    });
  }
  if (normalize(frontmatter.type) !== "special/project-decisions") {
    issues.push({
      code: "frontmatter-type-mismatch",
      message: `${fileName}: frontmatter.type must be "special/project-decisions"`,
    });
  }
  if (!normalize(frontmatter.project)) {
    issues.push({
      code: "missing-frontmatter-project",
      message: `${fileName}: frontmatter.project is required`,
    });
  }
  if (!isIsoDateTime(frontmatter.updated)) {
    issues.push({
      code: "frontmatter-updated-format",
      message: `${fileName}: frontmatter.updated must be an ISO datetime`,
    });
  }

  const bootPriority = Number(normalize(frontmatter.boot_priority));
  if (!Number.isInteger(bootPriority)) {
    issues.push({
      code: "frontmatter-boot-priority-format",
      message: `${fileName}: frontmatter.boot_priority must be an integer`,
    });
  }
  issues.push(...lintDeprecatedDomainField(fileName, frontmatter));

  const sections = parseSections(parsed.body);
  for (const section of ["About", "Decisions"]) {
    if (!hasSection(sections, section)) {
      issues.push({
        code: "missing-section",
        message: `${fileName}: missing required section "## ${section}"`,
      });
    }
  }

  if (mode === "full") {
    issues.push(...lintRelativeLinks(fileName, absolutePath, parsed.body));
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintReferenceDocPage(fileName, absolutePath) {
  return {
    file: fileName,
    path: absolutePath,
    ok: true,
    issues: [],
  };
}

function lintCalendarPage(fileName, absolutePath, mode) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  if (!normalize(parsed.frontmatter.title)) {
    issues.push({
      code: "missing-frontmatter-title",
      message: `${fileName}: frontmatter.title is required`,
    });
  }
  issues.push(...lintDeprecatedDomainField(fileName, parsed.frontmatter));

  const sections = parseSections(parsed.body);
  if (fileName === "calendar/README.md") {
    if (!hasSection(sections, "Events")) {
      issues.push({
        code: "missing-section",
        message: `${fileName}: missing required section "## Events"`,
      });
    }
  } else if (!isIsoDate(parsed.frontmatter.date) && !normalize(parsed.frontmatter.start)) {
    issues.push({
      code: "missing-frontmatter-date",
      message: `${fileName}: calendar events require frontmatter.date or frontmatter.start`,
    });
  }

  if (mode === "full") {
    issues.push(...lintRelativeLinks(fileName, absolutePath, parsed.body));
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintPersonaMemoryPage(fileName, absolutePath, mode) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  if (!normalize(parsed.frontmatter.title)) {
    issues.push({
      code: "missing-frontmatter-title",
      message: `${fileName}: frontmatter.title is required`,
    });
  }
  if (!normalize(parsed.frontmatter.slug)) {
    issues.push({
      code: "missing-frontmatter-slug",
      message: `${fileName}: frontmatter.slug is required`,
    });
  }
  if (normalize(parsed.frontmatter.type) && normalize(parsed.frontmatter.type) !== "domain") {
    issues.push({
      code: "frontmatter-type-mismatch",
      message: `${fileName}: frontmatter.type must be domain when present`,
    });
  }
  const updated = normalize(parsed.frontmatter.updated);
  if (!(isIsoDate(updated) || isIsoDateTime(updated))) {
    issues.push({
      code: "frontmatter-updated-format",
      message: `${fileName}: frontmatter.updated must be YYYY-MM-DD or an ISO datetime`,
    });
  }
  issues.push(...lintDeprecatedDomainField(fileName, parsed.frontmatter));

  const sections = parseSections(parsed.body);
  if (!hasSection(sections, "About")) {
    issues.push({
      code: "missing-section",
      message: `${fileName}: missing required section "## About"`,
    });
  }
  if (!hasPersonaTimelineSection(sections)) {
    issues.push({
      code: "missing-section",
      message: `${fileName}: missing persona timeline section`,
    });
  }

  if (mode === "full") {
    issues.push(...lintRelativeLinks(fileName, absolutePath, parsed.body));
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintLogFile(fileName, absolutePath) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");

  if (!contents.startsWith("# Kuma Vault Change Log")) {
    issues.push({
      code: "log-heading",
      message: `${fileName}: must start with "# Kuma Vault Change Log"`,
    });
  }

  if (!/^## \d{4}-\d{2}-\d{2}$/mu.test(contents)) {
    issues.push({
      code: "missing-log-date-section",
      message: `${fileName}: must include at least one date section heading`,
    });
  }

  if (!/^- (INIT|MIGRATE|UPDATE|INGEST|CREATE|ARCHIVE|SYNC_SKILLS): /mu.test(contents)) {
    issues.push({
      code: "missing-log-entry",
      message: `${fileName}: must include at least one change entry`,
    });
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintResultArchivePage(fileName, absolutePath) {
  return {
    file: fileName,
    path: absolutePath,
    ok: true,
    issues: [],
  };
}

function lintSchemaFile(fileName, absolutePath, mode) {
  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: fileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${fileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  if (!normalize(parsed.frontmatter.title)) {
    issues.push({
      code: "missing-frontmatter-title",
      message: `${fileName}: frontmatter.title is required`,
    });
  }
  if (!contents.includes("# Kuma Vault Schema")) {
    issues.push({
      code: "schema-heading",
      message: `${fileName}: must declare "# Kuma Vault Schema"`,
    });
  }

  for (const section of ["## Summary", "## Directories", "## Special Files"]) {
    if (!contents.includes(section)) {
      issues.push({
        code: "missing-section",
        message: `${fileName}: missing required section "${section}"`,
      });
    }
  }

  if (mode === "full") {
    issues.push(...lintRelativeLinks(fileName, absolutePath, parsed.body));
  }

  return {
    file: fileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

function lintSingleFile({ vaultDir, fileName, mode, schemaSections, ctx }) {
  const { profile } = ctx;
  const normalizedFileName = fileName.replace(/\\/gu, "/");
  const baseFileName = basename(normalizedFileName);
  const spec = normalizedFileName === baseFileName ? SPECIAL_VAULT_FILE_SPECS[baseFileName] : null;
  const absolutePath = resolve(vaultDir, normalizedFileName);

  if (!existsSync(absolutePath)) {
    return {
      file: normalizedFileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-file",
        message: `${normalizedFileName}: file does not exist`,
      }],
    };
  }

  // Root-level non-nav files (ledgers, agent-instruction, design docs) are not
  // navigable knowledge pages, so the canonical-page contract must not apply
  // (profile.rootNonNavFiles — same non-nav treatment as the plans slot below).
  if (profile.rootNonNavFiles.includes(normalizedFileName)) {
    return { file: normalizedFileName, path: absolutePath, ok: true, issues: [] };
  }

  // Delegate the plans slot to `kuma plan lint` (see isPlansSlotPath). Even when a plan file
  // is requested explicitly (--files / lifecycle hook on a changed plan), vault-lint reports
  // no canonical-page findings for it — the plan contract is enforced by plan-lint, its owner.
  if (isPlansSlotPath(normalizedFileName, profile)) {
    return {
      file: normalizedFileName,
      path: absolutePath,
      ok: true,
      issues: [],
    };
  }

  // A README living inside an owner-local bucket (`_assets/`, `_sources/`,
  // `_evidence/`, `_archive/`, …) is a non-nav evidence holder, not part of the
  // generated navigation topology. The index generator (vault-ingest) neither
  // mints nor maintains it (DEC vault-compiler step 13), so applying the nav
  // index-region contract here would demand a regeneration the generator refuses
  // to perform — a guaranteed lint↔generator contradiction (원칙 3 Consistency).
  // It is exempt from README-page nav linting, the same non-nav treatment the
  // plans slot already gets above; its non-README evidence docs still lint
  // normally (leniently) as nested reference pages.
  if (
    isOwnerLocalBucketPath(normalizedFileName, profile) &&
    (normalizedFileName === "README.md" || normalizedFileName.endsWith("/README.md"))
  ) {
    return {
      file: normalizedFileName,
      path: absolutePath,
      ok: true,
      issues: [],
    };
  }

  // A binary sidecar `<name>.<ext>.md` is a generated derivative — a pure function of its
  // source binary produced by `kuma vault sync` (DEC vault-compiler step 5). It is not a
  // hand-authored nav page, so the canonical-page authoring contract (title/created/updated,
  // the deprecated-`domain` block, etc.) must not apply — the same non-nav treatment plans-slot
  // and bucket files already get,
  // and the same lint↔generator parity principle as step 13: never demand fields the generator
  // does not (and cannot deterministically) produce. Its own sidecar-stamp contract is checked
  // leniently instead.
  if (isSidecarPath(normalizedFileName, profile)) {
    return lintSidecarPage(normalizedFileName, absolutePath);
  }

  if (normalizedFileName === "README.md" || normalizedFileName.endsWith("/README.md")) {
    return lintReadmePage(normalizedFileName, absolutePath, mode, vaultDir, ctx);
  }

  // Profiles that don't enforce the canonical-page frontmatter contract (generic
  // docs-as-code trees) lint content pages on topology only:
  // broken relative links, nothing else. README index-region + reachability are
  // still enforced (above / in the global scans) — that is the docs-as-code
  // contract (folder README = index, no orphans, no broken links).
  if (!profile.enforcePageFrontmatter) {
    const issues = mode === "full"
      ? lintRelativeLinks(normalizedFileName, absolutePath, readFileSync(absolutePath, "utf8"))
      : [];
    return { file: normalizedFileName, path: absolutePath, ok: issues.length === 0, issues };
  }

  if (normalizedFileName === "log.md") {
    return lintLogFile(normalizedFileName, absolutePath);
  }

  if (normalizedFileName === "schema.md") {
    return lintSchemaFile(normalizedFileName, absolutePath, mode);
  }

  if (isCalendarPage(normalizedFileName)) {
    return lintCalendarPage(normalizedFileName, absolutePath, mode);
  }

  if (isMemoPage(normalizedFileName)) {
    return lintMemoPage(normalizedFileName, absolutePath, mode);
  }

  if (isLearningPage(normalizedFileName)) {
    return lintLearningPage(normalizedFileName, absolutePath, mode);
  }

  if (isLessonPage(normalizedFileName)) {
    return lintLessonPage(normalizedFileName, absolutePath, mode);
  }

  if (isResultArchivePage(normalizedFileName)) {
    return lintResultArchivePage(normalizedFileName, absolutePath);
  }

  if (isPersonaMemoryPage(normalizedFileName, profile)) {
    return lintPersonaMemoryPage(normalizedFileName, absolutePath, mode);
  }

  if (isNestedReferenceDocPage(normalizedFileName)) {
    return lintReferenceDocPage(normalizedFileName, absolutePath);
  }

  if (isOperationalRulePage(normalizedFileName)) {
    return lintOperationalRulePage(normalizedFileName, absolutePath, mode);
  }

  if (isProjectDecisionPage(normalizedFileName)) {
    return lintProjectDecisionPage(normalizedFileName, absolutePath, mode);
  }

  if (isTopLevelDomainPage(normalizedFileName)) {
    const parsed = parseFrontmatter(readFileSync(absolutePath, "utf8"));
    if (parsed && normalize(parsed.frontmatter.source).startsWith("skills/")) {
      return lintManagedSkillPage(normalizedFileName, absolutePath);
    }
  }

  if (!spec) {
    return lintGenericPage(normalizedFileName, absolutePath, mode, profile);
  }

  const issues = [];
  const contents = readFileSync(absolutePath, "utf8");
  const parsed = parseFrontmatter(contents);
  if (!parsed) {
    return {
      file: normalizedFileName,
      path: absolutePath,
      ok: false,
      issues: [{
        code: "missing-frontmatter",
        message: `${normalizedFileName}: YAML frontmatter is missing or malformed`,
      }],
    };
  }

  for (const [key, rule] of Object.entries(spec.frontmatter)) {
    const issue = validateFrontmatterValue(normalizedFileName, key, rule, parsed.frontmatter[key]);
    if (issue) {
      issues.push(issue);
    }
  }

  if (mode === "full") {
    const sections = parseSections(parsed.body);

    for (const section of spec.requiredSections) {
      if (!hasSection(sections, section)) {
        issues.push({
          code: "missing-section",
          message: `${normalizedFileName}: missing required section "## ${section}"`,
        });
      }
    }

    issues.push(...lintSchemaRegistration(normalizedFileName, spec, schemaSections));
    issues.push(...lintStructuralRules(normalizedFileName, spec, sections));
    issues.push(...lintRelativeLinks(normalizedFileName, absolutePath, parsed.body));
  }

  return {
    file: normalizedFileName,
    path: absolutePath,
    ok: issues.length === 0,
    issues,
  };
}

// --- Cross-store pointer check ---------------------------------------------
//
// A cross-store pointer is an inline-code span `<store-id>:<relative-path>` that
// names a document living in ANOTHER knowledge tree (schema.md "Cross-store
// 포인터"). This check parses those tokens out of document bodies and resolves
// each against the machine store registry (vault-stores.mjs), failing loud on
// anything that does not resolve — the machine-checkable half of the convention.
//
// False-positive boundary (오탐 경계): only a single-backtick inline-code span
// counts (fenced code blocks are examples, skipped); the store-id must be
// lowercase kebab; and the target must be a vault DOCUMENT reference — a path
// ending in `.md` (a markdown page) or `/` (a directory). A cross-store pointer
// names a document in another tree (schema.md convention), so this shape is the
// convention itself, not a heuristic. It excludes mail headers and URI schemes
// whose value merely looks path-like — `to:user@x.app`, `from:host.com`,
// `file:../x`, `data:image/png;base64,…` — as well as URLs (`https://…`), clock
// and ratio text (`16:9`, `12:30`), and plain `key: value` colons.
const CROSS_STORE_POINTER_PATTERN = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*):([^\s`]+)$/u;
const CROSS_STORE_DOC_TARGET = /(?:\.md|\/)$/u;

function isCrossStorePointerTarget(targetPath) {
  if (!targetPath || targetPath.startsWith("/")) return false;
  if (targetPath.includes("://")) return false;
  return CROSS_STORE_DOC_TARGET.test(targetPath);
}

// Exported: `vault graph` draws its external-store layer from the same parse,
// so the pointer grammar and its false-positive boundary stay single-owner here.
export function extractCrossStorePointers(contents) {
  const pointers = [];
  let inFence = false;
  const lines = String(contents ?? "").replace(/\r/gu, "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCED_CODE_PATTERN.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    for (const match of line.matchAll(/`([^`\n]+)`/gu)) {
      const parts = match[1].trim().match(CROSS_STORE_POINTER_PATTERN);
      if (!parts) {
        continue;
      }
      const [raw, storeId, targetPath] = parts;
      if (!isCrossStorePointerTarget(targetPath)) {
        continue;
      }
      pointers.push({ raw, storeId, targetPath, line: i + 1 });
    }
  }
  return pointers;
}

function resolveCrossStorePointer(fileName, pointer, registry) {
  const { storeId, targetPath, raw, line } = pointer;
  const where = `${fileName}:${line}`;
  const entry = registry.stores.get(storeId);
  if (!entry) {
    return {
      file: fileName,
      code: "cross-store-unknown-store",
      severity: "error",
      message: `${where}: cross-store pointer \`${raw}\` names store "${storeId}" which is not in the registry (${registry.path}) — register it or fix the store-id`,
    };
  }
  if (entry.status === "root-missing") {
    return {
      file: fileName,
      code: "cross-store-store-root-missing",
      severity: "error",
      message: `${where}: cross-store pointer \`${raw}\`: registry maps store "${storeId}" to ${entry.rootDir}, which does not exist on this machine`,
    };
  }
  if (entry.status === "id-mismatch") {
    const declared = entry.declaredId ? `declares id "${entry.declaredId}"` : "declares no id";
    const detail = entry.detail ? ` (${entry.detail})` : "";
    return {
      file: fileName,
      code: "cross-store-registry-mismatch",
      severity: "error",
      message: `${where}: cross-store pointer \`${raw}\`: registry maps store "${storeId}" to ${entry.rootDir}, but that tree ${declared}${detail}`,
    };
  }

  const wantsDir = targetPath.endsWith("/");
  const normalized = targetPath.replace(/\/+$/u, "");
  const resolvedTarget = resolve(entry.rootDir, normalized);
  const rootWithSep = entry.rootDir.endsWith("/") ? entry.rootDir : `${entry.rootDir}/`;
  if (resolvedTarget !== entry.rootDir && !resolvedTarget.startsWith(rootWithSep)) {
    return {
      file: fileName,
      code: "cross-store-pointer-invalid",
      severity: "error",
      message: `${where}: cross-store pointer \`${raw}\` escapes the "${storeId}" store root`,
    };
  }
  const stat = existsSync(resolvedTarget) ? statSync(resolvedTarget) : null;
  const typeOk = stat && (wantsDir ? stat.isDirectory() : stat.isFile());
  if (!typeOk) {
    const kind = wantsDir ? "directory" : "file";
    return {
      file: fileName,
      code: "cross-store-pointer-unresolved",
      severity: "error",
      message: `${where}: cross-store pointer \`${raw}\` does not resolve — no ${kind} at ${resolvedTarget}`,
    };
  }
  return null;
}

// Scan the requested files for cross-store pointers and resolve them against the
// machine registry. Runs over `targetFiles` (whole-tree walk or an explicit
// --files subset), so the pre-commit path catches a broken pointer in a changed
// file too. Returns global issues (each already carrying `file`).
function scanCrossStorePointers({ vaultDir, targetFiles, registry }) {
  const issues = [];
  let candidateCount = 0;
  const canResolve = registry.present && !registry.invalid;

  for (const fileName of targetFiles) {
    const absolutePath = resolve(vaultDir, fileName);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const pointers = extractCrossStorePointers(readFileSync(absolutePath, "utf8"));
    if (pointers.length === 0) {
      continue;
    }
    candidateCount += pointers.length;
    if (!canResolve) {
      continue;
    }
    for (const pointer of pointers) {
      const issue = resolveCrossStorePointer(fileName, pointer, registry);
      if (issue) {
        issues.push(issue);
      }
    }
  }

  if (candidateCount === 0) {
    return issues;
  }
  // Registry present-but-broken, or absent: never resolve silently (원칙 6).
  if (registry.invalid) {
    issues.push({
      file: "(cross-store registry)",
      code: "cross-store-registry-invalid",
      severity: "error",
      message: `store registry ${registry.path} is present but invalid: ${registry.invalid} — ${candidateCount} cross-store pointer(s) cannot be resolved until it is fixed`,
    });
  } else if (!registry.present) {
    issues.push({
      file: "(cross-store registry)",
      code: "cross-store-check-skipped",
      severity: "warn",
      message: `${candidateCount} cross-store pointer(s) found but no store registry at ${registry.path} — resolution skipped on this machine (create it to enable the check)`,
    });
  }
  return issues;
}

export function lintVaultFiles({
  vaultDir,
  mode = "full",
  files,
  schemaPath,
  profile,
} = {}) {
  const resolvedVaultDir = resolve(vaultDir ?? resolveVaultDir());
  const lintMode = mode === "fast" ? "fast" : "full";
  const ctx = buildLintNavContext(resolvedVaultDir, profile);
  const activeProfile = ctx.profile;
  const targetFiles = normalizeRequestedFiles(files, { vaultDir: resolvedVaultDir, mode: lintMode, ctx });
  const hasExplicitFiles = files != null && !(Array.isArray(files) && files.length === 0);
  const startedAt = performance.now();
  let schemaSections = {};
  let schemaResolvedPath = null;
  const filesResult = [];
  const globalIssues = [];

  if (lintMode === "full") {
    // The schema special-file contract (schema.md `## Special Files` + per-file
    // frontmatter/type/writer) is a vault-specific canonical check. Generic
    // docs-as-code profiles keep their rules in a runbook, not a
    // machine-validated schema, so they skip this block entirely.
    if (activeProfile.schema.validateSpecialFiles) {
      schemaResolvedPath = resolve(schemaPath ?? join(resolvedVaultDir, activeProfile.schema.path));
      if (!existsSync(schemaResolvedPath)) {
        globalIssues.push({
          file: "schema.md",
          code: "missing-schema",
          message: `schema.md is missing: ${schemaResolvedPath}`,
        });
      } else {
        const schemaContents = readFileSync(schemaResolvedPath, "utf8");
        schemaSections = extractSchemaSections(schemaContents);
        if (Object.keys(schemaSections).length === 0) {
          globalIssues.push({
            file: "schema.md",
            code: "schema-special-files-missing",
            message: "schema.md is missing the `## Special Files` section",
          });
        }
        globalIssues.push(...scanSpecialFileSetMismatch(schemaSections));
      }
    }

    if (!hasExplicitFiles) {
      // Universal docs-as-code structural checks (broken links, orphans, legacy
      // index.md) run for every profile.
      globalIssues.push(...scanLegacyIndexFiles(resolvedVaultDir, ctx));
      globalIssues.push(...scanReachability(resolvedVaultDir, ctx));
      // Vault-specific canonical invariants (projects/ drift, domain taxonomy)
      // only apply to a tree that carries those slot semantics.
      if (activeProfile.canonicalChecks) {
        globalIssues.push(...scanCanonicalDrift(resolvedVaultDir));
        globalIssues.push(...scanDomainTreeDrift(resolvedVaultDir, activeProfile));
      }
    }

    // Cross-store pointer resolution runs on whatever files were requested
    // (whole-tree walk or an explicit --files subset), independent of the
    // whole-tree-only scans above.
    globalIssues.push(...scanCrossStorePointers({
      vaultDir: resolvedVaultDir,
      targetFiles,
      registry: loadStoreRegistry(),
    }));
  }

  for (const fileName of targetFiles) {
    filesResult.push(lintSingleFile({
      vaultDir: resolvedVaultDir,
      fileName,
      mode: lintMode,
      schemaSections,
      ctx,
    }));
  }

  const issues = [
    ...globalIssues,
    ...filesResult.flatMap((entry) => entry.issues.map((issue) => ({ file: entry.file, ...issue }))),
  ];
  // Severity gate: an issue with no explicit severity is an `error` (every
  // pre-existing check). Only `warn`/`info` issues are reported without failing
  // the lint — e.g. the cross-store skip notice on a machine with no registry.
  const isError = (issue) => (issue.severity ?? "error") === "error";
  const errorCount = issues.filter(isError).length;
  const durationMs = Number((performance.now() - startedAt).toFixed(3));

  return {
    ok: errorCount === 0,
    mode: lintMode,
    vaultDir: resolvedVaultDir,
    schemaPath: schemaResolvedPath,
    files: filesResult,
    globalIssues,
    issues,
    issueCount: issues.length,
    errorCount,
    warningCount: issues.filter((issue) => issue.severity === "warn").length,
    fileCount: filesResult.length,
    durationMs,
  };
}

export function formatVaultLintReport(result) {
  const status = result.ok ? "VAULT_LINT_OK" : "VAULT_LINT_FAIL";
  const lines = [
    `${status} mode=${result.mode} files=${result.fileCount} duration_ms=${result.durationMs}`,
  ];

  for (const fileResult of result.files) {
    lines.push(`${fileResult.ok ? "OK" : "FAIL"} ${fileResult.file}`);
    for (const issue of fileResult.issues) {
      lines.push(`- ${issue.message}`);
    }
  }

  // Global (tree-level) issues — schema, reachability, canonical drift, and
  // cross-store — are not tied to a per-file result block, so print them here.
  for (const issue of result.globalIssues ?? []) {
    const marker = issue.severity === "warn" ? "- [warn] " : "- ";
    lines.push(`${marker}${issue.message}`);
  }

  return `${lines.join("\n")}\n`;
}

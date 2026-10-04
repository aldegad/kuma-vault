import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { DEFAULT_DISPATCH_RESULT_DIR, DEFAULT_DISPATCH_TASK_DIR, DEFAULT_VAULT_INGEST_STAMP_DIR } from "./kuma-paths.mjs";
import { resolveVaultDir } from "./path-resolver.mjs";
import { writeFileAtomic } from "./atomic-file-store.mjs";
import { VAULT_PROFILE, resolveProfile } from "./vault-profile.mjs";
import {
  detectProjectIdFromContentText,
  inferProjectIdFromSlugPrefix,
} from "./project-attribution.mjs";

const RESULT_ARCHIVE_DIR = "results";
const VAULT_SECTION_DIRS = ["domains", "projects", "memos", "learnings", RESULT_ARCHIVE_DIR, "inbox"];
// Archive-tree slots are now profile-owned (VAULT_PROFILE.archiveTreeDirs) so the
// same predicate serves the vault and generic docs-as-code trees.
const INGESTIBLE_INBOX_EXTENSIONS = new Set([".md", ".txt", ".json", ".log"]);
const RESULT_FILE_PATTERN = /\.result\.md$/u;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/gu;
export const VAULT_INDEX_START_MARKER = "<!-- vault-index:start -->";
export const VAULT_INDEX_END_MARKER = "<!-- vault-index:end -->";
// Append-only runtime ledgers are evidence/history, not navigation topology.
// They are reachable from the root README's curated "Special Files" prose, so
// the generated root vault-index excludes them (they are not canonical knowledge
// slots a reader navigates the topology to reach).
export const VAULT_ROOT_NON_NAV_FILES = new Set(["dispatch-log.md", "log.md"]);
const PROJECT_STATE_START_MARKER = "<!-- project-state:start -->";
const PROJECT_STATE_END_MARKER = "<!-- project-state:end -->";
const LEGACY_PROJECT_INGEST_BLOCK_PATTERN = /<!-- ingest:[^:]+:start -->[\s\S]*?<!-- ingest:[^:]+:end -->/gu;
const PROJECT_ROUTING_KEYWORDS = [
  "project", "milestone", "roadmap", "backlog", "issue", "issues", "todo", "task", "tasks",
  "architecture", "migration", "release", "deploy", "deployment", "sprint", "spec", "prd",
  "프로젝트", "마일스톤", "로드맵", "백로그", "이슈", "할일", "작업", "아키텍처", "마이그레이션", "릴리즈", "배포", "명세",
];
const LEARNING_ROUTING_KEYWORDS = [
  "rule", "rules", "guideline", "guidelines", "playbook", "runbook", "checklist", "postmortem", "rca",
  "debug", "debugging", "troubleshoot", "troubleshooting", "lesson", "lessons", "benchmark", "performance",
  "timeout", "flaky", "incident", "recovery", "pattern",
  "규칙", "원칙", "가이드", "가이드라인", "플레이북", "런북", "체크리스트", "장애", "원인", "복구", "디버깅", "교훈", "벤치마크", "성능", "패턴",
];
const DOMAIN_ROUTING_KEYWORDS = [
  "company", "service", "product", "vendor", "market", "competitor", "website", "homepage", "pricing",
  "price", "plan", "feature", "platform", "api", "sdk", "library", "tool", "resume", "portfolio", "candidate",
  "회사", "서비스", "제품", "사이트", "홈페이지", "가격", "요금", "플랜", "기능", "플랫폼", "api", "라이브러리", "도구", "이력서", "포트폴리오", "후보자",
];
const DEFAULT_SCHEMA_CONTENT = `---
title: Kuma Vault Schema
description: Vault 페이지 작성 규칙과 운영 원칙
---

# Kuma Vault Schema

## 원칙
1. Single Source of Truth
2. Append-friendly
3. 교차참조
4. QA 통과 결과만 ingest
`;

function normalizeLineEndings(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function normalizePathSeparators(value) {
  return String(value ?? "").replace(/\\/gu, "/");
}

function collapseToSingleLine(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizeFrontmatterValue(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    return "";
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      return [];
    }

    return inner
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        // Double-quoted items are emitted by `formatInlineArrayItem` via `JSON.stringify`, so
        // `JSON.parse` is the exact inverse (\" -> ", \\ -> \) — a naive slice would leave the
        // escape backslashes in the value. Fall back to a plain unwrap for a hand-authored or
        // malformed item that is not valid JSON (원칙 3: the reader mirrors the writer's codec).
        if (item.length >= 2 && item.startsWith('"') && item.endsWith('"')) {
          try {
            return JSON.parse(item);
          } catch {
            return item.slice(1, -1);
          }
        }
        if (item.length >= 2 && item.startsWith("'") && item.endsWith("'")) {
          return item.slice(1, -1);
        }

        return item;
      });
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function parseFrontmatterDocument(content = "") {
  const safeContent = normalizeLineEndings(content);
  const lines = safeContent.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: safeContent.trim() };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    return { frontmatter: {}, body: safeContent.trim() };
  }

  const frontmatter = Object.create(null);
  let currentArrayKey = null;

  for (const rawLine of lines.slice(1, closingIndex)) {
    const line = rawLine.trimEnd();
    const arrayItem = line.match(/^\s*-\s*(.+)$/u);
    if (currentArrayKey && arrayItem) {
      frontmatter[currentArrayKey].push(normalizeFrontmatterValue(arrayItem[1]));
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (!match) {
      currentArrayKey = null;
      continue;
    }

    const [, key, rawValue] = match;
    if (rawValue.trim() === "") {
      frontmatter[key] = [];
      currentArrayKey = key;
      continue;
    }

    currentArrayKey = null;
    frontmatter[key] = normalizeFrontmatterValue(rawValue);
  }

  return {
    frontmatter,
    body: lines.slice(closingIndex + 1).join("\n").trim(),
  };
}

// Canonical frontmatter value serializer. Arrays render as inline flow syntax
// (`[a, "b c"]`) so `parseFrontmatterDocument` round-trips them and `vault lint`'s
// inline-array rule accepts them; scalars render verbatim. Exported so the enrich
// writer (vault-enrich.mjs) serializes tags/aliases through this ONE SSoT instead of
// re-implementing array formatting (원칙 3 Consistency).
export function formatFrontmatterValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatInlineArrayItem(item)).join(", ")}]`;
  }

  return String(value ?? "");
}

function formatInlineArrayItem(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return '""';
  }

  if (/^[A-Za-z0-9._/-]+$/u.test(text)) {
    return text;
  }

  return JSON.stringify(text);
}

export function stringifyFrontmatter(frontmatter) {
  const entries = Object.entries(frontmatter)
    .filter(([, value]) => value != null);
  const lines = entries.map(([key, value]) => `${key}: ${formatFrontmatterValue(value)}`);
  return `---\n${lines.join("\n")}\n---`;
}

// Drops blank lines at both edges of a line list but never touches the lines that remain —
// unlike `String#trim()`, which also strips the indentation of the first and last line and
// so turns an indented code block on a section's first line into plain prose.
function stripBlankEdgeLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

function splitSections(body, { preserveIndent = false } = {}) {
  const finish = (lines) => (preserveIndent ? stripBlankEdgeLines(lines).join("\n") : lines.join("\n").trim());
  const normalized = normalizeLineEndings(body);
  const lines = preserveIndent ? stripBlankEdgeLines(normalized.split("\n")) : normalized.trim().split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    return [];
  }

  const sections = [];
  let current = { heading: null, lines: [] };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/u);
    if (headingMatch) {
      if (current.heading || current.lines.length > 0) {
        sections.push({
          heading: current.heading,
          content: finish(current.lines),
        });
      }
      current = { heading: headingMatch[1].trim(), lines: [] };
      continue;
    }

    current.lines.push(line);
  }

  sections.push({
    heading: current.heading,
    content: finish(current.lines),
  });

  return sections;
}

// Fenced code blocks (``` or ~~~, CommonMark rules: up to three spaces of indent, a closing
// fence of the same character at least as long as the opener). `splitSections` treats every
// `## ` line as a heading regardless of fences, so a `## Summary` pasted inside a fence would
// be handled as the managed section — the closing fence and whatever follows it were then
// rewritten away with exit 0 (2026-09-12). This scan does not make the splitter fence-aware;
// it only reports what would make a keyed rewrite lossy so the writer can refuse.
function findFenceHazards(lines) {
  const hazards = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/u);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
        continue;
      }
      if (/^##\s+\S/u.test(line)) {
        hazards.push(`"${line.trim()}" at body line ${index + 1} sits inside the code fence opened at body line ${fence.line} — the splitter would read it as a section heading`);
      }
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length, line: index + 1 };
    }
  }
  if (fence) {
    hazards.push(`code fence opened at body line ${fence.line} is never closed — every later line, including managed sections, is fenced text`);
  }
  return hazards;
}

function sectionsToMap(body) {
  const sections = new Map();
  for (const section of splitSections(body)) {
    if (section.heading) {
      sections.set(section.heading, section.content);
    }
  }
  return sections;
}

// The three H2 sections ingest owns on a knowledge page. Everything else in an existing
// body (H1, tables, prose before the first H2, any other `##` heading) is the page owner's
// content: ingest carries it forward verbatim or refuses — it never rebuilds the page from
// these three alone (2026-09-12: `--page` re-ingest of a nonstandard ledger — frontmatter +
// H1 + table + `## 출처` — exited 0, passed fast-lint, and had silently dropped every row).
const INGEST_MANAGED_HEADINGS = ["Summary", "Details", "Related"];

function renderManagedSection(heading, sectionMap) {
  return `## ${heading}\n${String(sectionMap.get(heading) ?? "").trim() || "(비어 있음)"}`;
}

// Read-only. Describes an existing page body in the terms the writer needs: what precedes
// the first H2 (`preamble`), every `##` segment in document order, which of those ingest
// manages, which it must preserve, and why the body cannot be rewritten losslessly
// (`unsupported`, empty when it can). Pure over the body text — no filesystem access.
export function inspectExistingPageBodyShape(body = "") {
  const segments = splitSections(body, { preserveIndent: true });
  const preamble = segments.find((segment) => segment.heading === null)?.content ?? "";
  const headed = segments.filter((segment) => segment.heading !== null);
  const preservedHeadings = [];
  const managedHeadings = [];
  const seen = new Map();
  const unsupported = findFenceHazards(normalizeLineEndings(body).split("\n"));
  for (const segment of headed) {
    seen.set(segment.heading, (seen.get(segment.heading) ?? 0) + 1);
    if (INGEST_MANAGED_HEADINGS.includes(segment.heading)) {
      managedHeadings.push(segment.heading);
    } else {
      preservedHeadings.push(segment.heading);
    }
  }
  for (const [heading, count] of seen) {
    if (count > 1) {
      unsupported.push(`duplicate H2 heading "## ${heading}" (${count}x) — a keyed rewrite cannot tell which one owns the content`);
    }
  }
  return {
    preamble,
    segments: headed.map(({ heading, content }) => ({ heading, content })),
    managedHeadings,
    preservedHeadings,
    unsupported,
  };
}

// Reassembles a page body from its inspected shape plus the next values of the managed
// sections: preamble first, then every original H2 in its original order (managed ones
// replaced, all others verbatim), then any managed section the page lacked, appended in
// canonical order. A page with no prior body degenerates to the canonical three.
function renderPageBody(shape, sectionMap) {
  const blocks = [];
  // Preserved text is re-emitted line for line (blank edges dropped, indentation kept):
  // trimming here would strip the indent of an indented code block on a segment's first line.
  const preserved = (text) => stripBlankEdgeLines(String(text ?? "").split("\n")).join("\n");
  if (String(shape?.preamble ?? "").trim()) {
    blocks.push(preserved(shape.preamble));
  }
  const emitted = new Set();
  for (const segment of shape?.segments ?? []) {
    if (INGEST_MANAGED_HEADINGS.includes(segment.heading)) {
      blocks.push(renderManagedSection(segment.heading, sectionMap));
      emitted.add(segment.heading);
    } else {
      const content = preserved(segment.content);
      blocks.push(content ? `## ${segment.heading}\n${content}` : `## ${segment.heading}`);
    }
  }
  for (const heading of INGEST_MANAGED_HEADINGS) {
    if (!emitted.has(heading)) {
      blocks.push(renderManagedSection(heading, sectionMap));
    }
  }
  return blocks.join("\n\n");
}

function sanitizeSlug(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.result$/u, "")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "") || "untitled";
}

function stripMarkdownStem(value) {
  return String(value ?? "")
    .replace(RESULT_FILE_PATTERN, "")
    .replace(/\.md$/u, "");
}

function isResultSourcePath(value) {
  const normalized = String(value ?? "").trim().replace(/\\/gu, "/");
  return RESULT_FILE_PATTERN.test(normalized);
}

function humanizeSlug(value) {
  const normalized = String(value ?? "").replace(/[-_]+/gu, " ").trim();
  if (!normalized) {
    return "Untitled";
  }
  return normalized;
}

function stripLeadingTitleHeading(body) {
  const normalized = normalizeLineEndings(body).trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");
  if (lines[0]?.match(/^#\s+/u)) {
    return lines.slice(1).join("\n").trim();
  }

  return normalized;
}

function demoteMarkdownHeadings(body, increment = 2) {
  return normalizeLineEndings(body)
    .split("\n")
    .map((line) => {
      const match = line.match(/^(#{1,6})(\s+.+)$/u);
      if (!match) {
        return line;
      }

      const level = Math.min(match[1].length + increment, 6);
      return `${"#".repeat(level)}${match[2]}`;
    })
    .join("\n")
    .trim();
}

export function extractTitle(body, fallback) {
  const lines = normalizeLineEndings(body).split("\n");
  const headingLine = lines.find((line) => /^#\s+.+$/u.test(line.trim()));
  if (headingLine) {
    return headingLine.replace(/^#\s+/u, "").trim();
  }

  return fallback;
}

export function extractSummary(body, fallback) {
  const sections = sectionsToMap(body);
  const explicitSummary = sections.get("Summary");
  if (explicitSummary) {
    const lines = explicitSummary
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("- "));
    if (lines.length > 0) {
      return lines.slice(0, 3).join(" ");
    }
  }

  const content = stripLeadingTitleHeading(body);
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^##\s+/u.test(line))
    .filter((line) => !/^###\s+/u.test(line))
    .filter((line) => !/^[-*]\s+/u.test(line));

  if (lines.length > 0) {
    return lines.slice(0, 3).join(" ");
  }

  return fallback;
}

function parseTaskLikeMetadata(content = "") {
  const lines = normalizeLineEndings(content).split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === "---");
  if (startIndex === -1) {
    return {};
  }

  const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === "---");
  if (endIndex === -1) {
    return {};
  }

  const metadata = Object.create(null);
  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/u);
    if (!match) {
      continue;
    }
    metadata[match[1]] = normalizeFrontmatterValue(match[2]);
  }

  return metadata;
}

async function findMatchingTaskMetadata(resultPath, taskDir) {
  if (!taskDir || !existsSync(taskDir)) {
    return null;
  }

  const entries = await readdir(taskDir, { withFileTypes: true });
  const normalizedResultPath = resolve(resultPath);

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".task.md")) {
      continue;
    }

    const fullPath = join(taskDir, entry.name);
    const content = await readFile(fullPath, "utf8");
    const metadata = parseTaskLikeMetadata(content);
    const referencedResult = typeof metadata.result === "string" ? resolve(metadata.result) : null;

    if (referencedResult === normalizedResultPath) {
      return metadata;
    }
  }

  return null;
}

function inferProjectFromSourceName(sourceSlug, knownProjectIds = []) {
  return inferProjectIdFromSlugPrefix(sourceSlug, knownProjectIds);
}

function isLikelyUrl(value) {
  return /^https?:\/\//iu.test(String(value ?? "").trim());
}

function normalizeRoutingText(value) {
  return String(value ?? "").toLowerCase();
}

function countKeywordHits(haystack, keywords) {
  let score = 0;
  for (const keyword of keywords) {
    if (haystack.includes(normalizeRoutingText(keyword))) {
      score += 1;
    }
  }
  return score;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function detectProjectIdFromContent(documentMeta, knownProjectIds = []) {
  const haystack = normalizeRoutingText([
    documentMeta?.title,
    documentMeta?.summary,
    documentMeta?.body,
    documentMeta?.sourcePath,
    documentMeta?.sourceName,
    documentMeta?.taskId,
  ].filter(Boolean).join("\n"));

  return detectProjectIdFromContentText(haystack, knownProjectIds);
}

export function analyzeDocumentRouting({ documentMeta, explicitSection = null, page = null, sourceType = "text", knownProjectIds = [] }) {
  if (page || explicitSection) {
    return {
      section: explicitSection,
      project: documentMeta?.project ?? null,
      confidence: "explicit",
      ambiguous: false,
      reason: page ? "explicit-page" : "explicit-section",
      scores: {
        projects: 0,
        learnings: 0,
        domains: 0,
      },
      candidates: [],
    };
  }

  const inferredProject =
    documentMeta?.project ??
    detectProjectIdFromContent(documentMeta, knownProjectIds) ??
    inferProjectFromSourceName(documentMeta?.sourceSlug ?? "", knownProjectIds);
  const haystack = normalizeRoutingText([
    documentMeta?.title,
    documentMeta?.summary,
    documentMeta?.body,
    documentMeta?.sourcePath,
    documentMeta?.sourceName,
    documentMeta?.taskId,
  ].filter(Boolean).join("\n"));

  const projectScore = (inferredProject ? 2 : 0) + countKeywordHits(haystack, PROJECT_ROUTING_KEYWORDS);
  const learningScore = countKeywordHits(haystack, LEARNING_ROUTING_KEYWORDS);
  const domainScore = (sourceType === "url" ? 1 : 0) + countKeywordHits(haystack, DOMAIN_ROUTING_KEYWORDS);
  const candidates = [
    { section: "projects", score: projectScore, project: inferredProject },
    { section: "learnings", score: learningScore, project: inferredProject },
    { section: "domains", score: domainScore, project: inferredProject },
  ].sort((left, right) => right.score - left.score || left.section.localeCompare(right.section));
  const prioritizeCandidates = (chosenSection) => [
    ...candidates.filter((candidate) => candidate.section === chosenSection),
    ...candidates.filter((candidate) => candidate.section !== chosenSection),
  ];
  const top = candidates[0] ?? { section: "learnings", score: 0 };
  const second = candidates[1] ?? { section: null, score: 0 };
  const ambiguous =
    top.score <= 1 ||
    (second.score > 0 && Math.abs(top.score - second.score) <= 1);
  const confidence =
    top.score >= 4 && top.score - second.score >= 2
      ? "high"
      : top.score >= 2 && top.score - second.score >= 1
        ? "medium"
        : "low";

  if (inferredProject && projectScore >= 3 && projectScore + 1 >= learningScore) {
    return {
      section: "projects",
      project: inferredProject,
      confidence,
      ambiguous,
      reason: inferredProject ? "project-id-and-project-keywords" : "project-keywords",
      scores: {
        projects: projectScore,
        learnings: learningScore,
        domains: domainScore,
      },
      candidates: prioritizeCandidates("projects"),
    };
  }

  if (learningScore > 0 && learningScore >= domainScore) {
    return {
      section: "learnings",
      project: inferredProject,
      confidence,
      ambiguous,
      reason: "learning-keywords",
      scores: {
        projects: projectScore,
        learnings: learningScore,
        domains: domainScore,
      },
      candidates: prioritizeCandidates("learnings"),
    };
  }

  if (domainScore > 0 || sourceType === "url") {
    return {
      section: "domains",
      project: inferredProject,
      confidence,
      ambiguous,
      reason: sourceType === "url" && domainScore <= 1 ? "url-default" : "domain-keywords",
      scores: {
        projects: projectScore,
        learnings: learningScore,
        domains: domainScore,
      },
      candidates: prioritizeCandidates("domains"),
    };
  }

  return {
    section: inferredProject ? "projects" : "learnings",
    project: inferredProject,
    confidence,
    ambiguous: true,
    reason: inferredProject ? "project-fallback" : "default-learning-fallback",
    scores: {
      projects: projectScore,
      learnings: learningScore,
      domains: domainScore,
    },
    candidates: prioritizeCandidates(inferredProject ? "projects" : "learnings"),
  };
}

function normalizeGenericSourceName(sourceRef, fallbackSlug) {
  const trimmed = String(sourceRef ?? "").trim();
  if (!trimmed) {
    return `${fallbackSlug}.md`;
  }

  if (isLikelyUrl(trimmed)) {
    try {
      const url = new URL(trimmed);
      const pathname = url.pathname.replace(/\/+$/u, "");
      const leaf = pathname.split("/").filter(Boolean).pop();
      return leaf || url.hostname || `${fallbackSlug}.md`;
    } catch {
      return trimmed;
    }
  }

  return basename(trimmed) || `${fallbackSlug}.md`;
}

function buildGenericDocumentMeta({
  content,
  sourceRef,
  title = null,
  taskId = null,
  project = null,
  status = "",
  worker = "",
  qa = "",
  knownProjectIds = [],
  updatedDate = new Date().toISOString().slice(0, 10),
} = {}) {
  const parsed = parseFrontmatterDocument(String(content ?? ""));
  const body = parsed.body?.trim() ? parsed.body : String(content ?? "").trim();
  const normalizedSourceName = normalizeGenericSourceName(sourceRef, "note");
  const rawSourceSlug = sanitizeSlug(
    taskId ??
    title ??
    basename(normalizedSourceName, extname(normalizedSourceName)) ??
    sourceRef ??
    "note",
  );
  const fallbackTitle = humanizeSlug(taskId ?? rawSourceSlug);

  return {
    sourcePath: String(sourceRef ?? "").trim() || rawSourceSlug,
    sourceName: normalizeGenericSourceName(sourceRef, rawSourceSlug),
    sourceSlug: rawSourceSlug,
    taskId:
      String(
        taskId ??
        parsed.frontmatter.id ??
        parsed.frontmatter.task ??
        rawSourceSlug,
      ).trim(),
    project:
      typeof project === "string" && project.trim()
        ? project.trim()
        : typeof parsed.frontmatter.project === "string" && parsed.frontmatter.project.trim()
          ? parsed.frontmatter.project.trim()
          : inferProjectFromSourceName(rawSourceSlug, knownProjectIds),
    status:
      typeof status === "string" && status.trim()
        ? status.trim()
        : typeof parsed.frontmatter.status === "string"
          ? parsed.frontmatter.status.trim()
          : "",
    worker:
      typeof worker === "string" && worker.trim()
        ? worker.trim()
        : typeof parsed.frontmatter.worker === "string"
          ? parsed.frontmatter.worker.trim()
          : "",
    qa:
      typeof qa === "string" && qa.trim()
        ? qa.trim()
        : typeof parsed.frontmatter.qa === "string"
          ? parsed.frontmatter.qa.trim()
          : "",
    title: title ?? extractTitle(body, fallbackTitle),
    summary: extractSummary(body, fallbackTitle),
    body,
    updatedDate,
  };
}

function inferTargetDescriptor(resultMeta, options = {}) {
  const pageOverride = typeof options.page === "string" && options.page.trim()
    ? options.page.trim().replace(/^\/+/u, "")
    : null;
  if (pageOverride) {
    const section = pageOverride.includes("/") ? pageOverride.split("/")[0] : "learnings";
    const fileName = pageOverride.includes("/") ? pageOverride.split("/").slice(1).join("/") : pageOverride;
    const slug = basename(fileName, extname(fileName));
    return {
      section,
      slug,
      relativePath: pageOverride.endsWith(".md") ? pageOverride : `${pageOverride}.md`,
    };
  }

  const explicitSection = typeof options.section === "string" && options.section.trim()
    ? options.section.trim()
    : null;
  const explicitSlug = typeof options.slug === "string" && options.slug.trim()
    ? sanitizeSlug(options.slug)
    : null;

  const project = resultMeta.project ?? inferProjectFromSourceName(resultMeta.sourceSlug, options.knownProjectIds ?? []);
  if (explicitSection === "projects" && project) {
    const slug = explicitSlug ?? sanitizeSlug(project);
    return {
      section: "projects",
      slug,
      relativePath: join("projects", `${slug}.md`),
    };
  }

  if (project && !explicitSection) {
    const slug = explicitSlug ?? sanitizeSlug(project);
    return {
      section: "projects",
      slug,
      relativePath: join("projects", `${slug}.md`),
    };
  }

  const section = explicitSection ?? "learnings";
  const slug = explicitSlug ?? sanitizeSlug(resultMeta.taskId ?? resultMeta.sourceSlug);
  return {
    section,
    slug,
    relativePath: join(section, `${slug}.md`),
  };
}

function mergeTags(existingTags, nextTags) {
  return Array.from(
    new Set(
      [...(Array.isArray(existingTags) ? existingTags : []), ...(Array.isArray(nextTags) ? nextTags : [])]
        .map((tag) => String(tag ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function inferTags(resultMeta, target) {
  const tags = new Set();
  tags.add(target.section);

  if (resultMeta.project) {
    tags.add(resultMeta.project);
  }

  for (const part of String(resultMeta.taskId ?? resultMeta.sourceSlug).split(/[-_]/u)) {
    const normalized = part.trim().toLowerCase();
    if (normalized.length >= 3) {
      tags.add(normalized);
    }
  }

  return Array.from(tags);
}

function buildIngestBlock(resultMeta, qaStatus) {
  const dateLabel = resultMeta.updatedDate;
  const lines = [
    `### ${dateLabel} · ${resultMeta.title}`,
    "",
    `- Source: \`${resultMeta.sourcePath}\``,
    `- Task: \`${resultMeta.taskId}\``,
  ];

  if (resultMeta.status) {
    lines.push(`- Status: \`${resultMeta.status}\``);
  }
  if (resultMeta.worker) {
    lines.push(`- Worker: \`${resultMeta.worker}\``);
  }
  if (resultMeta.qa) {
    lines.push(`- QA: \`${resultMeta.qa}\``);
  }
  lines.push(`- QA Verdict: \`${qaStatus}\``);
  lines.push("");

  const body = stripLeadingTitleHeading(resultMeta.body);
  if (body) {
    lines.push(demoteMarkdownHeadings(body));
  } else {
    lines.push(resultMeta.summary);
  }

  return lines.join("\n").trim();
}

function upsertDetailsSection(detailsContent, blockId, blockContent) {
  const startMarker = `<!-- ingest:${blockId}:start -->`;
  const endMarker = `<!-- ingest:${blockId}:end -->`;
  const block = `${startMarker}\n${blockContent}\n${endMarker}`;
  const normalizedDetails = String(detailsContent ?? "").trim();
  const markerPattern = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`,
    "u",
  );

  if (markerPattern.test(normalizedDetails)) {
    return {
      content: normalizedDetails.replace(markerPattern, block).trim(),
      action: "updated",
    };
  }

  if (!normalizedDetails || /^\(.+\)$/u.test(normalizedDetails)) {
    return { content: block, action: "created" };
  }

  return {
    content: `${normalizedDetails}\n\n${block}`.trim(),
    action: "created",
  };
}


// Owner-local archive for file sources that live outside the vault. Returns null when the
// source is not a filesystem path, does not exist, or already lives inside the vault (a path
// inside the vault is a legitimate owner and is referenced as-is). The snapshot lands in the
// page's own `_sources/<slug>-<date>/source-snapshot.md` bucket, mirroring the hand-made
// convention already in the tree (e.g. `domains/agent-tooling/_sources/cli-jaw-2026-05-07/`).
async function archiveExternalFileSource({ vaultDir, pagePath, sourcePath, updatedDate, dryRun }) {
  const raw = String(sourcePath ?? "").trim();
  if (!raw || isLikelyUrl(raw) || raw.startsWith("text:")) {
    return null;
  }
  const resolvedSource = resolve(raw);
  if (!existsSync(resolvedSource)) {
    return null;
  }
  const resolvedVault = resolve(vaultDir);
  const rel = relative(resolvedVault, resolvedSource);
  if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
    return null; // already vault-owned
  }
  const pageDir = dirname(pagePath);
  const stem = sanitizeSlug(basename(resolvedSource, extname(resolvedSource))) || "source";
  const bucketDir = join(pageDir, "_sources", `${stem}-${updatedDate}`);
  const snapshotPath = join(bucketDir, "source-snapshot.md");
  if (!dryRun) {
    await mkdir(bucketDir, { recursive: true });
    await writeFile(snapshotPath, await readFile(resolvedSource, "utf8"), "utf8");
  }
  return {
    snapshotPath,
    relativeToPage: relative(pageDir, snapshotPath).replace(/\\/gu, "/"),
    relativeToVault: relative(resolvedVault, snapshotPath).replace(/\\/gu, "/"),
  };
}

function parsePageDocument(content = "") {
  const { frontmatter, body } = parseFrontmatterDocument(content);
  return {
    frontmatter,
    sections: sectionsToMap(body),
    body,
  };
}

function extractFrontmatterSources(frontmatter = {}) {
  if (Array.isArray(frontmatter.sources) && frontmatter.sources.length > 0) {
    return frontmatter.sources
      .map((source) => String(source ?? "").trim())
      .filter(Boolean);
  }

  if (typeof frontmatter.source === "string" && frontmatter.source.trim()) {
    return [frontmatter.source.trim()];
  }

  if (typeof frontmatter.sourcePath === "string" && frontmatter.sourcePath.trim()) {
    return [frontmatter.sourcePath.trim()];
  }

  return [];
}

function isExternalLinkTarget(target) {
  return (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("obsidian://")
  );
}

function parseMarkdownLinkTarget(rawTarget) {
  const trimmed = String(rawTarget ?? "").trim();
  if (!trimmed) {
    return { targetPath: "", anchor: "", suffix: "" };
  }

  const firstWhitespace = trimmed.search(/\s/u);
  const pathAndAnchor = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
  const suffix = firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace);
  const hashIndex = pathAndAnchor.indexOf("#");

  if (hashIndex === -1) {
    return { targetPath: pathAndAnchor, anchor: "", suffix };
  }

  return {
    targetPath: pathAndAnchor.slice(0, hashIndex),
    anchor: pathAndAnchor.slice(hashIndex),
    suffix,
  };
}

export function rewriteCrossReferenceBullet(bullet, entry, indexPath, vaultDir) {
  return bullet.replace(MARKDOWN_LINK_PATTERN, (match, label, rawTarget) => {
    const parsedTarget = parseMarkdownLinkTarget(rawTarget);
    const targetPath = parsedTarget.targetPath.trim();

    if (!targetPath) {
      return label;
    }

    if (isExternalLinkTarget(targetPath)) {
      return match;
    }

    if (targetPath.startsWith("#")) {
      return label;
    }

    const resolvedTarget = resolve(dirname(entry.filePath), targetPath);
    const normalizedVaultDir = normalizePathSeparators(resolve(vaultDir));
    const normalizedResolvedTarget = normalizePathSeparators(resolvedTarget);

    if (
      !(
        normalizedResolvedTarget === normalizedVaultDir ||
        normalizedResolvedTarget.startsWith(`${normalizedVaultDir}/`)
      ) ||
      !existsSync(resolvedTarget)
    ) {
      return label;
    }

    const rebasedTarget = normalizePathSeparators(relative(dirname(indexPath), resolvedTarget));
    const finalTarget = `${rebasedTarget || basename(resolvedTarget)}${parsedTarget.anchor}${parsedTarget.suffix}`;
    return `[${label}](${finalTarget})`;
  });
}

function parseRelatedBullets(relatedContent = "") {
  return normalizeLineEndings(relatedContent)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

function createPageTitle(target, resultMeta, overrideTitle = null) {
  if (overrideTitle) {
    return overrideTitle;
  }

  if (target.section === "projects" && resultMeta.project) {
    return `${resultMeta.project} 프로젝트 지식`;
  }

  return resultMeta.title || humanizeSlug(target.slug);
}

function buildRelatedSection(existingRelated, target, resultMeta) {
  const bullets = new Set(parseRelatedBullets(existingRelated));

  if (target.section !== "projects" && resultMeta.project) {
    const projectSlug = sanitizeSlug(resultMeta.project);
    bullets.add(`- [${resultMeta.project}](../projects/${projectSlug}.md) — 관련 프로젝트 지식`);
  }

  const values = Array.from(bullets);
  return values.length > 0 ? values.join("\n") : "(교차참조 추가 예정)";
}

function normalizeProjectPageSources(existingSources) {
  return (Array.isArray(existingSources) ? existingSources : [])
    .map((source) => String(source ?? "").trim())
    .filter(Boolean)
    .filter((source) => !isResultSourcePath(source));
}

function stripLegacyProjectDetails(detailsContent = "") {
  const stripped = normalizeLineEndings(String(detailsContent ?? ""))
    .replace(LEGACY_PROJECT_INGEST_BLOCK_PATTERN, "")
    .replace(new RegExp(
      `${escapeRegExp(PROJECT_STATE_START_MARKER)}[\\s\\S]*?${escapeRegExp(PROJECT_STATE_END_MARKER)}`,
      "u",
    ), "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  if (!stripped || /^\(.+\)$/u.test(stripped)) {
    return "";
  }

  return stripped;
}

function renderProjectStateBlock({ pagePath, sourcePath, resultMeta }) {
  const evidence = renderProjectEvidenceReference(pagePath, sourcePath);
  const summary = collapseToSingleLine(resultMeta.summary);
  const title = collapseToSingleLine(resultMeta.title);
  const lines = [
    PROJECT_STATE_START_MARKER,
    "### Current State",
    `- Updated: ${resultMeta.updatedDate}`,
  ];

  if (summary) {
    lines.push(`- Summary: ${summary}`);
  }
  if (title && title !== summary) {
    lines.push(`- Latest topic: ${title}`);
  }
  if (resultMeta.status) {
    lines.push(`- Status: \`${resultMeta.status}\``);
  }
  if (evidence) {
    lines.push(`- Evidence: ${evidence}`);
  }

  lines.push(PROJECT_STATE_END_MARKER);
  return lines.join("\n");
}

function renderProjectEvidenceReference(pagePath, sourcePath) {
  const normalizedSourcePath = String(sourcePath ?? "").trim();
  if (!normalizedSourcePath || normalizedSourcePath.startsWith("text:")) {
    return "";
  }

  if (isLikelyUrl(normalizedSourcePath)) {
    return `[source](${normalizedSourcePath})`;
  }

  if (!normalizedSourcePath.startsWith("/")) {
    return `\`${normalizedSourcePath}\``;
  }

  const relativePath = relative(dirname(pagePath), normalizedSourcePath).replace(/\\/gu, "/");
  if (!relativePath) {
    return `[${basename(normalizedSourcePath)}](./${basename(normalizedSourcePath)})`;
  }

  return `[${basename(normalizedSourcePath)}](${relativePath})`;
}

function upsertProjectDetailsSection(detailsContent, { pagePath, sourcePath, resultMeta }) {
  const manualDetails = stripLegacyProjectDetails(detailsContent);
  const projectStateBlock = renderProjectStateBlock({ pagePath, sourcePath, resultMeta });
  const content = manualDetails
    ? `${manualDetails}\n\n${projectStateBlock}`.trim()
    : projectStateBlock;

  return {
    content,
    action: manualDetails ? "updated" : "created",
  };
}

async function ingestDocumentMeta({
  documentMeta,
  vaultDir,
  section = null,
  slug = null,
  page = null,
  title = null,
  dryRun = false,
  qaStatus = "passed",
  sourceLogLabel = null,
  knownProjectIds = [],
} = {}) {
  const activeVaultDir = vaultDir ?? resolveVaultDir();
  const routing = analyzeDocumentRouting({
    documentMeta,
    explicitSection: section,
    page,
    sourceType: isLikelyUrl(documentMeta?.sourcePath) ? "url" : "text",
    knownProjectIds,
  });
  const effectiveMeta = {
    ...documentMeta,
    project: routing.project ?? documentMeta?.project ?? null,
  };
  const target = inferTargetDescriptor(effectiveMeta, { section: routing.section, slug, page, knownProjectIds });
  const pagePath = join(activeVaultDir, target.relativePath);
  const candidateTargets = Array.isArray(routing.candidates)
    ? routing.candidates
      .map((candidate) => {
        if (!candidate?.section) {
          return null;
        }
        const candidateMeta = {
          ...effectiveMeta,
          project: candidate.project ?? effectiveMeta.project ?? null,
        };
        const candidateTarget = inferTargetDescriptor(candidateMeta, {
          section: candidate.section,
          slug,
          page,
          knownProjectIds,
        });
        return {
          section: candidate.section,
          score: candidate.score,
          project: candidate.project ?? candidateMeta.project ?? null,
          relativePath: candidateTarget.relativePath.replace(/\\/gu, "/"),
        };
      })
      .filter(Boolean)
    : [];

  const pageExists = existsSync(pagePath);
  const existingContent = pageExists ? await readFile(pagePath, "utf8") : "";
  const existingPage = parsePageDocument(existingContent);
  // Data-loss boundary: decide whether the existing body can be rewritten losslessly BEFORE
  // anything is written (the `_sources/` snapshot below is already a mutation). A body this
  // writer cannot carry forward verbatim is refused loudly, never rebuilt from the managed
  // sections alone (No Silent Fallback).
  const existingShape = inspectExistingPageBodyShape(existingPage.body);
  if (existingShape.unsupported.length > 0) {
    throw new Error(
      `vault-ingest refused to rewrite ${target.relativePath.replace(/\\/gu, "/")}: existing body cannot be preserved losslessly — ` +
      `${existingShape.unsupported.join("; ")}. Nothing was written; curate the page by hand or pick another --page.`,
    );
  }

  await ensureVaultScaffold(activeVaultDir);
  await mkdir(join(activeVaultDir, target.section), { recursive: true });

  // `domain:` is a DEPRECATED frontmatter field (2026-07-05 폐기 결정): membership is declared
  // by the vault path (topology), cross-cutting classification by `tags`. Ingest must NOT stamp
  // it — otherwise every re-ingest would re-insert the field the vault-lint now rejects and the
  // migration is undone one write at a time. A pre-existing `domain:` on an ingested page is
  // dropped here on rewrite (self-healing strip), never carried forward.
  // A file source that lives OUTSIDE the vault (scratchpad, Downloads, /tmp …) is not a durable
  // owner (vault topology rule: owner-local `_sources/` holds originals). Archive a snapshot next
  // to the page and reference the vault-relative path — never the host absolute path, which
  // stops resolving the moment the session directory is reaped (2026-08-18: an ingest wrote a
  // /private/tmp/... scratchpad path into `sources:` and the Details block).
  const archivedSource = await archiveExternalFileSource({
    vaultDir: activeVaultDir,
    pagePath,
    sourcePath: effectiveMeta.sourcePath,
    updatedDate: effectiveMeta.updatedDate,
    dryRun,
  });
  if (archivedSource) {
    effectiveMeta.sourcePath = archivedSource.relativeToPage;
  }
  // Rebuild only the keys ingest owns; every other existing frontmatter key (description,
  // aliases, source_grade, status, …) is carried forward verbatim. Dropping them was a real
  // regression (2026-08-18: `--page` re-ingest wiped `description`/`aliases`/`source_grade`).
  const { domain: _deprecatedDomain, ...carriedFrontmatter } = existingPage.frontmatter;
  const frontmatter = {
    ...carriedFrontmatter,
    title: String(existingPage.frontmatter.title ?? createPageTitle(target, effectiveMeta, title)),
    tags: mergeTags(existingPage.frontmatter.tags, inferTags(effectiveMeta, target)),
    created: String(existingPage.frontmatter.created ?? effectiveMeta.updatedDate),
    updated: effectiveMeta.updatedDate,
    sources:
      target.section === "projects"
        ? normalizeProjectPageSources(existingPage.frontmatter.sources)
        : mergeTags(existingPage.frontmatter.sources, [effectiveMeta.sourcePath]),
  };

  const detailsBlockId = sanitizeSlug(effectiveMeta.sourceName || effectiveMeta.sourceSlug || effectiveMeta.taskId);
  const nextSummary =
    String(existingPage.sections.get("Summary") ?? "").trim() &&
    !String(existingPage.sections.get("Summary") ?? "").trim().startsWith("(")
      ? String(existingPage.sections.get("Summary") ?? "").trim()
      : effectiveMeta.summary;

  const detailsUpdate =
    target.section === "projects"
      ? upsertProjectDetailsSection(
        existingPage.sections.get("Details") ?? "",
        {
          pagePath,
          sourcePath: effectiveMeta.sourcePath,
          resultMeta: effectiveMeta,
        },
      )
      : upsertDetailsSection(
        existingPage.sections.get("Details") ?? "",
        detailsBlockId,
        buildIngestBlock(effectiveMeta, qaStatus),
      );

  const nextSections = new Map();
  nextSections.set("Summary", nextSummary);
  nextSections.set("Details", detailsUpdate.content);
  nextSections.set(
    "Related",
    buildRelatedSection(existingPage.sections.get("Related") ?? "", target, effectiveMeta),
  );

  const pageContent = `${stringifyFrontmatter(frontmatter)}\n\n${renderPageBody(existingShape, nextSections)}\n`;
  const relativePagePath = target.relativePath.replace(/\\/gu, "/");
  const operation = pageExists
    ? (target.section === "projects" ? "UPDATE" : (detailsUpdate.action === "updated" ? "UPDATE" : "INGEST"))
    : "CREATE";
  const logLabel = sourceLogLabel ?? documentMeta.sourceName ?? documentMeta.sourcePath;

  if (!dryRun) {
    await writeFile(pagePath, pageContent, "utf8");
    // Ingest boundary (plan step [10]): regenerate the vault-index topology through
    // the SAME engine `kuma vault sync` uses — not the legacy single-pass
    // rewriteIndex — so ingest leaves the index at the engine's fixed point and a
    // later sync is a genuine no-op (원칙 1 SSoT, 원칙 5 idempotency). Non-convergence
    // throws (No Silent Fallback).
    await syncVaultIndex({ vaultDir: activeVaultDir });
    await appendLogEntry(
      activeVaultDir,
      `${operation}: \`${logLabel}\` → \`${relativePagePath}\` (qa: ${qaStatus})`,
    );
  }

  return {
    action: operation,
    pagePath,
    relativePagePath,
    vaultDir: activeVaultDir,
    taskId: effectiveMeta.taskId,
    project: effectiveMeta.project,
    sourcePath: effectiveMeta.sourcePath,
    dryRun,
    routing: {
      ...routing,
      resolvedSection: target.section,
      resolvedProject: effectiveMeta.project ?? null,
      suggestedPath: relativePagePath,
      candidates: candidateTargets,
    },
  };
}

async function ensureVaultScaffold(vaultDir) {
  await mkdir(vaultDir, { recursive: true });

  for (const section of VAULT_SECTION_DIRS) {
    await mkdir(join(vaultDir, section), { recursive: true });
  }

  const schemaPath = join(vaultDir, "schema.md");
  if (!existsSync(schemaPath)) {
    await writeFile(schemaPath, `${DEFAULT_SCHEMA_CONTENT.trim()}\n`, "utf8");
  }

  const logPath = join(vaultDir, "log.md");
  if (!existsSync(logPath)) {
    await writeFile(logPath, "# Kuma Vault Change Log\n", "utf8");
  }
}

function normalizeVaultRelativePath(value) {
  return String(value ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "");
}

export function isArchiveTreeRelativePath(relativePath, profile = VAULT_PROFILE) {
  const firstSegment = normalizeVaultRelativePath(relativePath).split("/")[0];
  return profile.archiveTreeDirs.includes(firstSegment);
}

// The top-level `plans/` slot is a runtime SoC re-parent (`~/.kuma/vault/plans/<project>/`),
// not a knowledge-page tree. Its contract (frontmatter, checklist, section shape) is owned
// canonically by `kuma plan lint` — the plan SSoT. Neither the vault-index generator nor
// vault-lint may treat plan documents as knowledge pages (SSoT #1). The generator therefore
// never mints a README index into the plans slot, and lint never double-judges it — both read
// the same predicate so their contracts cannot contradict (원칙 3 Consistency; DEC vault-compiler
// step 1/13). This is an explicit ownership boundary, not a silent fallback (#6).
// The plans-slot root is profile-owned (VAULT_PROFILE.plansSlotRoot === "plans").
// A profile with `plansSlotRoot: null` (e.g. the generic docs profile, which has
// no plans store) makes this predicate always false — the tree has no plans slot to exempt.
export function isPlansSlotPath(relativePath, profile = VAULT_PROFILE) {
  if (!profile.plansSlotRoot) {
    return false;
  }
  const firstSegment = normalizeVaultRelativePath(relativePath).split("/")[0];
  return firstSegment === profile.plansSlotRoot;
}

// Owner-local bucket contract (schema.md Page Rules): originals, attachments, and
// intermediate artifacts live next to their canonical owner in an underscore-prefixed
// bucket — `_assets/`, `_sources/`, `_evidence/` (also `_media/`, `_diagrams/`,
// `_attachments/`, staging buckets, etc.). These buckets are evidence/asset holders,
// NOT navigable knowledge pages, so their `.md` files are neither part of the generated
// README navigation topology nor valid required nav targets. The underscore-prefix is the
// vault's established bucket signal (already honored by scanDomainTreeDrift and the
// project-shared-evidence-bucket check). Both the index generator and reachability lint
// exempt any path with an underscore-prefixed segment — the same "not part of nav topology"
// exemption already applied to archive dirs and the plans slot (DEC vault-compiler step 12/13).
export function isOwnerLocalBucketPath(relativePath, profile = VAULT_PROFILE) {
  const prefix = profile.ownerLocalBucketPrefix ?? "_";
  return normalizeVaultRelativePath(relativePath)
    .split("/")
    .some((segment) => segment.startsWith(prefix));
}

// Binary sidecar contract (schema.md Page Rules / DEC vault-compiler step 5): a binary
// document `<name>.<ext>` gets a derived Markdown sidecar `<name>.<ext>.md` carrying the
// extracted text + source/sha256/extractor stamp. The sidecar is a *pure function of the
// binary* (regenerated by `kuma vault sync` only when the source hash changes), so it is a
// generated derivative — never a hand-authored nav page. `SIDECAR_SOURCE_EXTENSIONS` is the
// canonical set of extensions with a registered extractor (SSoT); the extractor registry in
// vault-sidecar.mjs must cover exactly these (parity test). `isSidecarPath` is path-only and
// cheap so both the sidecar generator and the lint exemption share one predicate (원칙 3
// Consistency — same pattern as isPlansSlotPath / isOwnerLocalBucketPath).
export const SIDECAR_SOURCE_EXTENSIONS = new Set([".pdf"]);

export function isSidecarPath(relativePath, profile = VAULT_PROFILE) {
  const name = normalizeVaultRelativePath(relativePath).split("/").pop() ?? "";
  const lower = name.toLowerCase();
  if (!lower.endsWith(".md")) {
    return false;
  }
  const withoutMd = lower.slice(0, -".md".length);
  const sourceExt = extname(withoutMd);
  return sourceExt !== "" && profile.sidecarSourceExtensions.includes(sourceExt);
}

// Navigation-scope resolution (DEC vault-compiler step 8). A profile with
// `navScope: "git-tracked"` bounds the managed nav tree to the repo's git-tracked
// layer — the working tree may also carry untracked vendored artifacts (candidate
// portfolio code, large binaries) that are preserved evidence, not the handbook.
// Returns a Set of tree-relative directory paths that contain at least one tracked
// file (plus every ancestor, and "." for the root), or `null` for `navScope: "all"`
// (walk the whole tree). A non-repo root under a git-tracked profile is a hard
// error (No Silent Fallback — never silently fall back to walking everything).
export function resolveGitTrackedDirs(root) {
  let output;
  try {
    output = execFileSync("git", ["--no-optional-locks", "-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `git-tracked nav scope requires a git repository at ${root}: ${error.message}`,
    );
  }
  const dirs = new Set(["."]);
  for (const file of output.split("\0")) {
    if (!file) {
      continue;
    }
    const parts = normalizeVaultRelativePath(file).split("/");
    parts.pop();
    let acc = "";
    for (const segment of parts) {
      acc = acc ? `${acc}/${segment}` : segment;
      dirs.add(acc);
    }
  }
  return dirs;
}

// Resolve the tracked-directory bound for a profile's navScope: the Set of
// tree-relative dirs with tracked content under "git-tracked", or `null` under
// "all". The DERIVED passes (sidecar, enrich, FTS/search corpus) share this with
// the index generator and lint, so every pass is bounded by the same managed
// scope — an untracked vendored/secret subtree is never extracted, sent to a
// model, or indexed (원칙 3 Consistency).
export function resolveNavScopeTrackedDirs(vaultDir, profile = VAULT_PROFILE) {
  const resolved = resolveProfile(profile);
  return resolved.navScope === "git-tracked" ? resolveGitTrackedDirs(vaultDir) : null;
}

// Is a tree-relative directory inside the (optional) tracked scope? `null`
// tracked set = "all" scope, always true.
export function isDirInTrackedScope(relativePath, trackedDirs) {
  if (!trackedDirs) {
    return true;
  }
  const normalized = normalizeVaultRelativePath(relativePath);
  return trackedDirs.has(normalized === "" ? "." : normalized);
}

// A nav context bundles the resolved profile with the (optional) git-tracked
// directory set, threaded through the index walk so both the README-mint descent
// and the parent-index child listing honor the same scope (원칙 3 Consistency).
function buildNavContext(vaultDir, { profile = VAULT_PROFILE, trackedDirs } = {}) {
  const resolved = resolveProfile(profile);
  let dirs = trackedDirs ?? null;
  if (dirs === null && resolved.navScope === "git-tracked") {
    dirs = resolveGitTrackedDirs(vaultDir);
  }
  return { profile: resolved, trackedDirs: dirs };
}

// Is a tree-relative directory within the managed nav scope? Always true for
// "all" scope; for git-tracked scope, only directories with tracked content.
function isDirInNavScope(relativePath, ctx) {
  if (!ctx.trackedDirs) {
    return true;
  }
  const normalized = normalizeVaultRelativePath(relativePath);
  return ctx.trackedDirs.has(normalized === "" ? "." : normalized);
}

function titleFromReadmePath(relativePath) {
  const normalized = normalizeVaultRelativePath(relativePath);
  if (normalized === "README.md") {
    return "vault";
  }
  const parts = normalized.split("/");
  return parts[parts.length - 2] || stripMarkdownStem(basename(normalized));
}

// Index-line summary resolution (Compiler Vault: the index line is a pure
// function of the source page). Priority:
//   1. frontmatter `description` — the canonical, LLM-owned one-line synopsis
//      (the single leaf-frontmatter write target of `vault sync --enrich`).
//   2. explicit `## Summary` section — human-authored synopsis.
//   3. body-derived fallback — `extractReadmeIntroSummary`/`extractSummary`.
// A `description` present in → `description` derived out; when absent the prior
// summarize() chain is preserved unchanged. A non-string `description`
// (malformed, e.g. an array) is treated as absent and falls through the chain.
function resolveIndexSummary(parsed, { isReadme, fileStem }) {
  const description =
    typeof parsed.frontmatter?.description === "string"
      ? parsed.frontmatter.description.trim()
      : "";
  if (description) {
    return description;
  }

  const explicitSummary = String(parsed.sections.get("Summary") ?? "").trim();
  if (explicitSummary) {
    return explicitSummary;
  }

  return isReadme
    ? extractReadmeIntroSummary(parsed.body) || "Vault folder."
    : extractSummary(parsed.body, fileStem);
}

async function readVaultIndexChild(filePath, vaultDir, linkPath, section) {
  const fileExists = existsSync(filePath);
  const content = fileExists
    ? await readFile(filePath, "utf8")
    : defaultReadmeContent(vaultDir, filePath);
  const parsed = parsePageDocument(content);
  const relativePath = normalizeVaultRelativePath(relative(vaultDir, filePath));
  const fileStem = stripMarkdownStem(basename(filePath));
  const isReadme = basename(filePath) === "README.md";
  const title =
    String(parsed.frontmatter.title ?? "").trim() ||
    extractTitle(parsed.body, isReadme ? titleFromReadmePath(relativePath) : fileStem);
  const summary = resolveIndexSummary(parsed, { isReadme, fileStem });

  return {
    section,
    filePath,
    relativePath,
    linkPath: normalizeVaultRelativePath(linkPath),
    slug: isReadme ? titleFromReadmePath(relativePath) : fileStem,
    title,
    summary: summary && !summary.startsWith("(") ? summary.replace(/\n+/gu, " ").trim() : "",
    sources: extractFrontmatterSources(parsed.frontmatter),
    relatedBullets: parseRelatedBullets(String(parsed.sections.get("Related") ?? "").trim()),
    project: section === RESULT_ARCHIVE_DIR ? inferProjectFromSourceName(fileStem) : null,
    isDirectoryEntry: isReadme,
  };
}

function extractReadmeIntroSummary(body) {
  const lines = normalizeLineEndings(body).split("\n");
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

async function collectReadmeIndexChildren(vaultDir, readmePath, ctx = buildNavContext(vaultDir)) {
  const { profile } = ctx;
  const folderPath = dirname(readmePath);
  const folderRelativePath = normalizeVaultRelativePath(relative(vaultDir, folderPath));
  if (folderRelativePath && isArchiveTreeRelativePath(folderRelativePath, profile)) {
    return [];
  }

  const entries = existsSync(folderPath)
    ? await readdir(folderPath, { withFileTypes: true })
    : [];
  const children = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const childPath = join(folderPath, entry.name);
    if (entry.isDirectory()) {
      const childReadmePath = join(childPath, "README.md");
      const childRelativePath = normalizeVaultRelativePath(relative(vaultDir, childPath));
      // A parent index must not link a subdir the generator never mints a README
      // into. Plans slot and owner-local buckets are non-nav, so they are absent
      // from both collectReadmePaths and this listing (원칙 3 Consistency). Under a
      // git-tracked nav scope, an untracked subdir (vendored evidence) is likewise
      // outside the managed tree and must not be linked.
      if (
        isPlansSlotPath(childRelativePath, profile) ||
        isOwnerLocalBucketPath(childRelativePath, profile) ||
        !isDirInNavScope(childRelativePath, ctx)
      ) {
        continue;
      }
      const linkPath = normalizeVaultRelativePath(relative(folderPath, childReadmePath));
      children.push(await readVaultIndexChild(
        childReadmePath,
        vaultDir,
        linkPath,
        childRelativePath.split("/")[0] ?? "",
      ));
      continue;
    }

    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") {
      continue;
    }
    if (entry.name === "README.md" || entry.name === "index.md") {
      continue;
    }
    // Root-level append-only ledgers / agent-instruction files are runtime
    // evidence or config, not navigation. They stay reachable via curated root
    // prose (profile.rootNonNavFiles).
    if (!folderRelativePath && profile.rootNonNavFiles.includes(entry.name)) {
      continue;
    }

    const childRelativePath = normalizeVaultRelativePath(relative(vaultDir, childPath));
    if (folderRelativePath && isArchiveTreeRelativePath(childRelativePath, profile)) {
      continue;
    }

    children.push(await readVaultIndexChild(
      childPath,
      vaultDir,
      normalizeVaultRelativePath(relative(folderPath, childPath)),
      childRelativePath.split("/")[0] ?? "",
    ));
  }

  return children.sort((left, right) => (
    Number(left.isDirectoryEntry) - Number(right.isDirectoryEntry) ||
    left.linkPath.localeCompare(right.linkPath)
  ));
}

// Percent-encode the characters that break an inline markdown link target — a bare
// `(`/`)`/space/`%` in a filename (e.g. a sidecar for `(주)회사_소개 v2.pdf`) would
// truncate the naive `[text](target)` parse. Applied by BOTH index-line writers
// (generator + lint's expected-region builder) and decoded by the lint link
// resolver, so the generator never writes a link its own parser cannot read back
// (원칙 3 Consistency).
export function encodeVaultLinkTarget(linkPath) {
  return String(linkPath ?? "")
    .replaceAll("%", "%25")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll(" ", "%20");
}

function formatReadmeIndexEntry(entry, readmePath, vaultDir) {
  const label = entry.isDirectoryEntry
    ? `${basename(dirname(entry.filePath))}/`
    : entry.title;
  const rawSummary = entry.summary || "Vault document.";
  const summary = rewriteCrossReferenceBullet(rawSummary, entry, readmePath, vaultDir);
  return `- [${label}](${encodeVaultLinkTarget(entry.linkPath)}) — ${summary}`;
}

function replaceMarkerRegion(content, startMarker, endMarker, generatedMarkdown) {
  const normalizedContent = normalizeLineEndings(content).trimEnd();
  const generated = normalizeLineEndings(generatedMarkdown).trim();
  const block = generated
    ? `${startMarker}\n${generated}\n${endMarker}`
    : `${startMarker}\n\n${endMarker}`;
  // Greedy span (first start → last end) so a malformed file with duplicate or
  // stray marker pairs collapses back to a single clean region (self-heal,
  // DEC-K). One region per README is the invariant, so greedy never merges two
  // legitimate regions.
  const markerPattern = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*${escapeRegExp(endMarker)}`,
    "u",
  );

  if (markerPattern.test(normalizedContent)) {
    return `${normalizedContent.replace(markerPattern, block)}\n`;
  }

  return `${normalizedContent}\n\n## Vault Index\n\n${block}\n`;
}

function upsertVaultIndexRegion(content, generatedMarkdown) {
  return replaceMarkerRegion(content, VAULT_INDEX_START_MARKER, VAULT_INDEX_END_MARKER, generatedMarkdown);
}

const VAULT_CROSS_REFERENCES_REGION_PATTERN =
  /\n*##\s+Cross References\s*\n+<!-- vault-cross-references:start -->[\s\S]*?<!-- vault-cross-references:end -->\n*/u;

// The flat root cross-reference dump is retired. Each page keeps its own
// `## Related` section as the SSoT for its links; the root README no longer
// carries a global tag-style mirror. This strips any legacy region so an old
// README self-heals on the next ingest (No Silent Fallback: removal is explicit).
function stripVaultCrossReferencesRegion(content) {
  const normalizedContent = normalizeLineEndings(content);
  if (!VAULT_CROSS_REFERENCES_REGION_PATTERN.test(normalizedContent)) {
    return normalizedContent;
  }
  return `${normalizedContent.replace(VAULT_CROSS_REFERENCES_REGION_PATTERN, "\n").trimEnd()}\n`;
}

async function collectReadmePaths(vaultDir, currentDir = vaultDir, ctx = buildNavContext(vaultDir)) {
  const { profile } = ctx;
  const readmes = [];
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    // Dot-directories are machine/vcs artifacts, never navigable knowledge folders: `.git`, and
    // the `.fts/` FTS index cache (DEC vault-compiler step 7). Skipping them here keeps the README
    // generator's descent identical to the parent-index child listing, which already skips
    // dot-entries (원칙 3 Consistency) — so sync never mints a README inside a derived-cache dir.
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const childDir = join(currentDir, entry.name);
    const childRelativePath = normalizeVaultRelativePath(relative(vaultDir, childDir));
    const childReadme = join(childDir, "README.md");
    // Non-nav slots (plans store, owner-local buckets) are never part of the
    // generated README topology — skip minting/indexing a README and do not
    // descend. Keeps the generator contract identical to lint reachability
    // (원칙 3 Consistency; DEC vault-compiler step 13). A git-tracked nav scope
    // additionally prunes untracked subtrees (vendored evidence, not handbook).
    if (
      isPlansSlotPath(childRelativePath, profile) ||
      isOwnerLocalBucketPath(childRelativePath, profile) ||
      !isDirInNavScope(childRelativePath, ctx)
    ) {
      continue;
    }
    if (isArchiveTreeRelativePath(childRelativePath, profile)) {
      if (!childRelativePath.includes("/")) {
        readmes.push(childReadme);
      }
      continue;
    }
    readmes.push(childReadme);
    readmes.push(...await collectReadmePaths(vaultDir, childDir, ctx));
  }
  return readmes;
}

function defaultReadmeContent(vaultDir, readmePath) {
  const relativeReadmePath = normalizeVaultRelativePath(relative(vaultDir, readmePath));
  const title = titleFromReadmePath(relativeReadmePath);
  return `---
title: ${title}
status: active
---

# ${title}

## Vault Index

${VAULT_INDEX_START_MARKER}

${VAULT_INDEX_END_MARKER}
`;
}

async function buildVaultReadmeIndexUpdates(vaultDir, ctx = buildNavContext(vaultDir)) {
  const rootReadmePath = join(vaultDir, "README.md");
  const readmePaths = [
    rootReadmePath,
    ...await collectReadmePaths(vaultDir, vaultDir, ctx),
  ].filter((readmePath, index, all) => all.indexOf(readmePath) === index);

  const updates = [];

  for (const readmePath of readmePaths.sort((left, right) => left.localeCompare(right))) {
    const existed = existsSync(readmePath);
    const existingContent = existed
      ? normalizeLineEndings(await readFile(readmePath, "utf8"))
      : defaultReadmeContent(vaultDir, readmePath);
    const children = await collectReadmeIndexChildren(vaultDir, readmePath, ctx);
    const generatedMarkdown = children
      .map((entry) => formatReadmeIndexEntry(entry, readmePath, vaultDir))
      .join("\n");
    let nextContent = upsertVaultIndexRegion(existingContent, generatedMarkdown);
    if (readmePath === rootReadmePath) {
      nextContent = stripVaultCrossReferencesRegion(nextContent);
    }
    updates.push({
      readmePath,
      relativeReadmePath: normalizeVaultRelativePath(relative(vaultDir, readmePath)),
      generatedMarkdown,
      nextContent,
      existed,
      changed: !existed || existingContent !== nextContent,
    });
  }

  return updates;
}

export function extractIndexStructure(indexContent) {
  const pathToSubsection = new Map();
  const subsectionOrder = new Map();
  if (!indexContent) {
    return { pathToSubsection, subsectionOrder };
  }

  const lines = normalizeLineEndings(indexContent).split("\n");
  let currentSection = null;
  let currentSubsection = null;

  for (const rawLine of lines) {
    const h2 = rawLine.match(/^##\s+(.+?)\s*$/u);
    if (h2) {
      currentSection = h2[1].trim();
      currentSubsection = null;
      if (!subsectionOrder.has(currentSection)) {
        subsectionOrder.set(currentSection, []);
      }
      continue;
    }
    const h3 = rawLine.match(/^###\s+(.+?)\s*$/u);
    if (h3 && currentSection) {
      currentSubsection = h3[1].trim();
      const order = subsectionOrder.get(currentSection);
      if (order && !order.includes(currentSubsection)) {
        order.push(currentSubsection);
      }
      continue;
    }
    const link = rawLine.match(/^-\s+\[[^\]]+\]\(([^)]+\.md)\)/u);
    if (link && currentSection) {
      const relPath = link[1].trim();
      pathToSubsection.set(relPath, currentSubsection);
    }
  }

  return { pathToSubsection, subsectionOrder };
}

export async function rewriteIndex(vaultDir, { profile, trackedDirs } = {}) {
  const ctx = buildNavContext(vaultDir, { profile, trackedDirs });
  const updates = await buildVaultReadmeIndexUpdates(vaultDir, ctx);
  for (const update of updates) {
    await writeFileAtomic(update.readmePath, update.nextContent, "utf8");
  }
}

// One derivation pass: regenerate every folder's generated vault-index region
// and (unless `check`) write back only the READMEs whose content actually
// changed (content equality, 8원칙 #5).
async function runVaultIndexPass(activeVaultDir, check, ctx) {
  const updates = await buildVaultReadmeIndexUpdates(activeVaultDir, ctx);
  const changed = [];
  let unchangedCount = 0;
  for (const update of updates) {
    if (!update.changed) {
      unchangedCount += 1;
      continue;
    }
    changed.push({ path: update.relativeReadmePath, created: !update.existed });
    if (!check) {
      await writeFileAtomic(update.readmePath, update.nextContent, "utf8");
    }
  }
  return { total: updates.length, changed, unchangedCount };
}

// Idempotent regeneration of the vault-index topology. The index is a pure
// function of the source tree (README markers + child pages), so each README is
// rewritten only when its regenerated content differs.
//
// A single pass is not always a fixed point: when a pass *creates* a child
// README (e.g. a folder that had none), its parent's generated index entry for
// that child only reflects the new file on the *next* pass. Write mode
// therefore iterates to a fixed point — it loops until a pass writes nothing,
// so that a subsequent independent `vault sync` invocation is a genuine no-op
// (Done Criteria: 연속 2회 실행 시 2회차 no-op). Non-convergence within
// `maxPasses` is a hard error, never silently truncated (No Silent Fallback).
//
// `check: true` never writes; it reports single-pass drift — the drift gate for
// git hooks / CI ("would a sync change anything?").
export async function syncVaultIndex({ vaultDir, check = false, maxPasses = 10, profile, trackedDirs } = {}) {
  const activeVaultDir = vaultDir ?? resolveVaultDir();
  const ctx = buildNavContext(activeVaultDir, { profile, trackedDirs });

  if (check) {
    const pass = await runVaultIndexPass(activeVaultDir, true, ctx);
    return {
      vaultDir: activeVaultDir,
      check: true,
      total: pass.total,
      changedCount: pass.changed.length,
      unchangedCount: pass.unchangedCount,
      changed: pass.changed,
      passes: 1,
      converged: pass.changed.length === 0,
    };
  }

  const touched = new Map();
  let total = 0;
  let passes = 0;
  let lastChangedCount = 0;
  while (passes < maxPasses) {
    const pass = await runVaultIndexPass(activeVaultDir, false, ctx);
    passes += 1;
    total = pass.total;
    lastChangedCount = pass.changed.length;
    for (const entry of pass.changed) {
      if (!touched.has(entry.path)) {
        touched.set(entry.path, entry.created);
      }
    }
    if (pass.changed.length === 0) {
      break;
    }
  }

  if (lastChangedCount > 0) {
    throw new Error(
      `vault sync did not converge after ${maxPasses} passes; ` +
      `${lastChangedCount} README(s) still drifting (possible non-deterministic index generation).`,
    );
  }

  const changed = [...touched.entries()]
    .map(([path, created]) => ({ path, created }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    vaultDir: activeVaultDir,
    check: false,
    total,
    changedCount: changed.length,
    unchangedCount: total - changed.length,
    changed,
    passes,
    converged: true,
  };
}

async function appendLogEntry(vaultDir, message) {
  const logPath = join(vaultDir, "log.md");
  const today = new Date().toISOString().slice(0, 10);
  const heading = `## ${today}`;
  const line = `- ${message}`;
  const existing = existsSync(logPath) ? normalizeLineEndings(await readFile(logPath, "utf8")).trimEnd() : "# Kuma Vault Change Log";

  let next;
  if (!existing.includes(heading)) {
    next = `${existing}\n\n${heading}\n${line}\n`;
  } else {
    const pattern = new RegExp(`(${escapeRegExp(heading)}\\n)([\\s\\S]*?)(?=\\n##\\s+\\d{4}-\\d{2}-\\d{2}|$)`, "u");
    next = `${existing}\n`.replace(pattern, (_match, prefix, block) => `${prefix}${block}${block.endsWith("\n") ? "" : "\n"}${line}\n`);
  }

  await writeFile(logPath, next, "utf8");
}

async function findTaskMetadataById(taskId, taskDir) {
  if (!taskId || !taskDir || !existsSync(taskDir)) {
    return null;
  }

  const entries = await readdir(taskDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".task.md")) {
      continue;
    }

    const fullPath = join(taskDir, entry.name);
    const content = await readFile(fullPath, "utf8");
    const metadata = parseTaskLikeMetadata(content);
    if (String(metadata.id ?? "").trim() === String(taskId).trim()) {
      return metadata;
    }
  }

  return null;
}

export async function resolveResultPathForTaskId(taskId, {
  taskDir = DEFAULT_DISPATCH_TASK_DIR,
  resultDir = DEFAULT_DISPATCH_RESULT_DIR,
  vaultDir = resolveVaultDir(),
} = {}) {
  const normalizedTaskId = String(taskId ?? "").trim();
  if (!normalizedTaskId) {
    throw new Error("taskId is required.");
  }

  const taskMetadata = await findTaskMetadataById(normalizedTaskId, taskDir);
  if (typeof taskMetadata?.result === "string" && taskMetadata.result.trim()) {
    const referenced = resolve(taskMetadata.result);
    if (existsSync(referenced)) {
      return referenced;
    }
  }

  const candidates = [
    join(resultDir, `${normalizedTaskId}.result.md`),
    join(vaultDir, "results", `${normalizedTaskId}.result.md`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return resolve(candidate);
    }
  }

  throw new Error(`Could not resolve result file for task id: ${normalizedTaskId}`);
}

function normalizeOptionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildVaultIngestStampKey(resultPath, mtimeMs) {
  return createHash("sha1")
    .update(`${resolve(resultPath)}:${Math.trunc(mtimeMs)}`)
    .digest("hex");
}

function resolveResultArchiveTarget(vaultDir, resultPath) {
  const fileName = basename(resolve(resultPath));
  return {
    fileName,
    filePath: join(vaultDir, RESULT_ARCHIVE_DIR, fileName),
    relativePath: `${RESULT_ARCHIVE_DIR}/${fileName}`,
  };
}

async function archiveResultFile({
  vaultDir,
  resultPath,
  resultContent,
  qaStatus = "passed",
  dryRun = false,
} = {}) {
  const activeVaultDir = resolve(vaultDir ?? resolveVaultDir());
  const target = resolveResultArchiveTarget(activeVaultDir, resultPath);

  await ensureVaultScaffold(activeVaultDir);
  await mkdir(join(activeVaultDir, RESULT_ARCHIVE_DIR), { recursive: true });

  if (!dryRun) {
    await writeFile(target.filePath, resultContent, "utf8");
    // Ingest boundary (plan step [10]): same shared `syncVaultIndex` engine as
    // `kuma vault sync` (one index regenerator, no divergent copy).
    await syncVaultIndex({ vaultDir: activeVaultDir });
    await appendLogEntry(
      activeVaultDir,
      `ARCHIVE: \`${basename(resultPath)}\` → \`${target.relativePath}\` (qa: ${qaStatus})`,
    );
  }

  return {
    action: "ARCHIVE",
    vaultDir: activeVaultDir,
    archivedResultPath: target.filePath,
    relativeArchivePath: target.relativePath,
  };
}

function buildArchivedResultContent(resultContent, resultMeta = {}) {
  const parsed = parseFrontmatterDocument(resultContent);
  const project =
    typeof resultMeta.project === "string" && resultMeta.project.trim()
      ? resultMeta.project.trim()
      : "";

  if (!project || (typeof parsed.frontmatter.project === "string" && parsed.frontmatter.project.trim())) {
    return resultContent;
  }

  return `${stringifyFrontmatter({
    ...parsed.frontmatter,
    project,
  })}\n\n${parsed.body.trim()}\n`;
}

export async function ingestResultFileWithGuards({
  resultPath,
  signal = null,
  taskDir = DEFAULT_DISPATCH_TASK_DIR,
  stampDir = DEFAULT_VAULT_INGEST_STAMP_DIR,
  vaultDir,
  wikiDir,
  section = null,
  slug = null,
  page = null,
  title = null,
  dryRun = false,
  knownProjectIds = [],
} = {}) {
  const requestedResultPath = normalizeOptionalString(resultPath);
  if (!requestedResultPath) {
    return { status: "skipped", reason: "missing-result-path" };
  }

  const absoluteResultPath = resolve(requestedResultPath);
  if (!existsSync(absoluteResultPath)) {
    return { status: "skipped", reason: "missing-result-file", resultPath: absoluteResultPath };
  }

  const taskMetadata = await findMatchingTaskMetadata(absoluteResultPath, taskDir);
  if (!taskMetadata) {
    return { status: "skipped", reason: "missing-task-metadata", resultPath: absoluteResultPath };
  }

  const qaSurface = normalizeOptionalString(taskMetadata.qa);
  if (!qaSurface) {
    return {
      status: "skipped",
      reason: "task-has-no-qa",
      resultPath: absoluteResultPath,
      taskId: normalizeOptionalString(taskMetadata.id),
    };
  }

  const expectedSignal = normalizeOptionalString(taskMetadata.signal);
  const receivedSignal = normalizeOptionalString(signal);
  if (receivedSignal && expectedSignal && receivedSignal !== expectedSignal) {
    return {
      status: "skipped",
      reason: "signal-mismatch",
      resultPath: absoluteResultPath,
      taskId: normalizeOptionalString(taskMetadata.id),
      expectedSignal,
      receivedSignal,
    };
  }

  const resultStat = await stat(absoluteResultPath);
  const resolvedStampDir = resolve(stampDir);
  const stampPath = join(
    resolvedStampDir,
    `${buildVaultIngestStampKey(absoluteResultPath, resultStat.mtimeMs)}.json`,
  );

  if (existsSync(stampPath)) {
    return {
      status: "skipped",
      reason: "already-ingested",
      resultPath: absoluteResultPath,
      taskId: normalizeOptionalString(taskMetadata.id),
      stampPath,
    };
  }

  const ingest = await ingestResultFile({
    resultPath: absoluteResultPath,
    vaultDir,
    wikiDir,
    taskDir,
    qaStatus: "passed",
    section,
    slug,
    page,
    title,
    dryRun,
    knownProjectIds,
  });

  if (!dryRun) {
    await mkdir(resolvedStampDir, { recursive: true });
    await writeFile(
      stampPath,
      `${JSON.stringify(
        {
          status: "ingested",
          signal: receivedSignal || expectedSignal || null,
          resultPath: absoluteResultPath,
          taskId: normalizeOptionalString(taskMetadata.id) || ingest.taskId || null,
          ingestedAt: new Date().toISOString(),
          ingest,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return {
    status: "ingested",
    reason: null,
    resultPath: absoluteResultPath,
    taskId: normalizeOptionalString(taskMetadata.id) || ingest.taskId || null,
    stampPath,
    ingest,
  };
}

function extractTextFromHtml(html = "") {
  return normalizeLineEndings(String(html ?? ""))
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<\/?(main|article|section|p|div|li|h[1-6]|br|tr|td|th|blockquote)[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

async function readUrlAsIngestText(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/markdown,text/plain,text/html,application/json;q=0.9,*/*;q=0.8",
      "User-Agent": "kuma-vault/vault-ingest",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL for vault-ingest: ${url} (${response.status})`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  if (contentType.includes("text/html")) {
    return extractTextFromHtml(raw);
  }

  return raw.trim();
}

export async function ingestGenericSource({
  source,
  sourceType = null,
  vaultDir,
  taskDir = DEFAULT_DISPATCH_TASK_DIR,
  section = null,
  slug = null,
  page = null,
  title = null,
  project = null,
  qaStatus = "passed",
  dryRun = false,
  knownProjectIds = [],
} = {}) {
  const activeVaultDir = vaultDir ?? resolveVaultDir();
  const normalizedSource = String(source ?? "").trim();
  if (!normalizedSource) {
    throw new Error("source is required.");
  }

  let effectiveSourceType = sourceType;
  if (!effectiveSourceType) {
    if (isLikelyUrl(normalizedSource)) {
      effectiveSourceType = "url";
    } else if (existsSync(resolve(normalizedSource))) {
      effectiveSourceType = "file";
    } else {
      effectiveSourceType = "text";
    }
  }

  if (effectiveSourceType === "file") {
    const resolvedPath = resolve(normalizedSource);
    const content = await readFile(resolvedPath, "utf8");
    const documentMeta = buildGenericDocumentMeta({
      content,
      sourceRef: resolvedPath,
      title,
      project,
    });
    return ingestDocumentMeta({
      documentMeta,
      vaultDir: activeVaultDir,
      section,
      slug,
      page,
      title,
      dryRun,
      qaStatus,
      sourceLogLabel: basename(resolvedPath),
      knownProjectIds,
    });
  }

  if (effectiveSourceType === "url") {
    const content = await readUrlAsIngestText(normalizedSource);
    const documentMeta = buildGenericDocumentMeta({
      content,
      sourceRef: normalizedSource,
      title,
      project,
    });
    return ingestDocumentMeta({
      documentMeta,
      vaultDir: activeVaultDir,
      section,
      slug,
      page,
      title,
      dryRun,
      qaStatus,
      sourceLogLabel: normalizedSource,
      knownProjectIds,
    });
  }

  const documentMeta = buildGenericDocumentMeta({
    content: normalizedSource,
    sourceRef: `text:${sanitizeSlug(slug ?? title ?? normalizedSource.slice(0, 40) ?? "note")}`,
    title,
    taskId: slug ?? null,
    project,
  });
  return ingestDocumentMeta({
    documentMeta,
    vaultDir: activeVaultDir,
    section,
    slug,
    page,
    title,
    dryRun,
    qaStatus,
    sourceLogLabel: "inline-text",
    knownProjectIds,
  });
}

export async function ingestInbox({
  vaultDir,
  taskDir = DEFAULT_DISPATCH_TASK_DIR,
  section = null,
  qaStatus = "passed",
  dryRun = false,
  routeResolver = null,
  knownProjectIds = [],
} = {}) {
  const activeVaultDir = vaultDir ?? resolveVaultDir();
  const inboxDir = join(activeVaultDir, "inbox");
  await ensureVaultScaffold(activeVaultDir);

  if (!existsSync(inboxDir)) {
    return { action: "NONE", vaultDir: activeVaultDir, processed: [] };
  }

  const entries = await readdir(inboxDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile())
    .filter((entry) => !entry.name.endsWith(".done"))
    .filter((entry) => INGESTIBLE_INBOX_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name));

  const processed = [];

  for (const entry of candidates) {
    const originalPath = join(inboxDir, entry.name);
    const archivedPath = `${originalPath}.done`;
    const content = await readFile(originalPath, "utf8");
    const previewDocumentMeta = buildGenericDocumentMeta({
      content,
      sourceRef: originalPath,
      taskId: basename(entry.name, extname(entry.name)),
      project: null,
    });
    const preview = await ingestDocumentMeta({
      documentMeta: previewDocumentMeta,
      vaultDir: activeVaultDir,
      section,
      slug: null,
      page: null,
      title: null,
      dryRun: true,
      qaStatus,
      sourceLogLabel: entry.name,
      knownProjectIds,
    });
    const override = typeof routeResolver === "function"
      ? await routeResolver({
        entryName: entry.name,
        documentMeta: previewDocumentMeta,
        preview,
      })
      : null;
    if (override?.skip === true) {
      processed.push({
        action: "SKIP",
        vaultDir: activeVaultDir,
        sourcePath: originalPath,
        relativePagePath: null,
        routing: preview.routing,
      });
      continue;
    }

    const sourcePath = dryRun ? originalPath : archivedPath;
    if (!dryRun) {
      await rename(originalPath, archivedPath);
    }
    const documentMeta = buildGenericDocumentMeta({
      content,
      sourceRef: sourcePath,
      taskId: basename(entry.name, extname(entry.name)),
      project: null,
    });
    const ingestResult = await ingestDocumentMeta({
      documentMeta,
      vaultDir: activeVaultDir,
      section: override?.section ?? section,
      slug: override?.slug ?? null,
      page: override?.page ?? null,
      title: null,
      dryRun,
      qaStatus,
      sourceLogLabel: entry.name,
      knownProjectIds,
    });
    processed.push({
      ...ingestResult,
      inboxPath: originalPath,
      archivedInboxPath: sourcePath,
    });
  }

  return {
    action: processed.length > 0 ? "INGEST_BATCH" : "NONE",
    vaultDir: activeVaultDir,
    processed,
    dryRun,
  };
}

export async function ingestResultFile({
  resultPath,
  vaultDir,
  wikiDir,
  taskDir = DEFAULT_DISPATCH_TASK_DIR,
  qaStatus = "passed",
  section = null,
  slug = null,
  page = null,
  title = null,
  dryRun = false,
  knownProjectIds = [],
} = {}) {
  const activeVaultDir = vaultDir ?? wikiDir ?? resolveVaultDir();

  if (qaStatus !== "passed") {
    throw new Error("vault ingest requires --qa-status passed.");
  }

  if (typeof resultPath !== "string" || !resultPath.trim()) {
    throw new Error("resultPath is required.");
  }

  const resolvedResultPath = resolve(resultPath);
  const resultContent = await readFile(resolvedResultPath, "utf8");
  const parsedResult = parseFrontmatterDocument(resultContent);
  const taskMetadata = await findMatchingTaskMetadata(resolvedResultPath, taskDir);
  const sourceSlug = sanitizeSlug(
    basename(resolvedResultPath)
      .replace(/\.result\.md$/u, "")
      .replace(/\.md$/u, ""),
  );
  const fallbackTitle = humanizeSlug(parsedResult.frontmatter.id ?? parsedResult.frontmatter.task ?? sourceSlug);
  const resultMeta = {
    sourcePath: resolvedResultPath,
    sourceName: basename(resolvedResultPath),
    sourceSlug,
    taskId:
      String(
        parsedResult.frontmatter.id ??
        parsedResult.frontmatter.task ??
        taskMetadata?.id ??
        sourceSlug,
      ).trim(),
    project:
      typeof parsedResult.frontmatter.project === "string" && parsedResult.frontmatter.project.trim()
        ? parsedResult.frontmatter.project.trim()
        : typeof taskMetadata?.project === "string" && taskMetadata.project.trim()
          ? taskMetadata.project.trim()
          : inferProjectFromSourceName(sourceSlug, knownProjectIds),
    status:
      typeof parsedResult.frontmatter.status === "string" ? parsedResult.frontmatter.status.trim() : "",
    worker:
      typeof parsedResult.frontmatter.worker === "string"
        ? parsedResult.frontmatter.worker.trim()
        : typeof taskMetadata?.worker === "string"
          ? taskMetadata.worker.trim()
          : "",
    qa:
      typeof parsedResult.frontmatter.qa === "string"
        ? parsedResult.frontmatter.qa.trim()
        : typeof taskMetadata?.qa === "string"
          ? taskMetadata.qa.trim()
          : "",
    title: extractTitle(parsedResult.body, fallbackTitle),
    summary: extractSummary(parsedResult.body, fallbackTitle),
    body: parsedResult.body,
    updatedDate: new Date().toISOString().slice(0, 10),
  };
  const archivedResultContent = buildArchivedResultContent(resultContent, resultMeta);

  const archive = await archiveResultFile({
    vaultDir: activeVaultDir,
    resultPath: resolvedResultPath,
    resultContent: archivedResultContent,
    qaStatus,
    dryRun,
  });

  const archivedMeta = {
    ...resultMeta,
    sourcePath: archive.archivedResultPath,
    sourceName: basename(archive.archivedResultPath),
    sourceSlug: sanitizeSlug(stripMarkdownStem(basename(archive.archivedResultPath))),
  };
  const hasExplicitCanonicalTarget = Boolean(
    (typeof section === "string" && section.trim()) ||
    (typeof page === "string" && page.trim()),
  );

  if (!hasExplicitCanonicalTarget) {
    return {
      action: archive.action,
      vaultDir: activeVaultDir,
      resultPath: resolvedResultPath,
      archivedResultPath: archive.archivedResultPath,
      relativeArchivePath: archive.relativeArchivePath,
      taskId: archivedMeta.taskId,
      project: archivedMeta.project,
      sourcePath: archive.archivedResultPath,
      dryRun,
      routing: {
        section: RESULT_ARCHIVE_DIR,
        resolvedSection: RESULT_ARCHIVE_DIR,
        resolvedProject: archivedMeta.project ?? null,
        suggestedPath: archive.relativeArchivePath,
        reason: "result-archive-default",
        confidence: "explicit",
        ambiguous: false,
        candidates: [],
        archivedOnly: true,
        requiresExplicitCanonicalTarget: true,
      },
    };
  }

  const promoted = await ingestDocumentMeta({
    documentMeta: archivedMeta,
    vaultDir: activeVaultDir,
    section,
    slug,
    page,
    title,
    dryRun,
    qaStatus,
    sourceLogLabel: basename(resolvedResultPath),
    knownProjectIds,
  });

  return {
    ...promoted,
    archivedResultPath: archive.archivedResultPath,
    relativeArchivePath: archive.relativeArchivePath,
    archiveAction: archive.action,
  };
}

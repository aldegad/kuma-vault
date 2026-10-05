// Binary sidecar derivation for the Compiler Vault pipeline (DEC vault-compiler step 5).
//
// A binary document `<name>.<ext>` (currently PDF) is a black box to the Markdown-native
// vault — it cannot be searched, indexed, or linked. This module derives a Markdown
// *sidecar* `<name>.<ext>.md` that carries the extracted text plus a
// source/sha256/extractor stamp, so the binary participates in the vault like any other
// page (search finds its text; the README index lists it in nav folders).
//
// Invariants:
//   - The sidecar is a PURE FUNCTION of the binary bytes (+ the pinned extractor). It
//     carries no timestamps; two syncs over an unchanged binary produce byte-identical
//     output — and in practice the second sync never re-extracts at all.
//   - Regeneration is gated on the source content hash (`sha256`): extraction runs only
//     when the sidecar is missing or its stamped hash differs from the binary
//     (완료 기준: "sync 가 hash 변경 시에만 재생성" / hash 불변 재실행 no-op).
//   - Extractors are PLUGGABLE behind `SIDECAR_EXTRACTORS`, keyed by extension. The key
//     set must equal `SIDECAR_SOURCE_EXTENSIONS` (the topology SSoT in vault-ingest) —
//     asserted by a parity test.
//   - No Silent Fallback: an extraction failure is reported (never a partial/empty
//     sidecar written), and the caller surfaces it as a failing gate.

import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

import { resolveVaultDir } from "./path-resolver.mjs";
import {
  extractSummary,
  isDirInTrackedScope,
  isSidecarPath,
  parseFrontmatterDocument,
  resolveNavScopeTrackedDirs,
  stringifyFrontmatter,
} from "./vault-ingest.mjs";
import { VAULT_PROFILE, resolveProfile } from "./vault-profile.mjs";

const SIDECAR_WALK_SKIP_DIRS = new Set(["node_modules"]);
const SIDECAR_KIND = "sidecar";

// --- Pluggable extractor registry ------------------------------------------------------

// PDF extractor: kordoc (primary, DEC vault-compiler step 4). Since kordoc 4.x the PDF
// engine (pdfjs) is bundled inside kordoc's dist — no external pdfjs-dist dependency, and
// the historical 5.x pin (pdfjs 6.x `doc.destroy` crash) is obsolete (re-verified 2026-07-14).
// kordoc is imported lazily so a vault without any PDFs never pays its (heavy) load cost.
async function extractPdf(absolutePath) {
  let kordoc;
  try {
    kordoc = await import("kordoc");
  } catch (error) {
    throw new Error(
      `PDF sidecar extraction requires the "kordoc" dependency (>=4, PDF engine bundled). ` +
      `Install failed or missing: ${error.message}`,
    );
  }

  const result = await kordoc.parse(absolutePath);
  if (!result || result.success === false) {
    const detail = result?.warnings?.length ? `: ${JSON.stringify(result.warnings)}` : "";
    throw new Error(`kordoc could not parse ${absolutePath}${detail}`);
  }

  const text = typeof result.markdown === "string" && result.markdown.trim()
    ? result.markdown
    : kordoc.blocksToMarkdown(Array.isArray(result.blocks) ? result.blocks : []);

  return {
    text: String(text ?? "").trim(),
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    extractor: `kordoc@${kordoc.VERSION}`,
  };
}

// extension -> async (absolutePath) => { text, warnings, extractor }
export const SIDECAR_EXTRACTORS = new Map([
  [".pdf", extractPdf],
]);

// --- Hashing + stamp -------------------------------------------------------------------

// In a remote store a large binary is a git-lfs pointer on disk until it is fetched. The
// pointer's oid IS the sha256 of the content, so the stamp check needs no bytes: a pointer is
// in sync with a sidecar stamped with its oid. Extraction (a stale or missing sidecar) still
// needs the real file and fails loud on a pointer.
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]*)\n$/u;

async function sha256File(absolutePath) {
  const buffer = await readFile(absolutePath);
  if (buffer.length <= 1024) {
    const pointer = LFS_POINTER.exec(buffer.toString("utf8"));
    if (pointer) return { sha256: pointer[1], lfsPointer: true };
  }
  return { sha256: createHash("sha256").update(buffer).digest("hex"), lfsPointer: false };
}

// Read the idempotency stamp (source hash + extractor) from an existing sidecar without
// re-extracting. Returns null when the file is absent or not a valid sidecar.
async function readSidecarStamp(sidecarAbsolutePath) {
  if (!existsSync(sidecarAbsolutePath)) {
    return null;
  }
  const { frontmatter } = parseFrontmatterDocument(await readFile(sidecarAbsolutePath, "utf8"));
  const sha256 = typeof frontmatter.sha256 === "string" ? frontmatter.sha256.trim() : "";
  const extractor = typeof frontmatter.extractor === "string" ? frontmatter.extractor.trim() : "";
  return { sha256, extractor };
}

function sanitizeSummary(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

function buildSidecarContent({ sourceRelativePath, sha256, extractor, text, warnings }) {
  const sourceName = basename(sourceRelativePath);
  const summary = sanitizeSummary(extractSummary(text, `Extracted text of ${sourceName}`));
  const sourceExt = extname(sourceName).slice(1).toLowerCase();

  const frontmatter = {
    title: sourceName,
    kind: SIDECAR_KIND,
    source: sourceRelativePath,
    sha256,
    extractor,
    description: summary,
    tags: ["sidecar", sourceExt].filter(Boolean),
    generated: true,
  };

  const warningBlock = warnings.length > 0
    ? `\n## Extraction Warnings\n\n${warnings
        .map((warning) => `- ${typeof warning === "string" ? warning : JSON.stringify(warning)}`)
        .join("\n")}\n`
    : "";

  return `${stringifyFrontmatter(frontmatter)}

# ${sourceName}

> Generated sidecar — a pure function of \`${sourceRelativePath}\` (sha256 \`${sha256.slice(0, 12)}…\`).
> Regenerated by \`kuma vault sync\` only when the source hash changes; do not edit by hand.

## Summary

${summary}
${warningBlock}
## Extracted Text

${text}
`;
}

// --- Walk -------------------------------------------------------------------------------

// Collect every binary in the vault that the profile derives a sidecar for. Sidecars may
// live in any folder (nav pages get indexed; owner-local buckets stay searchable), so the
// walk skips only machine dirs (dot-dirs, node_modules) — plus, under a git-tracked nav
// scope, untracked subtrees: vendored/secret material is preserved evidence, never a
// sidecar-extraction source (원칙 3 Consistency with the index generator's scope).
async function collectSidecarSources(vaultDir, ctx, currentDir = vaultDir, out = []) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SIDECAR_WALK_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const relativePath = relative(vaultDir, fullPath).split("\\").join("/");
      if (!isDirInTrackedScope(relativePath, ctx.trackedDirs)) {
        continue;
      }
      await collectSidecarSources(vaultDir, ctx, fullPath, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = extname(entry.name).toLowerCase();
    if (!ctx.sourceExtensions.has(ext)) {
      continue;
    }
    out.push({
      absolutePath: fullPath,
      relativePath: relative(vaultDir, fullPath).split("\\").join("/"),
      ext,
    });
  }
  return out;
}

// Sidecars whose source binary no longer exists (renamed/deleted). Reported, never
// silently deleted (No Silent Fallback — deletion is a destructive, out-of-scope action).
async function collectOrphanSidecars(vaultDir, ctx, currentDir = vaultDir, out = []) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SIDECAR_WALK_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const dirRelativePath = relative(vaultDir, fullPath).split("\\").join("/");
      if (!isDirInTrackedScope(dirRelativePath, ctx.trackedDirs)) {
        continue;
      }
      await collectOrphanSidecars(vaultDir, ctx, fullPath, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativePath = relative(vaultDir, fullPath).split("\\").join("/");
    if (!isSidecarPath(relativePath, ctx.profile)) {
      continue;
    }
    // Sidecar `<name>.<ext>.md` -> expected source `<name>.<ext>`.
    const sourceAbsolutePath = fullPath.slice(0, -".md".length);
    if (!existsSync(sourceAbsolutePath)) {
      out.push(relativePath);
    }
  }
  return out;
}

// A sidecar edit/deletion checks its source too; deleted sources can leave orphans.
function selectedSidecars(vaultDir, paths, ctx) {
  const candidates = new Set(paths.map((path) => isSidecarPath(path, ctx.profile) ? path.slice(0, -3) : path));
  const sources = [];
  const orphans = [];
  for (const path of candidates) {
    const ext = extname(path).toLowerCase();
    if (!ctx.sourceExtensions.has(ext)) continue;
    const dirs = dirname(path).split("/").filter((p) => p !== ".");
    if (dirs.some((p) => p.startsWith(".") || SIDECAR_WALK_SKIP_DIRS.has(p))) continue;
    if (!isDirInTrackedScope(dirname(path), ctx.trackedDirs)) continue;
    const absolutePath = join(vaultDir, path);
    if (existsSync(absolutePath)) {
      if (lstatSync(absolutePath).isFile()) sources.push({ absolutePath, relativePath: path, ext });
    } else if (existsSync(`${absolutePath}.md`)) orphans.push(`${path}.md`);
  }
  return { sources, orphans };
}

// --- Sync -------------------------------------------------------------------------------

// Idempotent sidecar derivation. In write mode, (re)generates a sidecar for every binary
// whose stamped hash is missing or stale, and skips the rest; a second invocation over an
// unchanged tree regenerates nothing (no-op). `check: true` never writes — it reports which
// sidecars would be (re)generated (the drift gate for git hooks / CI).
export async function syncVaultSidecars({ vaultDir, check = false, profile = VAULT_PROFILE, paths = null } = {}) {
  const activeVaultDir = vaultDir ?? resolveVaultDir();
  const resolvedProfile = resolveProfile(profile);

  // The profile owns which binary extensions derive sidecars; every declared
  // extension must have a registered extractor (No Silent Fallback — a contract
  // naming an unextractable binary is a hard error, never a skipped file class).
  const sourceExtensions = new Set(resolvedProfile.sidecarSourceExtensions.map((ext) => ext.toLowerCase()));
  for (const ext of sourceExtensions) {
    if (!SIDECAR_EXTRACTORS.has(ext)) {
      throw new Error(
        `profile ${resolvedProfile.id} declares sidecarSourceExtensions "${ext}" but no extractor is registered ` +
        `(known: ${[...SIDECAR_EXTRACTORS.keys()].join(", ")}).`,
      );
    }
  }

  const ctx = {
    profile: resolvedProfile,
    trackedDirs: resolveNavScopeTrackedDirs(activeVaultDir, resolvedProfile),
    sourceExtensions,
  };

  const selected = paths === null ? null : selectedSidecars(activeVaultDir, paths, ctx);
  const sources = selected ? selected.sources : await collectSidecarSources(activeVaultDir, ctx);
  sources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const regenerated = [];
  const skipped = [];
  const failed = [];

  for (const source of sources) {
    const sidecarAbsolutePath = `${source.absolutePath}.md`;
    const sidecarRelativePath = `${source.relativePath}.md`;

    let sha256;
    let lfsPointer;
    try {
      ({ sha256, lfsPointer } = await sha256File(source.absolutePath));
    } catch (error) {
      failed.push({ path: source.relativePath, error: `hash failed: ${error.message}` });
      continue;
    }

    const stamp = await readSidecarStamp(sidecarAbsolutePath);
    if (stamp && stamp.sha256 === sha256) {
      skipped.push(sidecarRelativePath);
      continue;
    }

    const reason = stamp ? "hash-changed" : "missing";
    if (check) {
      regenerated.push({ path: sidecarRelativePath, created: !stamp, reason });
      continue;
    }

    if (lfsPointer) {
      failed.push({ path: source.relativePath, error: `LFS pointer (sha256 ${sha256.slice(0, 12)}…) — fetch the file first (vault blob get ${source.relativePath}), then sync` });
      continue;
    }

    const extractor = SIDECAR_EXTRACTORS.get(source.ext);
    if (!extractor) {
      failed.push({ path: source.relativePath, error: `no extractor registered for ${source.ext}` });
      continue;
    }

    try {
      const { text, warnings, extractor: extractorId } = await extractor(source.absolutePath);
      const content = buildSidecarContent({
        sourceRelativePath: source.relativePath,
        sha256,
        extractor: extractorId,
        text,
        warnings,
      });
      await writeFile(sidecarAbsolutePath, content, "utf8");
      regenerated.push({ path: sidecarRelativePath, created: !stamp, reason });
    } catch (error) {
      failed.push({ path: source.relativePath, error: error.message });
    }
  }

  const orphans = selected ? selected.orphans : await collectOrphanSidecars(activeVaultDir, ctx);
  orphans.sort((left, right) => left.localeCompare(right));

  return {
    vaultDir: activeVaultDir,
    check,
    total: sources.length,
    regeneratedCount: regenerated.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    orphanCount: orphans.length,
    regenerated,
    skipped,
    failed,
    orphans,
    ok: failed.length === 0,
  };
}

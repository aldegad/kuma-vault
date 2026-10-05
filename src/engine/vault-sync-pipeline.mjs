// The composed `vault sync` pipeline — ONE implementation, every consumer.
//
// `vault sync` is not a single derivation; it is a fixed composition of three of them
// (sidecar → enrich → index) plus a lint pass, a report shape, and an exit gate that
// decides which of those failures may refuse a commit. That composition IS the command's
// judgement, and it lived twice: once in this package's CLI adapter, once in the kuma-studio
// host's own `vault-commands.mjs`. Two copies of a judgement drift the moment one side is
// improved — measured on 2026-07-31, the host copy was three engine improvements behind and
// on a real declared tree (acme-ops) reported 39 phantom sidecar drifts and 974 phantom
// enrich candidates against the engine's 0 and 41, because it ran the derived passes under
// the built-in contract while the index pass used the declared one.
//
// So the judgement lives here and the CLIs became adapters. What stays with each consumer is
// exactly what differs between them, and it is injected, never re-implemented:
//
//   - `generateDescription` / `createGenerateDescription` — which model writes a page's
//     synopsis. The generic CLI resolves it from ~/.kuma-vault/config.json; kuma-studio
//     injects a generator built from its team config.
//   - `enrichFields` — which leaf-frontmatter fields the enrich pass may fill. This is NOT a
//     free choice: it is the dependent variable of the generator's response contract. A
//     generator that returns a bare description string (the host's prompt) must select
//     `["description"]` only, because asking for `tags`/`aliases` it never produces writes
//     empty arrays AND their freshness stamps, permanently suppressing later enrichment. A
//     generator that returns `{description, tags, aliases}` (this package's provider adapter)
//     selects the full set. The pair travels together; see enrichVaultDescriptions.
//
// Everything else — order, gate, report — is not a consumer's to vary.

import { enrichVaultDescriptions } from "./vault-enrich.mjs";
import { syncVaultIndex } from "./vault-ingest.mjs";
import { lintVaultFiles } from "./vault-lint.mjs";
import { resolveTreeContract } from "./vault-config.mjs";
import { syncVaultSidecars } from "./vault-sidecar.mjs";

export function formatVaultSyncReport(report) {
  const lines = [];
  const mode = report.check ? "check (no writes)" : "write";
  lines.push(`vault sync — ${mode}`);
  lines.push(`vault-dir: ${report.vaultDir}`);
  lines.push(
    report.check
      ? `index: ${report.changedCount} drifted / ${report.total} README(s) (${report.unchangedCount} in sync)`
      : `index: ${report.changedCount} regenerated / ${report.total} README(s) (${report.unchangedCount} unchanged, ${report.passes} pass${report.passes === 1 ? "" : "es"})`,
  );
  for (const entry of report.changed) {
    const tag = entry.created ? "create" : report.check ? "drift" : "write";
    lines.push(`  - [${tag}] ${entry.path}`);
  }

  const sidecars = report.sidecars;
  if (sidecars) {
    lines.push(
      report.check
        ? `sidecars: ${sidecars.regeneratedCount} would (re)generate / ${sidecars.total} binary source(s) (${sidecars.skippedCount} in sync)`
        : `sidecars: ${sidecars.regeneratedCount} (re)generated / ${sidecars.total} binary source(s) (${sidecars.skippedCount} unchanged)`,
    );
    for (const entry of sidecars.regenerated) {
      const tag = report.check ? "drift" : entry.created ? "create" : "rebuild";
      lines.push(`  - [${tag}] ${entry.path}`);
    }
    for (const entry of sidecars.failed) {
      lines.push(`  - [fail] ${entry.path}: ${entry.error}`);
    }
    if (sidecars.orphanCount > 0) {
      for (const orphan of sidecars.orphans) {
        lines.push(`  - [orphan] ${orphan} (source binary missing)`);
      }
    }
  }

  const enrich = report.enrich;
  if (enrich) {
    lines.push(
      report.check
        ? `enrich: ${enrich.candidateCount} would enrich / ${enrich.total} leaf page(s) (${enrich.skippedCount} in sync)`
        : `enrich: ${enrich.enrichedCount} enriched / ${enrich.total} leaf page(s) (${enrich.skippedCount} unchanged)`,
    );
    for (const entry of enrich.enriched) {
      const tag = report.check ? "would" : "write";
      lines.push(`  - [${tag}:${entry.reason}] ${entry.path}`);
    }
    for (const entry of enrich.failed) {
      lines.push(`  - [fail] ${entry.path}: ${entry.error}`);
    }
    for (const entry of enrich.raced ?? []) {
      lines.push(`  - [raced] ${entry.path}: edited while the model ran — left as written`);
    }
    if (enrich.capped) {
      lines.push(`  - [capped] ${enrich.remaining} more page(s) not enriched this run (--enrich-limit)`);
    }
  }

  const lint = report.lint;
  if (lint) {
    lines.push(
      lint.ok
        ? `lint: ok (${lint.checkedCount ?? 0} file(s))`
        : `lint: ${lint.issueCount} issue(s) across ${lint.fileCount ?? 0} file(s)`,
    );
    if (typeof lint.staleIndexRegionCount === "number") {
      lines.push(`  stale vault-index regions: ${lint.staleIndexRegionCount}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Read a refused `vault sync --check` (the pre-commit gate) back from its text: was it refused
 * for TRACKED drift alone, and which files drifted. A caller that regenerates the derivations
 * itself (the sync daemon's autosave) may regenerate and commit again on drift; any other
 * refusal — a commit-policy violation (`vault gate [rule]`), a sidecar that failed to extract —
 * is not drift, and neither is output this formatter did not write. The reader sits next to
 * the formatter so the two change together.
 *
 * @param {string} text The gate's output (stdout and stderr).
 * @returns {{ driftOnly: boolean, drifted: string[], summary: string, reasons: string[] }}
 *   `drifted` is tree-relative; `summary` is the report's drift count line(s), empty without
 *   drift; `reasons` are the lines of a refusal that is not drift (a commit-policy violation, a
 *   sidecar that failed, stale index regions), trimmed, empty when there is none.
 */
export function parseVaultSyncCheckDrift(text) {
  const output = String(text ?? "");
  const index = /^index: (\d+) drifted \/.*$/m.exec(output);
  const sidecars = /^sidecars: (\d+) would \(re\)generate \/.*$/m.exec(output);
  const counted = [index, sidecars].filter((match) => match && Number(match[1]) > 0);
  const drifted = [...output.matchAll(/^ {2}- \[(?:drift|create)\] (.+)$/gm)].map((match) => match[1].trim());
  // Stale index regions come with drift; alone they are the two index builders disagreeing.
  const reasons = output
    .split("\n")
    .filter((line) => /^vault gate \[/.test(line) || /^ {2}- \[fail\] /.test(line) || (counted.length === 0 && /^ {2}stale vault-index regions: [1-9]/.test(line)))
    .map((line) => line.trim());
  const otherRefusal = reasons.length > 0;
  return { driftOnly: counted.length > 0 && !otherRefusal, drifted, summary: counted.map((match) => match[0]).join("; "), reasons };
}

function summarizeVaultSyncLint(lintResult) {
  const issues = Array.isArray(lintResult?.issues) ? lintResult.issues : [];
  const staleIndexRegionCount = issues.filter(
    (issue) => issue?.code === "vault-index-region-stale",
  ).length;
  const failingFiles = new Set(
    issues.map((issue) => issue?.file).filter(Boolean),
  ).size;
  return {
    ok: lintResult?.ok !== false,
    checkedCount: lintResult?.fileCount ?? 0,
    fileCount: failingFiles,
    issueCount: lintResult?.issueCount ?? issues.length,
    staleIndexRegionCount,
  };
}

/**
 * Run the composed sync over one resolved (root, profile) pair.
 *
 * The caller has already answered "which tree, under which contract" — that is a CLI/flag
 * question (`resolveVaultContract`). This answers "what runs, in what order, and what does it
 * report", identically for every consumer.
 *
 * @param {object} options
 * @param {string} options.vaultDir Resolved tree root.
 * @param {object|string} [options.profile] Resolved contract (or a built-in profile id). A
 *   declared tree's contract is its declaration (`resolveTreeContract`): omit it, or pass the
 *   declared one; an undeclared tree needs it.
 * @param {boolean} [options.check] Report drift without writing.
 * @param {boolean} [options.enrich] Run the opt-in LLM leaf-metadata pass.
 * @param {number} [options.enrichLimit] Cap pages one enrich write run may (re)generate.
 * @param {string[]} [options.enrichPaths] Tree-relative pages the enrich pass is narrowed to (the
 *   pages the sync daemon's clone committed) and writes together after its last model call;
 *   omitted, it walks the tree and writes each page as it is described.
 * @param {string[]} [options.enrichFields] Leaf fields the enrich pass may fill; must match
 *   what the injected generator actually returns (see the module header). Defaults to
 *   `enrichVaultDescriptions`'s own default (description only).
 * @param {Function} [options.generateDescription] Explicit generator (tests / E2E drivers).
 * @param {Function} [options.createGenerateDescription] Lazy factory for the production
 *   generator. Called ONLY when a write-mode enrich actually needs it, so a consumer whose
 *   generator construction reads config and throws (kuma-studio's team-config lookup)
 *   cannot break a plain `vault sync`.
 * @returns {Promise<object>} The sync report, with the full lint result as `lintReport`.
 */
export async function runVaultSync({
  vaultDir,
  profile,
  check = false,
  enrich = false,
  enrichLimit,
  enrichFields,
  enrichPaths,
  generateDescription,
  createGenerateDescription,
} = {}) {
  const resolvedProfile = resolveTreeContract(vaultDir, profile);

  if (enrich && !resolvedProfile.enrich) {
    // No Silent Fallback: a profile that does not carry the LLM-enrich contract
    // must reject --enrich rather than silently ignore it.
    throw new Error(`vault sync --enrich is not supported by the ${resolvedProfile.id} profile.`);
  }

  // Binary sidecars are a profile feature. Sidecars first when enabled: extracting binaries
  // mints/refreshes `<name>.<ext>.md` derivatives, and a newly-created sidecar must exist
  // before the index pass so it gets listed in its folder's vault-index. Both passes are
  // hash/content-gated derivations, so the composed sync stays idempotent.
  const sidecars = resolvedProfile.sidecar
    ? await syncVaultSidecars({ vaultDir, check, profile: resolvedProfile })
    : null;
  const activeVaultDir = sidecars?.vaultDir ?? vaultDir;

  // Enrich (opt-in `--enrich`) runs between sidecars and the index pass: the model fills a
  // leaf page's frontmatter metadata, and the index pass right after derives that page's
  // README index line from its description. Only leaf frontmatter is written; check mode
  // reports would-enrich targets without ever calling the model.
  let enrichResult = null;
  if (enrich) {
    const generator = check ? undefined : generateDescription ?? createGenerateDescription?.();
    enrichResult = await enrichVaultDescriptions({
      vaultDir: activeVaultDir,
      check,
      generateDescription: generator,
      profile: resolvedProfile,
      maxFiles: enrichLimit ?? Infinity,
      fields: enrichFields,
      paths: enrichPaths ?? null,
    });
  }

  const sync = await syncVaultIndex({ vaultDir: activeVaultDir, check, profile: resolvedProfile });

  // Lint runs against the resolved vault after the (conditional) index write so
  // the stale-region count reflects post-sync state. No writes in check mode.
  const lintReport = lintVaultFiles({ vaultDir: sync.vaultDir, mode: "full", profile: resolvedProfile });
  const lint = summarizeVaultSyncLint(lintReport);

  return {
    command: "vault-sync",
    profile: resolvedProfile.id,
    ...sync,
    sidecars,
    enrich: enrichResult,
    lint,
    lintReport,
  };
}

/**
 * The exit gate, as a pure function of the report.
 *
 * ── What the gate refuses ──────────────────────────────────────────────────
 * Every derivation (README vault-index regions, binary sidecars) lives inside the committed
 * tree. Drift there means the snapshot the commit would capture disagrees with its own
 * generator, and regenerating it mid-commit would rewrite unstaged files without fixing the
 * staged snapshot. Refuse, loud — the human re-runs `vault sync` and re-commits.
 *
 * check mode: tracked drift is a failing gate.
 * write mode: success once index + sidecars are regenerated; residual non-index lint
 * issues are surfaced but gated by `vault lint`, not by sync.
 *
 * @param {object} report
 * @returns {0|1}
 */
export function vaultSyncExitCode(report) {
  if (report.check && (report.changedCount > 0 || (report.sidecars?.regeneratedCount ?? 0) > 0)) {
    return 1;
  }
  if ((report.lint?.staleIndexRegionCount ?? 0) > 0) {
    // Post-write stale regions mean the two index builders disagree — a real
    // defect, never silently swallowed (No Silent Fallback).
    return 1;
  }
  if ((report.sidecars?.failedCount ?? 0) > 0) {
    // A binary that could not be extracted is a reported failure, never a silent skip
    // (No Silent Fallback). The sidecar is left untouched rather than written empty.
    return 1;
  }
  if (report.enrich && report.enrich.failedCount > 0) {
    // A page the model could not describe is a reported failure, never a silent skip
    // (No Silent Fallback). The page's frontmatter is left untouched.
    return 1;
  }
  return 0;
}

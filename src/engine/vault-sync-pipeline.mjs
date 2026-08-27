// The composed `vault sync` pipeline — ONE implementation, every consumer.
//
// `vault sync` is not a single derivation; it is a fixed composition of four of them
// (sidecar → enrich → index → fts) plus a lint pass, a report shape, and an exit gate that
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
//     injects its Moonbi team-config generator.
//   - `enrichFields` — which leaf-frontmatter fields the enrich pass may fill. This is NOT a
//     free choice: it is the dependent variable of the generator's response contract. A
//     generator that returns a bare description string (the host's Moonbi prompt) must select
//     `["description"]` only, because asking for `tags`/`aliases` it never produces writes
//     empty arrays AND their freshness stamps, permanently suppressing later enrichment. A
//     generator that returns `{description, tags, aliases}` (this package's provider adapter)
//     selects the full set. The pair travels together; see enrichVaultDescriptions.
//
// Everything else — order, gate, report — is not a consumer's to vary.

import { enrichVaultDescriptions } from "./vault-enrich.mjs";
import { healFtsIndex } from "./vault-fts.mjs";
import { syncVaultIndex } from "./vault-ingest.mjs";
import { lintVaultFiles } from "./vault-lint.mjs";
import { resolveProfile } from "./vault-profile.mjs";
import { syncVaultSidecars } from "./vault-sidecar.mjs";

export function formatVaultSyncReport(report) {
  const lines = [];
  // "no writes" was a half-truth: check mode writes nothing to the TRACKED tree, but the
  // out-of-tree `.fts/` search cache is healed on the same path (see the fts pass below —
  // the cache self-heals rather than gating a commit). A header that claims zero writes and
  // then touches a directory is the kind of small dishonesty that costs a debugging hour.
  const mode = report.check ? "check (no tree writes — .fts cache self-heals)" : "write";
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
    if (enrich.capped) {
      lines.push(`  - [capped] ${enrich.remaining} more page(s) not enriched this run (--enrich-limit)`);
    }
  }

  const fts = report.fts;
  if (fts) {
    // The FTS cache reports the same way in both modes because it behaves the same way in both:
    // it is healed, never gated. A heal is announced (원칙 6 — the self-heal is observable, not
    // a silent repair), including when a concurrent builder won the publish race.
    const healSuffix = fts.raced ? ", concurrent builder published first" : "";
    lines.push(
      fts.healed
        ? `fts: healed — rebuilt from the live tree (${fts.docCount} doc(s)${healSuffix})`
        : `fts: in sync (${fts.docCount} doc(s))`,
    );
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
 * @param {object|string} options.profile Resolved contract (or a built-in profile id).
 * @param {boolean} [options.check] Report drift without writing.
 * @param {boolean} [options.enrich] Run the opt-in LLM leaf-metadata pass.
 * @param {number} [options.enrichLimit] Cap pages one enrich write run may (re)generate.
 * @param {string[]} [options.enrichFields] Leaf fields the enrich pass may fill; must match
 *   what the injected generator actually returns (see the module header). Defaults to
 *   `enrichVaultDescriptions`'s own default (description only).
 * @param {Function} [options.generateDescription] Explicit generator (tests / E2E drivers).
 * @param {Function} [options.createGenerateDescription] Lazy factory for the production
 *   generator. Called ONLY when a write-mode enrich actually needs it, so a consumer whose
 *   generator construction reads config and throws (kuma-studio's Moonbi team-config lookup)
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
  generateDescription,
  createGenerateDescription,
} = {}) {
  const resolvedProfile = resolveProfile(profile);

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
    });
  }

  const sync = await syncVaultIndex({ vaultDir: activeVaultDir, check, profile: resolvedProfile });

  // FTS index is the last derivation (search feature): it indexes the fully-derived tree.
  // Full rebuild, idempotent by corpus signature.
  //
  // Both modes take the SAME path — the cache is healed, not gated. Check mode is a gate on the
  // *committed tree*, and the `.fts/` database is not in it: a stale cache says nothing about
  // whether the commit is consistent, so refusing the commit over it blocked one session's work
  // for another session's edit (2026-07-31, 3 measured occurrences). 원칙 1's self-heal clause
  // owns this case — the derived cache recovers from the live truth instead of stopping and
  // calling a human. Tracked derivations in the gate below keep the loud refusal.
  let fts = null;
  if (resolvedProfile.fts) {
    fts = await healFtsIndex({ vaultDir: sync.vaultDir, profile: resolvedProfile });
  }

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
    fts,
    lint,
    lintReport,
  };
}

/**
 * The exit gate, as a pure function of the report.
 *
 * ── What the gate refuses, and what it heals ────────────────────────────────
 * The gate splits derivations by RESIDENCE, which is a structural property, not a heuristic:
 *
 *  - TRACKED derivations (README vault-index regions, binary sidecars) live inside the
 *    committed tree. Drift there means the snapshot the commit would capture disagrees with
 *    its own generator, and regenerating it mid-commit would rewrite unstaged files without
 *    fixing the staged snapshot. Refuse, loud — the human re-runs `vault sync` and re-commits.
 *  - CACHE derivations (the `.fts/` index) live outside the committed tree. Nothing about
 *    them can make a commit inconsistent, and rebuilding one changes nothing a commit sees,
 *    so they are healed during the run rather than gated here.
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

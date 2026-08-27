// vault-sync-triggers — the ONE place a vault-sync boundary turns into an engine call.
//
// The Compiler Vault model has three trigger boundaries that must re-derive the
// README vault-index topology (Notes: "트리거는 워처가 아니라 경계 3개"):
//   1. ingest       — a page/result was written; regenerate inline (vault-ingest.mjs
//                     calls `syncVaultIndex` directly right after the write).
//   2. cron          — a periodic safety-net tick runs `kuma vault sync`
//                     (commandVaultSync → syncVaultIndex).
//   3. lint-self-heal — a full lint flagged a stale vault-index region; heal it.
//
// (git hook is the 4th boundary and is owned by plan step [8], not here.)
//
// SSoT (원칙 1): every boundary funnels through the SAME index engine
// `syncVaultIndex`. There is no per-boundary index regenerator — a divergent copy
// would let two boundaries disagree about what the derived index should be. This
// module is the funnel + the self-heal detector; the engine itself lives in
// vault-ingest.mjs and is shared verbatim with `kuma vault sync`.
//
// No Silent Fallback (원칙 6): a boundary that cannot reach a converged index
// throws — self-heal never swallows residual drift, it surfaces it.

import { syncVaultIndex } from "./vault-ingest.mjs";
import { lintVaultFiles } from "./vault-lint.mjs";
import { resolveVaultDir } from "./path-resolver.mjs";

// The three trigger boundaries this module funnels (git hook = step [8], separate).
export const VAULT_SYNC_BOUNDARIES = Object.freeze(["ingest", "cron", "lint-self-heal"]);

// Lint code emitted when a folder README's generated vault-index region no longer
// matches what the generator would produce (vault-lint.mjs, full mode only).
export const STALE_INDEX_CODE = "vault-index-region-stale";

// THE shared entry point. Every boundary (cron / lint-self-heal here; ingest calls
// syncVaultIndex directly from its own module to avoid an import cycle) turns a
// trigger into exactly one engine call so all boundaries stay on one SSoT.
//
// `check: true` reports drift without writing (the drift-gate a boundary can use
// to decide "would a sync change anything?"). Non-convergence throws inside
// syncVaultIndex and is propagated here unmodified (No Silent Fallback).
export async function triggerVaultSyncIndex({ vaultDir, boundary, check = false } = {}) {
  if (!VAULT_SYNC_BOUNDARIES.includes(boundary)) {
    throw new Error(
      `triggerVaultSyncIndex: unknown boundary "${boundary}" ` +
      `(expected ${VAULT_SYNC_BOUNDARIES.join(" | ")}).`,
    );
  }
  const activeVaultDir = vaultDir ?? resolveVaultDir();
  const index = await syncVaultIndex({ vaultDir: activeVaultDir, check });
  return { boundary, vaultDir: activeVaultDir, check, index };
}

function staleIndexIssues(lintResult) {
  const issues = Array.isArray(lintResult?.issues) ? lintResult.issues : [];
  return issues.filter((issue) => issue?.code === STALE_INDEX_CODE);
}

// Lint-self-heal boundary. Lint stays detection-only by design (vault-lint.mjs
// never regenerates); this path is where a detected stale index region becomes a
// heal by funneling through the SAME engine, then re-linting to confirm.
//
// - Stale regions are detected in FULL mode only (fast mode skips the region diff),
//   so self-heal lints full regardless of the caller's default.
// - No stale regions → no-op (healed:false). The engine is not run; a clean tree
//   is not rewritten (원칙 5 idempotency).
// - Regions remain stale after the heal → throw. That means the generator and the
//   lint region-checker disagree (a real defect), surfaced not swallowed
//   (No Silent Fallback).
export async function selfHealStaleIndex({ vaultDir, mode = "full" } = {}) {
  const activeVaultDir = vaultDir ?? resolveVaultDir();
  // Stale detection needs the full region diff; downgrade nothing.
  const lintMode = mode === "fast" ? "full" : mode;

  const before = lintVaultFiles({ vaultDir: activeVaultDir, mode: lintMode });
  const staleBefore = staleIndexIssues(before);
  if (staleBefore.length === 0) {
    return {
      healed: false,
      vaultDir: activeVaultDir,
      staleBefore: 0,
      staleAfter: 0,
      files: [],
    };
  }

  const result = await triggerVaultSyncIndex({
    vaultDir: activeVaultDir,
    boundary: "lint-self-heal",
  });

  const after = lintVaultFiles({ vaultDir: activeVaultDir, mode: lintMode });
  const staleAfter = staleIndexIssues(after);
  if (staleAfter.length > 0) {
    throw new Error(
      `vault index self-heal ran but ${staleAfter.length} stale region(s) remain ` +
      `(${staleAfter.map((issue) => issue.file).join(", ")}) — ` +
      `generator/lint disagree, likely non-deterministic index generation.`,
    );
  }

  return {
    healed: true,
    vaultDir: activeVaultDir,
    staleBefore: staleBefore.length,
    staleAfter: 0,
    files: [...new Set(staleBefore.map((issue) => issue.file).filter(Boolean))],
    index: result.index,
  };
}

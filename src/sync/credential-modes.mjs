// The clone's side of the credential modes (../server/credential-modes.mjs): which credential
// directories the clone has, kept 0600/0700 after git writes them, and the `credentialModes`
// alarm when one stays loose.
//
// Roots come from the index (`git ls-files`, re-read only when HEAD moved) plus the untracked
// paths of this tick's scan, so a credential directory someone just created counts before
// autosave commits it. Everything under a root is walked on disk, tracked or not.

import { credentialModes, credentialRoots } from "../server/credential-modes.mjs";
import { git, revParse, splitNul } from "./git.mjs";
import { isoLocal } from "./integrate.mjs";

/** Credential roots of the clone's index, cached by HEAD in `cache` (`{ head, roots }`). */
export async function trackedCredentialRoots(repo, cache = null) {
  const head = await revParse(repo, "HEAD");
  if (cache && cache.head === head && head) return cache;
  const listed = await git(["ls-files", "-z"], { cwd: repo });
  return { head, roots: credentialRoots(splitNul(listed.stdout)) };
}

/**
 * Walk the clone's credential directories; `fix` tightens what is loose. `paths` adds
 * repo-relative paths (the scan's untracked ones) whose roots the index does not have yet.
 * Returns `{ report, cache }`.
 */
export async function keepCredentialModes(repo, { fix = false, paths = [], cache = null } = {}) {
  const tracked = await trackedCredentialRoots(repo, cache);
  const roots = [...new Set([...tracked.roots, ...credentialRoots(paths)])].sort();
  return { report: credentialModes(repo, roots, { fix }), cache: tracked };
}

/** The `credentialModes` alarm (red) of a report, or of the error that stopped the walk. */
export function credentialModesAlert(report, { now = Date.now(), error = null } = {}) {
  if (error) {
    return { count: 1, active: true, level: "red", checkedAt: isoLocal(now), error: String(error.message ?? error).slice(0, 400), paths: [], fixed: 0 };
  }
  return {
    count: report.looseCount,
    active: report.looseCount > 0,
    level: "red",
    checkedAt: isoLocal(now),
    roots: report.roots,
    checked: report.checked,
    fixed: report.fixedCount,
    paths: report.loose,
    failed: report.failed,
  };
}

/** One line for a CLI: what was tightened and what is still loose. */
export function formatCredentialModes(report) {
  const parts = [`credential modes: ${report.checked} path(s) under ${report.roots} root(s)`];
  if (report.fixedCount) parts.push(`${report.fixedCount} tightened to 0600/0700`);
  if (report.looseCount) parts.push(`${report.looseCount} still loose: ${report.loose.slice(0, 5).map((p) => `${p.path} ${p.mode ?? "?"}${p.error ? ` (${p.error})` : ""}`).join(", ")}`);
  return parts.join(", ");
}

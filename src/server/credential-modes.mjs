// Modes of the credential directories in a checkout: files 0600, directories 0700.
//
// git records only the executable bit, and a checkout creates files and directories by the
// umask (0644/0755 under the common 022). So every `vault clone`, every fast-forward or merge
// the sync daemon moves a clone by, and every move of the server's `tree/` would leave the
// vault's secrets readable by the group and others. The clone, the daemon, `vault sync install`
// and the server's post-receive call `credentialModes` after git wrote the tree; `vault sync
// status` calls it read-only and raises the `credentialModes` alarm on what it finds.
//
// Which directories: `credentialRootOf` (secret-dirs.mjs), over the paths the caller lists (git's
// tracked paths, plus the clone's untracked ones). Under a root every file and directory is
// walked on disk, tracked or not. A symlink is never followed or changed (chmod would change its
// target). A file keeps an owner executable bit (0700): git records that bit, and dropping it
// would show as a change git commits. A mode is loose when the group or others have any bit.
// Paths and modes only — a file's content is never read.

import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { credentialRootOf } from "./secret-dirs.mjs";

export const CREDENTIAL_FILE_MODE = 0o600;
export const CREDENTIAL_DIR_MODE = 0o700;
const MAX_PATHS = 200;

const octal = (mode) => (mode & 0o7777).toString(8).padStart(4, "0");

/** Sorted unique credential roots of repo-relative paths (each path's outermost `_credentials`). */
export function credentialRoots(paths) {
  const roots = new Set();
  for (const path of paths) {
    const root = credentialRootOf(path);
    if (root) roots.add(root);
  }
  return [...roots].sort();
}

/** The mode a credential path should have, from its lstat. */
export function wantedMode(stat) {
  if (stat.isDirectory()) return CREDENTIAL_DIR_MODE;
  return stat.mode & 0o100 ? 0o700 : CREDENTIAL_FILE_MODE;
}

export function isLooseMode(mode) {
  return (mode & 0o077) !== 0;
}

/**
 * Walk the credential roots under `workTree` and, with `fix`, tighten every loose mode.
 * Returns `{ roots, checked, fixed, loose, failed }`: `fixed` and `failed` are what this call
 * changed or could not change, `loose` what is still loose afterwards (with `fix`, exactly the
 * failures). Each list holds `{ path, mode, want }` (octal strings) and is capped at 200.
 */
export function credentialModes(workTree, roots, { fix = false } = {}) {
  const report = { roots: roots.length, checked: 0, fixed: [], loose: [], failed: [] };
  const push = (list, row) => {
    if (list.length < MAX_PATHS) list.push(row);
  };
  const counts = { fixed: 0, loose: 0, failed: 0 };

  const visit = (rel) => {
    let stat;
    try {
      stat = lstatSync(join(workTree, rel));
    } catch (error) {
      if (error.code === "ENOENT") return; // listed by git, not on disk (deleted, or a sparse path)
      counts.failed += 1;
      counts.loose += 1;
      push(report.failed, { path: rel, mode: null, want: null, error: error.code ?? error.message });
      push(report.loose, { path: rel, mode: null, want: null });
      return;
    }
    if (stat.isSymbolicLink()) return;
    report.checked += 1;
    const want = wantedMode(stat);
    if (isLooseMode(stat.mode)) {
      const row = { path: rel, mode: octal(stat.mode), want: octal(want) };
      if (!fix) {
        counts.loose += 1;
        push(report.loose, row);
      } else {
        try {
          chmodSync(join(workTree, rel), want);
          counts.fixed += 1;
          push(report.fixed, row);
        } catch (error) {
          counts.failed += 1;
          counts.loose += 1;
          push(report.failed, { ...row, error: error.code ?? error.message });
          push(report.loose, row);
        }
      }
    }
    if (!stat.isDirectory()) return;
    let names;
    try {
      names = readdirSync(join(workTree, rel));
    } catch (error) {
      counts.failed += 1;
      counts.loose += 1;
      push(report.failed, { path: rel, mode: octal(stat.mode), want: octal(want), error: error.code ?? error.message });
      push(report.loose, { path: rel, mode: octal(stat.mode), want: octal(want) });
      return;
    }
    for (const name of names.sort()) visit(`${rel}/${name}`);
  };

  for (const root of roots) visit(root);
  return { ...report, fixedCount: counts.fixed, looseCount: counts.loose, failedCount: counts.failed };
}

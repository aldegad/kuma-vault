// What in the work tree is not committed: `git status --porcelain=v2 -z --untracked-files=all`,
// each path with the stat the autosave and the alarms decide on. Ignored paths never show up
// here; the ignored scan (alerts.mjs) lists those.

import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

import { isLfsPath } from "../server/lfs-paths.mjs";
import { git, splitNul } from "./git.mjs";

/** mtime of the path, or for a deleted path of its nearest existing ancestor directory. */
function statOrAncestor(repo, path) {
  try {
    return { stat: lstatSync(join(repo, path)), exists: true };
  } catch {
    let dir = dirname(path);
    for (;;) {
      try {
        return { stat: lstatSync(join(repo, dir === "." ? "" : dir)), exists: false };
      } catch {
        if (dir === "." || dir === "/" || dir === "") return { stat: null, exists: false };
        dir = dirname(dir);
      }
    }
  }
}

/** True when the file is binary for the reject rule: an LFS extension, or NUL in its first 8000 bytes. */
export function looksBinaryFile(absPath, repoPath) {
  if (isLfsPath(repoPath)) return true;
  let fd;
  try {
    fd = openSync(absPath, "r");
    const buffer = Buffer.alloc(8000);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Parse porcelain v2 -z output into entries:
 * `{ path, tracked, nested, unmerged, staged, exists, size, mtimeMs, birthtimeMs, symlink }`.
 */
export async function scanWorktree(repo) {
  const result = await git(
    ["--literal-pathspecs", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"],
    { cwd: repo },
  );
  const entries = [];
  for (const record of splitNul(result.stdout)) {
    const type = record[0];
    let path;
    let tracked = true;
    let unmerged = false;
    let nested = false;
    let staged = false;
    if (type === "1") {
      // 1 XY sub mH mI mW hH hI path
      const fields = record.split(" ");
      path = fields.slice(8).join(" ");
      staged = fields[1][0] !== ".";
      nested = fields[2][0] === "S";
    } else if (type === "u") {
      const fields = record.split(" ");
      path = fields.slice(10).join(" ");
      unmerged = true;
    } else if (type === "?") {
      path = record.slice(2);
      tracked = false;
      if (path.endsWith("/")) {
        nested = true; // an untracked directory git does not descend into: a nested repository
        path = path.slice(0, -1);
      }
    } else {
      continue; // "2" cannot appear with --no-renames; "!" only with --ignored; "#" headers
    }
    const { stat, exists } = statOrAncestor(repo, path);
    entries.push({
      path,
      tracked,
      nested,
      unmerged,
      staged,
      exists,
      symlink: Boolean(exists && stat?.isSymbolicLink()),
      size: exists && stat ? stat.size : 0,
      mtimeMs: stat ? stat.mtimeMs : 0,
      birthtimeMs: stat && stat.birthtimeMs > 0 ? stat.birthtimeMs : 0,
    });
  }
  return entries;
}

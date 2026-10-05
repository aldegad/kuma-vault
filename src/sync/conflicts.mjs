// `_sync-conflicts/conflicts.jsonl`: one line per conflict the merge settled, later lines with
// the same id update it (`"status":"resolved"`). `vault sync resolve` is how a person or an
// agent picks the version; the daemon never picks.

import { appendFileSync, copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { regenerateDerived } from "./autosave.mjs";
import { gitRetry } from "./git.mjs";
import { scanWorktree } from "./scan.mjs";
import { conflictsDir, isoLocal } from "./integrate.mjs";

export function ledgerPath(ctx) {
  return `${conflictsDir(ctx)}/conflicts.jsonl`;
}

/** All conflicts folded by id, in first-seen order. */
export function readConflicts(ctx) {
  const abs = join(ctx.repo, ledgerPath(ctx));
  if (!existsSync(abs)) return [];
  const byId = new Map();
  for (const line of readFileSync(abs, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row?.id) continue;
    byId.set(row.id, { ...(byId.get(row.id) ?? {}), ...row });
  }
  return [...byId.values()];
}

export function openConflicts(ctx) {
  return readConflicts(ctx).filter((c) => c.status === "open");
}

/**
 * The same records read by path, for a host that has no sync context (a plan writer refusing a
 * plan with an open conflict): the tree at `treeDir` (where its vault.config.json lives) inside the
 * repository `repoDir` (default: the nearest ancestor holding `.git`). Record paths are
 * repo-relative. Returns `{ repoDir, ledgerPath, conflicts, open }`; no ledger means no conflicts.
 */
export function readTreeSyncConflicts(treeDir, { repoDir } = {}) {
  const tree = realpathSync(treeDir);
  let repo = repoDir ? realpathSync(repoDir) : tree;
  if (!repoDir) {
    while (!existsSync(join(repo, ".git"))) {
      const parent = dirname(repo);
      if (parent === repo) throw new Error(`${treeDir} is not inside a git work tree`);
      repo = parent;
    }
  }
  const ctx = { repo, treeRel: relative(repo, tree).split("\\").join("/") };
  const conflicts = readConflicts(ctx);
  return { repoDir: repo, ledgerPath: join(repo, ledgerPath(ctx)), conflicts, open: conflicts.filter((c) => c.status === "open") };
}

function removeEmptyParents(repo, rel, stopAt) {
  let dir = dirname(rel);
  while (dir && dir !== "." && dir !== stopAt) {
    const abs = join(repo, dir);
    try {
      if (readdirSync(abs).length > 0) return;
      rmdirSync(abs);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/**
 * Settle one conflict: `take` = "local" | "remote" | <path of a merged file>. Puts the chosen
 * content at the path, deletes the side copy, appends the resolved record and commits those
 * paths (the daemon pushes it on its next tick).
 */
export async function resolveConflict(ctx, id, take, { cwd = process.cwd(), now = Date.now() } = {}) {
  const conflict = readConflicts(ctx).find((c) => c.id === id);
  if (!conflict) throw new Error(`no conflict ${id} in ${ledgerPath(ctx)}`);
  if (conflict.status !== "open") throw new Error(`conflict ${id} is already ${conflict.status}`);
  const pathAbs = join(ctx.repo, conflict.path);
  const touched = [conflict.path];
  let taken;
  if (take === "local") {
    taken = "local";
    if (conflict.copy) {
      copyFileSync(join(ctx.repo, conflict.copy), pathAbs);
    } else if (conflict.kept === "remote") {
      rmSync(pathAbs, { force: true }); // local side was the deletion
    }
  } else if (take === "remote") {
    taken = "remote";
    if (!conflict.copy && conflict.kept === "local") rmSync(pathAbs, { force: true }); // remote side was the deletion
  } else {
    const source = ctx.repoPath(take, cwd);
    copyFileSync(join(ctx.repo, source), pathAbs);
    taken = `file:${source}`;
  }
  if (conflict.copy) {
    rmSync(join(ctx.repo, conflict.copy), { force: true });
    touched.push(conflict.copy);
    removeEmptyParents(ctx.repo, conflict.copy, conflictsDir(ctx));
  }
  const ledger = join(ctx.repo, ledgerPath(ctx));
  const prior = readFileSync(ledger, "utf8");
  const line = JSON.stringify({ id, status: "resolved", resolvedAt: isoLocal(now), take: taken, host: ctx.host });
  appendFileSync(ledger, `${prior.endsWith("\n") || prior === "" ? "" : "\n"}${line}\n`);
  touched.push(ledgerPath(ctx));

  // The merge that made this conflict never passed the gate, and the version taken may read
  // differently in its folder index or sidecar: what the regeneration reports writing, and git
  // sees as changed, goes into this commit (as in autosave).
  const derived = await regenerateDerived(ctx);
  if (derived?.written.length) {
    const owned = new Set(derived.written);
    for (const e of await scanWorktree(ctx.repo)) if (owned.has(e.path) && !touched.includes(e.path)) touched.push(e.path);
  }
  const existing = touched.filter((p) => existsSync(join(ctx.repo, p)));
  if (existing.length) {
    await gitRetry(["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: ctx.repo, input: `${existing.join("\0")}\0` });
  }
  const result = await gitRetry(
    ["--literal-pathspecs", "commit", "--quiet", "--only", "-m", `vault-sync: resolve ${id} (take ${taken})`, "--pathspec-from-file=-", "--pathspec-file-nul"],
    { cwd: ctx.repo, input: `${touched.join("\0")}\0`, allowFail: true },
  );
  if (result.code !== 0 && !/nothing to commit|no changes added/i.test(`${result.stdout}${result.stderr}`)) {
    throw new Error(`resolve ${id}: commit failed: ${result.stderr.trim() || result.stdout.toString("utf8").trim()}`);
  }
  return { id, take: taken, paths: touched };
}

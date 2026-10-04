// Autosave: commit what nobody committed (design 2.1).
//
// Everything that is not ignored is collected, text or binary, tracked or not — there is no
// allow list, so a writer nobody listed is still collected. What is held back, and why:
//
//   - a path changed within the last `quietMs` (120 s): its writer may still be at it, or about
//     to commit it with a message. Text still changing after `textForceMs` (10 min) is saved as
//     it stands; a binary (LFS extension) is never forced — a recording appended to for an hour
//     would otherwise leave one CAS object per save. "Changed" is the mtime, except an mtime more
//     than `futureMtimeMs` (5 min) ahead (a camera or an archive with its clock ahead): that path
//     counts from when the daemon first saw it dirty, or it would wait for its clock date,
//     uncollected and unalarmed.
//   - a non-LFS file over `maxNonLfsBytes` (32 MiB): the server's rule 4 would refuse the push and
//     every commit behind it would wait. It stays out and shows in `uncollected` with its reason.
//   - a binary in a `binaries.reject` place: refused by the server's rule 7. It is reject residue.
//   - lock and temp names (the junk block), nested repositories, unmerged paths.
//
// Before `git add`, `vault sync --no-fts` regenerates the tracked derivations (README indexes,
// sidecars) the pre-commit gate checks; the files it reports writing go into the same commit.
// It takes seconds on a large tree, so everything else is judged again after it, on a fresh scan
// and the clock as it then stands: a file written meanwhile (a recording being appended, a note
// being typed) is not quiet and waits. Every judgment reads `clock()` after the scan it judges —
// never a time read before (a tick's start, a fetch ago) — so an mtime written up to that scan
// is never "ahead" of the clock that judges it. The gate then runs as for any commit and is never
// bypassed. A blocked autosave is retried after `gateRetryMs` and its paths age into
// `uncollected`.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { isLfsPath } from "../server/lfs-paths.mjs";
import { rejectMatcher } from "./context.mjs";
import { git, gitRetry } from "./git.mjs";
import { looksBinaryFile, scanWorktree } from "./scan.mjs";

export const REASONS = Object.freeze({
  big: "큰 일반 파일 — .gitattributes 에 확장자 추가",
  nested: "중첩 git 저장소 — 볼트 안에 두지 않는다",
  unmerged: "병합 중인 경로 — 사람이 풀어야 한다",
  junk: "잠금·임시 파일 이름 — .gitignore 쓰레기 블록이 빠졌다",
  blocked: "자동 저장 막힘",
  pending: "아직 거두지 않음",
});

/**
 * When the path last changed, for the quiet rule and the `uncollected` age. An mtime more than
 * `futureMtimeMs` ahead of `now` is not a write in progress but a wrong clock. `now` must be read
 * after the scan that gave `entry`.
 */
export function lastChangeMs(ctx, entry, now, dirtySince) {
  if (entry.mtimeMs <= now + ctx.settings.futureMtimeMs) return entry.mtimeMs;
  return Math.min(dirtySince.get(entry.path) ?? now, now);
}

function nulList(paths) {
  return `${paths.join("\0")}\0`;
}

/**
 * Sort uncommitted entries into ready / waiting / held back. Pure apart from reading file heads.
 * `now` is the judging clock read after the scan that gave `entries`.
 */
export function classifyEntries(ctx, entries, { now, dirtySince, reject }) {
  const ready = [];
  const waiting = [];
  const held = []; // { entry, reason }
  const residue = [];
  for (const entry of entries) {
    const { path } = entry;
    if (entry.nested) {
      held.push({ entry, reason: "nested" });
      continue;
    }
    if (entry.unmerged) {
      held.push({ entry, reason: "unmerged" });
      continue;
    }
    if (ctx.junk(path)) {
      held.push({ entry, reason: "junk" });
      continue;
    }
    if (entry.exists && reject.match(path) && looksBinaryFile(join(ctx.repo, path), path)) {
      residue.push(entry);
      continue;
    }
    const lfs = isLfsPath(path);
    if (entry.exists && !entry.symlink && !lfs && entry.size > ctx.settings.maxNonLfsBytes) {
      held.push({ entry, reason: "big" });
      continue;
    }
    const quiet = now - lastChangeMs(ctx, entry, now, dirtySince) >= ctx.settings.quietMs;
    const since = dirtySince.get(path) ?? now;
    const forced = !lfs && now - since >= ctx.settings.textForceMs;
    if (quiet || forced) ready.push({ ...entry, forced: !quiet && forced });
    else waiting.push(entry);
  }
  return { ready, waiting, held, residue };
}

function runVaultSyncNoFts(ctx) {
  return new Promise((resolvePromise) => {
    const child = spawn(ctx.vaultBin, ["sync", "--no-fts", "--json", "--root", ctx.treeAbs], {
      cwd: ctx.treeAbs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (error) => resolvePromise({ code: 127, stdout: "", stderr: error.message }));
    child.on("close", (code) =>
      resolvePromise({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
}

function firstMeaningfulLine(text) {
  const lines = String(text).split("\n").map((l) => l.replace(/^remote:\s*/, "").trim()).filter(Boolean);
  const pick = lines.find((l) => /error|fail|drift|block|refus|거부|막|denied|fatal/i.test(l)) ?? lines[0] ?? "";
  return pick.slice(0, 300);
}

/**
 * Run `vault sync --no-fts` on a declared tree. Returns the repo paths its report says it wrote
 * (README indexes, sidecars) — what the regeneration owns, nothing else — or null for an
 * undeclared tree. A run that leaves no report writes nothing we collect; its first error line
 * is kept, and the gate refuses the commit if the tree is left drifted.
 */
export async function regenerateDerived(ctx) {
  if (!existsSync(join(ctx.treeAbs, "vault.config.json"))) return null;
  const run = await runVaultSyncNoFts(ctx);
  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    report = null;
  }
  const written = report
    ? [...(report.changed ?? []), ...(report.sidecars?.regenerated ?? [])].map((e) => (ctx.treeRel ? `${ctx.treeRel}/${e.path}` : e.path))
    : [];
  const line = firstMeaningfulLine(report ? run.stderr : `${run.stderr}\n${run.stdout}`);
  return { preSync: { code: run.code, line }, written };
}

/** Bytes and files per directory (two levels below the tree), largest first. */
export function directoryTotals(ctx, files) {
  const byDir = new Map();
  for (const f of files) {
    const rel = ctx.treePath(f.path) ?? f.path;
    const parts = rel.split("/");
    const dir = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0] : ".";
    const row = byDir.get(dir) ?? { dir, bytes: 0, files: 0 };
    row.bytes += f.size;
    row.files += 1;
    byDir.set(dir, row);
  }
  return [...byDir.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files);
}

/**
 * One autosave pass. `regenerate` runs the derivation pass even with nothing quiet to collect —
 * after a merge, whose commit never went through the gate. `memory` carries `dirtySince` (Map path -> first seen dirty) and the gate
 * block (`gateBlockedAt`, `gateMessage`) between ticks. `clock` is the tick's judging clock
 * (daemon.mjs judgeClock); every time this pass judges by is read from it at that moment.
 * Returns what happened.
 */
export async function autosave(ctx, memory, { clock = Date.now, force = false, regenerate = false } = {}) {
  const entries = await scanWorktree(ctx.repo);
  const now = clock();
  const seen = new Set();
  for (const entry of entries) {
    seen.add(entry.path);
    if (!memory.dirtySince.has(entry.path)) {
      const born = !entry.tracked && entry.birthtimeMs > 0 ? Math.min(entry.birthtimeMs, now) : now;
      memory.dirtySince.set(entry.path, born);
    }
  }
  for (const path of [...memory.dirtySince.keys()]) if (!seen.has(path)) memory.dirtySince.delete(path);

  const reject = rejectMatcher(ctx);
  const sorted = classifyEntries(ctx, entries, { now, dirtySince: memory.dirtySince, reject });
  const report = { ...sorted, entries, committed: null, blocked: null, attempted: false };

  if (memory.gateBlockedAt && !force && now - memory.gateBlockedAt < ctx.settings.gateRetryMs) {
    report.blocked = { message: memory.gateMessage, at: memory.gateBlockedAt };
    return report;
  }
  if (sorted.ready.length === 0 && !regenerate) return report;
  report.attempted = true;

  // Regenerate the tracked derivations the gate checks; what it reports writing joins the commit
  // at once — its writer has finished, so the quiet rule does not apply to it (the other holds
  // do). The rest is judged again: the run took time, and whatever was written during it is not
  // quiet now.
  let ready = sorted.ready;
  const derived = await regenerateDerived(ctx);
  if (derived) {
    report.preSync = derived.preSync;
    const owned = new Set(derived.written);
    const after = await scanWorktree(ctx.repo);
    const later = clock();
    const rest = classifyEntries(ctx, after.filter((e) => !owned.has(e.path)), { now: later, dirtySince: memory.dirtySince, reject });
    const own = classifyEntries(ctx, after.filter((e) => owned.has(e.path)), { now: later, dirtySince: memory.dirtySince, reject });
    const ownTaken = [...own.ready, ...own.waiting];
    ready = [...rest.ready, ...ownTaken];
    report.derived = ownTaken.map((e) => e.path);
  }
  if (ready.length === 0) return report;

  const paths = ready.map((e) => e.path);
  const untracked = ready.filter((e) => !e.tracked).map((e) => e.path);
  if (untracked.length) {
    await gitRetry(["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: ctx.repo, input: nulList(untracked) });
  }
  const message = `vault-sync: autosave (${ctx.host}, ${paths.length} files)`;
  const commit = await gitRetry(
    ["--literal-pathspecs", "commit", "--quiet", "--only", "-m", message, "--pathspec-from-file=-", "--pathspec-file-nul"],
    { cwd: ctx.repo, input: nulList(paths), allowFail: true },
  );
  if (commit.code !== 0) {
    const output = `${commit.stdout.toString("utf8")}\n${commit.stderr}`;
    if (untracked.length) {
      await gitRetry(["--literal-pathspecs", "rm", "--cached", "--quiet", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        cwd: ctx.repo,
        input: nulList(untracked),
        allowFail: true,
      });
    }
    if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(output)) {
      return report; // somebody committed these meanwhile — nothing lost
    }
    memory.gateBlockedAt = clock();
    memory.gateMessage = firstMeaningfulLine(output) || `git commit exited ${commit.code}`;
    report.blocked = { message: memory.gateMessage, at: memory.gateBlockedAt };
    return report;
  }
  memory.gateBlockedAt = null;
  memory.gateMessage = null;
  const sha = (await git(["rev-parse", "HEAD"], { cwd: ctx.repo })).stdout.toString("utf8").trim();
  const lfsFiles = ready.filter((e) => e.exists && isLfsPath(e.path));
  report.committed = {
    commit: sha,
    files: paths.length,
    lfsFiles: lfsFiles.length,
    lfsBytes: lfsFiles.reduce((sum, e) => sum + e.size, 0),
    dirs: directoryTotals(ctx, lfsFiles),
    paths,
  };
  for (const path of paths) memory.dirtySince.delete(path);
  return report;
}

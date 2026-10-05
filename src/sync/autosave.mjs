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
// Before `git add`, `vault sync` regenerates the tracked derivations (README indexes,
// sidecars) the pre-commit gate checks; the files it reports writing go into the same commit.
// It takes seconds on a large tree, so everything else is judged again after it, on a fresh scan
// and the clock as it then stands: a file written meanwhile (a recording being appended, a note
// being typed) is not quiet and waits. Every judgment reads `clock()` after the scan it judges —
// never a time read before (a tick's start, a fetch ago) — so an mtime written up to that scan
// is never "ahead" of the clock that judges it. The gate then runs as for any commit and is never
// bypassed. It reads the work tree as it stands at that moment: a page another writer adds,
// removes or re-describes after the regeneration (a `vault sync --enrich` run between its page
// write and its own index pass, an agent saving a note) leaves an index behind it, and the gate
// refuses the commit for a file this pass never touched. That refusal is a race, not a fault: when
// the gate refused for tracked drift alone (its report says so, read back by the engine's
// `parseVaultSyncCheckDrift`), the derivations are regenerated and the commit is made again, with
// whatever the regeneration wrote, at most `gateDriftRetries` times — even when the regeneration
// wrote nothing, because another writer may have brought the index back in step meanwhile. Any
// other refusal (a freeze, a commit-policy rule, a sidecar that failed, a hook of its own), or
// drift that outlasts the retries, is a block: retried after `gateRetryMs`, its paths ageing into
// `uncollected` — or at the next pass, when the tree's `vault.config.json` is no longer the one
// that stood when the pass that was refused began (`declarationDigest`). The gate reads the
// declaration afresh on every run, so a commit refused under one declaration (one being edited
// while the gate read it, one that did not parse) may pass under the next; a declaration that is
// still wrong is refused again, loudly, with its own reason.
//
// A git lock the add or the commit meets (`index.lock`, a ref lock) is not the gate's answer. While
// the call waits on it, the stale-lock rule (stale-locks.mjs) judges it at every retry: a lock a
// killed git left goes as soon as it is old enough and the call goes through, instead of the whole
// lock wait passing on a lock nobody holds and its failure standing as a block for `gateRetryMs`
// after the lock is gone.

import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

import { parseVaultSyncCheckDrift } from "../engine/vault-sync-pipeline.mjs";
import { isLfsPath } from "../server/lfs-paths.mjs";
import { DAEMON_SUBJECT, declarationDigest, rejectMatcher } from "./context.mjs";
import { git, gitRetry } from "./git.mjs";
import { looksBinaryFile, scanWorktree } from "./scan.mjs";
import { clearStaleLocks } from "./stale-locks.mjs";

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

/** `vault sync --json` on the tree, with `extra` flags and `input` on stdin. */
export function runVaultSyncJson(ctx, extra = [], input = null) {
  return new Promise((resolvePromise) => {
    const child = spawn(ctx.vaultBin, ["sync", "--json", "--root", ctx.treeAbs, ...extra], {
      cwd: ctx.treeAbs,
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== null) {
      child.stdin.on("error", () => {}); // a child that exits early closes its stdin; its code says why
      child.stdin.end(input);
    }
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

export function firstMeaningfulLine(text) {
  const lines = String(text).split("\n").map((l) => l.replace(/^remote:\s*/, "").trim()).filter(Boolean);
  const pick = lines.find((l) => /error|fail|drift|block|refus|거부|막|denied|fatal/i.test(l)) ?? lines[0] ?? "";
  return pick.slice(0, 300);
}

// The lines of the gate's own report (formatVaultSyncReport): what the check counted, never why a
// refusal that is not drift was made. "index: 0 drifted", or a vault-dir path holding the word
// "drift", must not stand for a freeze or a failed sidecar.
const GATE_REPORT_LINE = /^(vault sync — |vault-dir: |scope: |index: |sidecars: |enrich: |fts: |lint: |stale vault-index regions: |- \[)/u;

/**
 * A refused commit in one line: a refusal that is not drift says its own reason first (`vault gate
 * [rule] …`, a failed sidecar, stale index regions), then any drift; drift alone is the gate's
 * count line; with either, the tracked derivations it named as out of step (`- [drift] <path>`),
 * so the state file says which index it was. Otherwise the first meaningful line that is not the
 * gate's own report.
 */
export function gateRefusal(output, code, refusal = parseVaultSyncCheckDrift(output)) {
  const reasons = refusal.reasons ?? [];
  const foreign = String(output).split("\n").filter((line) => !GATE_REPORT_LINE.test(line.trim())).join("\n");
  const line = (reasons.length ? [...reasons.slice(0, 2), ...(refusal.summary ? [refusal.summary] : [])].join("; ") : "")
    || refusal.summary
    || firstMeaningfulLine(foreign)
    || `git commit exited ${code}`;
  const named = refusal.drifted;
  if (named.length === 0) return line.slice(0, 500);
  return `${line} — ${named.slice(0, 3).join(", ")}${named.length > 3 ? ` (+${named.length - 3})` : ""}`.slice(0, 500);
}

/**
 * Run `vault sync` on a declared tree. Returns the repo paths its report says it wrote
 * (README indexes, sidecars) — what the regeneration owns, nothing else — or null for an
 * undeclared tree. A run that leaves no report writes nothing we collect; its first error line
 * is kept, and the gate refuses the commit if the tree is left drifted.
 */
export async function regenerateDerived(ctx, paths = null, reason = "unknown-change-scope") {
  if (!existsSync(join(ctx.treeAbs, "vault.config.json"))) return null;
  const treePaths = paths?.map((path) => ctx.treePath(path)).filter((path) => path !== null);
  const extra = treePaths === undefined ? ["--full", "--full-reason", reason] : ["--changed-paths-from", "-"];
  return readSyncRun(ctx, await runVaultSyncJson(ctx, extra, treePaths === undefined ? null : nulList(treePaths)));
}

/**
 * A `vault sync --json` run read back: `{ preSync, written, report }`. `written` is what its report
 * says it wrote (README indexes, sidecars, and with `enrichedWritten` the pages it described), as
 * repo paths; `report` is the parsed report, null when the run printed none.
 */
export function readSyncRun(ctx, run, { enrichedWritten = false } = {}) {
  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    report = null;
  }
  const pages = enrichedWritten ? (report?.enrich?.enriched ?? []).filter((e) => e.wrote) : [];
  const written = report
    ? [...(report.changed ?? []), ...(report.sidecars?.regenerated ?? []), ...pages].map((e) => (ctx.treeRel ? `${ctx.treeRel}/${e.path}` : e.path))
    : [];
  const line = firstMeaningfulLine(report ? run.stderr : `${run.stderr}\n${run.stdout}`);
  return { preSync: { code: run.code, line }, written, report };
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
 * after a merge, whose commit never went through the gate. `derived` hands in a derivation run
 * already made (`{ preSync, written }`, the enrich run of enrich.mjs, which regenerated the
 * indexes too): its written paths are taken like the regeneration's and no second run is made.
 * `enriched` counts the pages that run described, for the commit message. `memory` carries `dirtySince` (Map path -> first seen dirty) and the gate
 * block (`gateBlockedAt` the last refusal, `gateBlockedSince` the first, `gateRefusals`,
 * `gateMessage`, `gateDeclaration` the declaration digest the refused pass began under) between ticks. `clock` is the tick's judging clock
 * (daemon.mjs judgeClock); every time this pass judges by is read from it at that moment.
 * Returns what happened: `driftRetries` lists each gate refusal for drift that was regenerated
 * and committed again, `blocked` a refusal that blocks (`reason` "drift" or "refused", with the
 * drifted files), `unblocked` the block this pass cleared (`at` its first refusal, `lastAt` its
 * last, `refusals`), `vanished` the untracked files left out because their writer deleted them
 * between the scan and the add. `log` takes the row of a stale git lock removed while a call
 * waited on it.
 */
export async function autosave(ctx, memory, { clock = Date.now, force = false, regenerate = false, derived: given = null, enriched = 0, log = () => {} } = {}) {
  const declaration = declarationDigest(ctx.treeAbs); // before the gate runs: what this pass is judged under
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
  const report = { ...sorted, entries, committed: null, blocked: null, unblocked: null, driftRetries: [], attempted: false };

  if (memory.gateBlockedAt && !force && memory.gateDeclaration === declaration && now - memory.gateBlockedAt < ctx.settings.gateRetryMs) {
    report.blocked = { message: memory.gateMessage, at: memory.gateBlockedAt };
    return report;
  }
  if (sorted.ready.length === 0 && !regenerate && !given) return report;
  report.attempted = true;

  // Regenerate the tracked derivations the gate checks; what it reports writing joins the commit
  // at once — its writer has finished, so the quiet rule does not apply to it (the other holds
  // do). The rest is judged again: the run took time, and whatever was written during it is not
  // quiet now.
  let ready = sorted.ready;
  const derived = given ?? (await regenerateDerived(ctx, regenerate || !memory.syncInitialized ? null : entries.map((e) => e.path), regenerate ? "post-integration" : "first-autosave"));
  if (derived) {
    report.preSync = derived.preSync;
    report.syncScope = derived.report?.scope;
    if (derived.preSync.code === 0) memory.syncInitialized = true;
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

  // Commit, and answer a refusal by regenerating: see the header.
  let taken = ready;
  const added = new Set();
  let regenerations = 0;
  const onLocked = () => clearStaleLocks(ctx, { clock, log }); // a lock met here is judged at once
  for (;;) {
    const paths = taken.map((e) => e.path);
    const untracked = taken.filter((e) => !e.tracked && !added.has(e.path)).map((e) => e.path);
    if (untracked.length) {
      const add = ["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"];
      const result = await gitRetry(add, { cwd: ctx.repo, input: nulList(untracked), allowFail: true, onLocked });
      if (result.code !== 0) {
        // git refuses the whole add when one path is gone. A file its writer deleted after the
        // scan (a run clearing its own frames) has nothing left to save: leave it out and save
        // the rest. A failure with every path still there is a failure.
        const gone = untracked.filter((path) => !pathExists(join(ctx.repo, path)));
        if (gone.length === 0) throw new Error(`git ${add.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
        const left = new Set(gone);
        report.vanished = [...(report.vanished ?? []), ...gone];
        for (const path of gone) memory.dirtySince.delete(path);
        taken = taken.filter((e) => !left.has(e.path));
        if (taken.length === 0) return report; // nothing was added: nothing to undo
        continue;
      }
      for (const path of untracked) added.add(path);
    }
    const message = `${DAEMON_SUBJECT}autosave (${ctx.host}, ${paths.length} files${enriched ? `, ${enriched} enriched` : ""})`;
    const commit = await gitRetry(
      ["--literal-pathspecs", "commit", "--quiet", "--only", "-m", message, "--pathspec-from-file=-", "--pathspec-file-nul"],
      { cwd: ctx.repo, input: nulList(paths), allowFail: true, onLocked },
    );
    if (commit.code === 0) break;

    const output = `${commit.stdout.toString("utf8")}\n${commit.stderr}`;
    const nothing = /nothing to commit|no changes added to commit|nothing added to commit/i.test(output);
    const refusal = parseVaultSyncCheckDrift(output);
    const drifted = refusal.drifted.map((p) => (ctx.treeRel ? `${ctx.treeRel}/${p}` : p));
    const again = !nothing && refusal.driftOnly && regenerations < ctx.settings.gateDriftRetries ? await regenerateDerived(ctx, [...paths, ...drifted, ...(await scanWorktree(ctx.repo)).map((e) => e.path)]) : null;
    if (again) {
      regenerations += 1;
      report.driftRetries.push({ attempt: regenerations, drifted });
      const have = new Set(paths);
      const moved = new Set(again.written);
      const scan = (await scanWorktree(ctx.repo)).filter((e) => moved.has(e.path) && !have.has(e.path));
      const own = classifyEntries(ctx, scan, { now: clock(), dirtySince: memory.dirtySince, reject });
      const more = [...own.ready, ...own.waiting];
      taken = [...taken, ...more];
      report.derived = [...(report.derived ?? []), ...more.map((e) => e.path)];
      continue;
    }
    if (added.size) {
      await gitRetry(["--literal-pathspecs", "rm", "--cached", "--quiet", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        cwd: ctx.repo,
        input: nulList([...added]),
        allowFail: true,
        onLocked,
      });
    }
    if (nothing) {
      // somebody committed these meanwhile — nothing lost, and the gate (which runs before git
      // finds the commit empty) let it through
      clearBlock(memory, report);
      return report;
    }
    memory.gateBlockedAt = clock(); // the last refusal: the retry wait runs from it
    memory.gateBlockedSince ??= memory.gateBlockedAt; // the first: how long the block has lasted
    memory.gateRefusals = (memory.gateRefusals ?? 0) + 1;
    memory.gateMessage = gateRefusal(output, commit.code, refusal);
    memory.gateDeclaration = declaration;
    report.blocked = {
      message: memory.gateMessage,
      at: memory.gateBlockedAt,
      reason: refusal.driftOnly ? "drift" : "refused",
      drifted,
      retries: regenerations,
    };
    return report;
  }
  clearBlock(memory, report);
  const paths = taken.map((e) => e.path);
  const sha = (await git(["rev-parse", "HEAD"], { cwd: ctx.repo })).stdout.toString("utf8").trim();
  const lfsFiles = taken.filter((e) => e.exists && isLfsPath(e.path));
  report.committed = {
    commit: sha,
    files: paths.length,
    lfsFiles: lfsFiles.length,
    lfsBytes: lfsFiles.reduce((sum, e) => sum + e.size, 0),
    dirs: directoryTotals(ctx, lfsFiles),
    paths,
    regenerations,
  };
  for (const path of paths) memory.dirtySince.delete(path);
  return report;
}

function pathExists(abs) {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function clearBlock(memory, report) {
  if (memory.gateBlockedAt) {
    report.unblocked = { at: memory.gateBlockedSince ?? memory.gateBlockedAt, lastAt: memory.gateBlockedAt, refusals: memory.gateRefusals ?? 1, message: memory.gateMessage };
  }
  memory.gateBlockedAt = null;
  memory.gateBlockedSince = null;
  memory.gateRefusals = 0;
  memory.gateMessage = null;
  memory.gateDeclaration = null;
}

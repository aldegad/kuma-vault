// Enrich on autosave: describe the knowledge pages this clone committed (docs/sync.md).
//
// Off unless the clone says so (`git config kuma-vault.enrich.onAutosave true`, read every tick): it
// calls a model, and only the clone where the pages are written should. When on, a queue collects the tree's
// knowledge pages from two places:
//
//   - every autosave commit of this daemon (the paths it carried), and
//   - every other commit made in this clone — an agent's or a person's `git commit`. Most pages
//     arrive this way. Each tick reads the commits on `main` that no earlier tick looked at
//     (`seenHead`), leaving out merges, the daemon's own commits and the commits that came from
//     the server. Where a commit came from is read from git's own record of `origin/main` (its
//     reflog): a commit came from the server when the first state of `origin/main` that holds it
//     was written by a fetch — the daemon's, or a person's `git fetch`/`git pull` in the clone —
//     and from this clone when that state was written by this clone's push ("update by push") or
//     when no state holds it yet. So a page pulled by hand is not described here, and one this
//     clone pushed before a tick could look (a commit made while a tick runs; one pushed and
//     built on elsewhere while the daemon was stopped) still is: the clone that wrote a page
//     describes it. `origin/main` as the daemon's last fetch left it (`remoteSeen`) also bounds
//     the walk: everything under it came from the server or was looked at. Turning enrich on
//     starts from what the server does not have yet; with no `origin/main` at all it starts from
//     the current head — a whole history is a bulk import, not a tick's work.
//
// The commits are judged every tick, also while the tree's declaration cannot be read: their
// paths are held (`held`) and queued by the resolver once it is back, so a commit pushed during
// the alarm and built on by another computer is still this clone's when the alarm clears.
//
// A path enters the queue only if the engine's one target resolver, under the tree's declaration,
// calls it a knowledge page (plans, archive slots such as results/, root ledgers, README indexes,
// sidecars, owner-local buckets, hidden directories, the pages the declaration lists in
// `enrichExclude` and secret directories are never targets). So
// the queue's `ENRICH_PENDING_MAX` places hold pages a run can describe, whatever else the clone
// commits while no provider answers.
//
// Right after AUTOSAVE the tick hands the queue to one
// `vault sync --enrich --enrich-paths-from -` run, which asks the same resolver again and
// calls the model for the pages whose description is missing or stamped for an older body. A page
// with uncommitted changes is not handed over: its writer is still at it, and the commit below
// would take their work with it. It stays queued until it is committed. What the run writes — the
// pages, together after its last model call, and the indexes regenerated from them — is committed
// by the next autosave pass of the same tick, so the tree is never left with a description its
// index does not carry.
//
//   - caps: at most `enrichPerTick` model calls a tick and `enrichPerHour` in the last hour; what
//     does not fit stays queued for the next tick.
//   - failures: a tree whose declaration cannot be read or carries no enrich, a run that prints no
//     report (no provider configured, a crash) or a page the model could not describe raises the
//     `enrich` alarm; a failed run waits `enrichRetryMs`; a page that failed
//     `ENRICH_GIVE_UP_AFTER` times leaves the queue and stays in the alarm until it is committed
//     again.
//   - secrets: a path crossing `_credentials/` or `_sync-conflicts/` never enters the queue (the
//     engine refuses it too).
//   - one run at a time: it runs inside the tick, and one daemon serves a clone.
//
// The queue survives a restart in the state file (`enrichQueue`); it holds `ENRICH_PENDING_MAX`
// paths and counts what it dropped — a bulk import is for `vault sync --enrich --enrich-limit`.

import { resolveTreeContract } from "../engine/vault-config.mjs";
import { isEnrichTargetPath } from "../engine/vault-enrich.mjs";
import { crossesSecretDir } from "../server/secret-dirs.mjs";
import { autosave, readSyncRun, runVaultSyncJson } from "./autosave.mjs";
import { DAEMON_SUBJECT } from "./context.mjs";
import { git, revParse } from "./git.mjs";
import { isoLocal } from "./integrate.mjs";
import { scanWorktree } from "./scan.mjs";

export const ENRICH_PENDING_MAX = 1000;
export const ENRICH_GIVE_UP_AFTER = 3;
const HOUR = 60 * 60_000;
const ALARM_PATHS = 20;
const ERROR_CHARS = 400;

/**
 * A provider error as the state file keeps it: its first line and its last error line. A provider
 * CLI may echo its whole prompt (the page body) to stderr; that never goes into the state file.
 */
export function shortError(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const last = [...lines].reverse().find((line) => /error|fail|denied|refus|not supported|timed out/iu.test(line)) ?? "";
  return (last && last !== first ? `${first} … ${last}` : first).slice(0, ERROR_CHARS);
}

/** Enrich memory, seeded from the previous state file's `enrichQueue`. */
export function createEnrichMemory(previous) {
  const saved = previous?.enrichQueue ?? {};
  const pairs = (list) => (Array.isArray(list) ? list.filter((row) => Array.isArray(row) && typeof row[0] === "string") : []);
  return {
    pending: new Map(pairs(saved.pending).map(([path, attempts]) => [path, Number(attempts) || 0])),
    gaveUp: new Map(pairs(saved.gaveUp).map(([path, error]) => [path, String(error ?? "")])),
    dropped: Number(saved.dropped) || 0,
    calls: Array.isArray(saved.calls) ? saved.calls.filter(Number.isFinite) : [],
    retryAt: Number(saved.retryAt) || 0,
    seenHead: typeof saved.seenHead === "string" ? saved.seenHead : null,
    remoteSeen: typeof saved.remoteSeen === "string" ? saved.remoteSeen : null,
    held: Array.isArray(saved.held) ? saved.held.filter((path) => typeof path === "string") : [],
    lastRunAt: saved.lastRunAt ?? null,
    lastError: saved.lastError ?? null,
    lastFailed: Array.isArray(saved.lastFailed) ? saved.lastFailed : [],
    targetError: null, // judged anew every tick
    totals: { runs: 0, calls: 0, enriched: 0, ...(saved.totals ?? {}) },
  };
}

/** What the state file keeps of the enrich memory. */
export function persistEnrichMemory(state) {
  return {
    pending: [...state.pending],
    gaveUp: [...state.gaveUp],
    dropped: state.dropped,
    calls: state.calls,
    retryAt: state.retryAt,
    seenHead: state.seenHead,
    remoteSeen: state.remoteSeen,
    held: state.held,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    lastFailed: state.lastFailed,
    totals: state.totals,
  };
}

/**
 * This tick's target resolver: `(treePath) => boolean` under the tree's declaration, read again
 * each tick (the declaration may change). Null while enrich is off, and — with `targetError` set,
 * which raises the alarm — when the declaration cannot be read or does not carry enrich: nothing
 * is queued by a rule the daemon could not read.
 */
export function enrichTargets(ctx, state) {
  state.targetError = null;
  if (!ctx.settings.enrichOnAutosave) return null;
  let profile;
  try {
    profile = resolveTreeContract(ctx.treeAbs);
  } catch (error) {
    state.targetError = shortError(error.message);
    return null;
  }
  if (!profile.enrich) {
    state.targetError = `the ${profile.id} contract of this tree does not carry enrich`;
    return null;
  }
  return (treePath) => isEnrichTargetPath(treePath, profile);
}

/**
 * Queue repo paths, except `skip`. Only a knowledge page of the tree enters (`isTarget`, from
 * enrichTargets); a path outside the tree or crossing a secret directory never does, and a page
 * whose path has a line break goes straight to the alarm. A path queued again starts over: fresh
 * attempts, out of the alarm, at the queue's end.
 */
function queuePaths(ctx, state, isTarget, repoPaths, skip = []) {
  if (!ctx.settings.enrichOnAutosave || !isTarget) return;
  const skipped = new Set(skip);
  for (const repoPath of repoPaths) {
    if (skipped.has(repoPath)) continue;
    const path = ctx.treePath(repoPath);
    if (path === null || crossesSecretDir(path) || !isTarget(path)) continue;
    if (/[\r\n]/u.test(path)) {
      // The run reads NUL-separated paths and refuses one with a line break; the alarm names it.
      state.pending.delete(path);
      state.gaveUp.set(path, "a path with a line break is not handed to the enrich run; rename the page");
      continue;
    }
    state.gaveUp.delete(path);
    state.pending.delete(path);
    state.pending.set(path, 0);
  }
  while (state.pending.size > ENRICH_PENDING_MAX) {
    state.pending.delete(state.pending.keys().next().value);
    state.dropped += 1;
  }
}

/**
 * Queue the knowledge pages of an autosave commit (`committed` of autosave()), except `skip` (repo
 * paths the enrich run itself wrote).
 */
export function noteCollected(ctx, state, isTarget, committed, { skip = [] } = {}) {
  if (committed?.paths?.length) queuePaths(ctx, state, isTarget, committed.paths, skip);
}

/**
 * Of `candidates` (commits on `main` no tick has judged), the ones that came from the server: the
 * oldest state of `origin/main` that holds one, walking its reflog back from the newest, was
 * written by a fetch (a daemon's, or a person's `git fetch`/`git pull`), not by this clone's push.
 * `bounds` (`^sha` arguments) leave out what an earlier tick judged. A clone whose `origin/main`
 * has no reflog says nothing here, and every candidate counts as this clone's.
 */
export async function fromServer(ctx, candidates, bounds) {
  const found = new Set();
  if (candidates.length === 0) return found;
  const reflog = await git(["reflog", "show", "--format=%H%x00%gs", "refs/remotes/origin/main", "--"], { cwd: ctx.repo, allowFail: true });
  if (reflog.code !== 0) return found;
  const pending = new Set(candidates);
  const firstBy = new Map(); // candidate -> the message of the oldest state seen so far that holds it
  for (const line of reflog.stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    const [state, message] = line.split("\0");
    const held = await git(["rev-list", state, ...bounds, "--"], { cwd: ctx.repo, allowFail: true });
    const holds = held.code === 0 ? held.stdout.toString("utf8").split("\n").filter((sha) => pending.has(sha)) : [];
    if (holds.length === 0) break; // older states hold none of them either
    for (const sha of holds) firstBy.set(sha, message);
  }
  for (const [sha, message] of firstBy) if (message !== "update by push") found.add(sha);
  return found;
}

/**
 * The paths added or changed by the commits others made in this clone since `seenHead`, oldest
 * first: on `main`, not a merge, not the daemon's own, not from the server (fromServer, and
 * whatever is under `remoteSeen`, else under `origin/main` as it stands). Returns
 * `{ head, commits, paths }`; nothing when neither bound exists (see the header). A bound that is
 * gone (a rewritten branch, a pruned object) bounds nothing.
 */
export async function directCommits(ctx, { seenHead = null, remoteSeen = null } = {}) {
  const head = await revParse(ctx.repo, "refs/heads/main");
  if (!head || head === seenHead) return { head, commits: 0, paths: [] };
  const seen = seenHead ? await revParse(ctx.repo, seenHead) : null;
  const remote = (remoteSeen ? await revParse(ctx.repo, remoteSeen) : null) ?? (await revParse(ctx.repo, "refs/remotes/origin/main"));
  const known = [seen, remote].filter(Boolean).map((sha) => `^${sha}`);
  if (known.length === 0) return { head, commits: 0, paths: [] };
  // One record per commit: \x01 <sha> \x02 <subject> \x03, then its paths, NUL-terminated.
  const log = await git(
    ["log", "--reverse", "--no-merges", "--no-renames", "--diff-filter=AM", "--name-only", "-z", "--format=%x01%H%x02%s%x03", head, ...known],
    { cwd: ctx.repo },
  );
  const records = log.stdout.toString("utf8").split("\x01").slice(1).map((record) => ({
    sha: record.slice(0, record.indexOf("\x02")),
    subject: record.slice(record.indexOf("\x02") + 1, record.indexOf("\x03")),
    paths: record.slice(record.indexOf("\x03") + 1).split("\0").map((path) => path.replace(/^\n+/u, "")).filter(Boolean),
  })).filter((record) => !record.subject.startsWith(DAEMON_SUBJECT));
  const pulled = await fromServer(ctx, records.map((record) => record.sha), known);
  const own = records.filter((record) => !pulled.has(record.sha));
  return { head, commits: own.length, paths: own.flatMap((record) => record.paths) };
}

/**
 * Queue the knowledge pages of the commits others made in this clone since the last tick looked.
 * The commits are judged every tick; while there is no resolver (`isTarget` null: the tree could
 * not be judged) their paths are held and queued with the next resolver. While enrich is off both
 * bounds and the held paths are forgotten, so turning it on starts from what the server does not
 * have yet.
 */
export async function noteDirectCommits(ctx, state, isTarget, { log = () => {} } = {}) {
  if (!ctx.settings.enrichOnAutosave) {
    state.seenHead = null;
    state.remoteSeen = null;
    state.held = [];
    return;
  }
  const found = await directCommits(ctx, state);
  state.seenHead = found.head;
  if (!isTarget) {
    const held = new Set(state.held);
    for (const repoPath of found.paths) {
      const path = ctx.treePath(repoPath);
      if (path !== null && !crossesSecretDir(path)) held.add(repoPath);
    }
    state.held = [...held];
    if (state.held.length > ENRICH_PENDING_MAX) state.dropped += state.held.splice(0, state.held.length - ENRICH_PENDING_MAX).length;
    if (found.commits) log({ event: "enrich-commits", commits: found.commits, held: state.held.length });
    return;
  }
  const before = state.pending.size + state.dropped;
  const released = state.held.length;
  queuePaths(ctx, state, isTarget, [...state.held, ...found.paths]);
  state.held = [];
  if (found.commits || released) {
    log({ event: "enrich-commits", commits: found.commits, ...(released ? { released } : {}), queued: state.pending.size + state.dropped - before, pending: state.pending.size });
  }
}

/**
 * After a fetch, before the push: `origin/main` holds what the server has — other computers'
 * commits, and of this clone's only those an earlier push took there, which a tick has judged.
 */
export async function noteFetched(ctx, state) {
  if (!ctx.settings.enrichOnAutosave) return;
  state.remoteSeen = await revParse(ctx.repo, "refs/remotes/origin/main");
}

/** The enrich run: the queued paths on stdin, NUL-separated. */
export async function runEnrich(ctx, { paths, limit }) {
  const run = await runVaultSyncJson(
    ctx,
    ["--enrich", "--enrich-limit", String(limit), "--enrich-paths-from", "-"],
    `${paths.join("\0")}\0`,
  );
  return readSyncRun(ctx, run, { enrichedWritten: true });
}

/** Tree paths with uncommitted changes (the work tree scan, as autosave reads it). */
export async function uncommittedPaths(ctx) {
  const dirty = new Set();
  for (const entry of await scanWorktree(ctx.repo)) {
    const path = ctx.treePath(entry.path);
    if (path !== null) dirty.add(path);
  }
  return dirty;
}

/**
 * The enrich step of one tick. `run` is the enrich run and `uncommitted` the scan of pages still
 * being written (both injected in tests); `isTarget` is this tick's resolver (enrichTargets).
 * Returns null when nothing ran, else `{ enrich, saved }`: the run's enrich report (null when it
 * printed none) and the autosave pass that committed what it wrote (null when it wrote nothing).
 */
export async function enrichStep(ctx, mem, { clock = Date.now, log = () => {}, run = runEnrich, uncommitted = uncommittedPaths, isTarget = null } = {}) {
  const state = mem.enrich;
  if (!ctx.settings.enrichOnAutosave) {
    state.pending.clear();
    state.gaveUp.clear();
    state.lastError = null;
    state.lastFailed = [];
    state.retryAt = 0;
    return null;
  }
  if (!isTarget || state.pending.size === 0) return null;
  const now = clock();
  if (now < state.retryAt) return null;
  state.calls = state.calls.filter((at) => now - at < HOUR);
  const limit = Math.floor(Math.min(ctx.settings.enrichPerTick, ctx.settings.enrichPerHour - state.calls.length));
  if (limit <= 0) return null; // over a cap: the queue waits for the next tick

  const dirty = await uncommitted(ctx);
  const paths = [...state.pending.keys()].filter((path) => !dirty.has(path));
  if (paths.length === 0) return null; // every queued page is still being written

  const derived = await run(ctx, { paths, limit });
  const doneAt = clock();
  state.totals.runs += 1;
  state.lastRunAt = isoLocal(doneAt);
  const enrich = derived.report?.enrich ?? null;
  if (!enrich) {
    // No report: nothing was described (no provider, a crash). The queue stays; the alarm says why.
    state.lastError = shortError(derived.preSync.line) || `vault sync --enrich exited ${derived.preSync.code}`;
    state.lastFailed = [];
    state.retryAt = doneAt + ctx.settings.enrichRetryMs;
    log({ event: "enrich-failed", message: state.lastError });
    return { enrich: null, saved: null };
  }

  for (let i = 0; i < (enrich.modelCalls ?? 0); i += 1) state.calls.push(doneAt);
  const wrote = enrich.enriched.filter((e) => e.wrote);
  state.totals.calls += enrich.modelCalls ?? 0;
  state.totals.enriched += wrote.length;
  for (const e of [...wrote, ...(enrich.raced ?? [])]) state.pending.delete(e.path);
  for (const path of enrich.skipped ?? []) state.pending.delete(path);
  for (const e of enrich.excluded ?? []) state.pending.delete(e.path);
  const failed = enrich.failed.map((f) => ({ path: f.path, error: shortError(f.error) }));
  for (const failure of failed) {
    const attempts = (state.pending.get(failure.path) ?? 0) + 1;
    if (attempts >= ENRICH_GIVE_UP_AFTER) {
      state.pending.delete(failure.path);
      state.gaveUp.set(failure.path, failure.error);
    } else {
      state.pending.set(failure.path, attempts);
    }
  }
  state.lastFailed = failed.slice(0, ALARM_PATHS);
  state.lastError = failed.length ? `${failed.length} page(s) not described: ${failed[0].error}`.slice(0, ERROR_CHARS) : null;
  state.retryAt = enrich.failed.length ? doneAt + ctx.settings.enrichRetryMs : 0;
  log({ event: "enrich", calls: enrich.modelCalls ?? 0, enriched: wrote.length, failed: enrich.failed.length, raced: enrich.raced?.length ?? 0, pending: state.pending.size });

  if (derived.written.length === 0) return { enrich, saved: null };
  const saved = await autosave(ctx, mem.autosave, { clock, derived, enriched: wrote.length, log });
  noteCollected(ctx, state, isTarget, saved.committed, { skip: derived.written });
  return { enrich, saved };
}

/** The `enrich` alarm: the tree could not be judged, the last run failed, or a page was given up on. */
export function enrichAlert(ctx, state, { now = Date.now() } = {}) {
  if (!ctx.settings.enrichOnAutosave) return { active: false, on: false };
  const recent = state.calls.filter((at) => now - at < HOUR).length;
  const failed = [
    ...state.lastFailed.map((f) => ({ path: f.path, error: f.error })),
    ...[...state.gaveUp].map(([path, error]) => ({ path, error, gaveUp: true })),
  ];
  const lastError = state.targetError ?? state.lastError;
  return {
    active: Boolean(lastError) || state.gaveUp.size > 0,
    on: true,
    level: "yellow",
    pending: state.pending.size,
    held: state.held.length,
    dropped: state.dropped,
    callsLastHour: recent,
    perTick: ctx.settings.enrichPerTick,
    perHour: ctx.settings.enrichPerHour,
    lastRunAt: state.lastRunAt,
    lastError,
    nextRetryAt: state.retryAt > now ? isoLocal(state.retryAt) : null,
    failed: failed.slice(0, ALARM_PATHS),
    gaveUp: state.gaveUp.size,
    totals: state.totals,
  };
}

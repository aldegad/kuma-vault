// `vault syncd` — the write-behind sync daemon of one clone (design 2.2).
//
//   tick: 0 read state (stale git locks)  1 AUTOSAVE  2 FETCH  3 INTEGRATE  4 PUSH  5 STATUS   (hourly: ignored scan, EVICT)
//
// Credential directories are tightened to 0600/0700 right after a fast-forward or merge wrote
// them, and again at STATUS (with this tick's untracked paths), which raises `credentialModes`
// when one stays loose.
//
// Woken by: commits (fs watch on refs/heads and logs/HEAD, 2 s debounce), the server's events
// long-poll, a 60 s timer, and SIGUSR1 (`vault sync now`). Every step is recomputed from git, so
// a restart or a kill loses nothing: the next tick starts from 0. One daemon per clone
// (`.git/vault-syncd.lock`). Network steps back off 2 s -> 5 s -> 15 s -> 60 s -> 5 min after a
// failure and reset on the first success; autosave keeps running while offline.
//
// One clock judges the whole tick: `judgeClock(now)` — the injected start plus the real time
// since. Every quiet rule, age, window and backoff reads it at the moment it judges, after the
// scan it judges; nothing in a tick judges by its start time, which a slow fetch leaves minutes
// behind the mtimes of files written meanwhile.

import { existsSync, watch } from "node:fs";
import { join } from "node:path";

import { autosave, classifyEntries } from "./autosave.mjs";
import { blobEvict, cachedObjects } from "./blob.mjs";
import {
  computeGrowth, computeIgnoredOutside, computeRejectResidue, computeUncollected, recordGrowth, rejectMatcher, scanIgnored,
} from "./alerts.mjs";
import { openConflicts } from "./conflicts.mjs";
import { credentialModesAlert, keepCredentialModes } from "./credential-modes.mjs";
import { BACKOFF_MS } from "./context.mjs";
import { checkGitVersion, git, revParse } from "./git.mjs";
import { fetchOrigin, integrate, isoLocal, pushMain } from "./integrate.mjs";
import { createRemoteApi } from "./remote-api.mjs";
import { scanWorktree } from "./scan.mjs";
import { clearStaleLocks } from "./stale-locks.mjs";
import { acquireLock, isPaused, readStatus, writeStatus } from "./state-files.mjs";

const SERVER_INFO_MS = 5 * 60_000;
const MAX_PUSH_ROUNDS = 5;

async function aheadBehind(ctx) {
  const L = await revParse(ctx.repo, "refs/heads/main");
  const R = await revParse(ctx.repo, "refs/remotes/origin/main");
  if (!L) return { ahead: 0, behind: 0, oldestUnpushedMs: null, L, R };
  const range = R ? `${R}..${L}` : L;
  const log = await git(["log", "--format=%ct", range], { cwd: ctx.repo });
  const times = log.stdout.toString("utf8").split("\n").filter(Boolean).map((t) => Number(t) * 1000);
  let behind = 0;
  if (R) {
    const count = await git(["rev-list", "--count", `${L}..${R}`], { cwd: ctx.repo });
    behind = Number(count.stdout.toString("utf8").trim());
  }
  return { ahead: times.length, behind, oldestUnpushedMs: times.length ? Math.min(...times) : null, L, R };
}

/** The judging clock of one tick: `now` (injected; real time by default) plus the real time since. */
export function judgeClock(now = Date.now()) {
  const offset = now - Date.now();
  return () => Date.now() + offset;
}

/** Fresh daemon memory, seeded from the previous state file so alarm onsets survive restarts. */
export function createMemory(ctx) {
  const previous = readStatus(ctx.statusPath);
  return {
    autosave: { dirtySince: new Map(), gateBlockedAt: null, gateMessage: null },
    previous,
    growthWindow: Array.isArray(previous?.growthWindow) ? previous.growthWindow : [],
    failures: 0,
    backoffUntil: 0,
    nonff: 0,
    tickSeq: previous?.tickSeq ?? 0,
    eventsSeq: previous?.server?.eventsSeq ?? 0,
    ignored: null,
    ignoredAt: 0,
    evictAt: 0,
    serverInfoAt: 0,
    server: previous?.server ?? {},
    lastSyncAt: previous?.lastSyncAt ?? null,
    lastError: null,
    lastEvict: previous?.lastEvict ?? null,
    credentialRoots: null,
  };
}

/** Tighten the clone's credential modes; the alarm, never a thrown tick. */
async function tightenCredentialModes(ctx, mem, { paths = [], now, log }) {
  try {
    const { report, cache } = await keepCredentialModes(ctx.repo, { fix: true, paths, cache: mem.credentialRoots });
    mem.credentialRoots = cache;
    if (report.fixedCount) log({ event: "credential-modes", fixed: report.fixedCount, paths: report.fixed.slice(0, 20).map((f) => f.path) });
    return credentialModesAlert(report, { now });
  } catch (error) {
    mem.credentialRoots = null;
    log({ event: "credential-modes-failed", message: error.message });
    return credentialModesAlert(null, { now, error });
  }
}

/**
 * One tick. `force` (vault sync now) retries a blocked autosave and ignores the backoff.
 * Returns `{ ok, again }`: `again` asks for an immediate follow-up tick (non-ff push).
 */
export async function runTick(ctx, mem, { now = Date.now(), force = false, api = createRemoteApi(ctx), log = () => {} } = {}) {
  const judgeNow = judgeClock(now);
  mem.tickSeq += 1;
  const status = {
    store: ctx.store,
    repo: ctx.repo,
    host: ctx.host,
    pid: process.pid,
    tickSeq: mem.tickSeq,
    tickAt: isoLocal(judgeNow()),
    state: "ok",
    paused: false,
  };
  let failed = false;
  let again = false;
  let lastError = null;
  let autosaveBlocked = null;
  let integration = null;
  const reject = rejectMatcher(ctx);

  // 0 a lock a killed git left behind would fail every step below
  clearStaleLocks(ctx, { clock: judgeNow, log });

  if (isPaused(ctx.pausePath)) {
    status.state = "paused";
    status.paused = true;
  } else {
    // 1 AUTOSAVE
    const saved = await autosave(ctx, mem.autosave, { clock: judgeNow, force });
    const committed = saved.committed;
    mem.growthWindow = recordGrowth(ctx, mem.growthWindow, committed, { now: judgeNow() });
    if (committed) log({ event: "autosave", commit: committed.commit, files: committed.files, lfsBytes: committed.lfsBytes });
    if (saved.blocked) autosaveBlocked = `자동 저장 막힘: ${saved.blocked.message}`;

    // 2-4 FETCH, INTEGRATE, PUSH
    const network = force || judgeNow() >= mem.backoffUntil;
    if (network) {
      const fetched = await fetchOrigin(ctx);
      if (!fetched.ok) {
        failed = true;
        status.state = fetched.kind === "offline" ? "offline" : "blocked";
        lastError = fetched.kind === "auth" ? `인증 실패: ${fetched.message}` : fetched.message;
      } else {
        integration = await integrate(ctx, { clock: judgeNow });
        if (integration.records?.length) log({ event: "conflicts", count: integration.records.length, ids: integration.records.map((r) => r.id) });
        if (integration.action === "merged" || integration.action === "ff") {
          log({ event: integration.action, commit: integration.commit });
          await tightenCredentialModes(ctx, mem, { now: judgeNow(), log }); // the checkout wrote them by the umask
          // A merge commit never passed the gate, and what came in may change folder indexes:
          // regenerate the tracked derivations now, so the next agent commit is not refused.
          const regen = await autosave(ctx, mem.autosave, { clock: judgeNow, force: true, regenerate: true });
          mem.growthWindow = recordGrowth(ctx, mem.growthWindow, regen.committed, { now: judgeNow() });
          if (regen.committed) log({ event: "regenerated", commit: regen.committed.commit, files: regen.committed.files });
          if (regen.blocked) autosaveBlocked = `자동 저장 막힘: ${regen.blocked.message}`;
        }
        const ab = await aheadBehind(ctx);
        if (ab.ahead > 0 && integration.action !== "wait-dirty" && integration.action !== "retry") {
          const pushed = await pushMain(ctx);
          if (pushed.ok) {
            mem.nonff = 0;
            log({ event: "pushed", head: await revParse(ctx.repo, "refs/heads/main") });
            await git(["fetch", "--quiet", "--no-tags", "origin"], { cwd: ctx.repo, allowFail: true });
          } else if (pushed.kind === "nonff") {
            mem.nonff += 1;
            if (mem.nonff >= MAX_PUSH_ROUNDS) {
              failed = true;
              lastError = `push 가 ${mem.nonff}번 연속 밀렸다(서버가 계속 앞서 감)`;
            } else {
              again = true;
            }
          } else {
            failed = true;
            status.state = pushed.kind === "offline" ? "offline" : "blocked";
            lastError = pushed.message;
          }
        } else if (integration.action === "retry") {
          again = true;
        }
        if (integration.action === "wait-dirty") lastError = "통합 대기: 받을 판이 작업 중인 파일과 겹친다(조용해지면 자동 저장 뒤 충돌 처리)";
      }
    }
  }

  // 5 STATUS
  const ab = await aheadBehind(ctx);
  const entries = await scanWorktree(ctx.repo);
  const judgedAt = judgeNow(); // after the scan: no mtime in `entries` is ahead of it by a tick's length
  const prevAlerts = mem.previous?.alerts ?? {};
  const uncollected = computeUncollected(ctx, entries, { now: judgedAt, previous: prevAlerts.uncollected, memory: mem.autosave, reject });
  if (!mem.ignored || judgedAt - mem.ignoredAt >= ctx.settings.ignoredScanMs || force) {
    mem.ignored = await scanIgnored(ctx, { reject });
    mem.ignoredAt = judgeNow();
  }
  const held = classifyEntries(ctx, entries, { now: judgedAt, dirtySince: mem.autosave.dirtySince, reject }).residue;
  const alertsAt = judgeNow(); // after the ignored scan, whose mtimes the residue age reads
  mem.growthWindow = recordGrowth(ctx, mem.growthWindow, null, { now: alertsAt }); // drop what left the window
  const credentialAlert = await tightenCredentialModes(ctx, mem, { paths: entries.filter((e) => !e.tracked).map((e) => e.path), now: judgeNow(), log });
  const alerts = {
    uncollected,
    ignoredOutside: computeIgnoredOutside(ctx, mem.ignored.outside),
    rejectResidue: computeRejectResidue(ctx, mem.ignored.residue, held, { now: alertsAt }),
    growth: computeGrowth(ctx, mem.growthWindow, prevAlerts.growth, { now: alertsAt }),
    credentialModes: credentialAlert,
  };

  if (!isPaused(ctx.pausePath) && ctx.apiBase && (force || judgeNow() - mem.serverInfoAt >= SERVER_INFO_MS) && !failed) {
    try {
      const [health, backup] = await Promise.all([api.health(), api.backupStatus().catch(() => null)]);
      mem.server = {
        ...mem.server,
        diskFreeGB: health?.diskFreeGB ?? null,
        diskAlert: health?.diskAlert ?? null,
        growthAlert: health?.growthAlert ?? null,
        lastBackupAt: backup?.lastBackupAt ?? null,
      };
      mem.serverInfoAt = judgeNow();
    } catch (error) {
      log({ event: "server-info-failed", message: error.message });
    }
  }

  if (!isPaused(ctx.pausePath) && judgeNow() - mem.evictAt >= ctx.settings.evictMs && !failed && ctx.apiBase) {
    mem.evictAt = judgeNow();
    try {
      const result = await blobEvict(ctx, api, { clock: judgeNow });
      if (result.evicted.length) log({ event: "evicted", count: result.evicted.length, bytes: result.evicted.reduce((s, e) => s + e.bytes, 0) });
      mem.lastEvict = { at: isoLocal(judgeNow()), evicted: result.evicted.length, cacheBytes: result.cacheBytes };
    } catch (error) {
      log({ event: "evict-failed", message: error.message });
    }
  }

  const conflicts = openConflicts(ctx);
  if (status.state === "ok") {
    if (autosaveBlocked) status.state = "blocked";
    else if (conflicts.length) status.state = "conflict";
    else if (ab.ahead > 0 || integration?.action === "wait-dirty" || again) status.state = "syncing";
  }
  const endAt = judgeNow();
  if (!failed && !status.paused && ab.ahead === 0) mem.lastSyncAt = isoLocal(endAt);
  mem.lastError = lastError;
  Object.assign(status, {
    ahead: ab.ahead,
    behind: ab.behind,
    head: ab.L,
    oldestUnpushedAt: ab.oldestUnpushedMs ? isoLocal(ab.oldestUnpushedMs) : null,
    lastSyncAt: mem.lastSyncAt,
    lastError,
    openConflicts: conflicts.length,
    conflicts: conflicts.slice(0, 50).map((c) => ({ id: c.id, path: c.path, class: c.class, copy: c.copy })),
    autosaveBlocked,
    lfsCache: { bytes: cachedObjects(ctx).reduce((s, o) => s + o.size, 0), limitBytes: ctx.settings.lfsCacheMaxBytes },
    lastEvict: mem.lastEvict,
    alerts,
    growthWindow: mem.growthWindow,
    server: { ...mem.server, head: ab.R, indexedHead: mem.server.indexedHead ?? null, eventsSeq: mem.eventsSeq },
    backoffUntil: mem.backoffUntil > endAt ? isoLocal(mem.backoffUntil) : null,
  });

  if (failed) {
    const step = BACKOFF_MS[Math.min(mem.failures, BACKOFF_MS.length - 1)];
    mem.failures += 1;
    mem.backoffUntil = endAt + step;
    status.backoffUntil = isoLocal(mem.backoffUntil);
  } else if (!status.paused) {
    mem.failures = 0;
    mem.backoffUntil = 0;
  }
  writeStatus(ctx.statusPath, status);
  mem.previous = status;
  return { ok: !failed, again, status };
}

/**
 * Run the daemon until SIGTERM/SIGINT. Resolves after a clean stop.
 */
export async function runDaemon(ctx, { log = (row) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`) } = {}) {
  await checkGitVersion();
  const lock = acquireLock(ctx.lockPath, { log });
  const mem = createMemory(ctx);
  const api = createRemoteApi(ctx);
  log({ event: "start", store: ctx.store, repo: ctx.repo, pid: process.pid });

  let stopping = false;
  let running = false;
  let wanted = false;
  let wantForce = false;
  let timer = null;
  let debounce = null;
  const watchers = [];
  const poll = new AbortController();

  const schedule = (delayMs) => {
    if (stopping) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(kick, Math.max(0, delayMs));
  };

  async function kick() {
    timer = null;
    if (running) {
      wanted = true;
      return;
    }
    running = true;
    let next = ctx.settings.timerMs;
    do {
      wanted = false;
      const force = wantForce;
      wantForce = false;
      try {
        const result = await runTick(ctx, mem, { force, api, log });
        if (result.again) wanted = true;
        if (!result.ok) {
          log({ event: "tick-failed", state: result.status.state, error: result.status.lastError, backoffUntil: result.status.backoffUntil });
          next = Math.min(ctx.settings.timerMs, Math.max(0, mem.backoffUntil - Date.now()));
        }
      } catch (error) {
        mem.failures += 1;
        mem.backoffUntil = Date.now() + BACKOFF_MS[Math.min(mem.failures - 1, BACKOFF_MS.length - 1)];
        log({ event: "tick-error", message: error.stack ?? error.message });
        try {
          writeStatus(ctx.statusPath, { ...(mem.previous ?? {}), store: ctx.store, pid: process.pid, tickSeq: (mem.tickSeq += 1), state: "blocked", lastError: `데몬 오류: ${error.message}`.slice(0, 400), tickAt: isoLocal(Date.now()) });
        } catch {
          // the state file itself failed; the log line above is the record
        }
      }
    } while (wanted && !stopping);
    running = false;
    if (!stopping) schedule(next);
  }

  const wake = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      const wait = Math.max(0, mem.backoffUntil - Date.now());
      if (running) wanted = true;
      else schedule(wait);
    }, ctx.settings.debounceMs);
  };

  for (const target of [join(ctx.gitDir, "refs", "heads"), join(ctx.gitDir, "logs", "HEAD")]) {
    if (!existsSync(target)) continue;
    try {
      watchers.push(watch(target, { persistent: false }, wake));
    } catch (error) {
      log({ event: "watch-failed", target, message: error.message });
    }
  }

  async function longPoll() {
    let failures = 0;
    while (!stopping && ctx.apiBase) {
      try {
        const result = await api.events(mem.eventsSeq, { signal: poll.signal });
        failures = 0;
        if (Array.isArray(result?.events) && result.events.length > 0) {
          mem.eventsSeq = result.lastSeq ?? mem.eventsSeq;
          if (running) wanted = true;
          else schedule(0);
        } else if (typeof result?.lastSeq === "number" && result.lastSeq < mem.eventsSeq) {
          mem.eventsSeq = result.lastSeq; // the server's log restarted
        }
      } catch (error) {
        if (stopping) break;
        failures += 1;
        await new Promise((r) => setTimeout(r, Math.min(60_000, 5_000 * failures)));
      }
    }
  }

  const onSignal = (signal) => {
    if (signal === "SIGUSR1") {
      wantForce = true;
      if (running) wanted = true;
      else schedule(0);
      return;
    }
    if (stopping) return;
    stopping = true;
    log({ event: "stopping", signal });
    poll.abort();
    if (timer) clearTimeout(timer);
    if (debounce) clearTimeout(debounce);
    for (const w of watchers) w.close();
  };
  process.on("SIGUSR1", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const pollDone = longPoll();
  schedule(0);
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (stopping && !running) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
  await pollDone.catch(() => {});
  lock.release();
  log({ event: "stopped" });
}

// Mac backup routine retirement judge.
//
// The Mac routine keeps backing up the local clone until nothing exists only on the Mac. It
// retires when all four conditions hold, judged from records, never from a person's say-so:
//
//   1. server-backups  the server's last 3 backup runs are consecutive successes and the
//                      latest restore drill passed on one of those snapshots, with text and CAS
//                      samples both non-empty, at their floors and all matched
//   2. alert-path      a fake `uncollected` alert was injected and both the red chip and the
//                      owner's message were observed (record written by the alert-path probe)
//   3. clean-72h       over the last 72 hours: one sync-status sample in every hour, each with
//                      uncollected 0 and ignoredOutside.lfsExt 0; and every sample taken at a Mac
//                      backup (kind "mac-backup", at least one per day) has ahead 0
//   4. sub-gitignores  no sub-directory .gitignore with an active rule is left in the clone
//                      (those places move to binaries.reject or are dropped)
//
// After retirement the routine stays registered but disabled. If `uncollected` has been red
// (1+ path for over an hour) for REENABLE_AFTER_RED_MS more, the routine is switched back on.

export const WINDOW_MS = 72 * 3_600_000;
export const HOUR_MS = 3_600_000;
export const RED_AFTER_MS = HOUR_MS; // design 2.1: 1+ uncollected path for over an hour = red
export const REENABLE_AFTER_RED_MS = 6 * HOUR_MS; // design 3.4: not fixed within 6 hours -> back on

function cond(id, ok, detail) {
  return { id, ok, detail };
}

export function judgeServerBackups(backupStatus) {
  const runs = Array.isArray(backupStatus?.runs) ? backupStatus.runs : [];
  const last3 = runs.slice(-3);
  if (last3.length < 3) return cond("server-backups", false, `${last3.length} server backup run(s) recorded, need 3`);
  const failed = last3.filter((r) => r.result !== "ok");
  if (failed.length) return cond("server-backups", false, `last 3 runs not all ok (${last3.map((r) => r.result).join(",")})`);
  const drill = backupStatus.lastDrill;
  if (!drill || drill.result !== "ok") return cond("server-backups", false, `restore drill ${drill ? drill.result : "never ran"}${drill?.error ? `: ${drill.error}` : ""}`);
  // a drill counts only when it actually compared something, as much as its floor asked for
  for (const kind of ["text", "cas"]) {
    const s = drill[kind];
    if (!s || !Number.isInteger(s.required) || !Number.isInteger(s.sampled) || !Number.isInteger(s.matched)) return cond("server-backups", false, `drill ${kind} record lacks required/sampled/matched (a drill from before the sample floors)`);
    if (s.sampled === 0) return cond("server-backups", false, `drill sampled no ${kind} (live ${s.live ?? "?"}, listed ${s.available ?? "?"})`);
    if (s.sampled < s.required) return cond("server-backups", false, `drill ${kind} sample ${s.sampled} below its floor ${s.required}`);
    if (s.matched !== s.sampled || (s.mismatches?.length ?? 0) > 0) return cond("server-backups", false, `drill ${kind} ${s.matched}/${s.sampled} matched`);
  }
  const snaps = new Set(last3.map((r) => r.snapshotId));
  if (!snaps.has(drill.snapshotId)) return cond("server-backups", false, `latest drill (${drill.snapshotId}) is not on one of the last 3 snapshots`);
  return cond("server-backups", true, `3 consecutive ok (${[...snaps].join(",")}), drill ok on ${drill.snapshotId} (text ${drill.text?.matched}/${drill.text?.sampled}, cas ${drill.cas?.matched}/${drill.cas?.sampled})`);
}

export function judgeAlertPath(probe) {
  if (!probe) return cond("alert-path", false, "no alert-path probe record (the alert-path probe injects a fake uncollected and records it)");
  if (probe.injected !== "uncollected") return cond("alert-path", false, `probe injected ${probe.injected ?? "nothing"}, need uncollected`);
  if (probe.chipRed !== true) return cond("alert-path", false, "probe did not observe the red chip");
  if (!probe.ownerMessage?.deliveredAt) return cond("alert-path", false, "probe did not observe the owner's message arriving");
  return cond("alert-path", true, `probe ${probe.at}: chip red, message delivered ${probe.ownerMessage.deliveredAt}`);
}

export function judgeClean72h(samples, now) {
  const end = now.getTime();
  const start = end - WINDOW_MS;
  const inWindow = samples.filter((s) => {
    const t = Date.parse(s.ts);
    return t > start && t <= end;
  });
  const hours = new Set(inWindow.map((s) => Math.floor((Date.parse(s.ts) - start - 1) / HOUR_MS)));
  const missing = [];
  for (let h = 0; h < 72; h += 1) if (!hours.has(h)) missing.push(h);
  if (missing.length) {
    const first = new Date(start + missing[0] * HOUR_MS).toISOString();
    return cond("clean-72h", false, `${missing.length} of 72 hours have no sample (first gap from ${first})`);
  }
  const dirty = inWindow.filter((s) => s.uncollected !== 0 || s.ignoredOutsideLfsExt !== 0);
  if (dirty.length) return cond("clean-72h", false, `${dirty.length} sample(s) with uncollected or ignoredOutside.lfsExt > 0 (first ${dirty[0].ts})`);
  const backups = inWindow.filter((s) => s.kind === "mac-backup");
  const days = new Set(backups.map((s) => Math.floor((Date.parse(s.ts) - start - 1) / (24 * HOUR_MS))));
  if (days.size < 3) return cond("clean-72h", false, `Mac backup samples on ${days.size} of 3 days`);
  const ahead = backups.filter((s) => s.ahead !== 0);
  if (ahead.length) return cond("clean-72h", false, `${ahead.length} Mac backup sample(s) with unpushed commits (first ${ahead[0].ts}, ahead ${ahead[0].ahead})`);
  return cond("clean-72h", true, `${inWindow.length} samples over 72 hours, all clean; ${backups.length} Mac backup samples with ahead 0`);
}

export function judgeSubGitignores(paths) {
  if (!Array.isArray(paths)) return cond("sub-gitignores", false, "sub-directory .gitignore list unavailable");
  if (paths.length) return cond("sub-gitignores", false, `${paths.length} sub-directory .gitignore with rules left: ${paths.slice(0, 5).join(", ")}`);
  return cond("sub-gitignores", true, "no sub-directory .gitignore with rules");
}

/** How long `uncollected` has been red at `now` (0 when it is not red). */
export function redDurationMs(syncStatus, now) {
  const u = syncStatus?.alerts?.uncollected;
  if (!u || !(u.count > 0) || !u.since) return 0;
  const redSince = Date.parse(u.since) + RED_AFTER_MS;
  return Math.max(0, now.getTime() - redSince);
}

/**
 * The decision for one tick. `routineEnabled` is the routine's current state; `retired` says
 * whether the last decision retired it (a routine switched off by hand is not "retired").
 * Returns { action, conditions, ... } with action one of:
 *   keep-running | retire | stay-retired | reenable
 */
export function decide({ now, routineEnabled, retired, backupStatus, alertProbe, samples, subGitignores, syncStatus }) {
  const conditions = [
    judgeServerBackups(backupStatus),
    judgeAlertPath(alertProbe),
    judgeClean72h(samples ?? [], now),
    judgeSubGitignores(subGitignores),
  ];
  const allMet = conditions.every((c) => c.ok);
  const red = redDurationMs(syncStatus, now);
  if (retired && !routineEnabled) {
    if (red >= REENABLE_AFTER_RED_MS) return { action: "reenable", reason: `uncollected red for ${Math.round(red / 60_000)} min (>= 6 h)`, conditions, at: now.toISOString() };
    return { action: "stay-retired", reason: red ? `uncollected red for ${Math.round(red / 60_000)} min (< 6 h)` : "retired, no red alert", conditions, at: now.toISOString() };
  }
  if (allMet && routineEnabled) return { action: "retire", reason: "all four conditions met", conditions, at: now.toISOString() };
  return { action: "keep-running", reason: allMet ? "conditions met but the routine is not enabled (switched off by hand?)" : conditions.filter((c) => !c.ok).map((c) => c.id).join(", "), conditions, at: now.toISOString() };
}

/** One sample line from the sync daemon's status file (design 2.6). */
export function sampleFromSyncStatus(status, { kind = "hourly", now = new Date() } = {}) {
  if (!status || typeof status !== "object") throw new Error("sync status is not an object");
  const u = status.alerts?.uncollected;
  const io = status.alerts?.ignoredOutside;
  if (typeof status.ahead !== "number" || typeof u?.count !== "number" || typeof io?.lfsExt !== "number") {
    throw new Error("sync status lacks ahead / alerts.uncollected.count / alerts.ignoredOutside.lfsExt");
  }
  return { ts: now.toISOString(), kind, state: status.state ?? null, ahead: status.ahead, uncollected: u.count, ignoredOutsideLfsExt: io.lfsExt };
}

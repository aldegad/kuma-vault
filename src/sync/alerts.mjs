// The four alarms of the state file (design 2.1): drift (what did not go up) and growth (too
// much went up).
//
//   uncollected     red     a not-ignored change older than 30 min still uncommitted, for 1 h
//                           (age from the last change as the autosave judges it: lastChangeMs)
//   ignoredOutside  yellow  ignored by a rule outside the root generated blocks (a nested
//                           .gitignore, .env): any LFS-extension file, or 100 MB in all
//   rejectResidue   yellow  binaries left in binaries.reject places: 5 GB, or one older than 7 days
//   growth          yellow  this clone's autosaves added 1 GB of LFS bytes or 500 binaries within
//                           the last 24 h — one burst or a trickle spread over many ticks
//
// Each alarm carries `active`; `vault sync status` exits 2 while any is active.

import { lstatSync } from "node:fs";
import { join } from "node:path";

import { isLfsPath } from "../server/lfs-paths.mjs";
import { classifyEntries, lastChangeMs, REASONS } from "./autosave.mjs";
import { rejectMatcher } from "./context.mjs";
import { looksBinaryFile } from "./scan.mjs";
import { git, splitNul } from "./git.mjs";
import { isoLocal } from "./integrate.mjs";

const MAX_PATHS = 200;

/** `uncollected` from the work-tree entries left after this tick's autosave; `now` read after their scan. */
export function computeUncollected(ctx, entries, { now, previous, memory, reject }) {
  const sorted = classifyEntries(ctx, entries, { now, dirtySince: memory.dirtySince, reject });
  const heldReason = new Map(sorted.held.map((h) => [h.entry.path, h.reason]));
  const residue = new Set(sorted.residue.map((e) => e.path));
  const old = entries.filter((e) => !residue.has(e.path) && now - lastChangeMs(ctx, e, now, memory.dirtySince) >= ctx.settings.uncollectedAgeMs);
  const paths = old.map((e) => {
    const held = heldReason.get(e.path);
    let reason = held ? REASONS[held] : REASONS.pending;
    if (!held && memory.gateBlockedAt) reason = `${REASONS.blocked}: ${memory.gateMessage}`;
    return { path: e.path, reason, bytes: e.size, mtime: isoLocal(e.mtimeMs) };
  });
  const count = paths.length;
  const sinceMs = count === 0 ? null : previous?.count > 0 && previous.sinceMs ? previous.sinceMs : now;
  return {
    count,
    since: sinceMs === null ? null : isoLocal(sinceMs),
    sinceMs,
    active: count > 0 && now - sinceMs >= ctx.settings.uncollectedAlarmMs,
    level: "red",
    paths: paths.slice(0, MAX_PATHS),
  };
}

/** Every ignored file, split into reject residue and ignored-outside (junk is expected and dropped). */
export async function scanIgnored(ctx, { reject = rejectMatcher(ctx) } = {}) {
  const result = await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], { cwd: ctx.repo });
  const residue = [];
  const outside = [];
  for (const path of splitNul(result.stdout)) {
    if (ctx.junk(path)) continue;
    let stat;
    try {
      stat = lstatSync(join(ctx.repo, path));
    } catch {
      continue;
    }
    const row = { path, bytes: stat.size, mtimeMs: stat.mtimeMs };
    if (reject.match(path)) {
      // reject places hold binaries back (server rule 7); text there is not residue
      if (looksBinaryFile(join(ctx.repo, path), path)) residue.push(row);
    } else {
      outside.push(row);
    }
  }
  // which rule ignores each outside file (first 50), for whoever fixes it
  const sample = outside.slice(0, 50);
  if (sample.length) {
    const rules = await git(["check-ignore", "-v", "-z", "--no-index", "--stdin"], {
      cwd: ctx.repo,
      input: `${sample.map((r) => r.path).join("\0")}\0`,
      allowFail: true,
    });
    const parts = splitNul(rules.stdout);
    for (let i = 0; i + 3 < parts.length; i += 4) {
      const row = sample.find((r) => r.path === parts[i + 3]);
      if (row) row.rule = `${parts[i]}:${parts[i + 1]}:${parts[i + 2]}`;
    }
  }
  return { residue, outside };
}

export function computeIgnoredOutside(ctx, outside) {
  const bytes = outside.reduce((s, r) => s + r.bytes, 0);
  const lfsExt = outside.filter((r) => isLfsPath(r.path)).length;
  return {
    count: outside.length,
    bytes,
    lfsExt,
    active: lfsExt > 0 || bytes >= ctx.settings.ignoredOutsideBytes,
    level: "yellow",
    paths: outside.slice(0, 50).map((r) => ({ path: r.path, bytes: r.bytes, ...(r.rule ? { rule: r.rule } : {}) })),
  };
}

/** Residue = ignored files in reject places + not-ignored binaries the autosave held back there. */
export function computeRejectResidue(ctx, ignoredResidue, statusResidue, { now }) {
  const rows = [...ignoredResidue, ...statusResidue.map((e) => ({ path: e.path, bytes: e.size, mtimeMs: e.mtimeMs }))];
  const bytes = rows.reduce((s, r) => s + r.bytes, 0);
  const oldestMs = rows.length ? Math.min(...rows.map((r) => r.mtimeMs)) : null;
  return {
    count: rows.length,
    bytes,
    oldestAt: oldestMs === null ? null : isoLocal(oldestMs),
    active: bytes >= ctx.settings.rejectResidueBytes || (oldestMs !== null && now - oldestMs >= ctx.settings.rejectResidueAgeMs),
    level: "yellow",
    paths: rows.slice(0, 50).map((r) => ({ path: r.path, bytes: r.bytes })),
  };
}

const GROWTH_BUCKET_MS = 10 * 60_000;
const GROWTH_BUCKET_DIRS = 20;

/**
 * Add an autosave commit to the growth window: 10-minute buckets of LFS bytes, binaries and the
 * largest directories, kept for `growthWindowMs`. The window rides in the state file, so a
 * restart keeps it. Returns the new window.
 */
export function recordGrowth(ctx, window, committed, { now }) {
  const kept = (window ?? []).filter((b) => b.atMs > now - ctx.settings.growthWindowMs);
  if (!committed || committed.lfsFiles === 0) return kept;
  const atMs = Math.floor(now / GROWTH_BUCKET_MS) * GROWTH_BUCKET_MS;
  let bucket = kept.find((b) => b.atMs === atMs);
  if (!bucket) {
    bucket = { atMs, bytes: 0, files: 0, commit: null, dirs: [] };
    kept.push(bucket);
  }
  bucket.bytes += committed.lfsBytes;
  bucket.files += committed.lfsFiles;
  bucket.commit = committed.commit;
  bucket.dirs = mergeDirs([bucket.dirs, committed.dirs ?? []]).slice(0, GROWTH_BUCKET_DIRS);
  return kept.sort((a, b) => a.atMs - b.atMs);
}

function mergeDirs(lists) {
  const byDir = new Map();
  for (const list of lists) {
    for (const row of list) {
      const sum = byDir.get(row.dir) ?? { dir: row.dir, bytes: 0, files: 0 };
      sum.bytes += row.bytes;
      sum.files += row.files;
      byDir.set(row.dir, sum);
    }
  }
  return [...byDir.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files);
}

/** `growth` from the window: active while its sums reach `growthBytes` or `growthFiles`. */
export function computeGrowth(ctx, window, previous, { now }) {
  const live = (window ?? []).filter((b) => b.atMs > now - ctx.settings.growthWindowMs);
  const bytes = live.reduce((s, b) => s + b.bytes, 0);
  const files = live.reduce((s, b) => s + b.files, 0);
  if (bytes < ctx.settings.growthBytes && files < ctx.settings.growthFiles) return null;
  const top = mergeDirs(live.map((b) => b.dirs))[0] ?? null;
  const hours = Math.round(ctx.settings.growthWindowMs / 3_600_000);
  return {
    active: true,
    level: "yellow",
    at: previous?.active ? previous.at : isoLocal(now),
    atMs: previous?.active ? previous.atMs : now,
    since: isoLocal(live[0].atMs),
    commit: live[live.length - 1].commit,
    bytes,
    files,
    topDir: top?.dir ?? null,
    label: `큰 자동 저장: ${top?.dir ?? "."} ${files}개 · ${(bytes / 1e9).toFixed(2)} GB (${hours}시간 합)`,
  };
}

export { rejectMatcher };

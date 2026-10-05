// Server backup: restic -> offsite repository (docs/server.md "Backup", design 3.4).
//
// Thin by design: per store only `origin.git`, `lfs/objects`, `state` and the config directory
// (minus the credential directory). `tree/` is rebuilt from `origin.git`;
// `lfs/incoming/` holds only unverified uploads.
//
// Every snapshot carries `--host <backup.host>` and `--tag <store id>`. Retention (`forget`)
// only ever selects this host's snapshots and always keeps the pre-cutover tag, so the other
// groups in a shared repository (the Mac routine's snapshots) are never touched: the removals
// are computed with a dry run and checked before anything is forgotten, then forgotten by id.
// The one exception is the pre-cutover retention: once its clock has run out, the snapshots
// carrying that tag and taken before the clock started are forgotten by id, whatever their host.
//
// A snapshot of a live bare repository restores whole because objects are only ever added
// while it is read (receive.autogc=false, gc.auto=0 — gc runs here, before the refs are
// recorded) and the refs are written to state/backup-refs.json before restic starts: every
// recorded ref points at objects that were on disk before restic read the objects directory.
// A restore resets the refs to that file (refs a push moved mid-backup may point past it).

import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, chownSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { isLfsPath } from "./lfs-paths.mjs";
import { resticEnv, runRestic } from "./restic.mjs";
import { runGit, storePaths } from "./store-layout.mjs";

const RUNS_KEPT = 30;
const OID = /^[0-9a-f]{64}$/;

// --- small helpers ---

export function backupStores(config) {
  if (!config.backup) throw new Error("backup is not configured (server.json has no backup block — vault server backup configure)");
  return config.backup.stores ?? Object.keys(config.stores);
}

function storeOf(config, storeId) {
  const store = config.stores[storeId];
  if (!store) throw new Error(`no store ${storeId} in server.json`);
  return store;
}

function isUnder(path, dir) {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

/** Paths and excludes one store's snapshot holds. */
export function backupTargets(config, configPath, storeId) {
  const paths = storePaths(storeOf(config, storeId).path);
  const configDir = dirname(configPath);
  const excludes = [];
  if (isUnder(config.backup.credentialsDir, configDir)) excludes.push(config.backup.credentialsDir);
  return { paths: [paths.gitDir, paths.lfsObjects, paths.state, configDir], excludes };
}

function atomicWriteJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  try {
    const parent = statSync(dirname(path));
    if (process.getuid?.() === 0) chownSync(temp, parent.uid, parent.gid);
  } catch {
    // ownership follows the directory only when we can; serve reads the file either way
  }
  renameSync(temp, path);
}

export function readBackupStatus(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`backup status ${path} unreadable: ${error.message}`);
  }
}

function updateStatus(config, storeId, mutate) {
  const path = storePaths(storeOf(config, storeId).path).backupStatus;
  const status = readBackupStatus(path);
  const next = mutate(status) ?? status;
  atomicWriteJson(path, next);
  return next;
}

/** Fold one backup run into a status object (pure, tested). */
export function recordRun(status, run) {
  const runs = [...(status.runs ?? []), run].slice(-RUNS_KEPT);
  let consecutiveOk = 0;
  for (let i = runs.length - 1; i >= 0 && runs[i].result === "ok"; i -= 1) consecutiveOk += 1;
  return {
    ...status,
    host: run.host ?? status.host,
    lastRunAt: run.at,
    lastResult: run.result,
    lastError: run.result === "ok" ? null : run.error,
    // snapshot START time: everything on disk before it is in the snapshot (design 3.3 evict)
    lastBackupAt: run.result === "ok" ? run.snapshotTime : status.lastBackupAt ?? null,
    lastSnapshotId: run.result === "ok" ? run.snapshotId : status.lastSnapshotId ?? null,
    consecutiveOk,
    runs,
  };
}

function hostArgs(config) {
  return ["--host", config.backup.host];
}

function lockArgs(config) {
  return ["--retry-lock", config.backup.retryLock];
}

async function snapshotList(config, env, filters) {
  const result = await runRestic(["snapshots", "--json", ...lockArgs(config), ...filters], { env, json: true });
  if (!Array.isArray(result.doc)) throw new Error(`restic snapshots: unexpected output (${result.stdout.slice(0, 200)})`);
  return result.doc;
}

function shortSnapshot(s) {
  return { id: s.short_id ?? s.id.slice(0, 8), time: s.time, host: s.hostname, paths: s.paths, tags: s.tags ?? [] };
}

// --- backup ---

/** Record the refs a snapshot must restore to (after gc, before restic reads the store). */
export async function recordRefs(gitDir, refsPath, now = new Date()) {
  // gc only here: objects stay put while restic reads (see the header)
  // autoDetach=false: a gc left running in the background would delete packs mid-read
  await runGit(["--git-dir", gitDir, "-c", "gc.auto=6700", "-c", "gc.autoPackLimit=50", "-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"]);
  const out = await runGit(["--git-dir", gitDir, "for-each-ref", "--format=%(objectname) %(refname)"]);
  const refs = {};
  for (const line of out.stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    refs[line.slice(space + 1)] = line.slice(0, space);
  }
  const head = await runGit(["--git-dir", gitDir, "symbolic-ref", "HEAD"], { allowFail: true });
  const manifest = { at: now.toISOString(), head: head.code === 0 ? head.stdout.toString("utf8").trim() : null, refs };
  atomicWriteJson(refsPath, manifest);
  return manifest;
}

export async function runStoreBackup({ config, configPath, storeId, env = process.env, now = () => new Date() }) {
  const started = now();
  const run = { at: started.toISOString(), host: config.backup.host, result: "failed" };
  try {
    const paths = storePaths(storeOf(config, storeId).path);
    const restic = resticEnv(config.backup, env);
    await recordRefs(paths.gitDir, paths.backupRefs, started);
    const { paths: targets, excludes } = backupTargets(config, configPath, storeId);
    const args = ["backup", "--json", ...lockArgs(config), ...hostArgs(config), "--tag", storeId, ...excludes.flatMap((e) => ["--exclude", e]), ...targets];
    const result = await runRestic(args, { env: restic, json: true, allowCodes: [3] });
    const messages = result.messages ?? [];
    const summary = messages.find((m) => m.message_type === "summary");
    const errors = messages.filter((m) => m.message_type === "error").map((m) => m.item ?? m.during ?? "error");
    if (summary?.snapshot_id) {
      const [snap] = await snapshotList(config, restic, [summary.snapshot_id]);
      Object.assign(run, {
        snapshotId: summary.snapshot_id.slice(0, 8),
        snapshotTime: snap?.time ?? null,
        durationSec: Math.round(summary.total_duration ?? 0),
        filesNew: summary.files_new,
        filesChanged: summary.files_changed,
        filesUnmodified: summary.files_unmodified,
        dataAdded: summary.data_added,
        totalBytesProcessed: summary.total_bytes_processed,
        totalFilesProcessed: summary.total_files_processed,
      });
    }
    if (result.code === 3) {
      // a snapshot exists but some files could not be read: not a green run
      run.error = `restic could not read ${errors.length} item(s): ${errors.slice(0, 5).join(", ")}`;
    } else if (!summary?.snapshot_id) {
      run.error = "restic backup gave no summary with a snapshot id";
    } else {
      run.result = "ok";
    }
  } catch (error) {
    run.error = error.message;
  }
  run.durationSec ??= Math.round((now() - started) / 1000);
  updateStatus(config, storeId, (status) => recordRun(status, run));
  return run;
}

// --- retention of this host's groups ---

/** The snapshots a `restic forget --json` (dry run) would remove; throws on any other output. */
function plannedRemovals(result, what) {
  if (!Array.isArray(result.doc)) throw new Error(`${what}: unexpected restic forget output (${result.stdout.slice(0, 200)})`);
  return {
    removed: result.doc.flatMap((g) => (g.remove ?? []).map((s) => ({ ...shortSnapshot(s), fullId: s.id }))),
    kept: result.doc.flatMap((g) => (g.keep ?? []).map(shortSnapshot)),
  };
}

/**
 * Forget exactly the planned snapshots by id, then check that exactly those went (the second line
 * of defence: anything else gone, or a planned one still there, stops before prune).
 */
async function forgetPlanned(config, restic, removed, what) {
  const before = new Set((await snapshotList(config, restic, [])).map((s) => s.id));
  await runRestic(["forget", ...lockArgs(config), ...removed.map((s) => s.fullId)], { env: restic });
  const after = new Set((await snapshotList(config, restic, [])).map((s) => s.id));
  const planned = new Set(removed.map((s) => s.fullId));
  const gone = [...before].filter((id) => !after.has(id));
  const unplanned = gone.filter((id) => !planned.has(id));
  const left = [...planned].filter((id) => after.has(id));
  if (unplanned.length || left.length) {
    throw new Error(`${what}: forget removed ${unplanned.map((id) => id.slice(0, 8)).join(",") || "nothing"} outside the plan and left ${left.map((id) => id.slice(0, 8)).join(",") || "nothing"} of it — not pruning`);
  }
}

/**
 * This host's retention for one store. The removals are computed first (`forget --dry-run`) and
 * checked — every one must be this host's, tagged with the store id alone and not pre-cutover —
 * before anything is forgotten; then exactly those ids are forgotten.
 */
export async function forgetOwnGroup({ config, storeId, env = process.env, now = () => new Date(), prune = true }) {
  const record = { at: now().toISOString(), result: "failed" };
  try {
    const restic = resticEnv(config.backup, env);
    const { keep, preCutover } = config.backup;
    const args = [
      "forget", "--json", "--dry-run", ...lockArgs(config), ...hostArgs(config), "--tag", storeId,
      "--keep-daily", String(keep.daily), "--keep-weekly", String(keep.weekly), "--keep-monthly", String(keep.monthly),
      "--keep-tag", preCutover.tag,
    ];
    const { removed, kept } = plannedRemovals(await runRestic(args, { env: restic, json: true }), "forget");
    const outside = removed.filter((s) => s.host !== config.backup.host || s.tags.length !== 1 || s.tags[0] !== storeId);
    if (outside.length) {
      throw new Error(`forget would remove ${outside.map((s) => `${s.id} (${s.host}, ${s.tags.join(",")})`).join("; ")} — outside host ${config.backup.host} tag ${storeId}; nothing forgotten`);
    }
    record.removed = removed.map((s) => s.id);
    record.kept = kept.length;
    if (removed.length > 0) {
      await forgetPlanned(config, restic, removed, "forget");
      if (prune) {
        await runRestic(["prune", ...lockArgs(config)], { env: restic });
        record.pruned = true;
      }
    }
    record.result = "ok";
  } catch (error) {
    record.error = error.message;
  }
  updateStatus(config, storeId, (status) => ({ ...status, forget: record }));
  return record;
}

// --- pre-cutover retention (design 3.4 rule 4, Q8) ---

export function preCutoverDeadline(backup) {
  const started = backup.preCutover.clockStartedAt;
  if (!started) return null;
  return new Date(Date.parse(started) + backup.preCutover.retentionDays * 86_400_000);
}

/**
 * Decide what the pre-cutover retention does now (pure, tested). Eligible = snapshots with the
 * tag taken before the clock started — a later cutover's tagged snapshot is never eligible.
 */
export function planPreCutover(backup, snapshots, now) {
  const { tag, retentionDays, clockStartedAt } = backup.preCutover;
  const tagged = snapshots.filter((s) => (s.tags ?? []).includes(tag));
  const base = { tag, retentionDays, clockStartedAt, snapshots: tagged.map(shortSnapshot) };
  if (!clockStartedAt) return { ...base, state: "clock-not-started", deadline: null, forget: [] };
  const deadline = preCutoverDeadline(backup);
  if (now < deadline) return { ...base, state: "keeping", deadline: deadline.toISOString(), forget: [] };
  const eligible = tagged.filter((s) => Date.parse(s.time) < Date.parse(clockStartedAt));
  return { ...base, state: eligible.length ? "expired" : "deleted", deadline: deadline.toISOString(), forget: eligible.map((s) => s.id) };
}

export async function preCutoverRetention({ config, env = process.env, now = () => new Date(), prune = true }) {
  const at = now();
  const restic = resticEnv(config.backup, env);
  const snapshots = await snapshotList(config, restic, ["--tag", config.backup.preCutover.tag]);
  const plan = planPreCutover(config.backup, snapshots, at);
  const record = { at: at.toISOString(), state: plan.state, tag: plan.tag, retentionDays: plan.retentionDays, clockStartedAt: plan.clockStartedAt, deadline: plan.deadline, snapshots: plan.snapshots };
  if (plan.forget.length) {
    await runRestic(["forget", ...lockArgs(config), ...plan.forget], { env: restic });
    if (prune) await runRestic(["prune", ...lockArgs(config)], { env: restic });
    record.state = "deleted";
    record.deleted = plan.forget.map((id) => id.slice(0, 8));
    record.deletedAt = now().toISOString();
  }
  return record;
}

// --- thin the Mac group's old-path snapshots down to the pre-cutover one ---

export async function forgetPath({ config, host, path, dryRun = false, env = process.env }) {
  if (!host || !path) throw new Error("forget-path needs --host and --path");
  const restic = resticEnv(config.backup, env);
  const tag = config.backup.preCutover.tag;
  const group = await snapshotList(config, restic, ["--host", host, "--path", path]);
  const tagged = group.filter((s) => (s.tags ?? []).includes(tag));
  if (group.length === 0) throw new Error(`no snapshot of host ${host} with path ${path}`);
  // keep-tag alone keeps nothing when nothing carries the tag: that would forget the group whole
  if (tagged.length === 0) throw new Error(`refusing: no ${tag} snapshot in host ${host} path ${path} — forget would remove all ${group.length}`);
  const args = ["forget", "--json", "--dry-run", ...lockArgs(config), "--host", host, "--path", path, "--keep-tag", tag];
  const { removed, kept } = plannedRemovals(await runRestic(args, { env: restic, json: true }), "forget-path");
  // checked before anything is forgotten: one foreign or pre-cutover snapshot stops the whole run
  const outside = removed.filter((s) => s.host !== host || !(s.paths ?? []).includes(path) || s.tags.includes(tag));
  if (outside.length) {
    throw new Error(`forget-path would remove ${outside.map((s) => `${s.id} (${s.host}, ${(s.paths ?? []).join(",")}, ${s.tags.join(",")})`).join("; ")} — outside host ${host} path ${path} or tagged ${tag}; nothing forgotten`);
  }
  if (!dryRun && removed.length) {
    await forgetPlanned(config, restic, removed, "forget-path");
    await runRestic(["prune", ...lockArgs(config)], { env: restic });
  }
  return { host, path, dryRun, removed: removed.map((s) => s.id), kept: kept.map((s) => s.id) };
}

// --- restore and drill ---

function seededRandom(seedHex) {
  let a = Number.parseInt(String(seedHex).slice(0, 8), 16) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample(items, count, seedHex) {
  const random = seededRandom(seedHex);
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", rejectPromise)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

/** Objects in a CAS directory, counted from the disk (independent of any restic listing). */
function countCasObjects(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countCasObjects(join(dir, entry.name));
    else if (entry.isFile() && OID.test(entry.name)) n += 1;
  }
  return n;
}

async function latestSnapshot(config, restic, storeId) {
  const list = await snapshotList(config, restic, [...hostArgs(config), "--tag", storeId, "--latest", "1"]);
  if (list.length === 0) throw new Error(`no snapshot of host ${config.backup.host} tagged ${storeId}`);
  list.sort((x, y) => Date.parse(x.time) - Date.parse(y.time));
  return list[list.length - 1];
}

/**
 * Reset a restored bare repository's refs to the recorded manifest and fsck it. Throws when a
 * recorded ref points at a missing object (update-ref refuses) or fsck finds a problem.
 */
export async function applyRefsManifest(gitDir, manifest) {
  const current = await runGit(["--git-dir", gitDir, "for-each-ref", "--format=%(refname)"]);
  for (const ref of current.stdout.toString("utf8").split("\n").filter(Boolean)) {
    if (!(ref in manifest.refs)) await runGit(["--git-dir", gitDir, "update-ref", "-d", ref]);
  }
  for (const [ref, sha] of Object.entries(manifest.refs)) {
    await runGit(["--git-dir", gitDir, "update-ref", ref, sha]);
  }
  const fsck = await runGit(["--git-dir", gitDir, "fsck", "--full", "--no-dangling", "--no-progress"], { allowFail: true });
  if (fsck.code !== 0) throw new Error(`git fsck of the restored repository failed: ${fsck.stderr.trim().split("\n").slice(0, 5).join(" | ")}`);
  return { refs: Object.keys(manifest.refs).length };
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`restored refs manifest ${path} unreadable: ${error.message}`);
  }
}

/** Text blobs of one commit that are not LFS paths or pointers (path, sha, size). */
async function textEntries(gitDir, commit) {
  const out = await runGit(["--git-dir", gitDir, "ls-tree", "-r", "-z", "-l", "--full-tree", commit]);
  const entries = [];
  for (const record of out.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, sha, size] = record.slice(0, tab).split(/\s+/);
    const path = record.slice(tab + 1);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    if (isLfsPath(path) || Number(size) === 0) continue;
    entries.push({ path, sha, size: Number(size) });
  }
  return entries;
}

async function blobSha256(gitDir, sha) {
  const out = await runGit(["--git-dir", gitDir, "cat-file", "blob", sha]);
  return { sha256: createHash("sha256").update(out.stdout).digest("hex") };
}

/**
 * Restore drill (design 3.4): restore `origin.git` + `state` and `cas` CAS objects from the
 * latest snapshot into a scratch directory, reset refs to the manifest, fsck, then compare
 * `text` text blobs and the CAS objects by sha256 against the live store. Counts files on disk
 * after each restore — a restore that matched nothing ("Restored 0 files") fails here. Each
 * sample has a floor, min(asked, live count) with the live count read from the store itself, so
 * a listing that comes back empty or short (a changed restic output format, a snapshot without
 * lfs/objects) fails, and so does a store with nothing to verify.
 */
export async function drill({ config, storeId, snapshot: snapshotId, env = process.env, now = () => new Date(), keep = false }) {
  const at = now();
  const record = { at: at.toISOString(), result: "failed" };
  const live = storePaths(storeOf(config, storeId).path);
  const drillRoot = join(config.dataDir, ".backup-drill", `${storeId}-${at.toISOString().replace(/[:.]/g, "")}`);
  try {
    const restic = resticEnv(config.backup, env);
    const snap = snapshotId
      ? (await snapshotList(config, restic, [snapshotId]))[0]
      : await latestSnapshot(config, restic, storeId);
    if (!snap) throw new Error(`snapshot ${snapshotId} not found`);
    record.snapshotId = snap.short_id ?? snap.id.slice(0, 8);
    record.snapshotTime = snap.time;
    if (!snap.paths.includes(live.gitDir)) throw new Error(`snapshot ${record.snapshotId} does not hold ${live.gitDir} (paths: ${snap.paths.join(", ")})`);
    mkdirSync(drillRoot, { recursive: true, mode: 0o750 });

    // 1. origin.git + state
    await runRestic(["restore", ...lockArgs(config), snap.id, "--target", drillRoot, "--include", live.gitDir, "--include", live.state], { env: restic });
    const restoredGit = join(drillRoot, live.gitDir);
    const restoredState = join(drillRoot, live.state);
    const gitFiles = countFiles(restoredGit);
    if (gitFiles === 0) throw new Error(`restore of ${live.gitDir} wrote 0 files`);
    const manifest = readManifest(join(restoredState, "backup-refs.json"));
    await applyRefsManifest(restoredGit, manifest);
    record.fsck = "ok";
    record.refs = Object.keys(manifest.refs).length;

    // 2. text blobs: restored vs live, same commit. The floor comes from the live repository read
    // at that commit, so a restored tree that lists fewer blobs cannot shrink what is asked.
    const main = manifest.refs["refs/heads/main"] ?? null;
    const liveMain = await runGit(["--git-dir", live.gitDir, "rev-parse", "--verify", "--quiet", "refs/heads/main"], { allowFail: true });
    if (!main && liveMain.code === 0) throw new Error("the snapshot's refs manifest has no refs/heads/main but the live store has one");
    const liveText = main ? (await textEntries(live.gitDir, main)).length : 0;
    record.text = { commit: main, live: liveText, required: Math.min(config.backup.drill.text, liveText), available: 0, sampled: 0, matched: 0, mismatches: [] };
    if (main) {
      const entries = await textEntries(restoredGit, main);
      const picked = sample(entries, config.backup.drill.text, snap.id);
      record.text.available = entries.length;
      record.text.sampled = picked.length;
      if (entries.length !== liveText) throw new Error(`restored commit ${main.slice(0, 12)} lists ${entries.length} text blob(s), the live store ${liveText}`);
      for (const entry of picked) {
        const restored = await blobSha256(restoredGit, entry.sha);
        const liveBlob = await runGit(["--git-dir", live.gitDir, "cat-file", "blob", entry.sha], { allowFail: true });
        const liveSha = liveBlob.code === 0 ? createHash("sha256").update(liveBlob.stdout).digest("hex") : null;
        if (restored.sha256 === liveSha) record.text.matched += 1;
        else record.text.mismatches.push({ path: entry.path, restored: restored.sha256, live: liveSha });
      }
    }
    if (record.text.sampled < record.text.required) throw new Error(`text sample ${record.text.sampled} below the floor ${record.text.required} (live ${liveText})`);

    // 3. CAS objects: sha256(restored) == oid == sha256(live). The floor is min(backup.drill.cas,
    // live objects): a listing that yields nothing while the live store holds objects (restic's
    // `ls --json` format changed, the snapshot lacks lfs/objects) fails instead of passing 0/0.
    const liveCas = countCasObjects(live.lfsObjects);
    const nodes = [];
    let unparsed = 0;
    await runRestic(["ls", ...lockArgs(config), "--json", "--recursive", snap.id, live.lfsObjects], {
      env: restic,
      onLine: (line) => {
        let node;
        try {
          node = JSON.parse(line);
        } catch {
          unparsed += 1;
          return;
        }
        if (node.struct_type !== "node" || node.type !== "file" || typeof node.path !== "string") return;
        const name = node.path.split("/").pop();
        if (OID.test(name) && node.path.startsWith(`${live.lfsObjects}/`)) nodes.push({ path: node.path, oid: name, size: node.size });
      },
    });
    const picked = sample(nodes, config.backup.drill.cas, snap.id);
    record.cas = { live: liveCas, required: Math.min(config.backup.drill.cas, liveCas), available: nodes.length, sampled: picked.length, matched: 0, restoredFiles: 0, mismatches: [] };
    if (unparsed) throw new Error(`restic ls printed ${unparsed} line(s) that are not JSON — output format changed?`);
    if (liveCas > 0 && nodes.length === 0) throw new Error(`restic ls listed no CAS object in snapshot ${record.snapshotId} while the live store holds ${liveCas} — output format changed or lfs/objects missing`);
    if (picked.length < record.cas.required) throw new Error(`CAS sample ${picked.length} below the floor ${record.cas.required} (snapshot lists ${nodes.length}, live ${liveCas})`);
    if (liveText === 0 && liveCas === 0) throw new Error("nothing to verify: the store has no text blob at refs/heads/main and no CAS object");
    if (picked.length) {
      await runRestic(["restore", ...lockArgs(config), snap.id, "--target", drillRoot, ...picked.flatMap((n) => ["--include", n.path])], { env: restic });
      record.cas.restoredFiles = countFiles(join(drillRoot, live.lfsObjects));
      if (record.cas.restoredFiles !== picked.length) throw new Error(`CAS restore wrote ${record.cas.restoredFiles} file(s), expected ${picked.length}`);
      for (const node of picked) {
        const restoredPath = join(drillRoot, node.path);
        const restoredSha = await sha256File(restoredPath);
        const livePath = node.path;
        const liveSha = existsSync(livePath) ? await sha256File(livePath) : null;
        const size = statSync(restoredPath).size;
        if (restoredSha === node.oid && liveSha === node.oid && size === node.size) record.cas.matched += 1;
        else record.cas.mismatches.push({ oid: node.oid, restored: restoredSha, live: liveSha, size });
      }
    }
    const textOk = record.text.matched === record.text.sampled;
    const casOk = record.cas.matched === record.cas.sampled;
    if (!textOk || !casOk) throw new Error(`sha256 mismatch: text ${record.text.matched}/${record.text.sampled}, cas ${record.cas.matched}/${record.cas.sampled}`);
    record.result = "ok";
  } catch (error) {
    record.error = error.message;
  } finally {
    if (!keep) rmSync(drillRoot, { recursive: true, force: true });
    else record.keptAt = drillRoot;
  }
  updateStatus(config, storeId, (status) => ({ ...status, lastDrill: record }));
  return record;
}

/** Full restore of one store into `target` (disaster recovery and the restore-refutation test). */
export async function restoreStore({ config, storeId, snapshot: snapshotId, target, env = process.env }) {
  const live = storePaths(storeOf(config, storeId).path);
  const restic = resticEnv(config.backup, env);
  const snap = snapshotId ? (await snapshotList(config, restic, [snapshotId]))[0] : await latestSnapshot(config, restic, storeId);
  if (!snap) throw new Error(`snapshot ${snapshotId} not found`);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`restore target ${target} is not empty`);
  mkdirSync(target, { recursive: true, mode: 0o750 });
  await runRestic(["restore", ...lockArgs(config), snap.id, "--target", target, "--include", live.gitDir, "--include", live.lfsObjects, "--include", live.state], { env: restic });
  const root = join(target, live.root);
  const gitFiles = countFiles(join(target, live.gitDir));
  const casFiles = countFiles(join(target, live.lfsObjects));
  if (gitFiles === 0) throw new Error(`restore of ${live.gitDir} wrote 0 files`);
  const manifest = readManifest(join(target, live.state, "backup-refs.json"));
  await applyRefsManifest(join(target, live.gitDir), manifest);
  return { snapshotId: snap.short_id, snapshotTime: snap.time, root, gitFiles, casFiles, refs: Object.keys(manifest.refs).length, head: manifest.refs["refs/heads/main"] ?? null };
}

// --- the nightly job ---

function takeLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o640);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8").trim());
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (probe) {
        alive = probe.code === "EPERM";
      }
      if (alive) throw new Error(`another backup job holds ${path} (pid ${pid})`);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`could not take ${path}`);
}

/** Backup, own-group forget and drill per store, then the pre-cutover retention. */
export async function nightly({ config, configPath, env = process.env, now = () => new Date(), log = () => {} }) {
  const stores = backupStores(config);
  const release = takeLock(join(config.dataDir, ".backup.lock"));
  const report = { stores: {}, ok: true };
  try {
    for (const storeId of stores) {
      const run = await runStoreBackup({ config, configPath, storeId, env, now });
      log(`backup ${storeId}: ${run.result} ${run.snapshotId ?? ""} ${run.error ?? ""}`.trim());
      const forget = run.result === "ok" ? await forgetOwnGroup({ config, storeId, env, now }) : { result: "skipped" };
      if (run.result === "ok") log(`forget ${storeId}: ${forget.result} removed ${forget.removed?.length ?? 0} ${forget.error ?? ""}`.trim());
      const drillRecord = run.result === "ok" ? await drill({ config, storeId, env, now }) : { result: "skipped" };
      if (run.result === "ok") log(`drill ${storeId}: ${drillRecord.result} text ${drillRecord.text?.matched ?? 0}/${drillRecord.text?.sampled ?? 0} cas ${drillRecord.cas?.matched ?? 0}/${drillRecord.cas?.sampled ?? 0} ${drillRecord.error ?? ""}`.trim());
      report.stores[storeId] = { backup: run, forget, drill: drillRecord };
      if (run.result !== "ok" || forget.result !== "ok" || drillRecord.result !== "ok") report.ok = false;
    }
    let retention;
    try {
      retention = await preCutoverRetention({ config, env, now });
    } catch (error) {
      retention = { at: now().toISOString(), state: "failed", error: error.message };
      report.ok = false;
    }
    log(`pre-cutover: ${retention.state}${retention.deadline ? ` (deadline ${retention.deadline})` : ""}${retention.error ? ` ${retention.error}` : ""}`);
    for (const storeId of stores) updateStatus(config, storeId, (status) => ({ ...status, preCutover: retention }));
    report.preCutover = retention;
  } finally {
    release();
  }
  return report;
}

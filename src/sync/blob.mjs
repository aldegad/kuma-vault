// Large files of a clone (design 3.3). A clone checks LFS paths out as pointers
// (`lfs.fetchexclude=*`); `vault blob get` fetches the named paths only, `evict` turns them
// back into pointers and drops the cached object, `status` reports both.
//
// `get` passes `-X ""` with `-I`: the per-command `-I` overrides only the include setting, so
// under `lfs.fetchexclude=*` an `-I` alone fetches nothing.
//
// Eviction drops the clone's copy only when all three hold: the server holds the object, a
// server backup finished after the server was first seen holding it (so the clone's cache was
// never the last copy), and — for the hourly cache trim — nobody opened it for 7 days.

import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { isLfsPath, parseLfsPointer, renderLfsPointer } from "../server/lfs-paths.mjs";
import { loadContext } from "./context.mjs";
import { git, gitRetry } from "./git.mjs";
import { scanWorktree } from "./scan.mjs";

/** LFS files at HEAD: Map path -> { oid, checkedOut }. */
export async function lfsFiles(ctx) {
  const result = await git(["lfs", "ls-files", "-l"], { cwd: ctx.repo });
  const map = new Map();
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const match = /^([0-9a-f]{64}) ([*-]) (.*)$/.exec(line);
    if (match) map.set(match[3], { oid: match[1], checkedOut: match[2] === "*" });
  }
  return map;
}

export function lfsObjectPath(ctx, oid) {
  return join(ctx.gitDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
}

/** Objects in the clone's LFS cache: [{ oid, size, mtimeMs, atimeMs }]. */
export function cachedObjects(ctx) {
  const root = join(ctx.gitDir, "lfs", "objects");
  const out = [];
  if (!existsSync(root)) return out;
  for (const a of readdirSync(root)) {
    if (!/^[0-9a-f]{2}$/.test(a)) continue;
    for (const b of readdirSync(join(root, a))) {
      for (const oid of readdirSync(join(root, a, b))) {
        if (!/^[0-9a-f]{64}$/.test(oid)) continue;
        const st = statSync(join(root, a, b, oid));
        out.push({ oid, size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
      }
    }
  }
  return out;
}

function escapePattern(path) {
  return path.replace(/[\\[\]*?]/g, (c) => `\\${c}`);
}

/** `git lfs pull -I <paths> -X ""`, then check every path holds its real bytes. */
export async function fetchLfsPaths(ctx, inputs, { cwd = process.cwd() } = {}) {
  const files = await lfsFiles(ctx);
  const paths = inputs.map((p) => ctx.repoPath(p, cwd));
  for (const path of paths) {
    if (!files.has(path)) throw new Error(`${path} is not an LFS file at HEAD`);
    if (path.includes(",")) throw new Error(`${path}: git lfs -I cannot take a path with a comma`);
  }
  const result = await git(["lfs", "pull", "-I", paths.map(escapePattern).join(","), "-X", ""], { cwd: ctx.repo, allowFail: true });
  const after = await lfsFiles(ctx);
  const missing = paths.filter((p) => !after.get(p)?.checkedOut);
  if (result.code !== 0 || missing.length) {
    throw new Error(`blob get: ${missing.length ? `still pointers: ${missing.join(", ")}` : ""} ${result.stderr.trim().split("\n").slice(-2).join(" | ")}`.trim());
  }
  return paths;
}

/**
 * `vault blob get` as a call (the package API): fetch these LFS files of the clone that holds
 * `repo`. `paths` are relative to `repo` or absolute. Resolves to the fetched paths, relative to
 * the clone's top; rejects with the reason — not an LFS file at HEAD, outside the clone, not a
 * synced clone, or what git-lfs said when the server did not hand the object over.
 */
export async function blobGet({ repo, paths, env = process.env } = {}) {
  if (typeof repo !== "string" || !repo) throw new Error("blobGet: repo must be a directory inside the clone");
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("blobGet: paths must name at least one file");
  const dir = resolve(repo);
  const ctx = await loadContext(dir, { env });
  return fetchLfsPaths(ctx, paths, { cwd: dir });
}

function loadLedger(ctx) {
  try {
    return JSON.parse(readFileSync(join(ctx.privateDir, "lfs-confirmed.json"), "utf8"));
  } catch {
    return {};
  }
}

function saveLedger(ctx, ledger) {
  mkdirSync(ctx.privateDir, { recursive: true, mode: 0o700 });
  const path = join(ctx.privateDir, "lfs-confirmed.json");
  writeFileSync(`${path}.${process.pid}.tmp`, `${JSON.stringify(ledger)}\n`);
  renameSync(`${path}.${process.pid}.tmp`, path);
}

function lastOpened(ctx, object, paths) {
  let t = Math.max(object.mtimeMs, object.atimeMs);
  for (const p of paths) {
    try {
      const st = lstatSync(join(ctx.repo, p));
      t = Math.max(t, st.mtimeMs, st.atimeMs);
    } catch {
      // gone from the work tree
    }
  }
  return t;
}

function pointerize(ctx, path, oid, size) {
  const abs = join(ctx.repo, path);
  const st = lstatSync(abs);
  const temp = `${abs}.${process.pid}.evict.tmp`;
  writeFileSync(temp, renderLfsPointer(oid, size), { mode: st.mode & 0o777 });
  renameSync(temp, abs);
}

/**
 * Evict cached objects. `paths` given: those files (idle rule waived — the caller asked).
 * Otherwise (hourly trim): only while the cache is over `lfsCacheMaxBytes`, idle objects
 * oldest-opened first. Returns `{ evicted: [{oid, bytes, paths}], skipped: [{oid, reason}], cacheBytes }`.
 */
export async function blobEvict(ctx, api, { paths: inputs = null, cwd = process.cwd(), clock = Date.now } = {}) {
  const files = await lfsFiles(ctx);
  const byOid = new Map();
  for (const [path, info] of files) byOid.set(info.oid, [...(byOid.get(info.oid) ?? []), path]);
  const objects = cachedObjects(ctx);
  const objectByOid = new Map(objects.map((o) => [o.oid, o]));
  let cacheBytes = objects.reduce((s, o) => s + o.size, 0);
  const dirty = new Set((await scanWorktree(ctx.repo)).map((e) => e.path));
  const skipped = [];

  let candidates;
  const manual = Array.isArray(inputs) && inputs.length > 0;
  if (manual) {
    candidates = [];
    for (const input of inputs) {
      const path = ctx.repoPath(input, cwd);
      const info = files.get(path);
      if (!info) throw new Error(`${path} is not an LFS file at HEAD`);
      const object = objectByOid.get(info.oid);
      if (!object) {
        skipped.push({ oid: info.oid, path, reason: "이미 포인터(캐시에 없음)" });
        continue;
      }
      if (!candidates.includes(object)) candidates.push(object);
    }
  } else {
    if (cacheBytes <= ctx.settings.lfsCacheMaxBytes) return { evicted: [], skipped, cacheBytes };
    const opened = objects.map((o) => ({ ...o, opened: lastOpened(ctx, o, byOid.get(o.oid) ?? []) }));
    const now = clock(); // after the stats it judges
    candidates = opened
      .filter((o) => now - o.opened >= ctx.settings.evictIdleMs)
      .sort((a, b) => a.opened - b.opened);
  }
  if (candidates.length === 0) return { evicted: [], skipped, cacheBytes };

  // (1) the server holds it — first sighting is recorded; (2) a backup finished after that
  const ledger = loadLedger(ctx);
  const unknown = candidates.filter((o) => !ledger[o.oid]).map((o) => ({ oid: o.oid, size: o.size }));
  if (unknown.length) {
    const have = await api.serverHas(unknown);
    const seenAt = clock(); // when the server answered: a backup must finish after it
    for (const oid of have) ledger[oid] = seenAt;
    saveLedger(ctx, ledger);
  }
  const backup = await api.backupStatus();
  const backupMs = backup?.lastBackupAt ? Date.parse(backup.lastBackupAt) : null;

  const evicted = [];
  for (const object of candidates) {
    if (!manual && cacheBytes <= ctx.settings.lfsCacheMaxBytes) break;
    const paths = byOid.get(object.oid) ?? [];
    if (!ledger[object.oid]) {
      skipped.push({ oid: object.oid, reason: "서버에 없다" });
      continue;
    }
    if (!backupMs || backupMs <= ledger[object.oid]) {
      skipped.push({ oid: object.oid, reason: "서버 백업이 아직 이 객체를 덮지 않았다" });
      continue;
    }
    if (paths.some((p) => dirty.has(p))) {
      skipped.push({ oid: object.oid, reason: "작업 트리에서 고쳐지는 중" });
      continue;
    }
    for (const p of paths) {
      if (!files.get(p).checkedOut) continue;
      if (parseLfsPointer(readFileSync(join(ctx.repo, p)).subarray(0, 1025))) continue;
      pointerize(ctx, p, object.oid, object.size);
    }
    rmSync(lfsObjectPath(ctx, object.oid), { force: true });
    cacheBytes -= object.size;
    evicted.push({ oid: object.oid, bytes: object.size, paths });
  }
  // `update-index --refresh` compares stat only and would leave the path "modified"; `git add`
  // runs the clean filter, which turns the pointer text back into the same pointer blob.
  const rewritten = evicted.flatMap((e) => e.paths);
  if (rewritten.length) {
    await gitRetry(["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: ctx.repo, input: `${rewritten.join("\0")}\0` });
  }
  return { evicted, skipped, cacheBytes };
}

export async function blobStatus(ctx, inputs = [], { cwd = process.cwd() } = {}) {
  const files = await lfsFiles(ctx);
  const objects = cachedObjects(ctx);
  const rows = inputs.length
    ? inputs.map((input) => {
        const path = ctx.repoPath(input, cwd);
        const info = files.get(path);
        return { path, lfs: Boolean(info) || isLfsPath(path), oid: info?.oid ?? null, state: info ? (info.checkedOut ? "hydrated" : "pointer") : "not-lfs" };
      })
    : null;
  return {
    lfsFiles: files.size,
    hydrated: [...files.values()].filter((f) => f.checkedOut).length,
    cache: { objects: objects.length, bytes: objects.reduce((s, o) => s + o.size, 0), limitBytes: ctx.settings.lfsCacheMaxBytes },
    ...(rows ? { paths: rows } : {}),
  };
}

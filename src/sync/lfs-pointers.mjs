// Which paths of a commit are LFS pointers, and what they point at (design 3.3).
//
// `git lfs ls-files -l` answers this by reading every pointer blob of the tree and statting every
// file, on every call. Over 120k pointers that is tens of CPU seconds, and `vault blob get` paid
// it twice per fetch. The answer is a pure function of the tree object id, so:
//
//   lfsPointersOf(ctx, paths)   the named paths only — `ls-tree` with those pathspecs, then their
//                               blobs. What `vault blob get` asks.
//   lfsPointers(ctx)            every path. Kept under the tree id in the clone's private dir and
//                               shared by every caller (the CLI, the daemon's hourly trim); a new
//                               tree is reached from the kept one by `diff-tree`, so a commit
//                               costs what it changed. Calls for one tree in one process share
//                               one computation. Another process reading a kept map of a
//                               different tree only redoes the diff.
//
// The map is of HEAD's tree: the index is not part of it, and whether the work tree holds the
// real bytes is read from the work tree by the caller each time (`isHydrated`), never kept.
//
// Large non-LFS blobs are not local in a partial clone, and reading one would fetch it. A pointer
// is at most LFS_POINTER_MAX_BYTES and the clone filter (blob:limit=1m) keeps every blob that
// small local, so sizes come from `rev-list --filter=blob:limit --missing=print` (no fetch) and
// only the small present blobs are read.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

import { LFS_POINTER_MAX_BYTES, parseLfsPointer } from "../server/lfs-paths.mjs";
import { git, splitNul } from "./git.mjs";

const CACHE_VERSION = 1;
const REGULAR = new Set(["100644", "100755"]);

export function lfsPointersCachePath(ctx) {
  return join(ctx.privateDir, "lfs-pointers.json");
}

/** Tree object id of `ref`, or null (an unborn branch). */
export async function treeOf(ctx, ref = "HEAD") {
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{tree}`], { cwd: ctx.repo, allowFail: true });
  return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
}

/** Regular-file blobs of `tree`, all of them or under `paths`: [{ path, blob }]. */
async function lsTree(ctx, tree, paths = null) {
  const args = ["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", tree];
  if (paths) args.push("--", ...paths);
  const out = [];
  for (const record of splitNul((await git(args, { cwd: ctx.repo })).stdout)) {
    const tab = record.indexOf("\t");
    const [mode, type, blob] = record.slice(0, tab).split(" ");
    if (type === "blob" && REGULAR.has(mode)) out.push({ path: record.slice(tab + 1), blob });
  }
  return out;
}

/** Of these blob ids, the ones present here and small enough to be a pointer. Never fetches. */
async function smallBlobs(ctx, blobs) {
  if (blobs.length === 0) return new Set();
  const result = await git(
    ["rev-list", "--objects", "--no-object-names", `--filter=blob:limit=${LFS_POINTER_MAX_BYTES + 1}`, "--filter-provided-objects", "--missing=print", "--ignore-missing", "--stdin"],
    { cwd: ctx.repo, input: `${blobs.join("\n")}\n` },
  );
  const small = new Set();
  for (const line of result.stdout.toString("utf8").split("\n")) if (/^[0-9a-f]{40,64}$/.test(line)) small.add(line);
  return small;
}

/** `cat-file --batch` of these blobs: Map blob -> { oid, size } for the ones that are pointers. */
async function readPointerBlobs(ctx, blobs) {
  const pointers = new Map();
  if (blobs.length === 0) return pointers;
  const out = (await git(["cat-file", "--batch"], { cwd: ctx.repo, input: `${blobs.join("\n")}\n` })).stdout;
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) break;
    const [blob, type, sizeText] = out.subarray(at, eol).toString("utf8").split(" ");
    if (type === "missing" || sizeText === undefined) {
      at = eol + 1;
      continue;
    }
    const size = Number(sizeText);
    const pointer = type === "blob" ? parseLfsPointer(out.subarray(eol + 1, eol + 1 + size)) : null;
    if (pointer) pointers.set(blob, pointer);
    at = eol + 1 + size + 1;
  }
  return pointers;
}

/** [{ path, blob }] -> Map path -> { oid, size } for the entries whose blob is a pointer. */
async function pointersOfEntries(ctx, entries) {
  const unique = [...new Set(entries.map((e) => e.blob))];
  const small = await smallBlobs(ctx, unique);
  const pointers = await readPointerBlobs(ctx, unique.filter((b) => small.has(b)));
  const files = new Map();
  for (const { path, blob } of entries) {
    const pointer = pointers.get(blob);
    if (pointer) files.set(path, { oid: pointer.oid, size: pointer.size });
  }
  return files;
}

/** The named repo-relative paths that are LFS files at HEAD: Map path -> { oid, size }. */
export async function lfsPointersOf(ctx, paths) {
  const tree = await treeOf(ctx);
  if (!tree || paths.length === 0) return new Map();
  const wanted = new Set(paths);
  return pointersOfEntries(ctx, (await lsTree(ctx, tree, paths)).filter((e) => wanted.has(e.path)));
}

function readCache(ctx) {
  try {
    const cache = JSON.parse(readFileSync(lfsPointersCachePath(ctx), "utf8"));
    if (cache?.version !== CACHE_VERSION || typeof cache.tree !== "string" || !Array.isArray(cache.files)) return null;
    return { tree: cache.tree, files: new Map(cache.files.map(([path, oid, size]) => [path, { oid, size }])) };
  } catch {
    return null;
  }
}

function writeCache(ctx, tree, files) {
  mkdirSync(ctx.privateDir, { recursive: true, mode: 0o700 });
  const path = lfsPointersCachePath(ctx);
  const rows = [...files].map(([p, { oid, size }]) => [p, oid, size]);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: CACHE_VERSION, tree, files: rows })}\n`);
  renameSync(temp, path);
}

/** Carry `base` (the map of tree `from`) to tree `to`; null when `from` is not here to diff. */
async function carry(ctx, base, from, to) {
  const result = await git(["diff-tree", "-r", "-z", "--no-renames", from, to], { cwd: ctx.repo, allowFail: true });
  if (result.code !== 0) return null;
  const files = new Map(base);
  const changed = [];
  const parts = splitNul(result.stdout);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // :<old mode> <new mode> <old id> <new id> <status>  then the path
    const [, newMode, , blob, status] = parts[i].slice(1).split(" ");
    const path = parts[i + 1];
    files.delete(path);
    if (status !== "D" && REGULAR.has(newMode)) changed.push({ path, blob });
  }
  for (const [path, info] of await pointersOfEntries(ctx, changed)) files.set(path, info);
  return files;
}

const inFlight = new Map();

/**
 * Every LFS file at HEAD: `{ tree, files: Map path -> { oid, size } }` — from the kept map when it
 * is of HEAD's tree, carried from it by `diff-tree` when it is of another, computed in full
 * otherwise; the answer is kept for the next caller.
 */
export async function lfsPointers(ctx) {
  const tree = await treeOf(ctx);
  if (!tree) return { tree: null, files: new Map() };
  const key = `${ctx.repo}\0${tree}`;
  if (!inFlight.has(key)) {
    inFlight.set(key, (async () => {
      const cache = readCache(ctx);
      if (cache?.tree === tree) return { tree, files: cache.files };
      const files = (cache && (await carry(ctx, cache.files, cache.tree, tree))) ?? (await pointersOfEntries(ctx, await lsTree(ctx, tree)));
      writeCache(ctx, tree, files);
      return { tree, files };
    })().finally(() => inFlight.delete(key)));
  }
  return inFlight.get(key);
}

/**
 * True when the work tree holds the object's bytes, not its pointer — git-lfs ls-files' "*" (the
 * file's size is the object's), and the file is not a pointer text of that very size.
 */
export function isHydrated(ctx, path, size) {
  const abs = join(ctx.repo, path);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return false;
  }
  if (!st.isFile() || st.size !== size) return false;
  if (size > LFS_POINTER_MAX_BYTES) return true;
  let fd;
  try {
    fd = openSync(abs, "r");
    const buffer = Buffer.alloc(size);
    const n = readSync(fd, buffer, 0, size, 0);
    return !parseLfsPointer(buffer.subarray(0, n));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

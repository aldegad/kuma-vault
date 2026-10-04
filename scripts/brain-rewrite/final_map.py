#!/usr/bin/env python3
"""Rewrite pipeline step 1: final-map.tsv and the CAS hardlinks.

Every LFS-extension file in the worktree that git does not ignore
(`ls-files --cached --others --exclude-standard`, the set autosave sees),
minus files gone from the worktree and minus delete-paths, is read once for
its git blob sha1 and sha256. Size-0 files stay empty blobs. A worktree file
that is itself an unsmudged LFS pointer maps to the pointer's oid, and its
bytes come from the original .git/lfs/objects.

Paths are recorded in NFC (server receive rule 2) and read under the name that
exists on disk (see brainrw.worktree_paths).

Cache key (path, size, mtime_ns, inode): a second run reads only changed files.
CAS: one hardlink per sha256 at <cas>/<aa>/<bb>/<sha256>; an existing entry is
kept after a size check. Links never modify the source inode's content or
mtime; nothing here writes, chmods or touches a worktree file.

  final_map.py --worktree W --out final-map.tsv --cache map-cache.tsv --report r.json \
      [--cas DIR] [--lfs-objects ORIG/.git/lfs/objects] [--delete-paths F] [--jobs 4]
"""

import argparse
import concurrent.futures
import hashlib
import os
import stat
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402

CHUNK = 8 << 20
CACHE_HEADER = b"st_size\tmtime_ns\tino\tsize\tblob_sha1\tsha256\tmode\tkind\tpath\n"


def load_cache(fn):
    cache = {}
    if not fn or not os.path.exists(fn):
        return cache
    with open(fn, "rb") as f:
        if f.readline() != CACHE_HEADER:
            B.die("cache header mismatch: %s" % fn)
        for line in f:
            st_size, mt, ino, size, sha1, sha256, mode, kind, path = line.rstrip(b"\n").split(b"\t", 8)
            cache[path] = ((int(st_size), int(mt), int(ino)),
                           dict(path=path, size=int(size), blob_sha1=sha1, sha256=sha256.decode(), mode=mode,
                                kind=kind.decode()))
    return cache


def save_cache(fn, entries):
    tmp = fn + ".tmp"
    with open(tmp, "wb") as f:
        f.write(CACHE_HEADER)
        for path in sorted(entries):
            (st_size, mt, ino), r = entries[path]
            f.write(b"\t".join([str(st_size).encode(), str(mt).encode(), str(ino).encode(), str(r["size"]).encode(),
                                r["blob_sha1"], r["sha256"].encode(), r["mode"], r["kind"].encode(), path]) + b"\n")
    os.replace(tmp, fn)


def hash_file(full, st):
    h1 = hashlib.sha1(b"blob %d\0" % st.st_size)
    h2 = hashlib.sha256()
    n = 0
    head = b""
    with open(full, "rb") as f:
        while True:
            buf = f.read(CHUNK)
            if not buf:
                break
            if n == 0:
                head = buf[:B.POINTER_MAX]
            n += len(buf)
            h1.update(buf)
            h2.update(buf)
    st2 = os.lstat(full)
    if n != st.st_size or st2.st_size != st.st_size or st2.st_mtime_ns != st.st_mtime_ns:
        B.die("file changed while hashing: %r" % full)
    return h1.hexdigest().encode(), h2.hexdigest(), head


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worktree", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cache", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--cas")
    ap.add_argument("--lfs-objects")
    ap.add_argument("--delete-paths")
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    T = B.Timer()
    wt = os.fsencode(os.path.abspath(a.worktree))
    dp = B.DeletePaths(a.delete_paths) if a.delete_paths else None

    listed = B.split_z(B.git(a.worktree, "ls-files", "-z", "--cached", "--others", "--exclude-standard"))
    disk_of = B.worktree_paths(a.worktree, listed)  # NFC path -> name on disk
    paths = sorted(disk_of)
    ignored = [p for p in B.split_z(B.git(a.worktree, "ls-files", "-z", "--others", "--ignored",
                                           "--exclude-standard")) if B.is_lfs_path(p)]
    ign_bytes = 0
    for p in ignored:
        try:
            ign_bytes += os.lstat(os.path.join(wt, p)).st_size
        except FileNotFoundError:
            pass
    T.mark("list")

    cache = load_cache(a.cache)
    rows, todo = [], []
    stats = dict(listed=len(paths), nonNfcOnDisk=sum(1 for k, v in disk_of.items() if k != v),
                 lfsCandidates=0, deletedByRule=0, missing=0, symlinks=0, cacheHits=0,
                 hashed=0, hashedBytes=0, empty=0, unsmudgedPointers=0)
    new_cache = {}
    for p in paths:
        if not B.is_lfs_path(p):
            continue
        stats["lfsCandidates"] += 1
        if dp and dp.matches(p):
            stats["deletedByRule"] += 1
            continue
        full = os.path.join(wt, disk_of[p])
        try:
            st = os.lstat(full)
        except FileNotFoundError:
            stats["missing"] += 1
            continue
        if stat.S_ISLNK(st.st_mode):
            target = os.readlink(full)
            stats["symlinks"] += 1
            rows.append(dict(path=p, size=len(target), blob_sha1=B.git_blob_sha1(target), sha256="-",
                             mode=b"120000", kind="symlink"))
            continue
        if not stat.S_ISREG(st.st_mode):
            B.die("not a regular file: %r" % full)
        mode = b"100755" if st.st_mode & 0o100 else b"100644"
        if st.st_size == 0:
            stats["empty"] += 1
            rows.append(dict(path=p, size=0, blob_sha1=B.EMPTY_BLOB, sha256=B.EMPTY_SHA256, mode=mode, kind="empty"))
            continue
        key = (st.st_size, st.st_mtime_ns, st.st_ino)
        c = cache.get(p)
        if c and c[0] == key and c[1]["mode"] == mode:
            stats["cacheHits"] += 1
            rows.append(dict(c[1]))
            new_cache[p] = (key, c[1])
            continue
        todo.append((p, full, st, mode))
    T.mark("stat")

    def work(item):
        p, full, st, mode = item
        return item, hash_file(full, st)

    with concurrent.futures.ThreadPoolExecutor(max_workers=a.jobs) as ex:
        for (p, full, st, mode), (sha1, sha256, head) in ex.map(work, todo):
            stats["hashed"] += 1
            stats["hashedBytes"] += st.st_size
            r = dict(path=p, size=st.st_size, blob_sha1=sha1, sha256=sha256, mode=mode, kind="file")
            # Unsmudged pointer: history blob and worktree bytes are the pointer
            # text; the real object must already sit in .git/lfs/objects.
            if st.st_size < B.POINTER_MAX and B.looks_like_pointer(head):
                parsed = B.parse_pointer(head)
                if not parsed:
                    B.die("worktree file looks like an LFS pointer but does not parse: %r" % p)
                r.update(sha256=parsed[0], size=parsed[1], kind="pointer")
                stats["unsmudgedPointers"] += 1
            rows.append(r)
            new_cache[p] = ((st.st_size, st.st_mtime_ns, st.st_ino), r)
    T.mark("hash")

    cas = dict(linked=0, present=0, uniqueObjects=0, uniqueBytes=0)
    if a.cas:
        seen = set()
        for r in rows:
            if r["kind"] not in ("file", "pointer") or r["sha256"] in seen:
                continue
            seen.add(r["sha256"])
            cas["uniqueObjects"] += 1
            cas["uniqueBytes"] += r["size"]
            dst = B.cas_path(a.cas, r["sha256"])
            if os.path.lexists(dst):
                if os.lstat(dst).st_size != r["size"]:
                    B.die("CAS entry has wrong size: %s" % dst)
                cas["present"] += 1
                continue
            if r["kind"] == "pointer":
                if not a.lfs_objects:
                    B.die("unsmudged pointer %r needs --lfs-objects" % r["path"])
                src = B.cas_path(a.lfs_objects, r["sha256"])
                if not os.path.exists(src) or os.lstat(src).st_size != r["size"]:
                    B.die("LFS object missing or wrong size for %r: %s" % (r["path"], src))
            else:
                src = os.path.join(wt, disk_of[r["path"]])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.link(src, dst)
            cas["linked"] += 1
    T.mark("cas")

    B.write_final_map(a.out, rows)
    save_cache(a.cache, new_cache)
    T.mark("write")

    kinds = {}
    for r in rows:
        kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    rep = dict(stats, rows=len(rows), kinds=kinds, bytes=sum(r["size"] for r in rows if r["kind"] in ("file", "pointer")),
               uniqueSha256=len(set(r["sha256"] for r in rows if r["kind"] in ("file", "pointer"))),
               ignoredLfsFiles=len(ignored), ignoredLfsBytes=ign_bytes,
               ignoredLfsSample=[p.decode("utf-8", "replace") for p in ignored[:20]],
               cas=cas if a.cas else None, seconds=T.marks)
    B.write_json(a.report, rep)
    print("final-map: %d rows, hashed %d (%.2f GB), cache hits %d, CAS linked %d, %.1fs" % (
        len(rows), stats["hashed"], stats["hashedBytes"] / 1e9, stats["cacheHits"], cas["linked"], T.marks["write"]))


if __name__ == "__main__":
    main()

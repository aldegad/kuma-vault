#!/usr/bin/env python3
"""Rewrite pipeline step 2: strip-blob-ids.txt — history binaries whose path is dropped.

A blob is stripped when it sits at an LFS-extension path (regular file mode)
somewhere in history, is not the empty blob, its sha1 is not in final-map, and
it is not an existing LFS pointer whose oid is in final-map (lfsify c). Every
(path, blob) pair comes from `log --all --raw -m --root -z`, so a blob is seen
under every path it ever had. A non-empty blob that appears at both an LFS path
and a non-LFS path aborts the run (must be 0).

  strip_list.py --repo <gitdir> --final-map F --delete-paths D --out strip-blob-ids.txt --report r.json
"""

import argparse
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--final-map", required=True)
    ap.add_argument("--delete-paths", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", required=True)
    a = ap.parse_args()
    T = B.Timer()
    dp = B.DeletePaths(a.delete_paths)
    rows = B.read_final_map(a.final_map)
    fm1 = B.final_map_by_sha1(rows)
    fm256 = set(r["sha256"] for r in rows if r["kind"] in ("file", "pointer"))

    pairs = B.raw_pairs(a.repo, "--all")
    T.mark("pairs")
    lfs_blobs = collections.defaultdict(set)
    text_blobs = set()
    for path, mode, blob in pairs:
        if dp.matches(path):
            continue  # gone with the path; neither stripped nor converted
        if B.is_lfs_path(path) and mode in B.REGULAR_MODES:
            lfs_blobs[blob].add(path)
        else:
            text_blobs.add(blob)
    both = sorted(b for b in set(lfs_blobs) & text_blobs if b != B.EMPTY_BLOB)
    if both:
        B.die("blob(s) at both LFS and non-LFS paths: %s" % b", ".join(both[:10]).decode())

    head = set(oid for _m, oid in B.ls_tree(a.repo, "HEAD").values())
    cands = [b for b in lfs_blobs if b != B.EMPTY_BLOB and b not in fm1]
    sizes = B.batch_sizes(a.repo, cands)
    cat = B.CatFile(a.repo)
    strip, keep_ptr = [], []
    by_ext = collections.Counter()
    by_ext_bytes = collections.Counter()
    hist_ptr = 0
    for b in cands:
        size = sizes[b]
        if size is None:
            B.die("blob missing from repo: %s" % b.decode())
        if size < B.POINTER_MAX:
            _t, data = cat.get(b)
            parsed = B.parse_pointer(data)
            if parsed and parsed[0] in fm256:
                keep_ptr.append(b)
                continue
            if B.looks_like_pointer(data):
                hist_ptr += 1  # history-only LFS file: its object is not in the worktree map
        strip.append(b)
        e = B.ext_of(sorted(lfs_blobs[b])[0])
        by_ext[e] += 1
        by_ext_bytes[e] += size
    cat.close()
    strip.sort()
    with open(a.out + ".tmp", "wb") as f:
        f.write(b"".join(x + b"\n" for x in strip))
    os.replace(a.out + ".tmp", a.out)
    T.mark("done")

    rep = dict(
        lfsPathBlobs=len(lfs_blobs), mappedToPointer=sum(1 for b in lfs_blobs if b in fm1),
        emptyBlobAtLfsPath=B.EMPTY_BLOB in lfs_blobs, keptExistingPointers=len(keep_ptr),
        stripped=len(strip), strippedBytes=sum(sizes[b] for b in strip),
        strippedHistoryOnlyLfsPointers=hist_ptr,
        strippedInHeadTree=sum(1 for b in strip if b in head),
        byExt=[{"ext": e, "count": by_ext[e], "bytes": by_ext_bytes[e]} for e, _ in by_ext_bytes.most_common()],
        seconds=T.marks)
    B.write_json(a.report, rep)
    print("strip: %d blobs, %.3f GB (kept existing pointers %d)" % (len(strip), rep["strippedBytes"] / 1e9,
                                                                    len(keep_ptr)))


if __name__ == "__main__":
    main()

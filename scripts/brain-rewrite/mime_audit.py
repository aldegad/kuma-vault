#!/usr/bin/env python3
"""Re-judge the extension list by content (`file --mime-type`).

Looks at every history blob that ever sat at a non-LFS-extension path and every
non-ignored worktree file outside the list, and reports, per extension, the
files whose MIME type is not text-like. Anything binary outside the list means
the list needs that extension (or the file is junk); the report is the input
for that decision, it changes nothing.

  mime_audit.py --repo <gitdir with all history> --worktree W --delete-paths D --tmp DIR --report r.json
"""

import argparse
import collections
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402

HEAD_BYTES = 1 << 16
TEXTLIKE = {"application/json", "application/javascript", "application/xml", "image/svg+xml", "inode/x-empty",
            "application/x-empty", "application/x-ndjson", "application/csv", "application/x-subrip",
            "application/x-wine-extension-ini", "application/toml", "application/x-yaml", "application/yaml",
            "application/x-ipynb+json", "application/sql", "application/x-shellscript", "application/pgp-keys",
            "application/x-pem-file", "application/mbox"}


def textlike(m):
    return m.startswith("text/") or m.startswith("message/") or m in TEXTLIKE


def mime_of_files(names):
    out = []
    for i in range(0, len(names), 5000):
        chunk = names[i:i + 5000]
        p = subprocess.run(["file", "-b", "--mime-type", "-f", "-"], input=b"\n".join(chunk) + b"\n",
                           stdout=subprocess.PIPE, check=True)
        res = p.stdout.decode("utf-8", "replace").splitlines()
        if len(res) != len(chunk):
            B.die("file(1) returned %d lines for %d names" % (len(res), len(chunk)))
        out += res
    return out


def summarize(items):
    """items: (ext, size, mime, label) for non-text-like content."""
    by = collections.defaultdict(lambda: dict(count=0, bytes=0, mimes=collections.Counter(), sample=[]))
    for ext, size, mime, label in items:
        d = by[ext]
        d["count"] += 1
        d["bytes"] += size
        d["mimes"][mime] += 1
        if len(d["sample"]) < 3:
            d["sample"].append(label)
    res = []
    for ext, d in sorted(by.items(), key=lambda kv: -kv[1]["bytes"]):
        res.append(dict(ext=ext, count=d["count"], bytes=d["bytes"], mimes=dict(d["mimes"].most_common(5)),
                        sample=d["sample"]))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--worktree", required=True)
    ap.add_argument("--delete-paths", required=True)
    ap.add_argument("--tmp", required=True)
    ap.add_argument("--report", required=True)
    a = ap.parse_args()
    T = B.Timer()
    dp = B.DeletePaths(a.delete_paths)

    # history
    blob_path = {}
    for path, mode, blob in B.raw_pairs(a.repo, "--all"):
        if B.is_lfs_path(path) or mode not in B.REGULAR_MODES or dp.matches(path) or blob == B.EMPTY_BLOB:
            continue
        blob_path.setdefault(blob, path)
    shutil.rmtree(a.tmp, ignore_errors=True)
    os.makedirs(a.tmp)
    sizes = B.batch_sizes(a.repo, blob_path)
    cat = B.CatFile(a.repo)
    names = []
    for blob in blob_path:
        _t, data = cat.get(blob)
        fn = os.path.join(os.fsencode(a.tmp), blob)
        with open(fn, "wb") as f:
            f.write(data[:HEAD_BYTES])
        names.append(fn)
    cat.close()
    mimes = mime_of_files(names)
    hist = []
    for blob, mime in zip(blob_path, mimes):
        if not textlike(mime):
            p = blob_path[blob]
            hist.append((B.ext_of(p), sizes[blob], mime, p.decode("utf-8", "replace")))
    shutil.rmtree(a.tmp)
    T.mark("history")

    # worktree
    wt = os.fsencode(os.path.abspath(a.worktree))
    files = []
    for p in sorted(set(B.split_z(B.git(a.worktree, "ls-files", "-z", "--cached", "--others", "--exclude-standard")))):
        if B.is_lfs_path(p) or dp.matches(p) or b"\n" in p:
            continue
        full = os.path.join(wt, p)
        if os.path.isfile(full) and not os.path.islink(full) and os.path.getsize(full) > 0:
            files.append((p, full))
    wmimes = mime_of_files([f for _p, f in files])
    wt_items = []
    for (p, full), mime in zip(files, wmimes):
        if not textlike(mime):
            wt_items.append((B.ext_of(p), os.path.getsize(full), mime, p.decode("utf-8", "replace")))
    T.mark("worktree")

    rep = dict(historyBlobsChecked=len(blob_path), worktreeFilesChecked=len(files),
               historyNonText=summarize(hist), worktreeNonText=summarize(wt_items), seconds=T.marks)
    B.write_json(a.report, rep)
    print("mime audit: history %d blobs (%d non-text), worktree %d files (%d non-text)" % (
        len(blob_path), len(hist), len(files), len(wt_items)))


if __name__ == "__main__":
    main()

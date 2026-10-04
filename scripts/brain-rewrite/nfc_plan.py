#!/usr/bin/env python3
"""List the deletions the NFC rewrite must drop (see brainrw.twin_kept_deletes).

Each line: <old commit sha> TAB <NFC path>. attrs.py reads it during filter-repo
(BRW_RUN/nfc-keep.tsv); tail_replay.py applies the same rule on its own.
Changes are taken against the first parent, the way fast-export emits them.

  nfc_plan.py --repo <gitdir> --out nfc-keep.tsv
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()
out = B.git(a.repo, "log", "--all", "--raw", "-z", "--no-abbrev", "--no-renames", "--root",
            "--diff-merges=first-parent", "--format=%x00@%H")
deleted, cur = {}, None
toks = out.split(b"\0")
i = 0
while i < len(toks):
    t = toks[i].lstrip(b"\n")
    if t.startswith(b"@"):
        cur = t[1:]
        i += 1
    elif t.startswith(b":"):
        if t.split(b" ")[4][:1] == b"D":
            deleted.setdefault(cur, []).append(toks[i + 1])
        i += 2
    else:
        i += 1
rows = []
for commit, paths in deleted.items():
    for p in sorted(B.twin_kept_deletes(a.repo, commit, paths)):
        rows.append(commit + b"\t" + p + b"\n")
with open(a.out + ".tmp", "wb") as f:
    f.writelines(rows)
os.replace(a.out + ".tmp", a.out)
print("nfc plan: %d deletions kept" % len(rows))

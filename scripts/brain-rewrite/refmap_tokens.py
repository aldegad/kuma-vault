#!/usr/bin/env python3
"""Distinct sha-like tokens in a work tree's tracked text files — the same scan as
`vault migrate refmap` (word-bounded [0-9a-f]{7,40}; LFS-extension paths and files
with a NUL in the first 8000 bytes skipped). Feeds other_repo_prefixes.py.

  refmap_tokens.py --repo TREE --out tokens.txt
"""

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402

TOKEN = re.compile(rb"(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?![0-9A-Za-z_])")
ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()
root = os.fsencode(os.path.abspath(a.repo))
tokens = set()
for rec in B.split_z(B.git(a.repo, "ls-files", "-s", "-z")):
    meta, path = rec.split(b"\t", 1)
    if meta.split(b" ")[0] not in B.REGULAR_MODES or B.is_lfs_path(path):
        continue
    full = os.path.join(root, path)
    if not os.path.isfile(full) or os.path.islink(full):
        continue
    data = open(full, "rb").read()
    if b"\0" in data[:8000]:
        continue
    tokens.update(TOKEN.findall(data))
with open(a.out, "wb") as f:
    f.write(b"".join(t + b"\n" for t in sorted(tokens)))
print("refmap tokens: %d distinct" % len(tokens))

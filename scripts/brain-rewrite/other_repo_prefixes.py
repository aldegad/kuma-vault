#!/usr/bin/env python3
"""Tokens that resolve to a commit (or are ambiguous) in another repository.

Input: a token list (one 7-40 hex token per line, e.g. extracted where the vault
text lives) and a file listing git dirs. Output: `<token> TAB <git dir>` lines —
the format `vault migrate refmap --other-repo-prefixes` reads. Only runs
`git cat-file --batch-check` in each repo, so it is light enough to run where
those repositories are (the client) without reading the vault itself.

  other_repo_prefixes.py --tokens tokens.txt --repos repos.txt --out prefixes.tsv
"""

import argparse
import os
import subprocess

ap = argparse.ArgumentParser()
ap.add_argument("--tokens", required=True)
ap.add_argument("--repos", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()
tokens = sorted(set(l.split()[0] for l in open(a.tokens) if l.strip() and not l.startswith("#")))
repos = [os.path.expanduser(l.strip()) for l in open(a.repos) if l.strip() and not l.startswith("#")]
hits = {}
for repo in repos:
    p = subprocess.run(["git", "--no-optional-locks", "--git-dir", repo, "cat-file",
                        "--batch-check=%(objectname) %(objecttype)"],
                       input="\n".join(tokens) + "\n", capture_output=True, text=True, check=True,
                       env=dict(os.environ, GIT_NO_REPLACE_OBJECTS="1"))
    for token, line in zip(tokens, p.stdout.splitlines()):
        if line.endswith(" ambiguous") or line.endswith(" commit"):
            hits.setdefault(token, repo)
with open(a.out, "w") as f:
    f.write("# tokens that resolve to a commit (or are ambiguous) in another repository\n")
    for token in sorted(hits):
        f.write("%s\t%s\n" % (token, hits[token]))
print("other-repo prefixes: %d of %d tokens, %d repos" % (len(hits), len(tokens), len(repos)))

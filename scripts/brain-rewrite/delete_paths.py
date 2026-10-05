#!/usr/bin/env python3
"""Rewrite pipeline: write delete-paths.txt (junk paths dropped from all history) and
report which rules actually match in history, HEAD and the worktree.

The generic rule set is fixed here; repo-specific junk paths come from
--extra-rules (one filter-repo path rule per line, `# label` comment lines
before a rule name it), kept with the repo's own records rather than here. The derived graph cache sits in the
vault tree (--tree, default vault; empty when the tree is the repository root).
Rules that match nothing stay in the file so a junk path committed after the
rehearsal snapshot is still dropped at cutover. The report is the confirmation
against history.

  delete_paths.py --repo <worktree or gitdir> [--worktree <dir>] [--tree vault|""] [--extra-rules F] --out delete-paths.txt --report r.json
"""

import argparse
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402

# Junk = the server's receive rule 6 list (lfs-extensions.json junkPatterns), so a
# rewritten history passes that rule by construction; plus the derived graph cache.
JUNK_RULES = [("junk %s" % p, ("regex:" + B.gitignore_regex(p)).encode()) for p in B.JUNK_PATTERNS]


def rules_for(tree):
    graph = (tree.strip("/") + "/.graph/") if tree.strip("/") else ".graph/"
    return JUNK_RULES + [("%s (derived)" % graph, b"literal:" + graph.encode())]


def read_extra(fn):
    rules, label = [], None
    with open(fn, "rb") as f:
        for line in f:
            line = line.rstrip(b"\r\n")
            if not line:
                continue
            if line.startswith(b"#"):
                label = line[1:].strip().decode("utf-8", "replace")
                continue
            rules.append((label or "extra", line))
            label = None
    return rules


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--worktree")
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--extra-rules")
    ap.add_argument("--tree", default="vault", help="vault tree inside the repository; empty = the repository root")
    a = ap.parse_args()
    rules = rules_for(a.tree) + (read_extra(a.extra_rules) if a.extra_rules else [])
    engine_checked = B.check_engine_lists()

    with open(a.out + ".tmp", "wb") as f:
        f.write(b"# brain rewrite junk paths; git-filter-repo --invert-paths --paths-from-file\n")
        for label, rule in rules:
            f.write(b"# " + label.encode() + b"\n" + rule + b"\n")
    os.replace(a.out + ".tmp", a.out)
    dp = B.DeletePaths(a.out)

    hist = collections.defaultdict(set)
    for path, _mode, _blob in B.raw_pairs(a.repo, "--all"):
        r = dp.rule_for(path)
        if r:
            hist[r].add(path)
    head = collections.defaultdict(set)
    for path in B.ls_tree(a.repo, "HEAD"):
        r = dp.rule_for(path)
        if r:
            head[r].add(path)
    wt = collections.defaultdict(set)
    if a.worktree:
        for path in B.split_z(B.git(a.worktree, "ls-files", "-z", "--cached", "--others")):
            r = dp.rule_for(path)
            if r:
                wt[r].add(path)

    rep = {"rules": []}
    for label, rule in rules:
        rep["rules"].append({
            "label": label, "rule": rule.decode(),
            "historyPaths": len(hist[rule]), "headPaths": len(head[rule]),
            "worktreeNonIgnoredPaths": len(wt[rule]) if a.worktree else None,
            "historySample": sorted(p.decode("utf-8", "replace") for p in hist[rule])[:5],
        })
    rep["historyPathsTotal"] = sum(len(v) for v in hist.values())
    rep["engineListsCompared"] = engine_checked
    B.write_json(a.report, rep)
    print("delete-paths: %d rules, %d history paths match" % (len(rules), rep["historyPathsTotal"]))


if __name__ == "__main__":
    main()

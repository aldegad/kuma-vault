#!/usr/bin/env python3
"""Isolated-copy rule, comparison: content inventory of the original repo, taken
before and after a rehearsal (or around cutover steps 4 and 8).

  (1) .git outside objects/: (path, size, mode, sha256); worktree: (path, size, mode)
      — the worktree is not re-hashed; symlinks record their target
  (2) .git/objects/**: (path, size)
  (3) git --no-optional-locks fsck (--full for the rehearsal, --connectivity-only in the freeze window)
mtimes are recorded in a separate file for information (reflog, COMMIT_EDITMSG,
pack files); they are not part of the verdict, nor are nlink/ctime, which CAS
hardlinks change by design.

  source_inventory.py take    --repo <original> --out PREFIX [--fsck full|connectivity-only|none]
  source_inventory.py compare --before PREFIX1 --after PREFIX2 --report r.json
"""

import argparse
import hashlib
import os
import stat
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402


def esc(p):
    return p.replace(b"\\", b"\\\\").replace(b"\t", b"\\t").replace(b"\n", b"\\n")


def sha256_file(full):
    h = hashlib.sha256()
    with open(full, "rb") as f:
        for buf in iter(lambda: f.read(8 << 20), b""):
            h.update(buf)
    return h.hexdigest().encode()


def take(a):
    T = B.Timer()
    root = os.fsencode(os.path.abspath(a.repo))
    gitdir = os.path.join(root, b".git")
    objdir = os.path.join(gitdir, b"objects")
    content, mtimes = [], []
    n = dict(gitFiles=0, gitBytes=0, worktreeEntries=0, objectFiles=0, objectBytes=0)
    for top, dirs, files in os.walk(root):
        dirs.sort()
        rel_top = os.path.relpath(top, root)
        for name in sorted(dirs + files):
            full = os.path.join(top, name)
            rel = os.path.normpath(os.path.join(rel_top, name)) if rel_top != b"." else name
            st = os.lstat(full)
            mode = b"%o" % st.st_mode
            if full == objdir or full.startswith(objdir + b"/"):
                if stat.S_ISREG(st.st_mode):
                    content.append(b"O\t%d\t%s\t%s" % (st.st_size, mode, esc(rel)))
                    n["objectFiles"] += 1
                    n["objectBytes"] += st.st_size
                else:
                    content.append(b"O\t-\t%s\t%s" % (mode, esc(rel)))
            elif full == gitdir or full.startswith(gitdir + b"/"):
                if stat.S_ISREG(st.st_mode):
                    content.append(b"G\t%d\t%s\t%s\t%s" % (st.st_size, mode, sha256_file(full), esc(rel)))
                    n["gitFiles"] += 1
                    n["gitBytes"] += st.st_size
                elif stat.S_ISLNK(st.st_mode):
                    content.append(b"G\t-\t%s\tlink:%s\t%s" % (mode, esc(os.readlink(full)), esc(rel)))
                else:
                    content.append(b"G\t-\t%s\t-\t%s" % (mode, esc(rel)))
            else:
                n["worktreeEntries"] += 1
                if stat.S_ISREG(st.st_mode):
                    content.append(b"W\t%d\t%s\t%s" % (st.st_size, mode, esc(rel)))
                elif stat.S_ISLNK(st.st_mode):
                    content.append(b"W\t-\t%s\tlink:%s\t%s" % (mode, esc(os.readlink(full)), esc(rel)))
                else:
                    content.append(b"W\t-\t%s\t%s" % (mode, esc(rel)))
            if not stat.S_ISDIR(st.st_mode) and (full.startswith(gitdir + b"/")):
                mtimes.append(b"%d\t%s" % (st.st_mtime_ns, esc(rel)))
    T.mark("walk")
    with open(a.out + ".content.tsv", "wb") as f:
        f.write(b"\n".join(content) + b"\n")
    with open(a.out + ".git-mtimes.tsv", "wb") as f:
        f.write(b"\n".join(mtimes) + b"\n")
    fsck = None
    if a.fsck != "none":
        args = ["git", "--no-optional-locks", "-C", a.repo, "fsck"] + (["--full"] if a.fsck == "full" else
                                                                       ["--connectivity-only"])
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=B.GIT_ENV)
        with open(a.out + ".fsck.txt", "wb") as f:
            f.write(p.stdout)
        lines = p.stdout.decode("utf-8", "replace").splitlines()
        fsck = dict(mode=a.fsck, rc=p.returncode,
                    problemLines=sum(1 for l in lines if l and not l.startswith(("Checking", "dangling"))),
                    dangling=sum(1 for l in lines if l.startswith("dangling")))
    T.mark("fsck")
    B.write_json(a.out + ".json", dict(n, repo=a.repo, fsck=fsck, seconds=T.marks))
    print("inventory %s: %s fsck=%s" % (a.out, n, fsck))


def compare(a):
    def lines(fn):
        with open(fn, "rb") as f:
            return f.read().splitlines()
    rep = {}
    cb, ca = lines(a.before + ".content.tsv"), lines(a.after + ".content.tsv")
    sb, sa = set(cb), set(ca)
    rep["contentIdentical"] = cb == ca
    rep["contentOnlyBefore"] = len(sb - sa)
    rep["contentOnlyAfter"] = len(sa - sb)
    rep["contentDiffSample"] = [l.decode("utf-8", "replace") for l in sorted(sb ^ sa)[:20]]
    mb, ma = lines(a.before + ".git-mtimes.tsv"), lines(a.after + ".git-mtimes.tsv")
    rep["gitMtimesIdentical"] = mb == ma
    rep["gitMtimeDiffSample"] = [l.decode("utf-8", "replace") for l in sorted(set(mb) ^ set(ma))[:20]]
    jb, ja = B.load_json(a.before + ".json"), B.load_json(a.after + ".json")
    fb, fa = jb.get("fsck"), ja.get("fsck")
    rep["fsckBefore"], rep["fsckAfter"] = fb, fa
    out_same = None
    if fb and fa:
        out_same = open(a.before + ".fsck.txt", "rb").read() == open(a.after + ".fsck.txt", "rb").read()
    rep["fsckOutputIdentical"] = out_same
    rep["ok"] = bool(rep["contentIdentical"] and fb and fa and fb["rc"] == 0 and fa["rc"] == 0
                     and fb["problemLines"] == 0 and fa["problemLines"] == 0 and out_same)
    B.write_json(a.report, rep)
    print("source compare: content %s, git mtimes %s, fsck %s/%s -> %s" % (
        rep["contentIdentical"], rep["gitMtimesIdentical"], fb and fb["rc"], fa and fa["rc"],
        "OK" if rep["ok"] else "FAIL"))
    sys.exit(0 if rep["ok"] else 1)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("take")
    t.add_argument("--repo", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--fsck", choices=["full", "connectivity-only", "none"], default="full")
    c = sub.add_parser("compare")
    c.add_argument("--before", required=True)
    c.add_argument("--after", required=True)
    c.add_argument("--report", required=True)
    a = ap.parse_args()
    take(a) if a.cmd == "take" else compare(a)


if __name__ == "__main__":
    main()

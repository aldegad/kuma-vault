#!/usr/bin/env python3
"""Rewrite pipeline step 5: pointer commit P on top of the rewritten branch.

Every final-map path gets its pointer (size 0: the empty blob; symlink: its
link blob); an LFS-extension path in the rewritten HEAD tree that final-map
does not have is removed. Built in a temporary index (read-tree, update-index
--index-info, write-tree, commit-tree), so no worktree is involved.

The rewritten history keeps the old branch name (master); the server
branch is main. --branch moves the ref and HEAD to it.

  pointer_commit.py --gitdir src.git --final-map F --run RUN --source-branch master --branch main --report r.json
"""

import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gitdir", required=True)
    ap.add_argument("--final-map", required=True)
    ap.add_argument("--run", required=True)
    ap.add_argument("--source-branch", default="master")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--worktree", help="old worktree, only to read LFS-extension symlinks missing from the repo")
    ap.add_argument("--author", default="kuma-vault migrate <kuma-vault@localhost>")
    ap.add_argument("--report", required=True)
    a = ap.parse_args()
    T = B.Timer()
    g = a.gitdir
    head = B.git(g, "rev-parse", "--verify", "refs/heads/%s^{commit}" % a.source_branch).strip()
    tree = B.ls_tree(g, head.decode())
    rows = B.read_final_map(a.final_map)

    want = {}
    pointer_texts = {}
    for r in rows:
        if r["kind"] == "symlink":
            want[r["path"]] = (b"120000", r["blob_sha1"])
        elif r["kind"] == "empty":
            want[r["path"]] = (r["mode"], B.EMPTY_BLOB)
        else:
            data = B.pointer_bytes(r["sha256"], r["size"])
            oid = B.git_blob_sha1(data)
            pointer_texts[oid] = data
            want[r["path"]] = (r["mode"], oid)

    # Write pointer blobs the rewrite did not already create.
    sizes = B.batch_sizes(g, list(pointer_texts) + [B.EMPTY_BLOB])
    missing = [oid for oid in pointer_texts if sizes.get(oid) is None]
    if sizes.get(B.EMPTY_BLOB) is None:
        B.hash_object_w(g, b"")
    tmpdir = os.path.join(a.run, "p-pointers.tmp")
    shutil.rmtree(tmpdir, ignore_errors=True)
    os.makedirs(tmpdir)
    names = []
    for oid in missing:
        fn = os.path.join(tmpdir, oid.decode())
        with open(fn, "wb") as f:
            f.write(pointer_texts[oid])
        names.append(fn.encode())
    if names:
        out = B.git(g, "hash-object", "-w", "--no-filters", "--stdin-paths", input=b"\n".join(names) + b"\n")
        got = out.split()
        if got != missing:
            B.die("hash-object returned unexpected ids for pointer blobs")
    shutil.rmtree(tmpdir)
    symlink_blobs = [m_oid[1] for m_oid in want.values() if m_oid[0] == b"120000"]
    missing_links = [oid for oid, size in B.batch_sizes(g, symlink_blobs).items() if size is None]
    if missing_links:
        if not a.worktree:
            B.die("symlink blobs not in repo and no --worktree to read them from: %d" % len(missing_links))
        for path, (mode, oid) in want.items():
            if mode == b"120000" and oid in missing_links:
                target = os.readlink(os.path.join(os.fsencode(a.worktree), path))
                if B.hash_object_w(g, target) != oid:
                    B.die("symlink changed since final-map: %r" % path)
    T.mark("blobs")

    lines, A, M, Dl = [], 0, 0, 0
    for path, (mode, oid) in sorted(want.items()):
        cur = tree.get(path)
        if cur is None:
            A += 1
        elif cur != (mode, oid):
            M += 1
        else:
            continue
        lines.append(mode + b" " + oid + b"\t" + path)
    for path, (mode, oid) in sorted(tree.items()):
        if B.is_lfs_path(path) and path not in want and (mode in B.REGULAR_MODES or mode == b"120000"):
            Dl += 1
            lines.append(b"0 " + b"0" * 40 + b"\t" + path)

    env = dict(B.GIT_ENV, GIT_INDEX_FILE=os.path.abspath(os.path.join(a.run, "p-index")))
    name, email = a.author.rsplit(" <", 1)
    env.update(GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email.rstrip(">"),
               GIT_COMMITTER_NAME=name, GIT_COMMITTER_EMAIL=email.rstrip(">"))
    if os.path.exists(env["GIT_INDEX_FILE"]):
        os.remove(env["GIT_INDEX_FILE"])
    B.git(g, "read-tree", head.decode(), env=env)
    B.git(g, "update-index", "-z", "--index-info", input=b"".join(l + b"\0" for l in lines), env=env)
    new_tree = B.git(g, "write-tree", env=env).strip()
    os.remove(env["GIT_INDEX_FILE"])
    msg = "vault-migrate: binaries as LFS pointers (%d added, %d changed, %d removed)\n" % (A, M, Dl)
    p = B.git(g, "commit-tree", new_tree.decode(), "-p", head.decode(), input=msg.encode(), env=env).strip()
    B.git(g, "update-ref", "refs/heads/" + a.branch, p.decode())
    B.git(g, "symbolic-ref", "HEAD", "refs/heads/" + a.branch)
    if a.branch != a.source_branch:
        B.git(g, "update-ref", "-d", "refs/heads/" + a.source_branch, head.decode())
    T.mark("commit")
    rep = dict(headFinalNew=head.decode(), p=p.decode(), tree=new_tree.decode(), added=A, changed=M, removed=Dl,
               pointerBlobsWritten=len(missing), finalMapRows=len(rows), branch=a.branch,
               movedFrom=a.source_branch, seconds=T.marks)
    B.write_json(a.report, rep)
    print("P %s (A %d, M %d, D %d) on refs/heads/%s" % (p.decode(), A, M, Dl, a.branch))


if __name__ == "__main__":
    main()

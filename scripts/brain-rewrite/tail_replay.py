#!/usr/bin/env python3
"""Tail replay: replay old commits S..HEAD_final onto a repo already
rewritten up to S, with the same rules as the filter-repo run (delete-paths,
lfsify 0/a/b/c, attrs), without filter-repo.

Per commit (oldest first): new parents = commit-map[old parents]; a temporary
index is filled from the new first parent's tree; the old commit's changes
against its old first parent (`diff-tree -r --no-renames`) are applied under the
rules; write-tree; commit-tree with the original author, committer, dates and
message bytes. commit-map and refs/replace/<old> get the new entry; the branch
ref moves to the last new commit.

Old commits are read from --old-gitdir with --no-optional-locks only.

  tail_replay.py --old-gitdir OLD --gitdir NEW --run RUN --from S --to HEAD_final --branch master \
      [--check-against FULL/filter-repo/commit-map] --report r.json
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402


def parse_commit(raw):
    head, _sep, msg = raw.partition(b"\n\n")
    hdr = {"parent": []}
    for line in head.split(b"\n"):
        k, _s, v = line.partition(b" ")
        if k == b"parent":
            hdr["parent"].append(v)
        elif k in (b"tree", b"author", b"committer"):
            hdr[k.decode()] = v
        else:
            B.die("commit header %r is not supported by tail replay (filter-repo would rewrite it)" % k)
    return hdr, msg


def ident(v):
    # "Name <email> 1690000000 +0900"
    lt = v.index(b" <")
    gt = v.index(b"> ", lt)
    return v[:lt], v[lt + 2:gt], v[gt + 2:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old-gitdir", required=True)
    ap.add_argument("--gitdir", required=True)
    ap.add_argument("--run", required=True)
    ap.add_argument("--from", dest="frm", required=True, help="old commit S already rewritten in --gitdir")
    ap.add_argument("--to", required=True, help="old commit to replay up to (HEAD_final)")
    ap.add_argument("--branch", default="master")
    ap.add_argument("--check-against")
    ap.add_argument("--report", required=True)
    a = ap.parse_args()
    T = B.Timer()
    old, g = a.old_gitdir, a.gitdir
    dp = B.DeletePaths(os.path.join(a.run, "delete-paths.txt"))
    strip = B.read_strip(os.path.join(a.run, "strip-blob-ids.txt"))
    rows = B.read_final_map(os.path.join(a.run, "final-map.tsv"))
    fm1 = B.final_map_by_sha1(rows)
    fm256 = set(r["sha256"] for r in rows if r["kind"] in ("file", "pointer"))
    attrs_blob = open(os.path.join(a.run, "attrs-blob.txt"), "rb").read().strip()
    cmap_file = os.path.join(g, "filter-repo", "commit-map")
    cmap = {}
    with open(cmap_file, "rb") as f:
        f.readline()
        for line in f:
            o, n = line.split()
            cmap[o] = n
    frm = B.git(old, "rev-parse", "--verify", a.frm + "^{commit}").strip()
    to = B.git(old, "rev-parse", "--verify", a.to + "^{commit}").strip()
    if frm not in cmap:
        B.die("--from %s is not in %s" % (frm.decode(), cmap_file))
    todo = B.git(old, "rev-list", "--reverse", "--topo-order", "%s..%s" % (frm.decode(), to.decode())).split()
    sizes_old = {}
    cat_old = B.CatFile(old)
    ptr_blob = {}
    merged_attrs = {}
    env = dict(B.GIT_ENV, GIT_INDEX_FILE=os.path.abspath(os.path.join(a.run, "tail-index")))
    stats = dict(commits=0, pointer=0, strip=0, empty=0, existingPointer=0, deletePathSkipped=0, attrs=0,
                 nfcDeletesKept=0)

    def lfs_target(path, mode, blob):
        """None = remove the path; else (mode, blob) — same decisions as lfsify.py."""
        if mode not in B.REGULAR_MODES:
            return mode, blob
        if blob == B.EMPTY_BLOB:
            stats["empty"] += 1
            return mode, blob
        if blob in strip:
            stats["strip"] += 1
            return None
        hit = fm1.get(blob)
        if hit is not None:
            size, sha256 = hit
            if sha256 not in ptr_blob:
                ptr_blob[sha256] = B.hash_object_w(g, B.pointer_bytes(sha256, size))
            stats["pointer"] += 1
            return mode, ptr_blob[sha256]
        if blob not in sizes_old:
            sizes_old.update(B.batch_sizes(old, [blob]))
        if sizes_old[blob] < B.POINTER_MAX:
            parsed = B.parse_pointer(cat_old.get(blob)[1])
            if parsed and parsed[0] in fm256:
                stats["existingPointer"] += 1
                return mode, blob
        B.die("tail replay: unclassified LFS-path blob %s at %r" % (blob.decode(), path))

    new_of = {}
    for c in todo:
        _t, raw = cat_old.get(c)
        hdr, msg = parse_commit(raw)
        parents = hdr["parent"]
        try:
            new_parents = [new_of.get(p) or cmap[p] for p in parents]
        except KeyError as e:
            B.die("tail replay: parent %s of %s has no mapping" % (e.args[0].decode(), c.decode()))
        if os.path.exists(env["GIT_INDEX_FILE"]):
            os.remove(env["GIT_INDEX_FILE"])
        if new_parents:
            B.git(g, "read-tree", new_parents[0].decode(), env=env)
            diff_args = [parents[0].decode(), c.decode()]
        else:
            B.git(g, "read-tree", "--empty", env=env)
            diff_args = ["--root", c.decode()]
        out = B.git(old, "diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", *diff_args)
        toks = B.split_z(out)
        # Keyed by NFC path like attrs.py; when two old names
        # meet, a change beats a deletion and two different changes abort — the same
        # rules filter-repo applies to colliding renamed paths.
        changes = {}
        DEL = (b"0", b"0" * 40)

        def put(path, entry):
            cur = changes.get(path)
            if cur is not None and cur != entry and entry != DEL and cur != DEL:
                B.die("tail replay: colliding NFC path %r in %s" % (path, c.decode()))
            if cur is None or cur == DEL:
                changes[path] = entry

        kept = B.twin_kept_deletes(old, c, [toks[j + 1] for j in range(0, len(toks), 2)
                                            if toks[j].lstrip(b":").split(b" ")[4][:1] == b"D"])
        i = 0
        while i < len(toks):
            meta = toks[i].lstrip(b":").split(b" ")
            raw_path = toks[i + 1]
            i += 2
            status = meta[4][:1]
            if dp.matches(raw_path):
                stats["deletePathSkipped"] += 1
                continue
            path = B.nfc(raw_path)
            if path == b".gitattributes":
                stats["attrs"] += 1
                if status == b"D":
                    put(path, (b"100644", attrs_blob))
                else:
                    if meta[3] not in merged_attrs:
                        merged_attrs[meta[3]] = B.hash_object_w(g, B.merged_attrs_bytes(cat_old.get(meta[3])[1]))
                    put(path, (meta[1], merged_attrs[meta[3]]))
                continue
            if status == b"D":
                if path in kept:
                    stats["nfcDeletesKept"] += 1
                else:
                    put(path, DEL)
                continue
            mode, blob = meta[1], meta[3]
            if B.is_lfs_path(path):
                t = lfs_target(path, mode, blob)
                if t is None:
                    put(path, DEL)
                    continue
                mode, blob = t
            put(path, (mode, blob))
        lines = [m + b" " + o + b"\t" + p for p, (m, o) in sorted(changes.items())]
        if not new_parents:
            lines.append(b"100644 " + attrs_blob + b"\t.gitattributes")
        if lines:
            B.git(g, "update-index", "-z", "--index-info", input=b"".join(l + b"\0" for l in lines), env=env)
        tree = B.git(g, "write-tree", env=env).strip()
        an, ae, ad = ident(hdr["author"])
        cn, ce, cd = ident(hdr["committer"])
        cenv = dict(env, GIT_AUTHOR_NAME=an, GIT_AUTHOR_EMAIL=ae, GIT_AUTHOR_DATE=b"@" + ad,
                    GIT_COMMITTER_NAME=cn, GIT_COMMITTER_EMAIL=ce, GIT_COMMITTER_DATE=b"@" + cd)
        cenv = {k: (v.decode("utf-8", "surrogateescape") if isinstance(v, bytes) else v) for k, v in cenv.items()}
        pargs = []
        for p in new_parents:
            pargs += ["-p", p.decode()]
        new = B.git(g, "commit-tree", tree.decode(), *pargs, input=msg, env=cenv).strip()
        new_of[c] = new
        stats["commits"] += 1
    cat_old.close()
    if os.path.exists(env["GIT_INDEX_FILE"]):
        os.remove(env["GIT_INDEX_FILE"])
    T.mark("replay")

    with open(cmap_file, "ab") as f:
        for c in todo:
            f.write(c + b" " + new_of[c] + b"\n")
    refs = b"".join(b"update refs/replace/" + c + b" " + new_of[c] + b"\n" for c in todo)
    if todo:
        refs += b"update refs/heads/" + a.branch.encode() + b" " + new_of[todo[-1]] + b"\n"
    B.git(g, "update-ref", "--stdin", input=refs)
    T.mark("refs")

    rep = dict(stats, fromOld=frm.decode(), toOld=to.decode(), tailCommits=len(todo),
               tipNew=new_of[todo[-1]].decode() if todo else None, seconds=T.marks)
    if a.check_against:
        full = {}
        with open(a.check_against, "rb") as f:
            f.readline()
            for line in f:
                o, n = line.split()
                full[o] = n
        diff = [c.decode() for c in todo if full.get(c) != new_of[c]]
        rep.update(checkedAgainst=a.check_against, shaMismatches=len(diff), mismatchSample=diff[:10],
                   allEqual=not diff)
    B.write_json(a.report, rep)
    print("tail replay: %d commits%s" % (len(todo), "" if not a.check_against else
                                         ", sha mismatches %d" % rep["shaMismatches"]))
    if a.check_against and rep["shaMismatches"]:
        sys.exit(1)


if __name__ == "__main__":
    main()

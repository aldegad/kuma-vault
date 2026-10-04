#!/usr/bin/env python3
"""Rewrite pipeline step 7: checks 7a-7d. Exit 1 on the first failed check group.

  verify.py fsck   --gitdir src.git --report 7a.json
  verify.py trees  --gitdir src.git --old-gitdir OLD --old-worktree OLDWT --run RUN --p-ref refs/heads/main --report 7b.json
  verify.py cas    --gitdir src.git --run RUN --cas CAS --report 7c.json
  verify.py sizes  --gitdir src.git --run RUN --cas CAS --report 7d.json

7a needs the new repo with no alternates. 7b reads old trees from OLD (with
--no-optional-locks) and checks the freeze pathspec is clean in OLDWT.
"""

import argparse
import hashlib
import os
import random
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402


def read_commit_map(gitdir):
    m = {}
    with open(os.path.join(gitdir, "filter-repo", "commit-map"), "rb") as f:
        f.readline()
        for line in f:
            old, new = line.split()
            m[old] = new
    return m


def cmd_fsck(a):
    alt = os.path.join(a.gitdir, "objects", "info", "alternates")
    if os.path.exists(alt):
        B.die("7a: %s still exists — run 4' first" % alt)
    p = subprocess.run(["git", "-C", a.gitdir, "fsck", "--full", "--strict"], stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, env=B.GIT_ENV)
    out = p.stdout.decode("utf-8", "replace")
    bad = [l for l in out.splitlines() if l and not l.startswith(("Checking", "dangling"))]
    rep = dict(rc=p.returncode, problemLines=len(bad), sample=bad[:20],
               dangling=sum(1 for l in out.splitlines() if l.startswith("dangling")))
    B.write_json(a.report, rep)
    print("7a fsck --full rc=%d problems=%d" % (p.returncode, len(bad)))
    return p.returncode == 0 and not bad


def tree_check(old_raw, new, ptr_of, attrs_of, dp, strip, fm1, fm256, attrs_blob, errs, label):
    # Old entries: drop delete-paths and stripped LFS blobs, then key by NFC path
    # (attrs.py); names that meet must carry the same entry.
    old = {}
    for path, (mode, oid) in old_raw.items():
        if dp.matches(path):
            continue
        if B.is_lfs_path(path) and mode in B.REGULAR_MODES and oid in strip:
            continue
        key = B.nfc(path)
        if key in old and old[key] != (mode, oid):
            errs.append("%s: two old names for NFC path %r differ" % (label, key))
            return
        old[key] = (mode, oid)
    expected = set(old)
    expected.add(b".gitattributes")
    got = set(new)
    if got != expected:
        errs.append("%s: path sets differ (+%d -%d) e.g. +%r -%r" % (
            label, len(got - expected), len(expected - got), sorted(got - expected)[:3], sorted(expected - got)[:3]))
        return
    for path in expected:
        nm, nb = new[path]
        if path == b".gitattributes" and path not in old:
            if nb != attrs_blob:
                errs.append("%s: root .gitattributes is not the generated blob" % label)
            continue
        om, ob = old[path]
        if path == b".gitattributes":
            if nb != attrs_of(ob):
                errs.append("%s: root .gitattributes is not old version + generated block" % label)
            continue
        if nm != om:
            errs.append("%s: mode changed %r" % (label, path))
            continue
        if B.is_lfs_path(path) and om in B.REGULAR_MODES:
            if ob == B.EMPTY_BLOB:
                ok = nb == B.EMPTY_BLOB
            elif ob in fm1:
                size, sha256 = fm1[ob]
                ok = ptr_of(nb) == (sha256, size)
            else:
                parsed = ptr_of(ob) if nb == ob else None
                ok = parsed is not None and parsed[0] in fm256
            if not ok:
                errs.append("%s: LFS path %r not converted as expected" % (label, path))
        elif nb != ob:
            errs.append("%s: blob changed %r" % (label, path))


def non_nfc_commits(gitdir, tip):
    """Commits whose own changes touch a path that is not NFC (always checked in 7b)."""
    out = B.git(gitdir, "log", "--raw", "-z", "--no-abbrev", "--no-renames", "-m", "--root",
                "--format=%x00@%H", tip.decode())
    res, cur = [], None
    for t in out.split(b"\0"):
        t = t.lstrip(b"\n")
        if t.startswith(b"@"):
            cur = t[1:]
        elif t and not t.startswith(b":") and cur and B.nfc(t) != t:
            if not res or res[-1] != cur:
                res.append(cur)
    return res


def freeze_status(worktree):
    """Entries of `git status` under the freeze pathspec that are real changes.

    On the Linux server a file whose tracked name is NFC (macOS index) but whose
    on-disk name is decomposed shows as a deleted tracked name plus an untracked
    name. Such a pair is not a change when the untracked file's bytes equal the
    tracked blob; any other entry is.
    """
    out = B.git(worktree, "status", "--porcelain", "-z", "--untracked-files=all", "--", *B.freeze_pathspec())
    toks = B.split_z(out)
    deleted, untracked, other = {}, {}, []
    i = 0
    while i < len(toks):
        xy, path = toks[i][:2], toks[i][3:]
        i += 2 if xy[:1] in (b"R", b"C") else 1
        if xy == b"??":
            untracked[B.nfc(path)] = path
        elif b"D" in xy and xy.strip(b" D") == b"":
            deleted[B.nfc(path)] = path
        else:
            other.append(toks[i - 1])
    head = B.ls_tree(worktree, "HEAD") if deleted else {}
    pairs = 0
    root = os.fsencode(os.path.abspath(worktree))
    for key in list(deleted):
        u = untracked.get(key)
        if u is None:
            continue
        full = os.path.join(root, u)
        data = os.readlink(full) if os.path.islink(full) else open(full, "rb").read()
        if head.get(deleted[key], (None, None))[1] == B.git_blob_sha1(data):
            del deleted[key], untracked[key]
            pairs += 1
    return other + list(deleted.values()) + list(untracked.values()), pairs


def cmd_trees(a):
    T = B.Timer()
    dp = B.DeletePaths(os.path.join(a.run, "delete-paths.txt"))
    strip = B.read_strip(os.path.join(a.run, "strip-blob-ids.txt"))
    rows = B.read_final_map(os.path.join(a.run, "final-map.tsv"))
    fm1 = B.final_map_by_sha1(rows)
    fm256 = set(r["sha256"] for r in rows if r["kind"] in ("file", "pointer"))
    attrs_blob = open(os.path.join(a.run, "attrs-blob.txt"), "rb").read().strip()
    cmap = read_commit_map(a.gitdir)
    if any(v == b"0" * 40 for v in cmap.values()):
        B.die("7b: commit-map has pruned commits")
    p_sha = B.git(a.gitdir, "rev-parse", "--verify", a.p_ref).strip()
    head_final_new = B.git(a.gitdir, "rev-parse", "--verify", a.p_ref + "^").strip()
    inv = {v: k for k, v in cmap.items()}
    head_final_old = inv.get(head_final_new)
    if head_final_old is None:
        B.die("7b: P's parent is not in commit-map")
    order = B.git(a.old_gitdir, "rev-list", "--reverse", "--topo-order", head_final_old.decode()).split()
    missing = [c for c in order if c not in cmap]
    if missing or len(order) != len(cmap):
        B.die("7b: commit-map does not cover rev-list exactly (%d missing, map %d, rev-list %d)" % (
            len(missing), len(cmap), len(order)))
    rnd = random.Random(a.seed)
    middle = order[50:-50]
    non_nfc = non_nfc_commits(a.old_gitdir, head_final_old)
    sample = list(dict.fromkeys(order[:50] + order[-50:] + rnd.sample(middle, min(200, len(middle))) +
                                [head_final_old] + non_nfc))
    cat = B.CatFile(a.gitdir)
    cache = {}

    def ptr_of(oid):
        if oid not in cache:
            _t, data = cat.get(oid)
            cache[oid] = B.parse_pointer(data) if data is not None else None
        return cache[oid]

    old_cat = B.CatFile(a.old_gitdir)
    attrs_cache = {}

    def attrs_of(oid):
        if oid not in attrs_cache:
            attrs_cache[oid] = B.git_blob_sha1(B.merged_attrs_bytes(old_cat.get(oid)[1]))
        return attrs_cache[oid]

    errs = []
    for old_c in sample:
        tree_check(B.ls_tree(a.old_gitdir, old_c.decode()), B.ls_tree(a.gitdir, cmap[old_c].decode()), ptr_of,
                   attrs_of, dp,
                   strip, fm1, fm256, attrs_blob, errs, "commit " + old_c[:12].decode())
        if len(errs) > 50:
            break
    T.mark("history")

    # P: LFS paths == final-map paths with matching pointers; everything else as in HEAD_final.
    ptree = B.ls_tree(a.gitdir, p_sha.decode())
    htree = B.ls_tree(a.gitdir, head_final_new.decode())
    want = {r["path"]: r for r in rows}
    p_lfs = {p for p, (m, _o) in ptree.items() if B.is_lfs_path(p) and (m in B.REGULAR_MODES or m == b"120000")}
    if p_lfs != set(want):
        errs.append("P: LFS path set != final-map (+%d -%d)" % (len(p_lfs - set(want)), len(set(want) - p_lfs)))
    for path in p_lfs & set(want):
        r, (m, o) = want[path], ptree[path]
        if r["kind"] == "symlink":
            ok = m == b"120000" and o == r["blob_sha1"]
        elif r["kind"] == "empty":
            ok = o == B.EMPTY_BLOB and m == r["mode"]
        else:
            ok = m == r["mode"] and ptr_of(o) == (r["sha256"], r["size"])
        if not ok:
            errs.append("P: %r does not match final-map" % path)
            if len(errs) > 50:
                break
    rest_p = {p: v for p, v in ptree.items() if p not in p_lfs}
    rest_h = {p: v for p, v in htree.items() if not (B.is_lfs_path(p) and (v[0] in B.REGULAR_MODES or v[0] == b"120000"))}
    if rest_p != rest_h:
        errs.append("P: non-LFS entries differ from HEAD_final (%d paths)" % len(set(rest_p.items()) ^ set(rest_h.items())))
    cat.close()
    old_cat.close()
    T.mark("p")

    dirty, nfc_pairs = freeze_status(a.old_worktree)
    if dirty:
        errs.append("old worktree: freeze pathspec not clean (%d entries) e.g. %r" % (len(dirty), dirty[:3]))
    T.mark("status")
    rep = dict(ok=not errs, sampledCommits=len(sample), totalCommits=len(order), seed=a.seed, errors=errs[:50],
               p=p_sha.decode(), headFinalNew=head_final_new.decode(), headFinalOld=head_final_old.decode(),
               nonNfcCommits=len(non_nfc), pLfsPaths=len(p_lfs), freezeStatusEntries=len(dirty), freezeStatusNfcPairs=nfc_pairs,
               seconds=T.marks)
    B.write_json(a.report, rep)
    print("7b trees: %d sampled of %d, errors %d" % (len(sample), len(order), len(errs)))
    return not errs


def all_pointer_oids(gitdir):
    """{(oid, size)} of every LFS pointer in the history plus raw LFS-path blobs left (should be none)."""
    blobs = set(b for p, m, b in B.raw_pairs(gitdir, "--all") if B.is_lfs_path(p) and m in B.REGULAR_MODES)
    blobs.discard(B.EMPTY_BLOB)
    sizes = B.batch_sizes(gitdir, blobs)
    cat = B.CatFile(gitdir)
    ptrs, raw = set(), []
    for b in blobs:
        if sizes[b] is not None and sizes[b] < B.POINTER_MAX:
            parsed = B.parse_pointer(cat.get(b)[1])
            if parsed:
                ptrs.add(parsed)
                continue
        raw.append((b, sizes[b]))
    cat.close()
    return ptrs, raw


def cmd_cas(a):
    T = B.Timer()
    rows = B.read_final_map(os.path.join(a.run, "final-map.tsv"))
    fm256 = set(r["sha256"] for r in rows if r["kind"] in ("file", "pointer"))
    ptrs, raw = all_pointer_oids(a.gitdir)
    T.mark("scan")
    errs = []
    if raw:
        errs.append("%d non-pointer blobs left at LFS paths, e.g. %r" % (len(raw), raw[:3]))
    outside = [o for o, _s in ptrs if o not in fm256]
    if outside:
        errs.append("%d pointer oids not in final-map" % len(outside))
    missing = bad_size = 0
    for oid, size in ptrs:
        fn = B.cas_path(a.cas, oid)
        try:
            if os.lstat(fn).st_size != size:
                bad_size += 1
        except FileNotFoundError:
            missing += 1
    if missing or bad_size:
        errs.append("CAS: %d missing, %d wrong size" % (missing, bad_size))
    T.mark("presence")
    rnd = random.Random(a.seed)
    sample = rnd.sample(sorted(ptrs), min(a.sample, len(ptrs)))
    rehash_bad = []
    rehash_bytes = 0
    for oid, size in sample:
        h = hashlib.sha256()
        with open(B.cas_path(a.cas, oid), "rb") as f:
            for buf in iter(lambda: f.read(8 << 20), b""):
                h.update(buf)
        rehash_bytes += size
        if h.hexdigest() != oid:
            rehash_bad.append(oid)
    if rehash_bad:
        errs.append("CAS sha256 mismatch: %d of %d sampled" % (len(rehash_bad), len(sample)))
    T.mark("rehash")
    rep = dict(ok=not errs, pointerOids=len(ptrs), rawLfsBlobsLeft=len(raw), oidsOutsideFinalMap=len(outside),
               casMissing=missing, casWrongSize=bad_size, sampled=len(sample), sampledBytes=rehash_bytes,
               sha256Mismatch=len(rehash_bad), seed=a.seed, errors=errs, seconds=T.marks)
    B.write_json(a.report, rep)
    print("7c cas: %d pointer oids, missing %d, sample %d mismatch %d" % (len(ptrs), missing, len(sample),
                                                                         len(rehash_bad)))
    return not errs


def cmd_sizes(a):
    def load(name):
        fn = os.path.join(a.run, name)
        return B.load_json(fn) if os.path.exists(fn) else None
    cnt = {}
    for line in B.git(a.gitdir, "count-objects", "-v").decode().splitlines():
        k, v = line.split(": ")
        cnt[k] = int(v)
    packs = []
    pdir = os.path.join(a.gitdir, "objects", "pack")
    for n in sorted(os.listdir(pdir)):
        packs.append({"name": n, "bytes": os.lstat(os.path.join(pdir, n)).st_size})
    app, alloc, files = B.du_bytes(a.cas)
    fm = load("final-map.json")
    rep = dict(countObjects=cnt, packFiles=packs, packBytes=sum(p["bytes"] for p in packs),
               cas=dict(files=files, apparentBytes=app, note="hardlinks to worktree inodes: no new blocks"),
               strip=load("strip.json"), pointerCommit=load("pointer-commit.json"), lfsify=load("lfsify-stats.json"),
               attrs=load("attrs-stats.json"),
               ignoredLfs=dict(files=fm["ignoredLfsFiles"], bytes=fm["ignoredLfsBytes"]) if fm else None)
    B.write_json(a.report, rep)
    print("7d sizes: pack %.3f GB, CAS %d files %.2f GB" % (rep["packBytes"] / 1e9, files, app / 1e9))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("check", choices=["fsck", "trees", "cas", "sizes"])
    ap.add_argument("--gitdir", required=True)
    ap.add_argument("--old-gitdir")
    ap.add_argument("--old-worktree")
    ap.add_argument("--run")
    ap.add_argument("--cas")
    ap.add_argument("--p-ref", default="refs/heads/main")
    ap.add_argument("--seed", type=int, default=1003)
    ap.add_argument("--sample", type=int, default=1000)
    ap.add_argument("--report", required=True)
    a = ap.parse_args()
    ok = {"fsck": cmd_fsck, "trees": cmd_trees, "cas": cmd_cas, "sizes": cmd_sizes}[a.check](a)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

"""Shared helpers for the one-time brain history rewrite.

Implements the vault history-rewrite pipeline and its LFS extension list.
Every tool in this directory imports this module so the extension rule, pointer
format, delete-path matching and freeze pathspec have one definition. Paths are bytes end to end and are read with -z, never through
core.quotePath quoting.
"""

import fnmatch
import hashlib
import unicodedata
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

EMPTY_BLOB = b"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1\n"
POINTER_RE = re.compile(rb"\Aversion https://git-lfs\.github\.com/spec/v1\noid sha256:([0-9a-f]{64})\nsize ([0-9]+)\n\Z")
POINTER_MAX = 1024  # lfsify rule c: existing pointers are < 1 KiB
REGULAR_MODES = (b"100644", b"100755")

# Deterministic git: no user/system config (global excludesFile, hooks, lfs
# filters) leaks into the rewrite. Identity for the commits the tools create is
# passed explicitly.
GIT_ENV = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
               GIT_TERMINAL_PROMPT="0", LC_ALL="C")
GIT_ENV.pop("GIT_DIR", None)
GIT_ENV.pop("GIT_INDEX_FILE", None)


def die(msg):
    sys.stderr.write("brain-rewrite: " + msg + "\n")
    sys.exit(1)


# --- extension list -------------------------------------------------------

def load_ext_config():
    with open(os.path.join(HERE, "lfs-extensions.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    exts = cfg["extensions"]
    if len(exts) != len(set(exts)) or any(e != e.lower() or "." in e for e in exts):
        die("lfs-extensions.json: extensions must be unique, lower-case, without dots")
    return cfg


EXT_CONFIG = load_ext_config()
EXTS = tuple(EXT_CONFIG["extensions"])
_SUFFIXES = tuple(b"." + e.encode() for e in EXTS)
JUNK_PATTERNS = tuple(EXT_CONFIG["junkPatterns"])


def check_engine_lists(lfs_paths_mjs=None):
    """Fail when the engine's server list (src/server/lfs-paths.mjs) has drifted from ours.

    The server receive rules and these tools must agree on both lists; the engine file is
    looked up next to this checkout unless a path is given. Absent file = nothing to compare.
    """
    fn = lfs_paths_mjs or os.environ.get("BRW_ENGINE_LFS_PATHS") or \
        os.path.join(HERE, "..", "..", "src", "server", "lfs-paths.mjs")
    if not os.path.exists(fn):
        return False
    src = open(fn, encoding="utf-8").read()

    def array(name):
        m = re.search(name + r"\s*=\s*Object\.freeze\(\[(.*?)\]\)", src, re.S)
        if not m:
            die("%s: %s not found" % (fn, name))
        body = re.sub(r"//[^\n]*", "", m.group(1))
        return tuple(re.findall(r'"([^"]*)"', body))
    if array("LFS_EXTENSIONS") != EXTS:
        die("LFS extension list differs from %s" % fn)
    if array("DEFAULT_JUNK_PATTERNS") != JUNK_PATTERNS:
        die("junk pattern list differs from %s" % fn)
    return True


def gitignore_regex(pattern):
    """filter-repo `regex:` rule for one slash-free gitignore pattern, case-insensitive.

    No slash: matches a basename at any depth, and a matching directory takes its
    contents with it; a trailing slash matches directories only.
    """
    dir_only = pattern.endswith("/")
    core = pattern.rstrip("/")
    if "/" in core or "**" in core or "[" in core:
        die("unsupported junk pattern: %r" % pattern)
    rx = "".join("[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c) for c in core)
    return "(?i)(^|/)" + rx + ("/" if dir_only else "(/|$)")


def nfc(path):
    """NFC form of a UTF-8 path (server receive rule 2). A non-UTF-8 path aborts."""
    if path.isascii():
        return path  # ASCII is always NFC; nearly every path takes this branch
    try:
        s = path.decode("utf-8")
    except UnicodeDecodeError:
        die("path is not UTF-8: %r" % path)
    return unicodedata.normalize("NFC", s).encode("utf-8")


def worktree_paths(root, listed):
    """{nfc path: on-disk relative path} for paths git lists in the worktree at root.

    The server is Linux, where git does not precompose Unicode: the index (made on
    macOS) holds NFC names while files rsync'd from APFS keep their decomposed bytes,
    so one file shows up as a tracked name absent on disk plus an untracked name that
    exists. Both collapse to one NFC key mapped to the name that exists. Two existing
    names with one NFC form cannot come from an APFS source and abort.
    """
    root = os.fsencode(root)
    groups = {}
    for p in listed:
        groups.setdefault(nfc(p), set()).add(p)
    res = {}
    for k, names in groups.items():
        existing = [p for p in names if os.path.lexists(os.path.join(root, p))]
        if len(existing) > 1:
            die("worktree has %d names for one NFC path: %r" % (len(existing), sorted(existing)))
        res[k] = existing[0] if existing else sorted(names)[0]
    return res


def is_lfs_path(path):
    """True when the basename ends in a listed extension, compared lower-case.

    Same rule as the generated `*.[pP][nN][gG]` patterns: `*` may match nothing,
    so a basename of exactly `.png` counts too.
    """
    base = path.rsplit(b"/", 1)[-1].lower()
    return base.endswith(_SUFFIXES)


def ext_of(path):
    base = path.rsplit(b"/", 1)[-1].lower()
    for e in sorted(EXTS, key=len, reverse=True):
        if base.endswith(b"." + e.encode()):
            return e
    i = base.rfind(b".")
    return base[i + 1:].decode("utf-8", "replace") if i > 0 else ""


def _bracket(ext):
    return "".join("[%s%s]" % (c.lower(), c.upper()) if c.isalpha() else c for c in ext)


def gitattributes_text():
    """Root .gitattributes. Generated; the vault setup reads the same JSON."""
    lines = [
        "# kuma-vault: large files are LFS pointers; their bytes live in the server CAS",
        "# Generated file, do not edit by hand. Case-insensitive patterns (same result with core.ignorecase true or false)",
    ]
    lines += ["*.%s filter=lfs diff=lfs merge=lfs -text" % _bracket(e) for e in EXTS]
    lines.append("# Append-only ledgers: merge keeps the additions of both sides")
    lines += ["%s merge=union" % p for p in EXT_CONFIG["unionMerge"]]
    return ("\n".join(lines) + "\n").encode("utf-8")


def freeze_pathspec():
    """Cutover step 3: text-only freeze commit pathspec (also the 7b status check)."""
    spec = ["."]
    spec += [":(exclude,icase)*.%s" % e for e in EXTS]
    spec += [":(exclude)*.DS_Store", ":(exclude)*__pycache__*"]
    return spec


# --- pointers ---------------------------------------------------------------

def pointer_bytes(sha256_hex, size):
    return b"version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %d\n" % (sha256_hex.encode(), size)


def parse_pointer(data):
    """(oid, size) for a canonical LFS pointer, else None."""
    if len(data) >= POINTER_MAX or not data.startswith(POINTER_PREFIX):
        return None
    m = POINTER_RE.match(data)
    if not m:
        return None
    return m.group(1).decode(), int(m.group(2))


def looks_like_pointer(data):
    return len(data) < POINTER_MAX and data.startswith(POINTER_PREFIX)


def git_blob_sha1(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest().encode()


def cas_path(cas_root, sha256_hex):
    return os.path.join(cas_root, sha256_hex[0:2], sha256_hex[2:4], sha256_hex)


# --- delete-paths (same semantics as git-filter-repo --paths-from-file) ------

class DeletePaths:
    def __init__(self, filename):
        self.rules = []
        with open(filename, "rb") as f:
            for line in f:
                line = line.rstrip(b"\r\n")
                if not line or line.startswith(b"#"):
                    continue
                if b"==>" in line:
                    die("delete-paths: renames are not used here: %r" % line)
                if line.startswith(b"regex:"):
                    self.rules.append(("regex", re.compile(line[6:]), line))
                elif line.startswith(b"glob:"):
                    self.rules.append(("glob", line[5:], line))
                else:
                    lit = line[8:] if line.startswith(b"literal:") else line
                    self.rules.append(("literal", lit, line))

    @staticmethod
    def _literal(expr, path):
        n = len(expr)
        return path.startswith(expr) and (expr[n - 1:n] == b"/" or len(path) == n or path[n:n + 1] == b"/")

    def rule_for(self, path):
        for kind, expr, raw in self.rules:
            if kind == "literal" and self._literal(expr, path):
                return raw
            if kind == "glob" and fnmatch.fnmatch(path, expr):
                return raw
            if kind == "regex" and expr.search(path):
                return raw
        return None

    def matches(self, path):
        return self.rule_for(path) is not None


# --- git plumbing -----------------------------------------------------------

def git(where, *args, input=None, env=None, check=True, stderr=None):
    cmd = ["git", "--no-optional-locks", "-c", "core.quotePath=false", "-C", where] + list(args)
    p = subprocess.run(cmd, input=input, stdout=subprocess.PIPE,
                       stderr=stderr if stderr is not None else subprocess.PIPE,
                       env=env or GIT_ENV)
    if check and p.returncode != 0:
        die("git %s failed (rc=%d): %s" % (" ".join(args[:3]), p.returncode,
                                           (p.stderr or b"").decode("utf-8", "replace")[:2000]))
    return p.stdout


def split_z(out):
    parts = out.split(b"\0")
    if parts and parts[-1] == b"":
        parts.pop()
    return parts


def ls_tree(where, rev):
    """{path: (mode, oid)} for every non-tree entry of rev."""
    res = {}
    for rec in split_z(git(where, "ls-tree", "-r", "-z", "--full-tree", rev)):
        meta, path = rec.split(b"\t", 1)
        mode, _typ, oid = meta.split(b" ")
        res[path] = (mode, oid)
    return res


def raw_pairs(where, *revs):
    """Every (path, mode, blob) that any commit reachable from revs introduces.

    log --raw -m --root lists each commit's changes against every parent, so the
    union covers every tree entry of every commit.
    """
    out = git(where, "log", "--raw", "-z", "--no-abbrev", "--no-renames", "-m", "--root",
              "--format=", *(revs or ("--all",)))
    toks = out.split(b"\0")
    pairs = set()
    i = 0
    while i < len(toks):
        t = toks[i].lstrip(b"\n")
        if t.startswith(b":"):
            meta = t[1:].split(b" ")
            status = meta[4][:1]
            path = toks[i + 1]
            if status != b"D":
                pairs.add((path, meta[1], meta[3]))
            i += 2
            continue
        i += 1
    return pairs


class CatFile:
    """Persistent `git cat-file --batch` for small objects."""

    def __init__(self, where):
        self.p = subprocess.Popen(["git", "-C", where, "cat-file", "--batch"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, env=GIT_ENV)

    def get(self, oid):
        self.p.stdin.write(oid + b"\n")
        self.p.stdin.flush()
        header = self.p.stdout.readline()
        if header.endswith(b" missing\n"):
            return None, None
        oid_, typ, size = header.split()
        size = int(size)
        data = self.p.stdout.read(size)
        self.p.stdout.read(1)
        return typ, data

    def close(self):
        self.p.stdin.close()
        self.p.wait()


def batch_sizes(where, oids):
    """{oid: size or None}."""
    oids = list(oids)
    if not oids:
        return {}
    out = git(where, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
              input=b"\n".join(oids) + b"\n")
    res = {}
    for line in out.splitlines():
        parts = line.split(b" ")
        if parts[-1] == b"missing":
            res[parts[0]] = None
        else:
            res[parts[0]] = int(parts[2])
    return res


# --- final-map --------------------------------------------------------------
# Columns: path, size, blob_sha1, sha256, mode, kind. kind is file | pointer
# (the worktree held an unsmudged LFS pointer) | empty | symlink. Paths carrying
# TAB or LF are refused when the map is written, so the TSV stays exact.

FM_HEADER = b"path\tsize\tblob_sha1\tsha256\tmode\tkind\n"


def write_final_map(filename, rows):
    tmp = filename + ".tmp"
    with open(tmp, "wb") as f:
        f.write(FM_HEADER)
        for r in sorted(rows, key=lambda r: r["path"]):
            if b"\t" in r["path"] or b"\n" in r["path"]:
                die("final-map: path with TAB/LF is not supported: %r" % r["path"])
            f.write(b"\t".join([r["path"], str(r["size"]).encode(), r["blob_sha1"], r["sha256"].encode(),
                                r["mode"], r["kind"].encode()]) + b"\n")
    os.replace(tmp, filename)


def read_final_map(filename):
    rows = []
    with open(filename, "rb") as f:
        if f.readline() != FM_HEADER:
            die("final-map: unexpected header in %s" % filename)
        for line in f:
            path, size, sha1, sha256, mode, kind = line.rstrip(b"\n").split(b"\t")
            rows.append({"path": path, "size": int(size), "blob_sha1": sha1, "sha256": sha256.decode(),
                         "mode": mode, "kind": kind.decode()})
    return rows


def final_map_by_sha1(rows):
    """blob_sha1 -> (size, sha256) for rows whose history blob becomes a pointer (lfsify b)."""
    return {r["blob_sha1"]: (r["size"], r["sha256"]) for r in rows if r["kind"] in ("file", "pointer")}


def read_strip(filename):
    with open(filename, "rb") as f:
        return set(l.strip() for l in f if l.strip() and not l.startswith(b"#"))


# --- misc -------------------------------------------------------------------

def load_json(filename):
    with open(filename, encoding="utf-8") as f:
        return json.load(f)


def write_json(filename, obj):
    tmp = filename + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, filename)


class Timer:
    def __init__(self):
        self.t0 = time.time()
        self.marks = {}

    def mark(self, name):
        self.marks[name] = round(time.time() - self.t0, 3)
        return self.marks[name]


def du_bytes(path):
    """(apparent bytes, allocated bytes, files) under path without following links."""
    app = alloc = n = 0
    seen = set()
    for root, dirs, files in os.walk(path):
        for name in files:
            st = os.lstat(os.path.join(root, name))
            n += 1
            app += st.st_size
            key = (st.st_dev, st.st_ino)
            if key not in seen:
                seen.add(key)
                alloc += st.st_blocks * 512
    return app, alloc, n


# --- attrs.py support (commit callback + tail replay share these) -------------

def merged_attrs_bytes(original):
    """A history version of the root .gitattributes with the generated LFS block appended."""
    gen = gitattributes_text()
    if gen in original:
        return original
    if original and not original.endswith(b"\n"):
        original += b"\n"
    return original + gen


def hash_object_w(gitdir, data):
    return git(gitdir, "hash-object", "-w", "--stdin", input=data).strip()


_ATTRS = {}


def attrs_state():
    if not _ATTRS:
        with open(os.path.join(os.environ["BRW_RUN"], "attrs-blob.txt"), "rb") as f:
            _ATTRS["blob"] = f.read().strip()
        _ATTRS["gitdir"] = os.environ["BRW_GITDIR"]
        _ATTRS["stats"] = {"rootAdded": 0, "modifyMerged": 0, "deleteReplaced": 0, "nfcDeletesDropped": 0,
                           "nfcRenamed": 0}
        _ATTRS["nfcKeep"] = {}
        keep_fn = os.path.join(os.environ["BRW_RUN"], "nfc-keep.tsv")
        if os.path.exists(keep_fn):
            for line in open(keep_fn, "rb"):
                c, p = line.rstrip(b"\n").split(b"\t", 1)
                _ATTRS["nfcKeep"].setdefault(c, set()).add(p)
        _ATTRS["merged"] = {}
        import atexit
        atexit.register(lambda: write_json(os.path.join(os.environ["BRW_RUN"], "attrs-stats.json"), _ATTRS["stats"]))
    return _ATTRS


def attrs_merged_blob(blob_id):
    st = attrs_state()
    if blob_id not in st["merged"]:
        orig = git(st["gitdir"], "cat-file", "blob", blob_id.decode())
        st["merged"][blob_id] = hash_object_w(st["gitdir"], merged_attrs_bytes(orig))
    return st["merged"][blob_id]


# --- NFC twins ------------------------------------------------------------------

def twin_kept_deletes(where, commit, deleted_paths, _cache={}):
    """NFC paths a commit must keep although it deletes one of their names.

    When a commit removes one name of an NFC path while another name of the same
    NFC path stays in its tree, normalizing names would turn the removal into a
    deletion of the surviving file. Only non-ASCII names can differ in normalization.
    """
    wanted = [p for p in deleted_paths if any(c > 127 for c in p)]
    if not wanted:
        return set()
    names = {}
    for p in ls_tree(where, commit.decode() if isinstance(commit, bytes) else commit):
        if any(c > 127 for c in p):
            names.setdefault(nfc(p), set()).add(p)
    return {nfc(p) for p in wanted if names.get(nfc(p), set()) - {p}}


def nfc_file_changes(changes, keep, stats):
    """A commit's file changes with every path in NFC (server receive rule 2).

    Runs in the filter-repo commit callback, after the file-info callback, so it
    sees deletions as well. Same rules filter-repo applies when renames make two
    paths meet: a change beats a deletion, equal changes merge, different changes
    abort. Deletions in `keep` (nfc_plan.py: the path survives under another name)
    are dropped.
    """
    out = {}
    for c in changes:
        if c.type == b"DELETEALL":
            out[b""] = c
            continue
        name = nfc(c.filename)
        if name != c.filename:
            stats["nfcRenamed"] += 1
            c.filename = name
        if c.type == b"D" and name in keep:
            stats["nfcDeletesDropped"] += 1
            continue
        cur = out.get(name)
        if cur is None or (cur.type == b"D" and c.type != b"D"):
            out[name] = c
        elif c.type == b"D" or (cur.mode, cur.blob_id) == (c.mode, c.blob_id):
            continue
        else:
            die("two names for NFC path %r carry different content" % name)
    return list(out.values())

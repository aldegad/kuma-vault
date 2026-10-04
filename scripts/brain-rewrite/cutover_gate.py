#!/usr/bin/env python3
"""Cutover go/no-go, decided by machine (no human check point).

Reads only; changes nothing. Exit 0 = go, 3 = no-go, 2 = the gate itself could not run.

  stage 0 (before freezing):  prerequisite plans completed, rehearsal passed, method,
                              G-server-0  free >= peak increment + rsync bytes + diskReserveGB + margin
                              G-mac       free >= text bytes to freeze-commit + test clone size + margin
  stage 4 (after the last rsync and drift check):
                              G-server-4  free >= peak increment + diskReserveGB + margin

  cutover_gate.py --config gate.json --stage 0|4 --out decision.json [--rsync-bytes N]

gate.json:
  {"plansDir": "~/.kuma/vault/plans",
   "prerequisites": ["<project>/<plan id>", ...],
   "rehearsal": "<rehearsal.json written by summarize.py>",
   "server": {"ssh": "<ssh host>", "dataPath": "/data", "snapshotPath": "<server copy of the repo>"},
   "mac": {"repo": "<client repo root>"},
   "diskReserveGB": 8, "marginGB": 5}
"server.ssh" may be null when the gate runs on the server itself.
"""

import argparse
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402

GB = 10 ** 9


def plan_status(plans_dir, plan_id):
    fn = os.path.join(plans_dir, plan_id + ".md")
    if not os.path.exists(fn):
        return None
    with open(fn, encoding="utf-8") as f:
        text = f.read()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        return None
    for line in m.group(1).splitlines():
        if line.startswith("status:"):
            return line.split(":", 1)[1].strip()
    return None


def run(cmd, **kw):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kw)
    if p.returncode != 0:
        raise RuntimeError("%s failed: %s" % (" ".join(cmd[:4]), p.stderr.decode("utf-8", "replace")[:500]))
    return p.stdout.decode()


def server_free(cfg):
    cmd = ["df", "-B1", "--output=avail", cfg["dataPath"]]
    if cfg.get("ssh"):
        cmd = ["ssh", "-o", "BatchMode=yes", cfg["ssh"], " ".join(cmd)]
    return int(run(cmd).split()[-1])


def local_free(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def rsync_bytes(mac_repo, server):
    dest = ("%s:%s/" % (server["ssh"], server["snapshotPath"])) if server.get("ssh") else server["snapshotPath"] + "/"
    out = run(["rsync", "-a", "-n", "--delete", "--stats", mac_repo.rstrip("/") + "/", dest])
    m = re.search(r"Total transferred file size: ([0-9,]+)", out)
    if not m:
        raise RuntimeError("rsync --stats output has no transferred size")
    return int(m.group(1).replace(",", ""))


def freeze_text_bytes(repo):
    """Bytes of text paths the step-3 freeze commit would stage (git status, LFS extensions excluded)."""
    out = B.git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", *B.freeze_pathspec())
    toks = B.split_z(out)
    total = n = 0
    i = 0
    root = os.fsencode(os.path.abspath(repo))
    while i < len(toks):
        xy, path = toks[i][:2], toks[i][3:]
        i += 2 if xy[:1] in (b"R", b"C") else 1
        try:
            total += os.lstat(os.path.join(root, path)).st_size
            n += 1
        except FileNotFoundError:
            pass  # deletion: nothing to hash
    return total, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--stage", choices=["0", "4"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--rsync-bytes", type=int, help="use this instead of measuring with rsync -n --stats")
    a = ap.parse_args()
    with open(a.config, encoding="utf-8") as f:
        cfg = json.load(f)
    reserve = cfg.get("diskReserveGB", 8) * GB
    margin = cfg.get("marginGB", 5) * GB
    checks = []

    def check(name, go, **detail):
        checks.append(dict(name=name, go=bool(go), **detail))

    try:
        reh = B.load_json(os.path.expanduser(cfg["rehearsal"]))
        peak = int(reh["peakIncrementBytes"])
        clone = int(reh["testCloneBytes"])
        check("rehearsal", reh.get("pass") is True, method=reh.get("method"), peakIncrementBytes=peak,
              testCloneBytes=clone)
        if a.stage == "0":
            plans_dir = os.path.expanduser(cfg["plansDir"])
            states = {p: plan_status(plans_dir, p) for p in cfg["prerequisites"]}
            check("prerequisites", all(s == "completed" for s in states.values()), plans=states)
            free = server_free(cfg["server"])
            rb = a.rsync_bytes if a.rsync_bytes is not None else rsync_bytes(os.path.expanduser(cfg["mac"]["repo"]),
                                                                              cfg["server"])
            need = peak + rb + reserve + margin
            check("G-server-0", free >= need, freeBytes=free, needBytes=need, rsyncBytes=rb)
            mac_repo = os.path.expanduser(cfg["mac"]["repo"])
            text, n = freeze_text_bytes(mac_repo)
            mfree = local_free(mac_repo)
            mneed = text + clone + margin
            check("G-mac", mfree >= mneed, freeBytes=mfree, needBytes=mneed, freezeTextBytes=text, freezeTextPaths=n)
        else:
            free = server_free(cfg["server"])
            need = peak + reserve + margin
            check("G-server-4", free >= need, freeBytes=free, needBytes=need)
    except Exception as e:  # the gate could not decide: say so, never "go"
        B.write_json(a.out, dict(stage=a.stage, go=False, error=str(e), checks=checks))
        print("cutover-gate: ERROR %s" % e)
        sys.exit(2)
    go = all(c["go"] for c in checks)
    B.write_json(a.out, dict(stage=a.stage, go=go, method=reh.get("method"), checks=checks))
    print("cutover-gate stage %s: %s" % (a.stage, "GO" if go else "NO-GO (" + ", ".join(
        c["name"] for c in checks if not c["go"]) + ")"))
    sys.exit(0 if go else 3)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Collect a rehearsal's step reports into rehearsal.json (input of cutover_gate.py).

T (rewrite pipeline) = map + strip + isolated copy + filter-repo + 4' + P + 7a-7d,
given twice: with the first (uncached) map and with the cached re-run.
Peak increment = highest use during the cutover-step-5..8 window (src .. compare,
test clone included) above rehearsal start: from run/own-usage.log when present
(attributable), else from df (shared disk — includes other writers).

  summarize.py --work WORK --out rehearsal.json
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brainrw as B  # noqa: E402

T_STEPS = ["strip", "src", "filter", "independent", "pointer", "verify"]
WINDOW = ("src", "compare")
FULL_LIMIT_S = 90 * 60


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    R, REP = os.path.join(a.work, "run"), os.path.join(a.work, "reports")

    def rep(name):
        fn = os.path.join(REP, name)
        return B.load_json(fn) if os.path.exists(fn) else None

    def num(name):
        fn = os.path.join(R, name)
        return int(open(fn).read().strip()) if os.path.exists(fn) else None

    phases = {}
    with open(os.path.join(R, "phases.tsv")) as f:
        for line in f:
            name, t0, t1, u0, u1, rc = line.rstrip("\n").split("\t")
            phases[name] = dict(start=float(t0), end=float(t1), seconds=round(float(t1) - float(t0), 1),
                                usedStart=int(u0), usedEnd=int(u1), rc=int(rc))
    samples = []
    with open(os.path.join(R, "df.log")) as f:
        for line in f:
            t, u = line.split()
            samples.append((float(t), int(u)))
    start_used = num("start-used")
    w0, w1 = phases[WINDOW[0]]["start"], phases[WINDOW[1]]["end"]
    win = [u for t, u in samples if w0 <= t <= w1] + [phases[p]["usedEnd"] for p in phases
                                                      if w0 <= phases[p]["start"] <= w1]
    peak_window = max(win)
    peak_all = max([u for _t, u in samples] + [p["usedEnd"] for p in phases.values()])
    # Attributable use (run/own-usage.log: "<epoch> TAB <bytes>" of the directories that
    # can hold new blocks, sampled by the operator): /data is shared, and other work on
    # it inflates the df view. When present it is the peak the gate uses.
    own = []
    own_fn = os.path.join(R, "own-usage.log")
    if os.path.exists(own_fn):
        own = [(float(t), int(b)) for t, b in (l.split() for l in open(own_fn) if l.strip())]
    own_win = [b for t, b in own if w0 <= t <= w1]
    rest = sum(phases[s]["seconds"] for s in T_STEPS)
    t_cold = phases["map-cold"]["seconds"] + rest
    t_warm = phases["map-warm"]["seconds"] + rest
    tail = rep("tail-replay.json")
    tail_ok = bool(tail and tail.get("allEqual"))
    if t_warm <= FULL_LIMIT_S:
        method = "full"
    else:
        method = "tail-replay" if tail_ok else "full (tail replay did not match — freeze for T)"
    checks = {
        "7a": (rep("7a-fsck.json") or {}).get("rc") == 0 and (rep("7a-fsck.json") or {}).get("problemLines") == 0,
        "7b": (rep("7b-trees.json") or {}).get("ok") is True,
        "7c": (rep("7c-cas.json") or {}).get("ok") is True,
        "stage8": (rep("stage8.json") or {}).get("ok") is True,
        "sourceUnchanged": (rep("source-compare.json") or {}).get("ok") is True,
        "tailReplayEqual": tail_ok,
        "serverReceiveRules": None if "skipped" in (rep("receive.json") or {"skipped": 1}) else
        rep("receive.json").get("violations") == 0,
    }
    fm_cold, fm_warm = rep("final-map-cold.json"), rep("final-map-warm.json")
    strip = rep("strip.json")
    sizes = rep("7d-sizes.json")
    server_side = t_warm + phases.get("tree", {}).get("seconds", 0) + phases["clone"]["seconds"] + \
        phases["compare"]["seconds"]
    out = dict(
        pass_=None,
        method=method,
        T=dict(coldSeconds=round(t_cold, 1), warmSeconds=round(t_warm, 1), stepSeconds={s: phases[s]["seconds"]
               for s in ["map-cold", "map-warm"] + T_STEPS}),
        map=dict(coldSeconds=phases["map-cold"]["seconds"], warmSeconds=phases["map-warm"]["seconds"],
                 rows=fm_cold and fm_cold["rows"], hashedBytesCold=fm_cold and fm_cold["hashedBytes"],
                 cacheHitsWarm=fm_warm and fm_warm["cacheHits"], hashedWarm=fm_warm and fm_warm["hashed"],
                 ignoredLfsFiles=fm_cold and fm_cold["ignoredLfsFiles"],
                 ignoredLfsBytes=fm_cold and fm_cold["ignoredLfsBytes"]),
        casBytes=fm_cold and fm_cold["cas"]["uniqueBytes"], casObjects=fm_cold and fm_cold["cas"]["uniqueObjects"],
        stripped=dict(count=strip and strip["stripped"], bytes=strip and strip["strippedBytes"]),
        newPackBytes=sizes and sizes["packBytes"], countObjects=sizes and sizes["countObjects"],
        peakIncrementBytes=max(own_win) if own_win else peak_window - start_used,
        peakIncrementSource="own-usage (attributable)" if own_win else "df",
        peakIncrementDfBytes=peak_window - start_used, peakIncrementDfAllStepsBytes=peak_all - start_used,
        ownUsageMaxBytes=max(b for _t, b in own) if own else None,
        startUsedBytes=start_used, peakWindow=list(WINDOW),
        testCloneBytes=num("clone-alloc"), testCloneApparentBytes=num("clone-apparent"),
        testCloneGitBytes=num("clone-git-alloc"),
        treeBytes=num("tree-alloc"),
        tailReplay=tail, receiveRules=rep("receive.json"),
        refmap=rep("refmap.json") or dict(status="not run"),
        freezeWindowServerSeconds=round(server_side, 1),
        checks=checks, phases=phases)
    out["pass"] = all(v for k, v in checks.items() if k != "tailReplayEqual" and v is not None) and \
        (method == "full" or tail_ok)
    out.pop("pass_")
    B.write_json(a.out, out)
    print("rehearsal: pass=%s method=%s T cold %.0fs warm %.0fs peak +%.2f GB clone %.2f GB" % (
        out["pass"], method, t_cold, t_warm, out["peakIncrementBytes"] / 1e9, (out["testCloneBytes"] or 0) / 1e9))


if __name__ == "__main__":
    main()

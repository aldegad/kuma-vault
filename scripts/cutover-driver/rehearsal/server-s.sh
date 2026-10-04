#!/usr/bin/env bash
# Rehearsal "S": the whole driver, steps pre-13b, on a Linux server scratch directory. The
# server blocks are the real ones (real serve, real server config, a scratch store id); the
# client role is a synthetic vault on the same machine, the agent runtime is kuma-sim.sh.
#
#   RT=<scratch dir> STORE=<scratch store id> server-s.sh setup | <scenario>... | teardown
#   scenarios: nogo success drift fail7 fail8 fail10 idem wait unknown rbinc corestop warmwrite freeze_gc slowversion
#
# Needs: passwordless sudo, an installed engine (/opt/kuma-vault/current), its node, git-lfs,
# restic, the filter-repo file (FILTER_REPO), the rehearsal result (REHEARSAL_JSON), the tool
# list (TOOLS_SHA256), an engine git checkout with history (ENGINE_CK).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DRV=$(dirname "$HERE")
: "${RT:?}" "${STORE:?}" "${FILTER_REPO:?}" "${REHEARSAL_JSON:?}" "${TOOLS_SHA256:?}" "${ENGINE_CK:?}"
E=$(readlink -f /opt/kuma-vault/current); NODEB=/opt/node/current/bin
VS="sudo env PATH=$NODEB:/usr/bin:/bin $E/bin/vault"
TOKEN_ID=${TOKEN_ID:-c8a-rehearsal}
CFG=/etc/kuma-vault/server.json
URL=http://127.0.0.1:7741
REC=$RT/receipts
mkdir -p "$RT" "$REC"
export PATH=$NODEB:$PATH

say() { printf '\n### %s %s\n' "$(date +%T)" "$*"; }
registered() { sudo jq -e --arg s "$1" '.stores | has($s)' "$CFG" >/dev/null; }
unregister() {
  sudo env PATH="$NODEB:/usr/bin:/bin" node --input-type=module -e "
    import { loadServerConfig, writeServerConfig } from '$E/src/server/server-config.mjs';
    const [p, id] = process.argv.slice(1); const c = loadServerConfig(p); delete c.stores[id]; writeServerConfig(p, c);" "$CFG" "$1"
}

setup() {
  say setup
  if ! sudo jq -e --arg t "$TOKEN_ID" '[.tokens[].id] | index($t)' "$CFG" >/dev/null; then
    (umask 077; $VS server token add --id "$TOKEN_ID" --store '*' --role writer --note "cutover driver rehearsal, removed after" > "$RT/token")
  fi
  # a fake runtime-repo history: backup change B0 on main, landed runtime change C1, installed app C2 (after C1)
  rm -rf "$RT/studio"; git init -q -b main "$RT/studio"
  for n in B0 C1 C2 X; do git -C "$RT/studio" -c user.name=s -c user.email=s@l commit -q --allow-empty -m "$n"; git -C "$RT/studio" rev-parse HEAD > "$RT/studio-$n"; done
  git -C "$RT/studio" branch -q side "$(cat "$RT/studio-B0")"
  git -C "$RT/studio" checkout -q side; git -C "$RT/studio" -c user.name=s -c user.email=s@l commit -q --allow-empty -m S
  git -C "$RT/studio" rev-parse HEAD > "$RT/studio-S"; git -C "$RT/studio" checkout -q main
  rm -rf "$RT/other"; git init -q "$RT/other"; git -C "$RT/other" -c user.name=s -c user.email=s@l commit -q --allow-empty -m other
}

# the client daemons the cases started (`vault syncd` runs as `node …/sync-cli.mjs syncd --repo …`)
stop_syncd() {
  local p i
  for i in $(seq 1 15); do
    p=$(pgrep -f "syncd --repo $RT/" || true); [ -n "$p" ] || return 0
    [ "$i" -lt 10 ] && kill $p 2>/dev/null || kill -9 $p 2>/dev/null || true
    sleep 1
  done
  ! pgrep -f "syncd --repo $RT/" >/dev/null
}

teardown_store() {
  stop_syncd
  if sudo jq -e '.backup != null' "$CFG" >/dev/null; then $VS server backup unconfigure; $VS server install >/dev/null; fi
  registered "$STORE" && unregister "$STORE"
  # the backup drill leaves its (empty) work dir in the data dir: ours, from the 13b rehearsal
  sudo rm -rf "/data/vaults/${STORE:?}" "/data/vaults/${STORE}-restic" /data/vaults/.backup-drill
  for m in $(findmnt -rn -o TARGET | grep "^$RT/" || true); do sudo umount "$m"; done
}

# a fresh case directory: client repo, home, links, stores file, plans, gate, config
fresh() {
  local name=$1 c4c=${2:-C1}
  teardown_store
  C=$RT/case-$name; sudo rm -rf "$C"; mkdir -p "$C/home/.kuma" "$C/srv" "$C/plans/p" "$C/sim"
  "$HERE/make-synth-vault.sh" "$C/mac/kuma-brain" "$E" > "$C/synth-head"
  ln -s "$C/mac/kuma-brain/vault" "$C/home/.kuma/vault"; ln -s "$C/mac/kuma-brain/vault/plans" "$C/home/.kuma/plans"
  printf '{\n  "stores": {\n    "kuma-brain": "%s"\n  }\n}\n' "$C/home/.kuma/vault" > "$C/home/.kuma/vault-stores.json"
  printf '{"other": "%s", "brain": {"repo": "%s"}}\n' "$RT/other" "$C/mac/kuma-brain" > "$C/home/.kuma/projects.json"
  for p in c1 c2 c3 c4a c4c driver; do printf -- '---\nstatus: completed\n---\n' > "$C/plans/p/$p.md"; done
  mkdir -p "$C/srv/kuma-brain"
  cat > "$C/gate.json" <<JSON
{"plansDir": "$C/plans", "prerequisites": ["p/c1", "p/c2", "p/c3", "p/c4a", "p/c4c", "p/driver"],
 "rehearsal": "$REHEARSAL_JSON", "server": {"ssh": null, "dataPath": "/data", "snapshotPath": "$C/srv/kuma-brain"},
 "mac": {"repo": "$C/mac/kuma-brain"}, "diskReserveGB": 8, "marginGB": 5}
JSON
  printf '{"restore_total": [0, 0], "gates": {"G1_keep_missing": 0, "G2_delete_on_mac_unguarded": 0, "G3_keep_x_reject": 0, "G4_head_tracked_x_reject": 0, "G5_clipless_raw_missing": 0, "G6_gone_not_in_step4_count": 0, "G6_step4_still_on_mac": 0}}\n' > "$C/c14d-summary.json"
  echo up > "$C/sim/core"; cat "$RT/studio-C2" > "$C/sim/installed"
  printf 'kuma-vault\tsniffed\tworking (sniffing)\nkuma-vault\treaped\tworking [reap:scheduled]\n' > "$C/sim/working"
  local K="$HERE/kuma-sim.sh" V="$E/bin/vault" NC=$C/home/.kuma/vaults/$STORE
  python3 - "$C" <<PY
import json, sys
C = sys.argv[1]
K, V, NC, RT, STORE, URL = "$K", "$V", "$NC", "$RT", "$STORE", "$URL"
sim = lambda *a: [K] + list(a)
cfg = {
 "workDir": C + "/c8work", "plan": "rehearsal/plan", "freezeReason": "cutover rehearsal",
 "launchdLabel": "ai.kuma-vault.cutover-driver.rehearsal",
 "gate": C + "/gate.json",
 "env": {"PATH": "$NODEB:/usr/local/bin:/usr/bin:/bin", "SIM_DIR": C + "/sim"},
 "mac": {
   "repo": C + "/mac/kuma-brain", "engine": "$ENGINE_CK", "toolsSha256": "$TOOLS_SHA256",
   "vault": [V], "freezeFile": C + "/home/.kuma/vault-freeze.json", "rsync": "rsync",
   "newClone": NC, "links": [{"path": C + "/home/.kuma/vault", "target": NC + "/vault"},
                             {"path": C + "/home/.kuma/plans", "target": NC + "/vault/plans"}],
   "storesFile": C + "/home/.kuma/vault-stores.json",
   "beforeFreeze": [[V, "sync", "--root", C + "/mac/kuma-brain/vault"]],
   "storeCommands": [["store", "rename", "kuma-brain", STORE, "--root", NC + "/vault"],
                     ["store", "set", STORE, "--mode", "remote", "--server", URL, "--remote-store", STORE,
                      "--search", "remote", "--lfs-cache-max-gb", "10", "--token-file", RT + "/token", "--default"]],
   "cloneUrl": URL + "/v1/stores/" + STORE + ".git", "cloneTokenFile": RT + "/token",
   "projectsJson": C + "/home/.kuma/projects.json", "kumaStudio": RT + "/studio",
   "daemonInstall": ["cd / && nohup %s syncd --repo %s > %s/syncd.log 2>&1 &" % (V, NC, C)],
   "backupRetarget": [sim("routine", "retarget")],
   "env": {"HOME": C + "/home", "GIT_AUTHOR_NAME": "synth", "GIT_AUTHOR_EMAIL": "synth@localhost",
           "GIT_COMMITTER_NAME": "synth", "GIT_COMMITTER_EMAIL": "synth@localhost"}},
 "prereq": {"studioBackupCommit": open(RT + "/studio-B0").read().strip(), "studioMainRef": "main",
            "c4cLandedSha": open(RT + "/studio-$c4c").read().strip(),
            "launcherVersionCmd": sim("control", "launcher-version", "--json"),
            "coreVersionCmd": sim("control", "core-version"), "engineMasterRef": "master",
            "checks": ["sudo -n true", ["git", "--version"]]},
 "c14d": {"summary": C + "/c14d-summary.json", "maxAgeHours": 6},
 "core": {"statusCmd": sim("status"), "waitMinutes": 0.1, "pollSeconds": 2,
          "controlStatusCmd": sim("control", "status"), "stopCmd": sim("control", "stop-core"), "startCmd": sim("control", "start"), "aliveCmd": sim("control", "alive")},
 "backup3b": {"command": "sleep 3; echo 'snapshot 0123abcd saved'"},
 "server": {"ssh": None, "work": C + "/srv/work/c8", "snapshot": C + "/srv/kuma-brain", "store": STORE,
            "owner": "rehearsal@example.invalid", "allowedRemote": URL + "/v1/stores/" + STORE + ".git",
            "commitMapRel": "projects/kuma-vault/remote-brain/commit-map.tsv",
            "rejectRel": "projects/kuma-vault/remote-brain/binaries-reject.json",
            "extraDeletePathsRel": "vault/projects/kuma-vault/remote-brain/rewrite-extra-delete-paths.txt",
            "filterRepo": "$FILTER_REPO", "workRoot": RT, "receipts": C + "/srv/receipts",
            "ignoreTokenIds": ["$TOKEN_ID"],
            "backup": {"repository": "/data/vaults/" + STORE + "-restic", "credentialFiles": ["restic-password"],
                       "initLocalRepository": True}},
 "smoke": {"planFile": "vault/plans/kuma-vault/c8-smoke.md", "logFile": "vault/_c8-smoke/log.md",
           "searchQuery": "note", "blobPath": "vault/domains/a/_assets/big.png",
           "rejectPath": "vault/domains/a/_assets/scratch/x.png", "bigPath": "vault/_c8-smoke/too-big.txt",
           "launchdRestart": False},
 "notify": {"command": sim("notify")},
}
json.dump(cfg, open(C + "/c8.json", "w"), indent=2)
PY
  python3 "$DRV/driver.py" stage --config "$C/c8.json" > /dev/null
  RUN="python3 $C/c8work/driver/driver.py run --config $C/c8work/c8.json"
  # what "nothing changed" / "back as it was" is compared against
  snapshot_client > "$C/before.txt"
}

snapshot_client() {
  local C=${C:?}
  echo "freeze=$([ -e "$C/home/.kuma/vault-freeze.json" ] && echo present || echo absent)"
  echo "repo=$([ -d "$C/mac/kuma-brain/.git" ] && echo present || echo absent)"
  echo "renamed=$([ -e "$C/mac/kuma-brain.pre-cutover" ] && echo present || echo absent)"
  echo "link.vault=$(readlink "$C/home/.kuma/vault")"
  echo "link.plans=$(readlink "$C/home/.kuma/plans")"
  echo "stores=$(sha256sum < "$C/home/.kuma/vault-stores.json" | cut -c1-16)"
  echo "newclone=$([ -e "$C/home/.kuma/vaults/$STORE" ] && echo present || echo absent)"
  echo "store.registered=$(registered "$STORE" && echo yes || echo no)"
  echo "store.dir=$(sudo test -e "/data/vaults/$STORE" && echo present || echo absent)"
  echo "server.workdir=$([ -e "$C/srv/work/c8" ] && echo present || echo absent)"
  echo "core=$(cat "$C/sim/core")"
  echo "srv.notowned=$( [ -d "$C/srv/kuma-brain" ] && sudo find "$C/srv/kuma-brain" ! -user "$(id -un)" | wc -l || echo 0)"
}

# a change to the staged configuration the driver runs with: a python statement on c
setcfg() {
  python3 - "$C/c8work/c8.json" "$1" <<'PY2'
import json, sys
p, expr = sys.argv[1:]; c = json.load(open(p)); exec(expr); json.dump(c, open(p, "w"), indent=2)
PY2
}

# step 2 of the state: seconds it took and what it recorded; asserts the python condition given
check2() {
  python3 - "$C/c8work/state.json" "$1" <<'PY2'
import json, sys, datetime as dt
st = json.load(open(sys.argv[1])); s2 = st["steps"]["2"]; v = st["values"]
secs = (dt.datetime.fromisoformat(s2["endedAt"]) - dt.datetime.fromisoformat(s2["startedAt"])).total_seconds()
cut, unknown, already = v.get("sessionsCutAtStop"), v.get("statusUnknown"), v.get("coreAlreadyStopped")
print("step 2: %ds, reruns %s, sessionsCutAtStop %s, statusUnknown %s, coreAlreadyStopped %s" % (
    secs, s2.get("reruns"), json.dumps(cut, ensure_ascii=False), json.dumps(unknown, ensure_ascii=False), json.dumps(already)))
assert eval(sys.argv[2]), sys.argv[2]
PY2
}

# the client repository may keep the freeze commit (5.7 default); everything else as before
expect_restored() {
  local name=$1
  snapshot_client > "$C/after.txt"
  if diff "$C/before.txt" "$C/after.txt" > "$C/restore-diff.txt"; then
    echo "RESTORED $name: identical"; return 0
  fi
  echo "NOT RESTORED $name:"; cat "$C/restore-diff.txt"; return 1
}

receipt() {
  local name=$1 rc=$2 C=${C:?}
  python3 - "$C" "$name" "$rc" <<'PY' > "$REC/$name.json"
import json, sys, os
C, name, rc = sys.argv[1:]
st = json.load(open(C + "/c8work/state.json"))
out = {"scenario": name, "driverExit": int(rc), "outcome": st.get("outcome"), "reason": st.get("reason"),
       "attempt": st.get("attempt"),
       "steps": {k: {x: v.get(x) for x in ("status", "rc", "reruns", "startedAt", "endedAt", "error")} for k, v in st["steps"].items()},
       "rollback": st.get("rollback"),
       "values": {k: st["values"].get(k) for k in ("HEAD_pre", "HEAD_final", "pointerCommit", "cutoverTip", "drift",
                                                    "sessionsCutAtStop", "coreAlreadyStopped", "statusUnknown", "macClone", "stage8", "smoke", "server13",
                                                    "backup13b", "c9Ready", "refmap")},
       "simEvents": open(C + "/sim/events").read().splitlines() if os.path.exists(C + "/sim/events") else []}
for f in ("before.txt", "after.txt", "restore-diff.txt"):
    if os.path.exists(os.path.join(C, f)):
        out[f] = open(os.path.join(C, f)).read().splitlines()
print(json.dumps(out, ensure_ascii=False, indent=2))
PY
  echo "receipt $REC/$name.json (outcome $(jq -r .outcome "$REC/$name.json"), exit $rc)"
}

s_nogo() {
  fresh nogo S       # a landed runtime sha the installed app does not contain -> prerequisite 7 no-go
  local rc=0; $RUN || rc=$?
  expect_restored nogo
  receipt nogo "$rc"; [ "$rc" = 3 ]
  grep -q 'stop-core' "$C/sim/events" && { echo "no-go stopped the runtime"; return 1; } || true
}
s_success() {
  fresh success
  local rc=0; $RUN || rc=$?
  receipt success "$rc"; [ "$rc" = 0 ]
  [ "$(jq -r .values.c9Ready "$C/c8work/state.json")" = true ]
  # the two working rows of the real shapes waited the whole waitMinutes and were cut; the idle ones were not
  check2 'secs >= 6 and [r["member"] for r in cut] == ["sniffed", "reaped"]'
}
s_drift() {
  fresh drift
  $RUN --stop-after 3
  echo 'written after the freeze commit' >> "$C/mac/kuma-brain/vault/domains/a/notes.md"
  local rc=0; $RUN || rc=$?
  receipt drift "$rc"; [ "$rc" = 4 ]
  git -C "$C/mac/kuma-brain" checkout -q -- vault/domains/a/notes.md 2>/dev/null || true
  # the text line written after the freeze stays in the work tree (it is the writer's); compare the rest
  expect_restored drift
}
s_fail7() {
  fresh fail7
  $RUN --stop-after 6
  sudo mkdir -p "/data/vaults/$STORE"; sudo touch "/data/vaults/$STORE/origin.git"     # step 7 must refuse
  local rc=0; $RUN || rc=$?
  receipt fail7 "$rc"; [ "$rc" = 4 ]
  expect_restored fail7
}
s_fail8() {
  fresh fail8
  $RUN --stop-after 7
  echo 'server copy changed' >> "$C/srv/kuma-brain/vault/domains/a/notes.md"   # stage-8 comparison must fail
  local rc=0; $RUN || rc=$?
  receipt fail8 "$rc"; [ "$rc" = 4 ]
  expect_restored fail8
}
s_fail10() {
  fresh fail10
  $RUN --stop-after 9
  # step 10 fails after it swapped the links: a store command the CLI refuses
  python3 - "$C/c8work/c8.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["mac"]["storeCommands"].append(["store", "show", "no-such-store"]); json.dump(c, open(p, "w"), indent=2)
PY
  local rc=0; $RUN || rc=$?
  receipt fail10 "$rc"; [ "$rc" = 4 ]
  expect_restored fail10
}
s_idem() {
  fresh idem
  $RUN > "$C/run1.out" 2>&1 &
  local pid=$! t=0
  # wait until step 5 is inside filter-repo, then kill the driver hard
  until [ -s "$C/srv/work/c8/run/filter-repo.log" ] || [ $t -ge 600 ]; do sleep 0.2; t=$((t + 1)); done
  sleep 0.3
  kill -9 "$pid" || true; wait "$pid" 2>/dev/null || true
  echo "killed driver at: $(jq -c '[.steps | to_entries[] | select(.value.status == "running") | .key]' "$C/c8work/state.json")"
  pgrep -af "c8-guard" > "$C/orphans-after-kill.txt" || true
  local rc=0; $RUN || rc=$?
  receipt idem "$rc"; [ "$rc" = 0 ]
  [ "$(jq -r '.steps["5"].reruns' "$C/c8work/state.json")" -ge 1 ]
}

s_wait() {
  fresh wait
  printf 'kuma-vault\tsniffed\tworking (sniffing)\n' > "$C/sim/working"     # the only working row: no hook signal yet
  setcfg 'c["core"]["waitMinutes"] = 0.25'
  local rc=0; $RUN --stop-after 2 || rc=$?
  receipt wait "$rc"; [ "$rc" = 0 ]
  check2 'secs >= 15 and cut == [{"project": "kuma-vault", "member": "sniffed", "status": "working (sniffing)"}] and not unknown'
  grep -q 'control stop-core' "$C/sim/events"
}
s_unknown() {
  fresh unknown
  printf 'kuma-vault\tnewstate\tunknown:paused (output)\n' > "$C/sim/working"  # a STATUS word the driver does not know
  local rc=0; $RUN --stop-after 2 || rc=$?
  receipt unknown "$rc"; [ "$rc" = 0 ]
  check2 'secs >= 6 and [r["member"] for r in cut] == ["newstate"] and [r["status"] for r in unknown] == ["unknown:paused (output)"]'
  grep 'unknown status' "$C/c8work/logs/driver.log" | tail -1
}
s_rbinc() {
  fresh rbinc
  $RUN --stop-after 6
  sudo mkdir -p "/data/vaults/$STORE"; sudo touch "/data/vaults/$STORE/origin.git"     # step 7 must refuse (as fail7)
  touch "$C/sim/start-fails"                                                          # and the runtime start (undo of 2) fails
  local rc=0; $RUN || rc=$?
  receipt rbinc "$rc"; [ "$rc" = 6 ]
  head -1 "$C/c8work/REPORT.md" | tee "$C/report-head.txt"
  grep -q '^# cutover driver: rollback-incomplete (attempt 1) .*undo failed: 2' "$C/report-head.txt"
  [ "$(jq -c .rollback.failed "$C/c8work/state.json")" = '["2"]' ]
  # a run on that state tries the failed undo again, in the same attempt, and skips the done ones
  rm -f "$C/sim/start-fails"
  rc=0; $RUN || rc=$?
  receipt rbinc-retry "$rc"; [ "$rc" = 4 ]
  [ "$(jq -r '"\(.attempt) \(.outcome) \(.rollbackRetries | length)"' "$C/c8work/state.json")" = "1 rolled-back 1" ]
  head -1 "$C/c8work/REPORT.md"
  expect_restored rbinc
}
s_corestop() {
  fresh corestop
  touch "$C/sim/stop-hangs"                    # the first run is killed inside the stop, after the runtime went down
  $RUN > "$C/run1.out" 2>&1 &
  local pid=$! t=0
  until grep -q 'control stop-core' "$C/sim/events" 2>/dev/null || [ $t -ge 1200 ]; do sleep 0.5; t=$((t + 1)); done
  sleep 1
  kill -9 "$pid" || true; wait "$pid" 2>/dev/null || true
  for p in $(pgrep -f "kuma-sim.sh control stop-core" || true); do pkill -P "$p" || true; kill "$p" || true; done
  echo "killed driver at: $(jq -c '[.steps | to_entries[] | select(.value.status == "running") | .key]' "$C/c8work/state.json"), core $(cat "$C/sim/core")"
  [ "$(cat "$C/sim/core")" = down ]
  setcfg 'c["core"]["waitMinutes"] = 30'       # the re-run must not wait for a runtime that is down
  local rc=0; $RUN || rc=$?
  receipt corestop "$rc"; [ "$rc" = 0 ]
  check2 's2["reruns"] == 1 and secs < 60 and already["line"].startswith("down (stopped)") and [r["member"] for r in cut] == ["sniffed", "reaped"]'
}

s_warmwrite() {
  fresh warmwrite
  (
    while [ ! -e "$C/writer-stop" ]; do
      git -C "$C/mac/kuma-brain" -c user.name=writer -c user.email=writer@example.invalid \
        -c core.hooksPath=/dev/null commit -q --allow-empty -m 'concurrent writer'
      echo committed >> "$C/writer-commits"
      sleep 0.2
    done
  ) > "$C/writer.log" 2>&1 &
  local writer=$! rc=0
  $RUN --stop-after 0 || rc=$?
  touch "$C/writer-stop"; wait "$writer"
  [ "$rc" = 0 ]; [ "$(wc -l < "$C/writer-commits")" -gt 1 ]
  GIT_CONFIG_NOSYSTEM=1 git --no-optional-locks -C "$C/srv/kuma-brain" fsck --connectivity-only
  echo "concurrent commits: $(wc -l < "$C/writer-commits")" > "$REC/warmwrite-writer.txt"
  $RUN || rc=$?
  receipt warmwrite "$rc"; [ "$rc" = 0 ]
}

s_freeze_gc() {
  fresh freeze_gc
  $RUN --stop-after 2
  local repo=$C/mac/kuma-brain
  # Deliberately turn maintenance back on after pre, so step 3 must suppress it itself.
  PYTHONDONTWRITEBYTECODE=1 python3 - "$DRV" "$repo" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from test_driver import seed_loose
seed_loose(Path(sys.argv[2]))
PY
  git -C "$repo" config gc.auto 20
  git -C "$repo" config maintenance.auto true
  printf '#!/bin/sh\ntouch "$(git rev-parse --git-dir)/gc-observed"\n' > "$repo/.git/hooks/pre-auto-gc"
  chmod +x "$repo/.git/hooks/pre-auto-gc"
  find "$repo/.git/objects" -mindepth 2 -maxdepth 2 -type f | sort > "$C/loose-before"
  $RUN --stop-after 3
  [ ! -e "$repo/.git/gc.pid" ]; [ ! -e "$repo/.git/gc-observed" ]
  while IFS= read -r p; do [ -f "$p" ]; done < "$C/loose-before"
  printf 'old loose objects retained; gc.pid absent; pre-auto-gc hook not called\n' > "$REC/freeze_gc-objects.txt"
  git -C "$repo" config gc.auto 0
  git -C "$repo" config maintenance.auto false
  local rc=0; $RUN || rc=$?
  receipt freeze_gc "$rc"; [ "$rc" = 0 ]
}

s_slowversion() {
  fresh slowversion
  echo 150 > "$C/sim/launcher-delay"
  echo 150 > "$C/sim/core-delay"
  local start=$SECONDS rc=0
  $RUN --stop-after pre || rc=$?
  [ "$rc" = 0 ]; [ "$((SECONDS - start))" -ge 300 ]
  echo "two delayed version queries passed in $((SECONDS - start)) seconds" > "$REC/slowversion-time.txt"
  rm "$C/sim/launcher-delay" "$C/sim/core-delay"
  $RUN || rc=$?
  receipt slowversion "$rc"; [ "$rc" = 0 ]
}

final_cleanup() {
  say teardown
  teardown_store
  sudo jq -e --arg t "$TOKEN_ID" '[.tokens[].id] | index($t)' "$CFG" >/dev/null && $VS server token rm --id "$TOKEN_ID"
  rm -f "$RT/token"
  sudo rm -rf "$RT"/case-*
  {
    echo "vaults entries: $(sudo find /data/vaults -mindepth 1 -maxdepth 1 | wc -l)"
    echo "config clean: $(sudo jq -e '(.stores | length) == 0 and (.tokens | length) == 0' "$CFG")"
    echo "backup block: $(sudo jq -c .backup "$CFG")"
    echo "backup timer: $(systemctl is-enabled kuma-vault-backup.timer 2>&1 || true)"
    echo "mounts under $RT: $(findmnt -rn -o TARGET | grep -c "^$RT/" || true)"
    echo "client daemons under $RT: $(pgrep -fc "syncd --repo $RT/" || true)"
    echo "serve: $(systemctl is-active kuma-vault-serve)"; curl -s "$URL/v1/health" | jq -c '{ok, configError}'
  } | tee "$REC/cleanup.txt"
}

for s in "$@"; do
  case "$s" in
    setup) setup ;;
    teardown) final_cleanup ;;
    nogo|success|drift|fail7|fail8|fail10|idem|wait|unknown|rbinc|corestop|warmwrite|freeze_gc|slowversion) say "scenario $s"; "s_$s"; echo "SCENARIO $s PASS" ;;
    *) echo "unknown $s" >&2; exit 2 ;;
  esac
done

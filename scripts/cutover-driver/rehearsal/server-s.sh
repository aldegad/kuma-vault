#!/usr/bin/env bash
# Rehearsal "S": the whole driver, steps pre-13b, on a Linux server scratch directory. The
# server blocks are the real ones; they run against a scratch `vault serve` of their own — its
# own server configuration, port, data directory, token and backup credentials under $RT — so a
# server that already serves live stores is not touched (its configuration and data directory
# are fingerprinted at setup and compared at teardown). The client role is a synthetic vault on
# the same machine, the agent runtime is kuma-sim.sh.
#
#   RT=<scratch dir> STORE=<scratch store id> server-s.sh setup | <scenario>... | teardown
#   main mode:      nogo success drift fail7 fail8 fail10 idem wait unknown rbinc corestop warmwrite freeze_gc slowversion
#   secondary mode: sec_success sec_rename sec_busy sec_refs sec_mustignore sec_fail10
#
# Needs: passwordless sudo, the serve user (an installed engine made it), node, git-lfs, restic,
# the filter-repo file (FILTER_REPO), the rehearsal result (REHEARSAL_JSON), the tool list
# (TOOLS_SHA256), a clean engine git checkout of the commit under test (ENGINE_CK): setup
# unpacks that commit as the engine the server blocks and the client use.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DRV=$(dirname "$HERE")
: "${RT:?}" "${STORE:?}" "${FILTER_REPO:?}" "${REHEARSAL_JSON:?}" "${TOOLS_SHA256:?}" "${ENGINE_CK:?}"
NODEB=${NODEB:-/opt/node/current/bin}; SERVE_USER=${SERVE_USER:-kuma-vault}; PORT=${PORT:-17761}
SHA=$(git -C "$ENGINE_CK" rev-parse HEAD)
E=$RT/runtime/$SHA
# the configuration has a directory of its own, like /etc/kuma-vault: a backup takes that directory
CFG=$RT/etc/server.json; VAULTS=$RT/vaults; CRED=$RT/etc/credentials; BACKUP_REPO=$VAULTS/backup-restic
VS="sudo env PATH=$NODEB:/usr/bin:/bin KUMA_VAULT_SERVER_CONFIG=$CFG $E/bin/vault"
TOKEN_ID=${TOKEN_ID:-c8a-rehearsal}
EXISTING=${EXISTING:-s-existing}             # the store a secondary cutover finds already served
PROD_CFG=${PROD_CFG:-/etc/kuma-vault/server.json}; PROD_VAULTS=${PROD_VAULTS:-/data/vaults}
URL=http://127.0.0.1:$PORT
REC=$RT/receipts
mkdir -p "$RT" "$REC"
export PATH=$NODEB:$PATH

say() { printf '\n### %s %s\n' "$(date +%T)" "$*"; }
registered() { sudo jq -e --arg s "$1" '.stores | has($s)' "$CFG" >/dev/null; }
# what the live server looks like: must be the same before and after
production() {
  echo "config sha256: $(sudo sha256sum "$PROD_CFG" 2>/dev/null | cut -d' ' -f1)"
  echo "stores: $(sudo jq -c '.stores | keys' "$PROD_CFG" 2>/dev/null)"
  echo "backup.stores: $(sudo jq -c '.backup.stores' "$PROD_CFG" 2>/dev/null)"
  echo "data entries: $(sudo ls "$PROD_VAULTS" 2>/dev/null | tr '\n' ' ')"
  echo "serve: $(systemctl is-active kuma-vault-serve 2>&1 || true)"
  echo "backup timer: $(systemctl is-enabled kuma-vault-backup.timer 2>&1 || true)"
}
# the scratch server configuration from nothing: token auth, no store, a backup block with the
# scratch credentials (so a backup never reads the machine's own credentials)
write_config() {
  sudo env PATH="$NODEB:/usr/bin:/bin" node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    import { hashToken, writeServerConfig } from '$E/src/server/server-config.mjs';
    const [path, port, data, tokenId, tokenFile, cred, repo] = process.argv.slice(1);
    writeServerConfig(path, { version: 1, listen: ['127.0.0.1:' + port], dataDir: data, auth: { mode: 'token' },
      tokens: [{ id: tokenId, sha256: hashToken(readFileSync(tokenFile, 'utf8').trim()), role: 'writer', stores: ['*'] }],
      stores: {}, backup: { repository: repo, host: 'rehearsal', credentialsDir: cred, stores: null } });
  " "$CFG" "$PORT" "$VAULTS" "$TOKEN_ID" "$RT/token" "$CRED" "$BACKUP_REPO"
  sudo chown "$SERVE_USER:$SERVE_USER" "$CFG"
}
serve_up() { curl -fs "$URL/v1/health" >/dev/null 2>&1; }

setup() {
  say setup
  [ -z "$(git -C "$ENGINE_CK" status --porcelain)" ] || { echo "ENGINE_CK is not clean" >&2; exit 1; }
  production > "$REC/production-before.txt"
  if [ ! -d "$E" ]; then mkdir -p "$E"; git -C "$ENGINE_CK" archive HEAD | tar -x -C "$E"; fi
  ln -sfn "$SHA" "$RT/runtime/current"
  [ -f "$RT/token" ] || (umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$RT/token")
  sudo install -d -o root -g root -m 0755 "$RT/etc"
  sudo install -d -o root -g root -m 0700 "$CRED"
  sudo test -f "$CRED/restic-password" || for f in restic-password s3-access-key-id s3-secret-access-key; do
    head -c 24 /dev/urandom | base64 | sudo tee "$CRED/$f" >/dev/null; sudo chmod 0600 "$CRED/$f"; done
  sudo install -d -o "$SERVE_USER" -g "$SERVE_USER" -m 0750 "$VAULTS"
  write_config
  if ! serve_up; then
    ! ss -ltn | grep -q ":$PORT " || { echo "port $PORT is taken" >&2; exit 1; }
    sudo -u "$SERVE_USER" env PATH="$NODEB:/usr/bin:/bin" setsid nohup "$NODEB/node" "$E/src/server/server-cli.mjs" \
      serve --config "$CFG" > "$RT/serve.log" 2>&1 < /dev/null &
    for _ in $(seq 1 50); do serve_up && break; sleep 0.2; done
    serve_up || { echo "scratch serve did not come up" >&2; tail -20 "$RT/serve.log" >&2; exit 1; }
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

# the scratch server back to its start: no client daemon, no mount, an empty data directory, the
# configuration from nothing. `secondary`: one store already served and in backup.stores, the
# backup repository initialised — what a secondary cutover finds.
reset_server() {
  stop_syncd
  for m in $(findmnt -rn -o TARGET | grep "^$RT/" || true); do sudo umount "$m"; done
  sudo find "${VAULTS:?}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  write_config
  if [ "${1:-main}" = secondary ]; then
    $VS server init-store "$EXISTING" --owner rehearsal@example.invalid >/dev/null
    $VS server backup configure --stores "$EXISTING" >/dev/null 2>&1
    sudo env RESTIC_PASSWORD_FILE="$CRED/restic-password" restic init --repo "$BACKUP_REPO" >/dev/null
    sudo chown -R "$SERVE_USER:$SERVE_USER" "$BACKUP_REPO"
  fi
  sleep 1.2      # serve re-reads its configuration at most once a second
}

# a fresh case directory: client repo, home, links, stores file, plans, gate, config
fresh() {
  local name=$1 c4c=${2:-C1}
  reset_server main
  C=$RT/case-$name; sudo rm -rf "$C"; mkdir -p "$C/home/.kuma" "$C/srv" "$C/plans/p" "$C/sim"
  CREPO=$C/mac/kuma-brain; CSNAP=$C/srv/kuma-brain
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
                      "--lfs-cache-max-gb", "10", "--token-file", RT + "/token", "--default"]],
   "cloneUrl": URL + "/v1/stores/" + STORE + ".git", "cloneTokenFile": RT + "/token",
   "projectsJson": C + "/home/.kuma/projects.json", "kumaStudio": RT + "/studio",
   "daemonInstall": ["cd / && nohup %s syncd --repo %s > %s/syncd.log 2>&1 &" % (V, NC, C)],
   "backupRetarget": [sim("routine", "retarget")],
   "env": {"HOME": C + "/home", "GIT_AUTHOR_NAME": "synth", "GIT_AUTHOR_EMAIL": "synth@localhost",
           "GIT_COMMITTER_NAME": "synth", "GIT_COMMITTER_EMAIL": "synth@localhost"}},
 "prereq": {"studioBackupCommit": open(RT + "/studio-B0").read().strip(), "studioMainRef": "main",
            "c4cLandedSha": open(RT + "/studio-$c4c").read().strip(),
            "launcherVersionCmd": sim("control", "launcher-version", "--json"),
            "coreVersionCmd": sim("control", "core-version"), "engineMasterRef": "HEAD",
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
            # the scratch server: its own engine, configuration and data directory; no systemd unit is written
            "engineLink": RT + "/runtime/current", "vaultsDir": "$VAULTS", "serverConfig": "$CFG",
            "healthUrl": URL + "/v1/health", "installUnits": False,
            "backup": {"repository": "$BACKUP_REPO", "host": "rehearsal", "credentialsDir": "$CRED",
                       "credentialFiles": ["restic-password"], "initLocalRepository": True}},
 "smoke": {"planFile": "vault/plans/kuma-vault/c8-smoke.md", "logFile": "vault/_c8-smoke/log.md",
           "blobPath": "vault/domains/a/_assets/big.png",
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
  echo "repo=$([ -d "$CREPO/.git" ] && echo present || echo absent)"
  echo "repo.kind=$(stat -c %F "$CREPO" 2>/dev/null || echo absent)"
  echo "renamed=$([ -e "$CREPO.pre-cutover" ] && echo present || echo absent)"
  echo "link.vault=$(readlink "$C/home/.kuma/vault" 2>/dev/null || echo none)"
  echo "link.plans=$(readlink "$C/home/.kuma/plans" 2>/dev/null || echo none)"
  echo "stores=$(sha256sum < "$C/home/.kuma/vault-stores.json" | cut -c1-16)"
  echo "newclone=$([ -e "$C/home/.kuma/vaults/$STORE" ] && echo present || echo absent)"
  echo "store.registered=$(registered "$STORE" && echo yes || echo no)"
  echo "store.dir=$(sudo test -e "$VAULTS/$STORE" && echo present || echo absent)"
  echo "server.stores=$(sudo jq -c '.stores | keys' "$CFG")"
  echo "server.backup.stores=$(sudo jq -c '.backup.stores' "$CFG")"
  echo "server.workdir=$([ -e "$C/srv/work/c8" ] && echo present || echo absent)"
  echo "core=$(cat "$C/sim/core")"
  echo "srv.notowned=$( [ -d "$CSNAP" ] && sudo find "$CSNAP" ! -user "$(id -un)" | wc -l || echo 0)"
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
                                                    "backup13b", "c9Ready", "refmap", "freezeStore", "projectSessionsAtFreeze",
                                                    "projectFrozen", "refsPre", "refs4", "mustIgnorePre", "mustIgnore", "alarms",
                                                    "oldPathLinked", "platformNoise")},
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
  sudo mkdir -p "$VAULTS/$STORE"; sudo touch "$VAULTS/$STORE/origin.git"     # step 7 must refuse
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
  sudo mkdir -p "$VAULTS/$STORE"; sudo touch "$VAULTS/$STORE/origin.git"     # step 7 must refuse (as fail7)
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

# --- secondary mode --------------------------------------------------------------------------

# a fresh secondary case: the old vault declares <old id>, the server already serves $EXISTING and
# backs it up, the machine has a main store registered that the cutover must leave alone.
#   fresh_sec <name> same|rename      same: the store keeps its id; rename: <STORE>-old -> STORE
fresh_sec() {
  local name=$1 kind=${2:-same}
  reset_server secondary
  C=$RT/case-$name; sudo rm -rf "$C"; mkdir -p "$C/home/.kuma/main-live" "$C/srv" "$C/plans/p" "$C/sim"
  OLDID=$STORE; [ "$kind" = rename ] && OLDID=$STORE-old
  CREPO=$C/mac/second-vault; CSNAP=$C/srv/old
  # the renamed store has no commit reference in its text: step 6 rewrites nothing and commits nothing
  "$HERE/make-synth-vault.sh" "$CREPO" "$E" secondary "$OLDID" "$([ "$kind" = rename ] && echo noref || echo ref)" > "$C/synth-head"
  printf '{\n  "stores": {\n    "main-live": "%s",\n    "%s": "%s"\n  }\n}\n' "$C/home/.kuma/main-live" "$OLDID" "$CREPO" > "$C/home/.kuma/vault-stores.json"
  printf '{"other": "%s", "second": {"repo": "%s"}}\n' "$RT/other" "$CREPO" > "$C/home/.kuma/projects.json"
  for p in p1 p2; do printf -- '---\nstatus: completed\n---\n' > "$C/plans/p/$p.md"; done
  # the client daemon commits as the machine's user (its autosave needs an identity)
  git config --file "$C/home/.gitconfig" user.name synth; git config --file "$C/home/.gitconfig" user.email synth@localhost
  mkdir -p "$CSNAP"
  cat > "$C/gate.json" <<JSON
{"plansDir": "$C/plans", "prerequisites": ["p/p1", "p/p2"],
 "rehearsal": "$REHEARSAL_JSON", "server": {"ssh": null, "dataPath": "/data", "snapshotPath": "$CSNAP"},
 "mac": {"repo": "$CREPO"}, "diskReserveGB": 8, "marginGB": 5}
JSON
  echo up > "$C/sim/core"
  printf 'kuma-vault\tsniffed\tworking (sniffing)\nother-project\tbusy\tworking\n' > "$C/sim/working"   # other projects at work
  local K="$HERE/kuma-sim.sh" V="$E/bin/vault" NC=$C/home/.kuma/vaults/$STORE
  python3 - "$C" "$kind" <<PYSEC
import json, sys
C, kind = sys.argv[1:]
K, V, NC, RT, STORE, OLDID, URL, REPO = "$K", "$V", "$NC", "$RT", "$STORE", "$OLDID", "$URL", "$CREPO"
sim = lambda *a: [K] + list(a)
store_set = ["store", "set", STORE, "--root", NC, "--mode", "remote", "--server", URL, "--remote-store", STORE,
             "--lfs-cache-max-gb", "10", "--token-file", RT + "/token"]
cfg = {
 "mode": "secondary",
 "workDir": C + "/c8work", "plan": "rehearsal/plan", "freezeReason": "secondary cutover rehearsal",
 "launchdLabel": "ai.kuma-vault.cutover-driver.rehearsal",
 "gate": C + "/gate.json",
 "env": {"PATH": "$NODEB:/usr/local/bin:/usr/bin:/bin", "SIM_DIR": C + "/sim"},
 "mac": {
   "repo": REPO, "engine": "$ENGINE_CK", "toolsSha256": "$TOOLS_SHA256",
   "vault": [V], "freezeFile": C + "/home/.kuma/vault-freeze.json", "rsync": "rsync",
   "newClone": NC, "links": [], "storesFile": C + "/home/.kuma/vault-stores.json",
   "beforeFreeze": [[V, "sync", "--root", REPO]],
   "storeCommands": ([["store", "rename", OLDID, STORE, "--root", NC]] if kind == "rename" else []) + [store_set],
   "cloneUrl": URL + "/v1/stores/" + STORE + ".git", "cloneTokenFile": RT + "/token",
   "projectsJson": C + "/home/.kuma/projects.json",
   # a list argument with ~ (expanded by the driver), then the client daemon
   "daemonInstall": [sim("daemon", "install", "~/.kuma/vaults/" + STORE),
                     "cd / && nohup %s syncd --repo %s > %s/syncd.log 2>&1 &" % (V, NC, C)],
   "backupRetarget": [],
   "env": {"HOME": C + "/home", "GIT_AUTHOR_NAME": "synth", "GIT_AUTHOR_EMAIL": "synth@localhost",
           "GIT_COMMITTER_NAME": "synth", "GIT_COMMITTER_EMAIL": "synth@localhost"}},
 "prereq": {"engineMasterRef": "HEAD", "checks": ["sudo -n true"]},
 "project": {"id": "second", "statusCmd": sim("status", "--project", "second"),
             "freezeCommands": [sim("route", "disconnect", "chat-1"), sim("routine", "pause", "second-backup")],
             "undoCommands": [sim("route", "connect", "chat-1", "--project", "second"), sim("routine", "resume", "second-backup")],
             "releaseCommands": [sim("route", "connect", "chat-1", "--project", STORE)],
             "waitMinutes": 0.1, "pollSeconds": 2},
 "core": {"controlStatusCmd": sim("control", "status"), "stopCmd": sim("control", "stop-core"),
          "startCmd": sim("control", "start"), "aliveCmd": sim("control", "alive")},
 "server": {"ssh": None, "work": C + "/srv/work/c8", "snapshot": "$CSNAP", "store": STORE,
            "tree": "", "sourceBranch": "main",
            "owner": "rehearsal@example.invalid", "allowedRemote": URL + "/v1/stores/" + STORE + ".git",
            "commitMapRel": "_meta/commit-map.tsv", "rejectRel": "binaries-reject.json",
            "mustIgnore": ["intake/r1/a/source/app.py", "intake/r2/b/source/lib/util.js"],
            "filterRepo": "$FILTER_REPO", "workRoot": RT, "receipts": C + "/srv/receipts",
            "engineLink": RT + "/runtime/current", "vaultsDir": "$VAULTS", "serverConfig": "$CFG",
            "healthUrl": URL + "/v1/health", "installUnits": False},
 "smoke": {"planFile": None, "logFile": "_smoke/log.md", "blobPath": "assets/big.png",
           "rejectPath": "scratch/x.png", "bigPath": "_smoke/too-big.txt", "launchdRestart": False,
           "alarmsWaitSeconds": 180, "alarmsPollSeconds": 5},
 "notify": {"command": sim("notify")},
}
json.dump(cfg, open(C + "/c8.json", "w"), indent=2)
PYSEC
  python3 "$DRV/driver.py" stage --config "$C/c8.json" > /dev/null
  RUN="python3 $C/c8work/driver/driver.py run --config $C/c8work/c8.json"
  snapshot_client > "$C/before.txt"
}

# the runtime stand-in was never called with this (the events file may not exist yet)
never() { if grep -q "$1" "$C/sim/events" 2>/dev/null; then echo "unexpected runtime call: $1"; return 1; fi; }

# what a finished secondary cutover must look like, on the client and on the scratch server
check_sec_done() {
  local NC=$C/home/.kuma/vaults/$STORE old_merges
  [ "$(jq -r .values.c9Ready "$C/c8work/state.json")" = true ]
  # the runtime was never stopped; the project was frozen and released in order
  never 'control stop-core'; [ "$(cat "$C/sim/core")" = up ]
  grep 'route \|routine ' "$C/sim/events" | cut -d' ' -f2- > "$C/project-events.txt"
  diff "$C/project-events.txt" - <<EOF
route disconnect chat-1
routine pause second-backup
route connect chat-1 --project $STORE
EOF
  # the freeze named the old store only and is gone; the old path is a link to the new clone
  [ "$(jq -r .values.freezeStore "$C/c8work/state.json")" = "$OLDID" ]
  [ ! -e "$C/home/.kuma/vault-freeze.json" ]
  [ -L "$CREPO" ]; [ "$(readlink "$CREPO")" = "$NC" ]; [ -d "$CREPO.pre-cutover/.git" ]
  # the tree is the root, the merges are there, the derived cache is out of history, the print file is a pointer
  [ "$(jq -r .id "$NC/vault.config.json")" = "$STORE" ]
  old_merges=$(git -C "$CREPO.pre-cutover" rev-list --merges --count HEAD)
  [ "$old_merges" = 2 ]; [ "$(git -C "$NC" rev-list --merges --count HEAD)" = 2 ]
  [ -n "$(git -C "$CREPO.pre-cutover" log --all --format=%H -- .graph)" ]
  [ -z "$(git -C "$NC" log --all --format=%H -- .graph)" ]
  git -C "$NC" lfs ls-files | grep -q 'models/part.stl'
  [ -f "$NC/_meta/commit-map.tsv" ]
  # step 6: the reference to the first commit is rewritten (same-id case), or nothing is (rename case)
  if [ "$OLDID" = "$STORE" ]; then
    grep -q "see $(git -C "$NC" rev-list --max-parents=0 HEAD) for the start" "$NC/notes/a.md"
  else
    ! grep -q 'for the start' "$NC/notes/a.md"; [ "$(jq -r .values.refmap.candidates "$C/c8work/state.json")" = 0 ]
  fi
  # the cloned-source place: declared (generated block), probed at 6, 8 and by a real file in 12
  sed -n '/>>> kuma-vault generated: binaries.reject/,/<<< kuma-vault generated: binaries.reject/p' "$NC/.gitignore" | grep -qxF 'intake/**/source/'
  jq -e '.values.mustIgnore["6"].missing == [] and .values.mustIgnore["8"].missing == [] and
         (.values.smoke.mustIgnore | .ok and .ignored and (.committed | not) and (.onServer | not))' "$C/c8work/state.json" >/dev/null
  # the alarms were judged after the release; the daemon install argument was expanded
  jq -e '.values.alarms.ok == true and .values.smoke.plan.skipped != null and (.values.smoke | has("alarms") | not)' "$C/c8work/state.json" >/dev/null
  grep -q "daemon install $HOME/.kuma/vaults/$STORE" "$C/sim/events"
  # the server: the store joined backup.stores next to the one already there, its first backup and drill are ok
  [ "$(sudo jq -c '.backup.stores' "$CFG")" = "$(jq -nc --arg a "$EXISTING" --arg b "$STORE" '[$a, $b]')" ]
  [ "$(sudo jq -c '.stores | keys' "$CFG")" = "$(jq -nc --arg a "$EXISTING" --arg b "$STORE" '[$a, $b] | sort')" ]
  $VS server backup status --store "$STORE" | jq -e --arg s "$STORE" '.[$s].lastResult == "ok" and .[$s].lastDrill.result == "ok"' >/dev/null
  # the machine's main store entry is as it was
  [ "$(jq -r '.stores["main-live"] | if type == "object" then .root else . end' "$C/home/.kuma/vault-stores.json")" = "$C/home/.kuma/main-live" ]
}

s_sec_success() {
  fresh_sec sec_success same            # the store keeps its id: the freeze reaches the new clone too
  $RUN --stop-after 11
  local NC=$C/home/.kuma/vaults/$STORE
  # A file the daemon is due to save while the store is frozen (old enough to be past the quiet
  # time; a data file, not a page — a new page would make the folder index drift): the commit gate
  # refuses the autosave, and the status says so. Judged in step 12, that is a failed smoke.
  echo 'written during the freeze' > "$NC/notes/during-freeze.txt"; touch -d '10 minutes ago' "$NC/notes/during-freeze.txt"
  local t=0       # the daemon step 11 started is up before anything nudges it
  until { HOME=$C/home "$E/bin/vault" sync status --json --repo "$NC" || true; } | jq -e '.daemon.running == true' >/dev/null; do
    t=$((t + 1)); [ "$t" -lt 30 ]; sleep 1
  done
  HOME=$C/home "$E/bin/vault" sync now --repo "$NC" > /dev/null || true
  HOME=$C/home "$E/bin/vault" sync status --json --repo "$NC" > "$C/status-frozen.json" || true
  jq -e '.problems | map(select(test("동결"))) | length > 0' "$C/status-frozen.json" >/dev/null
  jq -c '{problems}' "$C/status-frozen.json" > "$REC/sec_success-status-while-frozen.json"
  # the alarms are judged in 13, after the release: the daemon saves the file and the server has it
  local rc=0; $RUN || rc=$?
  receipt sec_success "$rc"; [ "$rc" = 0 ]
  check_sec_done
  t=0
  until git -C "$NC" fetch -q origin && git -C "$NC" cat-file -e origin/main:notes/during-freeze.txt 2>/dev/null; do
    t=$((t + 1)); [ "$t" -lt 30 ]; sleep 2
  done
}
s_sec_rename() {
  fresh_sec sec_rename rename           # the store is renamed on the way (<STORE>-old -> STORE)
  # lock and temporary files that come and go while steps 0-4 copy (ignored names)
  ( n=0; while [ ! -e "$C/churn-stop" ]; do
      mkdir -p "$CREPO/.fts"; head -c 2048 /dev/urandom > "$CREPO/.fts/tmp-$n"; head -c 512 /dev/urandom > "$CREPO/notes/w$n.tmp"
      rm -f "$CREPO/.fts/tmp-$n" "$CREPO/notes/w$n.tmp"; n=$((n + 1)); echo "$n" > "$C/churn-count"
    done ) > /dev/null 2>&1 &
  local churn=$! rc=0
  $RUN --stop-after 4 || rc=$?
  touch "$C/churn-stop"; wait "$churn" || true
  [ "$rc" = 0 ]; [ "$(cat "$C/churn-count")" -gt 10 ]
  echo "junk files created and removed during steps pre-4: $(cat "$C/churn-count")" > "$REC/sec_rename-churn.txt"
  $RUN || rc=$?
  receipt sec_rename "$rc"; [ "$rc" = 0 ]
  check_sec_done
  jq -e --arg o "$OLDID" '.stores | has($o) | not' "$C/home/.kuma/vault-stores.json" >/dev/null
}
s_sec_busy() {
  fresh_sec sec_busy same
  printf 'second\tworker-b\tworking\nother-project\tbusy\tworking\n' > "$C/sim/working"   # a member of the project at work
  local rc=0; $RUN || rc=$?
  receipt sec_busy "$rc"; [ "$rc" = 3 ]
  jq -r .reason "$C/c8work/state.json" | grep -q "project second: 1 working session"
  never 'control stop-core'
  grep -q 'route connect chat-1 --project second' "$C/sim/events"     # the undo of the freeze commands
  expect_restored sec_busy
}
s_sec_refs() {
  fresh_sec sec_refs same
  # a tree ref (an agent's turn checkpoint): pre says no
  git -C "$CREPO" update-ref refs/agent/checkpoints/1 "$(git -C "$CREPO" rev-parse 'HEAD^{tree}')"
  local rc=0; $RUN || rc=$?
  receipt sec_refs-pre "$rc"; [ "$rc" = 3 ]
  jq -r .reason "$C/c8work/state.json" | grep -q 'ref: refs/agent/checkpoints/1 (tree)'
  git -C "$CREPO" update-ref -d refs/agent/checkpoints/1
  expect_restored sec_refs-pre
  # the ref comes back after pre (between the freeze and the last copy): step 4 reads it on the server copy
  $RUN --stop-after 3
  git -C "$CREPO" update-ref refs/agent/checkpoints/2 "$(git -C "$CREPO" rev-parse 'HEAD^{tree}')"
  rc=0; $RUN || rc=$?
  receipt sec_refs "$rc"; [ "$rc" = 4 ]
  jq -r .reason "$C/c8work/state.json" | grep -q 'refs on the server copy'
  git -C "$CREPO" update-ref -d refs/agent/checkpoints/2
  expect_restored sec_refs
}
s_sec_mustignore() {
  fresh_sec sec_mustignore same
  # the reject list loses the cloned-source place; the hand-written .gitignore line is still there
  printf '{\n  "reject": [\n    "scratch/"\n  ]\n}\n' > "$CREPO/binaries-reject.json"
  git -C "$CREPO" check-ignore -q --no-index intake/r1/a/source/app.py       # the old safety net does ignore it
  local rc=0; $RUN || rc=$?
  receipt sec_mustignore "$rc"; [ "$rc" = 3 ]
  jq -r .reason "$C/c8work/state.json" | grep -q 'mustIgnore place not in the generated reject block: intake/r1/a/source/app.py'
  never 'route disconnect'
  git -C "$CREPO" checkout -q -- binaries-reject.json
  expect_restored sec_mustignore
}
s_sec_fail10() {
  fresh_sec sec_fail10 rename
  $RUN --stop-after 9
  setcfg 'c["mac"]["storeCommands"].append(["store", "show", "no-such-store"])'   # step 10 fails after the old path became a link
  local rc=0; $RUN || rc=$?
  receipt sec_fail10 "$rc"; [ "$rc" = 4 ]
  grep -q 'route connect chat-1 --project second' "$C/sim/events"
  expect_restored sec_fail10
}

final_cleanup() {
  say teardown
  stop_syncd
  for m in $(findmnt -rn -o TARGET | grep "^$RT/" || true); do sudo umount "$m"; done
  sudo pkill -u "$SERVE_USER" -f "serve --config $CFG" || true
  for _ in $(seq 1 25); do serve_up || break; sleep 0.2; done
  production > "$REC/production-after.txt"
  sudo rm -rf "$RT"/case-* "$VAULTS" "$RT/etc" "$RT/runtime" "$RT/studio" "$RT/other"
  rm -f "$RT/token" "$RT"/studio-*
  {
    echo "live server before = after: $(cmp -s "$REC/production-before.txt" "$REC/production-after.txt" && echo same || echo DIFFERENT)"
    sed 's/^/  /' "$REC/production-after.txt"
    echo "scratch serve on $URL: $(serve_up && echo STILL-UP || echo stopped)"
    echo "mounts under $RT: $(findmnt -rn -o TARGET | grep -c "^$RT/" || true)"
    echo "client daemons under $RT: $(pgrep -fc "syncd --repo $RT/" || true)"
    echo "left in $RT: $(ls "$RT" | tr '\n' ' ')"
  } | tee "$REC/cleanup.txt"
  cmp -s "$REC/production-before.txt" "$REC/production-after.txt"
}

# a scenario that fails leaves its evidence: the driver logs and state, the server work reports
# and the archived attempt, copied into the receipts (teardown removes the case directories)
CUR=
keep_failure() {
  local rc=$? d
  if [ "$rc" != 0 ] && [ -n "$CUR" ] && [ -d "$RT/case-$CUR" ]; then
    d=$REC/failed-$CUR-$(date +%H%M%S); mkdir -p "$d"
    cp -a "$RT/case-$CUR/c8work/logs" "$RT/case-$CUR/c8work/state.json" "$d/" 2>/dev/null || true
    sudo cp -a "$RT/case-$CUR/srv/receipts" "$RT/case-$CUR/srv/work/c8/reports" "$d/" 2>/dev/null || true
    sudo chown -R "$(id -un)" "$d"; echo "kept the failed case's logs in $d" >&2
  fi
}
trap keep_failure EXIT

for s in "$@"; do
  CUR=$s
  case "$s" in
    setup) setup ;;
    teardown) final_cleanup ;;
    nogo|success|drift|fail7|fail8|fail10|idem|wait|unknown|rbinc|corestop|warmwrite|freeze_gc|slowversion|sec_success|sec_rename|sec_busy|sec_refs|sec_mustignore|sec_fail10)
      say "scenario $s"; "s_$s"; echo "SCENARIO $s PASS" ;;
    *) echo "unknown $s" >&2; exit 2 ;;
  esac
done

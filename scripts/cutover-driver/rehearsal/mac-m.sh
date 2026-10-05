#!/bin/bash
# Rehearsal "M": the whole driver on macOS (bash 3.2, system python3, openrsync, launchd,
# caffeinate), started by the driver's own one-shot LaunchAgent. The server blocks are the
# stand-in (standin-server.sh) with a real loopback `vault serve`; rehearsal "S" runs the real
# blocks on the server.
#
#   RT=<dir> mac-m.sh setup <node-dir> <git-lfs> <engine.bundle> <tools.sha256> <rehearsal.json>
#   RT=<dir> mac-m.sh launchd-success | direct-nogo | drift
#   RT=<dir> mac-m.sh teardown
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
: "${RT:?}"
STORE=${STORE:-c8a-rehearsal-vault}; PORT=${PORT:-7841}
export PATH="$RT/bin:$RT/node/bin:$RT/shims:/usr/bin:/bin:/usr/sbin:/sbin"
E=$RT/engine; V=$E/bin/vault; URL=http://127.0.0.1:$PORT
REC=$RT/receipts; mkdir -p "$REC"
say() { printf '\n### %s %s\n' "$(date +%T)" "$*"; }
DRV=$(dirname "$HERE")

setup() {
  say setup
  mkdir -p "$RT/bin" "$RT/shims" "$RT/serve" "$RT/vaults"
  [ -d "$RT/node" ] || cp -R "$1" "$RT/node"
  cp "$2" "$RT/bin/git-lfs"; chmod +x "$RT/bin/git-lfs"
  rm -rf "$E"; git clone -q -b master "$3" "$E"
  cp "$4" "$RT/tools.sha256"; cp "$5" "$RT/rehearsal.json"
  # GNU `df -B1 --output=avail <path>` for cutover_gate.py when the "server" is this Mac
  cat > "$RT/shims/df" <<'SH'
#!/bin/bash
if [ "${1:-}" = -B1 ] && [ "${2:-}" = --output=avail ]; then
  /usr/bin/python3 -c 'import os,sys; s=os.statvfs(sys.argv[1]); print("Avail"); print(s.f_bavail*s.f_frsize)' "$3"
else exec /bin/df "$@"; fi
SH
  chmod +x "$RT/shims/df"
  # git without this Mac's system/global credential helpers (osxkeychain, cache): a token-mode
  # loopback serve would otherwise have them store the rehearsal token, and the keychain store
  # blocks under launchd. The real cutover clones by tailnet identity (no credentials to store).
  printf '[user]\n\tname = synth\n\temail = synth@localhost\n[filter "lfs"]\n\tclean = git-lfs clean -- %%f\n\tsmudge = git-lfs smudge -- %%f\n\tprocess = git-lfs filter-process\n\trequired = true\n' > "$RT/gitconfig"
  printf '#!/bin/bash\nexec env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=%s /usr/bin/git "$@"\n' "$RT/gitconfig" > "$RT/bin/git"
  chmod +x "$RT/bin/git"
  # serve, token mode on loopback; the token value goes to a 0600 file only
  ( umask 077; node --input-type=module -e "
    import { generateToken, hashToken, writeServerConfig } from '$E/src/server/server-config.mjs';
    import { writeFileSync } from 'node:fs';
    const t = generateToken(); writeFileSync('$RT/serve/token', t + '\n', { mode: 0o600 });
    writeServerConfig('$RT/serve/server.json', { version: 1, listen: ['127.0.0.1:$PORT'], dataDir: '$RT/vaults',
      auth: { mode: 'token' }, tokens: [{ id: 'c8a-rehearsal', sha256: hashToken(t), role: 'writer', stores: ['*'] }], stores: {} });" )
  rm -rf "$RT/studio"; git init -q -b main "$RT/studio"
  for n in B0 C1 C2; do git -C "$RT/studio" -c user.name=s -c user.email=s@l commit -q --allow-empty -m "$n"; git -C "$RT/studio" rev-parse HEAD > "$RT/studio-$n"; done
  git -C "$RT/studio" checkout -q -b side "$(cat "$RT/studio-B0")"; git -C "$RT/studio" -c user.name=s -c user.email=s@l commit -q --allow-empty -m S
  git -C "$RT/studio" rev-parse HEAD > "$RT/studio-S"; git -C "$RT/studio" checkout -q main
  rm -rf "$RT/other"; git init -q "$RT/other"; git -C "$RT/other" -c user.name=s -c user.email=s@l commit -q --allow-empty -m other
  launchctl list | grep -i kuma > "$REC/launchctl-before.txt" || true
  ls -la ~ > "$REC/home-before.txt"
}

serve_down() { [ -f "$RT/serve/serve.pid" ] && kill "$(cat "$RT/serve/serve.pid")" 2>/dev/null || true; rm -f "$RT/serve/serve.pid"; }
case_down() {
  launchctl bootout "gui/$(id -u)/ai.kuma-vault.syncd.$STORE" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/ai.kuma-vault.cutover-driver.rehearsal" 2>/dev/null || true
  rm -f ~/Library/LaunchAgents/ai.kuma-vault.cutover-driver.rehearsal.plist
  serve_down
  node --input-type=module -e "
    import { loadServerConfig, writeServerConfig } from '$E/src/server/server-config.mjs';
    const c = loadServerConfig('$RT/serve/server.json'); delete c.stores['$STORE']; writeServerConfig('$RT/serve/server.json', c);"
  rm -rf "$RT/vaults/$STORE"
}

fresh() {
  local name=$1 c4c=${2:-C1}
  case_down
  C=$RT/case-$name; rm -rf "$C"; mkdir -p "$C/home/.kuma" "$C/srv/kuma-brain" "$C/plans/p" "$C/sim"
  "$HERE/make-synth-vault.sh" "$C/mac/kuma-brain" "$E" > "$C/synth-head"
  ln -s "$C/mac/kuma-brain/vault" "$C/home/.kuma/vault"; ln -s "$C/mac/kuma-brain/vault/plans" "$C/home/.kuma/plans"
  printf '{\n  "stores": {\n    "kuma-brain": "%s"\n  }\n}\n' "$C/home/.kuma/vault" > "$C/home/.kuma/vault-stores.json"
  printf '{"other": "%s", "brain": {"repo": "%s"}}\n' "$RT/other" "$C/mac/kuma-brain" > "$C/home/.kuma/projects.json"
  for p in c1 c2 c3 c4a c4c driver; do printf -- '---\nstatus: completed\n---\n' > "$C/plans/p/$p.md"; done
  cat > "$C/gate.json" <<JSON
{"plansDir": "$C/plans", "prerequisites": ["p/c1", "p/c2", "p/c3", "p/c4a", "p/c4c", "p/driver"],
 "rehearsal": "$RT/rehearsal.json", "server": {"ssh": null, "dataPath": "$RT", "snapshotPath": "$C/srv/kuma-brain"},
 "mac": {"repo": "$C/mac/kuma-brain"}, "diskReserveGB": 8, "marginGB": 5}
JSON
  printf '{"restore_total": [0, 0], "gates": {"G1_keep_missing": 0, "G2_delete_on_mac_unguarded": 0, "G3_keep_x_reject": 0, "G4_head_tracked_x_reject": 0, "G5_clipless_raw_missing": 0, "G6_gone_not_in_step4_count": 0, "G6_step4_still_on_mac": 0}}\n' > "$C/c14d-summary.json"
  echo up > "$C/sim/core"; cat "$RT/studio-C2" > "$C/sim/installed"; printf 'kuma-vault\tsniffed\tworking (sniffing)\nkuma-vault\treaped\tworking [reap:scheduled]\n' > "$C/sim/working"
  /usr/bin/python3 - "$C" "$c4c" <<PY
import json, sys
C, c4c = sys.argv[1:]
RT, STORE, URL, V, K, E = "$RT", "$STORE", "$URL", "$V", "$HERE/kuma-sim.sh", "$E"
NC = C + "/home/.kuma/vaults/" + STORE
sim = lambda *a: [K] + list(a)
cfg = {
 "workDir": C + "/c8work", "plan": "rehearsal/plan", "freezeReason": "cutover rehearsal",
 "launchdLabel": "ai.kuma-vault.cutover-driver.rehearsal", "gate": C + "/gate.json",
 "env": {"PATH": "$PATH", "SIM_DIR": C + "/sim", "STANDIN_DIR": RT + "/serve", "STANDIN_PORT": "$PORT",
         "STANDIN_INSTALLED_SHA": "e60981e",
         "STANDIN_ENGINE": E, "STANDIN_NODE": RT + "/node/bin/node"},
 "mac": {"repo": C + "/mac/kuma-brain", "engine": E, "toolsSha256": RT + "/tools.sha256", "vault": [V],
   "freezeFile": C + "/home/.kuma/vault-freeze.json", "rsync": "/usr/bin/rsync", "newClone": NC,
   "links": [{"path": C + "/home/.kuma/vault", "target": NC + "/vault"}, {"path": C + "/home/.kuma/plans", "target": NC + "/vault/plans"}],
   "storesFile": C + "/home/.kuma/vault-stores.json",
   "beforeFreeze": [[V, "sync", "--root", C + "/mac/kuma-brain/vault"]],
   "storeCommands": [["store", "rename", "kuma-brain", STORE, "--root", NC + "/vault"],
                     ["store", "set", STORE, "--mode", "remote", "--server", URL, "--remote-store", STORE,
                      "--lfs-cache-max-gb", "10", "--token-file", RT + "/serve/token", "--default"]],
   "cloneUrl": URL + "/v1/stores/" + STORE + ".git", "cloneTokenFile": RT + "/serve/token",
   "projectsJson": C + "/home/.kuma/projects.json", "kumaStudio": RT + "/studio",
   "daemonInstall": [[V, "sync", "install", "--repo", NC]],
   "backupRetarget": [sim("routine", "retarget")],
   "env": {"HOME": C + "/home", "KUMA_VAULT_SYNC_DIR": C + "/home/.kuma-vault/sync", "GIT_AUTHOR_NAME": "synth", "GIT_AUTHOR_EMAIL": "synth@localhost",
           "GIT_COMMITTER_NAME": "synth", "GIT_COMMITTER_EMAIL": "synth@localhost"}},
 "prereq": {"studioBackupCommit": open(RT + "/studio-B0").read().strip(), "studioMainRef": "main",
            "c4cLandedSha": open(RT + "/studio-" + c4c).read().strip(),
            "launcherVersionCmd": sim("control", "launcher-version", "--json"), "coreVersionCmd": sim("control", "core-version"),
            "engineMasterRef": "master", "checks": [["/usr/bin/security", "list-keychains"], "ssh -V"]},
 "c14d": {"summary": C + "/c14d-summary.json", "maxAgeHours": 6},
 "core": {"statusCmd": sim("status"), "waitMinutes": 0.1, "pollSeconds": 2, "controlStatusCmd": sim("control", "status"), "stopCmd": sim("control", "stop-core"),
          "startCmd": sim("control", "start"), "aliveCmd": sim("control", "alive")},
 "backup3b": {"command": "sleep 3; echo 'snapshot 0123abcd saved'"},
 "server": {"ssh": None, "standin": "$HERE/standin-server.sh", "work": C + "/srv/work/c8", "snapshot": C + "/srv/kuma-brain",
            "vaultsDir": RT + "/vaults", "serverConfig": RT + "/serve/server.json", "store": STORE,
            "owner": "rehearsal@example.invalid", "allowedRemote": URL + "/v1/stores/" + STORE + ".git",
            "commitMapRel": "projects/kuma-vault/remote-brain/commit-map.tsv",
            "rejectRel": "projects/kuma-vault/remote-brain/binaries-reject.json",
            "extraDeletePathsRel": "vault/projects/kuma-vault/remote-brain/rewrite-extra-delete-paths.txt",
            "filterRepo": "-", "receipts": C + "/srv/receipts", "ignoreTokenIds": ["c8a-rehearsal"]},
 "smoke": {"planFile": "vault/plans/kuma-vault/c8-smoke.md", "logFile": "vault/_c8-smoke/log.md",
           "blobPath": None, "rejectPath": None, "bigPath": None, "launchdRestart": True},
 "notify": {"command": sim("notify")},
}
json.dump(cfg, open(C + "/c8.json", "w"), indent=2)
PY
  /usr/bin/python3 "$DRV/driver.py" stage --config "$C/c8.json" > /dev/null
  W=$C/c8work; RUN="/usr/bin/python3 $W/driver/driver.py run --config $W/c8.json"
}

receipt() {
  local name=$1 rc=$2
  /usr/bin/python3 - "$C" "$name" "$rc" > "$REC/$name.json" <<'PY'
import json, sys, os
C, name, rc = sys.argv[1:]
st = json.load(open(C + "/c8work/state.json"))
v = st["values"]
print(json.dumps({"scenario": name, "driverExit": int(rc), "outcome": st.get("outcome"), "reason": st.get("reason"),
  "steps": {k: {x: s.get(x) for x in ("status", "rc", "reruns", "startedAt", "endedAt", "error")} for k, s in st["steps"].items()},
  "rollback": st.get("rollback"),
  "values": {k: v.get(k) for k in ("HEAD_final", "sessionsCutAtStop", "macClone", "smoke", "c9Ready", "refmap", "drift")},
  "simEvents": open(C + "/sim/events").read().splitlines() if os.path.exists(C + "/sim/events") else []},
  ensure_ascii=False, indent=2))
PY
  echo "receipt $REC/$name.json: $(/usr/bin/python3 -c "import json; d=json.load(open('$REC/$name.json')); print(d['outcome'], d['driverExit'])")"
}

m_launchd_success() {
  fresh launchd
  local at; at=$(/bin/date -v+2M +%Y-%m-%dT%H:%M)
  /usr/bin/python3 "$W/driver/driver.py" launchd install --config "$W/c8.json" --at "$at" | tee "$C/launchd-install.txt"
  launchctl print "gui/$(id -u)/ai.kuma-vault.cutover-driver.rehearsal" | grep -E 'state|path' > "$C/launchd-loaded.txt" || true
  echo "waiting for launchd at $at"
  local n=0
  until [ -f "$W/state.json" ] && /usr/bin/python3 -c "import json,sys; sys.exit(0 if json.load(open('$W/state.json')).get('outcome') else 1)"; do
    sleep 5; n=$((n + 1))
    [ -s "$C/caffeinate-during.txt" ] || pgrep -lf 'caffeinate -dims' > "$C/caffeinate-during.txt" || true
    [ $n -lt 400 ] || { echo "timeout"; return 1; }
  done
  local rc=0; /usr/bin/python3 -c "import json,sys; sys.exit(0 if json.load(open('$W/state.json'))['outcome']=='success' else 1)" || rc=1
  receipt launchd-success "$rc"
  {
    echo "plist after: $(ls ~/Library/LaunchAgents/ai.kuma-vault.cutover-driver.rehearsal.plist 2>&1)"
    echo "job after: $(launchctl print "gui/$(id -u)/ai.kuma-vault.cutover-driver.rehearsal" >/dev/null 2>&1 && echo loaded || echo unloaded)"
    echo "launchd log:"; cat "$W/logs/launchd.log" 2>/dev/null
    echo "caffeinate during run:"; cat "$C/caffeinate-during.txt" 2>/dev/null
    echo "caffeinate after: $(pgrep -lf 'caffeinate -dims' || echo none)"
  } | tee "$REC/launchd-start.txt"
  [ "$rc" = 0 ]
}
m_direct_nogo() {
  fresh nogo S
  local before; before=$(ls -la "$C/home/.kuma"; git -C "$C/mac/kuma-brain" rev-parse HEAD)
  local rc=0; $RUN || rc=$?
  receipt direct-nogo "$rc"
  [ "$rc" = 3 ] && [ "$before" = "$(ls -la "$C/home/.kuma"; git -C "$C/mac/kuma-brain" rev-parse HEAD)" ] && ! grep -q stop-core "$C/sim/events"
}
m_drift() {
  fresh drift
  $RUN --stop-after 3
  echo 'written after the freeze commit' >> "$C/mac/kuma-brain/vault/domains/a/notes.md"
  local rc=0; $RUN || rc=$?
  receipt drift "$rc"
  [ "$rc" = 4 ] && [ "$(readlink "$C/home/.kuma/vault")" = "$C/mac/kuma-brain/vault" ] && [ ! -e "$C/home/.kuma/vault-freeze.json" ]
}

teardown() {
  say teardown
  case_down
  pkill -f "$RT/" 2>/dev/null || true
  # the first M run's daemon (launchd, no HOME override) kept its state under the real home
  [ -d ~/.kuma-vault ] && [ ! -e "$REC/.kuma-vault-existed" ] && rm -rf ~/.kuma-vault
  launchctl list | grep -i kuma > "$REC/launchctl-after.txt" || true
  ls -la ~ > "$REC/home-after.txt"
  diff "$REC/launchctl-before.txt" "$REC/launchctl-after.txt" && echo "launchctl kuma jobs: same as before"
}

cmd=$1; shift
case "$cmd" in
  setup) setup "$@" ;;
  launchd-success) say "$cmd"; m_launchd_success && echo "SCENARIO $cmd PASS" ;;
  direct-nogo) say "$cmd"; m_direct_nogo && echo "SCENARIO $cmd PASS" ;;
  drift) say "$cmd"; m_drift && echo "SCENARIO $cmd PASS" ;;
  teardown) teardown ;;
  *) echo "unknown $cmd" >&2; exit 2 ;;
esac

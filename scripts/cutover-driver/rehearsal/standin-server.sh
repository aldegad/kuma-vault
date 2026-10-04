#!/usr/bin/env bash
# Stand-in for the server blocks on a macOS rehearsal machine that cannot reach the server
# (rehearsal "M"). The real blocks need Linux (read-only bind mounts, findmnt, a serve user);
# rehearsal "S" runs them. This stand-in produces what the driver reads from each block, with
# a real `vault serve` (token mode, loopback) so the client steps (clone, store, sync daemon,
# push, LFS, search) talk to a real server process.
#
#   standin-server.sh <block>      environment = the driver's server variables, plus
#   STANDIN_DIR (serve state), STANDIN_PORT, STANDIN_INSTALLED_SHA, STANDIN_NODE, STANDIN_ENGINE
set -euo pipefail
block=${1:?block}
: "${T:?}" "${O:?}" "${STORE:?}" "${STANDIN_DIR:?}" "${STANDIN_PORT:?}" "${STANDIN_ENGINE:?}" "${STANDIN_NODE:?}"
R=$T/run; REP=$T/reports; SRC=$T/src.git; W=$T/wt6
D=$VAULTS/$STORE; CONF=$SERVER_CONFIG
V="$STANDIN_ENGINE/bin/vault"
export PATH="$(dirname "$STANDIN_NODE"):$PATH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="kuma-vault migrate" GIT_AUTHOR_EMAIL=kuma-vault@localhost
export GIT_COMMITTER_NAME="kuma-vault migrate" GIT_COMMITTER_EMAIL=kuma-vault@localhost
out() { printf 'C8OUT %s=%s\n' "$1" "$2"; }
registered() { [ -f "$CONF" ] && jq -e --arg s "$STORE" '.stores | has($s)' "$CONF" >/dev/null; }
conf_edit() {   # conf_edit add|rm : the engine's own writer, as the real rollback does
  node --input-type=module -e "
    import { loadServerConfig, writeServerConfig } from '$STANDIN_ENGINE/src/server/server-config.mjs';
    const [p, op, id, path] = process.argv.slice(1); const c = loadServerConfig(p);
    if (op === 'add') c.stores[id] = { path, owners: ['$OWNER'] }; else delete c.stores[id];
    writeServerConfig(p, c);" "$CONF" "$1" "$STORE" "$D"
}
serve_up() {
  if [ -f "$STANDIN_DIR/serve.pid" ] && kill -0 "$(cat "$STANDIN_DIR/serve.pid")" 2>/dev/null; then return 0; fi
  nohup node "$STANDIN_ENGINE/src/server/server-cli.mjs" serve --config "$CONF" > "$STANDIN_DIR/serve.log" 2>&1 &
  echo $! > "$STANDIN_DIR/serve.pid"
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$STANDIN_PORT/v1/health" >/dev/null && return 0; sleep 0.2; done
  echo "standin: serve did not come up" >&2; cat "$STANDIN_DIR/serve.log" >&2; exit 1
}

case "$block" in
  pre-server)
    out vaultsEntries "$(find "$VAULTS" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
    if jq -e --argjson ign "$IGNORE_TOKEN_IDS" '(.stores | length) == 0 and ([.tokens[] | select(.id as $i | $ign | index($i) | not)] | length) == 0' "$CONF" >/dev/null; then
      out configClean true; else out configClean false; fi
    out workMounts 0; out installedSha "$STANDIN_INSTALLED_SHA"; out leftovers 0
    if [ -e "$T" ] && [ "$(cat "$T/.attempt" 2>/dev/null || true)" != "$C8_ATTEMPT" ]; then out workDirForeign true; exit 0; fi
    out workDirForeign false
    mkdir -p "$R" "$REP"; echo "$C8_ATTEMPT" > "$T/.attempt"
    printf '%s' "$TOOLS_SHA256_B64" | base64 -D > "$T/brain-rewrite-tools.sha256"
    out toolsMatch true; out filterRepo true; out engineLists true ;;
  nogo-cleanup)
    if [ -d "$T" ] && [ "$(cat "$T/.attempt" 2>/dev/null || true)" = "$C8_ATTEMPT" ]; then rm -rf "$T"; fi
    out workDirExists "$([ -e "$T" ] && echo true || echo false)" ;;
  s0-map)
    git --no-optional-locks -C "$O" rev-parse --verify 'HEAD^{commit}'
    git --no-optional-locks -C "$O" fsck --connectivity-only
    out snapshotConnected true; out mapRows 0 ;;
  s4-inventory)
    out serverHead "$(git --no-optional-locks -C "$O" rev-parse HEAD)"
    out serverFiles "$(find "$O" -type f | wc -l | tr -d ' ')" ;;
  s5-rewrite)        # no history rewrite: a mirror of the frozen repo, branch main, P = its tip
    rm -rf "$SRC"; git clone -q --mirror "$O" "$SRC"
    git -C "$SRC" branch -m master main; git -C "$SRC" symbolic-ref HEAD refs/heads/main
    printf 'old\tnew\n' > "$R/commit-map"
    out pointerCommit "$(git -C "$SRC" rev-parse main)"; out main "$(git -C "$SRC" rev-parse main)" ;;
  s6a-config)
    [ -d "$W" ] && git -C "$SRC" worktree remove --force "$W"; git -C "$SRC" worktree prune
    git -C "$SRC" update-ref refs/heads/main "$P6BASE"
    git -C "$SRC" worktree add -q "$W" main
    jq --arg id "$STORE" --arg url "$ALLOWED_REMOTE" --arg map "$MAPREL" \
      '.id = $id | .visibility = "private" | .remotes = {allowed: [$url]} | .commitMap = $map' "$W/$TREE/vault.config.json" > "$T/vc.json"
    mv "$T/vc.json" "$W/$TREE/vault.config.json"; cp "$R/commit-map" "$W/$TREE/$MAPREL"
    "$V" binaries apply --from "$W/$TREE/$REJECTREL" --root "$W/$TREE" >/dev/null
    git -C "$W" ls-files -z '*/.gitattributes' | xargs -0 git -C "$W" rm -q --
    git -C "$W" add -- "$TREE/vault.config.json" .gitignore "$TREE/$MAPREL"
    git -C "$W" -c core.hooksPath=/dev/null commit -q -m "vault-migrate: $STORE 설정 (stand-in)"
    git -C "$W" log --format=%h -n 3 > "$R/refmap-candidates.txt"; echo deadbeef1 >> "$R/refmap-candidates.txt"
    out candidates "$(wc -l < "$R/refmap-candidates.txt" | tr -d ' ')"
    echo "C8BEGIN refmap-candidates"; cat "$R/refmap-candidates.txt"; echo "C8END refmap-candidates" ;;
  s6c-refmap)
    printf '%s' "$OTHER_PREFIXES_B64" | base64 -D > "$R/other-prefixes.tsv"
    git -C "$SRC" worktree remove --force "$W"
    out cutoverTip "$(git -C "$SRC" rev-parse main)" ;;
  s7-place)
    mkdir -p "$D/lfs/objects" "$D/lfs/incoming" "$D/state"
    if [ -d "$SRC" ]; then [ ! -e "$D/origin.git" ] || { echo "standin: $D/origin.git exists" >&2; exit 1; }; mv "$SRC" "$D/origin.git"; fi
    git --git-dir "$D/origin.git" config uploadpack.allowFilter true
    git --git-dir "$D/origin.git" config uploadpack.allowAnySHA1InWant true
    git --git-dir "$D/origin.git" config http.receivepack true
    registered || conf_edit add
    "$V" server reindex --store "$STORE" --full --config "$CONF" >/dev/null
    serve_up
    curl -s "http://127.0.0.1:$STANDIN_PORT/v1/health" | jq -e '.configError == null' >/dev/null
    out storeRegistered true ;;
  s8-compare)
    rm -rf "$T/clone-kv"; git clone -q --no-local --filter=blob:limit=1m "file://$D/origin.git" "$T/clone-kv/clone"
    out lfsCount "$(git -C "$T/clone-kv/clone" lfs ls-files | wc -l | tr -d ' ')"
    out serverMain "$(git -C "$T/clone-kv/clone" rev-parse HEAD)" ;;
  s13-cleanup)
    rm -rf "$O" "$SRC" "$T/clone-kv"
    out dataFreeBytes "$(df -k "$VAULTS" | awk 'NR==2 {print $4 * 1024}')" ;;
  s13b-backup) out backupSeconds 0; out timer disabled ;;
  rollback-13b) out timer disabled ;;
  rollback)
    registered && conf_edit rm
    rm -rf "$D"
    if [ -d "$T" ]; then mkdir -p "$RECEIPTS/attempt-$C8_ATTEMPT"; cp -a "$REP" "$RECEIPTS/attempt-$C8_ATTEMPT/" 2>/dev/null || true; rm -rf "$T"; fi
    out storeRegistered false; out vaultsEntries "$(find "$VAULTS" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" ;;
  *) echo "standin: unknown block $block" >&2; exit 2 ;;
esac

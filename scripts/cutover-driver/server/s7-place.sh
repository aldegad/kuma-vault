# Step 7: placement and registration. Each move happens once: a re-run finds src.git / the CAS
# already in the store and goes on with the idempotent engine commands.
D=$VAULTS/$STORE
if [ -d "$SRC" ]; then
  git -C "$SRC" show "main:$(tp vault.config.json)" > "$T/vault.config.6.json"
  cp "$SRC/filter-repo/commit-map" "$T/commit-map.tsv"
  git -C "$SRC" config --unset core.ignorecase || true; git -C "$SRC" config --unset core.precomposeunicode || true
  # a client hooksPath copied with the config would switch the receive hooks off
  git -C "$SRC" config --unset-all core.hooksPath || true
fi
cd /
sudo mkdir -p "$D/lfs"
if [ -d "$SRC" ]; then
  sudo test ! -e "$D/origin.git" || { echo "c8: $D/origin.git exists" >&2; exit 1; }
  sudo mv "$SRC" "$D/origin.git"
fi
if [ -d "$CAS" ]; then
  sudo test ! -e "$D/lfs/objects" || { echo "c8: $D/lfs/objects exists" >&2; exit 1; }
  sudo mv "$CAS" "$D/lfs/objects"
fi
sudo test -d "$D/origin.git" && sudo test -d "$D/lfs/objects"
$VS server init-store "$STORE" --owner "$OWNER"
sudo install -o "$SERVE_USER" -g "$SERVE_USER" -m 0640 "$T/commit-map.tsv" "$D/state/commit-map.tsv"
$VS server set-reject --store "$STORE" --from "$T/vault.config.6.json" ${TREE:+--tree-prefix "$TREE"}
store_registered
[ -z "$(sudo git --git-dir "$D/origin.git" config --get core.hooksPath || true)" ]
sudo test -x "$D/origin.git/hooks/pre-receive"
# serve re-reads its configuration on a request, at most once a second: a request sooner than that
# after the last check still sees the old one (no store; configError of the old file). A request
# more than a second after the registration makes it re-read, so this answer and step 8's clone
# see the new store.
sleep 1.2
curl -s "$HEALTH_URL" | jq -e '.configError == null' >/dev/null
out storeRegistered true

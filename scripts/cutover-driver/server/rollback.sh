# 5.7 "after 3 - before 10", server half: no mount left, store out of server.json, store
# directory deleted, the old copy's owner back (7's chown -R went through the CAS hardlinks),
# small evidence archived, work directory deleted. The old copy keeps its content.
release_mounts
if store_registered; then
  sudo env PATH="$NODE_BIN:/usr/bin:/bin" node --input-type=module -e "
    import { loadServerConfig, writeServerConfig } from '$E/src/server/server-config.mjs';
    const [path, id] = process.argv.slice(1);
    const config = loadServerConfig(path);
    delete config.stores[id];
    writeServerConfig(path, config);" "$SERVER_CONFIG" "$STORE"
fi
store_registered && { echo "c8: $STORE still in $SERVER_CONFIG" >&2; exit 1; }
sudo rm -rf "${VAULTS:?}/${STORE:?}"
if [ "${CHOWN_BACK:-0}" = 1 ] && [ -d "$O" ]; then sudo chown -R "$ADMIN_USER:$ADMIN_USER" "$O"; fi
if [ -d "$T" ]; then
  A=$RECEIPTS/attempt-$C8_ATTEMPT
  mkdir -p "$A"
  [ -d "$REP" ] && cp -a "$REP" "$A/reports" || true
  for f in "$R"/*.json "$R"/commit-map* "$R"/refmap-*.tsv; do [ -f "$f" ] && cp -a "$f" "$A/" || true; done
  sudo rm -rf "${T:?}"
fi
out storeRegistered false
out vaultsEntries "$(sudo find "$VAULTS" -mindepth 1 -maxdepth 1 | wc -l)"

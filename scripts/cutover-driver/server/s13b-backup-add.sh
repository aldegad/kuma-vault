# Step 13b, secondary mode: the server already backs up other stores. Add this store to the
# configured backup.stores list (null = every store, nothing to add), then back up and drill
# this store alone — the nightly unit and its other stores are not run or changed. The list
# before is printed first, so the report always says what it was.
before=$(sudo jq -c '.backup.stores' "$SERVER_CONFIG")
out backupStoresBefore "$before"
if [ "$before" != null ]; then
  stores=$(sudo jq -r --arg s "$STORE" '.backup.stores + ([$s] - .backup.stores) | join(",")' "$SERVER_CONFIG")
  $VS server backup configure --stores "$stores" >/dev/null
fi
out backupStoresAfter "$(sudo jq -c '.backup.stores' "$SERVER_CONFIG")"
sudo jq -e --arg s "$STORE" '.backup.stores == null or (.backup.stores | index($s) != null)' "$SERVER_CONFIG" >/dev/null
t0=$(date +%s)
$VS server backup run --store "$STORE"
$VS server backup drill --store "$STORE"
out backupSeconds "$(( $(date +%s) - t0 ))"
$VS server backup status --store "$STORE" | tee "$REP/13b-backup-status.json"
jq -e --arg s "$STORE" '.[$s].lastResult == "ok" and .[$s].lastDrill.result == "ok"' "$REP/13b-backup-status.json" >/dev/null

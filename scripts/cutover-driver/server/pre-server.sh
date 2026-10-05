# Prerequisites 3 and 4, server half. Read only, except creating $T with the tool copy
# (prerequisite 3 is judged on the copy, before python writes any __pycache__).
if [ "$MODE" = secondary ]; then
  # other stores live here: this store id is free (no data directory, no config entry), the
  # configuration loads, and a backup block exists for 13b to add the store to
  if sudo test -e "$VAULTS/$STORE" || store_registered; then out storeAbsent false; else out storeAbsent true; fi
  if $VS server store list >/dev/null; then out configValid true; else out configValid false; fi
  if sudo jq -e '.backup != null' "$SERVER_CONFIG" >/dev/null; then out backupConfigured true; else out backupConfigured false; fi
else
  n=$(sudo find "$VAULTS" -mindepth 1 -maxdepth 1 | wc -l); out vaultsEntries "$n"
  if sudo jq -e --argjson ign "$IGNORE_TOKEN_IDS" \
       '(.stores | length) == 0 and ([.tokens[] | select(.id as $i | $ign | index($i) | not)] | length) == 0' \
       "$SERVER_CONFIG" >/dev/null; then out configClean true; else out configClean false; fi
fi
out workMounts "$(findmnt -rn -o TARGET | grep -c "^$(realpath -m "$WORK_ROOT")/" || true)"
out installedSha "$(basename "$E")"
left=0
for p in $CLEAN_ABSENT; do if [ -e "$p" ]; then echo "c8: leftover $p" >&2; left=$((left + 1)); fi; done
out leftovers "$left"
# $T belongs to this attempt (marker) or must not exist: a work directory left by another
# attempt that was not archived means someone has to look — the driver says no-go.
if [ -e "$T" ] && [ "$(cat "$T/.attempt" 2>/dev/null || true)" != "$C8_ATTEMPT" ]; then
  out workDirForeign true; exit 0
fi
out workDirForeign false
mkdir -p "$R" "$REP" "$T/bin"
echo "$C8_ATTEMPT" > "$T/.attempt"
rm -rf "$T/tools"
cp -a "$E/scripts/brain-rewrite" "$T/tools"
printf '%s' "$TOOLS_SHA256_B64" | base64 -d > "$T/brain-rewrite-tools.sha256"
# every file of the copy is in the list, and the list matches
if (cd "$T/tools" && sha256sum -c --strict --quiet ../brain-rewrite-tools.sha256) \
   && [ "$(find "$T/tools" -type f | wc -l)" = "$(grep -c . "$T/brain-rewrite-tools.sha256")" ]; then
  out toolsMatch true; else out toolsMatch false; fi
cp "$FILTER_REPO_SRC" "$T/bin/git-filter-repo"
if echo "$FR_SHA256  $T/bin/git-filter-repo" | sha256sum -c --quiet -; then out filterRepo true; else out filterRepo false; fi
if python3 -c "import sys; sys.path.insert(0, '$T/tools'); import brainrw; assert brainrw.check_engine_lists()"; then
  out engineLists true; else out engineLists false; fi
out freeBytes "$(df -B1 --output=avail "$T" | tail -1 | tr -d ' ')"

# Step 13, server half: delete the old copy (mount check first), re-run the CAS sample on the
# store, make the CAS read-only, keep maps and reports, delete the rest.
D=$VAULTS/$STORE
release_mounts
[ -z "$(mounts_under "$O")" ]
sudo rm -rf "$O"
[ -d "$SRC" ] && sudo rm -rf "$SRC" || true
sudo rm -rf "$T/old.git" "$T/clone-kv" "$W"
sudo install -d -o "$SERVE_USER" -g "$SERVE_USER" "$T/13"
sudo -u "$SERVE_USER" env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null LC_ALL=C PYTHONDONTWRITEBYTECODE=1 \
  python3 "$T/tools/verify.py" cas --gitdir "$D/origin.git" --run "$R" --cas "$D/lfs/objects" --report "$T/13/7c-after-delete.json"
cp "$T/13/7c-after-delete.json" "$REP/" && sudo rm -rf "$T/13"
sudo find "$D/lfs/objects" -type f -exec chmod 0444 {} +
rm -rf "$T/tools" "$T/bin" "$T/cas" "$MP" "$T/vc.json"
out dataFreeBytes "$(df -B1 --output=avail "$VAULTS" | tail -1 | tr -d ' ')"
out dataUsedBytes "$(df -B1 --output=used "$VAULTS" | tail -1 | tr -d ' ')"

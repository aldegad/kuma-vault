# Step 8, server half: file:// partial test clone as the serve user, comparison with the old
# worktree, then the original comparison against the inventory taken before step 5.
C=$T/clone-kv
sudo rm -rf "$C"
sudo install -d -o "$SERVE_USER" -g "$SERVE_USER" "$C"
sudo -u "$SERVE_USER" env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  git clone -q --no-local --filter=blob:limit=1m "file://$VAULTS/$STORE/origin.git" "$C/clone"
sudo chown -R "$ADMIN_USER:$ADMIN_USER" "$C" && du -sB1 "$C/clone" | cut -f1 > "$R/clone-alloc"
{ tail -n +2 "$R/refmap-applied.tsv" | cut -f1 | sort -u
  printf '%s\n' .gitignore "$TREE/vault.config.json" "$TREE/$MAPREL"
  git -c core.quotePath=false -C "$C/clone" diff --name-only --diff-filter=D "$(jq -r .p "$R/pointer-commit.json")" HEAD -- '*/.gitattributes'
} > "$R/allowed-changes.txt"
$PY/stage8_compare.py --old-worktree "$O" --clone "$C/clone" --run "$R" --allowed-changes "$R/allowed-changes.txt" --report "$REP/stage8.json"
git -C "$C/clone" lfs ls-files | wc -l | tr -d ' ' > "$R/lfs-files-count"
rm -rf "$REP/src-after8"
$PY/source_inventory.py take --repo "$O" --out "$REP/src-after8" --fsck connectivity-only
$PY/source_inventory.py compare --before "$REP/src-after4" --after "$REP/src-after8" --report "$REP/source-compare.json"
out lfsCount "$(cat "$R/lfs-files-count")"
out serverMain "$(git -C "$C/clone" rev-parse HEAD)"

# Step 0, after the warm-up rsync: junk list + first map (cold cache).
# The warm copy is read as a repository below. Refuse a disconnected copy before mapping;
# this is a no-go, never a retry of a live source.
GIT_CONFIG_NOSYSTEM=1 git --no-optional-locks -C "$O" rev-parse --verify 'HEAD^{commit}'
GIT_CONFIG_NOSYSTEM=1 git --no-optional-locks -C "$O" fsck --connectivity-only
out snapshotConnected true
$PY/delete_paths.py --repo "$O" --worktree "$O" --tree "$TREE" "${XRARGS[@]}" --out "$R/delete-paths.txt" --report "$REP/delete-paths-0.json"
jq -e '.engineListsCompared == true' "$REP/delete-paths-0.json" >/dev/null
$PY/final_map.py --worktree "$O" --cache "$R/map-cache.tsv" --cas "$CAS" --lfs-objects "$O/.git/lfs/objects" \
  --delete-paths "$R/delete-paths.txt" --out "$R/final-map-0.tsv" --report "$REP/final-map-0.json"
out mapRows "$(wc -l < "$R/final-map-0.tsv")"

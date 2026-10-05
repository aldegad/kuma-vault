# Step 5 = pipeline 1-7 (5.4). A re-run (driver killed mid-step) starts from a clean slate:
# the previous run's process group is gone (driver guard), mounts released, src.git dropped.
# The CAS links of the map are kept — final_map skips the ones that exist.
mkdir -p "$R" "$REP"
release_mounts
[ -d "$SRC" ] && git -C "$SRC" worktree prune || true
rm -rf "$SRC" "$T/old.git" "$W" "$REP/src-after4"
$PY/source_inventory.py take --repo "$O" --out "$REP/src-after4" --fsck connectivity-only
$PY/delete_paths.py --repo "$O" --worktree "$O" --tree "$TREE" "${XRARGS[@]}" --out "$R/delete-paths.txt" --report "$REP/delete-paths.json"
jq -e '.engineListsCompared == true' "$REP/delete-paths.json" >/dev/null
$PY/final_map.py --worktree "$O" --cache "$R/map-cache.tsv" --cas "$CAS" --lfs-objects "$O/.git/lfs/objects" \
  --delete-paths "$R/delete-paths.txt" --out "$R/final-map.tsv" --report "$REP/final-map.json"
$PY/strip_list.py --repo "$O" --final-map "$R/final-map.tsv" --delete-paths "$R/delete-paths.txt" --out "$R/strip-blob-ids.txt" --report "$REP/strip.json"
"$T/tools/isolate.sh" mount "$O/.git/objects" "$MP"
"$T/tools/isolate.sh" bare "$O/.git" "$SRC" "$MP"
"$T/tools/rewrite.sh" filter "$SRC" "$R"
"$T/tools/rewrite.sh" independent "$SRC"
"$T/tools/isolate.sh" umount "$MP"
$PY/pointer_commit.py --gitdir "$SRC" --final-map "$R/final-map.tsv" --run "$R" --worktree "$O" \
  --source-branch "$SOURCE_BRANCH" --branch main --report "$R/pointer-commit.json"
$PY/verify.py fsck  --gitdir "$SRC" --report "$REP/7a-fsck.json"
$PY/verify.py trees --gitdir "$SRC" --old-gitdir "$O" --old-worktree "$O" --run "$R" --report "$REP/7b-trees.json"
$PY/verify.py cas   --gitdir "$SRC" --run "$R" --cas "$CAS" --report "$REP/7c-cas.json"
$PY/verify.py sizes --gitdir "$SRC" --run "$R" --cas "$CAS" --report "$REP/7d-sizes.json"
out pointerCommit "$(jq -r .p "$R/pointer-commit.json")"
out main "$(git -C "$SRC" rev-parse main)"

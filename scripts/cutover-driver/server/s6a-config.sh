# Step 6, first half: settings commit + refmap dry-run in a temporary worktree of src.git.
# A re-run puts main back on the pointer commit P first, so nothing is committed twice.
release_mounts
if [ -d "$W" ]; then git -C "$SRC" worktree remove --force "$W"; fi
git -C "$SRC" worktree prune
rm -rf "$T/old.git"
git -C "$SRC" update-ref refs/heads/main "$P6BASE"
git -C "$SRC" config user.name "kuma-vault migrate"; git -C "$SRC" config user.email kuma-vault@localhost
GIT_LFS_SKIP_SMUDGE=1 git -C "$SRC" worktree add -q "$W" main
jq --arg id "$STORE" --arg url "$ALLOWED_REMOTE" --arg map "$MAPREL" \
   '.id = $id | .visibility = "private" | .remotes = {allowed: [$url]} | .commitMap = $map' \
   "$W/$TREE/vault.config.json" > "$T/vc.json"
mv "$T/vc.json" "$W/$TREE/vault.config.json"
cp "$SRC/filter-repo/commit-map" "$W/$TREE/$MAPREL"
$V binaries apply --from "$W/$TREE/$REJECTREL" --root "$W/$TREE"
git -C "$W" ls-files -z '*/.gitattributes' | xargs -0 -r git -C "$W" rm -q --
git -C "$W" add -- "$TREE/vault.config.json" .gitignore "$TREE/$MAPREL"
git -C "$W" commit -q -m "vault-migrate: $STORE 설정 (id·visibility·remotes·commitMap·binaries.reject, 하위 .gitattributes 정리)"
"$T/tools/isolate.sh" mount "$O/.git/objects" "$MP"
"$T/tools/isolate.sh" bare "$O/.git" "$T/old.git" "$MP"
$V migrate refmap --repo "$W" --map "$W/$TREE/$MAPREL" --from-git-dir "$T/old.git" \
  --review-out "$R/refmap-review.tsv" --applied-out "$R/refmap-applied.tsv" > "$REP/refmap-dry.json"
tail -n +2 "$R/refmap-applied.tsv" | cut -f3 | sort -u > "$R/refmap-candidates.txt"
out candidates "$(wc -l < "$R/refmap-candidates.txt")"
echo "C8BEGIN refmap-candidates"; cat "$R/refmap-candidates.txt"; echo "C8END refmap-candidates"

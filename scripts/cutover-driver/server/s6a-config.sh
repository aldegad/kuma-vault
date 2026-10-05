# Step 6, first half: settings commit + refmap dry-run in a temporary worktree of src.git.
# A re-run puts main back on the pointer commit P first, so nothing is committed twice.
release_mounts
if [ -d "$W" ]; then git -C "$SRC" worktree remove --force "$W"; fi
git -C "$SRC" worktree prune
rm -rf "$T/old.git"
git -C "$SRC" update-ref refs/heads/main "$P6BASE"
git -C "$SRC" config user.name "kuma-vault migrate"; git -C "$SRC" config user.email kuma-vault@localhost
GIT_LFS_SKIP_SMUDGE=1 git -C "$SRC" worktree add -q "$W" main
VC=$(tp vault.config.json); MAP=$(tp "$MAPREL")
jq --arg id "$STORE" --arg url "$ALLOWED_REMOTE" --arg map "$MAPREL" \
   '.id = $id | .visibility = "private" | .remotes = {allowed: [$url]} | .commitMap = $map' \
   "$W/$VC" > "$T/vc.json"
mv "$T/vc.json" "$W/$VC"
mkdir -p "$(dirname "$W/$MAP")"
cp "$SRC/filter-repo/commit-map" "$W/$MAP"
$V binaries apply --from "$W/$(tp "$REJECTREL")" --root "$W/$TREE"
git -C "$W" ls-files -z '*/.gitattributes' | xargs -0 -r git -C "$W" rm -q --
git -C "$W" add -- "$VC" .gitignore "$MAP"
git -C "$W" commit -q -m "vault-migrate: $STORE 설정 (id·visibility·remotes·commitMap·binaries.reject, 하위 .gitattributes 정리)"
# the root .gitignore as committed: the driver checks that the configured must-ignore places are
# ignored by its generated blocks (a hand-written line there is not enough)
echo "C8BEGIN gitignore"; cat "$W/.gitignore"; echo "C8END gitignore"
"$T/tools/isolate.sh" mount "$O/.git/objects" "$MP"
"$T/tools/isolate.sh" bare "$O/.git" "$T/old.git" "$MP"
$V migrate refmap --repo "$W" --map "$W/$MAP" --from-git-dir "$T/old.git" \
  --review-out "$R/refmap-review.tsv" --applied-out "$R/refmap-applied.tsv" > "$REP/refmap-dry.json"
tail -n +2 "$R/refmap-applied.tsv" | cut -f3 | sort -u > "$R/refmap-candidates.txt"
out candidates "$(wc -l < "$R/refmap-candidates.txt")"
echo "C8BEGIN refmap-candidates"; cat "$R/refmap-candidates.txt"; echo "C8END refmap-candidates"

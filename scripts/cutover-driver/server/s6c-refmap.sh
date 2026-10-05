# Step 6, second half: refmap with the client's other-repository prefixes, then commit.
printf '%s' "$OTHER_PREFIXES_B64" | base64 -d > "$R/other-prefixes.tsv"
$V migrate refmap --repo "$W" --map "$W/$(tp "$MAPREL")" --from-git-dir "$T/old.git" \
  --other-repo-prefixes "$R/other-prefixes.tsv" --map-label "$MAPREL" \
  --review-out "$R/refmap-review.tsv" --applied-out "$R/refmap-applied.tsv" --commit > "$REP/refmap.json"
# a commit when references changed; none when nothing was rewritable (a small vault, or every
# token sent to review) — the cutover goes on without one
jq -e '.written == true and ((.commit | type == "string") or .changedFiles == 0)' "$REP/refmap.json" >/dev/null
"$T/tools/isolate.sh" umount "$MP" && "$T/tools/isolate.sh" check "$T" && rm -rf "$T/old.git"
git -C "$SRC" worktree remove "$W"
git -C "$SRC" config --unset user.name; git -C "$SRC" config --unset user.email
out cutoverTip "$(git -C "$SRC" rev-parse main)"
out refmapApplied "$(jq -r '.applied // .replaced // empty' "$REP/refmap.json" 2>/dev/null || true)"

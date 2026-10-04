# Step 4 (c): the server copy after the last rsync. Original-read rule: no system config, no
# optional locks, nothing that refreshes the index.
g() { git --no-optional-locks -C "$O" "$@"; }
out serverHead "$(g rev-parse HEAD)"
g count-objects -v
g fsck --connectivity-only --no-progress
out serverFiles "$(find "$O" -type f | wc -l)"
out serverBytes "$(du -sB1 --apparent-size "$O" | cut -f1)"

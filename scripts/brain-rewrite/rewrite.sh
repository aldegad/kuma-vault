#!/usr/bin/env bash
# Rewrite pipeline steps 4 and 4'.
#
#   rewrite.sh filter      <src.git> <run>   filter-repo with delete-paths, lfsify.py, attrs.py
#   rewrite.sh independent <src.git>         4': drop stale commit-graph, repack -a -d (no -l),
#                                            remove alternates, write a fresh commit-graph
#
# Needs GIT_FILTER_REPO = path of git-filter-repo 2.47.0 (sha256 67447413…7d94, checked here).
#
# Flags beyond the pipeline's step-4 list, with reasons:
#   --force                   src.git is an isolated copy that carries the original's
#                             reflog and its packs + loose objects, so the
#                             fresh-clone check refuses it. The check protects a repo with
#                             unpushed work; here nothing writes back to the original
#                             (ro alternates), which is what makes the copy disposable.
# Paths are put in NFC (server receive rule 2) by attrs.py, not a filename callback:
# filter-repo refuses --filename-callback together with --file-info-callback.
#   --preserve-commit-hashes  filter-repo otherwise rewrites hex commit ids inside commit
#                             messages; the pipeline keeps messages as they were
#                             and tail-replay must produce the same bytes.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
FR_SHA256=67447413e273fc76809289111748870b6f6072f08b17efe94863a92d810b7d94
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null LC_ALL=C

cmd=${1:?command}; shift
case "$cmd" in
  filter)
    src=$(realpath "${1:?src.git}"); run=$(realpath "${2:?run}")
    fr=${GIT_FILTER_REPO:?set GIT_FILTER_REPO}
    echo "$FR_SHA256  $fr" | sha256sum -c --quiet -
    python3 "$HERE/prepare_attrs.py" --gitdir "$src" --run "$run"
    python3 "$HERE/nfc_plan.py" --repo "$src" --out "$run/nfc-keep.tsv"
    export BRW_TOOLS=$HERE BRW_RUN=$run BRW_GITDIR=$src
    old_count=$(git -C "$src" rev-list --all --count)
    (cd "$src" && python3 "$fr" --force --preserve-commit-hashes \
        --invert-paths --paths-from-file "$run/delete-paths.txt" \
        --file-info-callback "$HERE/lfsify.py" \
        --commit-callback "$HERE/attrs.py" \
        --replace-refs update-and-add \
        --prune-empty never --prune-degenerate never) > "$run/filter-repo.log" 2>&1 \
      || { tail -20 "$run/filter-repo.log" >&2; exit 1; }
    rows=$(($(wc -l < "$src/filter-repo/commit-map") - 1))
    pruned=$(awk 'NR>1 && $2 ~ /^0+$/' "$src/filter-repo/commit-map" | wc -l)
    replace=$(git -C "$src" for-each-ref refs/replace | wc -l)
    echo "filter-repo: commits $old_count, commit-map $rows, pruned $pruned, replace refs $replace"
    [ "$rows" -eq "$old_count" ] && [ "$pruned" -eq 0 ] && [ "$replace" -eq "$old_count" ] \
      || { echo "rewrite: commit-map is not 1:1" >&2; exit 1; }
    ;;
  independent)
    src=$(realpath "${1:?src.git}")
    rm -f "$src/objects/info/commit-graph"; rm -rf "$src/objects/info/commit-graphs"
    git -C "$src" repack -a -d -q
    rm "$src/objects/info/alternates"
    git -C "$src" commit-graph write --reachable >/dev/null
    git -C "$src" count-objects -v
    ;;
  *) echo "rewrite: unknown command $cmd" >&2; exit 2 ;;
esac

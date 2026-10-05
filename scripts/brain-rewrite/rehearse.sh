#!/usr/bin/env bash
# Rehearsal of the history-rewrite pipeline on an isolated copy of the server snapshot. The
# original is read only: worktree via cp -al hardlinks (never written), objects
# through a read-only bind mount, everything else of .git as real copies.
#
#   rehearse.sh <env-file> <step>...      steps run in the order given
#   rehearse.sh <env-file> all            the full rehearsal (not cleanup)
#   rehearse.sh <env-file> cleanup        unmount, findmnt check, delete the large copies
#
# env-file (sourced): ORIG (original repo), WORK (empty work dir on the same
# filesystem), GIT_FILTER_REPO, optional NODE (the refmap and receive steps), TAIL (commits for
# the tail-replay test, default 50),
# EXTRA_DELETE_PATHS (repo-specific junk rules for delete_paths.py), ENGINE_SERVER
# (engine checkout whose src/server receive rules the result must pass), SOURCE_BRANCH
# (the branch the original works on, default master), VAULT_TREE (the vault tree inside
# the repository, default vault; empty when the repository root is the tree).
#
# Steps, with the cutover step they stand for:
#   inventory-before   source content inventory + fsck --full of ORIG
#   snap               mount ORIG/.git/objects read-only, build the isolated snap
#   freeze             step 3 imitation in snap: text-only commit, hooks disabled
#   delete-paths mime map-cold map-warm strip         pipeline steps 1-2 (and the MIME audit)
#   src filter independent pointer verify             pipeline steps 3-7 (= cutover step 5)
#   tree               step 7: linked worktree of src.git
#   clone compare      step 8: partial test clone + comparison with the old worktree
#   tail               tail replay of the last $TAIL commits vs the full rewrite
#   refmap             step 6 sha references: refmap dry-run counts (optional REFMAP_ENGINE)
#   receive            server receive rules over the result (optional ENGINE_SERVER)
#   mount reset        re-run helpers: remount read-only, drop rewrite outputs
#   release            unmount the read-only mount, findmnt check
#   inventory-after    second inventory + comparison with the first
#   summary            rehearsal.json from all step reports
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ENVF=$(realpath "${1:?env file}"); shift
# shellcheck disable=SC1090
source "$ENVF"
: "${ORIG:?}" "${WORK:?}" "${GIT_FILTER_REPO:?}"
TAIL=${TAIL:-50}
SOURCE_BRANCH=${SOURCE_BRANCH:-master}; VAULT_TREE=${VAULT_TREE-vault}
export GIT_FILTER_REPO GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null LC_ALL=C
export GIT_AUTHOR_NAME="kuma-vault rehearsal" GIT_AUTHOR_EMAIL=rehearsal@localhost
export GIT_COMMITTER_NAME="kuma-vault rehearsal" GIT_COMMITTER_EMAIL=rehearsal@localhost
R=$WORK/run; REP=$WORK/reports; MP=$WORK/ro-objects; SNAP=$WORK/snap; SRC=$WORK/src.git
CAS=$WORK/cas/lfs/objects; CLONE=$WORK/clone; TREE=$WORK/tree; SRC2=$WORK/src-tail.git; R2=$WORK/run-tail
mkdir -p "$R" "$REP"
PY="python3 $HERE"

used() { df -B1 --output=used "$WORK" | tail -1 | tr -d ' '; }
now() { date +%s.%N; }
mounted() { findmnt -n --target "$MP" -o TARGET 2>/dev/null | grep -qx "$(realpath -m "$MP")"; }

sampler_start() {
  [ -f "$R/sampler.pid" ] && kill -0 "$(cat "$R/sampler.pid")" 2>/dev/null && return 0
  [ -f "$R/start-used" ] || used > "$R/start-used"
  # detached from the caller's stdout/stderr so it never holds an ssh session open
  ( while :; do printf '%s\t%s\n' "$(now)" "$(used)"; sleep 2; done ) >> "$R/df.log" 2>/dev/null < /dev/null &
  echo $! > "$R/sampler.pid"
}
sampler_stop() { [ -f "$R/sampler.pid" ] && kill "$(cat "$R/sampler.pid")" 2>/dev/null; rm -f "$R/sampler.pid"; }
# The sampler lives as long as this invocation, whatever its steps: a partial run
# (`rehearse.sh env snap freeze`) or an interrupted one must not leave the 2 s loop
# behind. The next invocation starts a new one and appends to the same df.log.
trap 'sampler_stop || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_step() {
  local name=$1; shift
  local t0 u0 rc=0
  t0=$(now); u0=$(used)
  echo "== $name $(date -Is)"
  # A separate shell: bash ignores `set -e` inside anything run under `||`.
  set +e; ( set -e; "$@" ); rc=$?; set -e
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$t0" "$(now)" "$u0" "$(used)" "$rc" >> "$R/phases.tsv"
  if [ "$rc" -ne 0 ]; then
    echo "== $name FAILED rc=$rc" >&2
    # leave nothing mounted behind a failure: a later rm -rf of the work dir must not
    # walk into the read-only view of the original
    sampler_stop || true; "$HERE/isolate.sh" umount "$MP" || true
    exit "$rc"
  fi
}

head_final() { git -C "$SNAP" rev-parse HEAD; }

s_inventory_before() { $PY/source_inventory.py take --repo "$ORIG" --out "$REP/src-before" --fsck full; }
s_snap() {
  "$HERE/isolate.sh" mount "$ORIG/.git/objects" "$MP"
  "$HERE/isolate.sh" snap "$ORIG" "$SNAP" "$MP"
}
s_freeze() {
  mapfile -t spec < <(python3 -c "import sys; sys.path.insert(0,'$HERE'); import brainrw; print('\n'.join(brainrw.freeze_pathspec()))")
  git -C "$SNAP" rev-parse HEAD > "$R/head-before-freeze"
  git -C "$SNAP" -c core.hooksPath=/dev/null add -A -- "${spec[@]}"
  git -C "$SNAP" -c core.hooksPath=/dev/null commit -q --allow-empty -m "vault-migrate: freeze snapshot (text only)"
  git -C "$SNAP" rev-parse HEAD > "$R/head-final"
  git -C "$SNAP" diff --stat --no-renames HEAD^ HEAD | tail -1 > "$R/freeze-stat.txt"
}
s_delete_paths() { $PY/delete_paths.py --repo "$SNAP" --worktree "$SNAP" --tree "$VAULT_TREE" ${EXTRA_DELETE_PATHS:+--extra-rules "$EXTRA_DELETE_PATHS"} --out "$R/delete-paths.txt" --report "$REP/delete-paths.json"; }
s_mime() { $PY/mime_audit.py --repo "$SNAP" --worktree "$SNAP" --delete-paths "$R/delete-paths.txt" --tmp "$WORK/mime.tmp" --report "$REP/mime-audit.json"; }
map_args() { echo --worktree "$SNAP" --cache "$R/map-cache.tsv" --cas "$CAS" --lfs-objects "$ORIG/.git/lfs/objects" --delete-paths "$R/delete-paths.txt"; }
s_map_cold() {
  rm -f "$R/map-cache.tsv"; sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
  # shellcheck disable=SC2046
  $PY/final_map.py $(map_args) --out "$R/final-map.tsv" --report "$REP/final-map-cold.json"
}
s_map_warm() {
  # shellcheck disable=SC2046
  $PY/final_map.py $(map_args) --out "$R/final-map.warm.tsv" --report "$REP/final-map-warm.json"
  cmp "$R/final-map.tsv" "$R/final-map.warm.tsv"
  cp "$REP/final-map-warm.json" "$R/final-map.json"
}
s_strip() { $PY/strip_list.py --repo "$SNAP" --final-map "$R/final-map.tsv" --delete-paths "$R/delete-paths.txt" --out "$R/strip-blob-ids.txt" --report "$R/strip.json"; cp "$R/strip.json" "$REP/strip.json"; }
s_src() { "$HERE/isolate.sh" bare "$SNAP/.git" "$SRC" "$SNAP/.git/objects"; }
s_filter() { "$HERE/rewrite.sh" filter "$SRC" "$R"; }
s_independent() { "$HERE/rewrite.sh" independent "$SRC"; "$HERE/isolate.sh" umount "$MP"; }
s_pointer() {
  $PY/pointer_commit.py --gitdir "$SRC" --final-map "$R/final-map.tsv" --run "$R" --worktree "$SNAP" \
    --source-branch "$SOURCE_BRANCH" --branch main --report "$R/pointer-commit.json"
  cp "$R/pointer-commit.json" "$REP/pointer-commit.json"
}
s_verify() {
  $PY/verify.py fsck --gitdir "$SRC" --report "$REP/7a-fsck.json"
  mounted || "$HERE/isolate.sh" mount "$ORIG/.git/objects" "$MP"
  $PY/verify.py trees --gitdir "$SRC" --old-gitdir "$SNAP" --old-worktree "$SNAP" --run "$R" --report "$REP/7b-trees.json"
  $PY/verify.py cas --gitdir "$SRC" --run "$R" --cas "$CAS" --report "$REP/7c-cas.json"
  $PY/verify.py sizes --gitdir "$SRC" --run "$R" --cas "$CAS" --report "$REP/7d-sizes.json"
}
s_tree() {
  git -C "$SRC" worktree add -q --detach "$TREE" main
  du -sB1 --apparent-size "$TREE" | cut -f1 > "$R/tree-apparent"; du -sB1 "$TREE" | cut -f1 > "$R/tree-alloc"
}
# Commit-sha references in the text: dry-run of `vault migrate refmap`
# (REFMAP_ENGINE: engine checkout with the migrate command) on the rewritten tree,
# old shas resolved in the snap. REFMAP_OTHER_PREFIXES: tokens that resolve in other
# repositories (other_repo_prefixes.py on the client); the token list for it is
# written to run/refmap-tokens.txt.
s_refmap() {
  [ -n "${REFMAP_ENGINE:-}" ] || { echo '{"skipped": "REFMAP_ENGINE not set"}' > "$REP/refmap.json"; return 0; }
  mounted || "$HERE/isolate.sh" mount "$ORIG/.git/objects" "$MP"
  python3 "$HERE/refmap_tokens.py" --repo "$TREE" --out "$R/refmap-tokens.txt"
  PATH="$(dirname "${NODE:?}"):$PATH" "$REFMAP_ENGINE/bin/vault" migrate refmap --repo "$TREE" \
    --map "$SRC/filter-repo/commit-map" --from-git-dir "$SNAP/.git" \
    ${REFMAP_OTHER_PREFIXES:+--other-repo-prefixes "$REFMAP_OTHER_PREFIXES"} \
    --review-out "$R/refmap-review.tsv" --applied-out "$R/refmap-applied.tsv" > "$REP/refmap.json"
  git -C "$TREE" diff --quiet   # dry-run: nothing written
}
s_clone() {
  git -C "$SRC" config uploadpack.allowFilter true
  git -C "$SRC" config uploadpack.allowAnySHA1InWant true
  git clone -q --no-local --filter=blob:limit=1m "file://$SRC" "$CLONE"
  du -sB1 "$CLONE" | cut -f1 > "$R/clone-alloc"; du -sB1 --apparent-size "$CLONE" | cut -f1 > "$R/clone-apparent"
  du -sB1 "$CLONE/.git" | cut -f1 > "$R/clone-git-alloc"
}
s_compare() { $PY/stage8_compare.py --old-worktree "$SNAP" --clone "$CLONE" --run "$R" --report "$REP/stage8.json"; }
s_tail() {
  mounted || "$HERE/isolate.sh" mount "$ORIG/.git/objects" "$MP"
  local hf base
  hf=$(cat "$R/head-final"); base=$(git -C "$SNAP" rev-parse "$hf~$TAIL")
  rm -rf "$R2"; mkdir -p "$R2"
  cp "$R/delete-paths.txt" "$R/final-map.tsv" "$R/strip-blob-ids.txt" "$R2/"
  "$HERE/isolate.sh" bare "$SNAP/.git" "$SRC2" "$SNAP/.git/objects"
  git -C "$SRC2" update-ref "refs/heads/$SOURCE_BRANCH" "$base"
  "$HERE/rewrite.sh" filter "$SRC2" "$R2"
  cmp "$R/attrs-blob.txt" "$R2/attrs-blob.txt"
  $PY/tail_replay.py --old-gitdir "$SNAP" --gitdir "$SRC2" --run "$R2" --from "$base" --to "$hf" --branch "$SOURCE_BRANCH" \
    --check-against "$SRC/filter-repo/commit-map" --report "$REP/tail-replay.json"
}
s_mount() { mounted || "$HERE/isolate.sh" mount "$ORIG/.git/objects" "$MP"; }
# Drop the outputs of the rewrite steps so they can run again after a tool fix
# (snap, the freeze commit and the CAS links are kept).
s_reset() {
  [ -d "$SRC" ] && git -C "$SRC" worktree prune
  rm -rf "$TREE" "$CLONE" "$SRC" "$SRC2" "$R2" "$WORK/receive"
}
# Server receive rules (ENGINE_SERVER: an engine checkout with src/server): a real push
# with receive.fsckObjects into a bare repo set up like the server's, then the rule
# checker over the whole history as one push.
s_receive() {
  [ -n "${ENGINE_SERVER:-}" ] || { echo '{"skipped": "ENGINE_SERVER not set"}' > "$REP/receive.json"; return 0; }
  local d=$WORK/receive; rm -rf "$d"; mkdir -p "$d"
  git init -q --bare --initial-branch=main "$d/fsck.git"
  for kv in receive.denyNonFastForwards=true receive.denyDeletes=true receive.denyDeleteCurrent=true receive.fsckObjects=true; do
    git -C "$d/fsck.git" config "${kv%%=*}" "${kv#*=}"
  done
  git -C "$SRC" push -q --no-verify "file://$d/fsck.git" 'refs/heads/main:refs/heads/main' 'refs/replace/*:refs/replace/*'
  [ "$(git -C "$d/fsck.git" rev-parse main)" = "$(git -C "$SRC" rev-parse main)" ]
  git init -q --bare "$d/quarantine.git"; echo "$SRC/objects" > "$d/quarantine.git/objects/info/alternates"
  BRW_ENGINE_LFS_PATHS="$ENGINE_SERVER/src/server/lfs-paths.mjs" python3 -c "import sys; sys.path.insert(0,'$HERE'); import brainrw; assert brainrw.check_engine_lists()"
  "${NODE:?NODE needed for the receive rules}" --no-warnings "$HERE/receive_check.mjs" "$ENGINE_SERVER" "$d/quarantine.git" "$SRC" "$WORK/cas" "$REP/receive.json"
  rm -rf "$d"
}
s_release() { "$HERE/isolate.sh" umount "$MP"; "$HERE/isolate.sh" check "$WORK"; }
s_inventory_after() {
  $PY/source_inventory.py take --repo "$ORIG" --out "$REP/src-after" --fsck full
  $PY/source_inventory.py compare --before "$REP/src-before" --after "$REP/src-after" --report "$REP/source-compare.json"
}
s_summary() { $PY/summarize.py --work "$WORK" --out "$REP/rehearsal.json"; }
s_cleanup() {
  sampler_stop || true
  "$HERE/isolate.sh" umount "$MP"
  "$HERE/isolate.sh" check "$WORK"   # refuse to delete anything while a mount sits below
  [ -d "$SRC" ] && git -C "$SRC" worktree prune || true
  rm -rf "$TREE" "$CLONE" "$SRC" "$SRC2" "$SNAP" "$WORK/cas" "$WORK/mime.tmp" "$WORK/receive" "$R/final-map.warm.tsv"
  rmdir "$MP" 2>/dev/null || true
  du -sB1 "$WORK" | cut -f1 > "$REP/after-cleanup-bytes"
}

steps=("$@")
[ "${steps[0]:-}" = all ] && steps=(inventory-before snap freeze delete-paths mime map-cold map-warm strip src filter
  independent pointer verify tree refmap clone compare tail receive release inventory-after summary)
for s in "${steps[@]}"; do
  fn="s_${s//-/_}"
  declare -F "$fn" >/dev/null || { echo "unknown step $s" >&2; exit 2; }
  case "$s" in
    summary) sampler_stop || true; "$fn" ;;
    cleanup) "$fn" ;;
    *) sampler_start; run_step "$s" "$fn" ;;
  esac
done

#!/usr/bin/env bash
# A small repository shaped like the real vault: tree `vault/`, plans, LFS-extension binaries
# (tracked, untracked, history-only, empty, one over the 1 MiB clone filter), a junk root file,
# junk paths in history, two sub-folder .gitattributes, commit-sha references in text, branch
# master, a reject list and a junk-rules file where the cutover reads them.
#
#   make-synth-vault.sh <repo-dir> <engine-dir> [secondary <declared id> [noref]]
#
# secondary: shaped like a company / second vault instead — the tree is the repository root,
# branch main, two merges, a derived .graph/ only in history, a 3D output file, the hand-written
# root .gitignore safety net for outside source clones and the reject list that declares the
# same place (binaries-reject.json at the root), the commit gate installed. One text line refers
# to the first commit by its full id (rewritten in step 6); `noref`: no reference at all (step 6
# then has nothing to rewrite and makes no commit).
set -euo pipefail
R=${1:?repo dir}; ENG=${2:?engine}; KIND=${3:-main}; SECID=${4:-synth-secondary}; REF=${5:-ref}
[ -e "$R" ] && { echo "exists: $R" >&2; exit 1; }
export GIT_AUTHOR_NAME=synth GIT_AUTHOR_EMAIL=synth@localhost GIT_COMMITTER_NAME=synth GIT_COMMITTER_EMAIL=synth@localhost
rnd() { head -c "$2" /dev/urandom > "$1"; }
mkdir -p "$R"; cd "$R"
if [ "$KIND" = secondary ]; then
  git init -q -b main .
  git config gc.auto 0; git config maintenance.auto false
  c() { git add -A -- "${@:2}"; git commit -q -m "$1"; }
  mkdir -p notes assets models scratch .graph
  printf '.DS_Store\n/.fts/\n*.tmp\n\n# outside source clones live outside the vault; this hand-written line is the old safety net\nintake/**/source/\n' > .gitignore
  printf '{\n  "id": "%s",\n  "profile": "kuma-vault"\n}\n' "$SECID" > vault.config.json
  printf '{\n  "reject": [\n    "scratch/",\n    "intake/**/source/"\n  ]\n}\n' > binaries-reject.json
  echo '# second vault' > README.md
  echo 'first note' > notes/a.md
  rnd assets/img1.png 4096; rnd assets/old.png 3000
  echo '{"derived": true}' > .graph/graph.json
  c "sec: start" .
  C1=$(git rev-parse HEAD)
  git rm -q -r .graph assets/old.png
  rnd assets/big.png 2200000
  [ "$REF" = noref ] || printf 'see %s for the start\n' "$C1" >> notes/a.md
  c "sec: big png, drop the derived cache" .
  git checkout -q -b side
  echo 'side note' > notes/side.md; rnd models/part.stl 9000
  c "sec: side work with a print file" .
  git checkout -q main
  echo 'main line' >> notes/a.md; c "sec: main moves" .
  git merge -q --no-ff -m "sec: merge side" side
  git checkout -q side; echo 'side again' >> notes/side.md; c "sec: side again" .
  git checkout -q main; git merge -q --no-ff -m "sec: merge side again" side
  git branch -q -D side
  mkdir -p intake/r1/a; echo '# a: review' > intake/r1/a/eval.md; c "sec: intake notes" .
  "$ENG/bin/vault" sync --root "$R" >/dev/null 2>&1 || true
  git add -A; git commit -q --allow-empty -m "sec: derived index"
  # working tree at freeze time: an untracked note, a modified text, junk, an untracked binary
  echo 'untracked note' > notes/untracked.md; echo 'uncommitted line' >> notes/a.md
  rnd assets/new.webp 5000; touch .DS_Store
  mkdir -p .git/lfs/objects
  git config kuma-vault.bin "$ENG/bin/vault"
  "$ENG/bin/vault" hook install --root "$R" >/dev/null
  git rev-parse HEAD
  exit 0
fi
git init -q -b master .
git config gc.auto 0
git config maintenance.auto false
# a client-side hooksPath (absent in the real vault): step 7 must drop it from the server copy
git config core.hooksPath .git/hooks
c() { git add -A -- "${@:2}"; git commit -q -m "$1"; }
mkdir -p vault/plans/kuma-vault vault/projects/kuma-vault/remote-brain vault/domains/a/_assets vault/domains/personal/talks/_media \
  vault/inbox/keepers/_attachments/meetup vault/_c8-smoke
printf '.DS_Store\n.env\nvault/.fts/\n*.gc-backup-*\n' > .gitignore
echo '# synthetic vault' > README.md
printf '{\n  "id": "kuma-brain",\n  "profile": "kuma-vault"\n}\n' > vault/vault.config.json
printf -- '---\ntitle: smoke plan\nstatus: active\n---\n\n## Notes\n' > vault/plans/kuma-vault/c8-smoke.md
printf '{\n  "reject": [\n    "domains/**/_assets/**/scratch/**"\n  ]\n}\n' > vault/projects/kuma-vault/remote-brain/binaries-reject.json
printf '# root junk file\nliteral:repro-tmp-check\n' > vault/projects/kuma-vault/remote-brain/rewrite-extra-delete-paths.txt
echo 'first note' > vault/domains/a/notes.md
rnd vault/domains/a/_assets/img1.png 4096
rnd vault/domains/a/_assets/old.png 3000
: > vault/domains/a/_assets/empty.png
echo junk > repro-tmp-check
c "synth: start" .
C1=$(git rev-parse HEAD)
mkdir -p vault/tools/__pycache__; rnd vault/tools/__pycache__/x.cpython-312.pyc 200
git add -f vault/tools/__pycache__/x.cpython-312.pyc
rnd vault/domains/personal/talks/_media/clip.mp4 1500000
printf '*.mp4 filter=lfs diff=lfs merge=lfs -text\n' > vault/domains/personal/talks/_media/.gitattributes
rnd vault/inbox/keepers/_attachments/meetup/photo.jpg 2048
printf '*.jpg -text\n' > vault/inbox/keepers/_attachments/meetup/.gitattributes
c "synth: media" .
C2=$(git rev-parse HEAD)
git rm -q vault/domains/a/_assets/old.png
rnd vault/domains/a/_assets/big.png 2200000
printf 'see commit %s and %s for the start\n' "${C1:0:9}" "${C2:0:12}" >> vault/domains/a/notes.md
c "synth: replace old.png, refer to $(echo "${C1:0:7}")" .
for i in 1 2 3 4 5; do echo "line $i" >> vault/domains/a/notes.md; c "synth: note $i" vault; done
rnd vault/domains/a/_assets/img1.png 4100
c "synth: img1 v2" vault
"$ENG/bin/vault" sync --root "$R/vault" >/dev/null 2>&1; c "synth: derived index" vault
# working tree at freeze time: untracked binary + text, a modified text, junk
mkdir -p vault/domains/b/_assets; rnd vault/domains/b/_assets/new.webp 5000
echo 'untracked note' > vault/inbox/untracked-note.md
echo 'line 6 (uncommitted)' >> vault/domains/a/notes.md
touch vault/.DS_Store
mkdir -p .git/lfs/objects
# the pre-commit gate the real vault has (vault sync --check)
git config kuma-vault.bin "$ENG/bin/vault"
"$ENG/bin/vault" hook install --root "$R/vault" >/dev/null
git rev-parse HEAD

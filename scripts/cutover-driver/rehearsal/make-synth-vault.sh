#!/usr/bin/env bash
# A small repository shaped like the real vault: tree `vault/`, plans, LFS-extension binaries
# (tracked, untracked, history-only, empty, one over the 1 MiB clone filter), a junk root file,
# junk paths in history, two sub-folder .gitattributes, commit-sha references in text, branch
# master, a reject list and a junk-rules file where the cutover reads them.
#
#   make-synth-vault.sh <repo-dir> <engine-dir>    (engine: installs the pre-commit gate hook)
set -euo pipefail
R=${1:?repo dir}; ENG=${2:?engine}
[ -e "$R" ] && { echo "exists: $R" >&2; exit 1; }
export GIT_AUTHOR_NAME=synth GIT_AUTHOR_EMAIL=synth@localhost GIT_COMMITTER_NAME=synth GIT_COMMITTER_EMAIL=synth@localhost
rnd() { head -c "$2" /dev/urandom > "$1"; }
mkdir -p "$R"; cd "$R"
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

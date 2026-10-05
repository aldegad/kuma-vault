#!/usr/bin/env bash
# Synthetic end-to-end test of the rehearsal tools (server only — needs sudo for
# the read-only bind mount). Builds a small repo with every case the real
# snapshot has or could have, runs `rehearse.sh all`, checks the verdict, then
# runs negative checks (the verifiers must catch a wrong strip list and a
# changed clone file) and cleans up.
#
#   selftest.sh <empty dir on the target filesystem>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
B=$(realpath -m "${1:?dir}")
[ -e "$B" ] && { echo "selftest: $B exists (remove it after: isolate.sh check $B)" >&2; exit 1; }
mkdir -p "$B"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null LC_ALL=C
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@x
rnd() { head -c "$1" /dev/urandom > "$2"; }
O=$B/orig
git init -q -b master "$O"; cd "$O"
git config core.ignorecase true; git config core.precomposeunicode true
MV="vault/x/build"
NFC=$(python3 -c 'import unicodedata; print(unicodedata.normalize("NFC", "한글"))')
NFD=$(python3 -c 'import unicodedata; print(unicodedata.normalize("NFD", "한글"))')
mkdir -p vault/a vault/media "vault/한글" vault/x/__pycache__ "$MV" vault/ign
printf '*.mp4 filter=lfs diff=lfs merge=lfs -text\n' > vault/media/.gitattributes
printf 'vault/ign/\n.DS_Store\n*.gc-backup-*\nvault/.fts/\n' > .gitignore
echo v1 > vault/a/x.md; rnd 5000 vault/a/keep.png; rnd 6000 vault/a/hist-only.mp4; rnd 3000 "vault/한글/사진 1.png"
: > vault/a/empty.png; rnd 100 vault/x/__pycache__/m.cpython-313.pyc; echo junk > root-junk
: > "$MV/ -i a.mp4 -i b.mp4"   # a command line that became a file name
ln -s keep.png vault/a/link.png; printf x > vault/a/.DS_Store; rnd 4000 vault/a/keep2.PNG
git add -A; git add -f vault/a/.DS_Store; git commit -qm c1
rnd 7000 vault/a/keep.png; echo v2 > vault/a/x.md; git rm -q vault/a/hist-only.mp4; git add -A; git commit -qm c2
REF2=$(git rev-parse HEAD)
# existing LFS pointers: talk.mp4 smudged in the worktree, talk2.mp4 left as pointer text
for n in talk talk2; do
  rnd 9000 "$B/$n.bin"; OID=$(sha256sum < "$B/$n.bin" | cut -d' ' -f1); SZ=$(stat -c %s "$B/$n.bin")
  mkdir -p ".git/lfs/objects/${OID:0:2}/${OID:2:2}"; cp "$B/$n.bin" ".git/lfs/objects/${OID:0:2}/${OID:2:2}/$OID"
  printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %s\n' "$OID" "$SZ" > "vault/media/$n.mp4"
  PB=$(git hash-object -w "vault/media/$n.mp4")
  git update-index --add --cacheinfo "100644,$PB,vault/media/$n.mp4"
done
git commit -qm c3; cp "$B/talk.bin" vault/media/talk.mp4   # smudged; later commits stage vault/a only
for i in $(seq 4 120); do
  echo "line $i" >> "vault/a/log-$((i % 7)).md"
  [ $((i % 10)) -eq 0 ] && rnd $((1000 + i)) "vault/a/b$i.png"
  [ $((i % 15)) -eq 0 ] && rnd $((2000 + i)) vault/a/keep2.PNG
  [ "$i" -eq 60 ] && printf '*.md text eol=lf\n' > .gitattributes
  [ "$i" -eq 90 ] && printf '*.md text eol=lf\n*.txt text\n' > .gitattributes
  [ "$i" -eq 100 ] && git rm -q .gitattributes
  [ "$i" -eq 105 ] && rm "vault/a/b100.png"
  # junk the server rejects (rule 6): tracked *.tmp and a nested .fts/ cache, history only
  [ "$i" -eq 40 ] && { echo t > vault/a/old.tmp; echo t > vault/a/old.tmp.1; mkdir -p vault/a/.fts; echo db > vault/a/.fts/x.db; }
  [ "$i" -eq 45 ] && rm -r vault/a/old.tmp vault/a/old.tmp.1 vault/a/.fts
  # decomposed (NFD) name committed by a client without precomposition, then its NFC twin
  # with the same bytes, then the NFD name removed while the twin stays
  [ "$i" -eq 50 ] && echo nfd > "vault/a/$NFD.md"
  [ "$i" -eq 51 ] && cp "vault/a/$NFD.md" "vault/a/$NFC.md"
  [ "$i" -eq 52 ] && rm "vault/a/$NFD.md"
  # NFC directory that the worktree will later hold under its NFD name (rsync from APFS)
  [ "$i" -eq 55 ] && { mkdir -p "vault/a/d-$NFC"; echo t > "vault/a/d-$NFC/t.md"; rnd 1500 "vault/a/d-$NFC/p.docx"; }
  msg="c$i"; [ "$i" -eq 70 ] && msg="c$i refers to ${REF2:0:10}"
  [ "$i" -eq 75 ] && echo "see commit ${REF2:0:10} and ${REF2}" > vault/a/ref.md
  git add -A -- vault/a; [ -e .gitattributes ] && git add .gitattributes
  git commit -qm "$msg"
  [ "$i" -eq 80 ] && git gc -q
done
# worktree state after the last commit (what the freeze sees)
mv "vault/a/d-$NFC" "vault/a/d-$NFD"   # index keeps the NFC names, disk has NFD
rnd 4000 vault/a/untracked.png; rnd 7100 vault/a/keep.png; rm vault/a/b10.png
echo new > vault/a/new.md; echo v3 > vault/a/x.md; rnd 300 vault/ign/i.png; echo g > vault/notes.md.gc-backup-1
printf '#!/bin/sh\nexec "/nonexistent/kuma-vault/bin/vault" sync --check\n' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit
mkdir -p .git/filter-repo; echo old > .git/filter-repo/already_ran; touch -d '3 days ago' .git/filter-repo/already_ran
cd "$B"

cat > "$B/env" <<EOF
ORIG=$O
WORK=$B/work
GIT_FILTER_REPO=${GIT_FILTER_REPO:?set GIT_FILTER_REPO}
TAIL=50
NODE=${NODE:-}
ENGINE_SERVER=${ENGINE_SERVER:-}
REFMAP_ENGINE=${REFMAP_ENGINE:-}
EXTRA_DELETE_PATHS=$B/extra-delete-paths.txt
EOF
printf '# root junk file\nliteral:root-junk\n# command-line file name with spaces\nliteral:vault/x/build/ -i a.mp4 -i b.mp4\n' > "$B/extra-delete-paths.txt"
"$HERE/rehearse.sh" "$B/env" all
python3 - "$B/work/reports/rehearsal.json" "$REF2" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
short = sys.argv[2][:10]
assert r["pass"] is True, r["checks"]
assert r["checks"]["tailReplayEqual"] is True
assert r["checks"]["serverReceiveRules"] in (True, None)
rm = r["refmap"]
# the 10-char reference is random; an all-digit one goes to review (refmap rule), not replaced
if short.isdigit():
    assert "skipped" in rm or (rm.get("replaced") == 1 and rm.get("reviewByReason") == {"all-digits": 1}), rm
else:
    assert "skipped" in rm or rm.get("replaced") == 2, rm
print("selftest verdict: pass, method", r["method"])
PY

# negative checks: the verifiers must fail on a wrong input
W=$B/work
"$HERE/isolate.sh" mount "$O/.git/objects" "$W/ro-objects"
cp -r "$W/run" "$W/run-neg"; sed -i '1d' "$W/run-neg/strip-blob-ids.txt"
if python3 "$HERE/verify.py" trees --gitdir "$W/src.git" --old-gitdir "$W/snap" --old-worktree "$W/snap" \
     --run "$W/run-neg" --report "$W/neg-7b.json" >/dev/null 2>&1; then
  echo "selftest: 7b did not catch a missing strip id" >&2; exit 1
fi
echo tampered >> "$W/clone/vault/a/x.md"
if python3 "$HERE/stage8_compare.py" --old-worktree "$W/snap" --clone "$W/clone" --run "$W/run" \
     --report "$W/neg-8.json" >/dev/null 2>&1; then
  echo "selftest: stage 8 did not catch a changed file" >&2; exit 1
fi
echo "selftest negative checks: ok"
# a partial run leaves no df sampler behind (one 2 s loop per invocation, stopped on exit)
"$HERE/rehearse.sh" "$B/env" mount >/dev/null
[ ! -e "$W/run/sampler.pid" ] || { echo "selftest: sampler.pid left after a partial run" >&2; exit 1; }
n1=$(wc -l < "$W/run/df.log"); sleep 3; n2=$(wc -l < "$W/run/df.log")
[ "$n1" = "$n2" ] || { echo "selftest: df sampler still running after a partial run" >&2; exit 1; }
echo "selftest partial run: no sampler left"
"$HERE/rehearse.sh" "$B/env" cleanup
echo "selftest: PASS"

#!/bin/bash
# End-to-end check of an INSTALLED `vault serve` (docs/server.md, Identity).
# Run as root on the server: sudo scripts/server/serve-e2e.sh [store-id]
#
#  1. a second Linux user (kv-probe, created for the run and removed after) gets health
#     anonymously but 401 on every other endpoint — over loopback AND the server's own tailnet
#     IP, with or without forged forwarding headers;
#  2. the same user cannot clone or push without a token;
#  3. with a temporary writer token (added for the run, removed after; the value never leaves
#     a 0600 file in the probe's work dir) two clones push, fetch and move an LFS file;
#  4. the installed hook refuses what slips past a mode or path check, and paths, names and
#     symlink targets no checkout can write (lengths, a name that is not UTF-8, names a Mac
#     folds into one, a `..namedfork` component); the limits themselves land and tree/ writes
#     them;
#  5. two LFS uploads at once cannot both spend the same free space (lfs-reserve-race.mjs;
#     declared sizes only, one byte sent each), and an upload that trickles a byte at a time is
#     cut within two pace windows and its temp file removed;
#  6. after the token is removed it is a 401.
set -euo pipefail

STORE="${1:-vault-serve-scratch}"
CONFIG=/etc/kuma-vault/server.json
VAULT=/opt/kuma-vault/current/bin/vault
PROBE=kv-probe
TOKEN_ID="serve-e2e-$$"
export PATH="/opt/node/current/bin:$PATH"

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
PORT="$(node -e 'const c=require(process.argv[1]); const l=c.listen.find(a=>a.startsWith("127.0.0.1:")); process.stdout.write(l.split(":")[1])' "$CONFIG")"
SELF_IP="$(tailscale ip -4 | head -1)"
LOOP="http://127.0.0.1:$PORT"
TAIL="http://$SELF_IP:$PORT"
WORK="$(mktemp -d /tmp/kv-serve-e2e.XXXXXX)"
PASS=0
FAIL=0

cleanup() {
  "$VAULT" server token rm --id "$TOKEN_ID" --config "$CONFIG" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  if id "$PROBE" >/dev/null 2>&1; then userdel "$PROBE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$*"; }
as_probe() { sudo -u "$PROBE" -H env PATH="$PATH" HOME="$WORK/home" GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 "$@"; }

id "$PROBE" >/dev/null 2>&1 || useradd --no-create-home --shell /usr/sbin/nologin "$PROBE"
mkdir -p "$WORK/home"
chown -R "$PROBE:$PROBE" "$WORK"
chmod 0700 "$WORK"
printf 'probe user: %s (uid %s), store %s, loopback %s, self tailnet %s\n' "$PROBE" "$(id -u "$PROBE")" "$STORE" "$LOOP" "$TAIL"

expect_status() {
  local want="$1" label="$2"
  shift 2
  local got
  got="$(as_probe curl -s -o /dev/null -w '%{http_code}' "$@")"
  if [ "$got" = "$want" ]; then ok "$label -> $got"; else bad "$label -> $got (want $want)"; fi
}

for base in "$LOOP" "$TAIL"; do
  expect_status 200 "health anonymous $base" "$base/v1/health"
  stores="$(as_probe curl -s "$base/v1/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).stores)))')"
  [ "$stores" = "[]" ] && ok "health hides stores from anonymous ($base)" || bad "health stores visible to anonymous: $stores"
  expect_status 401 "info/refs upload-pack $base" "$base/v1/stores/$STORE.git/info/refs?service=git-upload-pack"
  expect_status 401 "info/refs receive-pack $base" "$base/v1/stores/$STORE.git/info/refs?service=git-receive-pack"
  expect_status 401 "POST git-receive-pack $base" -X POST -H 'Content-Type: application/x-git-receive-pack-request' --data-binary @/dev/null "$base/v1/stores/$STORE.git/git-receive-pack"
  expect_status 401 "LFS batch $base" -X POST -H 'Content-Type: application/vnd.git-lfs+json' -d '{"operation":"download","objects":[]}' "$base/v1/stores/$STORE.git/info/lfs/objects/batch"
  expect_status 401 "file $base" "$base/v1/stores/$STORE/file?path=README.md"
  expect_status 401 "events $base" "$base/v1/stores/$STORE/events?after=0"
  expect_status 401 "backup-status $base" "$base/v1/stores/$STORE/backup-status"
  expect_status 401 "forged X-Forwarded-For/X-Real-IP $base" -H 'X-Forwarded-For: 100.64.0.9' -H 'X-Real-IP: 100.64.0.9' -H 'Tailscale-User-Login: owner@example.com' "$base/v1/stores/$STORE.git/info/refs?service=git-upload-pack"
  expect_status 401 "wrong token $base" -H 'Authorization: Bearer kv_not-a-token' "$base/v1/stores/$STORE/backup-status"
done

if as_probe git clone --quiet "$TAIL/v1/stores/$STORE.git" "$WORK/anon" >"$WORK/anon.log" 2>&1; then
  bad "git clone without token succeeded"
else
  grep -qE '401|could not read Username|Authentication failed' "$WORK/anon.log" && ok "git clone without token refused (401)" || bad "git clone failed for another reason: $(tail -1 "$WORK/anon.log")"
fi
if as_probe git ls-remote "$LOOP/v1/stores/$STORE.git" >"$WORK/anon2.log" 2>&1; then
  bad "git ls-remote over loopback without token succeeded"
else
  ok "git ls-remote over loopback without token refused"
fi

# --- token mode: two clones, push / fetch / LFS ---
"$VAULT" server token add --id "$TOKEN_ID" --store "$STORE" --role writer --note "serve-e2e temporary" --config "$CONFIG" >"$WORK/token" 2>/dev/null
chown "$PROBE" "$WORK/token"
chmod 0600 "$WORK/token"
sleep 1.2 # serve re-reads server.json within a second
HDR="Authorization: Bearer $(cat "$WORK/token")"
as_probe git config --global user.name kv-probe
as_probe git config --global user.email kv-probe@test.invalid
as_probe git config --global http.extraHeader "$HDR"
as_probe git lfs install --skip-repo >/dev/null
as_probe git config --global "lfs.$TAIL/v1/stores/$STORE.git/info/lfs.locksverify" false

as_probe git clone --quiet "$TAIL/v1/stores/$STORE.git" "$WORK/one" 2>"$WORK/one.log" && ok "clone one (token, self tailnet IP)" || bad "clone one: $(cat "$WORK/one.log")"
cd "$WORK/one"
if [ ! -f .gitattributes ]; then
  as_probe sh -c 'printf "*.[pP][nN][gG] filter=lfs diff=lfs merge=lfs -text\n" > .gitattributes'
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
as_probe mkdir -p "vault/e2e"
as_probe sh -c "head -c 300000 /dev/urandom > vault/e2e/$STAMP.png && printf 'e2e %s\n' $STAMP > vault/e2e/$STAMP.md"
WANT="$(sha256sum "vault/e2e/$STAMP.png" | cut -d' ' -f1)"
as_probe git add -A
as_probe git commit --quiet -m "serve-e2e $STAMP"
as_probe git push --quiet origin HEAD:main 2>"$WORK/push.log" && ok "push with LFS object (token)" || bad "push: $(cat "$WORK/push.log")"

as_probe git clone --quiet "$LOOP/v1/stores/$STORE.git" "$WORK/two" 2>"$WORK/two.log" && ok "clone two (token, loopback)" || bad "clone two: $(cat "$WORK/two.log")"
GOT="$(sha256sum "$WORK/two/vault/e2e/$STAMP.png" | cut -d' ' -f1)"
[ "$GOT" = "$WANT" ] && ok "LFS download matches sha256 $WANT" || bad "LFS bytes differ: $GOT"

cd "$WORK/two"
as_probe sh -c "printf 'from two\n' >> vault/e2e/$STAMP.md"
as_probe git commit --quiet -am "serve-e2e two $STAMP"
as_probe git push --quiet origin HEAD:main 2>"$WORK/push2.log" && ok "push from clone two" || bad "push two: $(cat "$WORK/push2.log")"
cd "$WORK/one"
as_probe git pull --quiet --ff-only origin main 2>"$WORK/pull.log" && grep -q "from two" "vault/e2e/$STAMP.md" && ok "clone one fetched clone two's commit" || bad "pull: $(cat "$WORK/pull.log")"

# --- the installed hook refuses what slips past a mode or path check ---
tree_head() { git -c safe.directory='*' -C "/data/vaults/$STORE/tree" rev-parse HEAD; }
TREE_BEFORE="$(tree_head)"
refused() { # label, expected stderr text; pushes HEAD and resets to origin/main
  if as_probe git push origin HEAD:main >"$WORK/refused.log" 2>&1; then
    bad "$1 was accepted"
  else
    grep -qF -- "$2" "$WORK/refused.log" && ok "$1 refused ($2)" || bad "$1 refused for another reason: $(grep -E 'remote:|error' "$WORK/refused.log" | head -3 | tr '\n' ' ')"
  fi
  as_probe git reset --quiet --hard origin/main
}
as_probe sh -c "head -c $((40 * 1024 * 1024)) /dev/urandom > $WORK/huge.bin"
BIG="$(as_probe git hash-object -w "$WORK/huge.bin")"
as_probe git update-index --add --cacheinfo "120000,$BIG,vault/e2e/huge-$STAMP.bin"
as_probe git commit --quiet -m "serve-e2e symlink $STAMP"
refused "40MiB blob as a symlink" "[규칙 4] 링크 대상이 아닌 심링크: vault/e2e/huge-$STAMP.bin"
DOTGIT_BLOB="$(printf '#!/bin/sh\n' | as_probe git hash-object -w --stdin)"
DOTGIT="$(printf '100644 blob %s\tconfig\n' "$DOTGIT_BLOB" | as_probe git mktree)"
VAULT_TREE="$( (as_probe git ls-tree HEAD:vault; printf '040000 tree %s\t.git\n' "$DOTGIT") | as_probe git mktree)"
ROOT_TREE="$( (as_probe git ls-tree HEAD | awk -F'\t' '$2 != "vault"'; printf '040000 tree %s\tvault\n' "$VAULT_TREE") | as_probe git mktree)"
as_probe git update-ref HEAD "$(as_probe git commit-tree "$ROOT_TREE" -p HEAD -m "serve-e2e dotgit $STAMP")"
refused "a vault/.git/ path" "hasDotgit"
repeat() { node -e 'process.stdout.write(process.argv[1].repeat(Number(process.argv[2])))' "$1" "$2"; }
for n in 4096 1024; do
  LINK="$(repeat a "$n" | as_probe git hash-object -w --stdin)"
  as_probe git update-index --add --cacheinfo "120000,$LINK,vault/e2e/l$n-$STAMP"
  as_probe git commit --quiet -m "serve-e2e link $n $STAMP"
  refused "a ${n}B symlink target" "[규칙 2] 체크아웃 못 하는 심링크: vault/e2e/l$n-$STAMP — 대상이 ${n}B, 1023B 이하만 받습니다"
done
NAME300="$(repeat n 300)"
TEXT="$(printf 'x\n' | as_probe git hash-object -w --stdin)"
as_probe git update-index --add --cacheinfo "100644,$TEXT,vault/e2e/$NAME300"
as_probe git commit --quiet -m "serve-e2e long name $STAMP"
refused "a 300B file name" "[규칙 2] 체크아웃 못 하는 경로: vault/e2e/$NAME300 — 이름 하나가 300B, 255B 이하만 받습니다"
as_probe git update-index --add --cacheinfo "100644,$TEXT,$(printf 'vault/e2e/caf\xe9-%s.md' "$STAMP")"
as_probe git commit --quiet -m "serve-e2e not utf-8 $STAMP"
refused "a name that is not UTF-8" '[규칙 2] UTF-8 이 아닌 경로: vault/e2e/caf\xe9-'"$STAMP.md"
for pair in "ß ss" "ς σ" "ﬀ ff"; do
  set -- $pair
  as_probe git update-index --add --cacheinfo "100644,$TEXT,vault/e2e/$1-$STAMP.md" --cacheinfo "100644,$TEXT,vault/e2e/$2-$STAMP.md"
  as_probe git commit --quiet -m "serve-e2e fold $1 $2 $STAMP"
  first="$(printf '%s\n%s\n' "vault/e2e/$1-$STAMP.md" "vault/e2e/$2-$STAMP.md" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s.trim().split("\n").sort().join(", ")))')"
  refused "$1 and $2 (one name on a Mac)" "[규칙 2] 대소문자만 다른 경로(macOS 에서 한 파일): $first"
done
for path in "vault/e2e/d-$STAMP/..namedfork/rsrc" "..namedfork/rsrc"; do
  as_probe git update-index --add --cacheinfo "100644,$TEXT,$path"
  as_probe git commit --quiet -m "serve-e2e named fork $STAMP"
  refused "$path (a resource fork on a Mac)" "[규칙 2] macOS 가 리소스 포크로 읽는 경로 성분: $path"
done
[ "$(tree_head)" = "$TREE_BEFORE" ] && ok "tree/ did not move on refused pushes" || bad "tree/ moved"
LINK="$(repeat a 1023 | as_probe git hash-object -w --stdin)"
NAME255="$(repeat n $((255 - ${#STAMP} - 1)))-$STAMP"
as_probe git update-index --add --cacheinfo "120000,$LINK,vault/e2e/l1023-$STAMP" --cacheinfo "100644,$TEXT,vault/e2e/$NAME255"
as_probe git commit --quiet -m "serve-e2e limits $STAMP"
if as_probe git push --quiet origin HEAD:main 2>"$WORK/limits.log"; then
  ok "a 1023B symlink target and a 255B name are accepted"
  TARGET="$(readlink "/data/vaults/$STORE/tree/vault/e2e/l1023-$STAMP" || true)"
  [ "${#TARGET}" = 1023 ] && [ -f "/data/vaults/$STORE/tree/vault/e2e/$NAME255" ] \
    && ok "tree/ wrote the 1023B symlink and the 255B name" || bad "tree/ is missing the limit entries"
else
  bad "limits push: $(cat "$WORK/limits.log")"
fi
expect_status 411 "LFS PUT without Content-Length (chunked)" -X PUT -H "$HDR" -H 'Transfer-Encoding: chunked' --data-binary 'x' "$LOOP/v1/stores/$STORE.git/info/lfs/objects/$(printf x | sha256sum | cut -d' ' -f1)"
STORE_ROOT="$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.stores[process.argv[2]].path ?? `${c.dataDir}/${process.argv[2]}`)' "$CONFIG" "$STORE")"
RESERVE_GB="$(node -e 'process.stdout.write(String(require(process.argv[1]).diskReserveGB ?? 8))' "$CONFIG")"
if node /opt/kuma-vault/current/scripts/server/lfs-reserve-race.mjs --base "$LOOP" --store "$STORE" --token-file "$WORK/token" \
  --store-root "$STORE_ROOT" --reserve-gb "$RESERVE_GB" >"$WORK/race.log" 2>&1; then :; fi
while read -r verdict rest; do
  case "$verdict" in PASS) ok "$rest" ;; FAIL) bad "$rest" ;; *) bad "lfs reserve probe: $verdict $rest" ;; esac
done <"$WORK/race.log"
grep -q '^PASS' "$WORK/race.log" || bad "lfs reserve probe printed no result"
# a writer that trickles a byte every 5s never goes idle, but brings far less than the pace floor
# (arguments through the environment: under -e, argv[1] would reach the module's main check)
if (cd "$WORK" && E2E_BASE="$LOOP" E2E_STORE="$STORE" E2E_TOKEN_FILE="$WORK/token" E2E_INCOMING="$STORE_ROOT/lfs/incoming" node --input-type=module -e '
  import { openPut, taken, gone } from "/opt/kuma-vault/current/scripts/server/lfs-reserve-race.mjs";
  import { randomBytes } from "node:crypto";
  import { readFileSync } from "node:fs";
  const { E2E_BASE: base, E2E_STORE: store, E2E_TOKEN_FILE: tokenFile, E2E_INCOMING: incoming } = process.env;
  const put = openPut({ base, store, token: readFileSync(tokenFile, "utf8").trim() }, randomBytes(32).toString("hex"), 1e9);
  if (!(await taken(incoming, put))) { console.log("not taken", put.status); process.exit(1); }
  const started = Date.now();
  const drip = setInterval(() => put.req.write("x"), 5_000);
  const cut = await gone(incoming, put.oid, 150_000);
  clearInterval(drip);
  put.req.destroy();
  console.log(cut ? `cut after ${Math.round((Date.now() - started) / 1000)}s` : "still held after 150s");
  process.exit(cut ? 0 : 1);
' >"$WORK/trickle.log" 2>&1); then
  ok "an LFS upload trickling a byte every 5s is cut ($(cat "$WORK/trickle.log"))"
else
  bad "trickling LFS upload: $(cat "$WORK/trickle.log")"
fi

"$VAULT" server token rm --id "$TOKEN_ID" --config "$CONFIG" >/dev/null
sleep 1.2
expect_status 401 "removed token" -H "$HDR" "$LOOP/v1/stores/$STORE/backup-status"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]

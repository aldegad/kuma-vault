# Shared preamble of every server block (5.6 "C8 server commands"). The driver puts the
# configuration in front of this file as exported variables, then the block after it, and
# sends the whole script to the server's bash on stdin.
#
#   T        work directory of this cutover on the server (/data/work/<stem>)
#   O        server copy of the old repository (rsync target, read only by every block)
#   ENGINE_LINK  installed engine link (/opt/kuma-vault/current)
#   VAULTS   server data directory of stores; STORE = new store id
#   OWNER    tailnet login that owns the store; ALLOWED_REMOTE = the client's origin URL
#   TREE     vault tree inside the repository (vault; empty = the repository root)
#   SOURCE_BRANCH  the branch the old repository works on (master, main)
#   MAPREL   commit map, tree-relative; REJECTREL = binaries-reject.json, tree-relative
#   XRREL    repo-specific junk rules, repo-relative (empty = none)
#   MODE     main | secondary (secondary: other stores already live on this server)
#   SERVER_CONFIG, SERVE_USER, ADMIN_USER, NODE_BIN, HEALTH_URL, FILTER_REPO_SRC
# Every engine command below reads SERVER_CONFIG (KUMA_VAULT_SERVER_CONFIG), the same file the
# jq checks read.
set -euo pipefail
E=$(readlink -f "$ENGINE_LINK")
R=$T/run; REP=$T/reports; MP=$T/ro-objects; SRC=$T/src.git; CAS=$T/cas/lfs/objects; W=$T/wt6
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null LC_ALL=C PYTHONDONTWRITEBYTECODE=1
export GIT_FILTER_REPO=$T/bin/git-filter-repo BRW_ENGINE_LFS_PATHS=$E/src/server/lfs-paths.mjs
PY="python3 $T/tools"; V="env PATH=$NODE_BIN:$PATH KUMA_VAULT_SERVER_CONFIG=$SERVER_CONFIG $E/bin/vault"
VS="sudo env PATH=$NODE_BIN:/usr/bin:/bin KUMA_VAULT_SERVER_CONFIG=$SERVER_CONFIG $E/bin/vault"
VK="sudo -u $SERVE_USER env PATH=$NODE_BIN:/usr/bin:/bin KUMA_VAULT_SERVER_CONFIG=$SERVER_CONFIG $E/bin/vault"
SOURCE_BRANCH=${SOURCE_BRANCH:-master}; MODE=${MODE:-main}
# junk rules file of the old repository, when the configuration names one
XRARGS=(); [ -z "${XRREL:-}" ] || XRARGS=(--extra-rules "$O/$XRREL")
FR_SHA256=67447413e273fc76809289111748870b6f6072f08b17efe94863a92d810b7d94

# one machine-readable value for the driver
out() { printf 'C8OUT %s=%s\n' "$1" "$2"; }
# a repository path of a tree-relative one (TREE may be empty: the tree is the repository root)
tp() { if [ -n "$TREE" ]; then printf '%s/%s' "$TREE" "$1"; else printf '%s' "$1"; fi; }
# mounts left under the work directory (read-only views of the original)
mounts_under() { findmnt -rn -o TARGET | grep "^$(realpath -m "$1")/" || true; }
release_mounts() {
  local m
  for m in $(mounts_under "$T"); do sudo umount "$m"; done
  [ -z "$(mounts_under "$T")" ] || { echo "c8: mounts left under $T" >&2; mounts_under "$T" >&2; exit 1; }
}
store_registered() { sudo jq -e --arg s "$STORE" '.stores | has($s)' "$SERVER_CONFIG" >/dev/null; }

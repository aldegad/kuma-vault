#!/usr/bin/env bash
# Isolated-copy rule: copies of the original repo that cannot write to it.
#
#   isolate.sh mount   <orig>/.git/objects <mountpoint>     read-only bind mount
#   isolate.sh umount  <mountpoint>                          unmount + findmnt check
#   isolate.sh snap    <orig> <snap> <mountpoint>            rehearsal worktree copy:
#        worktree = cp -al (hardlinks, .git excluded); .git outside objects/ and lfs/ = cp -a
#        real copies (index included); objects/ empty + alternates -> mountpoint
#   isolate.sh bare    <gitdir> <dest.git> <alternate-objects-dir>
#        bare src.git for filter-repo: everything outside objects/, lfs/, index, hooks/
#        and filter-repo/ copied with cp -a; objects/ empty + alternates; core.bare=true
#   isolate.sh check   <dir>                                 fail if anything is mounted under <dir>
#
# hooks/ is left out of src.git too: the client's hooks (pre-commit, pre-push with
# git-lfs, post-checkout) would run inside the server repo — a git-lfs pre-push
# scanning the whole history on every push from it, a pre-commit exec'ing a client path.
# filter-repo/ is left out of src.git on purpose: an original that was rewritten by
# filter-repo before still carries that run's metadata, and filter-repo would treat
# this run as a continuation of it — an interactive prompt (already_ran older than a day) and, on
# "y", a commit-map composed with the old run's map instead of old -> new.
set -euo pipefail

cmd=${1:?command}; shift

mounted() { findmnt -n --target "$1" -o TARGET 2>/dev/null | grep -qx "$(realpath "$1")"; }

case "$cmd" in
  mount)
    src=${1:?objects dir}; mp=${2:?mountpoint}
    mkdir -p "$mp"
    if mounted "$mp"; then echo "isolate: $mp already mounted" >&2; exit 1; fi
    sudo mount --bind "$src" "$mp"
    sudo mount -o remount,bind,ro "$mp"
    findmnt -n -o TARGET,OPTIONS "$mp" | grep -q '\bro\b' || { echo "isolate: $mp is not read-only" >&2; exit 1; }
    ;;
  umount)
    mp=${1:?mountpoint}
    if mounted "$mp"; then sudo umount "$mp"; fi
    if mounted "$mp"; then echo "isolate: $mp still mounted" >&2; exit 1; fi
    ;;
  snap)
    orig=${1:?orig}; snap=${2:?snap}; mp=${3:?mountpoint}
    [ -e "$snap" ] && { echo "isolate: $snap exists" >&2; exit 1; }
    mounted "$mp" || { echo "isolate: mount $mp first" >&2; exit 1; }
    mkdir -p "$snap/.git/objects/info" "$snap/.git/objects/pack"
    (cd "$orig" && find . -mindepth 1 -maxdepth 1 ! -name .git -exec cp -al {} "$snap/" \;)
    (cd "$orig/.git" && find . -mindepth 1 -maxdepth 1 ! -name objects ! -name lfs -exec cp -a {} "$snap/.git/" \;)
    realpath "$mp" > "$snap/.git/objects/info/alternates"
    ;;
  bare)
    gd=${1:?gitdir}; dest=${2:?dest.git}; alt=${3:?alternate objects dir}
    [ -e "$dest" ] && { echo "isolate: $dest exists" >&2; exit 1; }
    mkdir -p "$dest/objects/info" "$dest/objects/pack"
    (cd "$gd" && find . -mindepth 1 -maxdepth 1 ! -name objects ! -name lfs ! -name index ! -name filter-repo \
       ! -name hooks -exec cp -a {} "$dest/" \;)
    mkdir -p "$dest/hooks"
    git -C "$dest" config core.bare true
    realpath "$alt" > "$dest/objects/info/alternates"
    ;;
  check)
    d=$(realpath "${1:?dir}")
    if findmnt -rn -o TARGET | grep -q "^$d/"; then
      echo "isolate: mounts under $d:" >&2; findmnt -rn -o TARGET | grep "^$d/" >&2; exit 1
    fi
    ;;
  *) echo "isolate: unknown command $cmd" >&2; exit 2 ;;
esac

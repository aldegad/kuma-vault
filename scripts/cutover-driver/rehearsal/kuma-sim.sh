#!/usr/bin/env bash
# Stand-in of the agent runtime CLI for rehearsals: `kuma status`, `kuma control status`,
# stop/start, liveness, launcher-version and core-version, all from files under $SIM_DIR.
#   SIM_DIR/core        up|down
#   SIM_DIR/working     lines "project<TAB>member[<TAB>status]"; status is printed as the STATUS
#                       column as given (default "working"), so a rehearsal can give the shapes the
#                       real table prints: "working (sniffing)", "working [reap:scheduled]", …
#   SIM_DIR/installed   commit              SIM_DIR/events   append-only log of what was called
#   SIM_DIR/start-fails present: `control start` fails (an undo that does not go through)
#   SIM_DIR/stop-hangs  present: `control stop-core` stops, then hangs once (a run killed in it)
set -euo pipefail
D=${SIM_DIR:?}; mkdir -p "$D"; touch "$D/working"; [ -f "$D/core" ] || echo up > "$D/core"
echo "$(date +%FT%T) $*" >> "$D/events"
case "$1 ${2:-}" in
  "status "*|"status")
    [ "$(cat "$D/core")" = up ] || { echo "core down" >&2; exit 1; }
    printf 'PROJECT\tMEMBER\tSTATUS\tPREVIEW\n'
    # sessions that are not at work, in the shapes the real table prints them
    printf 'sim\tidle-hook\tidle\t-\nsim\tidle-sniffed\tidle (sniffing)\t-\nsim\tasks\tneeds-you\t-\n'
    while IFS=$'\t' read -r p m s; do [ -n "$p" ] && printf '%s\t%s\t%s\t-\n' "$p" "$m" "${s:-working}"; done < "$D/working"
    printf '\nParked: none\n' ;;
  "control status")
    if [ "$(cat "$D/core")" = up ]; then echo "core: up (pid 4242; listener 4242)  url: http://127.0.0.1:4313"
    else echo "core: down (stopped)  url: http://127.0.0.1:4313"; fi ;;
  "control stop-core")
    echo down > "$D/core"; : > "$D/working"
    if [ -e "$D/stop-hangs" ]; then rm -f "$D/stop-hangs"; sleep 600; fi ;;
  "control start") [ ! -e "$D/start-fails" ] || { echo "kuma-sim: start refused" >&2; exit 1; }; echo up > "$D/core" ;;
  "control alive") [ "$(cat "$D/core")" = up ] ;;
  "control launcher-version")
    [ ! -f "$D/launcher-delay" ] || sleep "$(cat "$D/launcher-delay")"
    c=$(cat "$D/installed"); printf '{"running":{"commit":"%s"},"installed":{"commit":"%s"}}\n' "$c" "$c" ;;
  "control core-version")
    [ ! -f "$D/core-delay" ] || sleep "$(cat "$D/core-delay")"
    echo "CORE source: CURRENT — simulated" ;;
  # recorded only (the events file): notify, a routine retarget, a daemon install argument, and the
  # project freeze of secondary mode (route disconnect / connect)
  "notify "*|"routine "*|"daemon "*|"route "*) : ;;
  *) echo "kuma-sim: unknown $*" >&2; exit 2 ;;
esac

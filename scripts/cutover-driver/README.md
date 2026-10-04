# Cutover driver

Runs the one-time move of a local vault repository to a served store — freeze, history
rewrite on the server (`../brain-rewrite/`), placement, client clone, path switch, smoke test,
first server backup — **without an agent**. Its step 2 stops the agent runtime, and every agent
session stops with it; the steps after that, and the rollback when one fails, run here.

Everything specific to one machine (hosts, paths, store id, owner, commands) is in a JSON
configuration; nothing of it is in this directory.

```
driver.py stage   --config c8.json                   copy driver + config into workDir
<workDir>/driver/driver.py launchd install --config <workDir>/c8.json --at 2026-10-04T01:00
<workDir>/driver/driver.py run     --config <workDir>/c8.json [--stop-after <step>]
<workDir>/driver/driver.py status  --config <workDir>/c8.json
<workDir>/driver/driver.py launchd uninstall --config <workDir>/c8.json
```

It runs from a copy in `workDir` because steps 9-10 rename the old repository and swap the
links that point into it. `launchd install` writes a one-shot LaunchAgent; at that time
`launch` checks the window (default 120 min), starts the run in its own session, removes the
plist and unloads the job. The run keeps the Mac awake with `caffeinate -dims -w <pid>`.

## Steps

`pre` 0 1 2 3 3b 4 5 6 7 8 9 10 11 12 13 13b — one per row of the cutover table:

| step | where | what |
|---|---|---|
| pre | client + server | prerequisites by machine (tools sha256, server clean, installed engine on master, client backup change on main, installed app carries the landed runtime commit and is what runs, freeze file / new clone / renamed repo absent, no unfilled values in the config, the configured `prereq.checks` — e.g. keychain reads and the server link, run under the same launchd start), then the intermediates gate summary. No-go changes nothing |
| 0 | both | `cutover_gate.py --stage 0`, refs-first snapshot copy, connectivity check before `server/s0-map.sh` maps it |
| 1 | client | freeze file `{id, since, reason, plan}` |
| 2 | client | wait up to `core.waitMinutes` for no working session, then stop the runtime anyway (its restart resumes the cut sessions; the list is reported). A session counts as working by the first word of its `kuma status` STATUS cell (`working (sniffing)` and `working [reap:…]` are working); a word the driver does not know counts as working and is reported as `statusUnknown`. A runtime already down by `kuma control status` (a re-run after the stop) is not waited for |
| 3 | client | `beforeFreeze` (derived text in step), text-only freeze commit (`--allow-empty`) with the freeze id; add and commit disable auto gc and maintenance |
| 3b | client | pre-cutover snapshot in the background; step 4 waits for it |
| 4 | both | last refs-first copy; drift: HEAD, rsync dry run, text changed after the freeze, server inventory; `cutover_gate.py --stage 4` |
| 5 | server | `server/s5-rewrite.sh` (history rewrite, pointer commit, checks 7a-7d) |
| 6 | both | `server/s6a-config.sh`, client `other_repo_prefixes.py`, `server/s6c-refmap.sh` |
| 7 | server | `server/s7-place.sh` |
| 8 | both | `server/s8-compare.sh`, client `vault clone` + HEAD / clean / LFS count |
| 9-11 | client | rename, link swap + store registry, daemon, runtime start |
| 12 | both | smoke: plan write, 10 commits until the server has them, search, one LFS file, two refused pushes, status alarms, launchd restart receipt |
| 13 | both | freeze file removed, `server/s13-cleanup.sh` |
| 13b | server | `server/s13b-backup.sh` |

`state.json` in workDir gets each step before it runs (status, time) and after (exit code).
A second run skips finished steps and repeats an interrupted one from a clean start: server
blocks run in their own session (`setsid`) and the next run stops a group left behind.

Failure: `pre`-2 = no-go (freeze file removed, runtime started). 3-10 = the undo of every step
that ran, newest first (links and registry, rename, new clone, `server/rollback.sh`, freeze
file, runtime) = rolled-back. 11-13 = halted: no rollback, runtime on, freeze file kept, a
person decides. 13b = backup configuration undone, success with `c9Ready: false`. A no-go or
rollback in which an undo failed ends as rollback-incomplete instead, with the failed undos on
the first line of the report; a run on that state tries them again in the same attempt.

Exit codes of `run`: 0 success (or `--stop-after`), 3 no-go, 4 rolled-back, 5 halted,
6 rollback-incomplete.

Each end writes `REPORT.md` and `reports/` in workDir and, when the runtime is up, runs
`notify.command`.

## Snapshot safety

Before starting, the source repository's effective `gc.auto` must be `0` and
`maintenance.auto` must be `false` (an unset maintenance setting defaults to true).
The driver checks these values without changing them. The freeze add and commit also
set both values on their command line. Do not start manual or scheduled repository
maintenance during the cutover. A live `gc.pid`, or one whose liveness cannot be
established, stops the copy before rsync.

Steps 0 and 4 copy the work tree and refs with `--exclude=/.git/objects/` first,
then copy `.git/objects/` separately, both with `-a --delete`. Objects must not be
removed during this window. Step 0 verifies `HEAD^{commit}` and runs
`fsck --connectivity-only` before map generation; a failure is a no-go with no retry.
The disk gate's `rsync -n --stats` is unchanged.

The final itemize check ignores only a symlink whose sole change is permissions
(`.L...p...` or `.L...p.....`); `values.platformNoise` records its count and up to
five sample lines. Every other nonempty output line remains drift, including
symlink target/mtime changes and file/directory metadata changes.

Both runtime version queries allow 300 seconds. Timeout is reported separately from
a non-current result, without retrying the query.

## Rehearsals (`rehearsal/`)

Run the driver regression tests on Linux scratch with
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/cutover-driver -v`.
They exercise real Git/rsync ordering, concurrent commits, connectivity failure,
gc suppression, itemize fixtures and preflight refusals.

- `server-s.sh` — the whole run on a Linux server scratch directory with the real server blocks
  (scratch store id, scratch token, local restic repository) and a synthetic vault in the
  client role; scenarios `nogo success drift fail7 fail8 fail10 idem` and, for step 2 and the
  rollback outcome, `wait` (only a `working (sniffing)` session left), `unknown` (a STATUS word
  the driver does not know), `rbinc` (an undo fails, then the re-run finishes it) and
  `corestop` (a run killed inside the stop, re-run with the runtime down),
  `warmwrite` (commits every 0.2 seconds during step 0), `freeze_gc` (a gc trigger
  enabled after preflight), and `slowversion` (both version queries take 150 seconds),
  then `teardown`.
- `mac-m.sh` — the whole run on a Mac, started by the driver's own LaunchAgent; the server
  blocks are replaced by `standin-server.sh` and a loopback `vault serve`.
- `make-synth-vault.sh` builds the synthetic vault, `kuma-sim.sh` stands in for the runtime CLI.

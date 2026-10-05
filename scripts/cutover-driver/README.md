# Cutover driver

Runs the one-time move of a local vault repository to a served store — freeze, history
rewrite on the server (`../brain-rewrite/`), placement, client clone, path switch, smoke test,
first server backup — **without an agent**. Its step 2 stops the agent runtime, and every agent
session stops with it; the steps after that, and the rollback when one fails, run here.

Everything specific to one machine (hosts, paths, store id, owner, commands) is in a JSON
configuration; nothing of it is in this directory. `config.example.json` is the main vault's
shape, `config.secondary.example.json` a second vault's.

## Modes

`"mode": "main"` (default) moves the machine's main vault: step 2 stops the agent runtime, step
10 swaps the links that point into the vault, the server must hold no store yet, and 13b
configures the server backup for the first time.

`"mode": "secondary"` moves one more vault while the main one stays served and the runtime
stays up:

| | main | secondary |
|---|---|---|
| freeze file (1) | freezes every vault tree | names the old store (`store`: the id its `vault.config.json` declares), so only that store's commit gate refuses; `pre` requires that gate (`vault hook install`) in the old repository |
| step 2 | waits, then stops the runtime | runs `project.freezeCommands` (route disconnect, routine pause, ...) once each, then waits up to `project.waitMinutes` for no working session of `project.id`; a session still at work fails the step (no-go). The runtime is never stopped |
| undo of step 2 | starts the runtime | `project.undoCommands` |
| 3b | snapshot of the old repository | skipped when `backup3b` is absent |
| step 10 | swaps `mac.links`, store registry | store registry, and the old path (renamed in 9) becomes a link to the new clone |
| step 13 | freeze file removed | freeze file removed, then `project.releaseCommands` (e.g. the route connected to the new project name) |
| server before (pre) | no store, no token | this store id is free, the configuration loads, a `backup` block exists |
| 13b | `backup configure --stores <store>`, units installed, the nightly unit run once | the store is added to the existing `backup.stores` (nothing to add when the list is null = every store), then `backup run` and `backup drill` of this store alone. A failed first backup keeps the store in the list (the nightly retries, its status shows it) and ends as success with `c9Ready: false` |
| `prereq.c4cLandedSha`, `c14d` | required | checked only when configured |

A secondary run does not need the launchd start (the runtime stays up, so a session of another
project can run `driver.py run` and wait for it); the LaunchAgent start works the same when the
run should not depend on any session.

Both modes take `server.tree` (the vault tree inside the repository; `""` when the repository
root is the tree) and `server.sourceBranch` (the branch the old repository works on, default
`master`; the served branch is always `main`). `server.extraDeletePathsRel` may be absent.

## Checks both modes run

- **Refs (D5).** `pre` on the old repository and step 4 on the server copy: the only ref is
  `refs/heads/<sourceBranch>`, a commit, and `HEAD` is on it. A ref to a tree (an agent's turn
  checkpoint), a side branch, a stash or a tag is a no-go in `pre` and drift in step 4 — the
  rewrite takes every ref, and such a ref carries objects into the copy that nobody reads. It is
  checked on every run, because such refs come back.
- **Must-ignore places** (`server.mustIgnore`: repository-relative probe paths, e.g. a file under
  a folder where outside source code is cloned). Each probe must be ignored by the *generated* blocks
  of the root `.gitignore` — the blocks `vault binaries apply` writes from the tree's reject
  list (`server.rejectRel`). A hand-written `.gitignore` line does not count: nothing regenerates
  it. Judged in `pre` (the reject list applied to a scratch repository), in step 6 (the
  `.gitignore` the rewrite commits), in step 8 (the new clone), and in step 12 by a real text
  file written at the first probe: after a daemon tick git reports it ignored, no commit has it,
  and the server's `main` does not have it. The server's receive rule 7 refuses *binaries* in a
  reject place; text there is kept out by this ignore block alone, so the place must be in the
  reject list.
- **Junk names stay out of the copy.** The rsync of steps 0 and 4 and the dry run of step 4
  exclude the engine's junk patterns (`.fts/`, `*.commit-lock`, `*.tmp*`, ... — the list the
  rewrite drops from history and the server refuses): lock and temporary files that vanish
  during a copy no longer end it with exit 23. A tracked file with such a name is still copied.
  Git's own lock and temporary object files under `.git` (`*.lock`, `tmp_obj_*`, `tmp_pack_*`)
  are left out the same way: a writer makes and removes them while the warm copy runs.
- **Alarms after the release.** The status alarms of the new clone are judged in step 13 after
  the freeze file is gone (a store that keeps its id has its autosave held back by the freeze
  itself), polling up to `smoke.alarmsWaitSeconds` (default 300). An alarm still on halts before
  the old server copy is deleted.
- **The smoke next to the daemon.** Step 12 waits until the daemon step 11 started is running
  before it nudges it (a `sync now` that finds no daemon runs the tick under the daemon's lock,
  and a daemon starting at that moment exits), and its commits wait out a held `index.lock`
  (the daemon's autosave stages and unstages on the same index).
- Configured commands given as lists (`daemonInstall`, `backupRetarget`, `beforeFreeze`,
  `prereq.checks`, the project commands) get `~` expanded.
- `launchd install` refuses a start time that is past or less than a minute ahead.

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
| 2 | client | (main; secondary: see Modes) wait up to `core.waitMinutes` for no working session, then stop the runtime anyway (its restart resumes the cut sessions; the list is reported). A session counts as working by the first word of its `kuma status` STATUS cell (`working (sniffing)` and `working [reap:…]` are working); a word the driver does not know counts as working and is reported as `statusUnknown`. A runtime already down by `kuma control status` (a re-run after the stop) is not waited for |
| 3 | client | `beforeFreeze` (derived text in step), text-only freeze commit (`--allow-empty`) with the freeze id; add and commit disable auto gc and maintenance |
| 3b | client | pre-cutover snapshot in the background; step 4 waits for it |
| 4 | both | last refs-first copy; drift: HEAD, rsync dry run, text changed after the freeze, server inventory; `cutover_gate.py --stage 4` |
| 5 | server | `server/s5-rewrite.sh` (history rewrite, pointer commit, checks 7a-7d) |
| 6 | both | `server/s6a-config.sh`, client `other_repo_prefixes.py`, `server/s6c-refmap.sh` (a commit when sha references were rewritten; none when nothing was rewritable) |
| 7 | server | `server/s7-place.sh` |
| 8 | both | `server/s8-compare.sh`, client `vault clone` + HEAD / clean / LFS count |
| 9-11 | client | rename, link swap + store registry, daemon, runtime start |
| 12 | both | smoke: plan write, 10 commits until the server has them, the log page read back with `vault get`, one LFS file, two refused pushes, a file in a must-ignore place, launchd restart receipt (`planFile`, `blobPath`, `bigPath`, `rejectPath` set to null skip that check) |
| 13 | both | freeze file removed, status alarms of the new clone, `server/s13-cleanup.sh` |
| 13b | server | `server/s13b-backup.sh` (secondary: `server/s13b-backup-add.sh`) |

`state.json` in workDir gets each step before it runs (status, time) and after (exit code).
A second run skips finished steps and repeats an interrupted one from a clean start: server
blocks run in their own session (`setsid`) and the next run stops a group left behind.

Failure: `pre`-2 = no-go (freeze file removed, runtime started). 3-10 = the undo of every step
that ran, newest first (links and registry, rename, new clone, `server/rollback.sh`, freeze
file, runtime) = rolled-back. 11-13 = halted: no rollback, runtime on, freeze file kept, a
person decides (an alarm failure in 13 comes after the freeze file is released). 13b = backup
configuration undone (secondary: kept, see Modes), success with `c9Ready: false`. A no-go or
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

The final itemize check ignores a symlink whose sole change is permissions
(`.L...p...` or `.L...p.....`) and a directory whose sole change is its time
(`.d..t...` or `.d..t......` — an excluded lock or temporary file made and removed
inside it moves it; an added or removed entry is a line of its own);
`values.platformNoise` records the counts and up to five sample lines of each. Every
other nonempty output line remains drift, including symlink target/mtime changes,
file metadata changes and directory permission/owner changes.

Both runtime version queries allow 300 seconds. Timeout is reported separately from
a non-current result, without retrying the query.

## Rehearsals (`rehearsal/`)

Run the driver regression tests on Linux scratch with
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/cutover-driver -v`.
They exercise real Git/rsync ordering, concurrent commits, connectivity failure,
gc suppression, itemize fixtures and preflight refusals.

- `server-s.sh` — the whole run on a Linux server scratch directory with the real server blocks
  and a synthetic vault in the client role. It starts a scratch `vault serve` of its own (own
  configuration, port, data directory, token, backup credentials and local restic repository,
  `server.installUnits: false`), so it can run on a server that serves live stores: the live
  configuration and data directory are fingerprinted at `setup` and must be the same at
  `teardown`. Secondary-mode scenarios: `sec_success` (root tree, branch `main`, merges, the
  store keeps its id, a file written during the freeze), `sec_rename` (the store is renamed;
  junk files come and go during steps 0-4), `sec_busy` (a member of the project still at
  work), `sec_refs` (a tree ref before `pre`, and one that appears after the freeze),
  `sec_mustignore` (the place is only in a hand-written line), `sec_fail10` (rollback after
  the old path became a link). Main-mode scenarios `nogo success drift fail7 fail8 fail10 idem` and, for step 2 and the
  rollback outcome, `wait` (only a `working (sniffing)` session left), `unknown` (a STATUS word
  the driver does not know), `rbinc` (an undo fails, then the re-run finishes it) and
  `corestop` (a run killed inside the stop, re-run with the runtime down),
  `warmwrite` (commits every 0.2 seconds during step 0), `freeze_gc` (a gc trigger
  enabled after preflight), and `slowversion` (both version queries take 150 seconds),
  then `teardown`.
- `mac-m.sh` — the whole run on a Mac, started by the driver's own LaunchAgent; the server
  blocks are replaced by `standin-server.sh` and a loopback `vault serve`.
- `make-synth-vault.sh` builds the synthetic vault, `kuma-sim.sh` stands in for the runtime CLI.

# Sync: `vault clone`, `vault syncd`

The client half of a remote store (the server half is [server.md](server.md)). This computer
keeps a git partial clone it reads and writes at local speed; a daemon commits what nobody
committed and moves commits to and from the server in the background. `vault sync install`
registers the daemon with launchd on macOS; on another system, run `vault syncd --repo <dir>`
under your service manager.

The code lives in `src/sync/` and, like the server, does not run the compiler engine in its own
process: the derivations and the enrich run are `vault sync` child processes.

## Clone

```sh
vault clone http://<server>:7741/v1/stores/<id>.git [<dir>] [--store <id>] [--token-file <path>] [--tree <rel>] [--no-hook]
```

`<dir>` defaults to `~/.kuma/vaults/<id>`. The clone gets:

| Setting | Why |
|---|---|
| `--filter=blob:limit=1m` | old versions of big text stay on the server until something asks for them |
| `lfs.fetchexclude=*` | LFS paths check out as pointers; `vault blob get` fetches the ones you open |
| `lfs.<url>/info/lfs.locksverify=false` | the server does not serve the LFS lock API |
| `+refs/replace/*:refs/replace/*` | old commit ids of a rewritten history still open |
| `core.untrackedCache`, `feature.manyFiles`, `core.fsmonitor` (macOS) | `git status` over a large tree |
| `index.skipHash=false` | retain checksums so optional index refreshes detect concurrent staging; `vault sync install` also applies this to existing clones and rewrites their index checksum under Git's index lock |
| credential helper | with `--token-file`, the token goes as the HTTP Basic password (copy in `.git/kuma-vault/token`, 0600). The clone's config first sets an empty helper for the server's URL, so the token file is its only helper: helpers from the system or global config (macOS git ships `osxkeychain`) are never asked to look the token up or store it. Without `--token-file` the server identifies the tailnet peer |
| `git lfs install --local` | LFS filters and the pre-push upload hook |
| pre-commit drift gate | `vault hook install` when the tree declares `vault.config.json` |
| `kuma-vault.store`, `kuma-vault.tree` | the store id and the declared tree (`vault` when `vault/vault.config.json` exists) |
| credential modes | every `_credentials/` directory (see below) tightened to 0600 files / 0700 directories after the checkout |

### Credential modes

git records only a file's executable bit; a checkout writes files and directories by the umask
(0644/0755 under the common 022). The vault's secrets would then be readable by the group and
others in every clone. So the credential directories are kept at **0600 files, 0700
directories**:

- which: a directory named `_credentials` at any depth, compared after NFC and lower-casing
  (`src/server/secret-dirs.mjs`, the same resolver that keeps them out of `rg`'s default reads and the server's file API), and
  everything under it, tracked or not. No declaration: the name is the convention;
- when: `vault clone` after its checkout, `vault sync install` (an existing clone), the daemon
  right after a fast-forward or merge and again at every STATUS step (with the tick's untracked
  paths, so a new local credential directory counts before it is committed), and the server's
  post-receive after it moves `tree/` (server.md);
- how: only a mode with a group or other bit is changed. A file with the owner executable bit
  becomes 0700 (git records that bit), a symlink is never followed or changed, a content is never
  read. A mode is not something git sees, so tightening commits nothing.

What stays loose (a path the walk cannot read or chmod) is the `credentialModes` alarm.

## The daemon

`vault syncd --repo <dir>` (launchd runs it, see below). One per clone, held by
`.git/vault-syncd.lock`. Each tick:

1. **Autosave** what is not committed: `git status --porcelain=v2 -z --untracked-files=all`.
   Before committing, derivation uses this pass's changed paths via the NUL-separated
   `--changed-paths-from` input. Only affected sidecars and the folder README ancestor
   closure are regenerated and checked. The first autosave, post-integration pass,
   unknown scope and contract changes run full, with a reason in the sync report.
   Enrich runs also always use full scope (`scope.reason: enrich-pass`), even when
   their leaf-metadata input is restricted to selected paths.
   Drift retries add the gate's reported paths and a fresh worktree scan to their scope.
   Installed hooks use `--check --incremental`; direct `vault sync --check` stays full.
   Existing drift outside the affected closure is left to full/periodic checks.

   Everything not ignored is collected, text or binary. There is no allow list. Held back:
   - a path changed in the last 120 s. Text still changing after 10 min is saved as it stands.
     A binary (an LFS extension) is never forced; a recording appended to for an hour waits until it stops.
     "Changed" is the mtime, unless the mtime is more than 5 min ahead of the clock (a camera or
     an archive with its clock ahead): then the path counts from when the daemon first saw it;
   - a non-LFS file over 32 MiB (the server would refuse it): reported as `uncollected`;
   - a binary in a `binaries.reject` place: reported as `rejectResidue`;
   - lock and temp names, nested repositories, unmerged paths.

   Before `git add` it runs `vault sync --json`. The README indexes and sidecars its
   report says it wrote go into the same commit. Everything else is judged again on a fresh scan
   and the clock after the run, so a file written while it ran (a recording being appended, a
   note being typed) waits. A new file its writer deletes after that scan (a run clearing its own
   frames) makes `git add` refuse the whole list; the pass leaves the deleted paths out, saves
   the rest and logs them in an `autosave-vanished` row. An `add` that fails with every path still
   there fails the tick as before. Then `git commit --only <paths>` with the pre-commit gate, which is
   never bypassed.

   The gate reads the work tree as it stands when it runs, not the commit. A page another writer
   adds, removes or re-describes after the regeneration — a `vault sync --enrich` run between
   writing a page and its own index pass, an agent saving a new note — leaves a README index
   behind it, and the gate refuses the commit over a file this pass never touched. So a refusal
   for tracked drift alone (the gate's report says so) is answered by regenerating again and
   committing again with whatever that wrote — also when it wrote nothing, because the page's
   own writer may have run `vault sync` meanwhile (up to twice, `gatedriftretries`; the log's
   `autosave` row counts them as `regenerations`, and each one is an `autosave-drift-retry` row
   naming the drifted files). Any other refusal — a freeze, a commit-policy rule, a sidecar that
   failed, a hook of its own — and drift that outlasts the retries, is a block: the state file
   carries the gate's line and the indexes it named, an `autosave-blocked` log row adds its
   reason (`drift` or `refused`), the drifted files repo-relative and when the gate is asked
   again (after 10 min — or at the next tick once the tree's `vault.config.json` is no longer the
   one that stood when the refused pass began: the gate reads the declaration afresh on every run,
   so a commit refused under a declaration being edited passes under the saved one, and one still
   wrong is refused again with its own reason; no restart is needed), and `autosave-unblocked` marks its end: `blockedAt` and
   `blockedSeconds` count from the block's first refusal, `lastRefusedAt` and `refusals` say how
   often it was asked again. The gate's line of a refusal that is not drift is the refusal's own
   reason (`vault gate [rule] …`, the failed sidecar, stale index regions), never a line of the
   gate's report such as `index: 0 drifted …`. After a
   merge or fast-forward the same pass runs once more, with the same rule.

   One clock judges a tick: the start time (injected in tests) plus the real time since. Every
   quiet rule, age, window and backoff reads it when it judges, after the scan it judges, never
   the tick's start. A fetch that takes minutes therefore cannot make a file written during it
   look "ahead of the clock".

   **Enrich** (off unless the clone turns it on, see [Descriptions](#descriptions-enrich-on-autosave)):
   the knowledge pages this clone committed — in this autosave, or in a commit of an agent's or
   a person's own that the server does not have yet — get a description from the configured
   model, and a second autosave pass in the same tick commits what that wrote.
2. **Fetch** `origin`.
3. **Integrate** by merge, never rebase. A local commit keeps its id, so a commit id an agent
   wrote into a plan stays valid. The branch moves only by `git merge --ff-only`, which never
   overwrites a dirty file; the daemon waits until that file is quiet and saved. A diverged
   branch is merged off to the side (`merge-tree --write-tree`) into a commit with both parents.
4. **Push**: `git lfs push` first, then `git push`. A non-fast-forward goes back to 2; a refusal
   by the server's receive rules blocks with the server's reason until someone fixes it.
5. **Status**: `~/.kuma-vault/sync/<id>.json`, written atomically.

Hourly it also rescans ignored files and trims the LFS cache. Forced ticks reuse the
ignored-file scan until its configured interval expires; force still retries blocked
autosaves and bypasses network backoff.

Woken by a commit (fs watch on `refs/heads` and `logs/HEAD`, 2 s debounce), the server's
events long-poll, a 60 s timer, and `vault sync now`. Every step is recomputed from git, so a
kill or a restart loses nothing. A git lock (`index.lock`, a ref lock) older than 10 min with
no git process in the clone is removed and logged: at the top of a tick, and at every retry while
the autosave's add or commit waits on one (up to 60 s) — so a lock a killed git left goes as soon
as it is old enough, and the wait does not run out on it and leave a block. Network steps back off 2 s, 5 s, 15 s,
60 s, then 5 min, and reset on the first success; autosave keeps running offline.

### Descriptions (enrich on autosave)

A page's `description` is its line in the folder README index, and `aliases` give a text search
more words to match. `vault sync --enrich` fills them by hand; a clone
can have its daemon do it for the pages it writes:

```sh
git config kuma-vault.enrich.onAutosave true   # this clone only; false (the default) turns it off
```

The daemon reads the switch at every tick, so turning it either way holds from the next tick with
no restart; `vault sync status` shows the value set now and the one the daemon's last tick ran
(`enrichSwitch` in `--json`) and says so while they differ. The other `kuma-vault.*` tunables
are read when the daemon starts.

Turn it on in the clone where the pages are written. Each tick, a queue collects the pages this
clone committed, from two places:

- the paths the daemon's own autosave commit carried;
- the paths added or changed by every other commit made in this clone — an agent's or a
  person's `git commit`, which is how most pages arrive. The tick reads the commits on `main`
  that it has not looked at before (`seenHead` in the state file), and leaves out merges, the
  daemon's own commits (`vault-sync: …`) and the commits that came from the server. Where a
  commit came from is read from git's own record of `origin/main` (its reflog, which git keeps
  in every clone unless `core.logAllRefUpdates` is turned off): it came from the server when the
  first state of `origin/main` that holds it was written by a fetch — the daemon's, or a
  person's `git fetch` or `git pull` in the clone — and it is this clone's when that state was
  written by this clone's push (`update by push`), or when no state holds it yet. So a page
  another computer wrote is not queued however it arrives, by the daemon's fetch or by a
  `git pull` (fast-forward or merge) in the clone: the clone that wrote a page describes it.
  A commit this clone pushed is still its own, also when another computer built on it before a
  tick looked (a commit made while a tick runs, or pushed by hand while the daemon was stopped).
  `origin/main` as the daemon's last fetch left it (`remoteSeen`) bounds the walk. A commit is
  looked at once, also while it waits unpushed. Turning the switch on starts from what the
  server does not have yet.

A path enters the queue only if it is one of the tree's knowledge pages, by the engine's one
target resolver under the tree's declaration (`vault.config.json`): not the plans slot, not the
archive slots (`results/`, `inbox/`, … as the profile or declaration lists them), not the root
ledgers (`log.md`, `dispatch-log.md`), not README indexes or sidecars, not an owner-local bucket
(`_evidence/`, `_assets/`, any `_`-prefixed folder), not a hidden directory, not a page the
declaration lists in `enrichExclude` (the files a person alone writes, such as decision ledgers),
never a secret directory (`_credentials/`, `_sync-conflicts/`). Records therefore never take a page's place in
the queue, however many are committed while no provider answers.

Right after the autosave the daemon runs
`vault sync --json --enrich --enrich-limit <n> --enrich-paths-from -` with the queue on
stdin — except the pages that have uncommitted changes. Their writer is still at them; they stay
queued and are handed over once they are committed. That run:

- asks the same resolver again, and never follows a symlink. What is not a target is reported
  `excluded` (`declared-exclude` for a page `enrichExclude` lists) and leaves the queue;
- calls the model only for a page whose `description`, `tags` or `aliases` is missing or stamped
  for an older body (`<field>_hash`). A value with no stamp is hand-written and never replaced;
- sends at most the first 8,000 characters of a body, from an empty temporary directory;
- writes its pages together, after its last model call, and regenerates the README indexes
  right after. Until then the tree is as its writers left it, so the commit gate, which reads
  the work tree, refuses nobody's commit while the model is thinking;
- writes nothing to a page that changed while the model ran (`raced`): the writer's bytes win,
  and the page is described when it is committed again.

What it wrote (the pages and the README indexes regenerated from them) is committed by a second
autosave pass in the same tick, `vault-sync: autosave (<host>, <n> files, <k> enriched)` — a
description and its index line are always one commit — and
pushed with the rest. The model is the one `vault setup --provider` configured
(`~/.kuma-vault/config.json`, or `KUMA_VAULT_CONFIG`), run as the engine's provider adapter: the
`claude` or `codex` CLI. The daemon's PATH must reach that CLI: `vault sync install` adds the directory of each
provider CLI it finds to the job's PATH, whether the switch is on or not, and says which; run it
again after installing a provider CLI. A CLI the daemon cannot find is a failed run in the `enrich` alarm.

| Limit | Default | Key |
|---|---|---|
| model calls per tick | 2 | `enrich.perTick` |
| model calls in the last hour | 10 | `enrich.perHour` |
| wait after a failed run | 1800 s | `enrich.retrySeconds` |

What a cap leaves stays queued for a later tick. The queue survives a restart (`enrichQueue` in
the state file) and holds 1000 paths; what it drops is counted (`dropped`). Describing a whole
tree at once is a manual `vault sync --enrich --enrich-limit <n>`.

A run that prints no report (no provider configured, a crash) or a page the model could not
describe raises the `enrich` alarm and waits `enrich.retrySeconds`. A page that failed three
times leaves the queue and stays in the alarm until it is committed again. A tree whose
declaration cannot be read, or whose contract does not carry enrich, raises the alarm too and
queues nothing: the daemon does not queue by a rule it could not read. It still judges the
clone's commits every tick and holds their paths (`held`); they are queued by the resolver once
the declaration can be read again, so a commit pushed during the alarm stays this clone's. The alarm keeps a
failure's first line and last error line, never more: a provider CLI may echo the prompt, and
with it the page, in its error.
Turning the switch off empties the queue and forgets `seenHead`, `remoteSeen` and the held paths;
nothing is sent. A committed page whose path has a line break never reaches the run (which
takes NUL-separated paths and refuses one with a line break): it goes straight to the alarm.

`vault sync --enrich` run by hand in a clone whose daemon is running writes each page as it is
described and regenerates the indexes at the end. In between, the tree has a description its
index does not carry, and the gate refuses commits. The daemon's autosave regenerates and
commits again (above); an agent's commit is refused until it runs `vault sync` or the run ends.

Kuma Studio describes pages through its own Moonbi path when it runs the enrich itself; the
daemon does not use it. The daemon is part of the engine package, runs where Studio may not
(another computer, a server clone), and reads one provider config — the one `vault setup` writes.

### Conflicts

| Kind | Result |
|---|---|
| `merge=union` paths (`dispatch-log.md`, `log.md`, `conflicts.jsonl`) | both sides' lines |
| `plans/**/*.graph.json`, a README whose local change was only inside the `vault-index` region | the server's version; recorded as resolved (regenerated later) |
| anything else, including LFS pointers | the server's version at the path, the local one at `<tree>/_sync-conflicts/<YYYYMMDD-HHMMSS>-<host>/<path>`, both in the merge commit |
| deleted on one side, changed on the other | the changed version |

Each one is a line in `<tree>/_sync-conflicts/conflicts.jsonl`. `vault sync conflicts` lists the
open ones; `vault sync resolve <id> --take local|remote|<merged-file>` settles one and commits
it, with the folder index and the sidecar the version taken regenerates. The local version of
a binary is kept as a pointer; one that has a sidecar (a pdf, say) must be fetched
(`vault blob get <copy>`) before it is taken, since the sidecar is extracted from the bytes.
The daemon never picks.

### State file and alarms

```json
{"store":"…","state":"ok|syncing|offline|blocked|conflict|paused","ahead":0,"behind":0,
 "oldestUnpushedAt":null,"lastSyncAt":"…","lastError":null,"openConflicts":0,"autosaveBlocked":null,
 "lfsCache":{"bytes":0,"limitBytes":10737418240},
 "alerts":{"uncollected":{…},"ignoredOutside":{…},"rejectResidue":{…},"growth":null,"credentialModes":{…},"enrich":{"active":false,"on":false}},
 "growthWindow":[{"atMs":0,"bytes":0,"files":0,"commit":"…","dirs":[…]}],
 "enrichQueue":{"pending":[["domains/a.md",0]],"gaveUp":[],"dropped":0,"calls":[0],"seenHead":"…","remoteSeen":"…","held":[],"totals":{"runs":0,"calls":0,"enriched":0}},
 "server":{"head":"…","diskFreeGB":41.2,"lastBackupAt":"…","eventsSeq":12}}
```

| Alarm | Level | Active when |
|---|---|---|
| `uncollected` | red | a not-ignored change older than 30 min (from its last change, as autosave judges it) is still uncommitted, for an hour. Each path carries its reason |
| `ignoredOutside` | yellow | files ignored by a rule outside the root trash/reject blocks (a nested `.gitignore`, `.env`): any LFS-extension file, or 100 MB in all. Each path carries the rule (`git check-ignore -v`) |
| `rejectResidue` | yellow | files left in `binaries.reject` places: 5 GB in all, or one older than 7 days |
| `credentialModes` | red | a file or directory under a `_credentials` directory still has a group or other bit after the daemon tightened them, or the walk failed. Each path carries its mode, the wanted mode and the error. `vault sync status` measures it again, read-only, when it runs |
| `growth` | yellow | this clone's autosaves added 1 GB of LFS bytes or 500 binaries within the last 24 h, in one burst or a trickle over many ticks; names the directory with the most bytes; clears when the window drops below both |
| `enrich` | yellow | enrich on autosave is on and the tree's declaration could not be read or carries no enrich, its last run printed no report or left a page undescribed (`lastError`, `failed`), or a page was given up on after three failures. Also shows the queue, the paths held while the declaration could not be read (`held`), the hour's calls against the cap and the totals. `{ "active": false, "on": false }` while off |

`vault sync status` exits 2 while an alarm is active, a conflict is open, the daemon is blocked
or offline, or no daemon holds the clone.

`binaries.reject` is read from the tree's `vault.config.json`, as gitignore globs relative to
the tree. The generated root `.gitignore` block and the server's rule 7 list hold the same places
relative to the repository.

## Commands

```sh
vault sync status [--json]          # exit 2: needs someone
vault sync now                      # tick now (signals the daemon, or runs one tick itself)
vault sync pause | resume
vault sync conflicts [--all] [--json]
vault sync resolve <id> --take local|remote|<merged-file>
vault sync install | uninstall      # launchd user agent ai.kuma-vault.syncd.<id> (macOS); install also tightens credential modes (exit 2 if one stays loose)
# every sync and blob command takes --repo <dir>; it defaults to the clone you are in
vault blob get <path...>            # git lfs pull -I <path> -X "" — only these paths
vault blob evict <path...>          # back to pointers
vault blob status [<path...>]
```

`blob get` passes `-X ""`. Under `lfs.fetchexclude=*` an `-I` alone fetches nothing, because
`-I` overrides only the include setting.

Which paths are LFS files is read from HEAD's tree, not with `git lfs ls-files` (which reads
every pointer of the tree on each call). `blob get` looks up only the paths it is given.
`blob status` and `blob evict` read every path from a map kept at
`.git/kuma-vault/lfs-pointers.json` under the id of the tree it describes. A new commit brings
it up to date by `diff-tree`, so the cost is only what changed, and a missing or broken file is
recomputed. A pointer is the canonical one `parseLfsPointer` accepts. A file holds its real
bytes when its size is the object's and it is not that pointer (an object can be as small as
its own pointer text).

`blob evict` drops a cached object only when the server holds it and a server backup finished
after the clone first saw the server holding it. The cache is then never the last copy. The
hourly trim also needs the object to be unopened for 7 days, and runs only while the cache is
over `lfsCacheMaxGB` (10).

## From a host (package API)

A host that reads a clone (shows its files, serves its pictures) imports these from `kuma-vault`
instead of copying them:

| Export | What it does |
|---|---|
| `parseLfsPointer(bytes)` | `{ oid, size }` when `bytes` (a Buffer or a string) are a canonical LFS pointer: the exact three lines git-lfs writes, at most `LFS_POINTER_MAX_BYTES` (1024) bytes. Anything else (CRLF, extra keys or bytes, an upper-case oid) is `null` |
| `syncStateDir(env?)` | where the daemon keeps `<store>.json` and `<store>.log`: `KUMA_VAULT_SYNC_DIR`, else `<HOME>/.kuma-vault/sync` |
| `blobGet({ repo, paths, env? })` | `vault blob get` as a call. `repo` is any directory inside the clone (the declared tree, say) and `paths` are relative to it. Resolves to the fetched paths relative to the clone's top; rejects with the reason: not an LFS file at HEAD, outside the clone, not a synced clone, or what git-lfs said when the server did not hand the object over |

```js
import { blobGet, parseLfsPointer } from "kuma-vault";

if (parseLfsPointer(head)) await blobGet({ repo: treeDir, paths: ["img/p1.png"] });
```

## launchd

`vault sync install` writes `~/Library/LaunchAgents/ai.kuma-vault.syncd.<id>.plist` (RunAtLoad,
KeepAlive, log at `~/.kuma-vault/sync/<id>.log`) and bootstraps it in `gui/<uid>`. launchd gives
a job a bare PATH, so the plist carries one built from where `node`, `git` and `git-lfs` are (and,
for a clone with enrich on autosave, where the provider CLIs are), and
`KUMA_VAULT_GIT` pins git by absolute path. The daemon never runs git through an agent shim.
Its git runner disables optional locks, so status scans do not refresh the shared index while
another process stages a commit. Required locks for staging, committing and merging still apply. This matters with
`feature.manyFiles`: its `index.skipHash` default can prevent Git from detecting that a status
scan's in-memory index is older than another process's staged changes.

A launchd job cannot answer a prompt. A token clone therefore uses no helper but its token file
(see the clone table): with macOS's `osxkeychain` helper also in the list, git asks the keychain
to store the token after each login, and under launchd that waits on a dialog no one sees, so the
daemon stands still. `vault sync install` gives a clone made before this rule the same config
(it prints `credential for <url>: the token file is now its only helper`). The daemon's own
token lookup (`git credential fill`, for the events, health and LFS calls) gives up after 15 s
and logs why, instead of waiting.

## Tunables

Per clone, `git config kuma-vault.<key> <value>` (seconds unless noted): `quietseconds` 120,
`textforceseconds` 600, `futuremtimeseconds` 300 (an mtime this far ahead is a wrong clock), `gateretryseconds` 600, `gatedriftretries` 2 (a count), `maxnonlfsbytes` 33554432,
`uncollectedageseconds` 1800, `uncollectedalarmseconds` 3600, `ignoredscanseconds` 3600,
`ignoredoutsidebytes` 1e8, `rejectresiduebytes` 5e9, `rejectresidueageseconds` 604800,
`growthbytes` 1e9, `growthfiles` 500, `growthwindowseconds` 86400, `timerseconds` 60,
`debounceseconds` 2, `evictseconds` 3600, `evictidleseconds` 604800, `lfscachemaxgb` 10 (GiB),
`stalelockseconds` 600, `enrich.pertick` 2, `enrich.perhour` 10, `enrich.retryseconds` 1800,
`host` (the name used in conflict records). Switch: `enrich.onautosave` false (`true`/`false`).

## Tests

`src/sync/sync.integration.test.mjs` starts its own `vault serve` on loopback behind a TCP proxy
(`scripts/test/sync-proxy.mjs`) that can cut the link, clones twice with `vault clone`, and drives
daemon ticks on an injected clock. Real daemon processes cover kill -9 and a push killed mid-upload.
`src/sync/sync.realtime.test.mjs` runs ticks on the real clock with a 3 s quiet window while a
recording is appended every 100 ms, through an autosave and through a post-merge pass, including
one behind a fetch slower than the future-mtime margin (cut to 2 s for the test).
`src/sync/credential-modes.integration.test.mjs` runs under umask 022 against its own serve: a
clone, a fast-forward that changes and adds credentials, a merge, the server's `tree/`, a loosened
mode, an unreadable directory, `vault sync status` and `vault sync install`.
`src/sync/declaration-reload.integration.test.mjs` edits the declaration while the gate reads it
(refused, then committed at the next tick once the edit is saved) and changes a wrong declaration
for another wrong one (refused again for the new reason, nothing committed).
`src/sync/autosave-drift.integration.test.mjs` races a writer between the derivation pass and the
gate (regenerated and committed again, blocked once the retries run out) and leaves the
`index.lock` of a killed git under a page, staged or not: removed while the call waits on it, the
page committed, no block.
`src/sync/enrich.integration.test.mjs` puts a fake `claude` on PATH as the configured provider and
checks what reached it: the changed knowledge page and nothing from `plans/`, `results/`,
`dispatch-log.md`, `_evidence/` or `_credentials/`; the per-tick and per-hour caps; a provider
failure and a missing provider in `vault sync status`; the switch off; a page an agent committed
itself, a page from another computer (never sent, whether the daemon fetched it or a person
pulled it by hand), a committed page still being written (held),
the daemon's own unpushed commits and a commit looked at once while offline. It also pins the
gate: a description and its index in one commit with the next autosave unblocked, a description
written between autosave's regeneration and the gate (regenerated again, committed), and a
refusal of the gate's own (blocked, logged, retried after the wait). `src/sync/enrich.test.mjs`
covers the queue and what may enter it under a declaration, the retry wait, giving up and the
state file with the run injected. `src/sync/enrich-provenance.test.mjs` judges where commits came
from against real git (a bare server and two clones): the daemon's fetch, a hand pull, a hand
merge pushed by hand, a commit pushed by hand and built on elsewhere, one the daemon's push took
before a tick looked, and commits judged and held through the alarm and a restart.
`src/sync/sync.latency.test.mjs` (`KV_SYNC_LATENCY=1`) measures commit → server and
server → other clone with two real daemons. Both need git ≥ 2.38, git-lfs and Node 22.

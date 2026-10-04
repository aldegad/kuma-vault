# Sync: `vault clone`, `vault syncd`

The client half of a remote store (the server half is [server.md](server.md)). This computer
keeps a git partial clone it reads and writes at local speed; a daemon commits what nobody
committed and moves commits to and from the server in the background. `vault sync install`
registers the daemon with launchd on macOS; on another system, run `vault syncd --repo <dir>`
under your service manager.

The code lives in `src/sync/` and, like the server, imports nothing from the compiler engine.

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
  (`src/server/secret-dirs.mjs`, the same resolver that keeps them out of search and serve), and
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
   Everything not ignored is collected, text or binary. There is no allow list. Held back:
   - a path changed in the last 120 s. Text still changing after 10 min is saved as it stands.
     A binary (an LFS extension) is never forced; a recording appended to for an hour waits until it stops.
     "Changed" is the mtime, unless the mtime is more than 5 min ahead of the clock (a camera or
     an archive with its clock ahead): then the path counts from when the daemon first saw it;
   - a non-LFS file over 32 MiB (the server would refuse it): reported as `uncollected`;
   - a binary in a `binaries.reject` place: reported as `rejectResidue`;
   - lock and temp names, nested repositories, unmerged paths.

   Before `git add` it runs `vault sync --no-fts --json`. The README indexes and sidecars its
   report says it wrote go into the same commit. Everything else is judged again on a fresh scan
   and the clock after the run, so a file written while it ran (a recording being appended, a
   note being typed) waits. Then `git commit --only <paths>` with the pre-commit gate. A blocked
   gate is retried after 10 min and never bypassed. After a merge or fast-forward the same pass
   runs once more, with the same rule.

   One clock judges a tick: the start time (injected in tests) plus the real time since. Every
   quiet rule, age, window and backoff reads it when it judges, after the scan it judges, never
   the tick's start. A fetch that takes minutes therefore cannot make a file written during it
   look "ahead of the clock".
2. **Fetch** `origin`.
3. **Integrate** by merge, never rebase. A local commit keeps its id, so a commit id an agent
   wrote into a plan stays valid. The branch moves only by `git merge --ff-only`, which never
   overwrites a dirty file; the daemon waits until that file is quiet and saved. A diverged
   branch is merged off to the side (`merge-tree --write-tree`) into a commit with both parents.
4. **Push**: `git lfs push` first, then `git push`. A non-fast-forward goes back to 2; a refusal
   by the server's receive rules blocks with the server's reason until someone fixes it.
5. **Status**: `~/.kuma-vault/sync/<id>.json`, written atomically.

Hourly it also rescans ignored files and trims the LFS cache.

Woken by a commit (fs watch on `refs/heads` and `logs/HEAD`, 2 s debounce), the server's
events long-poll, a 60 s timer, and `vault sync now`. Every step is recomputed from git, so a
kill or a restart loses nothing. A git lock (`index.lock`, a ref lock) older than 10 min with
no git process in the clone is removed and logged. Network steps back off 2 s, 5 s, 15 s,
60 s, then 5 min, and reset on the first success; autosave keeps running offline.

### Conflicts

| Kind | Result |
|---|---|
| `merge=union` paths (`dispatch-log.md`, `log.md`, `conflicts.jsonl`) | both sides' lines |
| `plans/**/*.graph.json`, a README whose local change was only inside the `vault-index` region | the server's version; recorded as resolved (regenerated later) |
| anything else, including LFS pointers | the server's version at the path, the local one at `<tree>/_sync-conflicts/<YYYYMMDD-HHMMSS>-<host>/<path>`, both in the merge commit |
| deleted on one side, changed on the other | the changed version |

Each one is a line in `<tree>/_sync-conflicts/conflicts.jsonl`. `vault sync conflicts` lists the
open ones; `vault sync resolve <id> --take local|remote|<merged-file>` settles one and commits
it. The daemon never picks.

### State file and alarms

```json
{"store":"…","state":"ok|syncing|offline|blocked|conflict|paused","ahead":0,"behind":0,
 "oldestUnpushedAt":null,"lastSyncAt":"…","lastError":null,"openConflicts":0,"autosaveBlocked":null,
 "lfsCache":{"bytes":0,"limitBytes":10737418240},
 "alerts":{"uncollected":{…},"ignoredOutside":{…},"rejectResidue":{…},"growth":null,"credentialModes":{…}},
 "growthWindow":[{"atMs":0,"bytes":0,"files":0,"commit":"…","dirs":[…]}],
 "server":{"head":"…","diskFreeGB":41.2,"lastBackupAt":"…","eventsSeq":12}}
```

| Alarm | Level | Active when |
|---|---|---|
| `uncollected` | red | a not-ignored change older than 30 min (from its last change, as autosave judges it) is still uncommitted, for an hour. Each path carries its reason |
| `ignoredOutside` | yellow | files ignored by a rule outside the root trash/reject blocks (a nested `.gitignore`, `.env`): any LFS-extension file, or 100 MB in all. Each path carries the rule (`git check-ignore -v`) |
| `rejectResidue` | yellow | files left in `binaries.reject` places: 5 GB in all, or one older than 7 days |
| `credentialModes` | red | a file or directory under a `_credentials` directory still has a group or other bit after the daemon tightened them, or the walk failed. Each path carries its mode, the wanted mode and the error. `vault sync status` measures it again, read-only, when it runs |
| `growth` | yellow | this clone's autosaves added 1 GB of LFS bytes or 500 binaries within the last 24 h, in one burst or a trickle over many ticks; names the directory with the most bytes; clears when the window drops below both |

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
a job a bare PATH, so the plist carries one built from where `node`, `git` and `git-lfs` are, and
`KUMA_VAULT_GIT` pins git by absolute path. The daemon never runs git through an agent shim.
Its git runner disables optional locks, so status scans do not refresh the shared index while
another process stages a commit. Remote search's local-change scan uses the same read-only
policy. Required locks for staging, committing and merging still apply. This matters with
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
`textforceseconds` 600, `futuremtimeseconds` 300 (an mtime this far ahead is a wrong clock), `gateretryseconds` 600, `maxnonlfsbytes` 33554432,
`uncollectedageseconds` 1800, `uncollectedalarmseconds` 3600, `ignoredscanseconds` 3600,
`ignoredoutsidebytes` 1e8, `rejectresiduebytes` 5e9, `rejectresidueageseconds` 604800,
`growthbytes` 1e9, `growthfiles` 500, `growthwindowseconds` 86400, `timerseconds` 60,
`debounceseconds` 2, `evictseconds` 3600, `evictidleseconds` 604800, `lfscachemaxgb` 10 (GiB),
`stalelockseconds` 600, `host` (the name used in conflict records).

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
`src/sync/sync.latency.test.mjs` (`KV_SYNC_LATENCY=1`) measures commit → server and
server → other clone with two real daemons. Both need git ≥ 2.38, git-lfs and Node 22.

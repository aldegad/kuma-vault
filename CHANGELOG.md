# Changelog

## Unreleased

- The stale-lock rule (a git lock older than `stalelockseconds` with no git process in the clone
  is removed) is also applied at every retry while the autosave's add or commit waits on a lock,
  not only at the top of a tick. A lock that turns stale during the 60 s wait goes then and the
  pass commits; before, the wait ran out on a lock nobody held and "Unable to create … index.lock"
  stood as a block for `gateretryseconds` after the next tick had removed the lock. This was the
  intermittent failure of the kill -9 daemon test (its stale-lock age is 3 s); with the default
  10 min age a restarted daemon still waits for the dead lock to age, as before.
- A blocked autosave is asked again at the next tick once the tree's `vault.config.json` changes,
  instead of after the 10-minute wait or a daemon restart. A declaration saved while the gate was
  reading it (refused: "The contract passed for … is not the one its vault.config.json declares")
  goes through as soon as the edit is saved; a declaration that is still wrong is refused again
  with its own reason.
- A tree can keep pages out of enrich: `"enrichExclude"` in `vault.config.json` lists them
  (gitignore syntax, tree-relative, case-insensitive; none by default). The one target resolver
  reads it, so neither `vault sync --enrich` nor the daemon sends such a page to a model or writes
  in it; a named run reports it `declared-exclude`. Meant for the files a person alone writes,
  such as decision ledgers. An engine older than this release refuses a declaration that carries
  the key (`unknown key(s) enrichExclude`), so update every reader before a tree adopts it.
- The daemon reads `kuma-vault.enrich.onAutosave` at every tick: turning it off (or on) holds
  from the next tick instead of the next restart. `vault sync status` shows the value set and the
  one the daemon's last tick ran (`enrichSwitch`). `vault sync install` puts the provider CLIs it
  finds on the job's PATH whether the switch is on or not.
- Autosave no longer fails a whole tick when a new file is deleted between its scan and its
  `git add` (a run clearing its own frames): the deleted paths are left out, the rest is
  committed, and an `autosave-vanished` log row names them.
- A blocked autosave reports the refusal's own reason: a freeze or policy rule (`vault gate
  [rule] …`), a sidecar that failed, stale index regions. Before, a refusal that was not drift
  could leave a line of the gate's report in the state file (`index: 0 drifted …`, or a
  `vault-dir:` line whose path held the word "drift"). `autosave-unblocked` counts
  `blockedSeconds` from the block's first refusal, not its last, and adds `lastRefusedAt` and
  `refusals`.
- Enrich on autosave no longer describes a page another computer wrote when it reaches the clone
  by a `git pull` (fast-forward or merge) made by hand. Where a commit came from is now read from
  the reflog of `origin/main`: from the server when the first state holding it was written by a
  fetch, the clone's own when it was written by the clone's push. A commit the clone pushed stays
  its own when another computer builds on it before a tick looks. While the tree's declaration
  cannot be read, the daemon keeps judging commits and holds their paths (`held` in the state
  file and the `enrich` alarm) until it can queue them, instead of judging everything in between
  afterwards.
- The `claude` enrich provider works with a subscription sign-in. It ran with `--bare`, which reads
  only `ANTHROPIC_API_KEY` or an `apiKeyHelper`, so every page failed with "Not logged in"; it now
  runs with `--safe-mode --tools ""` (none of the user's CLAUDE.md, hooks, MCP servers or plugins,
  no tools, the user's own sign-in). Default models: claude `sonnet` (the CLI's alias for its
  latest Sonnet), codex `gpt-6-luna` (`gpt-5.4-mini` is refused for a ChatGPT sign-in).
  `vault setup` makes one real call with the chosen model and fails, saving nothing, when the CLI
  refuses it.
- `vault sync --enrich-paths-from` refuses a path with a line break (a newline-separated list)
  instead of reporting it `not-a-target`.
- The connection counts of `vault lint` resolve links with the resolver lint checks them with: a
  link `x` is `x/README.md` when that folder has one, for the count as for the check, and a link
  whose letter case does not match is unresolved on every filesystem.
- `vault graph` is gone: the command, its HTML render and its reference page. Nothing else read
  the picture, and search ranks pages by their text, not by their links. What the picture was
  for, whether the pages are connected, is now one information line at the end of a whole-tree
  `vault lint --mode full` (and `connections` in `--json`): knowledge pages, orphans (pages no
  other page links to; generated README index links do not count), links that name nothing in
  the tree, and cross-store pointers naming a store the registry does not list. The line never
  fails the lint. A `.graph/` directory a past render left behind stays ignored by its own
  `.gitignore` and can be deleted.
- `vault sync resolve` commits the folder index and the sidecar the version taken regenerates.
  Before, the resolve commit left them out: what reached the server was the taken page under
  the other version's index line (or the taken binary beside the other version's sidecar), and
  the regenerated files stayed uncommitted until a later autosave collected them.
- The sync daemon can describe the pages it autosaves: with
  `git config kuma-vault.enrich.onAutosave true` on a clone, the knowledge pages an autosave
  commit carried go to one `vault sync --enrich --enrich-paths-from -` run right after it, and a
  second autosave pass in the same tick commits the descriptions. Off by default; capped at 2
  model calls a tick and 10 an hour (`enrich.perTick`, `enrich.perHour`); a missing provider or
  a failed page raises the yellow `enrich` alarm and waits `enrich.retrySeconds`. `vault sync`
  takes `--enrich-paths-from <file|->` to narrow an enrich run to named pages. Enrich never sends
  a page under a secret directory (`_credentials/`, `_sync-conflicts/`), whatever the tree
  declares as its bucket prefix, never follows a symlink to a page, and leaves a page that was
  saved again while the model ran as its writer left it (`raced`).
  The queue also takes the pages of commits made in the clone by an agent or a person (on `main`,
  not yet on the server, looked at once; never a commit from another computer, a merge or the
  daemon's own), and only knowledge pages enter it: plans, records and README indexes no longer
  take queue places while no provider answers. A page with uncommitted changes waits until it is
  committed. An `--enrich-paths-from` run writes its pages together after its last model call.
- Autosave no longer waits 10 minutes when the commit gate refuses a tree that moved under it (a
  page added or a description written by another process between autosave's regeneration and
  the gate): when the gate refused for tracked drift alone it regenerates and commits again, up
  to twice (`gatedriftretries`), also when the page's own writer already put the index right.
  Any other refusal (a freeze, a commit-policy rule, a failed sidecar) and drift that outlasts
  the retries still block; the state file now names the indexes the gate found out of step, and
  the daemon log has `autosave-drift-retry`, `autosave-blocked` (reason, drifted files, retry
  time) and `autosave-unblocked` (how long it lasted) rows.
- A plain `rg` in a vault no longer prints files under `_credentials/` or `_sync-conflicts/`.
  Setup writes `vault/.rgignore` with a generated block naming both (any depth, any case,
  derived from the one secret-directory resolver); `vault binaries apply` refreshes it and adds
  it to a vault set up before (`vault binaries apply --from <tree>/vault.config.json --root
  <tree>`). git does not read `.rgignore`: the directories stay tracked and synced, and `rg` on
  an explicit path or with `--no-ignore` still reads them.
- `vault search` and `vault timeline` are gone, with everything that kept their index: the
  local `.fts/` cache and the `fts` pass of `vault sync`, the server's index (`<store>/index/`,
  rebuilt after every push), its `POST /v1/stores/<id>/search|timeline` API and
  `vault server reindex`, the cross-store merge and the clone's read-your-writes supplement.
  Its trigram index could not match a word shorter than three characters and left `plans/` out;
  a scoped `rg` over the tree on disk has neither limit. Agents and people search with `rg`; the
  `kuma-vault` skill and the README say how. `vault get` stays (moved to
  `src/engine/vault-get.mjs`, `<store>:<path>` included), and so does the server's
  `GET /v1/stores/<id>/file`. The barrel no longer exports `searchVault`, `searchVaultStores`,
  `searchVaultTree`, `searchOneStore`, `isSearchCorpusPath` or the FTS functions.
  - `searchVault`, `formatVaultSearchText` and `resolveFtsDbPath` stay exported for this one
    release as stubs: a host branch cut before the removal still names them in its import, and a
    linked host checkout would otherwise fail to load at all. Importing them works; calling one
    throws `vault search was removed: <name>() …` (code `vault-search-removed`) with the `rg` and
    `vault get` route — never an empty result. The stubs are removed after the next app install,
    once no host branch imports them.
  - `vault sync --no-fts` is accepted until the next release and prints `--no-fts has no
    effect: the FTS index was removed …` on stderr, so a sync daemon started before the upgrade
    keeps committing and its log shows the flag until it restarts.
  - The registry's `"search"` key is retired: a registry carrying it still reads, `vault store
    list|show` names each such entry ("legacy search field ignored"), and `vault store set <id>
    --clear-search` removes it. `vault store add|set --search` is gone.
  - `"fts"` is no longer a `vault.config.json` key; a declaration that carries it is refused
    (`unknown key(s) fts`).
  - A server may delete each store's `index/`, `state/index.json` and `state/index.lock`; a
    clone may delete `vault/.fts/`. The `.fts/` junk pattern stays so an old cache is never
    pushed.
- `vault blob get` no longer runs `git lfs ls-files` (twice per call, a full read of every
  pointer in the tree). It looks up only the named paths in HEAD's tree. `blob status` and
  `blob evict` read a pointer map kept under HEAD's tree id
  (`.git/kuma-vault/lfs-pointers.json`), carried to each new tree by `diff-tree`. The daemon's
  hourly trim reads nothing while the cache is under its limit. A file whose object is exactly
  as large as its pointer text no longer counts as fetched while it is still a pointer.
- The LFS extension list (`src/server/lfs-paths.mjs`, the generated `.gitattributes`, receive
  rule 3, autosave and the history rewrite tools) grows from 41 to 64: 3D meshes and scenes
  (ply, stl, 3mf, model, fbx, vdb), 3D formats that are text but reach hundreds of MB (obj,
  gltf, step, stp) and print jobs (gcode, bgcode), images (bmp, tif, tiff, exr), audio (flac,
  aif, aiff), documents (doc, hwpx, odp) and wasm. Before, a mesh or print job over 32MiB was
  held as `uncollected` and refused by receive rule 4. Regenerate a store's `.gitattributes`
  after upgrading; files of these types already committed raw must be converted first.
- Docs: the README is a first-run guide (install → choose storage → daily use → backup), with
  one map of the docs and a table of which skill to use when. All docs and skills are in
  English except trigger phrases. `docs/file-lifecycle.md` is folded into
  `docs/architecture.md`; `docs/design.md` and `docs/setup.md` describe the current library
  contract and setup command instead of the extraction history. The
  `kuma-vault-remote-backup` skill now covers local-only stores and points server stores at
  the server's own backup. Repeated passages (removing a store, copying the engine to a server,
  the plain-text-on-server warning, the storage-mode table) live in one place each.
- Credential directories (`_credentials/` at any depth, any case) stay 0600 files / 0700
  directories in every checkout: `vault clone`, `vault sync install` (existing clones), the sync
  daemon after each fast-forward or merge and at each status step, and the server's `tree/` after
  post-receive. A checkout writes them by the umask (0644/0755) because git records only the
  executable bit. What stays loose is the red `credentialModes` alarm; `vault sync status`
  measures it read-only and exits 2.
- Sync and remote-search git calls disable optional index refreshes, preserving changes
  another process stages while a background status scan is running.
- New clones and `vault sync install` explicitly set `index.skipHash=false` and write an
  index checksum, allowing Git to detect concurrent staging even with `feature.manyFiles`.
- `vault server store rm --purge` deletes the directory it judged. When a store's path is a
  symlink, the data it points to goes and then the link; before, only the link went, the data
  stayed and the command still said `deleted`.
- The package exports `parseLfsPointer` (with `LFS_POINTER_MAX_BYTES`), `syncStateDir` and
  `blobGet({ repo, paths })` (`vault blob get` as a call) for hosts that read a partial
  clone (docs/sync.md "From a host").
- vault lint no longer carries one vault's names for the `domains/` tree. Persona-memory pages
  are the ones the tree declares: `vault.config.json` `personaMemoryPages` lists their
  `domains/<name>.md` paths (default none). Verdicts that change: a top-level page the old
  built-in list allowed is `domain-top-level-drift` until the tree declares it (upgrade the
  engine first, then declare: an older engine refuses the unknown key); the two
  top-level reference-page names the list allowed are drift like any other undeclared page; any
  top-level directory with a README is a category (before, only listed ones were).
- `lintVaultFiles` and `runVaultSync` take the contract from the tree's own `vault.config.json`
  when the caller passes none, so the lint after `vault ingest`, the dispatch lifecycle hook,
  self-heal and a host's own calls judge declared persona pages too. A contract passed with a
  declared tree must be the declared one; an undeclared tree needs one (no built-in default).
  `vault ingest` resolves it before writing and writes nothing into a tree it cannot resolve.
- `vault lint` on a `git-tracked` nav scope runs `git ls-files` with `--no-optional-locks`.
- `vault server store rm --purge` also deletes the link when the configured store path ends in
  `/`; before, the data went but the link stayed and the log said it was deleted.

- A token clone's token file is its only credential helper for the server: an empty helper
  first drops system and global helpers (macOS git's `osxkeychain`), which under launchd
  waited on a keychain dialog and left the daemon standing still, and which copied the token
  into the login keychain. `vault sync install` gives older clones the same config and waits
  for a stuck daemon to leave before starting the new one; the daemon's own
  `git credential fill` gives up after 15 s.
- Add `vault server store list|rm <id>`. rm takes a store out of `server.json` in one atomic
  write with the tokens scoped only to it and its `backup.stores` entry; other stores and
  tokens stay. The directory is kept unless `--purge --confirm <id>`, which refuses a
  directory that a store staying in `server.json` shares (the same path, one inside it or
  one around it, compared after resolving symlinks). serve also re-reads
  `server.json` from its index pass, so a removed store stops being served without a request.
- Add remote mode (`docs/remote-mode.md`). The store registry `~/.kuma/vault-stores.json`
  gains a v2 entry shape (`mode`, `remote`, `search`, `lfsCacheMaxGB`), still reads v1, and
  is written only by the new `vault store add|set|rename|rm|list|show`.
- `vault serve` indexes each vault store from git objects as pushes arrive (the events log is
  the queue; increments diff the indexed commit to `main`) and answers
  `POST /v1/stores/<id>/search|timeline` and `GET /v1/stores/<id>/file`. Symlinks in the
  checkout are never followed; `_credentials/` and `_sync-conflicts/` never leave through
  these APIs. `vault server reindex` rebuilds on demand.
- `vault search|timeline` asks the server of a remote store and adds what the clone changed
  after the server's index (unpushed commits, uncommitted edits). An unreachable server is an
  error naming `--local`, which scans the local copy instead. `_credentials/` and
  `_sync-conflicts/` are out of the search corpus everywhere.
- The commit gate (`vault sync --check`) refuses commits during a vault freeze
  (`~/.kuma/vault-freeze.json`, `KUMA_VAULT_FREEZE_ID` exception) and, for trees declaring
  `binaries`, intermediates in `binaries.reject` places and non-LFS files over 32 MiB. A
  remote-search store builds no local `.fts/`.
- `vault hook install` adds a pre-push remote allowlist for private trees (`visibility`,
  `remotes.allowed`) that chains `git lfs pre-push`; both hooks find `vault` at run time
  (`git config kuma-vault.bin`, else PATH) instead of a baked path.
- Add `vault binaries apply` (reject list → `vault.config.json`, the generated root
  `.gitignore` blocks, sub-`.gitignore` decisions) and `vault server set-reject --tree-prefix`.
- Add `vault migrate to-remote|refmap|other-repo-prefixes|rollback-export` and
  `vault commit-map`.
- PDF sidecars accept an LFS pointer whose oid matches their stamp; the dispatch ledger
  rewrite takes the shared file-commit lock.

- Add `vault serve`: a server for vault stores over git smart HTTP (`git http-backend`)
  with an LFS batch API backed by a hash-verified, read-only content-addressed store,
  tailnet identity via `tailscale whois` with per-store ACLs, tokens for requests from the
  server itself, change events, health (disk and CAS-growth alarms) and backup status.
- Add the seven server receive rules (main only and fast-forward, NFC, case-collision and
  `.git` paths, LFS pointers backed by the store, 32 MiB plain-blob cap, disk reserve,
  lock/temp paths, `binaries.reject` places). They are checked on every pushed commit and
  cover symlinks as well as files. The size cap also applies to objects no path names. Stores
  refuse malformed trees (`receive.fsckObjects`). Rule 2 also refuses paths a macOS or Linux
  checkout cannot write: a path that is not UTF-8, a code point macOS does not know (outside
  Unicode 16.0, or a noncharacter), two paths macOS matches as one name under full Unicode
  case folding (`ß`/`ss`, `ς`/`σ`, `ﬀ`/`ff`), an empty, `.` or `..` component, a
  `..namedfork` component (macOS reads `d/..namedfork/rsrc` as a resource fork), a symlinked
  `.gitmodules`, a name over 255 bytes, a path over 768 bytes or a symlink target over 1023
  bytes. `docs/server.md` lists each axis, and the special names of macOS and Linux path
  lookup, with what a real macOS and Linux clone did. The server refuses to run on a Node
  whose ICU is older than Unicode 16.0, which rule 2's normalization depends on.
- LFS uploads reserve their size before the first byte, so two uploads at once cannot both
  spend the same free space. An upload that brings less than 1 MiB in a minute (stalled, or
  trickling a byte at a time) is cut and its reservation released.
- The server backup's restore drill fails when a sample comes back empty or short of
  min(asked, live count), when `restic ls` output cannot be read, and on a store with nothing
  to verify. `forget` and `forget-path` check every snapshot a dry run would remove (host, tag,
  path, pre-cutover) before forgetting anything, then forget exactly those ids. The Mac
  routine's retirement judge counts only a drill whose samples met their floors.
- `backup.host` in `server.json` is required and has no default; a backup block without one is
  refused. `vault server backup configure` writes it once — `--host <name>`, or this machine's
  hostname — and later runs keep it, so renaming the machine does not move the forget group.
- Add `vault server install|init-store|token|set-reject` for setting up a server (Node,
  git-lfs, service user, systemd unit). See `docs/server.md`.
- Add the first-run storage branch in `kuma-vault-setup`: step 0 asks where the vault
  lives (this computer, your own Oracle Cloud Always Free server, or another Linux server)
  and opens a guide for each (`docs/local.md`, `docs/oracle.md`, `docs/other-remote.md`).
- Add `kuma-vault setup --storage local|oracle|remote` and `--add-store <id>`: create a store
  (or clone a server store and push its first commit), apply the storage policy, register it
  and link `~/.kuma/vault`; macOS installs the sync daemon. An existing `~/.kuma/vault` is
  refused (exit 3) unless it is a plain folder adopted with `--adopt` (one rename, counts
  before and after, undone on a later failure); `--dry-run` shows the plan.
- `vault server install --auth token` writes a token-mode `server.json` listening on loopback.
- `vault migrate to-remote --token-file` sets up the clone's token credential for the sync
  daemon, git-lfs and remote search.
- Add the vault storage policy (`skills/kuma-vault/docs/storage-policy.md`: commit
  everything, no public remote, single owner) and route storage questions to it from
  `kuma-vault`.
- Make `kuma-vault` the entry point for search and research requests, including
  Korean search terms and official-document lookups.
- Route missing, incomplete and stale facts to authoritative sources; apply a
  24-hour verification threshold to changeable external claims, with explicit
  live-state, historical, local-observation and offline boundaries.
- Route dynamic, interactive and authenticated pages through `kuma-computer-use`,
  with content checks, account scope and browser lifecycle boundaries.
- Record successful claim verification and refresh reusable knowledge through
  the existing ingest workflow without rewriting history or user decisions.

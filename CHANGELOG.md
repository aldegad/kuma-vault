# Changelog

## Unreleased

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

# Remote mode: a vault whose canonical copy lives on a server

A remote store keeps its canonical repository on a `vault serve` server ([server](server.md)).
This machine holds a clone: text as files, large files as git-lfs pointers. This page covers
what the engine does differently for such a store. The sync daemon (`vault syncd`) and
`vault clone` are in [sync](sync.md).

## Store registry v2 (`~/.kuma/vault-stores.json`)

```json
{
  "version": 2,
  "default": "kuma-main-vault",
  "stores": {
    "kuma-main-vault": {
      "root": "/Users/me/.kuma/vaults/kuma-main-vault/vault",
      "mode": "remote",
      "remote": { "server": "http://vault-server.example.ts.net:7741", "store": "kuma-main-vault" },
      "search": "remote",
      "lfsCacheMaxGB": 10
    },
    "acme-ops": { "root": "/Users/me/work/acme-ops", "mode": "local" }
  }
}
```

- A v1 file (`"id": "/path"`) still reads; every entry is then `mode: "local"`.
- `root` is the declared tree (the directory with `vault.config.json`); the repository root is
  found with git. The tree's `vault.config.json` `id` must equal the registry key.
- `remote.tokenFile` (optional) is a file holding a bearer token, plain or `{"token": "…"}` —
  needed off the tailnet or from the server itself. `KUMA_VAULT_TOKEN` overrides it.
- Write it with `vault store`, not by hand:

```sh
vault store add <id> --root <tree> [--mode remote --server <url> [--remote-store <id>]] [--default]
vault store set <id> [--root …] [--mode …] [--server …] [--search local|remote] [--token-file …] [--lfs-cache-max-gb n]
vault store rename <old> <new> [--root <tree>]   # the tree must already declare <new>
vault store rm <id>
vault store list | show <id> [--json]
```

## Search

`vault search|timeline` asks the server of every store registered with `search: "remote"`
(`POST /v1/stores/<id>/search`). The answer is as of the server's `indexedCommit`, so the
client adds what this clone changed after it: paths changed since the merge-base of that commit
and `HEAD` (unpushed commits) plus every uncommitted change, untracked included. Those paths are
searched locally with the same analyzer; the server's hits for them are dropped and the local
hits take their place, and a deleted path drops out. The output ends with
`<store>: 색인 기준 <sha> · 로컬 보충 N파일` ("indexed at <sha> · N files supplemented
 locally"; the CLI's messages are in Korean).

When the server cannot be reached or refuses, the search fails with
`서버 검색 불가(<reason>). 맥 사본에서 찾으려면 --local` ("server search unavailable;
use --local to search this copy"). It never switches to the local copy
by itself, and a failing remote store fails a multi-store search as a whole. `--local` scans
this clone's copy (no index).

`vault get` reads local files. A large file there may be an LFS pointer; `get` says so.

`_credentials/` and `_sync-conflicts/` (any depth, any case) are outside the search corpus
everywhere — the server index, the local scan and FTS, and the read-your-writes supplement.

## The commit gate (`vault sync --check`, the pre-commit hook)

Before the derivation checks, the gate judges what is staged:

| Check | Refuses | Applies to |
|---|---|---|
| freeze | any commit while `~/.kuma/vault-freeze.json` exists (`{id, since, reason, plan, store?}`), except one whose environment has `KUMA_VAULT_FREEZE_ID` equal to the file's `id`. With `store`, only that declared id is frozen. An unreadable file refuses | every declared tree |
| reject | a binary (LFS extension, or a NUL in the first 8000 bytes) in a `binaries.reject` place | trees declaring `binaries` |
| size | a non-LFS-extension file over 32 MiB (the server refuses it on push) | trees declaring `binaries` |

The same verdict is exported for hosts that write binaries into a vault
(`judgeBinaryWrite` in `src/engine/commit-policy.mjs`). For a store registered with remote
search the gate does not build a local `.fts/` and says `fts: skipped (remote store …)`.

## Hooks (`vault hook install --root <tree> [--bin <vault>]`)

- **pre-commit** runs the gate above.
- **pre-push** (installed when `vault.config.json` declares `visibility` or `remotes`): a tree
  with `"visibility": "private"` pushes only to URLs in `remotes.allowed` (credentials in the
  URL are ignored for the comparison), then runs `git lfs pre-push`. It replaces the stock
  git-lfs pre-push hook; any other existing hook is left alone and the install refuses.
- Neither hook bakes an engine path. They run `git config kuma-vault.bin` when set (`--bin`
  sets it — needed when the committer's PATH has no `vault`, a launchd daemon for example),
  else `vault` from PATH, and refuse loudly when there is none.
- `git push --no-verify` skips the pre-push hook; the allowlist protects against mistakes, the
  server's ACL protects the store.

## `binaries.reject` and the generated `.gitignore`

`vault.config.json` `binaries.reject` lists intermediate places in gitignore syntax, relative
to the declared tree. `vault binaries apply` writes it from one source file and keeps every
copy consistent:

```sh
vault binaries apply --from binaries-reject.json --root <tree> [--gitignore-decisions decisions.csv] [--dry-run]
```

- `vault.config.json` `binaries.reject` = the list (tree-relative).
- The repository-root `.gitignore` gets two generated blocks: trash/derived files and the
  reject list re-anchored at the tree (`domains/**` under `vault/` becomes `vault/domains/**`;
  an unanchored `canvas/` becomes `vault/**/canvas/`). Lines outside the blocks are kept.
- `--gitignore-decisions` (CSV `ignore_file,rule,…,decision`): a sub-`.gitignore` rule marked
  `reject로 올림` ("promote to reject") joins the list re-anchored at its directory, a rule marked
  `하위 줄 삭제 권고` ("delete the sub-rule") is only removed; decided lines leave their sub-`.gitignore`, and a file
  left with no rules is deleted. A rule that is not in its file stops the run (stale table).
- The server keeps its own copy (receive rule 7):
  `sudo vault server set-reject --store <id> --from <tree>/vault.config.json --tree-prefix <tree dir>`.

## Storage policy keys of `vault.config.json`

`visibility` (`"private"` | `"public"`), `remotes.allowed` (push URLs), `binaries.reject`, and
`commitMap` (tree-relative path of the commit map a history rewrite left; read by
`vault commit-map`).

## Large files

- A PDF that is an LFS pointer is in sync with a sidecar stamped with the pointer's oid (the
  content sha256), so the gate does not need the bytes. Regenerating a sidecar needs the real
  file and fails with a message to fetch it first.
- Lint link checks pass for pointer files (the path exists). `_sync-conflicts/` is not linted.

## Migration

```sh
vault migrate to-remote --root <tree> --server <url> [--remote-store <id>] [--remote origin] [--token-file <f>]
```

For a local store whose large files are already LFS pointers (a store set up with the
generated `.gitattributes`): refuses if any large-file path in history holds raw bytes (that
store needs a history rewrite), then commits `visibility: private` + the remote in
`remotes.allowed`, adds the remote, installs the hooks, pushes to `main` (git-lfs uploads the
objects), and registers the store as remote. With `--token-file` the token is copied to
`.git/kuma-vault/token` (0600) behind the same git credential helper `vault clone` sets, so the
sync daemon (`vault sync install --repo <repo>`), git-lfs and remote search use it afterwards.

`kuma-vault setup --storage local|oracle|remote` creates a store in this layout from the start
([setup › Storage](setup.md#storage)).

### Tools for a history rewrite (advanced)

A vault whose history holds raw large files has to be rewritten (for example with
git-filter-repo) before it can move to a server; the switch to the rewritten history is called
the *cutover* below. These commands keep old commit ids usable across it. A store created by
setup never needs them.

```sh
vault commit-map <sha prefix> [--map <file>] [--root <tree>]
```

Looks a prefix up on either side of the commit map (`old new` per line, the format of
git-filter-repo's `filter-repo/commit-map`).

```sh
vault migrate refmap --repo <work tree> --map <commit-map> --from-git-dir <git dir> [--to-git-dir <git dir>]
      [--reverse] [--extra-map <file>]... [--other-repos <file>] [--other-repo-prefixes <file>]
      [--exclude <path>]... [--review-out <tsv>] [--applied-out <tsv>] [--write | --commit] [--map-label <text>]
vault migrate other-repo-prefixes --repo <work tree> --other-repos <file> [--out <file>]
```

Rewrites abbreviated commit shas in the tracked text files of a work tree. A token (word
boundary, `[0-9a-f]{7,40}`) is replaced when it resolves to exactly one commit in the
`--from-git-dir` repository, that commit is in the map, and it resolves to no commit in any
other repository (`--other-repos` lists git dirs to ask; `--other-repo-prefixes` takes the
output of `other-repo-prefixes` run where those repositories live). The replacement keeps the
original length and grows until it is unique in `--to-git-dir` (default: the work tree's common
git dir). Tokens of digits only, ambiguous tokens and commits outside the map go to the review
file instead. All judging runs with replace refs off (`GIT_NO_REPLACE_OBJECTS=1`); the source
repository is read with `--no-optional-locks` and read-only commands. Without `--write` or
`--commit` it only reports. `--commit` commits just the changed files and refuses a detached
HEAD. `--reverse` uses the map new → old; `--extra-map` adds mappings already in the rewrite
direction.

```sh
vault migrate rollback-export <tip>..<main> --new <new work tree> --old <old work tree> --map <commit-map>
      [--old-head <sha>] [--cas <lfs/objects dir>] [--export-map-out <file>] [--dry-run]
```

Replays the commits after a cutover onto the pre-cutover repository: each commit of
`<tip>..<main>` in topological order, with its message, author, committer and dates. Parents in
the range map to their replays, parents in the commit map to their old commits, and the
cutover's own commits (ancestors of the tip outside the map) to the old `HEAD`. Large files come
back as bytes from `--cas` (or `git lfs fetch` in the new clone), checked against their oid,
and are stored raw — or as pointer + object where the old repository's attributes say
`filter=lfs`. Empty files stay empty blobs; symlinks pass through. Changes to `.gitattributes`
and to the tree's `vault.config.json` are skipped and reported. The old `HEAD` must still be
`--old-head`; the branch moves by compare-and-swap, the index follows by a two-tree read, and
only the paths the range changed are rewritten in the work tree — uncommitted files the cutover
left there stay. The new → replayed map is written for the reverse refmap that follows.

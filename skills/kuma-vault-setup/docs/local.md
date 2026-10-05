# Storage option 1 — this computer only (local)

The vault lives in a git repository on this computer. Nothing leaves the machine. This is
the quickest start and needs no account anywhere.

## Choose this when

- You use one computer, or you want to try Kuma first and decide on a server later.
- You do not want your notes and credentials on any cloud disk.

Trade-offs: the vault is only as safe as this disk, and agents on other machines cannot
reach it. You can move to a server later without losing history (see the last section).

## Before you start

| Need | Check |
|---|---|
| git 2.38 or newer | `git --version` |
| Git LFS (large files are stored as LFS pointers even locally) | `git lfs version`. If missing: macOS `brew install git-lfs` (<https://git-lfs.com>) |
| A git identity (setup makes the first commit) | `git var GIT_COMMITTER_IDENT` prints a name and email. If it fails: `git config --global user.name "<name>"` and `git config --global user.email "<email>"` |
| `kuma-vault` on your PATH | `kuma-vault --help` |

## What is at `~/.kuma/vault` now?

Run `ls -la ~/.kuma/vault`. Setup reads the same thing and refuses (exit code 3) rather
than guess:

| You see | Setup does |
|---|---|
| `No such file or directory` | creates the store (next section) |
| a folder that is not a git repository (Kuma Studio creates an empty one on first run) | refuses and prints its file count and size. Add `--adopt` to move it into the new store (see below) |
| a folder or link inside a git repository (a vault you already keep in git) | refuses. It already works as a local vault; to move it to a server use `vault migrate to-remote` (last section). Setup never takes over a repository |
| a link to a folder that no longer exists | refuses. Remove the link or restore its target |

## Run setup

```bash
kuma-vault setup --storage local --dry-run    # prints the plan, changes nothing
kuma-vault setup --storage local
```

With an existing plain folder, close Kuma Studio and any agents first, then:

```bash
kuma-vault setup --storage local --adopt --dry-run   # source, file count and bytes
kuma-vault setup --storage local --adopt
```

`--adopt` moves the folder with a single rename on the same disk (a folder on another disk
is refused, never copied). It prints the file count and bytes before and after the move. If
any later step fails, setup removes what it added, puts the folder back where it was, and
prints its count again.

Setup creates, in this order:

1. `~/.kuma/vaults/kuma-main-vault/` — a new git repository with Git LFS enabled.
   `kuma-main-vault` is the default id of your main vault (`--store <id>` picks another).
2. A generated `.gitattributes` (which file types go to LFS; append-only ledgers merge
   line by line) and a generated `.gitignore` (junk and derived files). These are the same
   rules a server store uses, so moving to a server later needs no rewrite. Also
   `vault/.rgignore`, so a plain `rg` in the vault skips `_credentials/` and
   `_sync-conflicts/` (git still tracks them). Do not edit the generated blocks by hand.
3. `vault/vault.config.json` with `"id": "kuma-main-vault"`, `"visibility": "private"`, an
   empty `"remotes": { "allowed": [] }` (the [storage policy](../../kuma-vault/docs/storage-policy.md))
   and `"binaries": { "reject": [] }`, plus `vault/README.md` when the tree has none.
4. The vault's git hooks (`kuma-vault hook install`): the pre-commit gate and the pre-push
   remote allow-list.
5. The first commit of everything in the tree.
6. The store registration in `~/.kuma/vault-stores.json`, as the default store.
7. The link `~/.kuma/vault` → `~/.kuma/vaults/kuma-main-vault/vault`. Kuma Studio and
   agents always use the `~/.kuma/vault` address; only the link target depends on the mode.

Large files are kept in the repository's own `.git/lfs` folder. Running setup again prints
"already set up" and changes nothing.

## Check it worked

```bash
readlink ~/.kuma/vault                                      # -> ~/.kuma/vaults/kuma-main-vault/vault
kuma-vault hook status --root ~/.kuma/vaults/kuma-main-vault/vault
git -C ~/.kuma/vaults/kuma-main-vault remote -v             # prints nothing: a local store has no remote
kuma-vault store list                                       # kuma-main-vault (default) local ...
kuma-vault index                                            # prints the vault's root README
```

## Back it up

A local store has no copy anywhere else. Set up client-encrypted offsite backup with the
[kuma-vault-remote-backup](../../kuma-vault-remote-backup/SKILL.md) skill — the storage
provider only ever sees ciphertext, so this does not break the "no public remote" rule.

## Move to a server later

1. Build the server with [oracle.md](oracle.md) or [other-remote.md](other-remote.md), up to
   and including the server install. Its store `kuma-main-vault` must be empty.
2. On this computer (add `--token-file <file>` for a token server):

   ```bash
   vault migrate to-remote --root ~/.kuma/vaults/kuma-main-vault/vault --server <url>
   vault sync install --repo ~/.kuma/vaults/kuma-main-vault    # macOS: the sync daemon
   ```

   `to-remote` refuses when a large file anywhere in the history is raw bytes rather than an
   LFS pointer; a store created by setup never has one. It allows the server in
   `vault.config.json`, adds it as the only remote, pushes, and registers the store as remote.
3. The `~/.kuma/vault` address stays the same; agents keep working.
4. Configure the server's backup ([server.md › Backup](../../../docs/server.md#backup)). Keep
   a client-side backup routine running until the server's backups and restore drills have
   proven themselves ([retiring a client-side backup routine](../../../docs/server.md#retiring-a-client-side-backup-routine)).

The same command moves a vault you already kept in git, as long as its history holds large
files only as LFS pointers. A history with raw large files needs a rewrite first, which
setup does not do.

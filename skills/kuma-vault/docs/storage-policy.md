# Vault storage policy

SKILL.md routes; this file owns **where a vault repository lives and what it may sync to**.
`kuma-vault-setup` applies these rules when it creates a store, and hooks enforce them
afterwards. A user's `decisions.md` only routes here; it does not restate the rules.

## Storage modes

A store is created in exactly one mode, chosen at first setup — `local`, `oracle` or
`remote`; the choices and their guides are in
[kuma-vault-setup](../../kuma-vault-setup/SKILL.md). `local` keeps the canonical copy in this
computer's git repository. `oracle` and `remote` differ only in the guide: both keep the
canonical copy on a server you control, both are registered as `remote`, and this computer
works on a local copy that a background daemon keeps in sync. A `local` store moves to a
server later with `vault migrate to-remote --root <tree> --server <url>` without rewriting
history.

## Rules

| Rule | What it says | What enforces it |
|---|---|---|
| **P1 Commit everything** | The vault repository commits its whole working tree, secrets and credentials included — the repository is a tracker, not a publication. Anything not ignored is committed, whoever wrote it (agent, Studio, tools). Only the two generated blocks of the root `.gitignore` are excluded: junk/derived files and the intermediate-output paths listed in `binaries.reject`. Binaries are not excluded; they go in as Git LFS pointers. Files caught by any other ignore rule (a nested `.gitignore`, `.env`) are surfaced by the `ignoredOutside` alert. | Auto-save commits, the `uncollected` and `ignoredOutside` alerts, the pre-commit gate, setup-generated `.gitattributes` and `.gitignore` |
| **P2 No public remote** | A vault repository has exactly one remote: the storage server chosen at setup (your Oracle server, or your other server over a tailnet or token-authenticated HTTPS). It never pushes to public hosting such as GitHub, private repositories included. | `vault.config.json` `"visibility": "private"` and `"remotes": { "allowed": [...] }`, written by setup (`kuma-vault setup --storage …`). The pre-push hook installed by `vault hook install` refuses any remote not on that list. `vault clone`, setup and `vault migrate to-remote` add only the server they were given. |
| **P3 Single owner** | The usual "never commit someone else's uncommitted changes" rule does not apply inside a vault: auto-save collects every writer's changes, text or binary. Anything it cannot collect turns into a red alert within an hour. | Auto-save, the `uncollected` alert |

Why P1 and P2 belong together: P1 keeps secrets in the repository so the vault stays the
single source of truth; P2 is what keeps that safe. The server API also never returns
`_credentials/**` paths through its file reads. Together, secrets stay on machines
you own.

## What this means for a user

- A `local` store has no remote at all until you migrate it. Back it up with
  [kuma-vault-remote-backup](../../kuma-vault-remote-backup/SKILL.md) (client-encrypted).
- A remote store is backed up by the server's nightly restic job, which also restores a
  sample every night to prove the backup opens (the engine's `docs/server.md`, Backup).
- On a remote store the server disk holds the vault **in plain text**, including
  `_credentials`. Whoever operates the cloud can, in principle, read that disk. Encryption
  at rest is optional and not set up by default (`encryption: null` in the store config).
- To add a second store (work, family), run
  `kuma-vault setup --add-store <id> --storage local|oracle|remote [--server <url>]`. Each
  store gets its own `visibility` and `remotes.allowed`.
- Do not hand-add a remote with `git remote add`. The pre-push hook rejects pushes to it,
  and a remote that is not on the list is reported as a policy violation, not a fallback.

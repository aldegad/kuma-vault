---
name: kuma-vault-setup
description: 'First-run setup for the kuma-vault knowledge-base compiler. Use on installing or enabling kuma-vault, on first use when no vault store is registered, when choosing where the vault (the agent''s memory) is stored — this computer only, a free Oracle Cloud server, or another Linux server — when following the Oracle or remote-server setup guide, when adding a store, on a first `kuma-vault sync --enrich`, when choosing the enrich provider (claude or codex), or when starring the project. Presents the choices to the user and records them via `kuma-vault setup`.'
---

# kuma-vault-setup — first-run setup

One interactive setup that records **where the vault is stored**, the user's **enrich
provider** and, on consent, **stars the project on GitHub**. Every choice is the user's —
never decide for them, never star without an explicit yes.

This skill is the agent-facing surface. The deterministic work (creating the store, writing
config, calling `gh`) lives in the `kuma-vault setup` CLI (`vault setup` is a short alias) —
you present the choices with your own native ask surface, then hand the decision to the CLI.
Do not re-implement the store creation, the config write or the star call yourself.

## When to run

- The user just installed or enabled the kuma-vault plugin, or asks to "set up" / "configure" it.
- No store is registered yet (`~/.kuma/vault-stores.json` missing or empty).
- `kuma-vault sync --enrich` failed with "needs a provider. Run `kuma-vault setup`".
- The user asks where the vault should live, to move it to a server, or to add a store.
- The user asks to change which provider generates document synopses, or to star the repo.

If a step is already configured (a registered store; `~/.kuma-vault/config.json` has a
`provider`), say so and only re-run that step when the user wants to change it.

## Flow

Present these as real choices using your runtime's native question surface (Claude Code:
the AskUserQuestion tool; Codex: ask in chat). Keep it short — this is a courtesy, not a wizard.
Storage is set by flags only; an interactive `kuma-vault setup` in a terminal asks the provider,
star and git-hook questions, never the storage one.

0. **Storage (required, first).** Ask "Where should the vault — the agent's memory — live?"
   and open the matching guide before running anything:

   | Choice | Guide | CLI (after the guide's server steps) |
   |---|---|---|
   | 1. This computer only (local) | [docs/local.md](docs/local.md) | `kuma-vault setup --storage local` |
   | 2. A free Oracle Cloud server of your own | [docs/oracle.md](docs/oracle.md) | `kuma-vault setup --storage oracle --server http://<server-name>.<tailnet>.ts.net:7741` |
   | 3. A Linux server you already have (SSH) | [docs/other-remote.md](docs/other-remote.md) | `kuma-vault setup --storage remote --server <url> [--token-file <file>]` |

   Do not pick for the user. If they are unsure, local is the reversible start: it moves to
   a server later without a history rewrite. For 2 and 3, walk the guide with the user up to
   its server-install step; the CLI checks the server's `/v1/health` before it changes
   anything. Every branch applies the [storage policy](../kuma-vault/docs/storage-policy.md);
   never add a git remote by hand. An extra store (work, family) is
   `kuma-vault setup --add-store <id> --storage <mode> [--server <url>]`.

   **An existing `~/.kuma/vault`.** Setup never takes it over silently; it exits 3 and says
   why. A plain folder (Kuma Studio seeds one on first run): run the same command with
   `--adopt --dry-run`, show the user the plan (source, file count, bytes), and only on their
   yes run it with `--adopt` — one rename, counts compared before and after, put back if a
   later step fails. A vault that is already a git repository is not adopted: relay the
   refusal, which names `vault migrate to-remote` for moving it to a server.

   The storage command only sets up storage. Run the provider step below as its own command.

1. **Enrich provider (required).** Ask which CLI should generate one-line document synopses for
   `kuma-vault sync --enrich`:
   - `claude` — spawns the Claude CLI (default model `claude-sonnet-5`).
   - `codex` — spawns the Codex CLI (default model `gpt-5.4-mini`).
   Only these two are supported. Do not pick for the user. If they don't care, offer `claude` as a
   neutral default but let them confirm.

2. **GitHub star (optional, explicit opt-in).** Ask: "If kuma-vault is useful, star it on GitHub?"
   Default is No. Only pass `--star` when the user clearly says yes. Starring uses their `gh`
   login; if `gh` is missing or not authenticated the CLI prints a notice and skips (that's fine).

3. **Persist via the CLI.** Run exactly one command with the collected choices:

   ```
   kuma-vault setup --provider <claude|codex> --yes            # star declined
   kuma-vault setup --provider <claude|codex> --yes --star     # star consented
   ```

   Add `--model <id>` only if the user asked for a non-default model. Add `--repo <owner/repo>`
   only if starring a fork/mirror instead of the canonical repo.

4. **Report** what was written (storage mode, store path and its first commit, provider, model,
   config path) and whether the star happened, using the CLI's own output. Then point them at
   `kuma-vault sync --enrich` and `kuma-vault --help`.

5. **Backup (offer, do not run).** A `local` store has no copy anywhere else: offer skill
   `kuma-vault-remote-backup`. A server store is backed up by the server
   (the engine's `docs/server.md`, Backup) once its `backup` block is configured; say whether
   it is.

## Rules

- **No forcing.** Storage, provider and star are the user's decisions. `--yes` only skips the
  CLI's own re-prompt; it does not skip *your* asking the user.
- **No silent fallback.** If the user hasn't chosen, ask — never invent a choice. If a server
  is unreachable, setup refuses, or `gh` fails, relay that; do not retry it differently,
  switch the storage mode, or work around it with raw git or shell commands.
- **Deterministic core stays in the CLI.** Everything that creates a store, writes
  `~/.kuma-vault/config.json` or `~/.kuma/vault-stores.json`, or calls `gh` is
  `kuma-vault setup`. Your job is to ask, walk the guide, then invoke it — nothing more.
- **Secrets go to the vault first.** Any password, MFA secret, SSH key or store token created
  while following a guide is written to the vault's `_credentials` (the user's password
  manager until the store exists) before it is used, and never printed in chat or logs.

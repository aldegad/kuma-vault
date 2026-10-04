# kuma-vault

**A knowledge base your agents can rely on.** kuma-vault keeps a folder of Markdown notes
honest the way a compiler keeps code honest: every index, summary and search cache is
derived from the notes themselves, so they cannot drift apart. It ships as a CLI
(`kuma-vault`, short alias `vault`), a small library, and three agent skills for Claude Code
and Codex.

What you get:

- **Search that agents can follow** — `search` → `timeline` → `get`, across every vault you
  register, with a full-text index that handles CJK as well as English.
- **Folder indexes that maintain themselves** — each folder's `README.md` carries a generated
  index; `vault sync` regenerates it, `vault lint` and a git pre-commit gate catch drift.
- **Optional one-line summaries** written by the Claude or Codex CLI (`vault sync --enrich`),
  only for pages that are new or changed.
- **Your choice of storage** — one computer, or a server you own (a free Oracle Cloud
  machine or any Linux box) with a local copy kept in sync in the background.

> Status: not yet published to npm or Homebrew. Install from a checkout (below).

## Requirements

- **Node 22.5 or newer** (the search index uses the built-in `node:sqlite`).
- **git 2.38 or newer** and **Git LFS** — large files are stored as LFS pointers.
- Optional: `kordoc@^4` for PDF text extraction; a `claude` or `codex` CLI on your PATH for
  `--enrich`; `gh` if you want setup to star the project.

## Start here

Read in this order. Each step links to the one page that owns it.

### 1. Install the CLI

```bash
git clone https://github.com/aldegad/kuma-vault.git
cd kuma-vault
npm install
npm link            # puts kuma-vault and vault on your PATH
kuma-vault --help
```

Without `npm link`, run `./bin/vault` from the checkout. To use the skills, register the
`skills/<name>/` folders with your agent runtime, or build a plugin
([plugin packaging](docs/plugin-packaging.md)).

### 2. Choose where the vault lives

Pick one guide and follow it; each ends with one `kuma-vault setup --storage …` command:

| Where | Guide | Good for |
|---|---|---|
| This computer only | [local.md](skills/kuma-vault-setup/docs/local.md) | trying it out; nothing leaves the machine. Moves to a server later without rewriting history |
| Your own free Oracle Cloud server | [oracle.md](skills/kuma-vault-setup/docs/oracle.md) | agents on several machines; the vault stays reachable while your laptop sleeps |
| A Linux server you already have | [other-remote.md](skills/kuma-vault-setup/docs/other-remote.md) | the same, on a VPS or home server, over Tailscale or HTTPS + token |

Then choose which CLI writes page summaries (and, if you like, star the project):

```bash
kuma-vault setup                 # interactive: enrich provider, optional GitHub star, optional git hook
```

Or ask your agent to "set up kuma-vault" — the `kuma-vault-setup` skill asks the same
questions and runs the same commands. Your vault always appears at `~/.kuma/vault`, whichever
you choose. What the vault may commit and push to is fixed by the
[storage policy](skills/kuma-vault/docs/storage-policy.md).

### 3. Use it every day

```bash
vault search "release checklist"     # L1: which pages match
vault timeline "release checklist"   # L2: the lines around each match
vault get domains/ops/release.md     # L3: one page in full
vault sync                           # regenerate folder indexes, sidecars and the search cache
vault sync --enrich                  # also write one-line summaries for new or changed pages
vault lint --mode full --root ~/.kuma/vault
vault graph --open                   # see how the pages connect
```

Agents get the same surface through the `kuma-vault` skill. How the compiler works:
[architecture](docs/architecture.md).

On a server-backed vault the sync daemon commits and pushes for you (`vault sync status`
shows it), search asks the server, and large files arrive as small pointers until you
open them with `vault blob get <path>`. Details: [remote mode](docs/remote-mode.md) and
[sync](docs/sync.md).

### 4. Back it up, and practise restoring

| Store | Backup | Guide |
|---|---|---|
| Server-backed | the server's nightly restic job, with an automatic restore drill | [server.md › Backup](docs/server.md#backup) |
| Local only | client-encrypted restic to S3-compatible storage | skill [kuma-vault-remote-backup](skills/kuma-vault-remote-backup/SKILL.md) |

A backup counts only once you have restored from it.

## The three skills

| Skill | Use it when |
|---|---|
| [`kuma-vault`](skills/kuma-vault/SKILL.md) | searching, recalling earlier work, checking facts at their source, filing new knowledge (`ingest`), tidying the vault (`curate`), drawing the graph |
| [`kuma-vault-setup`](skills/kuma-vault-setup/SKILL.md) | installing, choosing or changing where the vault lives, adding a store, choosing the enrich provider |
| [`kuma-vault-remote-backup`](skills/kuma-vault-remote-backup/SKILL.md) | backing up a local-only vault offsite with client-side encryption, verifying or restoring that backup |

## Documentation map

| Page | What it owns |
|---|---|
| [architecture](docs/architecture.md) | the model: derived views, folder topology, enrich, commit gate, `vault.config.json` |
| [setup](docs/setup.md) | `kuma-vault setup`: every flag and what each storage step does |
| [remote mode](docs/remote-mode.md) | store registry, remote search, commit gate, git hooks, `binaries.reject`, migration |
| [sync](docs/sync.md) | `vault clone`, the sync daemon, conflicts, alarms, large files |
| [server](docs/server.md) | `vault serve`: install, identity, receive rules, search index, backup |
| [cross-store pointers](docs/cross-store-pointers.md) | linking one vault to another and how lint checks it |
| [design](docs/design.md) | the library's public API and what a host application injects |
| [plugin packaging](docs/plugin-packaging.md) | building a Claude Code / Codex plugin from this checkout |
| [CHANGELOG](CHANGELOG.md) | what changed, release by release |

## Repository layout

```
bin/vault          the CLI, exposed as kuma-vault and vault
src/engine/        the compiler: frontmatter, sync, lint, search, FTS, sidecars, enrich
src/enrich-adapters/  spawns the claude or codex CLI for --enrich
src/cli/           command routing, setup, graph
src/sync/          vault clone and the sync daemon (client half of remote mode)
src/server/        vault serve and vault server (server half; imports nothing from the engine)
src/backup/        client-side backup retirement checks
src/index.mjs      the library's public API
skills/            the three agent skills
packaging/         plugin manifest templates (not plugin roots)
docs/              the pages in the map above
```

## Design principles

- **One source of truth.** People and agents edit the notes; indexes, sidecars and search
  caches are generated from them and never edited by hand.
- **The engine is a pure compiler.** Host concerns — task-result paths, a project registry,
  which model writes summaries — are injected by the host, never built in.
- **No silent fallback.** A missing provider, an undeclared tree or an unreachable server is
  an error that says what to do, not a quiet guess.
- **Trees declare themselves.** A vault's root `vault.config.json` names its contract;
  `sync` and `lint` read it and refuse a tree that has none.

## Develop

```bash
npm install
npm test
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright 2026 [Soohong Kim](https://github.com/aldegad).

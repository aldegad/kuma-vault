# `kuma-vault setup`

First-run setup decides **where the vault lives**, records which CLI writes page summaries
(the **enrich provider**), and — only on an explicit yes — **stars the project on GitHub**.
`vault setup` is the same command. Every choice is the user's: nothing is picked for them,
and nothing is starred without consent.

Two ways in, one deterministic core:

- **In a terminal**, `kuma-vault setup` asks the provider, star and git-hook questions.
- **Through an agent**, the [`kuma-vault-setup`](../skills/kuma-vault-setup/SKILL.md) skill
  asks with the runtime's own question surface, then runs the same command with flags.

Storage is set by flags only, and runs first. The user-facing walk-throughs are the three
guides in [`skills/kuma-vault-setup/docs/`](../skills/kuma-vault-setup/docs/); this page is
the reference behind them.

## Storage

```
kuma-vault setup --storage local [--store <id>] [--adopt] [--dry-run]
kuma-vault setup --storage oracle|remote --server <http(s)://host[:port]> [--token-file <path>] [--store <id>] [--adopt] [--dry-run] [--no-daemon]
kuma-vault setup --add-store <id> --storage local|oracle|remote [--server <url>] [--token-file <path>]
```

The main store is `kuma-main-vault` at `<kuma home>/vaults/<id>/` (kuma home = `KUMA_HOME_DIR`,
else `~/.kuma`), its tree `vault/`, and `<kuma home>/vault` links to that tree. `oracle` and
`remote` behave the same and are registered as `mode: "remote"`. `--add-store` creates another
store and leaves the link and the default store alone.

| Step | local | oracle / remote |
|---|---|---|
| refuse | an existing `~/.kuma/vault` (below), a registered id with another root, a non-empty store directory | the same, and a server whose `/v1/health` does not answer |
| preflight | git ≥ 2.38, git-lfs, a git commit identity (`git var GIT_COMMITTER_IDENT`) | the same |
| repository | `git init -b main`, `git lfs install --local` | `vault clone <server>/v1/stores/<id>.git` (token copied to `.git/kuma-vault/token`) |
| files | generated `.gitattributes` (LFS extensions, `merge=union` ledgers) and `.gitignore` (junk block), `vault/.rgignore` (the secret directories a plain `rg` skips), `vault/vault.config.json` (`visibility: private`, `remotes.allowed`, `binaries.reject: []`), `vault/README.md` if missing | the same when the server store is empty; a non-empty store is taken as it is (its URL is added to `remotes.allowed` when missing) |
| hooks | `vault hook install` (pre-commit gate, pre-push allowlist) | the same |
| commit | `vault sync`, then one commit of everything | the same (empty store only) |
| register | `vault-stores.json`: `mode: local`, default for the main store | `mode: remote`, `remote.tokenFile` = the clone's copy |
| link | `~/.kuma/vault` → the tree (main store) | the same |
| push | — | last: nothing reaches the server unless every step above held |
| daemon | — | macOS: `vault sync install` (launchd); elsewhere it says to run `vault syncd` under a service manager. A daemon that fails to install is reported (exit 1) and the store stays |

Every step that changes something registers its undo; a failure runs them in reverse and prints
each one. Running setup again for a store that is already registered at the same root with the
link in place prints "already set up" and exits 0.

**An existing `~/.kuma/vault`** is never taken over silently (exit 3):

| What is there | Verdict |
|---|---|
| a link to this store's tree | already set up |
| a folder or link inside a git repository | refused; the message names `vault migrate to-remote` (a history with raw large files needs a rewrite first) |
| a plain folder (Kuma Studio's first-run seed) | refused with its file count and bytes, unless `--adopt`: one `rename` into the tree (another filesystem is refused, never copied), counts printed before and after. On a later failure the added files are removed, rewritten READMEs and declaration restored, the listing compared with the original, and the folder renamed back. A server store that already holds a vault refuses `--adopt` |
| a dangling link, a file | refused |

`--dry-run` prints the plan (paths, server, adopt source with its counts) and changes nothing.

## Enrich provider

```
kuma-vault setup --provider claude|codex [--model <id>] --yes
```

`claude` spawns the Claude CLI, `codex` the Codex CLI; only these two are supported. Without
`--model`, the provider's default model comes from the enrich adapter
(`createCliDescriptionGenerator({ provider }).model`), the single place model ids are kept.
Before anything is saved, setup makes one real call with the chosen provider and model (a
short sample page, through the same adapter `vault sync --enrich` uses). A CLI that refuses the
model (a retired id, or one the user's sign-in does not cover) or is not signed in fails setup
with the CLI's own words, and nothing is written. The choice is then merged into
`~/.kuma-vault/config.json` (override the path with `KUMA_VAULT_CONFIG`) with an atomic write;
other keys in the file survive. `vault sync --enrich`
reads it and fails with a message naming `kuma-vault setup` when it is missing.

## GitHub star (optional)

Default is **No**. On an explicit yes (`--star`, or `y` at the prompt) setup stars its own
repository through the GitHub REST API — `gh` has no `repo star` subcommand:

```
gh api --method PUT /user/starred/{owner}/{repo}
```

The target is `aldegad/kuma-vault`, overridable with `--repo <owner/repo>` or the config key
`starRepo` (flag, then config, then the built-in). A missing or unauthenticated `gh`, or a
failed call, prints the reason and skips: a courtesy never fails setup. It never stars the
repository you happen to be in.

## Git hook (optional)

`--hook-root <repo>` (or a path at the third prompt) installs the pre-commit drift gate by
calling `kuma-vault hook install --root <repo>`; setup never re-implements the hook.

## Non-interactive runs

With `--yes`, or without a terminal, there are no prompts. One of `--provider` or `--storage`
is required — there is no silent default — and the star happens only with `--star`. A
storage-only run ends after the storage step and says to run the provider step next.

## Where the code lives

| Piece | Path |
|---|---|
| Setup command, prompts, config write, star | `src/cli/setup.mjs` |
| Storage step (`--storage`, `--add-store`) | `src/cli/setup-storage.mjs` |
| Enrich config reader | `src/cli/enrich-config.mjs` |
| Agent-facing skill and storage guides | `skills/kuma-vault-setup/` |
| Plugin manifests | `packaging/` — see [plugin packaging](plugin-packaging.md) |

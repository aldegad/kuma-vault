# kuma-vault

A repo-agnostic **knowledge-base compiler** extracted into its own package: frontmatter parsing, index sync, lint (drift gate), search, full-text search (FTS), sidecar extraction, and description enrichment. Host applications consume it as a library and inject their host-specific concerns (dispatch paths, project registry, model profiles).

> Status: self-standing engine library + `kuma-vault` CLI (`vault` short alias) + git
> pre-commit drift-gate installer + interactive setup, packaged as a Claude Code / Codex plugin.
> Not yet published to a registry.

## Requirements

- **Node >= 22.5** — the FTS index uses `node:sqlite` (`DatabaseSync`, FTS5), which is a zero-native-build built-in on Node 22.5+.
- Test runner: **vitest**.
- Optional: `kordoc@^4` for PDF sidecar extraction (PDF engine bundled since kordoc 4.x — no separate `pdfjs-dist`; lazily imported so a vault with no PDFs never pays the load cost). Optional: a `claude` or `codex` CLI on PATH, only when using `--enrich`.

## Install

`kuma-vault` is not published to npm or Homebrew yet, so the command does not exist on a
fresh machine until you install or link this checkout.

From a local checkout:

```bash
cd /path/to/kuma-vault
npm install
npm link
```

After `npm link`, npm exposes both binary names from `package.json`:

```bash
kuma-vault --help
vault --help
```

Use `kuma-vault` in docs, scripts, and setup instructions. `vault` is kept as a short alias for
the same CLI.

Without a global link, run the repo-local binary directly:

```bash
./bin/vault --help
./bin/vault setup
```

## Layout

```
src/
  index.mjs                     public API barrel
  engine/                       pure compiler
    vault-profile.mjs           profile abstraction (graph root)
    vault-config.mjs            repo self-declaration resolver (vault.config.json → root + contract)
    vault-ingest.mjs            frontmatter parser + core sync + dispatch-ingest
    vault-search.mjs            search + get
    vault-fts.mjs               node:sqlite FTS index
    vault-lint.mjs              drift lint
    vault-sync-triggers.mjs     self-heal / boundaries
    vault-lifecycle-hook.mjs    dispatch-lifecycle lint hook
    vault-sidecar.mjs           sidecar extraction (PDF via kordoc)
    vault-enrich.mjs            pure enrich (injected generateDescription)
    path-resolver.mjs           resolveVaultDir (env-driven)
    atomic-file-store.mjs       atomic write primitive
    kuma-paths.mjs              default dispatch/stamp paths (injectable)
    project-attribution.mjs     pure project-id matcher (injected known ids)
  enrich-adapters/
    provider-adapter.mjs        createCliDescriptionGenerator (claude|codex)
    process-util.mjs            CLI spawn primitive
  cli/
    cli.mjs                     node CLI router (vault-<verb>)
    vault-commands.mjs          sync/lint/search/get/ingest adapters
    enrich-config.mjs           reads provider from ~/.kuma-vault/config.json
    setup.mjs                   `kuma-vault setup` (provider pick + GitHub star)
bin/vault                       human CLI surface, exposed as `kuma-vault` and `vault`
skills/                         kuma:vault (retrieval) + kuma:vault-setup (first-run)
.claude-plugin/plugin.json      Claude Code plugin manifest
.codex-plugin/plugin.json       Codex plugin manifest
docs/design.md                  extraction design + dependency seams
docs/setup.md                   interactive-setup research + design + evidence
```

## Setup

Run setup after the CLI is installed or linked:

```bash
kuma-vault setup                       # interactive: pick an enrich provider, optionally star
kuma-vault setup --provider claude --yes   # non-interactive (agent / CI); add --star to consent
```

Setup records the enrich provider (`claude` | `codex`) to `~/.kuma-vault/config.json` and, only on
explicit consent, stars the project via `gh`. The choice is always the user's. See `docs/setup.md`
for the doc-first design and cross-runtime (Claude Code / Codex) plugin packaging. `vault setup`
is kept as a short alias for the same CLI.

## Design principles

- **SSoT** — the engine source lives here, once. Consumers import it; they do not vendor a copy.
- **SoC** — the engine is a pure compiler. Host-specific concerns are **injected**: dispatch paths (`taskDir`/`resultDir`/`stampDir`), the project registry (`knownProjectIds`), and the enrich model policy (which provider/model to spawn). The engine ships no-op/empty defaults so a generic tree works with no dispatch or project concepts.
- **No Silent Fallback** — a missing enrich provider or PDF dependency throws a clear error; nothing is silently skipped.
- **Repo self-declaration** — a managed tree declares its own contract in a root-level `vault.config.json` (base contract id + tree-local overrides). `vault sync`/`vault lint` resolve the target root *and* its contract from that declaration in one step: a disagreeing `--profile` flag is a hard error, an undeclared tree without explicit flags is a hard error, and there is no default-vault fallback. This structurally removes the flag-pair accident class (`--profile` without `--root` applying a foreign contract to the wrong tree).

See `docs/design.md` for the full dependency-seam analysis, and `docs/architecture.md` for the
four-domain topology (kuma-studio = system/host, kuma-vault = ontology engine, knowledge repos =
sibling content trees, each self-declaring via `vault.config.json`) and the fail-loud resolution
contract.

## Test

```bash
npm install
npm test
```

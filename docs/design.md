# Design — the library and what a host injects

kuma-vault is one npm package that is both a CLI and a library. A host application (Kuma
Studio is one) imports the engine instead of keeping its own copy, and injects the concerns
that belong to the host. This page is the contract between the two. The model the engine
implements is in [architecture](architecture.md).

## Principles

- **One copy of the engine.** Hosts depend on this package (`npm link`, a `file:` dependency or
  a packed tarball) and import from it. Vendoring a second copy would create a second source
  of truth.
- **The engine is a pure compiler.** Anything that depends on the host — where task results
  live, which projects exist, which model writes summaries — is a parameter, with an empty or
  no-op default so a plain tree works without any of it.
- **No silent fallback.** A missing provider, an undeclared tree or a missing PDF extractor is
  an error with a next step, never a quiet skip.

## Package layout

| Part | Path | Notes |
|---|---|---|
| CLI | `bin/vault` | one bash entry, exposed as `kuma-vault` and `vault`; engine verbs go to `src/cli/cli.mjs` |
| Compiler | `src/engine/` | frontmatter, sync, lint, get, sidecars, enrich, profiles, `vault.config.json` |
| Enrich adapter | `src/enrich-adapters/` | spawns the `claude` or `codex` CLI; the only place that runs a model |
| Remote mode, client | `src/sync/` | `vault clone`, the sync daemon, `vault blob` |
| Remote mode, server | `src/server/` | `vault serve`, `vault server`; imports nothing from the compiler |
| Public API | `src/index.mjs` | the barrel below; subpaths `kuma-vault/engine` and `kuma-vault/enrich-adapters` |

Runtime: Node 22.5 or newer — no native build step. The provider CLIs are needed only for
`--enrich`; `kordoc` only for PDF sidecars, and it is loaded lazily.

## Public API

Everything a host needs is exported from `kuma-vault` (`src/index.mjs`):

| Area | Exports |
|---|---|
| Frontmatter | `parseFrontmatterDocument`, `stringifyFrontmatter`, `extractTitle`, `extractSummary` |
| Sync and ingest | `syncVaultIndex`, `rewriteIndex`, `runVaultSync`, `formatVaultSyncReport`, `vaultSyncExitCode`, `ingestGenericSource`, `ingestInbox`, `ingestResultFile`, `ingestResultFileWithGuards`, `resolveResultPathForTaskId`, `inspectExistingPageBodyShape`, `analyzeDocumentRouting` |
| Self-heal and hooks | `selfHealStaleIndex`, `triggerVaultSyncIndex`, `runVaultLifecycleHook`, `parseTaskFileMetadata` |
| Lint | `lintVaultFiles`, `formatVaultLintReport` |
| Get | `getVaultDocuments`, `formatVaultGetText`, `crossesSecretDir` (no search: a scoped `rg` over the tree finds pages) |
| Sidecars | `syncVaultSidecars`, `SIDECAR_EXTRACTORS` |
| Enrich | `enrichVaultDescriptions` and its field constants; `createCliDescriptionGenerator`, `buildEnrichPrompt`, `parseEnrichResponse`, `SUPPORTED_ENRICH_PROVIDERS` |
| Contracts | `VAULT_PROFILE`, `DOCS_PROFILE`, `resolveProfile`, `listProfileIds`, `loadVaultDeclaration`, `discoverVaultDeclaration`, `resolveDeclaredProfile`, `resolveVaultContract` |
| Stores and paths | `resolveVaultDir`, `loadStoreRegistry`, `resolveStoreRegistryPath`, `judgeBinaryWrite`, `MAX_NON_LFS_BYTES` |
| Reading a remote clone | `parseLfsPointer`, `LFS_POINTER_MAX_BYTES`, `syncStateDir`, `blobGet`, `readTreeSyncConflicts` ([sync › From a host](sync.md#from-a-host-package-api)) |
| Project attribution | `inferProjectIdFromSlugPrefix`, `detectProjectIdFromContentText`, `normalizeKnownProjectIds` |

`src/index.exports.test.mjs` imports the host-facing exports through the package name, as a
host does, so one missing from the barrel or the `exports` map fails there.

## What a host injects

| Concern | How it reaches the engine | Default without a host |
|---|---|---|
| Where task files, task results and ingest stamps live | `taskDir`, `resultDir`, `stampDir` parameters of the result-ingest functions (the lifecycle hook takes the task file itself) | `~/.kuma/dispatch/tasks`, `~/.kuma/dispatch/results`, `~/.kuma/runtime/vault-ingest`, each overridable by environment (`KUMA_TASK_DIR`, `KUMA_RESULT_DIR`, `KUMA_VAULT_INGEST_STAMP_DIR`, or the `KUMA_HOME_DIR` they derive from). A tree with no task results never calls these functions |
| Which projects exist | known project ids passed to the attribution functions | none: nothing is attributed |
| Which model writes summaries | the host builds a `generateDescription` (usually by calling `createCliDescriptionGenerator({ provider, model })` with its own policy) and passes it to enrich | the CLI reads `{ provider, model }` from `~/.kuma-vault/config.json`, written by [`kuma-vault setup`](setup.md#enrich-provider) |
| A tree's contract | a profile object, or the tree's own `vault.config.json` | the declaration at the tree's root; no built-in default |

The core compiler — sync, lint, get, sidecars, enrich, profiles, frontmatter — takes
none of these: `syncVaultIndex({ vaultDir, check, maxPasses, profile, trackedDirs })` has no
host parameter at all. Only result ingest and project attribution are host-shaped, and both
take their host data as arguments.

## The enrich adapter

```
createCliDescriptionGenerator({ provider, model, effort, serviceTier }) => generateDescription
```

- `provider` is `"claude"` or `"codex"`; the adapter owns that list.
- `codex` runs `codex exec --ephemeral --skip-git-repo-check --sandbox read-only --cd <tmp>
  --model <model> --output-last-message <file>` and reads the answer only from that file.
- `claude` runs `claude --print --output-format text --safe-mode --tools "" --no-session-persistence
  --model <model> <prompt>`. `--safe-mode` loads none of the user's CLAUDE.md, hooks, MCP servers,
  skills or plugins and keeps the user's sign-in; `--tools ""` leaves the model no tools. `--bare`
  is not used: it reads only `ANTHROPIC_API_KEY` or an `apiKeyHelper`, so a subscription sign-in
  gets "Not logged in".
- Both run in a fresh empty temporary directory per call, so the model sees only the page it
  summarises.
- The default model per provider is kept in the adapter (`.model` on the returned
  generator) and nowhere else; an explicit `model` wins. claude's is the `sonnet` alias, which
  the CLI maps to the latest model of that family; codex's is a catalog id (`gpt-6-luna`), and
  `vault setup` makes one real call with the chosen model before saving it.

| Layer | Owner | Responsibility |
|---|---|---|
| Pure enrich | `src/engine/vault-enrich.mjs` | fills the enrich fields through the injected `generateDescription` |
| Adapter | `src/enrich-adapters/` | turns a provider choice into `generateDescription` |
| Stored choice | `~/.kuma-vault/config.json` | the provider and model picked at setup |
| Model policy | the host | decides provider and model, then calls the adapter |

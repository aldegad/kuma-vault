# Standalone sources and plugin artifacts

The canonical skill sources are `skills/<name>/`. Local installers register these directories without adding plugin manifests anywhere in their ancestry. Runtime metadata templates live in `packaging/claude.json` and `packaging/codex.json`; they are not runtime plugin roots. Package identity and version come from `package.json`.

## Generate and consume

Run `npm run package:plugin -- /existing/parent/new-plugin` from a stable checkout. The destination parent must already exist, and its resolved path must be outside the source tree and must not contain the source. The builder asks npm for its package file list with lifecycle scripts disabled, copies that list with executable modes preserved, and materializes `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` only in the artifact. The `package.json` files catalog owns payload membership, including every directory under `skills/`; no separate list of skill names is maintained. Source test files remain excluded by that catalog.

The artifact retains `bin/`, `src/`, `skills/`, `docs/`, package metadata and license files. It does not bundle `node_modules`. Install its declared dependencies before using dependency-backed features, just as for a checkout. The built-in CLI help and non-dependency paths can run directly with `./bin/vault --help`. No registry publish or plugin registration is performed by packaging.

For Claude Code, run `claude plugin validate /existing/parent/new-plugin`, then use `claude --plugin-dir /existing/parent/new-plugin`. For Codex, point the marketplace plugin source at the generated directory using the runtime's documented marketplace workflow. Plugins intentionally retain the runtime's namespaced skill presentation. The plain checkout and its local skill links retain standalone names. To make an internal plugin tarball, run `npm pack` in the artifact; a tarball made directly from the checkout contains templates and the builder but no active root manifests.

## Publication, repetition and concurrency

An atomic `mkdir` reservation at `<destination>.lock` serializes builders addressing the same resolved destination. The first reservation wins; a concurrent caller fails visibly with `EEXIST`, without changing the destination. No waiting, automatic retry or stale reservation recovery occurs. A crashed process can leave a reservation or hidden staging directory; identify the owner before manually removing these paths.

The builder assembles a sibling staging directory and publishes it with one directory rename. Before publication failures remove its own staging directory and reservation. Existing output is never updated: identical file paths, modes and bytes return `unchanged`, and any difference fails with an instruction to choose a new destination. This protocol coordinates calls to this builder; callers must keep source files stable and must not modify the destination externally during a build. Removing an artifact requires first removing any runtime registration that refers to it, then deleting that explicitly owned artifact. Neither operation changes the canonical skill sources.

## Verification

Run `npm run test:packaging` for synthetic executable-payload, recursive-asset, generated-manifest, repeat, collision, rollback, destination-protection and npm-tarball membership tests. Run the generator twice against a new destination and execute its `bin/vault --help`. Inspect local discovery separately: Codex exposes the model-visible catalog with `codex debug prompt-input`; Claude's stream initialization exposes its skill command catalog. A manifest validator alone does not prove standalone discovery.

Runtime contracts: [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference) and [Codex plugin documentation](https://developers.openai.com/codex/plugins). Metadata adapters follow those package contracts; they do not change engine discovery code.

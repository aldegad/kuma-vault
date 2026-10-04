# Cross-store pointers

A fact lives in exactly one vault store. When a page in one store needs a fact owned by
another, it points at it with a **cross-store pointer**. `vault lint` checks that every pointer
resolves to a real file in the target store and fails loudly when one does not; `vault search`,
`vault get` and `vault graph` follow the same pointers. What a pointer *means* in a given vault
is up to that tree's `schema.md`; this page is how the engine reads and checks it.

## Pointer form

A pointer is an inline code span holding `` `<store-id>:<path>` ``. `store-id` is the target
tree's `vault.config.json` `id` (for example `team-notes` or `acme-ops`); `path` is relative to
that tree's root. A pointer to a directory ends with a slash:
`` `team-notes:domains/research/` ``.

## From store id to a folder: the machine's registry

The same store sits at a different absolute path on each machine, so the `id → root` mapping
cannot live in any tree. It lives in the machine's store registry:

- `~/.kuma/vault-stores.json` (`$KUMA_HOME_DIR/vault-stores.json`; `KUMA_VAULT_STORES`
  overrides the path). Its format, and the `vault store` commands that write it, are in
  [remote mode › Store registry](remote-mode.md#store-registry-v2-kumavault-storesjson).
- The id itself still belongs to each tree's `vault.config.json`. When resolving, the engine
  checks that the registered root really declares that id; a mismatch is an error.

Creating the registry is what turns the check on. A machine with no registry resolves no
pointers, and says so instead of passing quietly.

## What counts as a pointer

A token is a pointer only when all of these hold:

- It is inside a single-backtick inline code span, and the span holds nothing else. Tokens in
  fenced code blocks (```` ``` ````, `~~~`) are examples and are not checked.
- `store-id` matches lower-case kebab case: `[a-z][a-z0-9]*(-[a-z0-9]+)*`.
- The path does not start with `/` (a machine path is not a cross-store reference).
- The path contains no `://`.
- The path ends in `.md` (a page) or `/` (a directory). Pointers name documents in another
  tree, so this shape is part of the contract, not a heuristic.

These rules keep out values that merely look like paths: mail headers and URI schemes
(`to:user@example.com`, `from:host.com`, `file:../x`, `data:image/png;base64,...`), URLs, times
and ratios (`12:30`, `16:9`) and ordinary `key: value` text — each of them a false positive
seen in real pages.

## Failure codes

An unresolved pointer is reported with a code. All of these have `severity: error` and fail
lint:

| Code | Meaning |
|---|---|
| `cross-store-unknown-store` | the store id is not in the registry. Register it, or fix the typo |
| `cross-store-store-root-missing` | the store is registered, but its root does not exist on this machine |
| `cross-store-registry-mismatch` | the registered root declares a different `id` |
| `cross-store-registry-invalid` | the registry file exists but is broken JSON or the wrong shape; no pointer is resolved |
| `cross-store-pointer-invalid` | the path escapes the target store's root with `..` |
| `cross-store-pointer-unresolved` | the store resolves, but the file (or, with a trailing slash, the directory) does not exist |

On a machine with no registry, any pointer found yields one `cross-store-check-skipped` line
with `severity: warn` and a count.

## Severity

Every lint issue has a `severity`; one without it counts as `error`. `result.ok` is true only
when there is no error. `warn` and `info` issues are reported (text output marks them
`[warn]`) but do not fail lint.

## When the check runs

Only in `full` mode. It walks the files requested — the whole tree, or a `--files` subset —
so a broken pointer new in one changed file is caught at pre-commit too. `fast` mode does not
touch other trees. The full walk already skips archives, the plans slot and owner-local
buckets, so stale pointers in historical documents raise no false alarms.

Implementation: `src/engine/vault-stores.mjs` (registry loader) and `src/engine/vault-lint.mjs`
(parser and resolution). Tests: `src/engine/vault-stores.test.mjs`,
`src/engine/vault-cross-store.test.mjs`.

## Search and get across stores

`vault search` searches **every registered store by default**. With no registry, or a broken
one, it searches the primary store and prints `stores_skipped:` — a machine without a registry
has simply not opted in, so this is not an error (unlike `vault graph --all-stores`, which asks
for the registry explicitly). In a multi-store result each hit id is a pointer,
`<store-id>:<path>`, and `vault get` resolves it through the same registry, so
`search → timeline → get` works across store boundaries.

`--vault-dir <path>` narrows the search to that one tree, `--store <id>` to one registered
store. Hits from different stores are ranked by the number of matches they show, because the
engines' own scores (bm25 for FTS, match counts for a scan) cannot be compared. The primary
store gets no bonus: otherwise an exact hit in another store would sink below a weak one in the
primary — the very miss this feature exists to prevent.

Implementation: `src/engine/vault-search.mjs` (`searchVaultStores`, pointer resolution in
`getVaultDocuments`). Tests: `src/engine/vault-search.test.mjs`, `describe("searchVaultStores")`.

## The graph's xstore layer

`vault graph` draws its **xstore** layer with the same parser (`extractCrossStorePointers`) and
the same registry: referencing page → external page → external store hub. The graph has no
parser of its own. Because it is a viewer, not a checker, an unknown store id is counted rather
than failed, and a pointer into a store it scanned (itself, or every registered store with
`--all-stores`) resolves to that store's real page node — in the union view those edges are the
bridges between stores. Details: the `kuma-vault` skill's
[graph reference](../skills/kuma-vault/docs/graph.md).

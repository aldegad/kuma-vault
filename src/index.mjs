// kuma-vault — public API barrel.
//
// The compiler vault engine as a repo-agnostic library. Consumers import from here
// (or from the ./engine / ./enrich-adapters subpaths) instead of reaching into the
// host source tree. Host-specific concerns (dispatch paths, project registry, model
// profiles) are injected by the consumer — see the injectable parameters on the ingest
// functions and createCliDescriptionGenerator.

// Frontmatter primitives — the shared parse/stringify contract other tools reuse.
export {
  parseFrontmatterDocument,
  stringifyFrontmatter,
  extractTitle,
  extractSummary,
} from "./engine/vault-ingest.mjs";

// Core compiler: sync / index / routing / dispatch-ingest.
export {
  analyzeDocumentRouting,
  rewriteIndex,
  syncVaultIndex,
  resolveResultPathForTaskId,
  ingestResultFile,
  ingestResultFileWithGuards,
  ingestGenericSource,
  ingestInbox,
  inspectExistingPageBodyShape,
  isSidecarPath,
  isArchiveTreeRelativePath,
  isPlansSlotPath,
  isOwnerLocalBucketPath,
  resolveGitTrackedDirs,
  SIDECAR_SOURCE_EXTENSIONS,
  VAULT_ROOT_NON_NAV_FILES,
} from "./engine/vault-ingest.mjs";

// Lint (drift gate) + report formatting.
export { lintVaultFiles, formatVaultLintReport } from "./engine/vault-lint.mjs";

// Get: read pages by path or `<store>:<path>` pointer (no index; finding is a scoped `rg`).
export { getVaultDocuments, formatVaultGetText } from "./engine/vault-get.mjs";

// The secret directories (`_credentials/`, `_sync-conflicts/`) no surface reads or serves.
export { crossesSecretDir } from "./server/secret-dirs.mjs";

// Retired search names a host branch cut before the removal still imports: they load and throw
// on call. Remove after the next app install.
export { searchVault, formatVaultSearchText, resolveFtsDbPath } from "./engine/retired-search.mjs";

// Sidecar extraction.
export { syncVaultSidecars, SIDECAR_EXTRACTORS } from "./engine/vault-sidecar.mjs";

// Enrich (pure — takes an injected generateDescription). Owns a fixed leaf-frontmatter field
// allowlist (description/tags/aliases) with per-field idempotency stamps.
export {
  enrichVaultDescriptions,
  ENRICH_FIELDS_ALL,
  DEFAULT_ENRICH_FIELDS,
  ENRICH_HASH_FIELD,
  enrichStampField,
  sanitizeTags,
  sanitizeAliases,
} from "./engine/vault-enrich.mjs";

// The composed `vault sync` pipeline (sidecar → enrich → index → lint), its report
// formatter, and its exit gate. Every consumer's `vault sync` is an adapter over this: flags in,
// host generator + matching enrich field set injected, report out. Nobody re-composes the order
// or re-decides the gate — that judgement has one home (원칙 1).
export { runVaultSync, formatVaultSyncReport, vaultSyncExitCode } from "./engine/vault-sync-pipeline.mjs";

// Sync triggers + self-heal.
export { selfHealStaleIndex, triggerVaultSyncIndex, STALE_INDEX_CODE } from "./engine/vault-sync-triggers.mjs";

// Lifecycle hook (dispatch lifecycle event -> lint). Dispatch paths are injected.
export { runVaultLifecycleHook, parseTaskFileMetadata } from "./engine/vault-lifecycle-hook.mjs";

// Profile abstraction. The engine ships generic built-in profiles only
// (`kuma-vault` default, `docs` docs-as-code). A consumer with a tree-specific
// contract passes its own profile OBJECT to `resolveProfile` / the sync/lint APIs.
export { VAULT_PROFILE, DOCS_PROFILE, resolveProfile, listProfileIds } from "./engine/vault-profile.mjs";

// Repo self-declaration (`vault.config.json`): a managed tree declares its own
// contract at its root; the CLI resolves root + contract together from it (the
// structural fix for the `--profile`-without-`--root` accident class).
export {
  VAULT_CONFIG_FILENAME,
  loadVaultDeclaration,
  discoverVaultDeclaration,
  resolveDeclaredProfile,
  resolveVaultContract,
} from "./engine/vault-config.mjs";

// Vault directory resolver.
export { resolveVaultDir } from "./engine/path-resolver.mjs";

// Storage policy a host applies before it writes a file into a vault tree: the same verdict the
// pre-commit gate gives a staged file (intermediate places, the non-LFS size ceiling).
export { judgeBinaryWrite, MAX_NON_LFS_BYTES } from "./engine/commit-policy.mjs";

// The machine's store registry (`~/.kuma/vault-stores.json`, v1 and v2), read side.
export { loadStoreRegistry, resolveStoreRegistryPath } from "./engine/vault-stores.mjs";

// A tree's sync conflict records (`_sync-conflicts/conflicts.jsonl`), read by path.
export { readTreeSyncConflicts } from "./sync/conflicts.mjs";

// Reading a partial clone (docs/sync.md "From a host"): the canonical LFS pointer form, where the
// sync daemon keeps its state files, and `vault blob get` as a call.
export { parseLfsPointer, LFS_POINTER_MAX_BYTES } from "./server/lfs-paths.mjs";
export { syncStateDir } from "./sync/context.mjs";
export { blobGet } from "./sync/blob.mjs";

// Project attribution (pure — consumer injects its known project ids).
export {
  inferProjectIdFromSlugPrefix,
  detectProjectIdFromContentText,
  normalizeKnownProjectIds,
} from "./engine/project-attribution.mjs";

// Enrich provider-adapter — turns a provider choice (claude|codex) into the injected
// generateDescription the enrich engine needs. Model/profile policy is a consumer concern.
export {
  createCliDescriptionGenerator,
  buildEnrichPrompt,
  parseEnrichResponse,
  isSupportedEnrichProvider,
  SUPPORTED_ENRICH_PROVIDERS,
} from "./enrich-adapters/provider-adapter.mjs";

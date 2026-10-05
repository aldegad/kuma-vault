// Vault contract profiles (DEC vault-compiler step 8: repo-agnostic sync/lint).
//
// The sync + lint engines are pure functions of (root, profile). A *profile*
// captures every topology contract that differs between one docs-as-code tree
// and another — which slots are non-nav, which root files are ledgers, whether
// binary sidecars / LLM enrichment apply, where the rules doc lives, and how the
// managed navigation scope is bounded. `syncVaultIndex`/`lintVaultFiles` take the
// SAME entry point for every tree; only `root` + `profile` change (audit F —
// identity, never a dedicated fork or thin clone).
//
// Every predicate in vault-ingest defaults its `profile` argument to
// `VAULT_PROFILE`, so existing callers and the whole kuma-vault path stay
// byte-identical (원칙 1 SSoT — one engine, one default).

// The kuma Topology Vault (`~/.kuma/vault`) — the canonical brain tree.
export const VAULT_PROFILE = Object.freeze({
  id: "kuma-vault",
  // Top-level slots whose contents are archives/ledgers, not a descended nav
  // tree: the generator mints only the slot's own top README and never indexes
  // its children (DEC vault-ingest archive contract).
  archiveTreeDirs: Object.freeze(["raw", "images", "recordings", "results", "stores", "memos", "inbox", "lessons", "docs"]),
  // The plans store is owned by `kuma plan lint`; neither the index generator nor
  // vault-lint may treat plan documents as knowledge pages (DEC step 1/13).
  plansSlotRoot: "plans",
  // Root-level append-only ledgers: reachable via curated root prose, excluded
  // from the generated root vault-index.
  rootNonNavFiles: Object.freeze(["dispatch-log.md", "log.md"]),
  // Owner-local bucket signal (originals/attachments/evidence live next to their
  // canonical owner in an underscore-prefixed bucket; non-nav — DEC step 12).
  ownerLocalBucketPrefix: "_",
  // Binary source extensions with a registered sidecar extractor (SSoT: the
  // vault-sidecar extractor registry must cover exactly these).
  sidecarSourceExtensions: Object.freeze([".pdf"]),
  sidecar: true,
  enrich: true,
  // Pages the model never describes although they are targets: gitignore syntax, tree-relative,
  // case-insensitive (a tree's files a person alone writes, such as its decision ledgers). The
  // engine names none; a tree declares its own in vault.config.json.
  enrichExclude: Object.freeze([]),
  // Vault-specific canonical lint scans (projects/ canonical-drift invariants,
  // domain taxonomy tree drift). Off for generic docs-as-code trees that don't
  // carry the vault's projects/domains slot semantics.
  canonicalChecks: true,
  // Top-level `domains/<name>.md` pages that are persona-memory pages (linted with that
  // contract; every other top-level page is domain-top-level-drift). A tree declares its own in
  // vault.config.json — no page shape tells a persona page from a misplaced topic page, so the
  // engine names none.
  personaMemoryPages: Object.freeze([]),
  // Enforce the vault canonical-page frontmatter/section authoring contract on
  // every content page (title/created/updated, per-page-type schemas; the
  // `domain` field is REJECTED here as deprecated — 2026-07-05). Generic
  // docs-as-code trees don't mandate frontmatter — they lint on topology only
  // (broken links, stale index regions, orphans), so they set this false.
  enforcePageFrontmatter: true,
  // Body sections a generic (untyped) content page must carry when
  // enforcePageFrontmatter is on. The brain vault authors every canonical page
  // in this shape; a knowledge repo whose pages are heterogeneous artifacts
  // (evaluation reports, verbatim mail originals) overrides this with `[]` to
  // keep frontmatter enforcement without demanding a body restructure.
  genericPageSections: Object.freeze(["Summary", "Details", "Related"]),
  // "all": walk the entire filesystem tree (minus dot-dirs, node_modules,
  // owner-local buckets, plans slot, archive dirs). The vault brain is a curated
  // tree, so every non-excluded folder is a navigable knowledge folder.
  navScope: "all",
  schema: Object.freeze({
    path: "schema.md",
    validateSpecialFiles: true,
    autoScaffold: true,
  }),
});

// Generic docs-as-code knowledge base. Same README-index topology as the vault
// (folder=topic, README=index, parent↔child drill-down, no orphans), but a
// leaner slot contract: no plans store, no binary sidecar / LLM enrichment, no
// machine-validated schema special-file frontmatter (the tree's rules live in a
// plain runbook), and navigation scoped to the *git-tracked* layer only. That
// last point matters for repos whose working tree also holds large untracked or
// vendored material next to the managed handbook: scoping nav to git-tracked
// directories keeps the derived index bounded to the handbook.
//
// This is a repo-agnostic template. A consumer that needs tree-specific values
// (a different rules-doc path, extra root non-nav files, a named archive dir)
// passes its own profile OBJECT to `resolveProfile` — the engine never hard-codes
// a specific organization's tree (SoC — engine ships generic profiles only).
export const DOCS_PROFILE = Object.freeze({
  id: "docs",
  // `archive/` preserves immutable originals: keep its own README, do not index
  // its children.
  archiveTreeDirs: Object.freeze(["archive"]),
  plansSlotRoot: null,
  // Agent-instruction files at the repo root are not nav pages. (CLAUDE.md /
  // GEMINI.md are commonly symlinks skipped as non-regular files; AGENTS.md is a
  // real file that would otherwise be indexed.)
  rootNonNavFiles: Object.freeze(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]),
  // `_local/`, `_secrets/`-style buckets use the same underscore signal.
  ownerLocalBucketPrefix: "_",
  // No binary sidecar derivation (source binaries stay as originals).
  sidecarSourceExtensions: Object.freeze([]),
  sidecar: false,
  enrich: false,
  enrichExclude: Object.freeze([]),
  canonicalChecks: false,
  personaMemoryPages: Object.freeze([]),
  enforcePageFrontmatter: false,
  genericPageSections: Object.freeze(["Summary", "Details", "Related"]),
  navScope: "git-tracked",
  schema: Object.freeze({
    // Informational only under this profile (validateSpecialFiles is false, so the
    // path is never read); a consumer profile overrides it with its rules-doc path.
    path: "README.md",
    validateSpecialFiles: false,
    autoScaffold: false,
  }),
});

const PROFILES = Object.freeze({
  [VAULT_PROFILE.id]: VAULT_PROFILE,
  [DOCS_PROFILE.id]: DOCS_PROFILE,
});

// Resolve a profile from an id string or a profile object. Unknown ids are a hard
// error (No Silent Fallback — never silently downgrade to the vault contract).
export function resolveProfile(profile) {
  if (!profile) {
    return VAULT_PROFILE;
  }
  if (typeof profile === "object") {
    return profile;
  }
  const found = PROFILES[profile];
  if (!found) {
    throw new Error(
      `Unknown vault profile: ${profile} (known: ${Object.keys(PROFILES).join(", ")}).`,
    );
  }
  return found;
}

export function listProfileIds() {
  return Object.keys(PROFILES);
}

// Repo self-declaration resolver (`vault.config.json`).
//
// A managed tree declares its OWN contract in a root-level `vault.config.json`:
// a base contract id (an engine built-in profile) plus tree-local overrides
// (extra root non-nav files, a different rules-doc path, …) and an optional
// contract label `id`. The CLI resolves the target root and its contract from
// the declaration in one step, so root and contract can never be paired wrong
// by hand — the flag-pair accident class (`--profile` without `--root` silently
// applying a foreign contract to the default vault, 2026-07-07) is structurally
// removed.
//
// Resolution contract (No Silent Fallback):
// - a declaration OWNS its tree's contract; a `--profile` flag that disagrees
//   with the declared contract id is a hard error (never "flag wins").
// - an explicit root WITHOUT a declaration needs an explicit `--profile`
//   (compat for undeclared generic trees); neither → hard error.
// - no root flag at all → the declaration is discovered by walking up from the
//   cwd (bounded by the git toplevel); none found → hard error. There is no
//   default-vault fallback for sync/lint.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { resolveProfile } from "./vault-profile.mjs";

export const VAULT_CONFIG_FILENAME = "vault.config.json";

// Profile fields a declaration may override. Anything else in the file is a
// typo or a schema drift — rejected, never silently ignored.
const BOOLEAN_KEYS = Object.freeze([
  "sidecar",
  "enrich",
  "fts",
  "canonicalChecks",
  "enforcePageFrontmatter",
]);
const STRING_LIST_KEYS = Object.freeze([
  "archiveTreeDirs",
  "rootNonNavFiles",
  "sidecarSourceExtensions",
  // May be `[]`: frontmatter stays enforced while no body section is demanded
  // (heterogeneous knowledge repos — evaluation reports, verbatim originals).
  "genericPageSections",
]);
const OVERRIDABLE_KEYS = Object.freeze([
  ...BOOLEAN_KEYS,
  ...STRING_LIST_KEYS,
  "plansSlotRoot",
  "ownerLocalBucketPrefix",
  "navScope",
  "schema",
]);
const DECLARATION_KEYS = Object.freeze(["id", "profile", ...OVERRIDABLE_KEYS]);

function declarationError(configPath, detail) {
  return new Error(`Invalid vault declaration at ${configPath}: ${detail}`);
}

function validateDeclaration(parsed, configPath) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw declarationError(configPath, "the declaration must be a JSON object.");
  }
  if (typeof parsed.profile !== "string" || !parsed.profile.trim()) {
    throw declarationError(configPath, 'a base contract id is required (e.g. { "profile": "kuma-vault" }).');
  }
  if (parsed.id !== undefined && (typeof parsed.id !== "string" || !parsed.id.trim())) {
    throw declarationError(configPath, '"id" must be a non-empty string when present.');
  }
  const unknown = Object.keys(parsed).filter((key) => !DECLARATION_KEYS.includes(key));
  if (unknown.length > 0) {
    throw declarationError(
      configPath,
      `unknown key(s) ${unknown.join(", ")} (allowed: ${DECLARATION_KEYS.join(", ")}).`,
    );
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in parsed && typeof parsed[key] !== "boolean") {
      throw declarationError(configPath, `"${key}" must be a boolean.`);
    }
  }
  for (const key of STRING_LIST_KEYS) {
    if (key in parsed) {
      const value = parsed[key];
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
        throw declarationError(configPath, `"${key}" must be an array of non-empty strings.`);
      }
    }
  }
  if ("plansSlotRoot" in parsed && parsed.plansSlotRoot !== null && typeof parsed.plansSlotRoot !== "string") {
    throw declarationError(configPath, '"plansSlotRoot" must be a string or null.');
  }
  if ("ownerLocalBucketPrefix" in parsed && (typeof parsed.ownerLocalBucketPrefix !== "string" || !parsed.ownerLocalBucketPrefix)) {
    throw declarationError(configPath, '"ownerLocalBucketPrefix" must be a non-empty string.');
  }
  if ("navScope" in parsed && !["all", "git-tracked"].includes(parsed.navScope)) {
    throw declarationError(configPath, '"navScope" must be "all" or "git-tracked".');
  }
  if ("schema" in parsed) {
    const schema = parsed.schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw declarationError(configPath, '"schema" must be an object.');
    }
    const allowed = ["path", "validateSpecialFiles", "autoScaffold"];
    const bad = Object.keys(schema).filter((key) => !allowed.includes(key));
    if (bad.length > 0) {
      throw declarationError(configPath, `"schema" has unknown key(s) ${bad.join(", ")} (allowed: ${allowed.join(", ")}).`);
    }
    if ("path" in schema && (typeof schema.path !== "string" || !schema.path.trim())) {
      throw declarationError(configPath, '"schema.path" must be a non-empty string.');
    }
    for (const key of ["validateSpecialFiles", "autoScaffold"]) {
      if (key in schema && typeof schema[key] !== "boolean") {
        throw declarationError(configPath, `"schema.${key}" must be a boolean.`);
      }
    }
  }
}

/**
 * Read + validate the declaration at a tree root. Returns the parsed declaration
 * object, or null when the root carries no `vault.config.json`. An unreadable or
 * invalid declaration throws (a broken contract file must never be skipped).
 */
export function loadVaultDeclaration(rootDir) {
  const configPath = join(resolve(rootDir), VAULT_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw declarationError(configPath, error instanceof Error ? error.message : String(error));
  }
  validateDeclaration(parsed, configPath);
  return parsed;
}

function freezeValue(value) {
  if (Array.isArray(value)) return Object.freeze([...value]);
  if (value && typeof value === "object") return Object.freeze({ ...value });
  return value;
}

/**
 * Turn a validated declaration into a concrete contract profile: the declared
 * base built-in profile with the declaration's overrides layered on. `schema`
 * merges shallowly over the base schema; the effective contract id is the
 * declared `id` label (default: the base profile id).
 */
export function resolveDeclaredProfile(declaration) {
  const base = resolveProfile(declaration.profile);
  const overrides = {};
  for (const key of OVERRIDABLE_KEYS) {
    if (!(key in declaration)) continue;
    overrides[key] = key === "schema"
      ? Object.freeze({ ...base.schema, ...declaration.schema })
      : freezeValue(declaration[key]);
  }
  return Object.freeze({ ...base, ...overrides, id: declaration.id ?? base.id });
}

/**
 * Discover the nearest declaration walking up from `startDir`. The walk is
 * bounded by the git toplevel (a declaration outside the repo you are in never
 * applies); outside a git repo it walks to the filesystem root. Returns
 * `{ rootDir, declaration }` or null.
 */
export function discoverVaultDeclaration(startDir = process.cwd()) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, VAULT_CONFIG_FILENAME))) {
      return { rootDir: dir, declaration: loadVaultDeclaration(dir) };
    }
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function assertFlagMatchesDeclaration(flagProfile, resolved, rootDir) {
  if (flagProfile && flagProfile !== resolved.id) {
    throw new Error(
      `--profile ${flagProfile} conflicts with the ${VAULT_CONFIG_FILENAME} declaration at ${rootDir} ` +
      `(declared contract: ${resolved.id}). The declaration owns the contract — drop --profile.`,
    );
  }
}

/**
 * Resolve the sync/lint target (root + contract) for the CLI.
 *
 * - `root` explicit (flag or KUMA_VAULT_DIR): a declaration at that root wins
 *   (a disagreeing `--profile` throws); without one, `--profile` selects an
 *   engine built-in (undeclared-tree compat); neither → throw.
 * - no `root`: discover a declaration walking up from `cwd`; none → throw.
 *
 * Returns `{ vaultDir, profile, source: "declaration" | "flags" }`.
 */
export function resolveVaultContract({ root, profile, cwd = process.cwd(), env = process.env } = {}) {
  const flagProfile = typeof profile === "string" && profile.trim() ? profile.trim() : undefined;
  const explicitRoot = root ?? (env.KUMA_VAULT_DIR || undefined);

  if (explicitRoot) {
    const rootDir = resolve(explicitRoot);
    const declaration = loadVaultDeclaration(rootDir);
    if (declaration) {
      const resolved = resolveDeclaredProfile(declaration);
      assertFlagMatchesDeclaration(flagProfile, resolved, rootDir);
      return { vaultDir: rootDir, profile: resolved, source: "declaration" };
    }
    if (flagProfile) {
      return { vaultDir: rootDir, profile: resolveProfile(flagProfile), source: "flags" };
    }
    throw new Error(
      `No ${VAULT_CONFIG_FILENAME} declaration at ${rootDir} and no --profile given. ` +
      `Add a ${VAULT_CONFIG_FILENAME} to the tree root (preferred), or pass --profile <id> explicitly.`,
    );
  }

  const discovered = discoverVaultDeclaration(cwd);
  if (discovered) {
    const resolved = resolveDeclaredProfile(discovered.declaration);
    assertFlagMatchesDeclaration(flagProfile, resolved, discovered.rootDir);
    return { vaultDir: discovered.rootDir, profile: resolved, source: "declaration" };
  }
  throw new Error(
    `No vault target: no --root/--vault-dir flag, no KUMA_VAULT_DIR, and no ${VAULT_CONFIG_FILENAME} ` +
    `found walking up from ${resolve(cwd)}. Run inside a declared tree, or pass --root <path> --profile <id>.`,
  );
}

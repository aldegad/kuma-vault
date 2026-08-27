// Cross-store registry resolver (`vault-stores.json`).
//
// A cross-store pointer `<store-id>:<relative-path>` names a document that lives
// in a DIFFERENT knowledge tree. The store-id is owned by that tree's own
// `vault.config.json` `id` (SSoT). What this module owns is the machine-local
// `id → root path` mapping: the same logical store lives at a different absolute
// path on every machine, so the mapping is inherently a per-machine concern and
// cannot live in either tree. That registry is the SSoT for "where does store X
// live on THIS machine".
//
// Resolution contract (No Silent Fallback, 원칙 6):
// - registry file ABSENT → this machine has not opted into cross-store checking.
//   Pointers are not resolved; the caller reports the skip explicitly (never a
//   silent pass). Creating the registry is the opt-in.
// - registry PRESENT → strict. An unparseable/ill-shaped file is a loud error,
//   never skipped. A referenced store-id not in the registry is a loud error.
// - a registered store whose root is missing, or whose root declares a different
//   `id`, is a registry-integrity error (원칙 3 Consistency) — the mapping and
//   the tree's own self-declaration must agree.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { loadVaultDeclaration } from "./vault-config.mjs";

export const VAULT_STORES_FILENAME = "vault-stores.json";

// Store-id grammar: lowercase kebab, matching the `id` both real trees declare
// (`kuma-brain`, `acme-ops`). Kept in sync with the pointer parser boundary.
export const STORE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function resolveHomeRelative(rawPath) {
  const value = String(rawPath).trim();
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Absolute path to the store registry for this machine. `KUMA_VAULT_STORES`
 * overrides (tests, non-default layouts); otherwise `$KUMA_HOME_DIR/vault-stores.json`,
 * defaulting to `~/.kuma/vault-stores.json`.
 */
export function resolveStoreRegistryPath(env = process.env) {
  const override = env.KUMA_VAULT_STORES;
  if (typeof override === "string" && override.trim()) {
    return resolve(resolveHomeRelative(override));
  }
  const homeDir = env.HOME ?? homedir() ?? ".";
  const kumaHome = resolve(env.KUMA_HOME_DIR ?? join(homeDir, ".kuma"));
  return join(kumaHome, VAULT_STORES_FILENAME);
}

/**
 * Validate + resolve one declared `id → path` entry against the tree it names.
 * Returns `{ status, rootDir, declaredId?, detail? }` where status is one of
 * `ok` | `root-missing` | `id-mismatch`.
 */
function resolveStoreEntry(storeId, rawPath) {
  const rootDir = resolve(resolveHomeRelative(rawPath));
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    return { status: "root-missing", rootDir };
  }
  let declaration;
  try {
    declaration = loadVaultDeclaration(rootDir);
  } catch (error) {
    return {
      status: "id-mismatch",
      rootDir,
      declaredId: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const declaredId = declaration?.id ?? null;
  if (declaredId !== storeId) {
    return { status: "id-mismatch", rootDir, declaredId };
  }
  return { status: "ok", rootDir, declaredId };
}

/**
 * Load + validate the machine's store registry.
 *
 * Returns `{ present, path, invalid, stores }`:
 * - `present` — the registry file exists.
 * - `invalid` — null, or a human message when the file is present but
 *   unparseable / the wrong shape (a loud error the caller surfaces; pointers
 *   are then not resolvable).
 * - `stores` — Map<store-id, { status, rootDir, declaredId?, detail? }>. Empty
 *   when the file is absent or invalid.
 */
export function loadStoreRegistry(env = process.env) {
  const path = resolveStoreRegistryPath(env);
  if (!existsSync(path)) {
    return { present: false, path, invalid: null, stores: new Map() };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      present: true,
      path,
      invalid: `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      stores: new Map(),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { present: true, path, invalid: "the registry must be a JSON object.", stores: new Map() };
  }
  const rawStores = parsed.stores;
  if (!rawStores || typeof rawStores !== "object" || Array.isArray(rawStores)) {
    return { present: true, path, invalid: 'the registry must have a "stores" object mapping store-id → root path.', stores: new Map() };
  }

  const stores = new Map();
  for (const [storeId, rawPath] of Object.entries(rawStores)) {
    if (!STORE_ID_PATTERN.test(storeId)) {
      return { present: true, path, invalid: `store-id "${storeId}" is not a valid id (lowercase kebab, e.g. "kuma-brain").`, stores: new Map() };
    }
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return { present: true, path, invalid: `store "${storeId}" must map to a non-empty path string.`, stores: new Map() };
    }
    if (!isAbsolute(resolveHomeRelative(rawPath))) {
      return { present: true, path, invalid: `store "${storeId}" path must be absolute (or ~-anchored): ${rawPath}`, stores: new Map() };
    }
    stores.set(storeId, resolveStoreEntry(storeId, rawPath));
  }

  return { present: true, path, invalid: null, stores };
}

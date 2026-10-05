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

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { withFileCommitLock } from "./file-commit-lock.mjs";
import { loadVaultDeclaration } from "./vault-config.mjs";

export const VAULT_STORES_FILENAME = "vault-stores.json";

// Store-id grammar: lowercase kebab, matching the `id` both real trees declare
// (`kuma-brain`, `acme-ops`). Kept in sync with the pointer parser boundary.
export const STORE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export function resolveHomeRelative(rawPath) {
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

// ── Registry v2 (`version: 2`) ───────────────────────────────────────────────
//
// v1 maps `store-id -> root path` (a string). v2 maps `store-id -> entry object`:
//
//   { "root": "/abs/…/vault", "mode": "local" | "remote",
//     "remote": { "server": "http://host:7741", "store": "<server store id>", "tokenFile"?: "/abs" },
//     "lfsCacheMaxGB"?: <number>, "sparse"?: [<path>, …] }
//
// plus an optional top-level `"default": "<store-id>"`. A v1 string value reads as
// `{ root, mode: "local" }`. Writes are always v2 (`vault store …`), never hand edits.
//
// `"search": "local" | "remote"` is a retired key (vault search was removed): a registry that
// still carries it is read, the value is kept so a write round-trips it, and nothing acts on it.
// `vault store list|show` names every entry that has it; `vault store set <id> --clear-search`
// removes it.
export const STORE_REGISTRY_VERSION = 2;
const ENTRY_KEYS = new Set(["root", "mode", "remote", "search", "lfsCacheMaxGB", "sparse"]);
const REMOTE_KEYS = new Set(["server", "store", "tokenFile"]);
const SERVER_STORE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** Validate one raw entry (v1 string or v2 object). Returns the normalized entry or throws. */
export function normalizeStoreEntry(storeId, raw) {
  if (typeof raw === "string") {
    if (!raw.trim()) throw new Error(`store "${storeId}" must map to a non-empty path string.`);
    if (!isAbsolute(resolveHomeRelative(raw))) throw new Error(`store "${storeId}" path must be absolute (or ~-anchored): ${raw}`);
    return { root: raw, mode: "local" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`store "${storeId}" must be a path string (v1) or an entry object (v2).`);
  }
  const unknown = Object.keys(raw).filter((key) => !ENTRY_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`store "${storeId}" has unknown key(s) ${unknown.join(", ")} (allowed: ${[...ENTRY_KEYS].join(", ")}).`);
  if (typeof raw.root !== "string" || !raw.root.trim()) throw new Error(`store "${storeId}" needs a "root" path.`);
  if (!isAbsolute(resolveHomeRelative(raw.root))) throw new Error(`store "${storeId}" root must be absolute (or ~-anchored): ${raw.root}`);
  const mode = raw.mode ?? "local";
  if (mode !== "local" && mode !== "remote") throw new Error(`store "${storeId}" mode must be "local" or "remote".`);
  const entry = { root: raw.root, mode };
  if (mode === "remote") {
    const remote = raw.remote;
    if (!remote || typeof remote !== "object" || Array.isArray(remote)) throw new Error(`store "${storeId}" is remote and needs a "remote" object { server, store }.`);
    const bad = Object.keys(remote).filter((key) => !REMOTE_KEYS.has(key));
    if (bad.length > 0) throw new Error(`store "${storeId}" remote has unknown key(s) ${bad.join(", ")} (allowed: ${[...REMOTE_KEYS].join(", ")}).`);
    let url;
    try {
      url = new URL(String(remote.server ?? ""));
    } catch {
      throw new Error(`store "${storeId}" remote.server must be an http(s) URL.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`store "${storeId}" remote.server must be an http(s) URL.`);
    if (url.username || url.password) throw new Error(`store "${storeId}" remote.server must not carry credentials — use remote.tokenFile.`);
    if (typeof remote.store !== "string" || !SERVER_STORE_ID.test(remote.store)) throw new Error(`store "${storeId}" remote.store must be a server store id.`);
    entry.remote = { server: url.origin + url.pathname.replace(/\/+$/u, ""), store: remote.store };
    if (remote.tokenFile !== undefined) {
      if (typeof remote.tokenFile !== "string" || !isAbsolute(resolveHomeRelative(remote.tokenFile))) {
        throw new Error(`store "${storeId}" remote.tokenFile must be an absolute path.`);
      }
      entry.remote.tokenFile = remote.tokenFile;
    }
  } else if (raw.remote !== undefined) {
    throw new Error(`store "${storeId}" has a "remote" block but mode is "local".`);
  }
  if (raw.search !== undefined) {
    if (raw.search !== "local" && raw.search !== "remote") throw new Error(`store "${storeId}" search must be "local" or "remote".`);
    entry.search = raw.search;
  }
  if (raw.lfsCacheMaxGB !== undefined) {
    if (typeof raw.lfsCacheMaxGB !== "number" || !Number.isFinite(raw.lfsCacheMaxGB) || raw.lfsCacheMaxGB <= 0) {
      throw new Error(`store "${storeId}" lfsCacheMaxGB must be a positive number.`);
    }
    entry.lfsCacheMaxGB = raw.lfsCacheMaxGB;
  }
  if (raw.sparse !== undefined) {
    if (!Array.isArray(raw.sparse) || raw.sparse.some((p) => typeof p !== "string" || !p.trim())) {
      throw new Error(`store "${storeId}" sparse must be a list of non-empty paths.`);
    }
    entry.sparse = [...raw.sparse];
  }
  return entry;
}

/** Parse + validate a registry document. Returns `{ version, default, entries: Map }` or throws. */
export function parseStoreRegistry(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the registry must be a JSON object.");
  const rawStores = parsed.stores;
  if (!rawStores || typeof rawStores !== "object" || Array.isArray(rawStores)) {
    throw new Error('the registry must have a "stores" object mapping store-id → root path.');
  }
  const version = parsed.version ?? 1;
  if (version !== 1 && version !== STORE_REGISTRY_VERSION) throw new Error(`unsupported registry version ${JSON.stringify(parsed.version)} (1 or 2).`);
  const unknownTop = Object.keys(parsed).filter((key) => !["version", "default", "stores"].includes(key));
  if (unknownTop.length > 0) throw new Error(`unknown top-level key(s) ${unknownTop.join(", ")} (allowed: version, default, stores).`);
  const entries = new Map();
  for (const [storeId, raw] of Object.entries(rawStores)) {
    if (!STORE_ID_PATTERN.test(storeId)) throw new Error(`store-id "${storeId}" is not a valid id (lowercase kebab, e.g. "kuma-brain").`);
    if (version === 1 && typeof raw !== "string") throw new Error(`store "${storeId}" must map to a non-empty path string.`);
    entries.set(storeId, normalizeStoreEntry(storeId, raw));
  }
  const defaultId = parsed.default ?? null;
  if (defaultId !== null && (typeof defaultId !== "string" || !entries.has(defaultId))) {
    throw new Error(`"default" names store "${defaultId}" which is not in "stores".`);
  }
  return { version, default: defaultId, entries };
}

/**
 * Load + validate the machine's store registry.
 *
 * Returns `{ present, path, invalid, version, default, stores }`:
 * - `present` — the registry file exists.
 * - `invalid` — null, or a human message when the file is present but
 *   unparseable / the wrong shape (a loud error the caller surfaces; pointers
 *   are then not resolvable).
 * - `stores` — Map<store-id, { status, rootDir, declaredId?, detail?, mode,
 *   remote?, search? (retired, ignored), lfsCacheMaxGB?, sparse? }>. Empty when the file is absent or invalid.
 */
export function loadStoreRegistry(env = process.env) {
  const path = resolveStoreRegistryPath(env);
  const empty = { present: false, path, invalid: null, version: null, default: null, stores: new Map() };
  if (!existsSync(path)) return empty;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ...empty, present: true, invalid: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  let registry;
  try {
    registry = parseStoreRegistry(parsed);
  } catch (error) {
    return { ...empty, present: true, invalid: error.message };
  }
  const stores = new Map();
  for (const [storeId, entry] of registry.entries) {
    const { root, ...rest } = entry;
    stores.set(storeId, { ...resolveStoreEntry(storeId, root), ...rest });
  }
  return { present: true, path, invalid: null, version: registry.version, default: registry.default, stores };
}

/** The registered store whose root is `rootDir` (realpath compare), or null. */
export function findStoreByRoot(registry, rootDir) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const target = real(rootDir);
  for (const [id, entry] of registry.stores) {
    if (real(entry.rootDir) === target) return { id, entry };
  }
  return null;
}

// ── Writer (`vault store add|set|rename|rm`) ─────────────────────────────────

function readRawRegistry(path) {
  if (!existsSync(path)) return { version: STORE_REGISTRY_VERSION, stores: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  parseStoreRegistry(parsed); // a broken file is never silently rewritten
  return parsed;
}

function toV2(parsed) {
  const stores = {};
  for (const [id, raw] of Object.entries(parsed.stores ?? {})) {
    stores[id] = normalizeStoreEntry(id, raw);
  }
  return { version: STORE_REGISTRY_VERSION, ...(parsed.default ? { default: parsed.default } : {}), stores };
}

/**
 * Read-modify-write the registry under the file-commit lock. `mutate(doc)` receives the v2
 * document and returns the next one (validated before it is written; temp file + rename).
 */
export function updateStoreRegistry(mutate, env = process.env) {
  const path = resolveStoreRegistryPath(env);
  const outcome = withFileCommitLock(path, () => {
    const current = toV2(readRawRegistry(path));
    const next = mutate(structuredClone(current));
    parseStoreRegistry(next);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return next;
  });
  if (!outcome.locked) throw new Error(`store registry ${path} is locked by ${outcome.holder} (${outcome.lockPath})`);
  return { path, registry: outcome.value };
}

// `server.json` — the one config file of `vault serve` (docs/server.md).
//
// Listen addresses, stores and their ACLs, disk reserve, the server-side `binaries.reject`
// list (rule 7 reads it here, never from the pushed tree), and token verifiers. Token VALUES
// live in the vault `_credentials` (custody SSoT); this file keeps only their sha256, so the
// file (0600, owner kuma-vault) and its backups never hold a usable secret.
//
// Validation is strict: an unknown key or a wrong type is an error, not a silent default.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync, rmSync, statSync, chownSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { compileGitignore } from "./gitignore-match.mjs";

export const DEFAULT_SERVER_CONFIG_PATH = "/etc/kuma-vault/server.json";
export const DEFAULT_PORT = 7741;
export const ROLE_LEVEL = Object.freeze({ none: 0, reader: 1, writer: 2, owner: 3, admin: 4 });
const TOKEN_ROLES = new Set(["reader", "writer", "admin"]);
const STORE_KINDS = new Set(["vault", "workspace"]);
const AUTH_MODES = new Set(["tailscale", "token"]);
const STORE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOKEN_ID = /^[A-Za-z0-9._-]{1,64}$/;

const TOP_KEYS = new Set([
  "version", "listen", "dataDir", "diskReserveGB", "diskWarnGB", "maxNonLfsBlobBytes",
  "warnNonLfsBlobBytes", "growthAlert", "junkPatterns", "auth", "tokens", "stores", "backup",
]);
const AUTH_KEYS = new Set(["mode", "tailscaleBin", "whoisCacheSeconds", "selfAddresses"]);
const GROWTH_KEYS = new Set(["windowDays", "thresholdGB"]);
const TOKEN_KEYS = new Set(["id", "sha256", "role", "stores", "note"]);
const STORE_KEYS = new Set(["path", "kind", "owners", "writers", "readers", "binaries", "encryption"]);
const BINARIES_KEYS = new Set(["reject"]);
const BACKUP_KEYS = new Set(["repository", "host", "stores", "credentialsDir", "keep", "drill", "preCutover", "retryLock"]);
const BACKUP_KEEP_KEYS = new Set(["daily", "weekly", "monthly"]);
const BACKUP_DRILL_KEYS = new Set(["text", "cas"]);
const BACKUP_PRE_CUTOVER_KEYS = new Set(["tag", "retentionDays", "clockStartedAt"]);
export const DEFAULT_BACKUP_CREDENTIALS_DIR = "/etc/kuma-vault/credentials";
const RESTIC_TAG = /^[A-Za-z0-9._-]{1,64}$/;
const RESTIC_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(where, message) {
  throw new Error(`server.json ${where}: ${message}`);
}

function checkKeys(obj, allowed, where) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) fail(where, "must be an object");
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(where, `unknown key "${key}"`);
  }
}

function checkNumber(value, where, { min = 0, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    fail(where, `must be a ${integer ? "whole " : ""}number >= ${min}`);
  }
  return value;
}

function checkStringList(value, where) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    fail(where, "must be a list of non-empty strings");
  }
  return value;
}

export function parseListenAddress(entry) {
  const match = /^(\[[0-9a-fA-F:.]+\]|[0-9.]+):(\d{1,5})$/.exec(entry);
  if (!match) throw new Error(`server.json listen: "${entry}" must be <ipv4>:<port> or [<ipv6>]:<port>`);
  const port = Number(match[2]);
  if (port > 65535) throw new Error(`server.json listen: bad port in "${entry}"`); // 0 = any free port (tests)
  return { host: match[1].replace(/^\[|\]$/g, ""), port };
}

/** Apply defaults and validate. Returns a new normalized config object. */
export function normalizeServerConfig(raw) {
  checkKeys(raw, TOP_KEYS, "(top level)");
  if (raw.version !== 1) fail("version", "must be 1");
  const listen = checkStringList(raw.listen ?? [], "listen");
  if (listen.length === 0) fail("listen", "needs at least one address");
  listen.forEach(parseListenAddress);
  const dataDir = raw.dataDir ?? "/data/vaults";
  if (typeof dataDir !== "string" || !isAbsolute(dataDir)) fail("dataDir", "must be an absolute path");

  const growth = raw.growthAlert ?? {};
  checkKeys(growth, GROWTH_KEYS, "growthAlert");
  const auth = raw.auth ?? {};
  checkKeys(auth, AUTH_KEYS, "auth");
  const authMode = auth.mode ?? "tailscale";
  if (!AUTH_MODES.has(authMode)) fail("auth.mode", `must be one of ${[...AUTH_MODES].join("|")}`);

  const config = {
    version: 1,
    listen,
    dataDir,
    diskReserveGB: checkNumber(raw.diskReserveGB ?? 8, "diskReserveGB"),
    diskWarnGB: checkNumber(raw.diskWarnGB ?? 20, "diskWarnGB"),
    maxNonLfsBlobBytes: checkNumber(raw.maxNonLfsBlobBytes ?? 32 * 1024 * 1024, "maxNonLfsBlobBytes", { min: 1, integer: true }),
    warnNonLfsBlobBytes: checkNumber(raw.warnNonLfsBlobBytes ?? 10 * 1024 * 1024, "warnNonLfsBlobBytes", { min: 1, integer: true }),
    growthAlert: {
      windowDays: checkNumber(growth.windowDays ?? 7, "growthAlert.windowDays", { min: 1 }),
      thresholdGB: checkNumber(growth.thresholdGB ?? 5, "growthAlert.thresholdGB"),
    },
    junkPatterns: raw.junkPatterns == null ? null : checkStringList(raw.junkPatterns, "junkPatterns"),
    auth: {
      mode: authMode,
      tailscaleBin: auth.tailscaleBin ?? "tailscale",
      whoisCacheSeconds: checkNumber(auth.whoisCacheSeconds ?? 60, "auth.whoisCacheSeconds"),
      selfAddresses: checkStringList(auth.selfAddresses ?? [], "auth.selfAddresses"),
    },
    tokens: [],
    stores: {},
  };
  if (config.junkPatterns) compileGitignore(config.junkPatterns);

  const tokens = raw.tokens ?? [];
  if (!Array.isArray(tokens)) fail("tokens", "must be a list");
  const tokenIds = new Set();
  tokens.forEach((token, index) => {
    const where = `tokens[${index}]`;
    checkKeys(token, TOKEN_KEYS, where);
    if (typeof token.id !== "string" || !TOKEN_ID.test(token.id)) fail(`${where}.id`, "must match [A-Za-z0-9._-]{1,64}");
    if (tokenIds.has(token.id)) fail(`${where}.id`, `duplicate id "${token.id}"`);
    tokenIds.add(token.id);
    if (typeof token.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(token.sha256)) fail(`${where}.sha256`, "must be 64 lower-case hex");
    if (!TOKEN_ROLES.has(token.role)) fail(`${where}.role`, `must be one of ${[...TOKEN_ROLES].join("|")}`);
    const stores = checkStringList(token.stores ?? [], `${where}.stores`);
    if (stores.length === 0) fail(`${where}.stores`, "needs at least one store id (or \"*\")");
    config.tokens.push({ id: token.id, sha256: token.sha256, role: token.role, stores, ...(token.note ? { note: String(token.note) } : {}) });
  });

  const stores = raw.stores ?? {};
  checkKeys(stores, new Set(Object.keys(stores)), "stores");
  for (const [id, store] of Object.entries(stores)) {
    const where = `stores.${id}`;
    if (!STORE_ID.test(id) || id.endsWith(".git")) fail(where, "store id must match [a-z0-9][a-z0-9._-]{0,63} and not end in .git");
    checkKeys(store, STORE_KEYS, where);
    const kind = store.kind ?? "vault";
    if (!STORE_KINDS.has(kind)) fail(`${where}.kind`, `must be one of ${[...STORE_KINDS].join("|")}`);
    const path = store.path ?? join(dataDir, id);
    if (typeof path !== "string" || !isAbsolute(path)) fail(`${where}.path`, "must be an absolute path");
    const binaries = store.binaries ?? {};
    checkKeys(binaries, BINARIES_KEYS, `${where}.binaries`);
    const reject = checkStringList(binaries.reject ?? [], `${where}.binaries.reject`);
    compileGitignore(reject);
    if (store.encryption !== undefined && store.encryption !== null) fail(`${where}.encryption`, "only null is supported (slot reserved for at-rest encryption)");
    config.stores[id] = {
      path,
      kind,
      owners: checkStringList(store.owners ?? [], `${where}.owners`),
      writers: checkStringList(store.writers ?? [], `${where}.writers`),
      readers: checkStringList(store.readers ?? [], `${where}.readers`),
      binaries: { reject },
      encryption: null,
    };
  }
  for (const token of config.tokens) {
    for (const storeId of token.stores) {
      if (storeId !== "*" && !config.stores[storeId]) fail(`tokens.${token.id}.stores`, `unknown store "${storeId}"`);
    }
  }
  if (raw.backup !== undefined && raw.backup !== null) config.backup = normalizeBackup(raw.backup, config);
  return config;
}

/**
 * The `backup` block (docs/server.md "Backup"). Absent = backups are not configured: the timer
 * stays disabled and `vault server backup` refuses to run. Every snapshot this server writes is
 * `--host <host>`; forget only ever touches that host's groups. The host is required here, with
 * no default: it is the group forget, drill and restore select by, so it must not move when the
 * machine is renamed. `vault server backup configure` writes it once (this machine's hostname
 * unless `--host` names one).
 */
function normalizeBackup(raw, config) {
  checkKeys(raw, BACKUP_KEYS, "backup");
  if (typeof raw.repository !== "string" || !raw.repository.trim()) fail("backup.repository", "required (restic repository, e.g. s3:https://<endpoint>/<bucket>)");
  const host = raw.host;
  if (host === undefined || host === null) fail("backup.host", "required (the restic --host of this server's snapshots; `vault server backup configure` writes it)");
  if (typeof host !== "string" || !RESTIC_HOST.test(host)) fail("backup.host", "must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  const stores = raw.stores == null ? null : checkStringList(raw.stores, "backup.stores");
  for (const id of stores ?? []) {
    if (!config.stores[id]) fail("backup.stores", `unknown store "${id}"`);
  }
  const credentialsDir = raw.credentialsDir ?? DEFAULT_BACKUP_CREDENTIALS_DIR;
  if (typeof credentialsDir !== "string" || !isAbsolute(credentialsDir)) fail("backup.credentialsDir", "must be an absolute path");
  const keep = raw.keep ?? {};
  checkKeys(keep, BACKUP_KEEP_KEYS, "backup.keep");
  const drill = raw.drill ?? {};
  checkKeys(drill, BACKUP_DRILL_KEYS, "backup.drill");
  const pre = raw.preCutover ?? {};
  checkKeys(pre, BACKUP_PRE_CUTOVER_KEYS, "backup.preCutover");
  const tag = pre.tag ?? "pre-cutover";
  if (typeof tag !== "string" || !RESTIC_TAG.test(tag)) fail("backup.preCutover.tag", "must match [A-Za-z0-9._-]{1,64}");
  const clockStartedAt = pre.clockStartedAt ?? null;
  if (clockStartedAt !== null && (typeof clockStartedAt !== "string" || !/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(clockStartedAt) || Number.isNaN(Date.parse(clockStartedAt)))) {
    fail("backup.preCutover.clockStartedAt", "must be null or an ISO date-time with an offset");
  }
  const retryLock = raw.retryLock ?? "2h";
  if (typeof retryLock !== "string" || !/^\d+[smh]$/.test(retryLock)) fail("backup.retryLock", 'must look like "30m" or "2h"');
  const keepPolicy = {
    daily: checkNumber(keep.daily ?? 14, "backup.keep.daily", { integer: true }),
    weekly: checkNumber(keep.weekly ?? 8, "backup.keep.weekly", { integer: true }),
    monthly: checkNumber(keep.monthly ?? 12, "backup.keep.monthly", { integer: true }),
  };
  // an all-zero policy would let forget remove every snapshot of the group
  if (keepPolicy.daily + keepPolicy.weekly + keepPolicy.monthly === 0) fail("backup.keep", "needs at least one non-zero keep count");
  return {
    repository: raw.repository.trim(),
    host,
    stores,
    credentialsDir,
    keep: keepPolicy,
    drill: {
      text: checkNumber(drill.text ?? 50, "backup.drill.text", { integer: true }),
      cas: checkNumber(drill.cas ?? 50, "backup.drill.cas", { integer: true }),
    },
    preCutover: {
      tag,
      retentionDays: checkNumber(pre.retentionDays ?? 14, "backup.preCutover.retentionDays", { integer: true }),
      clockStartedAt,
    },
    retryLock,
  };
}

export function loadServerConfig(path = DEFAULT_SERVER_CONFIG_PATH) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read server config ${path}: ${error.message}`, { cause: error });
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`server config ${path} is not valid JSON: ${error.message}`, { cause: error });
  }
  return normalizeServerConfig(raw);
}

/** Atomic write, mode 0600, keeping the previous file's owner when it existed. */
export function writeServerConfig(path, config) {
  const normalized = normalizeServerConfig(config);
  let owner = null;
  try {
    const st = statSync(path);
    owner = { uid: st.uid, gid: st.gid };
  } catch {
    owner = null;
  }
  const temp = join(dirname(path), `.server.json.${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    if (owner && process.getuid?.() === 0) chownSync(temp, owner.uid, owner.gid);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return normalized;
}

/**
 * `config` without store `id`, for `vault server store rm`: the store entry goes, a token
 * scoped to it loses that scope (and goes when nothing is left), `backup.stores` drops it.
 * `*` tokens and every other store are left as they are. Pure; the caller writes the result.
 */
export function withoutStore(config, id) {
  if (!config.stores[id]) throw new Error(`no store ${id}`);
  const stores = { ...config.stores };
  delete stores[id];
  const removedTokens = [];
  const narrowedTokens = [];
  const tokens = [];
  for (const token of config.tokens) {
    if (!token.stores.includes(id)) {
      tokens.push(token);
      continue;
    }
    const left = token.stores.filter((s) => s !== id);
    if (left.length === 0) {
      removedTokens.push(token.id);
      continue;
    }
    narrowedTokens.push(token.id);
    tokens.push({ ...token, stores: left });
  }
  let backup = config.backup;
  const backupListed = Boolean(backup?.stores?.includes(id));
  if (backupListed) backup = { ...backup, stores: backup.stores.filter((s) => s !== id) };
  return {
    config: { ...config, stores, tokens, ...(backup ? { backup } : {}) },
    removedTokens,
    narrowedTokens,
    backupListed,
  };
}

// --- tokens ---

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function generateToken() {
  return `kv_${randomBytes(32).toString("base64url")}`;
}

/** Find the token entry whose verifier matches `raw` (constant-time per entry), or null. */
export function findToken(config, raw) {
  if (typeof raw !== "string" || !raw) return null;
  const digest = Buffer.from(hashToken(raw), "hex");
  let found = null;
  for (const token of config.tokens) {
    if (timingSafeEqual(digest, Buffer.from(token.sha256, "hex"))) found = token;
  }
  return found;
}

// --- authorization ---

/**
 * Role a principal holds on one store. Principals: `{ kind: "token", token }` or
 * `{ kind: "user", login }` / `{ kind: "node", name }` (tailnet identity, ACL entry `node:<name>`).
 */
export function storeRole(config, storeId, principal) {
  const store = config.stores[storeId];
  if (!store || !principal) return ROLE_LEVEL.none;
  if (principal.kind === "token") {
    const token = principal.token;
    if (!token.stores.includes("*") && !token.stores.includes(storeId)) return ROLE_LEVEL.none;
    return ROLE_LEVEL[token.role];
  }
  const name = principal.kind === "node" ? `node:${principal.name}` : principal.login;
  if (store.owners.includes(name)) return ROLE_LEVEL.owner;
  if (store.writers.includes(name)) return ROLE_LEVEL.writer;
  if (store.readers.includes(name)) return ROLE_LEVEL.reader;
  return ROLE_LEVEL.none;
}

export function roleName(level) {
  return Object.keys(ROLE_LEVEL).find((key) => ROLE_LEVEL[key] === level) ?? "none";
}

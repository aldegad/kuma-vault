// Where one synced clone keeps what: its repo, the declared tree inside it, the server it talks
// to, the daemon's state file, lock and pause flag, and the tunables.
//
// Everything is read from the clone itself (`remote.origin.url`, `kuma-vault.*` git config set
// by `vault clone`) so the daemon needs no other registry. Tunables have the design's values
// and may be overridden per clone with `git config kuma-vault.<key> <value>` (tests do).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileGitignore } from "../server/gitignore-match.mjs";
import { DEFAULT_JUNK_PATTERNS } from "../server/lfs-paths.mjs";
import { git, gitText } from "./git.mjs";

export const VAULT_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vault");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// [git config key, settings name, default, unit multiplier]
export const TUNABLES = [
  ["quietseconds", "quietMs", 120, SECOND], // autosave: a path untouched this long is collected
  ["textforceseconds", "textForceMs", 600, SECOND], // text still changing after this is saved anyway
  ["futuremtimeseconds", "futureMtimeMs", 5 * 60, SECOND], // an mtime this far ahead is a wrong clock, not a write
  ["gateretryseconds", "gateRetryMs", 600, SECOND], // a blocked autosave is retried after this
  ["maxnonlfsbytes", "maxNonLfsBytes", 32 * 1024 * 1024, 1], // receive rule 4
  ["uncollectedageseconds", "uncollectedAgeMs", 30 * 60, SECOND],
  ["uncollectedalarmseconds", "uncollectedAlarmMs", 60 * 60, SECOND],
  ["ignoredscanseconds", "ignoredScanMs", 60 * 60, SECOND],
  ["ignoredoutsidebytes", "ignoredOutsideBytes", 100e6, 1],
  ["rejectresiduebytes", "rejectResidueBytes", 5e9, 1],
  ["rejectresidueageseconds", "rejectResidueAgeMs", 7 * 24 * 60 * 60, SECOND],
  ["growthbytes", "growthBytes", 1e9, 1], // growth: LFS bytes autosaved within the window
  ["growthfiles", "growthFiles", 500, 1], // growth: binaries autosaved within the window
  ["growthwindowseconds", "growthWindowMs", 24 * 60 * 60, SECOND],
  ["timerseconds", "timerMs", 60, SECOND],
  ["debounceseconds", "debounceMs", 2, SECOND],
  ["evictseconds", "evictMs", 60 * 60, SECOND],
  ["evictidleseconds", "evictIdleMs", 7 * 24 * 60 * 60, SECOND],
  ["lfscachemaxgb", "lfsCacheMaxBytes", 10, 1e9 * 1.073741824], // GiB, as the design's 10737418240
  ["unpushedwarnseconds", "unpushedWarnMs", 24 * 60 * 60, SECOND],
  ["stalelockseconds", "staleLockMs", 10 * 60, SECOND], // a git lock this old with no git running is removed
];

export const BACKOFF_MS = Object.freeze([2 * SECOND, 5 * SECOND, 15 * SECOND, MINUTE, 5 * MINUTE]);
export { SECOND, MINUTE, HOUR, DAY };

export function syncStateDir(env = process.env) {
  return env.KUMA_VAULT_SYNC_DIR ?? join(env.HOME ?? homedir(), ".kuma-vault", "sync");
}

export function shortHost() {
  return (hostname().split(".")[0] || "host").replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
}

/** `http://h:p/v1/stores/<id>.git` -> `{ serverBase: "http://h:p", store: "<id>" }`, or null. */
export function parseStoreUrl(url) {
  const match = /^(https?:\/\/[^/]+)\/v1\/stores\/([a-z0-9][a-z0-9._-]{0,63})\.git\/?$/.exec(String(url ?? "").trim());
  if (!match) return null;
  return { serverBase: match[1], store: match[2] };
}

async function readClonedConfig(repo) {
  const result = await git(["config", "--local", "--get-regexp", "^kuma-vault\\."], { cwd: repo, allowFail: true });
  const map = new Map();
  for (const line of result.stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    const key = (space < 0 ? line : line.slice(0, space)).slice("kuma-vault.".length).toLowerCase();
    map.set(key, space < 0 ? "" : line.slice(space + 1));
  }
  return map;
}

/** Read `binaries.reject` from the tree's vault.config.json (tree-relative gitignore globs). */
export function readRejectPatterns(treeAbs) {
  const path = join(treeAbs, "vault.config.json");
  if (!existsSync(path)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`vault.config.json at ${treeAbs} is not valid JSON: ${error.message}`, { cause: error });
  }
  const list = parsed?.binaries?.reject ?? [];
  if (!Array.isArray(list) || list.some((p) => typeof p !== "string")) {
    throw new Error(`vault.config.json binaries.reject at ${treeAbs} must be a list of strings`);
  }
  return list;
}

/**
 * Resolve the sync context of the clone that contains `start` (a path inside it).
 * Throws when `start` is not inside a git work tree or the clone has no origin.
 */
export async function loadContext(start, { env = process.env } = {}) {
  const top = await gitText(["rev-parse", "--show-toplevel"], { cwd: start }).catch(() => null);
  if (!top) throw new Error(`${start} is not inside a git work tree`);
  const gitDirRaw = await gitText(["rev-parse", "--git-dir"], { cwd: top });
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(top, gitDirRaw);
  const remoteUrl = await gitText(["config", "--get", "remote.origin.url"], { cwd: top }).catch(() => "");
  if (!remoteUrl) throw new Error(`${top} has no remote "origin" — not a synced clone (vault clone makes one)`);
  const cfg = await readClonedConfig(top);
  const parsed = parseStoreUrl(remoteUrl);
  const store = cfg.get("store") || parsed?.store;
  if (!store) throw new Error(`${top}: cannot tell the store id — set git config kuma-vault.store <id>`);

  let treeRel = cfg.get("tree");
  if (treeRel === undefined) {
    treeRel = existsSync(join(top, "vault", "vault.config.json")) ? "vault" : "";
  }
  treeRel = treeRel.replace(/^\/+|\/+$/g, "");
  const treeAbs = treeRel ? join(top, treeRel) : top;

  const settings = {};
  for (const [key, name, fallback, unit] of TUNABLES) {
    const raw = cfg.get(key);
    const value = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`git config kuma-vault.${key} must be a number >= 0 (got "${raw}")`);
    settings[name] = value * unit;
  }

  const stateDir = syncStateDir(env);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const junkPatterns = DEFAULT_JUNK_PATTERNS;
  return {
    repo: top,
    gitDir,
    store,
    treeRel,
    treeAbs,
    remoteUrl,
    serverBase: parsed?.serverBase ?? null,
    apiBase: parsed ? `${parsed.serverBase}/v1/stores/${parsed.store}` : null,
    host: cfg.get("host") || shortHost(), // kuma-vault.host: two clones on one machine (tests)
    stateDir,
    statusPath: join(stateDir, `${store}.json`),
    logPath: join(stateDir, `${store}.log`),
    lockPath: join(gitDir, "vault-syncd.lock"),
    pausePath: join(gitDir, "vault-syncd.paused"),
    privateDir: join(gitDir, "kuma-vault"),
    settings,
    vaultBin: env.KUMA_VAULT_BIN ?? VAULT_BIN,
    junkPatterns,
    junk: compileGitignore(junkPatterns, { ignoreCase: true }),
    /** Tree-relative path of a repo-relative path, or null when it lies outside the tree. */
    treePath(repoPath) {
      if (!treeRel) return repoPath;
      return repoPath.startsWith(`${treeRel}/`) ? repoPath.slice(treeRel.length + 1) : null;
    },
    /** Repo-relative path of an absolute or cwd-relative path. */
    repoPath(path, cwd = process.cwd()) {
      const rel = relative(top, resolve(cwd, path)).split("\\").join("/");
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside the clone ${top}`);
      return rel;
    },
  };
}

/** Matcher for the tree's reject places, re-read each call (the declaration may change). */
export function rejectMatcher(ctx) {
  const patterns = readRejectPatterns(ctx.treeAbs);
  const match = compileGitignore(patterns, { ignoreCase: true });
  return {
    patterns,
    match(repoPath) {
      const treePath = ctx.treePath(repoPath);
      return treePath === null ? null : match(treePath);
    },
  };
}

#!/usr/bin/env node
// Server-side CLI: `vault serve` and `vault server <verb>` (docs/server.md).
//
// Kept apart from src/cli/cli.mjs on purpose: the server needs no node_modules (node built-ins
// only); nothing here reaches the sidecar extractors or other npm dependencies.

import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { parseFlags } from "../cli/cli-options.mjs";
import { postReceive } from "./post-receive.mjs";
import { appendReceiveLog, checkReceive, parseRefUpdates, resolveHookStore } from "./receive-check.mjs";
import { DEFAULT_SERVER_CONFIG_PATH, generateToken, hashToken, loadServerConfig, withoutStore, writeServerConfig } from "./server-config.mjs";
import { startServe } from "./serve.mjs";
import { storePaths } from "./store-layout.mjs";
import { anchorPatternsToTree } from "./gitignore-match.mjs";
import { initServedStore, requireStoreOwnable, serveUserIds } from "./install.mjs";

const USAGE = `Usage:
  vault serve [--config <server.json>]
  vault server install [--store <id,...>] [--owner <login,...>] [--auth tailscale|token] [--listen <ip:port,...>]
                      [--data-dir <dir>] [--config <path>] [--no-start]
  vault server init-store <id> [--owner <login,...>] [--config <path>]
  vault server store list [--config <path>]
  vault server store rm <id> [--keep-data | --purge --confirm <id>] [--config <path>]
                                 (also drops tokens scoped only to it; --keep-data is the default)
  vault server token add --id <id> --store <id|*> --role reader|writer|admin [--note <text>] [--config <path>]
  vault server token list|rm --id <id> [--config <path>]
  vault server set-reject --store <id> --from <binaries-reject.json> [--tree-prefix <dir>] [--config <path>]
                                 (--tree-prefix: the list is relative to that tree, e.g. vault)
  vault server backup <verb> ...  (restic offsite backup — vault server backup --help)
  vault server receive-check     (pre-receive hook)
  vault server post-receive      (post-receive hook)
`;

function configPathOf(options) {
  return options.config ?? process.env.KUMA_VAULT_SERVER_CONFIG ?? DEFAULT_SERVER_CONFIG_PATH;
}

function listOption(value) {
  if (value === undefined || value === true) return [];
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function vaultBinPath() {
  return process.env.KUMA_VAULT_BIN ?? resolve(new URL("../../bin/vault", import.meta.url).pathname);
}

async function commandReceiveCheck() {
  const env = process.env;
  let config;
  try {
    config = loadServerConfig(env.KUMA_VAULT_SERVER_CONFIG || DEFAULT_SERVER_CONFIG_PATH);
  } catch (error) {
    process.stderr.write(`kuma-vault: 서버 설정을 읽지 못해 push 를 받지 않습니다: ${error.message}\n`);
    return 1;
  }
  const { storeId, gitDir } = resolveHookStore(config, env, process.cwd());
  const role = env.KUMA_VAULT_PUSH_ROLE || "writer";
  const updates = parseRefUpdates(await readStdin());
  const started = Date.now();
  const result = await checkReceive({ config, storeId, role, gitDir, updates });
  appendReceiveLog(config.stores[storeId].path, {
    ts: new Date().toISOString(),
    pusher: env.KUMA_VAULT_PUSHER ?? "local",
    role,
    refs: updates.map((u) => ({ ref: u.ref, old: u.oldSha, new: u.newSha })),
    commits: result.commits,
    accepted: result.violations.length === 0,
    violations: result.violations,
    warnings: result.warnings,
    ms: Date.now() - started,
  });
  for (const warning of result.warnings) process.stderr.write(`kuma-vault 경고 [규칙 ${warning.rule}] ${warning.message}\n`);
  if (result.violations.length === 0) return 0;
  process.stderr.write(`kuma-vault: push 를 받지 않습니다 (규칙 위반 ${result.violations.length}건)\n`);
  for (const v of result.violations.slice(0, 50)) process.stderr.write(`[규칙 ${v.rule}] ${v.message}\n`);
  if (result.violations.length > 50) process.stderr.write(`... 외 ${result.violations.length - 50}건\n`);
  return 1;
}

async function commandPostReceive() {
  const config = loadServerConfig(process.env.KUMA_VAULT_SERVER_CONFIG || DEFAULT_SERVER_CONFIG_PATH);
  const { storeId } = resolveHookStore(config, process.env, process.cwd());
  const updates = parseRefUpdates(await readStdin());
  const storeRoot = config.stores[storeId].path;
  try {
    const { credentialModes } = await postReceive({ storeRoot, updates });
    if (!credentialModes?.failedCount) return 0;
    // the push is in; tree/ keeps secrets the group or others can read until someone fixes it
    appendReceiveLog(storeRoot, { ts: new Date().toISOString(), event: "credential-modes", failed: credentialModes.failed });
    process.stderr.write(`kuma-vault 경고: tree/ 의 자격증명 경로 ${credentialModes.failedCount}개를 0600/0700 으로 맞추지 못했습니다\n`);
    for (const f of credentialModes.failed.slice(0, 20)) process.stderr.write(`  ${f.path} ${f.mode ?? "?"} -> ${f.want ?? "?"} (${f.error})\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`kuma-vault post-receive: ${error.message}\n`);
    return 1;
  }
}

/** `owner` is the serve user's ids unless a test passes its own (docs/server.md, Install). */
export async function commandInitStore(options, { owner = serveUserIds(), vaultBin = vaultBinPath() } = {}) {
  const id = options._[0];
  if (!id) throw new Error("vault server init-store <id>");
  requireStoreOwnable(owner); // before server.json gains the store
  const configPath = configPathOf(options);
  let config = loadServerConfig(configPath);
  if (!config.stores[id]) {
    config = writeServerConfig(configPath, {
      ...config,
      stores: { ...config.stores, [id]: { kind: "vault", owners: listOption(options.owner), writers: [], readers: [], binaries: { reject: [] }, encryption: null } },
    });
  }
  const paths = await initServedStore(config.stores[id].path, { vaultBin, owner });
  process.stdout.write(`store ${id}: ${paths.root}\n`);
}

function commandToken(options) {
  const action = options._[0];
  const configPath = configPathOf(options);
  const config = loadServerConfig(configPath);
  if (action === "list") {
    for (const t of config.tokens) process.stdout.write(`${t.id}\t${t.role}\t${t.stores.join(",")}\t${t.note ?? ""}\n`);
    return;
  }
  const id = options.id;
  if (typeof id !== "string") throw new Error("--id <token id> required");
  if (action === "rm") {
    if (!config.tokens.some((t) => t.id === id)) throw new Error(`no token ${id}`);
    writeServerConfig(configPath, { ...config, tokens: config.tokens.filter((t) => t.id !== id) });
    process.stdout.write(`removed token ${id}\n`);
    return;
  }
  if (action !== "add") throw new Error("vault server token add|list|rm");
  if (config.tokens.some((t) => t.id === id)) throw new Error(`token ${id} exists — rm it first (a token value is shown only once)`);
  const token = generateToken();
  writeServerConfig(configPath, {
    ...config,
    tokens: [...config.tokens, { id, sha256: hashToken(token), role: options.role, stores: listOption(options.store), ...(typeof options.note === "string" ? { note: options.note } : {}) }],
  });
  // The value is printed once, to stdout only. Record it in the vault `_credentials` first (custody).
  process.stdout.write(`${token}\n`);
  process.stderr.write(`token ${id} added (${options.role} on ${options.store}). Store the value in the vault _credentials now — the server keeps only its sha256.\n`);
}

/**
 * `path` with every symlink resolved, as segments. A tail that does not exist yet is resolved
 * through its nearest existing ancestor, so two spellings of one directory compare equal.
 */
function canonicalSegments(path) {
  let head = resolve(path);
  const tail = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  return [...realpathSync.native(head).split(sep), ...tail].filter(Boolean);
}

/** True when `inner` is `outer` or lies under it, compared segment by segment (`a` is not under `ab`). */
function sameOrUnder(outer, inner) {
  return outer.length <= inner.length && outer.every((segment, i) => segment === inner[i]);
}

/**
 * The store's own directory, safe to delete: strictly inside dataDir, laid out as a store, and
 * sharing no directory with a store that stays (the same path, one inside it, or one around it).
 * Judged on the real path, and `realDir` is what gets deleted: a store path that is a symlink
 * names its target's data, not the link.
 */
function purgeableStoreDir(config, id) {
  const dataDir = canonicalSegments(config.dataDir);
  const abs = resolve(config.stores[id].path);
  const own = canonicalSegments(abs);
  if (own.length === dataDir.length || !sameOrUnder(dataDir, own)) return { ok: false, why: `${abs} is not inside dataDir ${resolve(config.dataDir)}` };
  const overlapping = Object.entries(config.stores)
    .filter(([other, store]) => other !== id && (sameOrUnder(own, canonicalSegments(store.path)) || sameOrUnder(canonicalSegments(store.path), own)))
    .map(([other, store]) => `${other} (${store.path})`);
  if (overlapping.length) {
    return {
      ok: false,
      why: `${abs} shares its directory with store(s) that stay: ${overlapping.join(", ")}`,
      advice: "Remove the store with --keep-data; its directory is theirs too",
    };
  }
  if (!existsSync(abs)) return { ok: true, missing: true };
  if (!existsSync(storePaths(abs).gitDir)) return { ok: false, why: `${abs} has no origin.git — not a store directory` };
  return { ok: true, missing: false, abs, realDir: realpathSync.native(abs), link: lstatSync(abs).isSymbolicLink() };
}

/** True when something — a directory, a file or a dangling link — is at `path`. */
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `vault server store list|rm` (docs/server.md "Removing a store"). rm takes the store out of
 * server.json in one atomic write — with the tokens scoped only to it and its backup.stores
 * entry — and keeps the directory unless `--purge --confirm <id>` says to delete it.
 */
export function commandStore(options, { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const action = options._[0];
  const configPath = configPathOf(options);
  const config = loadServerConfig(configPath);
  if (action === "list") {
    for (const [id, store] of Object.entries(config.stores)) log(`${id}\t${store.kind}\t${store.path}`);
    return;
  }
  if (action !== "rm") throw new Error("vault server store list|rm <id> [--keep-data | --purge --confirm <id>]");
  const id = options._[1];
  if (!id) throw new Error("vault server store rm <id>");
  if (!config.stores[id]) throw new Error(`no store ${id} in ${configPath} (vault server store list)`);
  if (options.purge === true && options["keep-data"] === true) throw new Error("--purge and --keep-data exclude each other");
  const purge = options.purge === true;
  const dir = config.stores[id].path;
  let check = null;
  if (purge) {
    if (options.confirm !== id) throw new Error(`--purge deletes ${dir} and cannot be undone: repeat the store id as --confirm ${id}`);
    check = purgeableStoreDir(config, id);
    if (!check.ok) throw new Error(`refusing to delete: ${check.why}. ${check.advice ?? "Remove the store with --keep-data and delete the directory yourself"}`);
  }
  const { config: next, removedTokens, narrowedTokens, backupListed } = withoutStore(config, id);
  writeServerConfig(configPath, next); // serve rereads it on its next request or index pass
  log(`removed store ${id} from ${configPath}`);
  if (removedTokens.length) log(`removed token(s) scoped only to ${id}: ${removedTokens.join(", ")}`);
  if (narrowedTokens.length) log(`token(s) still valid for other stores, ${id} dropped: ${narrowedTokens.join(", ")}`);
  if (backupListed) log(`backup.stores no longer lists ${id}${next.backup.stores.length ? "" : " — it is now empty: backups cover no store"}`);
  if (!purge) {
    log(`kept ${dir}: \`vault server init-store ${id} --owner …\` brings the store back (access lists, tokens and binaries.reject are not restored); delete the directory by hand once it is not needed`);
    return;
  }
  if (check.missing) {
    log(`${dir} did not exist; nothing to delete`);
    return;
  }
  // rename first: from here on serve and a late push see no store at the old path
  const target = check.realDir;
  const doomed = join(dirname(target), `.${basename(target)}.removed-${process.pid}`);
  renameSync(target, doomed);
  rmSync(doomed, { recursive: true, force: true });
  // the link itself, now dangling — by its resolved path: a configured path ending in `/` would
  // follow the link to the deleted target and miss it
  if (check.link) rmSync(check.abs, { force: true });
  const left = [target, doomed, check.abs].find(present);
  if (left) throw new Error(`deleted the store but ${left} is still there — check what writes to it, then delete it by hand`);
  log(check.link ? `deleted ${target} (the data ${dir} linked to) and the link ${dir}` : `deleted ${dir}`);
}

/** Accepts a reject-list file in any of: ["glob", ...] | {"reject": [...]} | {"binaries": {"reject": [...]}}. */
export function readRejectList(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : Array.isArray(data?.reject) ? data.reject : data?.binaries?.reject;
  if (!Array.isArray(list) || list.some((p) => typeof p !== "string")) {
    throw new Error('reject file must be ["glob", ...], {"reject": [...]} or {"binaries": {"reject": [...]}}');
  }
  return list;
}

function commandSetReject(options) {
  const configPath = configPathOf(options);
  const config = loadServerConfig(configPath);
  const id = options.store;
  if (!config.stores[id]) throw new Error(`no store ${id} in ${configPath}`);
  if (typeof options.from !== "string") throw new Error("--from <binaries-reject.json> required");
  const listed = readRejectList(readFileSync(options.from, "utf8"));
  // The vault's list (vault.config.json binaries.reject) is relative to the declared tree;
  // receive rule 7 matches repo-relative paths. Without --tree-prefix the list is taken as
  // repo-relative already.
  const prefix = typeof options["tree-prefix"] === "string" ? options["tree-prefix"] : "";
  const reject = anchorPatternsToTree(listed, prefix);
  writeServerConfig(configPath, {
    ...config,
    stores: { ...config.stores, [id]: { ...config.stores[id], binaries: { reject } } },
  });
  process.stdout.write(`store ${id}: binaries.reject = ${reject.length} pattern(s)\n`);
}

async function commandServe(options) {
  const configPath = configPathOf(options);
  const handle = await startServe({ configPath });
  const stop = () => {
    handle.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await handle.ready;
}

export async function main(argv = process.argv.slice(2)) {
  const [top, ...rest] = argv;
  if (top === "serve") {
    await commandServe(parseFlags(rest));
    return;
  }
  if (top !== "server") {
    process.stdout.write(USAGE);
    process.exitCode = 1;
    return;
  }
  const [verb, ...args] = rest;
  const options = parseFlags(args);
  switch (verb) {
    case "receive-check":
      process.exitCode = await commandReceiveCheck();
      return;
    case "post-receive":
      process.exitCode = await commandPostReceive();
      return;
    case "init-store":
      await commandInitStore(options);
      return;
    case "token":
      commandToken(options);
      return;
    case "store":
      commandStore(options);
      return;
    case "set-reject":
      commandSetReject(options);
      return;
    case "backup": {
      const { commandBackup } = await import("./backup-cli.mjs");
      process.exitCode = await commandBackup(args, { parseFlags, configPathOf });
      return;
    }
    case "install": {
      const { commandServerInstall } = await import("./install.mjs");
      await commandServerInstall(options);
      return;
    }
    default:
      process.stdout.write(USAGE);
      process.exitCode = verb === "--help" || verb === "-h" ? 0 : 1;
  }
}

const isDirectExecution = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

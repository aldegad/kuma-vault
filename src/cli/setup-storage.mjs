// `kuma-vault setup --storage local|oracle|remote` and `--add-store <id>` — where a vault store
// lives (docs/setup.md "Storage", skills/kuma-vault/docs/storage-policy.md).
//
//   local            ~/.kuma/vaults/<id>/ = a new git repository: generated .gitattributes (large
//                    files as LFS pointers) and .gitignore, vault/.rgignore (secret directories rg
//                    skips), vault/vault.config.json (visibility private, no allowed remote), the
//                    pre-commit gate and the pre-push allowlist, a first commit, the store
//                    registration, and ~/.kuma/vault -> its tree.
//   oracle | remote  the same layout, cloned from a `vault serve` store (`vault clone`). An empty
//                    server store gets the first commit pushed; the server URL is the only allowed
//                    remote. Then the registration, the link and (macOS) the sync daemon.
//
// An existing ~/.kuma/vault is never taken over silently. A git repository is refused (it moves
// with `vault migrate to-remote`). A plain folder moves in only with --adopt: one rename on the
// same filesystem, file count and bytes compared before and after, and undone if a later step
// fails. Every step that changes something registers its undo; a failure runs them in reverse.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { VAULT_CONFIG_FILENAME, loadVaultDeclaration } from "../engine/vault-config.mjs";
import { loadStoreRegistry, normalizeStoreEntry, updateStoreRegistry } from "../engine/vault-stores.mjs";
import { DEFAULT_JUNK_PATTERNS, renderLfsGitattributesLines } from "../server/lfs-paths.mjs";
import { cloneStore } from "../sync/clone.mjs";
import { VAULT_BIN, loadContext } from "../sync/context.mjs";
import { checkGitVersion, git, gitText, revParse } from "../sync/git.mjs";
import { launchdInstall } from "../sync/launchd.mjs";
import { RGIGNORE_FILENAME, normalizeRemoteUrl, renderRootGitignore, renderTreeRgignore } from "./policy-commands.mjs";

export const MAIN_STORE_ID = "kuma-main-vault";
export const TREE_DIR = "vault";
export const STORAGE_MODES = Object.freeze(["local", "oracle", "remote"]);
const STORE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Append-only ledgers: both sides' lines are kept on a merge (docs/sync.md, Conflicts).
const UNION_FILES = Object.freeze(["dispatch-log.md", "log.md"]);
const ATTRIBUTES_BLOCK = Object.freeze([
  "# >>> kuma-vault generated: large files are LFS pointers, ledgers merge by union (kuma-vault setup) >>>",
  "# <<< kuma-vault generated: .gitattributes <<<",
]);

// ── paths ───────────────────────────────────────────────────────────────────

export function kumaHomeDir(env = process.env) {
  return resolve(env.KUMA_HOME_DIR ?? join(env.HOME ?? homedir(), ".kuma"));
}

export function storePaths(id, env = process.env) {
  const home = kumaHomeDir(env);
  const repo = join(home, "vaults", id);
  return { home, repo, tree: join(repo, TREE_DIR), link: join(home, "vault") };
}

// ── generated files ─────────────────────────────────────────────────────────

/** The repository-root .gitattributes of a store (the same rules a server store uses). */
export function renderStoreGitattributes(treeDir = TREE_DIR) {
  const prefix = treeDir ? `/${treeDir}/` : "/";
  return [
    ATTRIBUTES_BLOCK[0],
    ...renderLfsGitattributesLines(),
    ...UNION_FILES.map((name) => `${prefix}${name} merge=union`),
    ATTRIBUTES_BLOCK[1],
    "",
  ].join("\n");
}

/** vault.config.json of a new store: the storage policy (P2) plus the size/reject gate. */
export function renderStoreDeclaration(id, allowed, existing = null) {
  const base = existing ?? { profile: "kuma-vault" };
  const list = [...(existing?.remotes?.allowed ?? [])];
  for (const url of allowed) if (!list.map(normalizeRemoteUrl).includes(normalizeRemoteUrl(url))) list.push(url);
  return {
    ...base,
    id,
    visibility: "private",
    remotes: { ...(existing?.remotes ?? {}), allowed: list },
    binaries: { reject: [], ...(existing?.binaries ?? {}) },
  };
}

const SEED_README = [
  "# Kuma Vault",
  "",
  "The memory of your agents: plans, notes and knowledge. Created by `kuma-vault setup`.",
  "",
].join("\n");

// ── inspecting what is there ────────────────────────────────────────────────

/** Files (regular files and symlinks, any depth) and bytes of regular files under `dir`. */
export function measureTree(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        files += 1;
        if (entry.isFile()) bytes += lstatSync(full).size;
      }
    }
  }
  return { files, bytes };
}

function listTree(dir) {
  const out = new Map();
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.set(relative(dir, full), entry.isFile() ? lstatSync(full).size : -1);
    }
  }
  return out;
}

function gitTopOf(dir) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * What the main address (~/.kuma/vault) is now:
 *   absent | ours (a link to this store's tree) | folder (not in a git repository, adoptable) |
 *   git (a tree inside a git repository — moves with vault migrate) | dangling | other.
 */
export function inspectMainAddress(link, treeDir) {
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return { kind: "absent", link };
  }
  const isLink = stat.isSymbolicLink();
  let source;
  try {
    source = realpathSync(link);
  } catch {
    return { kind: "dangling", link, target: isLink ? readlinkSync(link) : null };
  }
  if (existsSync(treeDir) && source === realpathSync(treeDir)) return { kind: "ours", link, source };
  if (!statSync(source).isDirectory()) return { kind: "other", link, source, isLink };
  const top = gitTopOf(source);
  if (top) return { kind: "git", link, source, isLink, top };
  return { kind: "folder", link, source, isLink, ...measureTree(source) };
}

export function refusalForAddress(state, { adopt, treeDir }) {
  const where = state.isLink ? `${state.link} (a link to ${state.source})` : state.link;
  switch (state.kind) {
    case "git":
      return `${where} is already a vault inside the git repository ${state.top}. Setup never takes over a repository.\n` +
        `  Keep it on this computer: it works as it is (register it with: vault store add <id> --root <tree>).\n` +
        `  Move it to a server: vault migrate to-remote --root <tree> --server <url> — it refuses when large files in its history are raw bytes; such a vault needs a history rewrite first.`;
    case "dangling":
      return `${state.link} is a link to ${state.target}, which does not exist. Remove the link (or restore its target) and run setup again.`;
    case "other":
      return `${where} is not a folder. Move it aside and run setup again.`;
    case "folder":
      return adopt ? null : `${where} is an existing folder: ${state.files} files, ${state.bytes} bytes.\n` +
        `  To move it into the new store at ${treeDir}, run setup again with --adopt (add --dry-run first to see the plan).\n` +
        `  Setup does not move or delete it without --adopt.`;
    default:
      return null;
  }
}

// ── steps with undo ─────────────────────────────────────────────────────────

class Undo {
  constructor(log) {
    this.log = log;
    this.steps = [];
  }
  push(label, fn) {
    this.steps.push({ label, fn });
  }
  run() {
    while (this.steps.length > 0) {
      const { label, fn } = this.steps.pop();
      try {
        fn();
        this.log(`  undone: ${label}`);
      } catch (error) {
        const left = this.steps.map((s) => s.label).reverse();
        this.log(`  UNDO FAILED: ${label}: ${error.message}`);
        if (left.length) this.log(`  not undone (left in place): ${left.join("; ")}`);
        return false;
      }
    }
    return true;
  }
}

function vaultCli(args, { cwd } = {}) {
  const result = spawnSync(VAULT_BIN, args, { cwd, encoding: "utf8" });
  if (result.error) throw new Error(`vault ${args.join(" ")}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`vault ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function vaultOnPath() {
  return spawnSync("sh", ["-c", "command -v vault"], { stdio: ["ignore", "pipe", "ignore"] }).status === 0;
}

async function preflight() {
  await checkGitVersion();
  const lfs = await git(["lfs", "version"], { allowFail: true });
  if (lfs.code !== 0) throw new Error("git-lfs is not installed (git lfs version failed) — install it first (https://git-lfs.com)");
  // The first commit and every autosave commit as this user; git refuses without an identity.
  const ident = await git(["var", "GIT_COMMITTER_IDENT"], { allowFail: true });
  if (ident.code !== 0) {
    throw new Error("git has no commit identity on this computer — run: git config --global user.name \"<name>\" && git config --global user.email \"<email>\"");
  }
}

async function checkHealth(server) {
  let response;
  try {
    response = await fetch(`${server}/v1/health`, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`the server ${server} does not answer /v1/health (${error.cause?.code ?? error.message}) — finish the guide's server install step, then run setup again`);
  }
  if (!response.ok) throw new Error(`the server ${server} answered /v1/health with HTTP ${response.status}`);
  return response.json();
}

/** Back up what a later step may rewrite inside an adopted tree (README indexes, the declaration). */
function snapshotRewritable(tree) {
  const saved = new Map();
  for (const [path] of listTree(tree)) {
    if (path === VAULT_CONFIG_FILENAME || path.endsWith("README.md") || path === "README.md") {
      saved.set(path, readFileSync(join(tree, path)));
    }
  }
  return saved;
}

function digest(map) {
  return createHash("sha256").update(JSON.stringify([...map].sort())).digest("hex");
}

/**
 * Move `source` to `tree` (one rename) and register the way back: files the later steps added are
 * removed, rewritten files restored, and the listing compared with the original before the rename
 * back. A different filesystem is refused — a copy could stop halfway.
 */
function adoptFolder(state, tree, undo, log) {
  const before = { files: state.files, bytes: state.bytes };
  const original = listTree(state.source);
  if (statSync(state.source).dev !== statSync(dirname(tree)).dev) {
    throw new Error(`${state.source} is on another filesystem than ${dirname(tree)} — --adopt moves by one rename only; move the folder next to ${dirname(tree)} first`);
  }
  log(`adopt: ${state.source} -> ${tree}`);
  log(`  before: ${before.files} files, ${before.bytes} bytes`);
  renameSync(state.source, tree);
  const after = measureTree(tree);
  log(`  after:  ${after.files} files, ${after.bytes} bytes`);
  const saved = snapshotRewritable(tree);
  undo.push(`move ${tree} back to ${state.source}`, () => {
    for (const [path] of listTree(tree)) if (!original.has(path)) rmSync(join(tree, path), { force: true });
    for (const [path, bytes] of saved) writeFileSync(join(tree, path), bytes);
    const now = listTree(tree);
    if (digest(now) !== digest(original)) {
      throw new Error(`${tree} no longer matches the adopted folder (${now.size} vs ${original.size} files) — it stays at ${tree}`);
    }
    renameSync(tree, state.source);
    const back = measureTree(state.source);
    log(`  restored ${state.source}: ${back.files} files, ${back.bytes} bytes`);
  });
  if (after.files !== before.files || after.bytes !== before.bytes) {
    throw new Error(`the moved folder does not match (before ${before.files} files ${before.bytes} B, after ${after.files} files ${after.bytes} B)`);
  }
  return before;
}

/** Write the repository-root files and the tree's declaration and README (what is missing). */
function writeStoreFiles({ repo, tree, id, allowed }) {
  writeFileSync(join(repo, ".gitattributes"), renderStoreGitattributes(), "utf8");
  writeFileSync(join(repo, ".gitignore"), renderRootGitignore("", { junk: [...DEFAULT_JUNK_PATTERNS], reject: [] }), "utf8");
  mkdirSync(tree, { recursive: true });
  const rgignorePath = join(tree, RGIGNORE_FILENAME);
  writeFileSync(rgignorePath, renderTreeRgignore(existsSync(rgignorePath) ? readFileSync(rgignorePath, "utf8") : ""), "utf8");
  const configPath = join(tree, VAULT_CONFIG_FILENAME);
  const existing = existsSync(configPath) ? loadVaultDeclaration(tree) : null;
  if (existing?.id && existing.id !== id) {
    throw new Error(`${configPath} declares id "${existing.id}", not "${id}" — pass --store ${existing.id} or change the declaration`);
  }
  writeFileSync(configPath, `${JSON.stringify(renderStoreDeclaration(id, allowed, existing), null, 2)}\n`, "utf8");
  loadVaultDeclaration(tree);
  if (!existsSync(join(tree, "README.md"))) writeFileSync(join(tree, "README.md"), SEED_README, "utf8");
}

async function commitAll(repo, tree, message) {
  // derive README indexes and sidecars first: the pre-commit gate refuses drift
  vaultCli(["sync", "--root", tree]);
  await git(["add", "-A"], { cwd: repo });
  await git(["commit", "-q", "-m", message], { cwd: repo });
  return gitText(["rev-parse", "HEAD"], { cwd: repo });
}

function installHooks(tree) {
  return vaultCli(["hook", "install", "--root", tree, ...(vaultOnPath() ? [] : ["--bin", VAULT_BIN])]);
}

function register({ id, tree, main, entry }, undo) {
  const { path } = updateStoreRegistry((doc) => {
    doc.stores[id] = normalizeStoreEntry(id, { root: tree, ...entry });
    if (main) doc.default = id;
    return doc;
  });
  undo.push(`registration of ${id} in ${path}`, () => {
    updateStoreRegistry((doc) => {
      delete doc.stores[id];
      if (doc.default === id) delete doc.default;
      return doc;
    });
  });
  return path;
}

function linkMain(link, tree, state, undo) {
  mkdirSync(dirname(link), { recursive: true });
  const temp = `${link}.setup-${process.pid}`;
  rmSync(temp, { force: true });
  symlinkSync(tree, temp);
  const previous = state.isLink ? readlinkSync(link) : null;
  renameSync(temp, link);
  undo.push(`link ${link}`, () => {
    unlinkSync(link);
    if (previous !== null) symlinkSync(previous, link);
  });
}

// ── the storage step ────────────────────────────────────────────────────────

export function parseStorageOptions(options) {
  const addStore = typeof options["add-store"] === "string" ? options["add-store"] : null;
  if (options["add-store"] === true) throw new Error("--add-store <id> needs a store id");
  const storage = typeof options.storage === "string" ? options.storage : null;
  if (!storage && !addStore) return null;
  if (!storage) throw new Error("--add-store <id> needs --storage local|oracle|remote");
  if (!STORAGE_MODES.includes(storage)) throw new Error(`--storage must be one of ${STORAGE_MODES.join(", ")} (got "${storage}")`);
  const id = addStore ?? (typeof options.store === "string" ? options.store : MAIN_STORE_ID);
  if (!STORE_ID.test(id)) throw new Error(`store id "${id}" must be lowercase letters, digits and hyphens`);
  const remote = storage !== "local";
  const server = typeof options.server === "string" ? options.server.replace(/\/+$/, "") : null;
  if (remote && !server) throw new Error(`--storage ${storage} needs --server <url> (the vault serve address, e.g. http://<server>.<tailnet>.ts.net:7741)`);
  if (!remote && server) throw new Error("--server is for --storage oracle|remote; a local store has no server");
  if (server && !/^https?:\/\/[^/]+$/.test(server)) throw new Error(`--server must be http(s)://host[:port] with no path (got "${server}")`);
  const tokenFile = typeof options["token-file"] === "string" ? resolve(options["token-file"]) : null;
  if (tokenFile && !remote) throw new Error("--token-file is for a server store");
  if (options.adopt === true && addStore) throw new Error("--adopt moves an existing ~/.kuma/vault into the MAIN store; it does not apply to --add-store");
  return {
    mode: remote ? "remote" : "local",
    storage,
    id,
    main: !addStore,
    server,
    tokenFile,
    adopt: options.adopt === true,
    dryRun: options["dry-run"] === true,
    daemon: options["no-daemon"] !== true,
  };
}

/**
 * Run the storage step. Returns a summary object; throws (after undoing what it did) on failure.
 * `env` picks the kuma home (KUMA_HOME_DIR or HOME/.kuma) and the store registry.
 */
export async function runStorageSetup(plan, { env = process.env, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const paths = storePaths(plan.id, env);
  const registry = loadStoreRegistry(env);
  if (registry.invalid) throw new Error(`store registry ${registry.path} is invalid: ${registry.invalid}`);
  const registered = registry.stores.get(plan.id) ?? null;
  const state = plan.main ? inspectMainAddress(paths.link, paths.tree) : { kind: "absent" };

  // Already done: the same store, the same root, the address linked.
  if (registered && resolve(registered.rootDir ?? registered.root) === paths.tree && (!plan.main || state.kind === "ours")) {
    log(`store ${plan.id} is already set up: ${registered.mode}, ${paths.tree}${plan.main ? ` (${paths.link} -> it)` : ""}`);
    return { id: plan.id, already: true, mode: registered.mode, tree: paths.tree };
  }
  if (registered) throw new Error(`store "${plan.id}" is already registered in ${registry.path} with root ${registered.rootDir ?? registered.root} — pick another id or remove it (vault store rm ${plan.id})`);
  const refusal = plan.main ? refusalForAddress(state, { adopt: plan.adopt, treeDir: paths.tree }) : null;
  if (refusal) throw Object.assign(new Error(refusal), { exitCode: 3 });
  if (plan.adopt && state.kind !== "folder") throw new Error(`--adopt: there is no folder at ${paths.link} to adopt`);
  if (existsSync(paths.repo) && readdirSync(paths.repo).length > 0) {
    throw new Error(`${paths.repo} exists and is not empty — a store is created in an empty place only`);
  }

  const url = plan.server ? `${plan.server}/v1/stores/${plan.id}.git` : null;
  log(`setup ${plan.storage} store ${plan.id}${plan.main ? " (main)" : ""}`);
  log(`  repository: ${paths.repo}`);
  log(`  tree:       ${paths.tree}`);
  if (url) log(`  server:     ${url}${plan.tokenFile ? " (token)" : ""}`);
  if (plan.main) log(`  address:    ${paths.link} -> ${paths.tree}`);
  if (state.kind === "folder") log(`  adopt:      ${state.source} (${state.files} files, ${state.bytes} bytes) -> ${paths.tree}`);
  if (plan.dryRun) {
    log("dry run: nothing changed");
    return { id: plan.id, dryRun: true, tree: paths.tree, adopt: state.kind === "folder" ? { source: state.source, files: state.files, bytes: state.bytes } : null };
  }

  await preflight();
  if (plan.tokenFile && !existsSync(plan.tokenFile)) throw new Error(`--token-file ${plan.tokenFile} does not exist`);
  if (url) {
    const health = await checkHealth(plan.server);
    log(`  server health: version ${health.version ?? "?"}`);
  }

  const undo = new Undo(log);
  let summary;
  try {
    summary = plan.mode === "local"
      ? await createLocal(plan, paths, state, undo, log)
      : await createRemote(plan, paths, state, url, undo, log);
  } catch (error) {
    log(`setup failed: ${error.message}`);
    log("undoing:");
    const clean = undo.run();
    if (!clean) error.message += " (undo incomplete — see the lines above)";
    throw error;
  }
  // The store is complete and on the server. A daemon that does not install is reported, not undone.
  if (plan.mode === "remote") summary.daemon = await installDaemon(plan, paths, log);
  return { id: plan.id, mode: plan.mode, tree: paths.tree, ...summary };
}

async function installDaemon(plan, paths, log) {
  if (!plan.daemon) {
    log("sync daemon: not installed (--no-daemon)");
    return { installed: false, reason: "--no-daemon" };
  }
  if (platform() !== "darwin") {
    log(`sync daemon: no installer on ${platform()} — run \`vault syncd --repo ${paths.repo}\` under your service manager`);
    return { installed: false, reason: `no installer on ${platform()}` };
  }
  try {
    const result = launchdInstall(await loadContext(paths.repo));
    log(`sync daemon: launchd ${result.label}`);
    return { installed: true, label: result.label };
  } catch (error) {
    log(`sync daemon NOT installed: ${error.message} — run: vault sync install --repo ${paths.repo}`);
    process.exitCode = 1;
    return { installed: false, reason: error.message };
  }
}

function finishMain(plan, paths, state, undo, log) {
  if (!plan.main) return;
  linkMain(paths.link, paths.tree, state, undo);
  log(`linked ${paths.link} -> ${paths.tree}`);
}

async function createLocal(plan, paths, state, undo, log) {
  mkdirSync(paths.repo, { recursive: true });
  undo.push(`remove ${paths.repo}`, () => rmSync(paths.repo, { recursive: true, force: true }));
  await git(["init", "-q", "-b", "main"], { cwd: paths.repo });
  await git(["lfs", "install", "--local"], { cwd: paths.repo });
  const adopted = state.kind === "folder" ? adoptFolder(state, paths.tree, undo, log) : null;
  writeStoreFiles({ repo: paths.repo, tree: paths.tree, id: plan.id, allowed: [] });
  log(installHooks(paths.tree));
  const head = await commitAll(paths.repo, paths.tree, `kuma-vault setup: ${plan.id} (local)`);
  log(`first commit ${head.slice(0, 9)}`);
  const registryPath = register({ id: plan.id, tree: paths.tree, main: plan.main, entry: { mode: "local" } }, undo);
  log(`registered ${plan.id} (local) in ${registryPath}`);
  finishMain(plan, paths, state, undo, log);
  return { head, adopted };
}

async function createRemote(plan, paths, state, url, undo, log) {
  undo.push(`remove ${paths.repo}`, () => rmSync(paths.repo, { recursive: true, force: true }));
  const cloned = await cloneStore(url, paths.repo, { store: plan.id, tokenFile: plan.tokenFile ?? undefined, tree: TREE_DIR, log });
  let adopted = null;
  let head = cloned.head;
  let push = null;
  if (!cloned.head) {
    // an empty server store: this computer writes its first commit (pushed last, below)
    adopted = state.kind === "folder" ? adoptFolder(state, paths.tree, undo, log) : null;
    writeStoreFiles({ repo: paths.repo, tree: paths.tree, id: plan.id, allowed: [url] });
    log(installHooks(paths.tree));
    head = await commitAll(paths.repo, paths.tree, `kuma-vault setup: ${plan.id}`);
    push = `first commit ${head.slice(0, 9)}`;
  } else {
    if (state.kind === "folder") {
      throw new Error(`the server store ${plan.id} already holds a vault (main ${cloned.head.slice(0, 9)}) — --adopt would mix two vaults; adopt into an empty store, or move the folder aside`);
    }
    const declaration = loadVaultDeclaration(paths.tree);
    if (declaration?.id !== plan.id) {
      throw new Error(`the server store ${plan.id} has no ${TREE_DIR}/${VAULT_CONFIG_FILENAME} declaring id "${plan.id}" — not a store made by kuma-vault setup`);
    }
    const allowed = (declaration.remotes?.allowed ?? []).map(normalizeRemoteUrl);
    if (!allowed.includes(normalizeRemoteUrl(url))) {
      // this computer reaches the server by another address: allow it, or the pre-push hook refuses
      const configPath = join(paths.tree, VAULT_CONFIG_FILENAME);
      writeFileSync(configPath, `${JSON.stringify(renderStoreDeclaration(plan.id, [url], declaration), null, 2)}\n`, "utf8");
      loadVaultDeclaration(paths.tree);
      await git(["commit", "-q", "-m", `kuma-vault setup: allow remote ${url}`, "--", relative(paths.repo, configPath)], { cwd: paths.repo });
      head = await revParse(paths.repo, "HEAD");
      push = `${TREE_DIR}/${VAULT_CONFIG_FILENAME} allowing ${url} (${head.slice(0, 9)})`;
    }
  }
  const tokenCopy = plan.tokenFile ? join(paths.repo, ".git", "kuma-vault", "token") : undefined;
  const registryPath = register({
    id: plan.id,
    tree: paths.tree,
    main: plan.main,
    entry: { mode: "remote", remote: { server: plan.server, store: plan.id, ...(tokenCopy ? { tokenFile: tokenCopy } : {}) } },
  }, undo);
  log(`registered ${plan.id} (remote) in ${registryPath}`);
  finishMain(plan, paths, state, undo, log);
  // Last: nothing reaches the server unless every local step above held.
  if (push) {
    await git(["push", "-q", "origin", "main"], { cwd: paths.repo });
    log(`pushed ${push} to ${url}`);
  }
  return { head, adopted, url };
}

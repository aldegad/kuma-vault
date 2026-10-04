// `vault clone` — a partial clone of a served store, set up for the sync daemon (design 1.2).
//
//   --filter=blob:limit=1m          old versions of big text stay on the server until asked for
//   lfs.fetchexclude=*              LFS paths check out as pointers; `vault blob get` fetches one
//   lfs.<url>.locksverify=false     the server does not serve the LFS lock API
//   +refs/replace/*:refs/replace/*  old shas of a rewritten history still open
//   core.fsmonitor/untrackedCache, feature.manyFiles   `git status` over ~200k paths
//   index.skipHash=false           retain stale-index detection between concurrent writers
//   credential helper               a token from --token-file (Bearer/Basic on the server side),
//                                   the only helper for the server's URL (credentialEntries);
//                                   without it the server identifies the tailnet peer
//   pre-commit drift gate           `vault hook install` when the tree declares vault.config.json,
//                                   after `git lfs install` (the engine's pre-push hook calls git-lfs)
//   kuma-vault.bin                  which engine the hooks run
//   credential modes                the checkout wrote `_credentials/` by the umask: tightened to
//                                   0600 files / 0700 directories (credential-modes.mjs)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { VAULT_BIN, parseStoreUrl } from "./context.mjs";
import { formatCredentialModes, keepCredentialModes } from "./credential-modes.mjs";
import { checkGitVersion, git, gitEnv, revParse } from "./git.mjs";

export function credentialHelper(tokenPath) {
  if (tokenPath.includes("'")) throw new Error(`token path must not contain a single quote: ${tokenPath}`);
  // git runs `!<shell>` helpers with the action as $1; only `get` answers.
  return `!f() { test "$1" = get || exit 0; printf 'username=kuma-vault\\npassword=%s\\n' "$(cat '${tokenPath}')"; }; f`;
}

/**
 * Config entries that make the token file the only credential git, git-lfs and the daemon use
 * for `origin`: an empty helper first, which drops every helper a lower config (system,
 * global) adds — macOS git ships `credential.helper=osxkeychain` — then the file helper.
 * Without the reset git also asks osxkeychain, and after a good login asks it to `store` the
 * token: under launchd that waits on a keychain prompt no one sees (the daemon stands still),
 * and anywhere it leaves a copy of the token in the login keychain.
 */
export function credentialEntries(origin, tokenPath) {
  const key = `credential.${origin}.helper`;
  return [[key, ""], [key, credentialHelper(tokenPath)]];
}

/** Write `credentialEntries` into the repo's own config, replacing what the key held. */
export async function setCredential(repo, origin, tokenPath) {
  const entries = credentialEntries(origin, tokenPath);
  await git(["config", "--local", "--unset-all", entries[0][0]], { cwd: repo, allowFail: true });
  for (const [key, value] of entries) await git(["config", "--local", "--add", key, value], { cwd: repo });
}

/**
 * Clones set up before the reset existed carry the file helper alone; give them the reset.
 * Returns the origins it changed. Helpers that are not the clone's token file are left alone.
 */
export async function repairCredential(repo) {
  const out = await git(["config", "--local", "--get-regexp", "^credential\\..+\\.helper$"], { cwd: repo, allowFail: true });
  const byKey = new Map();
  for (const line of out.stdout.toString("utf8").split("\n").filter(Boolean)) {
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    byKey.set(key, [...(byKey.get(key) ?? []), value]);
  }
  const changed = [];
  for (const [key, values] of byKey) {
    const tokenPath = values.map((v) => /cat '([^']+\/kuma-vault\/token)'/.exec(v)?.[1]).find(Boolean);
    if (!tokenPath || values[0] === "") continue;
    const origin = key.slice("credential.".length, -".helper".length);
    await setCredential(repo, origin, tokenPath);
    changed.push(origin);
  }
  return changed;
}

function configEnv(pairs) {
  const env = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Shared by new clones and sync install: optional index writers need a real checksum. */
export async function ensureIndexChecksum(repo) {
  await git(["config", "--local", "--replace-all", "index.skipHash", "false"], { cwd: repo });
  // Existing indexes may still have a zero checksum. Rewrite under Git's required index
  // lock, preserving staged entries; the next status must read a checksummed index too.
  // A --no-checkout clone has no index yet: creating an empty one would stage every path
  // as deleted, and checkout would preserve those deletions instead of populating the tree.
  const index = (await git(["rev-parse", "--git-path", "index"], { cwd: repo })).stdout.toString("utf8").trim();
  if (existsSync(resolve(repo, index))) await git(["update-index", "--force-write-index"], { cwd: repo });
}

export async function cloneStore(url, dirArg, { store: storeArg, tokenFile, tree, hook = true, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  await checkGitVersion();
  const lfs = await git(["lfs", "version"], { allowFail: true });
  if (lfs.code !== 0) throw new Error("git-lfs is not installed (git lfs version failed)");
  const parsed = parseStoreUrl(url);
  const store = storeArg ?? parsed?.store;
  if (!store) throw new Error(`cannot tell the store id from ${url} — pass --store <id>`);
  const dir = resolve(dirArg ?? join(process.env.HOME ?? homedir(), ".kuma", "vaults", store));
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} exists and is not empty`);
  const serverBase = parsed?.serverBase ?? new URL(url).origin;

  let token = null;
  if (tokenFile) {
    token = readFileSync(tokenFile, "utf8").trim();
    if (!token) throw new Error(`${tokenFile} is empty`);
  }
  const cloneConfig = [
    ["lfs.fetchexclude", "*"],
    [`lfs.${url.replace(/\/$/, "")}/info/lfs.locksverify`, "false"],
  ];
  if (tokenFile) cloneConfig.push(...credentialEntries(serverBase, resolve(tokenFile)));
  const env = gitEnv({ ...configEnv(cloneConfig), GIT_LFS_SKIP_SMUDGE: "1" });
  await git(["clone", "--quiet", "--filter=blob:limit=1m", "--no-checkout", "--origin", "origin", url, dir], { env });

  const set = (key, value) => git(["config", key, value], { cwd: dir });
  if (token !== null) {
    const privateDir = join(dir, ".git", "kuma-vault");
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    chmodSync(privateDir, 0o700);
    const tokenPath = join(privateDir, "token");
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    await setCredential(dir, serverBase, tokenPath);
  }
  const settings = [
    ["core.untrackedCache", "true"],
    ["feature.manyFiles", "true"],
    ["lfs.fetchexclude", "*"],
    ["lfs.concurrenttransfers", "4"],
    [`lfs.${url.replace(/\/$/, "")}/info/lfs.locksverify`, "false"],
    ["kuma-vault.store", store],
    // the engine the gate hooks run (launchd gives the daemon no `vault` on PATH)
    ["kuma-vault.bin", process.env.KUMA_VAULT_BIN ?? VAULT_BIN],
    ["branch.main.remote", "origin"],
    ["branch.main.merge", "refs/heads/main"],
  ];
  if (process.platform === "darwin" || process.platform === "win32") settings.push(["core.fsmonitor", "true"]);
  if (process.platform === "darwin") settings.push(["core.precomposeunicode", "true"]);
  for (const [key, value] of settings) await set(key, value);
  await ensureIndexChecksum(dir);
  await git(["config", "--add", "remote.origin.fetch", "+refs/replace/*:refs/replace/*"], { cwd: dir });
  await git(["lfs", "install", "--local"], { cwd: dir });
  await git(["fetch", "--quiet", "--no-tags", "origin"], { cwd: dir });

  const remoteMain = await revParse(dir, "refs/remotes/origin/main");
  if (remoteMain) {
    await git(["checkout", "--quiet", "-B", "main", "refs/remotes/origin/main"], { cwd: dir });
  } else {
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: dir });
  }

  const { report: credentialModes } = await keepCredentialModes(dir, { fix: true });
  if (credentialModes.roots) log(formatCredentialModes(credentialModes));

  const treeRel = tree ?? (existsSync(join(dir, "vault", "vault.config.json")) ? "vault" : "");
  await set("kuma-vault.tree", treeRel);
  const treeAbs = treeRel ? join(dir, treeRel) : dir;
  let hookInstalled = false;
  if (hook && existsSync(join(treeAbs, "vault.config.json"))) {
    const result = spawnSync(process.env.KUMA_VAULT_BIN ?? VAULT_BIN, ["hook", "install", "--root", treeAbs], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`vault hook install failed: ${result.stderr || result.stdout}`);
    hookInstalled = true;
  }
  log(`cloned ${store} into ${dir} (main ${remoteMain ? remoteMain.slice(0, 9) : "empty"}, tree "${treeRel || "."}", pre-commit gate ${hookInstalled ? "installed" : "not installed"})`);
  return { dir, store, treeRel, head: remoteMain, hookInstalled, credentialModes };
}

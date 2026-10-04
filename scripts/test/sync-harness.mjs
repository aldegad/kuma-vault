// Test harness for the sync daemon (src/sync/*.test.mjs): a `vault serve` of its own on loopback
// with token auth, a TCP proxy in front of it whose link can be cut (network loss), clones made
// by `vault clone`, and in-process ticks on an injected clock. Needs git, git-lfs and Node 22.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_JUNK_PATTERNS, renderLfsGitattributesLines } from "../../src/server/lfs-paths.mjs";
import { hashToken, writeServerConfig } from "../../src/server/server-config.mjs";
import { initStore, storePaths } from "../../src/server/store-layout.mjs";

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VAULT_BIN = join(PKG_ROOT, "bin", "vault");
const SERVER_CLI = join(PKG_ROOT, "src", "server", "server-cli.mjs");
export const TOKEN = "tok-sync-writer";
export const MiB = 1024 * 1024;

export function createWorld(prefix = "kv-sync-") {
  const root = mkdtempSync(join(process.env.KV_SYNC_TMP ?? tmpdir(), prefix));
  const home = join(root, "home");
  mkdirSync(home);
  const env = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    KUMA_VAULT_SYNC_DIR: join(root, "sync-state"),
  };
  Object.assign(process.env, env); // in-process ticks read these
  const world = {
    root,
    env,
    sh(cmd, args, { cwd = root, input, allowFail = false, extraEnv = {}, timeout } = {}) {
      const result = spawnSync(cmd, args, { cwd, input, timeout, killSignal: "SIGKILL", maxBuffer: 512 * MiB, env: { ...process.env, ...env, LC_ALL: "C", ...extraEnv } });
      const out = { code: result.status, stdout: result.stdout?.toString("utf8") ?? "", stderr: result.stderr?.toString("utf8") ?? "" };
      if (out.code !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")} (${out.code})\n${out.stderr}\n${out.stdout}`);
      return out;
    },
    git(cwd, args, opts = {}) {
      return world.sh("git", args, { cwd, ...opts });
    },
  };
  world.sh("git", ["config", "--global", "user.name", "sync-test"]);
  world.sh("git", ["config", "--global", "user.email", "sync-test@test.invalid"]);
  world.sh("git", ["config", "--global", "init.defaultBranch", "main"]);
  world.sh("git", ["lfs", "install", "--skip-repo"]);
  writeFileSync(join(root, "token"), `${TOKEN}\n`, { mode: 0o600 });
  return world;
}

/** Start `vault serve` for one store `s` (token auth). `restart()` brings it back on the same port. */
export async function startServe(world, { reject = [], store = "s" } = {}) {
  const storeRoot = join(world.root, "stores", store);
  const configPath = join(world.root, "server.json");
  let port = 0;
  const writeConfig = () =>
    writeServerConfig(configPath, {
      version: 1,
      listen: [`127.0.0.1:${port}`],
      dataDir: join(world.root, "stores"),
      diskReserveGB: 0.001,
      auth: { mode: "token" },
      tokens: [{ id: "w", sha256: hashToken(TOKEN), role: "writer", stores: [store] }],
      stores: { [store]: { path: storeRoot, binaries: { reject } } },
    });
  writeConfig();
  await initStore(storeRoot, { vaultBin: VAULT_BIN });
  let child = null;
  // serve logs to a file, never a pipe: the tests block in spawnSync and a full pipe would stall it
  const logPath = join(world.root, `serve-${store}.log`);
  const launch = async () => {
    const offset = (() => {
      try {
        return readFileSync(logPath).length;
      } catch {
        return 0;
      }
    })();
    const fd = openSync(logPath, "a");
    child = spawn(process.execPath, [SERVER_CLI, "serve", "--config", configPath], { stdio: ["ignore", fd, fd], env: { ...process.env, ...world.env } });
    closeSync(fd);
    const until = Date.now() + 15_000;
    for (;;) {
      const text = readFileSync(logPath).subarray(offset).toString("utf8");
      const match = /"event":"listening","listen":"127\.0\.0\.1:(\d+)"/.exec(text);
      if (match) return Number(match[1]);
      if (child.exitCode !== null || Date.now() > until) throw new Error(`serve did not start: ${text.slice(-400)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  port = await launch();
  writeConfig(); // pin the port so a restart comes back on it
  const serve = {
    store,
    storeRoot,
    paths: storePaths(storeRoot),
    configPath,
    get port() {
      return port;
    },
    async stop() {
      if (!child) return;
      const c = child;
      child = null;
      await new Promise((r) => {
        c.once("exit", r);
        c.kill("SIGKILL");
      });
    },
    async restart() {
      await serve.stop();
      port = await launch();
    },
    head() {
      const out = world.sh("git", ["--git-dir", serve.paths.gitDir, "rev-parse", "--verify", "--quiet", "refs/heads/main"], { allowFail: true });
      return out.code === 0 ? out.stdout.trim() : null;
    },
    show(rev, path) {
      return world.sh("git", ["--git-dir", serve.paths.gitDir, "show", `${rev}:${path}`], { allowFail: true });
    },
    casHas(oid) {
      const out = world.sh("test", ["-f", join(serve.paths.lfsObjects, oid.slice(0, 2), oid.slice(2, 4), oid)], { allowFail: true });
      return out.code === 0;
    },
    events() {
      try {
        return readFileSync(serve.paths.events, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
  return serve;
}

/**
 * A TCP proxy in front of serve, in its own process (scripts/test/sync-proxy.mjs). `cut()` drops
 * every live connection and resets new ones (network loss), `restore()` lets traffic through,
 * `setThrottle(bytes/s)` slows uploads so a test can kill a push mid-transfer.
 */
export async function startProxy(targetPort) {
  const child = spawn(process.execPath, [join(PKG_ROOT, "scripts", "test", "sync-proxy.mjs"), String(targetPort)], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  const waiters = [];
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let nl;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiters.push(r)));
  const { port } = JSON.parse(await nextLine());
  const command = async (text) => {
    child.stdin.write(`${text}\n`);
    const answer = await nextLine();
    if (!answer.startsWith("ok ")) throw new Error(`proxy: ${answer}`);
  };
  return {
    port,
    cut: () => command("cut"),
    restore: () => command("restore"),
    setThrottle: (bytesPerSecond) => command(`throttle ${bytesPerSecond}`),
    retarget: (p) => command(`target ${p}`),
    close() {
      child.stdin.end();
      return new Promise((r) => {
        if (child.exitCode !== null) r();
        else child.once("exit", r);
      });
    },
  };
}

/** `.gitattributes` (LFS extensions + union ledgers) and the root `.gitignore` blocks for a fixture tree. */
export function fixtureAttributes(tree = "vault") {
  const p = tree ? `/${tree}` : "";
  return [...renderLfsGitattributesLines(), `${p}/dispatch-log.md merge=union`, `${p}/log.md merge=union`, ""].join("\n");
}

export function fixtureGitignore({ tree = "vault", reject = [] } = {}) {
  const prefix = tree ? `${tree}/` : "";
  const rejectLines = reject.map((p) => (p.includes("/") && !p.startsWith("**/") ? `/${prefix}${p.replace(/^\//, "")}` : `${prefix}**/${p}`));
  return ["# trash/derived", ...DEFAULT_JUNK_PATTERNS, "# binaries.reject", ...rejectLines, ""].join("\n");
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function removeWorld(world) {
  if (world?.root && !process.env.KV_SYNC_KEEP) rmSync(world.root, { recursive: true, force: true });
}

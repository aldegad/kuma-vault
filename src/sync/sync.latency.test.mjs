// Latency measurement (design 2.6), opt-in: KV_SYNC_LATENCY=1. Two real daemons (a, b) against
// a serve of their own — or against an installed one when KV_SYNC_URL and KV_SYNC_TOKEN_FILE
// name a scratch store — and N agent commits on a:
//   commit -> server accept      local commit returned until the server's main is that commit
//   server -> other work tree    server accepted until b's work tree holds the line
// Writes p50/p95 to KV_SYNC_RECEIPT (JSON) when set.

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VAULT_BIN, createWorld, fixtureAttributes, fixtureGitignore, removeWorld, startServe } from "../../scripts/test/sync-harness.mjs";

const SYNC_CLI = join(dirname(fileURLToPath(import.meta.url)), "sync-cli.mjs");
const ENABLED = process.env.KV_SYNC_LATENCY === "1";
const N = Number(process.env.KV_SYNC_N ?? 30);

let world;
let serve;
let url;
let tokenFile;
const daemons = [];

/** The checkout rewrites a file by unlink + create, so a read can land between the two. */
function readQuiet(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function remoteHead() {
  const out = world.sh("git", ["ls-remote", url, "refs/heads/main"], { allowFail: true, extraEnv: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${readFileSync(tokenFile, "utf8").trim()}` } });
  return out.stdout.split("\t")[0] || null;
}

beforeAll(async () => {
  if (!ENABLED) return;
  world = createWorld("kv-sync-lat-");
  if (process.env.KV_SYNC_URL) {
    url = process.env.KV_SYNC_URL;
    tokenFile = process.env.KV_SYNC_TOKEN_FILE;
  } else {
    serve = await startServe(world);
    url = `http://127.0.0.1:${serve.port}/v1/stores/s.git`;
    tokenFile = join(world.root, "token");
  }
  const seed = join(world.root, "seed");
  world.sh(VAULT_BIN, ["clone", url, seed, "--token-file", tokenFile, "--no-hook"]);
  if (!world.git(seed, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true }).stdout.trim()) {
    const put = (rel, text) => {
      mkdirSync(dirname(join(seed, rel)), { recursive: true });
      writeFileSync(join(seed, rel), text);
    };
    put(".gitattributes", fixtureAttributes("vault"));
    put(".gitignore", fixtureGitignore({ tree: "vault" }));
    put("vault/vault.config.json", '{"profile":"kuma-vault"}\n');
    put("vault/README.md", "# Vault\n");
    put("vault/dispatch-log.md", "# dispatch log\n");
    world.sh(VAULT_BIN, ["sync", "--root", join(seed, "vault")]);
    world.git(seed, ["add", "-A"]);
    world.git(seed, ["commit", "--quiet", "-m", "latency fixture"]);
    world.git(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  }
  for (const name of ["a", "b"]) {
    const dir = join(world.root, name);
    world.sh(VAULT_BIN, ["clone", url, dir, "--token-file", tokenFile]);
    world.git(dir, ["config", "kuma-vault.host", name]);
    const env = { ...process.env, ...world.env, KUMA_VAULT_SYNC_DIR: join(world.root, `state-${name}`) };
    const log = openSync(join(world.root, `${name}.daemon.log`), "a");
    daemons.push(spawn(process.execPath, [SYNC_CLI, "syncd", "--repo", dir], { env, detached: true, stdio: ["ignore", log, log] }));
    closeSync(log);
  }
  await new Promise((r) => setTimeout(r, 3000));
}, 180_000);

afterAll(async () => {
  for (const d of daemons) {
    try {
      process.kill(-d.pid, "SIGTERM");
    } catch {
      // gone
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  await serve?.stop();
  removeWorld(world);
});

describe.skipIf(!ENABLED)("sync latency", () => {
  it(`measures ${N} commits: commit -> server accept, server -> other work tree`, async () => {
    const a = join(world.root, "a");
    const b = join(world.root, "b");
    const push = [];
    const pull = [];
    for (let i = 0; i < N; i += 1) {
      const line = `- latency ${i} ${Date.now()}\n`;
      appendFileSync(join(a, "vault/dispatch-log.md"), line);
      world.git(a, ["commit", "--quiet", "-m", `latency ${i}`, "--", "vault/dispatch-log.md"]);
      const sha = world.git(a, ["rev-parse", "HEAD"]).stdout.trim();
      const committed = performance.now();
      let accepted = null;
      let arrived = null;
      const until = committed + 60_000;
      while (performance.now() < until && arrived === null) {
        if (accepted === null) {
          const head = serve ? serve.head() : remoteHead();
          if (head === sha) accepted = performance.now();
        }
        if (accepted !== null && readQuiet(join(b, "vault/dispatch-log.md")).includes(line)) arrived = performance.now();
        await new Promise((r) => setTimeout(r, serve ? 20 : 100));
      }
      expect(accepted, `commit ${i} accepted`).not.toBeNull();
      expect(arrived, `commit ${i} reached b`).not.toBeNull();
      push.push(accepted - committed);
      pull.push(arrived - accepted);
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
    }
    const summary = {
      n: N,
      target: serve ? "own serve on loopback" : url,
      commitToServerMs: { p50: Math.round(percentile(push, 50)), p95: Math.round(percentile(push, 95)), max: Math.round(Math.max(...push)) },
      serverToOtherWorktreeMs: { p50: Math.round(percentile(pull, 50)), p95: Math.round(percentile(pull, 95)), max: Math.round(Math.max(...pull)) },
      raw: { push: push.map(Math.round), pull: pull.map(Math.round) },
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (process.env.KV_SYNC_RECEIPT) writeFileSync(process.env.KV_SYNC_RECEIPT, `${JSON.stringify(summary, null, 2)}\n`);
    expect(summary.commitToServerMs.p95).toBeLessThan(10_000);
  }, 600_000);
});


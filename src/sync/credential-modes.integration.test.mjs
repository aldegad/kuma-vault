// Credential modes end to end: under umask 022 git writes `_credentials/` as 0644/0755 in a
// `vault clone`, in every fast-forward or merge the daemon makes, and in the server's `tree/`.
// Each must come out 0600 files / 0700 directories, and a mode left loose must raise the
// `credentialModes` alarm. Own `vault serve` on loopback (no proxy); daemon ticks in process.
// Needs git >= 2.38, git-lfs, Node 22. See docs/sync.md.

import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VAULT_BIN, createWorld, fixtureAttributes, fixtureGitignore, removeWorld, startServe } from "../../scripts/test/sync-harness.mjs";
import { loadContext } from "./context.mjs";
import { createMemory, runTick } from "./daemon.mjs";
import { statusProblems } from "./sync-cli.mjs";

const SYNC_CLI = join(dirname(fileURLToPath(import.meta.url)), "sync-cli.mjs");
const CRED = "vault/domains/personal/_credentials";

let world;
let serve;
let url;
let seedDir;
let savedUmask;

function writeAt(dir, rel, data) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}

const modeOf = (abs) => statSync(abs).mode & 0o777;

/** Every file and directory under `root` (the root included) with its mode: `{ rel: mode }`. */
function modesUnder(root) {
  const out = { ".": modeOf(root) };
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const child = rel ? `${rel}/${name}` : name;
      out[child] = modeOf(join(root, child));
      if (statSync(join(root, child)).isDirectory()) walk(child);
    }
  };
  walk("");
  return out;
}

function expectTight(root) {
  for (const [rel, mode] of Object.entries(modesUnder(root))) {
    const want = statSync(join(root, rel)).isDirectory() ? 0o700 : 0o600;
    expect({ rel, mode: mode.toString(8) }).toEqual({ rel, mode: want.toString(8) });
  }
}

/** Push from the seed clone with plain git (no daemon), as another machine would. */
function seedPush(files, message) {
  for (const [rel, data] of Object.entries(files)) writeAt(seedDir, rel, data);
  world.sh(VAULT_BIN, ["sync", "--root", join(seedDir, "vault")]);
  world.git(seedDir, ["add", "-A"]);
  world.git(seedDir, ["commit", "--quiet", "-m", message]);
  world.git(seedDir, ["push", "--quiet", "origin", "HEAD:main"]);
}

function client(name) {
  const dir = join(world.root, name);
  const env = { ...process.env, ...world.env, KUMA_VAULT_SYNC_DIR: join(world.root, `state-${name}`) };
  world.sh(VAULT_BIN, ["clone", url, dir, "--token-file", join(world.root, "token")], { extraEnv: env });
  world.git(dir, ["config", "kuma-vault.host", name]);
  const c = {
    dir,
    env,
    mem: null,
    async tick({ force = true } = {}) {
      const ctx = await loadContext(dir, { env });
      if (!c.mem) c.mem = createMemory(ctx);
      return runTick(ctx, c.mem, { force });
    },
    cli: (args) => world.sh(process.execPath, [SYNC_CLI, ...args], { cwd: dir, extraEnv: env, allowFail: true }),
  };
  return c;
}

beforeAll(async () => {
  savedUmask = process.umask(0o022); // git, serve and its hooks inherit it: checkouts at 0644/0755
  world = createWorld("kv-credmodes-");
  serve = await startServe(world);
  url = `http://127.0.0.1:${serve.port}/v1/stores/s.git`;

  seedDir = join(world.root, "seed");
  world.sh(VAULT_BIN, ["clone", url, seedDir, "--token-file", join(world.root, "token"), "--no-hook"]);
  writeAt(seedDir, ".gitattributes", fixtureAttributes("vault"));
  writeAt(seedDir, ".gitignore", fixtureGitignore({ tree: "vault" }));
  writeAt(seedDir, "README.md", "# credential modes fixture\n");
  writeAt(seedDir, "vault/vault.config.json", `${JSON.stringify({ profile: "kuma-vault" }, null, 2)}\n`);
  writeAt(seedDir, "vault/README.md", "# Vault\n");
  writeAt(seedDir, "vault/domains/notes/seed.md", "---\ntitle: Seed\ndescription: seed note\n---\n\n# Seed\n");
  seedPush({
    [`${CRED}/service-a.json`]: '{"token":"synthetic-a"}\n',
    [`${CRED}/nested/service-b.json`]: '{"token":"synthetic-b"}\n',
    "vault/domains/team/_Credentials/service-c.json": '{"token":"synthetic-c"}\n', // any depth, any case
  }, "fixture");
}, 120_000);

afterAll(async () => {
  await serve?.stop();
  removeWorld(world);
  process.umask(savedUmask);
});

describe.sequential("credential modes", { timeout: 120_000 }, () => {
  let a;

  it("the server's tree/ keeps the credential directories at 0600/0700 after the push", () => {
    const tree = serve.paths.tree;
    expect(modeOf(join(tree, "vault/domains/notes/seed.md"))).toBe(0o644); // the umask, everywhere else
    expectTight(join(tree, CRED));
    expectTight(join(tree, "vault/domains/team/_Credentials"));
  });

  it("a push that leaves a credential unchanged does not rewrite it in tree/ (no umask window)", async () => {
    // A chmod in a later second than the checkout (an operator's fix, a slow walk) leaves the
    // entry stat-dirty — git compares ctime by the second — and a forced checkout would write it
    // anew by the umask. Seen live: the first push after a manual chmod rewrote all of them.
    const file = join(serve.paths.tree, CRED, "nested/service-b.json");
    await new Promise((r) => setTimeout(r, 1100));
    chmodSync(file, 0o600); // same mode, new ctime
    const before = statSync(file);
    seedPush({ "vault/domains/notes/unrelated.md": "---\ntitle: Unrelated\ndescription: unrelated note\n---\n\n# Unrelated\n" }, "unrelated");
    expect(world.git(serve.paths.tree, ["rev-parse", "HEAD"]).stdout).toBe(world.git(seedDir, ["rev-parse", "HEAD"]).stdout);
    const after = statSync(file);
    // a rewrite shows in the mtime (ext4 hands the freed inode number straight back)
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode & 0o777).toBe(0o600);
  });

  it("vault clone under umask 022 leaves 0600 files and 0700 directories", () => {
    a = client("a");
    expect(modeOf(join(a.dir, "vault/domains/notes/seed.md"))).toBe(0o644);
    expect(modeOf(join(a.dir, "vault/domains/personal"))).toBe(0o755); // only the credential directory
    expectTight(join(a.dir, CRED));
    expectTight(join(a.dir, "vault/domains/team/_Credentials"));
  });

  it("a fast-forward that changes a credential and brings new ones keeps them 0600/0700", async () => {
    expect((await a.tick()).ok).toBe(true);
    seedPush({
      [`${CRED}/service-a.json`]: '{"token":"synthetic-a-2"}\n',
      [`${CRED}/service-new.json`]: '{"token":"synthetic-new"}\n',
      [`${CRED}/fresh-dir/service-d.json`]: '{"token":"synthetic-d"}\n',
      "vault/domains/other/_credentials/service-e.json": '{"token":"synthetic-e"}\n', // a new root
    }, "credentials change on the server");
    const result = await a.tick();
    expect(result.ok, result.status.lastError).toBe(true);
    expect(world.git(a.dir, ["rev-parse", "HEAD"]).stdout).toBe(world.git(seedDir, ["rev-parse", "HEAD"]).stdout);
    expectTight(join(a.dir, CRED));
    expectTight(join(a.dir, "vault/domains/other/_credentials"));
    expect(result.status.alerts.credentialModes).toMatchObject({ active: false, count: 0 });
    expect(world.git(a.dir, ["status", "--porcelain"]).stdout).toBe(""); // modes are not a change git sees
    // and the server's tree/ followed the push with the same modes
    expectTight(join(serve.paths.tree, CRED));
    expectTight(join(serve.paths.tree, "vault/domains/other/_credentials"));
  });

  it("a merge of diverged branches keeps them 0600/0700 too", async () => {
    writeAt(a.dir, "vault/domains/notes/local.md", "---\ntitle: Local\ndescription: local note\n---\n\n# Local\n");
    world.sh(VAULT_BIN, ["sync", "--root", join(a.dir, "vault")]);
    world.git(a.dir, ["add", "-A"]);
    world.git(a.dir, ["commit", "--quiet", "-m", "local"]);
    seedPush({ [`${CRED}/service-merge.json`]: '{"token":"synthetic-m"}\n' }, "server side");
    const result = await a.tick();
    expect(result.ok, result.status.lastError).toBe(true);
    expect(world.git(a.dir, ["log", "-1", "--format=%P"]).stdout.trim().split(" ")).toHaveLength(2);
    expectTight(join(a.dir, CRED));
  });

  it("the daemon tightens a credential someone loosened, and an untracked one", async () => {
    chmodSync(join(a.dir, CRED, "service-a.json"), 0o644);
    chmodSync(join(a.dir, CRED), 0o755);
    writeAt(a.dir, "vault/domains/local-only/_credentials/untracked.json", '{"token":"synthetic-u"}\n');
    const result = await a.tick({ force: false });
    expect(result.status.alerts.credentialModes).toMatchObject({ active: false, count: 0 });
    expectTight(join(a.dir, CRED));
    expectTight(join(a.dir, "vault/domains/local-only/_credentials"));
  });

  it("vault sync status raises credentialModes on a loose mode (read-only) and exits 2", () => {
    chmodSync(join(a.dir, CRED, "nested", "service-b.json"), 0o644);
    const out = a.cli(["sync", "status", "--json"]);
    expect(out.code).toBe(2);
    const status = JSON.parse(out.stdout);
    expect(status.alerts.credentialModes).toMatchObject({ active: true, count: 1, paths: [{ path: `${CRED}/nested/service-b.json`, mode: "0644", want: "0600" }] });
    expect(status.problems).toContain("경보 credentialModes");
    expect(JSON.stringify(status)).not.toContain("synthetic"); // modes and paths, never a value
    expect(modeOf(join(a.dir, CRED, "nested", "service-b.json"))).toBe(0o644); // status does not fix
    const text = a.cli(["sync", "status"]);
    expect(text.stdout).toMatch(/credentialModes 1 \[RED\] not 0600\/0700: vault\/domains\/personal\/_credentials\/nested\/service-b\.json 0644/);
  });

  it("a mode the daemon cannot fix stays in the state file's problems", async () => {
    const locked = join(a.dir, CRED, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "x.json"), '{"token":"synthetic-x"}\n');
    chmodSync(locked, 0o000); // the walk cannot read it: not tightened, not silently skipped
    try {
      const result = await a.tick();
      const alert = result.status.alerts.credentialModes;
      expect(alert.active).toBe(true);
      expect(alert.failed).toEqual([expect.objectContaining({ path: `${CRED}/locked`, error: "EACCES" })]);
      expect(statusProblems(result.status, { running: true })).toContain("경보 credentialModes");
    } finally {
      chmodSync(locked, 0o700);
    }
    const after = await a.tick();
    expect(after.status.alerts.credentialModes.active).toBe(false);
    expect(modeOf(join(locked, "x.json"))).toBe(0o600);
  });

  // launchd is macOS-only: on a Mac this would load a real user agent, so it runs elsewhere, where
  // install tightens the modes, prints its line, and then fails at launchd.
  it.skipIf(process.platform === "darwin")("vault sync install tightens an existing clone (migration)", () => {
    for (const rel of ["service-a.json", "nested/service-b.json"]) chmodSync(join(a.dir, CRED, rel), 0o644);
    chmodSync(join(a.dir, CRED, "nested"), 0o755);
    const out = a.cli(["sync", "install"]);
    expect(out.stdout).toMatch(/credential modes: \d+ path\(s\) under \d+ root\(s\), 3 tightened to 0600\/0700/);
    expectTight(join(a.dir, CRED));
  });
});

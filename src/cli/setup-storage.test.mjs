// `kuma-vault setup --storage …` end to end, through bin/vault, in an isolated HOME and
// KUMA_HOME_DIR: a local store, adopting a plain folder (and undoing it when a later step fails),
// refusing an existing git vault (a link to a tree inside a repository, as an installed Kuma has),
// and a server store over token auth (`vault serve` of the sync harness): first device seeds the
// empty store, second device clones it, `--add-store` adds an extra one.
// Needs git >= 2.38, git-lfs and Node 22.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VAULT_BIN, createWorld, removeWorld, startServe } from "../../scripts/test/sync-harness.mjs";
import { parseLfsPointer } from "../server/lfs-paths.mjs";
import { renderTreeRgignore } from "./policy-commands.mjs";
import { parseStorageOptions, renderStoreDeclaration, renderStoreGitattributes } from "./setup-storage.mjs";

let world;

function home(name) {
  const dir = join(world.root, name);
  mkdirSync(dir, { recursive: true });
  // a user home of its own, with the git identity and LFS filters a real user has in ~/.gitconfig
  copyFileSync(join(world.root, "home", ".gitconfig"), join(dir, ".gitconfig"));
  return {
    dir,
    kuma: join(dir, ".kuma"),
    env: { HOME: dir, KUMA_HOME_DIR: join(dir, ".kuma"), KUMA_VAULT_STORES: "", KUMA_VAULT_SYNC_DIR: join(dir, "sync-state") },
  };
}

function setup(h, args) {
  return world.sh(VAULT_BIN, ["setup", ...args], { extraEnv: h.env, allowFail: true });
}

function writeAt(dir, rel, data) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), data);
}

function listing(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(`${relative(dir, full)} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.sort();
}

function registry(h) {
  return JSON.parse(readFileSync(join(h.kuma, "vault-stores.json"), "utf8"));
}

beforeAll(() => {
  world = createWorld("kv-setup-");
});

afterAll(() => removeWorld(world));

describe("pure parts", () => {
  it("generates the LFS block and the union ledgers anchored at the tree", () => {
    const text = renderStoreGitattributes();
    expect(text).toContain("*.[pP][nN][gG] filter=lfs diff=lfs merge=lfs -text");
    expect(text).toContain("/vault/dispatch-log.md merge=union");
    expect(text).toContain("/vault/log.md merge=union");
  });

  it("writes the policy into a declaration and keeps what was there", () => {
    expect(renderStoreDeclaration("v", [])).toEqual({ profile: "kuma-vault", id: "v", visibility: "private", remotes: { allowed: [] }, binaries: { reject: [] } });
    const merged = renderStoreDeclaration("v", ["http://h:7741/v1/stores/v.git"], { profile: "kuma-vault", id: "v", remotes: { allowed: ["http://h:7741/v1/stores/v.git/"] }, binaries: { reject: ["a/**"] }, enrich: false });
    expect(merged.remotes.allowed).toEqual(["http://h:7741/v1/stores/v.git/"]);
    expect(merged.binaries.reject).toEqual(["a/**"]);
    expect(merged.enrich).toBe(false);
  });

  it("validates the flags", () => {
    expect(parseStorageOptions({ _: [] })).toBeNull();
    expect(() => parseStorageOptions({ _: [], storage: "cloud" })).toThrow(/local, oracle, remote/);
    expect(() => parseStorageOptions({ _: [], storage: "oracle" })).toThrow(/needs --server/);
    expect(() => parseStorageOptions({ _: [], storage: "local", server: "http://h" })).toThrow(/no server/);
    expect(() => parseStorageOptions({ _: [], storage: "remote", server: "http://h:7741/v1/stores/x.git" })).toThrow(/no path/);
    expect(() => parseStorageOptions({ _: [], "add-store": "work" })).toThrow(/needs --storage/);
    expect(() => parseStorageOptions({ _: [], "add-store": "work", storage: "local", adopt: true })).toThrow(/MAIN store/);
    expect(parseStorageOptions({ _: [], storage: "oracle", server: "http://h:7741/" })).toMatchObject({ mode: "remote", id: "kuma-main-vault", main: true, server: "http://h:7741" });
    expect(parseStorageOptions({ _: [], storage: "local", "add-store": "work" })).toMatchObject({ mode: "local", id: "work", main: false });
  });
});

describe.sequential("local", { timeout: 120_000 }, () => {
  it("creates the store, its policy and hooks, commits it, registers it and links the address", () => {
    const h = home("local");
    const run = setup(h, ["--storage", "local"]);
    expect(run.code, run.stderr + run.stdout).toBe(0);
    const repo = join(h.kuma, "vaults", "kuma-main-vault");
    const tree = join(repo, "vault");
    expect(readlinkSync(join(h.kuma, "vault"))).toBe(tree);
    const decl = JSON.parse(readFileSync(join(tree, "vault.config.json"), "utf8"));
    expect(decl).toMatchObject({ profile: "kuma-vault", id: "kuma-main-vault", visibility: "private", remotes: { allowed: [] } });
    expect(readFileSync(join(repo, ".gitattributes"), "utf8")).toContain("filter=lfs");
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(".fts/");
    expect(world.git(repo, ["show", "HEAD:vault/.rgignore"]).stdout).toBe(renderTreeRgignore(""));
    expect(world.git(repo, ["status", "--porcelain"]).stdout).toBe("");
    expect(world.git(repo, ["remote"]).stdout.trim()).toBe("");
    expect(readFileSync(join(repo, ".git/hooks/pre-commit"), "utf8")).toContain("kuma-vault-sync-hook");
    expect(readFileSync(join(repo, ".git/hooks/pre-push"), "utf8")).toContain("kuma-vault-push-hook");
    const reg = registry(h);
    expect(reg.default).toBe("kuma-main-vault");
    expect(reg.stores["kuma-main-vault"]).toMatchObject({ root: tree, mode: "local" });

    // P2: a hand-added remote is refused by the pre-push allowlist
    const bare = join(world.root, "public.git");
    world.git(world.root, ["init", "-q", "--bare", bare]);
    world.git(repo, ["remote", "add", "public", bare]);
    const push = world.sh("git", ["push", "public", "main"], { cwd: repo, extraEnv: h.env, allowFail: true });
    expect(push.code).not.toBe(0);
    expect(push.stderr).toMatch(/kuma-vault pre-push/);

    // again: nothing to do
    const again = setup(h, ["--storage", "local"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already set up/);
  });

  it("adds a second local store without touching the address", () => {
    const h = home("local");
    const run = setup(h, ["--add-store", "work-notes", "--storage", "local"]);
    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect(readlinkSync(join(h.kuma, "vault"))).toBe(join(h.kuma, "vaults", "kuma-main-vault", "vault"));
    const reg = registry(h);
    expect(reg.default).toBe("kuma-main-vault");
    expect(reg.stores["work-notes"]).toMatchObject({ mode: "local", root: join(h.kuma, "vaults", "work-notes", "vault") });
  });
});

describe.sequential("an existing ~/.kuma/vault", { timeout: 120_000 }, () => {
  it("refuses a link to a tree inside a git repository and changes nothing", () => {
    const h = home("gitlink");
    const brain = join(h.dir, "brain");
    writeAt(brain, "vault/vault.config.json", '{ "profile": "kuma-vault" }\n');
    writeAt(brain, "vault/README.md", "# brain\n");
    world.git(h.dir, ["init", "-q", brain]);
    world.git(brain, ["add", "-A"]);
    world.git(brain, ["commit", "-q", "-m", "brain"]);
    const head = world.git(brain, ["rev-parse", "HEAD"]).stdout;
    mkdirSync(h.kuma, { recursive: true });
    symlinkSync(join(brain, "vault"), join(h.kuma, "vault"));
    const before = listing(brain);

    for (const args of [["--storage", "local"], ["--storage", "local", "--adopt"], ["--storage", "remote", "--server", "http://127.0.0.1:9"]]) {
      const run = setup(h, args);
      expect(run.code).toBe(3);
      expect(run.stderr).toMatch(/inside the git repository .*brain/);
      expect(run.stderr).toMatch(/vault migrate to-remote/);
    }
    expect(readlinkSync(join(h.kuma, "vault"))).toBe(join(brain, "vault"));
    expect(existsSync(join(h.kuma, "vaults"))).toBe(false);
    expect(existsSync(join(h.kuma, "vault-stores.json"))).toBe(false);
    expect(listing(brain)).toEqual(before);
    expect(world.git(brain, ["rev-parse", "HEAD"]).stdout).toBe(head);
  });

  it("refuses a dangling link", () => {
    const h = home("dangling");
    mkdirSync(h.kuma, { recursive: true });
    symlinkSync(join(h.dir, "gone"), join(h.kuma, "vault"));
    const run = setup(h, ["--storage", "local"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toMatch(/does not exist/);
  });

  it("refuses a plain folder without --adopt, shows the plan with --dry-run, adopts with --adopt", () => {
    const h = home("adopt");
    const seed = join(h.kuma, "vault");
    writeAt(seed, "README.md", "# Kuma Vault\n\nseeded on first run\n");
    writeAt(seed, "plans/p/one.md", "# one\n");
    writeAt(seed, "domains/notes/a.md", "---\ntitle: A\ndescription: a note\n---\n\n# A\n");
    writeAt(seed, "domains/notes/pic.png", Buffer.alloc(4096, 7));
    mkdirSync(join(seed, "inbox"));
    const before = listing(seed);

    const refused = setup(h, ["--storage", "local"]);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toMatch(/existing folder: 4 files, \d+ bytes/);
    expect(refused.stderr).toMatch(/--adopt/);

    const dry = setup(h, ["--storage", "local", "--adopt", "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/adopt: +.*\(4 files, \d+ bytes\)/);
    expect(dry.stdout).toMatch(/dry run: nothing changed/);
    expect(lstatSync(seed).isDirectory()).toBe(true);
    expect(existsSync(join(h.kuma, "vaults"))).toBe(false);

    const run = setup(h, ["--storage", "local", "--adopt"]);
    expect(run.code, run.stderr + run.stdout).toBe(0);
    const [b] = /before: (\d+ files, \d+ bytes)/.exec(run.stdout).slice(1);
    const [a] = /after: +(\d+ files, \d+ bytes)/.exec(run.stdout).slice(1);
    expect(a).toBe(b);
    const repo = join(h.kuma, "vaults", "kuma-main-vault");
    expect(realpathSync(join(h.kuma, "vault"))).toBe(realpathSync(join(repo, "vault")));
    expect(world.git(repo, ["status", "--porcelain"]).stdout).toBe("");
    const pointer = world.git(repo, ["cat-file", "-p", "HEAD:vault/domains/notes/pic.png"]).stdout;
    expect(parseLfsPointer(Buffer.from(pointer))).not.toBeNull();
    for (const line of before) {
      const [path] = line.split(" ");
      if (path === "README.md") continue; // the root README may gain its index region
      expect(listing(join(repo, "vault"))).toContain(line);
    }
  });

  it("puts an adopted folder back, byte for byte, when a later step fails", () => {
    const h = home("adopt-undo");
    const seed = join(h.kuma, "vault");
    writeAt(seed, "README.md", "# Kuma Vault\n");
    writeAt(seed, "domains/notes/a.md", "# A\n");
    // a non-LFS file over 32 MiB: the pre-commit gate refuses the first commit
    writeAt(seed, "domains/notes/huge.bin", Buffer.alloc(33 * 1024 * 1024, 1));
    const before = listing(seed);

    const run = setup(h, ["--storage", "local", "--adopt"]);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toMatch(/setup failed/);
    expect(run.stdout).toMatch(/undone: move .* back to/);
    expect(run.stdout).toMatch(/restored .*: 3 files, \d+ bytes/);
    expect(lstatSync(seed).isDirectory()).toBe(true);
    expect(listing(seed)).toEqual(before);
    expect(existsSync(join(h.kuma, "vaults", "kuma-main-vault"))).toBe(false);
    expect(existsSync(join(h.kuma, "vault-stores.json"))).toBe(false);
  });
});

describe.sequential("server store (token auth)", { timeout: 180_000 }, () => {
  let serve;
  let server;

  beforeAll(async () => {
    serve = await startServe(world, { store: "kuma-main-vault" });
    server = `http://127.0.0.1:${serve.port}`;
  });

  afterAll(async () => {
    await serve?.stop();
  });

  it("token mode: health answers without a token, a store does not", async () => {
    expect((await fetch(`${server}/v1/health`)).status).toBe(200);
    expect((await fetch(`${server}/v1/stores/kuma-main-vault.git/info/refs?service=git-upload-pack`)).status).toBe(401);
  });

  it("refuses an unreachable server before changing anything", () => {
    const h = home("unreachable");
    const run = setup(h, ["--storage", "remote", "--server", "http://127.0.0.1:9", "--token-file", join(world.root, "token"), "--no-daemon"]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/does not answer \/v1\/health/);
    expect(existsSync(join(h.kuma, "vaults"))).toBe(false);
  });

  it("first device: adopts a folder into the empty store and pushes the first commit with its large file", () => {
    const h = home("device-1");
    const seed = join(h.kuma, "vault");
    writeAt(seed, "README.md", "# Kuma Vault\n");
    writeAt(seed, "domains/notes/a.md", "# A\n");
    writeAt(seed, "domains/notes/pic.png", Buffer.alloc(8192, 3));
    const run = setup(h, ["--storage", "remote", "--server", server, "--token-file", join(world.root, "token"), "--adopt", "--no-daemon"]);
    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect(run.stdout).toMatch(/pushed first commit/);
    const repo = join(h.kuma, "vaults", "kuma-main-vault");
    expect(serve.head()).toBe(world.git(repo, ["rev-parse", "HEAD"]).stdout.trim());
    const decl = JSON.parse(serve.show("main", "vault/vault.config.json").stdout);
    expect(decl.remotes.allowed).toEqual([`${server}/v1/stores/kuma-main-vault.git`]);
    expect(serve.show("main", "vault/.rgignore").stdout).toBe(renderTreeRgignore(""));
    const pointer = parseLfsPointer(Buffer.from(serve.show("main", "vault/domains/notes/pic.png").stdout));
    expect(serve.casHas(pointer.oid)).toBe(true);
    const entry = registry(h).stores["kuma-main-vault"];
    expect(entry).toMatchObject({ mode: "remote", remote: { server, store: "kuma-main-vault", tokenFile: join(repo, ".git/kuma-vault/token") } });
    expect(lstatSync(entry.remote.tokenFile).mode & 0o777).toBe(0o600);
    expect(readlinkSync(join(h.kuma, "vault"))).toBe(join(repo, "vault"));
  });

  it("second device: clones the store, no new commit; --adopt there is refused", () => {
    const head = serve.head();
    const h = home("device-2");
    const run = setup(h, ["--storage", "oracle", "--server", server, "--token-file", join(world.root, "token"), "--no-daemon"]);
    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect(serve.head()).toBe(head);
    const repo = join(h.kuma, "vaults", "kuma-main-vault");
    expect(readFileSync(join(repo, "vault/domains/notes/a.md"), "utf8")).toBe("# A\n");
    expect(readFileSync(join(repo, ".git/hooks/pre-push"), "utf8")).toContain("kuma-vault-push-hook");

    const h3 = home("device-3");
    writeAt(join(h3.kuma, "vault"), "x.md", "# x\n");
    const adopt = setup(h3, ["--storage", "remote", "--server", server, "--token-file", join(world.root, "token"), "--adopt", "--no-daemon"]);
    expect(adopt.code).not.toBe(0);
    expect(adopt.stdout + adopt.stderr).toMatch(/would mix two vaults/);
    expect(readFileSync(join(h3.kuma, "vault", "x.md"), "utf8")).toBe("# x\n");
    expect(existsSync(join(h3.kuma, "vaults", "kuma-main-vault"))).toBe(false);
    expect(serve.head()).toBe(head);
  });
});

describe.sequential("a local store moves to a token server (vault migrate to-remote)", { timeout: 180_000 }, () => {
  let serve;
  let server;

  beforeAll(async () => {
    serve = await startServe(world, { store: "moved" });
    server = `http://127.0.0.1:${serve.port}`;
  });

  afterAll(async () => {
    await serve?.stop();
  });

  it("pushes the history and leaves a token credential the daemon and plain git use", () => {
    const h = home("migrate");
    expect(setup(h, ["--add-store", "moved", "--storage", "local"]).code).toBe(0);
    const repo = join(h.kuma, "vaults", "moved");
    const tree = join(repo, "vault");
    const run = world.sh(VAULT_BIN, ["migrate", "to-remote", "--root", tree, "--server", server, "--token-file", join(world.root, "token")], { extraEnv: h.env, allowFail: true });
    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect(serve.head()).toBe(world.git(repo, ["rev-parse", "HEAD"]).stdout.trim());
    const tokenCopy = join(repo, ".git/kuma-vault/token");
    expect(lstatSync(tokenCopy).mode & 0o777).toBe(0o600);
    expect(world.git(repo, ["config", "--get", `credential.${server}.helper`]).stdout).toMatch(/kuma-vault\/token/);
    expect(registry(h).stores.moved).toMatchObject({ mode: "remote", remote: { server, store: "moved", tokenFile: tokenCopy } });

    // no extra header any more: git finds the token through the helper
    writeAt(tree, "notes/after.md", "# after\n");
    world.sh(VAULT_BIN, ["sync", "--root", tree], { extraEnv: h.env });
    world.git(repo, ["add", "-A"], { extraEnv: h.env });
    world.git(repo, ["commit", "-q", "-m", "after the move"], { extraEnv: h.env });
    const push = world.sh("git", ["push", "-q", "origin", "main"], { cwd: repo, extraEnv: h.env, allowFail: true });
    expect(push.code, push.stderr).toBe(0);
    expect(serve.show("main", "vault/notes/after.md").stdout).toBe("# after\n");
  });
});

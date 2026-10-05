// End-to-end: a remote store behind `vault serve` (own process). The file API reads one regular
// file from git objects; `vault migrate to-remote` moves a local store onto the server.
//
// Secrets: `_credentials/` and `_sync-conflicts/` (any depth, any case) and symlinks in the
// checkout — including ones that point outside the store — must not come out of the file API.
// The git transport itself is the sync channel and serves the whole tree to authorized clones by
// design; it is not that API. The search and timeline APIs (and the server index) are gone.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { renderLfsGitattributesLines } from "./lfs-paths.mjs";
import { hashToken, writeServerConfig } from "./server-config.mjs";
import { initStore, storePaths } from "./store-layout.mjs";

const VAULT_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vault");
const SERVER_CLI = join(dirname(fileURLToPath(import.meta.url)), "server-cli.mjs");
const TOKENS = { writer: "tok-writer", reader: "tok-reader" };
const SECRET_MARKERS = ["SECRET-CRED", "SECRET-CASE", "SECRET-CONFLICT", "SECRET-OUTSIDE", "root:x:0:0"];

let root;
let home;
let serve;
let base;
let store;
let clone;
let registryPath;
let tokenFile;
let firstCommit;

function sh(cmd, args, { cwd, input, allowFail = false, env = {} } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      ...env,
    },
  });
  const out = { code: result.status, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
  if (out.code !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")} (${out.code})\n${out.stderr}\n${out.stdout}`);
  return out;
}

const git = (cwd, args, opts) => sh("git", args, { cwd, ...opts });

function writeIn(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

async function api(path, { method = "GET", token = TOKENS.reader, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function vault(args, { env = {}, allowFail = true } = {}) {
  return sh(VAULT_BIN, args, { cwd: clone, allowFail, env: { KUMA_VAULT_STORES: registryPath, KUMA_VAULT_DIR: join(clone, "vault"), ...env } });
}

function pushHead() {
  git(clone, ["push", "--quiet", "origin", "HEAD:main"]);
  return git(clone, ["rev-parse", "HEAD"]).stdout.trim();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "kv-remote-it-"));
  home = join(root, "home");
  mkdirSync(home);
  const storeRoot = join(root, "stores", "brain");
  const configPath = join(root, "server.json");
  writeServerConfig(configPath, {
    version: 1,
    listen: ["127.0.0.1:0"],
    dataDir: join(root, "stores"),
    diskReserveGB: 0.001,
    tokens: [
      { id: "w", sha256: hashToken(TOKENS.writer), role: "writer", stores: ["*"] },
      { id: "r", sha256: hashToken(TOKENS.reader), role: "reader", stores: ["*"] },
    ],
    stores: { brain: { path: storeRoot }, moved: { path: join(root, "stores", "moved") }, rawhist: { path: join(root, "stores", "rawhist") } },
  });
  await initStore(storeRoot, { vaultBin: VAULT_BIN });
  await initStore(join(root, "stores", "moved"), { vaultBin: VAULT_BIN });
  await initStore(join(root, "stores", "rawhist"), { vaultBin: VAULT_BIN });
  store = storePaths(storeRoot);
  serve = spawn(process.execPath, [SERVER_CLI, "serve", "--config", configPath], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    let buffered = "";
    serve.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const match = /"event":"listening","listen":"127\.0\.0\.1:(\d+)"/.exec(buffered);
      if (match) resolve(Number(match[1]));
    });
    serve.on("exit", (code) => reject(new Error(`serve exited ${code}`)));
  });
  base = `http://127.0.0.1:${port}`;

  clone = join(root, "clone");
  sh("git", ["-c", `http.extraHeader=Authorization: Bearer ${TOKENS.writer}`, "clone", "--quiet", `${base}/v1/stores/brain.git`, clone], { cwd: root });
  git(clone, ["config", "http.extraHeader", `Authorization: Bearer ${TOKENS.writer}`]);
  git(clone, ["config", "user.name", "tester"]);
  git(clone, ["config", "user.email", "tester@test.invalid"]);

  tokenFile = join(home, "reader-token.json");
  writeFileSync(tokenFile, JSON.stringify({ token: TOKENS.reader }));
  registryPath = join(home, "vault-stores.json");
  writeFileSync(registryPath, JSON.stringify({
    version: 2,
    default: "brain",
    stores: { brain: { root: join(clone, "vault"), mode: "remote", remote: { server: base, store: "brain", tokenFile } } },
  }));
}, 30_000);

afterAll(() => {
  serve?.kill("SIGTERM");
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("remote store — file API, secrets, no search index", { timeout: 60_000 }, () => {
  it("takes a push whose checkout carries secrets and symlinks out of the store", async () => {
    writeFileSync(join(root, "outside.md"), "# outside\n\nzebracorn SECRET-OUTSIDE\n");
    writeIn(clone, "README.md", "# brain\n");
    writeIn(clone, "vault/vault.config.json", JSON.stringify({ id: "brain", profile: "kuma-vault", visibility: "private" }));
    writeIn(clone, "vault/domains/x/alpha.md", "---\ntitle: Alpha\n---\n\n# Alpha\n\nzebracorn alpha line\n");
    writeIn(clone, "vault/domains/x/gamma.md", "# Gamma\n\nunrelated words\n");
    writeIn(clone, "vault/_credentials/token.md", "# token\n\nzebracorn SECRET-CRED\n");
    writeIn(clone, "vault/domains/_Credentials/k.md", "# k\n\nzebracorn SECRET-CASE\n");
    writeIn(clone, "vault/_sync-conflicts/20261005-000000-mbp/vault/plans/p.md", "# p\n\nzebracorn SECRET-CONFLICT\n");
    mkdirSync(join(clone, "vault/domains/links"), { recursive: true });
    symlinkSync(join(root, "outside.md"), join(clone, "vault/domains/links/abs-leak.md"));
    symlinkSync("../../../../../../../../../../etc/passwd", join(clone, "vault/domains/links/passwd.md"));
    git(clone, ["add", "-A"]);
    git(clone, ["commit", "--quiet", "-m", "first"]);
    firstCommit = pushHead();
    // the threat is real: the follow-only checkout carries both symlinks
    expect(lstatSync(join(store.tree, "vault/domains/links/abs-leak.md")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(store.tree, "vault/domains/links/passwd.md")).isSymbolicLink()).toBe(true);
  });

  it("has no search or timeline API and builds no index", async () => {
    for (const verb of ["search", "timeline"]) {
      const res = await api(`/v1/stores/brain/${verb}`, { method: "POST", body: { q: "zebracorn" } });
      expect(res.status).toBe(404);
      for (const marker of SECRET_MARKERS) expect(res.text).not.toContain(marker);
    }
    expect(existsSync(join(dirname(store.state), "index"))).toBe(false);
    expect(existsSync(join(store.state, "index.json"))).toBe(false);
  });

  it("file serves regular files from git objects and refuses secrets, symlinks, .git and traversal", async () => {
    const ok = await api("/v1/stores/brain/file?path=domains/x/alpha.md");
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("zebracorn alpha line");
    expect(ok.headers.get("x-vault-commit")).toBe(firstCommit);
    const refused = {
      "_credentials/token.md": 403,
      "_CREDENTIALS/token.md": 403,
      "domains/_Credentials/k.md": 403,
      "_sync-conflicts/20261005-000000-mbp/vault/plans/p.md": 403,
      "domains/links/abs-leak.md": 403,
      "domains/links/passwd.md": 403,
      ".git/config": 403,
      "../outside.md": 400,
      "/etc/passwd": 400,
      "domains/x": 403,
      "domains/x/missing.md": 404,
    };
    for (const [path, status] of Object.entries(refused)) {
      const res = await api(`/v1/stores/brain/file?path=${encodeURIComponent(path)}`);
      expect([path, res.status]).toEqual([path, status]);
      for (const marker of SECRET_MARKERS) expect(res.text).not.toContain(marker);
    }
    const bad = await api(`/v1/stores/brain/file?path=domains/x/alpha.md&rev=${"f".repeat(40)}`);
    expect(bad.status).toBe(404);
    const noToken = await fetch(`${base}/v1/stores/brain/file?path=domains/x/alpha.md`);
    expect(noToken.status).toBe(401);
  });

  it("an older revision stays readable by sha after a later push", async () => {
    git(clone, ["rm", "--quiet", "vault/domains/x/alpha.md"]);
    git(clone, ["commit", "--quiet", "-m", "second"]);
    pushHead();
    expect((await api("/v1/stores/brain/file?path=domains/x/alpha.md")).status).toBe(404);
    const old = await api(`/v1/stores/brain/file?path=domains/x/alpha.md&rev=${firstCommit}`);
    expect(old.status).toBe(200);
    expect(old.text).toContain("zebracorn alpha line");
  });

  it("the commit gate of a remote store builds no local .fts", () => {
    const out = vault(["sync", "--check", "--root", join(clone, "vault")]);
    expect(out.stdout).not.toMatch(/^fts:/mu);
    expect(existsSync(join(clone, "vault", ".fts"))).toBe(false);
  });
});

describe("vault migrate to-remote", { timeout: 60_000 }, () => {
  function localStore(name) {
    const dir = join(root, name);
    mkdirSync(join(dir, "vault"), { recursive: true });
    git(dir, ["init", "--quiet", "-b", "main"]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "user.email", "t@test.invalid"]);
    git(dir, ["lfs", "install", "--local"]);
    writeIn(dir, "vault/vault.config.json", JSON.stringify({ id: name, profile: "docs" }));
    writeIn(dir, "vault/note.md", "# note\n");
    return dir;
  }

  it("a local LFS store moves: allowlist commit, push with LFS objects, registry entry, pre-push hook", async () => {
    const dir = localStore("moved");
    writeIn(dir, ".gitattributes", `${renderLfsGitattributesLines().join("\n")}\n`);
    writeIn(dir, "vault/pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "--quiet", "--no-verify", "-m", "local history"]);
    const writerToken = join(home, "writer-token");
    writeFileSync(writerToken, `${TOKENS.writer}\n`);
    const registry = join(home, "moved-stores.json");
    const out = sh(VAULT_BIN, ["migrate", "to-remote", "--root", join(dir, "vault"), "--server", base, "--token-file", writerToken], {
      cwd: dir,
      allowFail: true,
      env: { KUMA_VAULT_STORES: registry },
    });
    expect(out.code, `${out.stderr}\n${out.stdout}`).toBe(0);
    const report = JSON.parse(out.stdout);
    const url = `${base}/v1/stores/moved.git`;
    expect(report).toMatchObject({ store: "moved", url, remote: "origin" });
    const config = JSON.parse(readFileSync(join(dir, "vault/vault.config.json"), "utf8"));
    expect(config).toMatchObject({ visibility: "private", remotes: { allowed: [url] } });
    const serverHead = git(root, ["--git-dir", join(root, "stores", "moved", "origin.git"), "rev-parse", "main"]).stdout.trim();
    expect(serverHead).toBe(git(dir, ["rev-parse", "HEAD"]).stdout.trim());
    expect(readFileSync(join(dir, ".git/hooks/pre-push"), "utf8")).toContain("kuma-vault-push-hook");
    const entry = JSON.parse(readFileSync(registry, "utf8")).stores.moved;
    // the token is copied behind the clone's credential helper; the registry points at the copy
    const tokenCopy = join(dir, ".git/kuma-vault/token");
    expect(entry).toMatchObject({ mode: "remote", remote: { server: base, store: "moved", tokenFile: tokenCopy } });
    expect(entry).not.toHaveProperty("search");
    expect(readFileSync(tokenCopy, "utf8").trim()).toBe(readFileSync(writerToken, "utf8").trim());
    // and now a push anywhere else is refused by the hook
    const elsewhere = join(root, "elsewhere.git");
    git(root, ["init", "--quiet", "--bare", elsewhere]);
    const refused = git(dir, ["push", elsewhere, "main"], { allowFail: true });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("허용 목록 밖");
  });

  it("refuses a store whose history holds raw binaries (it needs the rewrite)", () => {
    const dir = localStore("rawhist");
    writeIn(dir, "vault/raw.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "--quiet", "--no-verify", "-m", "raw png"]);
    const out = sh(VAULT_BIN, ["migrate", "to-remote", "--root", join(dir, "vault"), "--server", base], {
      cwd: dir,
      allowFail: true,
      env: { KUMA_VAULT_STORES: join(home, "raw-stores.json") },
    });
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("history rewrite");
    expect(git(root, ["--git-dir", join(root, "stores", "rawhist", "origin.git"), "rev-parse", "--verify", "--quiet", "main"], { allowFail: true }).code).not.toBe(0);
  });
});

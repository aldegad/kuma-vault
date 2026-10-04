// vault serve behind a TLS reverse proxy on the same machine (docs/server.md, Behind a reverse
// proxy): the LFS batch hands back hrefs with the scheme and host the client used, taken from
// X-Forwarded-Proto / X-Forwarded-Host only when the request comes from loopback. A real
// git-lfs push goes through an HTTPS proxy that, like a default nginx, rewrites Host to the
// upstream — so both the scheme and the host of every href must come from the proxy's headers.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { renderLfsGitattributesLines } from "./lfs-paths.mjs";
import { hashToken, writeServerConfig } from "./server-config.mjs";
import { casObjectPath, initStore, storePaths } from "./store-layout.mjs";

const VAULT_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vault");
const SERVER_CLI = join(dirname(fileURLToPath(import.meta.url)), "server-cli.mjs");
const TOKEN = "tok-writer";
const OUTSIDE = Object.values(networkInterfaces()).flat().find((e) => e && e.family === "IPv4" && !e.internal)?.address;

let root;
let home;
let store;
let serve;
let loopPort;
let outsidePort;
let proxy;
let proxyBase;
const proxied = [];

/** Async, so the in-process proxy keeps serving while git runs. */
function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

async function batch(target, headers = {}) {
  const response = await fetch(`${target}/v1/stores/s.git/info/lfs/objects/batch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/vnd.git-lfs+json", ...headers },
    body: JSON.stringify({ operation: "upload", objects: [{ oid: "e".repeat(64), size: 10 }] }),
  });
  const text = await response.text();
  return { status: response.status, body: response.status === 200 ? JSON.parse(text) : text };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "kv-serve-proxy-"));
  home = join(root, "home");
  mkdirSync(home);
  spawnSync("git", ["lfs", "install", "--skip-repo"], { cwd: root, env: { ...process.env, HOME: home } });
  const storeRoot = join(root, "stores", "s");
  const configPath = join(root, "server.json");
  writeServerConfig(configPath, {
    version: 1,
    listen: ["127.0.0.1:0", ...(OUTSIDE ? [`${OUTSIDE}:0`] : [])],
    dataDir: join(root, "stores"),
    diskReserveGB: 0.001,
    auth: { mode: "token" },
    tokens: [{ id: "w", sha256: hashToken(TOKEN), role: "writer", stores: ["s"] }],
    stores: { s: { path: storeRoot } },
  });
  await initStore(storeRoot, { vaultBin: VAULT_BIN });
  store = storePaths(storeRoot);
  serve = spawn(process.execPath, [SERVER_CLI, "serve", "--config", configPath], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    let buffered = "";
    serve.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      loopPort ??= Number(/"event":"listening","listen":"127\.0\.0\.1:(\d+)"/.exec(buffered)?.[1]) || undefined;
      if (OUTSIDE) outsidePort ??= Number(new RegExp(`"event":"listening","listen":"${OUTSIDE.replaceAll(".", "\\.")}:(\\d+)"`).exec(buffered)?.[1]) || undefined;
      if (loopPort && (!OUTSIDE || outsidePort)) resolve();
    });
    serve.on("exit", (code) => reject(new Error(`serve exited ${code}`)));
  });

  // A self-signed TLS proxy on loopback, forwarding to serve the way a default nginx does:
  // Host becomes the upstream address, the client's Host goes in X-Forwarded-Host.
  const key = join(root, "proxy.key");
  const cert = join(root, "proxy.crt");
  const ssl = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", cert]);
  if (ssl.status !== 0) throw new Error(`openssl: ${ssl.stderr}`);
  proxy = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    proxied.push(`${req.method} ${req.url}`);
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: loopPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${loopPort}`, "x-forwarded-proto": "https", "x-forwarded-host": req.headers.host },
    }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyBase = `https://127.0.0.1:${proxy.address().port}`;
}, 30_000);

afterAll(async () => {
  serve?.kill("SIGTERM");
  proxy?.closeAllConnections();
  await new Promise((resolve) => (proxy ? proxy.close(resolve) : resolve()));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("vault serve behind a reverse proxy", { timeout: 60_000 }, () => {
  it("a direct request gets http hrefs on the Host it named", async () => {
    const { status, body } = await batch(`http://127.0.0.1:${loopPort}`);
    expect(status).toBe(200);
    expect(body.objects[0].actions.upload.href).toBe(`http://127.0.0.1:${loopPort}/v1/stores/s.git/info/lfs/objects/${"e".repeat(64)}`);
    expect(body.objects[0].actions.verify.href).toBe(`http://127.0.0.1:${loopPort}/v1/stores/s.git/info/lfs/objects/verify`);
  });

  it("from loopback, X-Forwarded-Proto and X-Forwarded-Host set the hrefs (first value of a list)", async () => {
    const { status, body } = await batch(`http://127.0.0.1:${loopPort}`, { "X-Forwarded-Proto": "HTTPS, http", "X-Forwarded-Host": "vault.example.org, inner:1" });
    expect(status).toBe(200);
    expect(body.objects[0].actions.upload.href).toBe(`https://vault.example.org/v1/stores/s.git/info/lfs/objects/${"e".repeat(64)}`);
    expect(body.objects[0].actions.verify.href).toBe("https://vault.example.org/v1/stores/s.git/info/lfs/objects/verify");
  });

  it("from loopback, a forwarded value that is not a scheme or a host[:port] is refused, not passed into an href", async () => {
    for (const headers of [
      { "X-Forwarded-Host": "evil.example/x?" },
      { "X-Forwarded-Host": "user@evil.example" },
      { "X-Forwarded-Proto": "javascript" },
    ]) {
      const { status } = await batch(`http://127.0.0.1:${loopPort}`, headers);
      expect(status, JSON.stringify(headers)).toBe(400);
    }
  });

  it.skipIf(!OUTSIDE)("from a non-loopback address, forged X-Forwarded-* are ignored", async () => {
    const { status, body } = await batch(`http://${OUTSIDE}:${outsidePort}`, { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "evil.example" });
    expect(status).toBe(200);
    expect(body.objects[0].actions.upload.href).toBe(`http://${OUTSIDE}:${outsidePort}/v1/stores/s.git/info/lfs/objects/${"e".repeat(64)}`);
    expect(body.objects[0].actions.verify.href).toBe(`http://${OUTSIDE}:${outsidePort}/v1/stores/s.git/info/lfs/objects/verify`);
    // and a bad one is not judged at all from there
    expect((await batch(`http://${OUTSIDE}:${outsidePort}`, { "X-Forwarded-Host": "evil.example/x?" })).status).toBe(200);
  });

  it("forwarded headers do not stand in for a token", async () => {
    const response = await fetch(`http://127.0.0.1:${loopPort}/v1/stores/s.git/info/lfs/objects/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.git-lfs+json", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "vault.example.org", "X-Forwarded-For": "100.64.0.5" },
      body: JSON.stringify({ operation: "upload", objects: [] }),
    });
    expect(response.status).toBe(401);
  });

  it("git-lfs pushes an LFS file through the HTTPS proxy: upload and verify go back through it", async () => {
    const dir = join(root, "clone");
    const auth = `http.extraHeader=Authorization: Bearer ${TOKEN}`;
    let r = await run("git", ["-c", auth, "-c", "http.sslVerify=false", "clone", "--quiet", `${proxyBase}/v1/stores/s.git`, dir], { cwd: root });
    expect(r.code, r.stderr).toBe(0);
    for (const [k, v] of [
      ["http.extraHeader", `Authorization: Bearer ${TOKEN}`],
      ["http.sslVerify", "false"],
      ["user.name", "proxy"],
      ["user.email", "proxy@test.invalid"],
      [`lfs.${proxyBase}/v1/stores/s.git/info/lfs.locksverify`, "false"],
    ]) await run("git", ["config", k, v], { cwd: dir });
    await run("git", ["lfs", "install", "--local"], { cwd: dir });
    const png = randomBytes(3 * 1024 * 1024);
    writeFileSync(join(dir, ".gitattributes"), `${renderLfsGitattributesLines().join("\n")}\n`);
    mkdirSync(join(dir, "vault"), { recursive: true });
    writeFileSync(join(dir, "vault/photo.png"), png);
    await run("git", ["add", "-A"], { cwd: dir });
    await run("git", ["commit", "--quiet", "-m", "photo"], { cwd: dir });
    proxied.length = 0;
    r = await run("git", ["push", "--quiet", "origin", "HEAD:main"], { cwd: dir });
    expect(r.code, r.stderr).toBe(0);

    const oid = createHash("sha256").update(png).digest("hex");
    expect(readFileSync(casObjectPath(store.lfsObjects, oid)).equals(png)).toBe(true);
    expect(proxied).toContain(`PUT /v1/stores/s.git/info/lfs/objects/${oid}`);
    expect(proxied).toContain("POST /v1/stores/s.git/info/lfs/objects/verify");
  });
});

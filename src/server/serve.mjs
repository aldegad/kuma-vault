// `vault serve` — the server side of remote vault stores (docs/server.md).
//
//   GET  /v1/health                                       anonymous (store details only to their readers)
//   GET  /v1/stores/<id>.git/info/refs?service=...         git smart HTTP via `git http-backend`
//   POST /v1/stores/<id>.git/git-upload-pack               reader
//   POST /v1/stores/<id>.git/git-receive-pack              writer (pre-receive = vault server receive-check)
//   POST /v1/stores/<id>.git/info/lfs/objects/batch        LFS batch API, basic transfer
//   PUT  /v1/stores/<id>.git/info/lfs/objects/<oid>        writer — CAS upload (hash-verified)
//   GET  /v1/stores/<id>.git/info/lfs/objects/<oid>        reader
//   POST /v1/stores/<id>.git/info/lfs/objects/verify       writer
//   GET  /v1/stores/<id>/events?after=<seq>                reader — long-poll (25s)
//   GET  /v1/stores/<id>/backup-status                     reader
//   POST /v1/stores/<id>/search  {q, limit, mode}          reader — server index (search-index.mjs)
//   POST /v1/stores/<id>/timeline {q, limit}               reader — same, timeline snippets
//   GET  /v1/stores/<id>/file?path=&rev=                   reader — one regular file from git objects
//
// Search and file never read `tree/` (a checkout may hold symlinks) and never serve
// `_credentials/` or `_sync-conflicts/` paths.
//
// Everything except health needs an identity (auth.mjs); requests from the server itself
// need a token. Logs carry paths, sizes and oids — never content.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createIdentifier, isLoopback, normalizeAddress } from "./auth.mjs";
import { CasError, casPut, casReadStream, casStat, casUsage } from "./cas.mjs";
import { isLfsOid } from "./lfs-paths.mjs";
import { diskFreeBytes } from "./receive-check.mjs";
import { FileRequestError, IndexNotReadyError, readServedFile, searchStoreIndex, startIndexer } from "./search-index.mjs";
import { ROLE_LEVEL, loadServerConfig, parseListenAddress, roleName, storeRole } from "./server-config.mjs";
import { cleanGitEnv, runGit, storePaths } from "./store-layout.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
const LFS_JSON = "application/vnd.git-lfs+json";
const LONG_POLL_MS = 25_000;
const GROWTH_REFRESH_MS = 10 * 60_000;
const MAX_JSON_BODY = 16 * 1024 * 1024;
// An LFS PUT must bring minBytes (or the rest of its body) in every window, or it is cut and its
// reservation released: about 17KiB/s, far below any real link
const UPLOAD_PACE = { windowMs: 60_000, minBytes: 1024 * 1024 };

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function sendJson(res, status, body, contentType = "application/json") {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

const HOST_SYNTAX = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function firstForwarded(value) {
  if (typeof value !== "string") return "";
  return value.split(",")[0].trim();
}

/**
 * The scheme and host the client used, for the hrefs an LFS batch hands back
 * (docs/server.md, Behind a reverse proxy). X-Forwarded-Proto / X-Forwarded-Host count only
 * from loopback — a reverse proxy on this machine; from anywhere else they are ignored. They
 * never take part in identity (auth.mjs reads the socket address and the token only).
 */
export function externalOrigin(req) {
  let scheme = "http";
  let host = req.headers.host;
  if (isLoopback(normalizeAddress(req.socket.remoteAddress))) {
    const proto = firstForwarded(req.headers["x-forwarded-proto"]).toLowerCase();
    if (proto === "http" || proto === "https") scheme = proto;
    else if (proto) throw new HttpError(400, `X-Forwarded-Proto is not http or https: ${proto}`);
    const forwardedHost = firstForwarded(req.headers["x-forwarded-host"]);
    if (forwardedHost) host = forwardedHost;
  }
  if (typeof host !== "string" || !HOST_SYNTAX.test(host)) throw new HttpError(400, "Host is not a host[:port]");
  return `${scheme}://${host}`;
}

function principalLabel(principal) {
  if (!principal) return "-";
  if (principal.kind === "node") return `node:${principal.name}`;
  return principal.name;
}

/** Run `git http-backend` as CGI: request body -> stdin, CGI headers + body -> response. */
function gitHttpBackend(req, res, { storeRoot, pathInfo, env }) {
  return new Promise((resolve) => {
    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let headerDone = false;
    let pending = Buffer.alloc(0);
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdout.on("data", (chunk) => {
      if (headerDone) {
        res.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      let end = pending.indexOf("\r\n\r\n");
      let sepLength = 4;
      if (end < 0) {
        end = pending.indexOf("\n\n");
        sepLength = 2;
      }
      if (end < 0) return;
      const headerText = pending.subarray(0, end).toString("latin1");
      const body = pending.subarray(end + sepLength);
      let status = 200;
      const headers = {};
      for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") status = Number.parseInt(value, 10) || 500;
        else headers[key] = value;
      }
      headerDone = true;
      res.writeHead(status, headers);
      if (body.length) res.write(body);
    });
    child.on("error", (error) => {
      if (!headerDone) sendJson(res, 500, { error: `git http-backend failed: ${error.message}` });
      resolve();
    });
    child.on("close", (code) => {
      if (!headerDone) {
        sendJson(res, 500, { error: `git http-backend exited ${code}`, detail: Buffer.concat(stderr).toString("utf8").slice(0, 400) });
      } else {
        res.end();
      }
      if (code !== 0) {
        process.stderr.write(`[serve] http-backend ${pathInfo} exit ${code}: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 400)}\n`);
      }
      resolve();
    });
    child.stdin.on("error", () => {});
    req.pipe(child.stdin);
    void storeRoot;
  });
}

export function createServeApp({ configPath, config: initialConfig, identifierOptions = {}, uploadPace = UPLOAD_PACE, log = (line) => process.stdout.write(`${line}\n`) }) {
  let config = initialConfig ?? loadServerConfig(configPath);
  let identify = createIdentifier(config, identifierOptions);
  let configMtime = configPath && existsSync(configPath) ? statSync(configPath).mtimeMs : 0;
  let configCheckedAt = Date.now();
  let configError = null;
  const growth = new Map(); // storeId -> { computedAt, objects, bytes, windowBytes }
  // Bytes promised to LFS uploads in flight, per filesystem (st_dev). A PUT reserves its whole
  // Content-Length before it reads a byte and gives it back when it ends, so two uploads at
  // once cannot both spend the same free space. Check and reserve run in one synchronous step
  // (no await between them), which is atomic in this single-threaded process. Bytes an upload
  // has already written count twice (free space and reservation) until it ends: the error
  // is toward refusing.
  const reserved = new Map();

  function diskShortage(path, bytes) {
    const free = diskFreeBytes(path) - (reserved.get(statSync(path).dev) ?? 0);
    if (free - bytes >= config.diskReserveGB * 1e9) return null;
    return new HttpError(507, `서버 디스크 부족(여유 ${(free / 1e9).toFixed(1)}GB, 예비 ${config.diskReserveGB}GB)`);
  }

  /** Reserve `bytes` on `path`'s filesystem or throw 507. Returns the release function (idempotent). */
  function reserveDisk(path, bytes) {
    const shortage = diskShortage(path, bytes);
    if (shortage) throw shortage;
    const dev = statSync(path).dev;
    reserved.set(dev, (reserved.get(dev) ?? 0) + bytes);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = reserved.get(dev) - bytes;
      if (left > 0) reserved.set(dev, left);
      else reserved.delete(dev);
    };
  }

  function maybeReloadConfig() {
    if (!configPath || Date.now() - configCheckedAt < 1000) return;
    configCheckedAt = Date.now();
    let mtime;
    try {
      mtime = statSync(configPath).mtimeMs;
    } catch (error) {
      configError = `cannot stat ${configPath}: ${error.message}`;
      return;
    }
    if (mtime === configMtime) return;
    try {
      config = loadServerConfig(configPath);
      identify = createIdentifier(config, identifierOptions);
      configMtime = mtime;
      configError = null;
      log(JSON.stringify({ ts: new Date().toISOString(), event: "config-reloaded" }));
    } catch (error) {
      configError = error.message;
      configMtime = mtime;
      log(JSON.stringify({ ts: new Date().toISOString(), event: "config-reload-failed", error: error.message }));
    }
  }

  async function refreshGrowth() {
    for (const [id, store] of Object.entries(config.stores)) {
      try {
        const usage = await casUsage(storePaths(store.path).lfsObjects, { windowMs: config.growthAlert.windowDays * 86_400_000 });
        growth.set(id, { computedAt: new Date().toISOString(), ...usage });
      } catch (error) {
        growth.set(id, { computedAt: null, error: error.message });
      }
    }
  }

  function requireRole(storeId, principal, need) {
    const have = storeRole(config, storeId, principal);
    if (have === ROLE_LEVEL.none) throw new HttpError(404, `no such store: ${storeId}`);
    if (have < need) throw new HttpError(403, `${principalLabel(principal)} is ${roleName(have)} on ${storeId}; this needs ${roleName(need)}`);
    return have;
  }

  async function storeHead(store) {
    const { stdout, code } = await runGit(["--git-dir", storePaths(store.path).gitDir, "rev-parse", "--verify", "--quiet", "refs/heads/main"], { allowFail: true });
    return code === 0 ? stdout.toString("utf8").trim() : null;
  }

  async function handleHealth(req, res, principal) {
    const dataFree = (() => {
      try {
        return diskFreeBytes(existsSync(config.dataDir) ? config.dataDir : "/");
      } catch {
        return null;
      }
    })();
    const freeGB = dataFree === null ? null : Number((dataFree / 1e9).toFixed(2));
    let diskAlert = null;
    if (freeGB !== null && freeGB < config.diskReserveGB) diskAlert = "reserve";
    else if (freeGB !== null && freeGB < config.diskWarnGB) diskAlert = "low";
    const thresholdBytes = config.growthAlert.thresholdGB * 1e9;
    const over = [...growth.entries()].filter(([, g]) => g.windowBytes >= thresholdBytes);
    const visible = principal ? Object.keys(config.stores).filter((id) => storeRole(config, id, principal) >= ROLE_LEVEL.reader) : [];
    const stores = [];
    for (const id of visible) {
      const store = config.stores[id];
      const g = growth.get(id) ?? null;
      stores.push({
        id,
        kind: store.kind,
        head: await storeHead(store),
        role: roleName(storeRole(config, id, principal)),
        cas: g ? { objects: g.objects ?? null, bytes: g.bytes ?? null, windowBytes: g.windowBytes ?? null, computedAt: g.computedAt } : null,
      });
    }
    sendJson(res, 200, {
      ok: configError === null,
      service: "kuma-vault-serve",
      version: VERSION,
      now: new Date().toISOString(),
      diskFreeGB: freeGB,
      diskReserveGB: config.diskReserveGB,
      diskWarnGB: config.diskWarnGB,
      diskAlert,
      growthAlert: over.length === 0
        ? null
        : {
            windowDays: config.growthAlert.windowDays,
            thresholdGB: config.growthAlert.thresholdGB,
            count: over.length,
            stores: over.filter(([id]) => visible.includes(id)).map(([id, g]) => ({ id, windowGB: Number((g.windowBytes / 1e9).toFixed(2)) })),
          },
      configError,
      stores,
    });
  }

  async function handleGit(req, res, { storeId, rest, principal, url }) {
    const service = url.searchParams.get("service");
    let need;
    if (rest === "info/refs" && req.method === "GET") {
      if (service === "git-upload-pack") need = ROLE_LEVEL.reader;
      else if (service === "git-receive-pack") need = ROLE_LEVEL.writer;
      else throw new HttpError(403, "only the smart protocol is served");
    } else if (rest === "git-upload-pack" && req.method === "POST") need = ROLE_LEVEL.reader;
    else if (rest === "git-receive-pack" && req.method === "POST") need = ROLE_LEVEL.writer;
    else throw new HttpError(404, "not found");
    requireRole(storeId, principal, need);
    const store = config.stores[storeId];
    const pushRole = principal.kind === "token" ? principal.token.role : roleName(storeRole(config, storeId, principal));
    const env = cleanGitEnv({
      GIT_PROJECT_ROOT: store.path,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/origin.git/${rest}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.replace(/^\?/, ""),
      REMOTE_USER: principalLabel(principal),
      REMOTE_ADDR: req.socket.remoteAddress ?? "",
      KUMA_VAULT_SERVER_CONFIG: configPath ?? "",
      KUMA_VAULT_STORE: storeId,
      KUMA_VAULT_PUSH_ROLE: pushRole,
      KUMA_VAULT_PUSHER: principalLabel(principal),
      ...(req.headers["content-type"] ? { CONTENT_TYPE: req.headers["content-type"] } : {}),
      ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
      ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
      ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: req.headers["git-protocol"] } : {}),
    });
    await gitHttpBackend(req, res, { storeRoot: store.path, pathInfo: rest, env });
  }

  async function handleLfs(req, res, { storeId, rest, principal }) {
    const store = config.stores[storeId];
    const paths = storePaths(store.path);
    if (rest.startsWith("locks")) {
      requireRole(storeId, principal, ROLE_LEVEL.reader);
      throw new HttpError(501, "LFS locking is not supported by vault serve");
    }
    if (rest === "objects/batch" && req.method === "POST") {
      const body = await readJsonBody(req);
      const operation = body?.operation;
      if (operation !== "upload" && operation !== "download") throw new HttpError(422, "operation must be upload or download");
      requireRole(storeId, principal, operation === "upload" ? ROLE_LEVEL.writer : ROLE_LEVEL.reader);
      if (Array.isArray(body.transfers) && body.transfers.length > 0 && !body.transfers.includes("basic")) {
        throw new HttpError(422, "only the basic transfer adapter is supported");
      }
      if (body.hash_algo && body.hash_algo !== "sha256") throw new HttpError(409, "only sha256 is supported");
      if (!Array.isArray(body.objects)) throw new HttpError(422, "objects must be a list");
      if (operation === "upload") {
        const incoming = body.objects.reduce((sum, o) => sum + (Number.isSafeInteger(o?.size) ? o.size : 0), 0);
        const shortage = diskShortage(store.path, incoming); // advisory; each PUT reserves its own bytes
        if (shortage) throw shortage;
      }
      const header = req.headers.authorization ? { Authorization: req.headers.authorization } : {};
      const hrefBase = `${externalOrigin(req)}/v1/stores/${storeId}.git/info/lfs/objects`;
      const objects = [];
      for (const object of body.objects) {
        const oid = object?.oid;
        const size = object?.size;
        if (!isLfsOid(oid) || !Number.isSafeInteger(size) || size < 0) {
          objects.push({ oid: String(oid), size, error: { code: 422, message: "invalid oid or size" } });
          continue;
        }
        const existing = await casStat(paths.lfsObjects, oid);
        if (operation === "download") {
          if (!existing) objects.push({ oid, size, error: { code: 404, message: "object does not exist" } });
          else objects.push({ oid, size: existing.size, authenticated: true, actions: { download: { href: `${hrefBase}/${oid}`, header, expires_in: 3600 } } });
          continue;
        }
        if (existing && existing.size === size) {
          objects.push({ oid, size, authenticated: true });
          continue;
        }
        if (existing) {
          objects.push({ oid, size, error: { code: 422, message: `object exists with size ${existing.size}` } });
          continue;
        }
        objects.push({
          oid,
          size,
          authenticated: true,
          actions: {
            upload: { href: `${hrefBase}/${oid}`, header, expires_in: 3600 },
            verify: { href: `${hrefBase}/verify`, header, expires_in: 3600 },
          },
        });
      }
      sendJson(res, 200, { transfer: "basic", objects, hash_algo: "sha256" }, LFS_JSON);
      return;
    }
    if (rest === "objects/verify" && req.method === "POST") {
      requireRole(storeId, principal, ROLE_LEVEL.writer);
      const body = await readJsonBody(req);
      if (!isLfsOid(body?.oid)) throw new HttpError(422, "invalid oid");
      const existing = await casStat(paths.lfsObjects, body.oid);
      if (!existing) throw new HttpError(404, "object does not exist");
      if (existing.size !== body.size) throw new HttpError(422, `size mismatch: object is ${existing.size}B`);
      sendJson(res, 200, { message: "ok" }, LFS_JSON);
      return;
    }
    const objectMatch = /^objects\/([0-9a-f]{64})$/.exec(rest);
    if (objectMatch && req.method === "GET") {
      requireRole(storeId, principal, ROLE_LEVEL.reader);
      const oid = objectMatch[1];
      const existing = await casStat(paths.lfsObjects, oid);
      if (!existing) throw new HttpError(404, "object does not exist");
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": existing.size });
      await new Promise((resolve, reject) => {
        const stream = casReadStream(paths.lfsObjects, oid);
        stream.on("error", reject);
        stream.on("end", resolve);
        stream.pipe(res);
      });
      return;
    }
    if (objectMatch && req.method === "PUT") {
      requireRole(storeId, principal, ROLE_LEVEL.writer);
      const oid = objectMatch[1];
      // The reservation needs the size up front, and Node's parser then stops the body at
      // exactly that many bytes — so a body can never outgrow what was reserved. git-lfs always
      // sends Content-Length; a chunked upload is refused.
      const declared = req.headers["content-length"];
      if (declared === undefined) throw new HttpError(411, "Content-Length 가 필요합니다");
      if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) throw new HttpError(400, "Content-Length 가 올바르지 않습니다");
      const length = Number(declared);
      const release = reserveDisk(store.path, length);
      // The reservation is held only while the body keeps coming. A stalled client, or one that
      // trickles a byte now and then, would otherwise hold it as long as its socket stays open.
      // Counted on the socket, so the check never touches the body stream casPut reads.
      const { socket } = req;
      const start = socket.bytesRead;
      let mark = start;
      const pace = setInterval(() => {
        const got = socket.bytesRead - mark;
        mark = socket.bytesRead;
        const rest = length - (mark - start);
        if (rest > 0 && got < Math.min(uploadPace.minBytes, rest)) {
          req.destroy(new Error(`upload too slow: ${got}B in ${uploadPace.windowMs}ms, at least ${uploadPace.minBytes}B per window`));
        }
      }, uploadPace.windowMs);
      const stopPace = () => clearInterval(pace);
      req.once("end", stopPace); // the body is in; hashing and fsync take their own time
      req.once("close", stopPace);
      try {
        const result = await casPut({ lfsObjects: paths.lfsObjects, lfsIncoming: paths.lfsIncoming, oid, source: req, expectedSize: length });
        if (result.created) {
          const g = growth.get(storeId);
          if (g && g.computedAt) {
            g.objects += 1;
            g.bytes += result.size;
            g.windowBytes += result.size;
          }
        }
        sendJson(res, 200, { oid, size: result.size, created: result.created }, LFS_JSON);
      } catch (error) {
        if (error instanceof CasError) throw new HttpError(error.status, error.message);
        throw error;
      } finally {
        stopPace();
        release();
      }
      return;
    }
    throw new HttpError(404, "not found");
  }

  async function handleEvents(req, res, { storeId, principal, url }) {
    requireRole(storeId, principal, ROLE_LEVEL.reader);
    const after = Number(url.searchParams.get("after") ?? 0);
    if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "after must be a whole number");
    const eventsPath = storePaths(config.stores[storeId].path).events;
    const read = async () => {
      let text = "";
      try {
        text = await readFile(eventsPath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return { events: events.filter((e) => e.seq > after), lastSeq: events.length ? events[events.length - 1].seq : 0 };
    };
    const deadline = Date.now() + LONG_POLL_MS;
    let closed = false;
    req.on("close", () => {
      closed = true;
    });
    let lastSize = -1;
    for (;;) {
      let size = 0;
      try {
        size = (await stat(eventsPath)).size;
      } catch {
        size = 0;
      }
      if (size !== lastSize) {
        lastSize = size;
        const result = await read();
        if (result.events.length > 0 || Date.now() >= deadline) {
          sendJson(res, 200, result);
          return;
        }
      }
      if (closed) return;
      if (Date.now() >= deadline) {
        sendJson(res, 200, await read());
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function handleBackupStatus(req, res, { storeId, principal }) {
    requireRole(storeId, principal, ROLE_LEVEL.reader);
    const path = storePaths(config.stores[storeId].path).backupStatus;
    let status;
    try {
      status = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw new HttpError(500, `backup status unreadable: ${error.message}`);
      status = { lastBackupAt: null, lastResult: null, note: "no backup has been recorded for this store" };
    }
    sendJson(res, 200, { store: storeId, ...status });
  }

  async function handleSearch(req, res, { storeId, principal, verb }) {
    requireRole(storeId, principal, ROLE_LEVEL.reader);
    const store = config.stores[storeId];
    if (store.kind !== "vault") throw new HttpError(404, `${storeId} is a ${store.kind} store — no search index`);
    const body = await readJsonBody(req);
    const q = typeof body?.q === "string" ? body.q : "";
    if (!q.trim()) throw new HttpError(400, "q required");
    const mode = verb === "timeline" ? "timeline" : (body.mode ?? "search");
    const limit = body.limit ?? 20;
    const started = Date.now();
    try {
      const result = await searchStoreIndex(store.path, { query: q, mode, limit });
      sendJson(res, 200, { store: storeId, ms: Date.now() - started, ...result });
    } catch (error) {
      if (error instanceof IndexNotReadyError) throw new HttpError(503, error.message, { "Retry-After": "5" });
      if (/^(query required|unsupported mode|limit must)/.test(error.message)) throw new HttpError(400, error.message);
      throw error;
    }
  }

  async function handleFile(req, res, { storeId, principal, url }) {
    requireRole(storeId, principal, ROLE_LEVEL.reader);
    const store = config.stores[storeId];
    try {
      const file = await readServedFile(store.path, { path: url.searchParams.get("path") ?? "", rev: url.searchParams.get("rev") ?? "main" });
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": file.size,
        "Cache-Control": "no-store",
        "X-Vault-Commit": file.commit,
        "X-Vault-Blob": file.sha,
        "X-Vault-Mode": file.mode,
      });
      res.end(file.content);
    } catch (error) {
      if (error instanceof FileRequestError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  async function handle(req, res) {
    maybeReloadConfig();
    const url = new URL(req.url, "http://serve.invalid");
    const path = decodeURIComponent(url.pathname);
    let principal = null;
    if (path === "/v1/health" && req.method === "GET") {
      const who = await identify(req);
      if (who.invalidToken) throw new HttpError(401, "invalid token", { "WWW-Authenticate": 'Basic realm="kuma-vault"' });
      principal = who.principal;
      res.locals = { principal };
      await handleHealth(req, res, principal);
      return;
    }
    const who = await identify(req);
    principal = who.principal;
    res.locals = { principal };
    if (!principal) throw new HttpError(401, who.reason ?? "authentication required", { "WWW-Authenticate": 'Basic realm="kuma-vault"' });

    const gitMatch = /^\/v1\/stores\/([a-z0-9][a-z0-9._-]{0,63})\.git\/(.+)$/.exec(path);
    if (gitMatch) {
      const [, storeId, rest] = gitMatch;
      if (!config.stores[storeId]) throw new HttpError(404, `no such store: ${storeId}`);
      if (rest.startsWith("info/lfs/")) {
        await handleLfs(req, res, { storeId, rest: rest.slice("info/lfs/".length), principal });
        return;
      }
      await handleGit(req, res, { storeId, rest, principal, url });
      return;
    }
    const storeMatch = /^\/v1\/stores\/([a-z0-9][a-z0-9._-]{0,63})\/([a-z-]+)$/.exec(path);
    if (storeMatch) {
      const [, storeId, verb] = storeMatch;
      if (!config.stores[storeId]) throw new HttpError(404, `no such store: ${storeId}`);
      if (verb === "events" && req.method === "GET") return handleEvents(req, res, { storeId, principal, url });
      if (verb === "backup-status" && req.method === "GET") return handleBackupStatus(req, res, { storeId, principal });
      if ((verb === "search" || verb === "timeline") && req.method === "POST") return handleSearch(req, res, { storeId, principal, verb });
      if (verb === "file" && req.method === "GET") return handleFile(req, res, { storeId, principal, url });
    }
    throw new HttpError(404, "not found");
  }

  async function handler(req, res) {
    const started = Date.now();
    res.locals = {};
    try {
      await handle(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!res.headersSent) {
        const body = JSON.stringify({ message: error.message }) + "\n";
        res.writeHead(status, {
          "Content-Type": req.url.includes("/info/lfs/") ? LFS_JSON : "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(error.headers ?? {}),
        });
        res.end(body);
      } else {
        res.destroy(error);
      }
      if (status >= 500 && !(error instanceof HttpError)) process.stderr.write(`[serve] ${req.method} ${req.url}: ${error.stack ?? error.message}\n`);
    } finally {
      const url = new URL(req.url, "http://serve.invalid");
      log(JSON.stringify({
        ts: new Date().toISOString(),
        ip: req.socket.remoteAddress,
        who: principalLabel(res.locals?.principal),
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      }));
    }
  }

  // the indexer asks every few seconds: a store removed from server.json stops being indexed
  // even when no request arrives to trigger the reload
  return {
    handler,
    refreshGrowth,
    getConfig: () => {
      maybeReloadConfig();
      return config;
    },
  };
}

function listenWithRetry(app, entry, { retryMs = 5000, log }) {
  const { host, port } = parseListenAddress(entry);
  const server = createServer({ requestTimeout: 0, headersTimeout: 60_000 }, app.handler);
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve) => {
    const attempt = () => {
      server.once("error", (error) => {
        log(JSON.stringify({ ts: new Date().toISOString(), event: "bind-failed", listen: entry, error: error.code ?? error.message, retryMs }));
        setTimeout(attempt, retryMs);
      });
      server.listen(port, host, () => {
        server.removeAllListeners("error");
        log(JSON.stringify({ ts: new Date().toISOString(), event: "listening", listen: `${host}:${server.address().port}` }));
        resolve(server);
      });
    };
    attempt();
  });
}

/** Start serving: one HTTP server per listen address, bind retried every 5s. */
export async function startServe({ configPath, config, identifierOptions, log = (line) => process.stdout.write(`${line}\n`), retryMs = 5000, indexIntervalMs = 5000 }) {
  const app = createServeApp({ configPath, config, identifierOptions, log });
  const indexer = indexIntervalMs > 0
    ? startIndexer({ getConfig: app.getConfig, intervalMs: indexIntervalMs, log: (record) => log(JSON.stringify({ ts: new Date().toISOString(), ...record })) })
    : null;
  const servers = [];
  const ready = app.getConfig().listen.map((entry) => listenWithRetry(app, entry, { retryMs, log }).then((s) => servers.push(s)));
  void app.refreshGrowth();
  const timer = setInterval(() => void app.refreshGrowth(), GROWTH_REFRESH_MS);
  timer.unref();
  return {
    app,
    ready: Promise.all(ready).then(() => servers),
    servers,
    indexer,
    close: async () => {
      clearInterval(timer);
      indexer?.stop();
      await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
    },
  };
}

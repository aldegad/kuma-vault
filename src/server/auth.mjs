// Who is asking (docs/server.md, Identity).
//
// - A request that carries a token (`Authorization: Bearer <token>`, or Basic with the token
//   as password so git credential helpers work) is that token — an unknown token is a 401,
//   never a fall-through to another identity.
// - Without a token, a tailnet peer is identified by `tailscale whois` (LoginName, or
//   `node:<name>` for a tagged device), cached per address.
// - The server itself — loopback, any address of a local interface (which includes its own
//   tailnet IPs), or a whois answer naming the server's own node — is NEVER identified by
//   whois: whois would answer with the server owner's login and hand that owner's rights to
//   any local Linux user. Such requests are anonymous; only `GET /v1/health` serves them.

import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";

import { findToken } from "./server-config.mjs";

export function normalizeAddress(address) {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function isLoopback(address) {
  return address === "::1" || /^127\./.test(address);
}

function localInterfaceAddresses() {
  const out = new Set();
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) out.add(normalizeAddress(entry.address));
  }
  return out;
}

function execJson(bin, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

/** `tailscale whois --json <ip:port>` -> `{ stableId, nodeName, tagged, login }` or null. */
export function tailscaleWhois(bin) {
  return async (address, port) => {
    const target = address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
    try {
      const data = await execJson(bin, ["whois", "--json", target]);
      const node = data?.Node ?? {};
      const tags = Array.isArray(node.Tags) ? node.Tags : [];
      const nodeName = String(node.ComputedName || node.Name || "").replace(/\.$/, "").split(".")[0];
      return {
        stableId: node.StableID ?? null,
        nodeName,
        tagged: tags.length > 0,
        login: data?.UserProfile?.LoginName ?? null,
      };
    } catch {
      return null;
    }
  };
}

export function tailscaleSelfStableId(bin) {
  return execJson(bin, ["status", "--json"])
    .then((data) => data?.Self?.ID ?? null)
    .catch(() => null);
}

function parseAuthorization(header) {
  if (typeof header !== "string" || !header.trim()) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  const value = rest.join(" ");
  if (/^bearer$/i.test(scheme)) return value;
  if (/^basic$/i.test(scheme)) {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon < 0 ? decoded : decoded.slice(colon + 1);
  }
  return "";
}

/**
 * Build `identify(req)` -> `{ principal, reason }`. principal is null when anonymous;
 * `reason` says why (for the 401 body). `whois` / `selfStableId` are injectable for tests.
 */
export function createIdentifier(config, { whois, selfStableId, interfaceAddresses = localInterfaceAddresses } = {}) {
  const lookup = whois ?? tailscaleWhois(config.auth.tailscaleBin);
  const cacheMs = config.auth.whoisCacheSeconds * 1000;
  const cache = new Map();
  let selfAddresses = new Set([...interfaceAddresses(), ...config.auth.selfAddresses.map(normalizeAddress)]);
  let refreshedAt = Date.now();
  let selfIdPromise = null;
  const selfId = () => {
    if (!selfIdPromise) {
      selfIdPromise = selfStableId !== undefined
        ? Promise.resolve(selfStableId)
        : config.auth.mode === "tailscale" ? tailscaleSelfStableId(config.auth.tailscaleBin) : Promise.resolve(null);
    }
    return selfIdPromise;
  };

  function isSelf(address) {
    if (Date.now() - refreshedAt > 60_000) {
      selfAddresses = new Set([...interfaceAddresses(), ...config.auth.selfAddresses.map(normalizeAddress)]);
      refreshedAt = Date.now();
    }
    return isLoopback(address) || selfAddresses.has(address);
  }

  return async function identify(req) {
    const raw = parseAuthorization(req.headers.authorization);
    if (raw !== null) {
      const token = findToken(config, raw);
      if (!token) return { principal: null, reason: "invalid token", invalidToken: true };
      return { principal: { kind: "token", token, name: `token:${token.id}` } };
    }
    if (config.auth.mode === "token") return { principal: null, reason: "token required" };
    const address = normalizeAddress(req.socket.remoteAddress);
    if (isSelf(address)) return { principal: null, reason: "token required for requests from the server itself" };

    const cached = cache.get(address);
    let who = cached && Date.now() - cached.at < cacheMs ? cached.who : undefined;
    if (who === undefined) {
      who = await lookup(address, req.socket.remotePort);
      if (who) cache.set(address, { who, at: Date.now() });
    }
    if (!who) return { principal: null, reason: "unknown tailnet identity" };
    const ownId = await selfId();
    if (ownId && who.stableId === ownId) return { principal: null, reason: "token required for requests from the server itself" };
    if (who.tagged) return { principal: { kind: "node", name: who.nodeName } };
    if (!who.login) return { principal: null, reason: "unknown tailnet identity" };
    return { principal: { kind: "user", login: who.login, name: who.login } };
  };
}

// The daemon's JSON calls to `vault serve`: events long-poll, health, backup status and LFS
// batch checks. Credentials come from the clone's git credential helper (the same token git
// and git-lfs use); without one the request goes bare and the server identifies the tailnet peer.

import { git } from "./git.mjs";

const AUTH_TTL_MS = 10 * 60_000;
// A helper that waits for input (a keychain prompt under launchd) fails the call instead of
// holding the daemon; the failure is kept for the TTL so no helper piles up behind it.
export const CREDENTIAL_TIMEOUT_MS = 15_000;

function parseCredential(text) {
  const map = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

export function createRemoteApi(ctx, { credentialTimeoutMs = CREDENTIAL_TIMEOUT_MS } = {}) {
  let auth = { header: undefined, error: null, at: 0 };

  async function authHeader() {
    if ((auth.header !== undefined || auth.error) && Date.now() - auth.at < AUTH_TTL_MS) {
      if (auth.error) throw auth.error;
      return auth.header;
    }
    let result;
    try {
      result = await git(["credential", "fill"], { cwd: ctx.repo, input: `url=${ctx.remoteUrl}\n\n`, allowFail: true, signal: AbortSignal.timeout(credentialTimeoutMs) });
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
      auth = {
        header: undefined,
        error: new Error(`git credential fill for ${ctx.remoteUrl} did not answer within ${credentialTimeoutMs / 1000}s — a credential helper is waiting for input (a keychain prompt?). Token clones: \`vault sync install\` makes the token file the only helper`),
        at: Date.now(),
      };
      throw auth.error;
    }
    const cred = result.code === 0 ? parseCredential(result.stdout.toString("utf8")) : {};
    auth = {
      header: cred.password ? `Basic ${Buffer.from(`${cred.username ?? "kuma-vault"}:${cred.password}`).toString("base64")}` : null,
      error: null,
      at: Date.now(),
    };
    return auth.header;
  }

  async function request(path, { method = "GET", body, timeoutMs = 15_000, signal, contentType = "application/json" } = {}) {
    if (!ctx.apiBase) throw new Error(`remote ${ctx.remoteUrl} is not a vault serve store URL`);
    const header = await authHeader();
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const response = await fetch(path.startsWith("http") ? path : `${ctx.serverBase}${path}`, {
      method,
      headers: {
        ...(header ? { Authorization: header } : {}),
        ...(body !== undefined ? { "Content-Type": contentType } : {}),
        Accept: contentType,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = new Error(`${method} ${path}: HTTP ${response.status} ${json?.error ?? json?.message ?? text.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    return json;
  }

  const storePath = () => `/v1/stores/${ctx.store}`;

  return {
    authHeader,
    /** Long-poll: resolves `{ events, lastSeq }` after a change or the server's 25 s window. */
    events(after, { signal } = {}) {
      return request(`${storePath()}/events?after=${after}`, { timeoutMs: 40_000, signal });
    },
    health() {
      return request("/v1/health");
    },
    backupStatus() {
      return request(`${storePath()}/backup-status`);
    },
    /** Which of `objects` ({oid,size}) the server holds: Set of oids. */
    async serverHas(objects) {
      const have = new Set();
      for (let i = 0; i < objects.length; i += 100) {
        const chunk = objects.slice(i, i + 100);
        const json = await request(`${storePath()}.git/info/lfs/objects/batch`, {
          method: "POST",
          body: { operation: "download", transfers: ["basic"], objects: chunk },
          contentType: "application/vnd.git-lfs+json",
        });
        for (const object of json?.objects ?? []) if (object.actions?.download) have.add(object.oid);
      }
      return have;
    },
  };
}


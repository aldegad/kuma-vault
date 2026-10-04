// LFS upload reservation (docs/server.md, Large-file store): a PUT that brings less than the
// pace floor in a window — stalled, or trickling a byte at a time — is cut and gives its
// reservation back; one that keeps the pace holds it. In process, with a short window.

import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cut, gone, openPut, taken } from "../../scripts/server/lfs-reserve-race.mjs";
import { createServeApp } from "./serve.mjs";
import { hashToken, writeServerConfig } from "./server-config.mjs";

const TOKEN = "tok-writer";
const RESERVE_GB = 0.001;
const MARGIN = 0.25e9;
const PACE = { windowMs: 1500, minBytes: 4096 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let root;
let storeRoot;
let incoming;
let server;
let base;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "kv-serve-reserve-"));
  storeRoot = join(root, "stores", "s");
  incoming = join(storeRoot, "lfs", "incoming");
  mkdirSync(incoming, { recursive: true });
  mkdirSync(join(storeRoot, "lfs", "objects"), { recursive: true });
  const configPath = join(root, "server.json");
  writeServerConfig(configPath, {
    version: 1,
    listen: ["127.0.0.1:0"],
    dataDir: join(root, "stores"),
    diskReserveGB: RESERVE_GB,
    auth: { mode: "token" },
    tokens: [{ id: "w", sha256: hashToken(TOKEN), role: "writer", stores: ["s"] }],
    stores: { s: { path: storeRoot } },
  });
  const app = createServeApp({ configPath, uploadPace: PACE, log: () => {} });
  server = createServer({ requestTimeout: 0 }, app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("LFS upload reservation", () => {
  it("holds a stalled upload's reservation until the pace floor cuts it, then gives it back", async () => {
    const st = statfsSync(storeRoot);
    const free = Number(st.bavail) * Number(st.bsize);
    const target = { base, store: "s", token: TOKEN };
    const oid = (c) => c.repeat(64);

    const stalled = openPut(target, oid("a"), Math.floor(free - RESERVE_GB * 1e9 - MARGIN));
    expect(await taken(incoming, stalled)).toBe(true);
    const refused = openPut(target, oid("b"), 2 * MARGIN);
    expect(await taken(incoming, refused)).toBe(false);
    await cut(incoming, refused);
    expect(refused.status).toBe(507);

    // nothing more arrives: serve cuts the stalled upload, removes its temp file and releases it
    expect(await gone(incoming, stalled.oid, 5_000)).toBe(true);
    const after = openPut(target, oid("c"), 2 * MARGIN);
    expect(await taken(incoming, after)).toBe(true);
    expect(await cut(incoming, after)).toBe(true);
    stalled.req.destroy();
    expect(readdirSync(incoming)).toEqual([]);
  });

  it("cuts an upload that trickles a byte at a time (never idle) and gives its reservation back", async () => {
    const st = statfsSync(storeRoot);
    const free = Number(st.bavail) * Number(st.bsize);
    const target = { base, store: "s", token: TOKEN };
    const trickle = openPut(target, "d".repeat(64), Math.floor(free - RESERVE_GB * 1e9 - MARGIN));
    expect(await taken(incoming, trickle)).toBe(true);
    const drip = setInterval(() => trickle.req.write("x"), 200); // well inside any idle limit
    try {
      expect(await gone(incoming, trickle.oid, 3 * PACE.windowMs + 2_000)).toBe(true);
    } finally {
      clearInterval(drip);
    }
    const after = openPut(target, "e".repeat(64), 2 * MARGIN);
    expect(await taken(incoming, after)).toBe(true);
    expect(await cut(incoming, after)).toBe(true);
    trickle.req.destroy();
    expect(readdirSync(incoming)).toEqual([]);
  }, 3 * PACE.windowMs + 10_000);

  it("keeps the reservation of an upload that brings the floor in every window", async () => {
    const target = { base, store: "s", token: TOKEN };
    const steady = openPut(target, "f".repeat(64), 64 * PACE.minBytes);
    expect(await taken(incoming, steady)).toBe(true);
    const chunk = Buffer.alloc(PACE.minBytes, 0x78);
    const feed = setInterval(() => steady.req.write(chunk), PACE.windowMs / 3); // 3 x minBytes per window
    try {
      await sleep(4 * PACE.windowMs);
      expect(steady.status).toBeNull();
      expect(readdirSync(incoming).some((name) => name.startsWith(`${steady.oid}.`))).toBe(true);
    } finally {
      clearInterval(feed);
    }
    expect(await cut(incoming, steady)).toBe(true);
  }, 6 * PACE.windowMs + 5_000);
});

#!/usr/bin/env node
// Probe the LFS upload reservation of a running `vault serve` (docs/server.md, Large-file
// store): two PUTs at once must not both spend the same free space. Only declared sizes are
// large — each PUT sends one byte and is then cut, so the probe writes almost nothing.
//
//   A declares free - reserve - margin, sends a byte and holds (its temp file shows the
//     reservation was taken);
//   B declares 2 x margin: it would fit alone, but not next to A -> 507;
//   A is cut; C declares what B did and must now be taken (A's reservation was given back).
//
// Needs read access to the store's lfs/incoming (to see the temp files) and a writer token.
//   node lfs-reserve-race.mjs --base http://127.0.0.1:7741 --store <id> --token-file <f> \
//     --store-root /data/vaults/<id> [--reserve-gb 8] [--margin-gb 0.5]

import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statfsSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freeBytes(path) {
  const st = statfsSync(path);
  return Number(st.bavail) * Number(st.bsize);
}

/** Open a PUT that declares `size`, send one byte and keep it open. */
export function openPut({ base, store, token }, oid, size) {
  const req = request(`${base}/v1/stores/${store}.git/info/lfs/objects/${oid}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "Content-Length": String(size) },
  });
  const put = { oid, size, status: null, req };
  put.done = new Promise((resolve) => {
    req.on("response", (res) => {
      put.status = res.statusCode;
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", () => resolve());
    req.on("close", () => resolve());
  });
  req.flushHeaders();
  req.write("x");
  return put;
}

/** Wait until `oid` has a temp file in incoming (the reservation was taken), or the PUT answered. */
export async function taken(incoming, put, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readdirSync(incoming).some((name) => name.startsWith(`${put.oid}.`))) return true;
    if (put.status !== null) return false;
    await sleep(20);
  }
  return false;
}

export async function gone(incoming, oid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!readdirSync(incoming).some((name) => name.startsWith(`${oid}.`))) return true;
    await sleep(20);
  }
  return false;
}

export async function cut(incoming, put) {
  put.req.destroy();
  await put.done;
  return gone(incoming, put.oid);
}

/** Returns `{ ok, steps: [...] }`; each step says what was seen. */
export async function raceLfsReserve({ base, store, token, storeRoot, reserveBytes, marginBytes = 0.5e9 }) {
  const incoming = join(storeRoot, "lfs", "incoming");
  const free = freeBytes(storeRoot);
  const steps = [];
  const step = (name, pass, detail) => steps.push({ name, pass, ...detail });
  const target = { base, store, token };
  const sizeA = Math.floor(free - reserveBytes - marginBytes);
  const sizeB = Math.floor(2 * marginBytes);
  if (sizeA < marginBytes) throw new Error(`free ${free}B leaves less than 2 x margin above the reserve ${reserveBytes}B`);
  const oid = () => randomBytes(32).toString("hex");

  const a = openPut(target, oid(), sizeA);
  step("A takes its reservation", await taken(incoming, a), { declared: sizeA, status: a.status });
  const b = openPut(target, oid(), sizeB);
  const bTaken = await taken(incoming, b); // a temp file means B got past the check
  await cut(incoming, b);
  step("B (fits alone, not next to A) is refused with 507", !bTaken && b.status === 507, { declared: sizeB, status: b.status });
  step("B left no temp file", await gone(incoming, b.oid), {});
  step("A is cut and its temp file removed", await cut(incoming, a), {});
  const c = openPut(target, oid(), sizeB);
  step("C (as B) is taken once A gave its reservation back", await taken(incoming, c), { declared: sizeB, status: c.status });
  step("C is cut and its temp file removed", await cut(incoming, c), {});
  return { ok: steps.every((s) => s.pass), free, reserveBytes, steps };
}

// realpath: the installed copy is run through the /opt/kuma-vault/current symlink
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
  );
  const result = await raceLfsReserve({
    base: args.base,
    store: args.store,
    token: readFileSync(args["token-file"], "utf8").trim(),
    storeRoot: args["store-root"],
    reserveBytes: Number(args["reserve-gb"] ?? 8) * 1e9,
    marginBytes: Number(args["margin-gb"] ?? 0.5) * 1e9,
  });
  for (const s of result.steps) process.stdout.write(`${s.pass ? "PASS" : "FAIL"} lfs reserve: ${s.name}${s.status !== undefined ? ` (status ${s.status})` : ""}\n`);
  process.exit(result.ok ? 0 : 1);
}

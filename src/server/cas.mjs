// Content-addressed store for LFS objects.
//
// Upload = stream to lfs/incoming/<oid>.<random> while hashing -> the sha256 must equal the
// oid -> fsync -> chmod 0444 -> rename into lfs/objects/<aa>/<bb>/<oid>. A reader never sees
// a partial object, a wrong hash never lands, and a landed object is never rewritten in place.
//
// Growth alarm: bytes of objects that arrived in the last
// `windowDays`, from the objects' own mtimes (the CAS is the truth, no side ledger).

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { chmod, open, opendir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import { casObjectPath } from "./store-layout.mjs";

export class CasError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function casStat(lfsObjects, oid) {
  try {
    const st = await stat(casObjectPath(lfsObjects, oid));
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function casReadStream(lfsObjects, oid) {
  return createReadStream(casObjectPath(lfsObjects, oid));
}

/**
 * Store `source` (a readable stream) as object `oid`. Resolves `{ size, created }`;
 * `created` is false when the object already existed (the upload is verified and dropped).
 */
export async function casPut({ lfsObjects, lfsIncoming, oid, source, expectedSize = null }) {
  mkdirSync(lfsIncoming, { recursive: true });
  const temp = join(lfsIncoming, `${oid}.${randomBytes(6).toString("hex")}`);
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, createWriteStream(temp, { mode: 0o600 }));
    const digest = hash.digest("hex");
    if (digest !== oid) throw new CasError(422, `sha256 mismatch: body hashes to ${digest}, not ${oid}`);
    if (expectedSize !== null && size !== expectedSize) {
      throw new CasError(422, `size mismatch: body is ${size}B, declared ${expectedSize}B`);
    }
    const handle = await open(temp, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o444);
    const target = casObjectPath(lfsObjects, oid);
    if (existsSync(target)) {
      await rm(temp, { force: true });
      return { size, created: false };
    }
    mkdirSync(join(lfsObjects, oid.slice(0, 2), oid.slice(2, 4)), { recursive: true });
    await rename(temp, target);
    return { size, created: true };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Walk the CAS: object count, total bytes, and bytes whose mtime is within the window. */
export async function casUsage(lfsObjects, { windowMs, now = Date.now() }) {
  const usage = { objects: 0, bytes: 0, windowBytes: 0, windowObjects: 0 };
  if (!existsSync(lfsObjects)) return usage;
  const since = now - windowMs;
  for await (const a of await opendir(lfsObjects)) {
    if (!a.isDirectory()) continue;
    for await (const b of await opendir(join(lfsObjects, a.name))) {
      if (!b.isDirectory()) continue;
      for await (const entry of await opendir(join(lfsObjects, a.name, b.name))) {
        if (!entry.isFile()) continue;
        const st = await stat(join(lfsObjects, a.name, b.name, entry.name));
        usage.objects += 1;
        usage.bytes += st.size;
        if (st.mtimeMs >= since) {
          usage.windowBytes += st.size;
          usage.windowObjects += 1;
        }
      }
    }
  }
  return usage;
}

// Exclusive-create lockfile mutex, released only by its holder.
//
// The same protocol the kuma-studio writers use for the vault ledgers
// (`packages/shared/cli/file-commit-lock.mjs`): the lock for `<dir>/<name>` is
// `<dir>/.<name>.commit-lock`, taken with `open(O_CREAT|O_EXCL)`, and removed only by the
// process that created it (its body carries a random token). There is no stale reclaim — a
// judge-then-remove step can delete a live claim (ABA), so a holder that dies leaves a lock an
// operator removes, and every refusal names that path. Engine writers that rewrite a file the
// host also appends to (the dispatch ledger) must take this lock, or the two lose each other's
// lines. A contender that cannot take the lock within the timeout does NOT run its write.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const LOCK_TIMEOUT_MS = 5_000;
const POLL_MS = 5;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function lockPathFor(target) {
  return join(dirname(target), `.${basename(target)}.commit-lock`);
}

/**
 * Run `critical` while holding the mutex for `target`.
 * Returns `{ locked: true, value, released }` or `{ locked: false, holder, lockPath }`.
 */
export function withFileCommitLock(target, critical, { timeoutMs = LOCK_TIMEOUT_MS, now = Date.now } = {}) {
  const lockPath = lockPathFor(target);
  const body = `${JSON.stringify({ pid: process.pid, token: randomUUID(), target, at: new Date().toISOString() })}\n`;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, body, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (now() >= deadline) {
        let holder = "unknown";
        try {
          holder = `pid ${JSON.parse(readFileSync(lockPath, "utf8"))?.pid ?? "unknown"}`;
        } catch {
          holder = "unreadable lock";
        }
        return { locked: false, holder, lockPath };
      }
      sleepSync(POLL_MS);
      continue;
    }
    const result = { locked: true, value: undefined, released: true };
    try {
      result.value = critical();
      return result;
    } finally {
      let onDisk;
      try {
        onDisk = readFileSync(lockPath, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") result.released = false;
      }
      if (onDisk !== undefined) {
        if (onDisk !== body) {
          result.released = false;
        } else {
          try {
            unlinkSync(lockPath);
          } catch (error) {
            if (error?.code !== "ENOENT") result.released = false;
          }
        }
      }
      if (!result.released) {
        process.stderr.write(`FILE_COMMIT_LOCK_NOT_RELEASED: ${target} — remove the lock by hand: ${lockPath}\n`);
      }
    }
  }
}

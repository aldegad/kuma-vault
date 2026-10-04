// The daemon's three small files: the per-clone lock (one daemon per clone), the state file
// Studio and `vault sync status` read (the boundary — the daemon knows nothing of Studio),
// and the pause flag.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

/** A killed process its parent has not reaped yet still answers kill(pid, 0); it holds nothing. */
function isZombie(pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
    } catch {
      return false;
    }
  }
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return /Z/.test(ps.stdout ?? "");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  return !isZombie(pid);
}

export function readLock(lockPath) {
  try {
    const holder = JSON.parse(readFileSync(lockPath, "utf8"));
    return { ...holder, alive: holder.host === hostname() ? pidAlive(holder.pid) : true };
  } catch {
    return null;
  }
}

/**
 * Take the clone's daemon lock (O_EXCL). A lock left by a dead process on this host is removed
 * and logged; a live holder is an error.
 */
export function acquireLock(lockPath, { log = () => {} } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
      closeSync(fd);
      return {
        release() {
          const holder = readLock(lockPath);
          if (holder?.pid === process.pid && holder.host === hostname()) rmSync(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = readLock(lockPath);
      if (holder?.alive) {
        const err = new Error(`another sync daemon holds ${lockPath} (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt})`);
        err.code = "LOCKED";
        err.holder = holder;
        throw err;
      }
      log({ event: "stale-lock-removed", lockPath, holder });
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`could not take ${lockPath}`);
}

export function readStatus(statusPath) {
  try {
    return JSON.parse(readFileSync(statusPath, "utf8"));
  } catch {
    return null;
  }
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeStatus(statusPath, status) {
  const temp = join(dirname(statusPath), `.${process.pid}.${Date.now()}.status.tmp`);
  writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, statusPath);
}

export function isPaused(pausePath) {
  return existsSync(pausePath);
}

// git lock files a killed git leaves behind (`index.lock`, a ref's `.lock`). Every later git
// call that needs them fails until they go, so the daemon removes one — and logs it — only when
// it is older than `staleLockMs` (10 min) and no git process has its working directory in
// this clone. A younger lock, or one with git still running, is somebody's live work.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const LOCKS = ["index.lock", "HEAD.lock", "packed-refs.lock", "config.lock", "refs/heads/main.lock", "refs/remotes/origin/main.lock"];

/** pids of git processes whose cwd is inside `repo`. */
export function gitProcessesIn(repo) {
  const pids = [];
  if (process.platform === "linux") {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const comm = readFileSync(`/proc/${entry}/comm`, "utf8").trim();
        if (!comm.startsWith("git")) continue;
        const cwd = readlinkSync(`/proc/${entry}/cwd`);
        if (cwd === repo || cwd.startsWith(`${repo}/`)) pids.push(Number(entry));
      } catch {
        // gone, or not ours to read
      }
    }
    return pids;
  }
  const ps = spawnSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
  for (const line of (ps.stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || !/(^|\/)git[^/]*$/.test(match[2].trim())) continue;
    const lsof = spawnSync("lsof", ["-a", "-p", match[1], "-d", "cwd", "-Fn"], { encoding: "utf8" });
    const cwd = /\nn(.*)/.exec(`\n${lsof.stdout ?? ""}`)?.[1];
    if (cwd && (cwd === repo || cwd.startsWith(`${repo}/`))) pids.push(Number(match[1]));
  }
  return pids;
}

/** Remove stale git locks. Returns the paths removed. */
export function clearStaleLocks(ctx, { clock = Date.now, log = () => {} } = {}) {
  const present = LOCKS.map((rel) => join(ctx.gitDir, rel)).filter((p) => existsSync(p));
  if (present.length === 0) return [];
  const stats = present.map((p) => {
    try {
      return { p, mtimeMs: statSync(p).mtimeMs };
    } catch {
      return null;
    }
  });
  const now = clock(); // after the stats it judges
  const old = stats.filter((s) => s && now - s.mtimeMs >= ctx.settings.staleLockMs).map((s) => s.p);
  if (old.length === 0) return [];
  const running = gitProcessesIn(ctx.repo);
  if (running.length > 0) return [];
  for (const path of old) {
    rmSync(path, { force: true });
    log({ event: "stale-git-lock-removed", path });
  }
  return old;
}

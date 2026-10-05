// `origin.git/hooks/post-receive` -> `vault server post-receive` (docs/server.md).
//
// 1. append `{seq, ref, old, new, ts}` per ref update to state/events.jsonl (seq strictly
//    increasing across pushes — the append is serialized by state/events.lock)
// 2. move `tree/` (the follow-only linked worktree) to the new main; create it on the first push
// 3. tighten the credential directories of `tree/` to 0600/0700 (credential-modes.mjs): the
//    checkout wrote them by the umask. What it cannot tighten goes to the pusher (stderr) and
//    to state/receive-log.jsonl
//
// events.jsonl is what `GET /v1/stores/<id>/events` long-polls (the clients' sync daemons).

import { closeSync, existsSync, openSync, readSync, rmSync, statSync, writeSync, fstatSync } from "node:fs";
import { join } from "node:path";

import { credentialModes, credentialRoots } from "./credential-modes.mjs";
import { cleanGitEnv, runGit, storePaths } from "./store-layout.mjs";

const ZERO = /^0+$/;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withLock(lockPath, fn) {
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx", 0o640);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
      } catch {
        // raced with the holder releasing it
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`events lock busy: ${lockPath}`);
      await sleep(25);
    }
  }
  try {
    writeSync(fd, `${process.pid}\n`);
    return await fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

/** seq of the last line of events.jsonl (0 when empty or missing). Reads only the tail. */
export function readLastSeq(eventsPath) {
  if (!existsSync(eventsPath)) return 0;
  const fd = openSync(eventsPath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const seq = JSON.parse(lines[i]).seq;
        if (Number.isInteger(seq)) return seq;
      } catch {
        // a torn first line of the tail window; keep looking backwards
      }
    }
    throw new Error(`events log ${eventsPath} has no readable seq in its tail`);
  } finally {
    closeSync(fd);
  }
}

export async function appendEvents(paths, updates, now = new Date()) {
  return withLock(paths.eventsLock, async () => {
    let seq = readLastSeq(paths.events);
    const lines = updates.map(({ oldSha, newSha, ref }) => {
      seq += 1;
      return JSON.stringify({ seq, ref, old: oldSha, new: newSha, ts: now.toISOString() });
    });
    const fd = openSync(paths.events, "a", 0o640);
    try {
      writeSync(fd, `${lines.join("\n")}\n`);
    } finally {
      closeSync(fd);
    }
    return seq;
  });
}

/**
 * Point tree/ at `commit` (detached). Pointers stay pointers — the tree never smudges LFS.
 * The index is refreshed first: a chmod (the credential modes) changes a file's ctime, and a
 * forced checkout rewrites every entry whose stat differs from the index, by the umask —
 * unchanged credentials included.
 */
export async function followTree(paths, commit) {
  const env = cleanGitEnv({ GIT_LFS_SKIP_SMUDGE: "1" });
  if (!existsSync(join(paths.tree, ".git"))) {
    await runGit(["--git-dir", paths.gitDir, "worktree", "prune"], { env });
    await runGit(["--git-dir", paths.gitDir, "worktree", "add", "--quiet", "--detach", paths.tree, commit], { env });
    return;
  }
  // exit 1 = some path differs in content; the forced checkout below overwrites it anyway
  await runGit(["-C", paths.tree, "update-index", "-q", "--refresh"], { env, allowFail: true });
  await runGit(["-C", paths.tree, "checkout", "--quiet", "--detach", "--force", commit], { env });
}

/** Tighten the credential directories of `tree/` (paths from its index). */
export async function treeCredentialModes(paths) {
  const listed = await runGit(["-C", paths.tree, "ls-files", "-z"], { env: cleanGitEnv() });
  const names = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  return credentialModes(paths.tree, credentialRoots(names), { fix: true });
}

export async function postReceive({ storeRoot, updates }) {
  const paths = storePaths(storeRoot);
  const lastSeq = await appendEvents(paths, updates);
  const main = updates.find((u) => u.ref === "refs/heads/main" && !ZERO.test(u.newSha));
  let modes = null;
  if (main) {
    await followTree(paths, main.newSha);
    modes = await treeCredentialModes(paths);
  }
  return { lastSeq, credentialModes: modes };
}

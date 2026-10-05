// The git runner of the sync daemon and its CLI.
//
// The daemon is not an agent: it calls git by absolute path, never through an agent shim on
// PATH (a shim's agent rules — refusing a path-less commit, say — must not stop an autosave),
// with prompts off and the caller's GIT_* context dropped. Index and ref lock contention with
// other writers is retried with jitter, up to a deadline, then the failure is returned as is.
// Optional index refreshes are disabled: background reads must not rewrite another writer's
// staging area. Required locks for add, commit and merge remain in force.

import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const LOCK_ERROR = /index\.lock|cannot lock ref|Unable to create '.*\.lock'|unable to lock|could not lock config file/i;

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable `name` on PATH, skipping agent shims under ~/.kuma/bin. */
export function findOnPath(name, { env = process.env, skipShims = true } = {}) {
  const shimDir = join(env.HOME ?? homedir(), ".kuma", "bin");
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    if (skipShims && (dir === shimDir || dir.startsWith(`${shimDir}/`))) continue;
    const candidate = join(dir, name);
    if (!isExecutable(candidate)) continue;
    if (skipShims) {
      try {
        if (realpathSync(candidate).startsWith(`${shimDir}/`)) continue;
      } catch {
        continue;
      }
    }
    return candidate;
  }
  return null;
}

let cachedGit = null;

export function gitBin(env = process.env) {
  if (env.KUMA_VAULT_GIT) return env.KUMA_VAULT_GIT;
  if (!cachedGit) {
    cachedGit = findOnPath("git", { env });
    if (!cachedGit) throw new Error("git not found on PATH");
  }
  return cachedGit;
}

/** Environment for a git child: no inherited GIT_* context, no prompts, C locale. */
export function gitEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  // Keep the caller's config isolation knobs (tests set them); drop repository context.
  for (const key of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...extra };
}

/**
 * Run git once. Resolves `{ code, stdout (Buffer), stderr (string) }`; rejects on a non-zero
 * exit unless `allowFail`.
 */
export function git(args, { cwd, env, input, allowFail = false, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(gitBin(), ["--no-optional-locks", ...args], { cwd, env: env ?? gitEnv(), stdio: ["pipe", "pipe", "pipe"], signal });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (code, sig) => {
      const result = { code: code ?? (sig ? 128 : 1), stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") };
      if (result.code !== 0 && !allowFail) {
        const error = new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
        error.result = result;
        rejectPromise(error);
        return;
      }
      resolvePromise(result);
    });
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * git with lock-contention retry: a failure whose stderr names an index/ref lock is retried
 * after 200-1500 ms of jitter until `deadlineMs` (default 60 s), then returned or thrown.
 * `onLocked` runs before each wait: the caller judges the lock it met (stale-locks.mjs removes
 * one a killed git left) instead of waiting the deadline out on a lock nobody holds.
 */
export async function gitRetry(args, options = {}) {
  const { deadlineMs = 60_000, allowFail = false, onLocked = null, ...rest } = options;
  const until = Date.now() + deadlineMs;
  for (;;) {
    const result = await git(args, { ...rest, allowFail: true });
    if (result.code === 0) return result;
    if (LOCK_ERROR.test(result.stderr) && Date.now() < until) {
      onLocked?.();
      await sleep(200 + Math.floor(Math.random() * 1300));
      continue;
    }
    if (allowFail) return result;
    const error = new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
    error.result = result;
    throw error;
  }
}

export async function gitText(args, options) {
  const result = await git(args, options);
  return result.stdout.toString("utf8").trim();
}

/** `rev-parse --verify --quiet <ref>^{commit}` or null. */
export async function revParse(repo, ref) {
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repo, allowFail: true });
  return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
}

export async function isAncestor(repo, a, b) {
  const result = await git(["merge-base", "--is-ancestor", a, b], { cwd: repo, allowFail: true });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed: ${result.stderr.trim()}`);
}

/** Split NUL-terminated output into strings (trailing empty dropped). */
export function splitNul(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const parts = text.split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export const MIN_GIT = [2, 38]; // merge-tree --write-tree

export async function checkGitVersion() {
  const text = await gitText(["version"]);
  const match = /git version (\d+)\.(\d+)/.exec(text);
  if (!match) throw new Error(`cannot read git version: ${text}`);
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) {
    throw new Error(`git ${major}.${minor} is too old — the sync daemon needs git >= ${MIN_GIT.join(".")} (merge-tree --write-tree)`);
  }
  return text;
}

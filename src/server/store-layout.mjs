// On-disk layout of one served store and the small git runner the
// server pieces share.
//
//   <root>/origin.git/                bare. hooks/pre-receive, post-receive
//   <root>/lfs/objects/<aa>/<bb>/<oid> CAS, files 0444
//   <root>/lfs/incoming/              upload temp (verified, then renamed)
//   <root>/tree/                      linked worktree of origin.git (--detach), follow-only
//   <root>/state/events.jsonl         ref update events (seq), appended by post-receive
//   <root>/state/backup-status.json   written by the backup job, read by serve
//   <root>/state/backup-refs.json     refs as they were just before the backup read the store
//   <root>/state/receive-log.jsonl    receive-rule rejections and warnings (paths/sizes/oids only)

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function storePaths(root) {
  const state = join(root, "state");
  return {
    root,
    gitDir: join(root, "origin.git"),
    lfsObjects: join(root, "lfs", "objects"),
    lfsIncoming: join(root, "lfs", "incoming"),
    tree: join(root, "tree"),
    state,
    events: join(state, "events.jsonl"),
    eventsLock: join(state, "events.lock"),
    backupStatus: join(state, "backup-status.json"),
    backupRefs: join(state, "backup-refs.json"),
    receiveLog: join(state, "receive-log.jsonl"),
  };
}

export function casObjectPath(lfsObjects, oid) {
  return join(lfsObjects, oid.slice(0, 2), oid.slice(2, 4), oid);
}

/** Environment for a git child that must not inherit a hook's or caller's repository context. */
export function cleanGitEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...extra };
}

/**
 * Run git and collect output. Rejects with the stderr text on a non-zero exit unless
 * `allowFail` is set (then the caller inspects `code`).
 */
export function runGit(args, { cwd, env = cleanGitEnv(), input, allowFail = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") };
      if (code !== 0 && !allowFail) {
        rejectPromise(new Error(`git ${args.join(" ")} failed (${code}): ${result.stderr.trim()}`));
        return;
      }
      resolvePromise(result);
    });
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const HOOK_MARKER = "# kuma-vault-server-hook";

export function renderHook(vaultBin, verb) {
  return [
    "#!/bin/sh",
    `${HOOK_MARKER} — regenerate via: vault server init-store <id>`,
    "# Receive rules: docs/server.md. vault serve passes KUMA_VAULT_SERVER_CONFIG / KUMA_VAULT_STORE /",
    "# KUMA_VAULT_PUSH_ROLE; a push that did not come through serve is checked as a plain writer.",
    `exec "${vaultBin}" server ${verb}`,
    "",
  ].join("\n");
}

/**
 * Create (or repair) a store directory: bare repo with the receive settings and hooks, CAS and
 * state dirs. Idempotent. The `tree/` worktree is created by post-receive on the first push
 * (a worktree cannot be added on an unborn branch).
 */
export async function initStore(root, { vaultBin }) {
  const paths = storePaths(root);
  for (const dir of [root, paths.lfsObjects, paths.lfsIncoming, paths.state]) {
    mkdirSync(dir, { recursive: true, mode: 0o750 });
  }
  chmodSync(root, 0o750);
  if (!existsSync(join(paths.gitDir, "HEAD"))) {
    await runGit(["init", "--quiet", "--bare", "--initial-branch=main", paths.gitDir]);
  }
  const settings = [
    ["receive.denyNonFastForwards", "true"],
    ["receive.denyDeletes", "true"],
    ["receive.denyDeleteCurrent", "true"],
    // index-pack --strict: refuses trees a checkout cannot write (`.git` components, `..`, bad
    // modes) before the hooks run; rule 2 refuses `.git` components as well, with a message
    ["receive.fsckObjects", "true"],
    ["http.receivepack", "true"],
    ["http.uploadpack", "true"],
    ["http.getanyfile", "false"],
    // partial clones (`--filter=blob:limit=1m`) fetch missing blobs by id later
    ["uploadpack.allowFilter", "true"],
    ["uploadpack.allowAnySHA1InWant", "true"],
    ["core.logAllRefUpdates", "true"],
    // objects are never deleted while the backup job reads the store: gc runs only inside that
    // job, before it records the refs (docs/server.md "Backup" — why a snapshot restores whole)
    ["receive.autogc", "false"],
    ["gc.auto", "0"],
  ];
  for (const [key, value] of settings) {
    await runGit(["--git-dir", paths.gitDir, "config", key, value]);
  }
  writeFileSync(join(paths.gitDir, "hooks", "pre-receive"), renderHook(vaultBin, "receive-check"), { mode: 0o755 });
  writeFileSync(join(paths.gitDir, "hooks", "post-receive"), renderHook(vaultBin, "post-receive"), { mode: 0o755 });
  chmodSync(join(paths.gitDir, "hooks", "pre-receive"), 0o755);
  chmodSync(join(paths.gitDir, "hooks", "post-receive"), 0o755);
  return paths;
}

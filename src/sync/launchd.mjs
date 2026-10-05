// launchd user agent that keeps `vault syncd` running for one clone (macOS).
//
// KeepAlive restarts it after a crash or a kill; RunAtLoad starts it at login. launchd hands a
// job a bare PATH, so the plist carries one built from where node, git and git-lfs are now, and
// pins git by absolute path (KUMA_VAULT_GIT) so no agent shim sits in front of it. A clone with
// enrich on autosave also gets the directories of the provider CLIs found at install time.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findOnPath, gitBin } from "./git.mjs";

const SYNC_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "sync-cli.mjs");

export function launchdLabel(store) {
  return `ai.kuma-vault.syncd.${store}`;
}

export function plistPath(store, env = process.env) {
  return join(env.HOME ?? homedir(), "Library", "LaunchAgents", `${launchdLabel(store)}.plist`);
}

function xml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderPlist({ label, node, repo, logPath, env }) {
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(node)}</string>
      <string>${xml(SYNC_CLI)}</string>
      <string>syncd</string>
      <string>--repo</string>
      <string>${xml(repo)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(repo)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logPath)}</string>
  </dict>
</plist>
`;
}

function launchctl(args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

function domain() {
  return `gui/${process.getuid()}`;
}

/**
 * bootout returns before the job is gone, and a daemon stuck in a tick (a git child waiting on
 * something) leaves only once launchd's exit timeout kills it; until then bootstrap fails with
 * "5: Input/output error". Wait for launchd to forget the label.
 */
function waitUnloaded(label, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (launchctl(["print", `${domain()}/${label}`]).status === 0) {
    if (Date.now() > until) throw new Error(`launchd still has ${label} ${timeoutMs / 1000} s after bootout`);
    spawnSync("sleep", ["0.2"]);
  }
}

/**
 * The job's PATH: where node, git and git-lfs are, the system directories, and where each of
 * `tools` (command names the daemon spawns besides git: the enrich provider CLIs) is found now.
 * Returns `{ path, found, missing }`.
 */
export function launchdPath({ node, git, lfs, tools = [], find = findOnPath }) {
  const found = [];
  const missing = [];
  for (const name of tools) {
    const at = find(name);
    if (at) found.push({ name, dir: dirname(at) });
    else missing.push(name);
  }
  const dirs = [...new Set([dirname(node), dirname(git), dirname(lfs), ...found.map((t) => t.dir), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])];
  return { path: dirs.join(":"), found, missing };
}

export function launchdInstall(ctx, { node = process.execPath, tools = [] } = {}) {
  if (process.platform !== "darwin") throw new Error("vault sync install uses launchd (macOS only)");
  const git = gitBin();
  const lfs = findOnPath("git-lfs");
  if (!lfs) throw new Error("git-lfs not found on PATH");
  const jobPath = launchdPath({ node, git, lfs, tools });
  const env = { PATH: jobPath.path, KUMA_VAULT_GIT: git };
  if (process.env.KUMA_VAULT_SYNC_DIR) env.KUMA_VAULT_SYNC_DIR = process.env.KUMA_VAULT_SYNC_DIR;
  const label = launchdLabel(ctx.store);
  const path = plistPath(ctx.store);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderPlist({ label, node, repo: ctx.repo, logPath: ctx.logPath, env }));
  launchctl(["bootout", `${domain()}/${label}`]); // not loaded yet is fine
  waitUnloaded(label, 60_000);
  const boot = launchctl(["bootstrap", domain(), path]);
  if (boot.status !== 0) throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim() || boot.stdout.trim()}`);
  launchctl(["enable", `${domain()}/${label}`]);
  // RunAtLoad alone can leave a job bootstrapped outside a login session (ssh) pending as a
  // "speculative" spawn that never starts; kickstart starts it now. KeepAlive does the rest.
  const kick = launchctl(["kickstart", `${domain()}/${label}`]);
  if (kick.status !== 0) throw new Error(`launchctl kickstart failed: ${kick.stderr.trim() || kick.stdout.trim()}`);
  return { label, plist: path, env, tools: { found: jobPath.found, missing: jobPath.missing } };
}

export function launchdUninstall(ctx) {
  const label = launchdLabel(ctx.store);
  const path = plistPath(ctx.store);
  const out = launchctl(["bootout", `${domain()}/${label}`]);
  if (existsSync(path)) rmSync(path);
  waitUnloaded(label, 60_000); // report only once launchd no longer knows it
  return { label, plist: path, bootout: out.status };
}

/** `{ loaded, state, pid, runs, lastExit }` from `launchctl print`. */
export function launchdStatus(store) {
  if (process.platform !== "darwin") return { loaded: false };
  const out = launchctl(["print", `${domain()}/${launchdLabel(store)}`]);
  if (out.status !== 0) return { loaded: false };
  const pick = (re) => re.exec(out.stdout)?.[1] ?? null;
  return {
    loaded: true,
    state: pick(/\n\s*state = (\S+)/),
    pid: Number(pick(/\n\s*pid = (\d+)/)) || null,
    runs: Number(pick(/\n\s*runs = (\d+)/)) || 0,
    lastExit: pick(/\n\s*last exit code = ([^\n]+)/),
  };
}

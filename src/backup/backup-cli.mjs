#!/usr/bin/env node
// `vault backup <verb>` — the Mac side of the backup move (design 3.4, docs/server.md "Backup").
//
//   vault backup sample --store <id> [--kind hourly|mac-backup]
//       append one sample of the sync daemon's status (~/.kuma-vault/sync/<id>.json) to
//       ~/.kuma-vault/sync/<id>.retire-samples.jsonl
//   vault backup retire-check --store <id> --routine-enabled true|false
//                             [--backup-status <file|url>] [--repo-root <dir>] [--now <iso>]
//       judge whether the Mac backup routine retires (or comes back), print the decision as
//       JSON and append it to ~/.kuma-vault/sync/<id>.retirement.jsonl. Exit 0 = a decision
//       was made (read `action`), 2 = could not judge.
//
// Store root and server come from vault-stores.json: a v1 entry is a path string, a v2 entry
// is { root, remote: { server, store } } (design 3.5).

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseFlags } from "../cli/cli-options.mjs";
import { resolveStoreRegistryPath } from "../engine/vault-stores.mjs";
import { syncStateDir } from "../sync/context.mjs";
import { decide, sampleFromSyncStatus } from "./retirement.mjs";

const USAGE = `Usage:
  vault backup sample --store <id> [--kind hourly|mac-backup]
  vault backup retire-check --store <id> --routine-enabled true|false [--backup-status <file|url>] [--repo-root <dir>] [--now <iso>]
`;

export function syncDir(env = process.env) {
  return resolve(syncStateDir(env));
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${what} ${path} unreadable: ${error.code ?? error.message}`);
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${path}:${i + 1} is not JSON`);
    }
  });
}

/** v1 string or v2 { root, remote } entry of one store. */
export function storeEntry(storeId, env = process.env) {
  const path = resolveStoreRegistryPath(env);
  const registry = readJson(path, "store registry");
  const entry = registry?.stores?.[storeId];
  if (entry === undefined) throw new Error(`store ${storeId} is not in ${path}`);
  if (typeof entry === "string") return { root: entry, remote: null, version: 1 };
  if (entry && typeof entry.root === "string") return { root: entry.root, remote: entry.remote ?? null, version: 2 };
  throw new Error(`store ${storeId} in ${path} has neither a path nor a root`);
}

/** Sub-directory .gitignore files with at least one active rule, tracked or not. */
export function subGitignores(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.gitignore", ".gitignore"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files in ${repoRoot} failed: ${result.stderr.trim()}`);
  const found = [];
  for (const path of new Set(result.stdout.split("\0").filter(Boolean))) {
    if (path === ".gitignore" || !path.endsWith("/.gitignore")) continue;
    let text = "";
    try {
      text = readFileSync(join(repoRoot, path), "utf8");
    } catch {
      continue; // listed in the index but deleted in the tree: no rule applies
    }
    if (text.split("\n").some((l) => l.trim() && !l.trim().startsWith("#"))) found.push(path);
  }
  return found.sort();
}

async function loadBackupStatus(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`backup status ${source}: HTTP ${response.status}`);
    return response.json();
  }
  return readJson(source, "backup status");
}

function lastRetired(log) {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const action = log[i].action;
    if (action === "retire" || action === "stay-retired") return true;
    if (action === "reenable" || action === "keep-running") return false;
  }
  return false;
}

export async function main(argv = process.argv.slice(2)) {
  const [verb, ...rest] = argv;
  const options = parseFlags(rest);
  const storeId = options.store;
  if ((verb !== "sample" && verb !== "retire-check") || typeof storeId !== "string") {
    process.stdout.write(USAGE);
    return verb === "--help" ? 0 : 2;
  }
  const dir = syncDir();
  mkdirSync(dir, { recursive: true });
  const statusPath = join(dir, `${storeId}.json`);
  const samplesPath = join(dir, `${storeId}.retire-samples.jsonl`);
  const now = options.now ? new Date(String(options.now)) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now ${options.now}: not a date`);

  if (verb === "sample") {
    const kind = options.kind ?? "hourly";
    if (kind !== "hourly" && kind !== "mac-backup") throw new Error("--kind must be hourly or mac-backup");
    const sample = sampleFromSyncStatus(readJson(statusPath, "sync status"), { kind, now });
    appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`);
    process.stdout.write(`${JSON.stringify(sample)}\n`);
    return 0;
  }

  if (options["routine-enabled"] !== "true" && options["routine-enabled"] !== "false") throw new Error("--routine-enabled true|false required (the routine's current state)");
  const entry = storeEntry(storeId);
  const repoRoot = typeof options["repo-root"] === "string"
    ? options["repo-root"]
    : spawnSync("git", ["-C", realpathSync(entry.root), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
  if (!repoRoot) throw new Error(`no git repository at ${entry.root}`);
  const notes = [];
  let backupStatus = null;
  const source = typeof options["backup-status"] === "string"
    ? options["backup-status"]
    : entry.remote?.server && entry.remote?.store ? `${entry.remote.server.replace(/\/$/, "")}/v1/stores/${entry.remote.store}/backup-status` : null;
  if (!source) notes.push("no server backup status source (v1 store, or no --backup-status)");
  else {
    try {
      backupStatus = await loadBackupStatus(source);
    } catch (error) {
      notes.push(error.message);
    }
  }
  const probePath = join(dir, `${storeId}.alert-probe.json`);
  const logPath = join(dir, `${storeId}.retirement.jsonl`);
  const decision = decide({
    now,
    routineEnabled: options["routine-enabled"] === "true",
    retired: lastRetired(readJsonl(logPath)),
    backupStatus,
    alertProbe: existsSync(probePath) ? readJson(probePath, "alert probe") : null,
    samples: readJsonl(samplesPath),
    subGitignores: subGitignores(repoRoot),
    syncStatus: existsSync(statusPath) ? readJson(statusPath, "sync status") : null,
  });
  const record = { ...decision, store: storeId, ...(notes.length ? { notes } : {}) };
  appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return 0;
}

const isDirectExecution = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}

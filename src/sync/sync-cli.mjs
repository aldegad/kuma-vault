#!/usr/bin/env node
// Client CLI of remote stores: `vault clone`, `vault syncd`, `vault sync <verb>`, `vault blob <verb>`
// (docs/sync.md). Like the server CLI it does not run the compiler engine: it imports only the
// store registry's path and the names of the enrich provider CLIs (for the launchd job's PATH).

import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseFlags } from "../cli/cli-options.mjs";
import { SUPPORTED_ENRICH_PROVIDERS } from "../enrich-adapters/provider-adapter.mjs";
import { resolveStoreRegistryPath } from "../engine/vault-stores.mjs";
import { blobEvict, blobStatus, fetchLfsPaths } from "./blob.mjs";
import { cloneStore, ensureIndexChecksum, repairCredential } from "./clone.mjs";
import { readConflicts, resolveConflict } from "./conflicts.mjs";
import { loadContext } from "./context.mjs";
import { credentialModesAlert, formatCredentialModes, keepCredentialModes } from "./credential-modes.mjs";
import { createMemory, runDaemon, runTick } from "./daemon.mjs";
import { isoLocal } from "./integrate.mjs";
import { launchdInstall, launchdStatus, launchdUninstall } from "./launchd.mjs";
import { createRemoteApi } from "./remote-api.mjs";
import { acquireLock, readLock, readStatus } from "./state-files.mjs";

const USAGE = `Usage:
  vault clone <store-url> [<dir>] [--store <id>] [--token-file <path>] [--tree <rel>] [--no-hook]
  vault syncd [<store>] [--repo <dir>]
  vault sync status [--json] [--repo <dir>]        exit 2 while an alarm, a conflict, a block or a stopped daemon needs someone
  vault sync now [--repo <dir>] [--timeout <s>]
  vault sync pause|resume [--repo <dir>]
  vault sync conflicts [--all] [--json] [--repo <dir>]
  vault sync resolve <id> --take local|remote|<merged-file> [--repo <dir>]
  vault sync install|uninstall [--repo <dir>]       launchd user agent (macOS); install also tightens credential modes
                                                    and puts the enrich provider CLIs it finds on the job's PATH
  vault blob get <path...>        fetch these LFS files only (git lfs pull -I <path> -X "")
  vault blob evict <path...>      back to pointers, once the server holds them and a backup covers them
  vault blob status [<path...>]
`;

/** `<store>` from vault-stores.json (v1 string or v2 { root }), else --repo, else the cwd. */
function repoArgument(options) {
  if (typeof options.repo === "string") return resolve(options.repo);
  const store = options._[0];
  if (store) {
    const registry = JSON.parse(readFileSync(resolveStoreRegistryPath(), "utf8"));
    const entry = registry?.stores?.[store];
    const root = typeof entry === "string" ? entry : entry?.root;
    if (!root) throw new Error(`store ${store} is not in ${resolveStoreRegistryPath()}`);
    return root.replace(/^~(?=\/)/, process.env.HOME ?? "");
  }
  return process.cwd();
}

function daemonState(ctx) {
  const holder = readLock(ctx.lockPath);
  return holder ? { running: holder.alive, pid: holder.pid, host: holder.host, since: holder.startedAt } : { running: false };
}

/** Why `vault sync status` should exit 2 (empty = 0). */
export function statusProblems(status, daemon) {
  const problems = [];
  if (!status) return ["상태 파일 없음 — 데몬이 한 번도 돌지 않았다"];
  if (!daemon.running) problems.push("데몬 멈춤");
  for (const [name, alarm] of Object.entries(status.alerts ?? {})) if (alarm?.active) problems.push(`경보 ${name}`);
  if (status.openConflicts > 0) problems.push(`충돌 ${status.openConflicts}`);
  if (status.state === "blocked") problems.push(`막힘: ${status.lastError ?? status.autosaveBlocked ?? ""}`);
  if (status.state === "offline") problems.push("오프라인");
  return problems;
}

/**
 * The enrich switch as the clone's git config sets it now (`configured`) and as the daemon's last
 * tick ran it (`daemon`, null before a tick recorded it). The daemon reads the switch every tick,
 * so the two differ until its next tick — longer only while it is stopped.
 */
export function enrichSwitch(settings, status) {
  const recorded = status?.alerts?.enrich?.on;
  return { configured: settings.enrichOnAutosave, daemon: typeof recorded === "boolean" ? recorded : null };
}

function formatStatus(status, daemon, problems, enrichSwitchNow = null) {
  if (!status) return `${problems.join("\n")}\n`;
  const a = status.alerts ?? {};
  const lines = [
    `store ${status.store}  state ${status.state}  ahead ${status.ahead}  behind ${status.behind}  daemon ${daemon.running ? `pid ${daemon.pid}` : "stopped"}`,
    `last sync ${status.lastSyncAt ?? "never"}  oldest unpushed ${status.oldestUnpushedAt ?? "-"}  tick ${status.tickSeq} @ ${status.tickAt}`,
  ];
  if (enrichSwitchNow && enrichSwitchNow.daemon !== null && enrichSwitchNow.configured !== enrichSwitchNow.daemon) {
    const word = (on) => (on ? "on" : "off");
    lines.push(`enrich switch: git config ${word(enrichSwitchNow.configured)}, the daemon's last tick ran it ${word(enrichSwitchNow.daemon)} — it holds from the daemon's next tick`);
  }
  if (status.lastError) lines.push(`error: ${status.lastError}`);
  if (status.autosaveBlocked) lines.push(status.autosaveBlocked);
  if (status.openConflicts) lines.push(`conflicts: ${status.openConflicts} open (vault sync conflicts)`);
  if (a.uncollected?.count) lines.push(`uncollected ${a.uncollected.count}${a.uncollected.active ? " [RED]" : ""} since ${a.uncollected.since}: ${a.uncollected.paths.slice(0, 5).map((p) => `${p.path} (${p.reason})`).join(", ")}`);
  if (a.ignoredOutside?.count) lines.push(`ignoredOutside ${a.ignoredOutside.count} · ${a.ignoredOutside.bytes} B · lfsExt ${a.ignoredOutside.lfsExt}${a.ignoredOutside.active ? " [YELLOW]" : ""}`);
  if (a.rejectResidue?.count) lines.push(`rejectResidue ${a.rejectResidue.count} · ${a.rejectResidue.bytes} B · oldest ${a.rejectResidue.oldestAt}${a.rejectResidue.active ? " [YELLOW]" : ""}`);
  if (a.growth?.active) lines.push(`growth [YELLOW] ${a.growth.label} (${a.growth.commit?.slice(0, 9)})`);
  if (a.credentialModes?.active) {
    const loose = a.credentialModes.error ?? a.credentialModes.paths.slice(0, 5).map((p) => `${p.path} ${p.mode ?? "?"}`).join(", ");
    lines.push(`credentialModes ${a.credentialModes.count} [RED] not 0600/0700: ${loose}`);
  }
  if (a.enrich?.on) {
    const e = a.enrich;
    lines.push(`enrich on: ${e.pending} queued${e.held ? `, ${e.held} held while the declaration cannot be read` : ""}${e.dropped ? ` (${e.dropped} dropped — vault sync --enrich --enrich-limit)` : ""} · ${e.callsLastHour}/${e.perHour} calls this hour · ${e.totals?.enriched ?? 0} described in ${e.totals?.calls ?? 0} calls${e.active ? " [YELLOW]" : ""}`);
    if (e.lastError) lines.push(`enrich: ${e.lastError}${e.nextRetryAt ? ` (retry ${e.nextRetryAt})` : ""}`);
    if (e.gaveUp) lines.push(`enrich gave up on ${e.gaveUp} page(s): ${e.failed.filter((f) => f.gaveUp).slice(0, 5).map((f) => f.path).join(", ")}`);
  }
  const s = status.server ?? {};
  lines.push(`server head ${s.head?.slice(0, 9) ?? "-"}  disk free ${s.diskFreeGB ?? "-"} GB  last backup ${s.lastBackupAt ?? "-"}  lfs cache ${status.lfsCache?.bytes ?? 0} B`);
  if (problems.length) lines.push(`needs attention: ${problems.join("; ")}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The `credentialModes` alarm measured now, read-only: the daemon's record may be a tick (or a
 * stopped daemon) old. Walks the index's roots and those the daemon last found loose.
 */
async function liveCredentialAlert(ctx, status) {
  const recorded = status?.alerts?.credentialModes?.paths ?? [];
  try {
    const { report } = await keepCredentialModes(ctx.repo, { paths: recorded.map((p) => p.path) });
    return credentialModesAlert(report);
  } catch (error) {
    return credentialModesAlert(null, { error });
  }
}

async function commandStatus(options) {
  const ctx = await loadContext(repoArgument(options));
  const recorded = readStatus(ctx.statusPath);
  const credentialModes = await liveCredentialAlert(ctx, recorded);
  const status = recorded ? { ...recorded, alerts: { ...(recorded.alerts ?? {}), credentialModes } } : null;
  const daemon = daemonState(ctx);
  const problems = statusProblems(status, daemon);
  if (!status && credentialModes.active) problems.push("경보 credentialModes");
  const switchNow = enrichSwitch(ctx.settings, status);
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ ...(status ?? {}), enrichSwitch: switchNow, daemon, launchd: launchdStatus(ctx.store), problems }, null, 2)}\n`);
  } else {
    process.stdout.write(formatStatus(status, daemon, problems, switchNow));
  }
  return problems.length ? 2 : 0;
}

async function commandNow(options) {
  const ctx = await loadContext(repoArgument(options));
  const daemon = daemonState(ctx);
  if (daemon.running && daemon.pid) {
    const before = readStatus(ctx.statusPath)?.tickSeq ?? 0;
    process.kill(daemon.pid, "SIGUSR1");
    const deadline = Date.now() + Number(options.timeout ?? 120) * 1000;
    for (;;) {
      const status = readStatus(ctx.statusPath);
      if ((status?.tickSeq ?? 0) > before) {
        process.stdout.write(formatStatus(status, daemon, statusProblems(status, daemon)));
        return 0;
      }
      if (Date.now() > deadline) throw new Error(`the daemon (pid ${daemon.pid}) did not finish a tick within ${options.timeout ?? 120}s`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const lock = acquireLock(ctx.lockPath);
  try {
    const result = await runTick(ctx, createMemory(ctx), { force: true });
    process.stdout.write(formatStatus(result.status, { running: false }, statusProblems(result.status, { running: true })));
    return result.ok ? 0 : 1;
  } finally {
    lock.release();
  }
}

async function commandPause(options, paused) {
  const ctx = await loadContext(repoArgument(options));
  if (paused) writeFileSync(ctx.pausePath, `${isoLocal(Date.now())}\n`);
  else rmSync(ctx.pausePath, { force: true });
  const daemon = daemonState(ctx);
  if (daemon.running && daemon.pid) process.kill(daemon.pid, "SIGUSR1");
  process.stdout.write(`${ctx.store}: ${paused ? "paused" : "resumed"}\n`);
  return 0;
}

async function commandConflicts(options) {
  const ctx = await loadContext(repoArgument(options));
  const rows = readConflicts(ctx).filter((c) => options.all === true || c.status === "open");
  if (options.json === true) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else for (const c of rows) process.stdout.write(`${c.id}\t${c.status}\t${c.class}\t${c.path}\t${c.copy ?? "-"}\tkept ${c.kept}\n`);
  return 0;
}

async function commandResolve(options) {
  const ctx = await loadContext(repoArgument({ ...options, _: [] }));
  const id = options._[0];
  if (!id || typeof options.take !== "string") throw new Error("vault sync resolve <id> --take local|remote|<merged-file>");
  const result = await resolveConflict(ctx, id, options.take);
  const daemon = daemonState(ctx);
  if (daemon.running && daemon.pid) process.kill(daemon.pid, "SIGUSR1");
  process.stdout.write(`resolved ${result.id} (take ${result.take})\n`);
  return 0;
}

async function commandBlob(verb, options) {
  const ctx = await loadContext(typeof options.repo === "string" ? resolve(options.repo) : process.cwd());
  const paths = options._;
  if (verb === "get") {
    if (!paths.length) throw new Error("vault blob get <path...>");
    const got = await fetchLfsPaths(ctx, paths);
    process.stdout.write(`${got.map((p) => `fetched ${p}`).join("\n")}\n`);
    return 0;
  }
  if (verb === "evict") {
    if (!paths.length) throw new Error("vault blob evict <path...>");
    const result = await blobEvict(ctx, createRemoteApi(ctx), { paths });
    for (const e of result.evicted) process.stdout.write(`evicted ${e.paths.join(", ")} (${e.bytes} B)\n`);
    for (const s of result.skipped) process.stdout.write(`kept ${s.path ?? s.oid}: ${s.reason}\n`);
    return result.skipped.length ? 1 : 0;
  }
  if (verb === "status") {
    process.stdout.write(`${JSON.stringify(await blobStatus(ctx, paths), null, 2)}\n`);
    return 0;
  }
  throw new Error("vault blob get|evict|status");
}

export async function main(argv = process.argv.slice(2)) {
  const [top, ...rest] = argv;
  if (top === "clone") {
    const options = parseFlags(rest);
    const [url, dir] = options._;
    if (!url) throw new Error("vault clone <store-url> [<dir>]");
    await cloneStore(url, dir, { store: options.store, tokenFile: options["token-file"], tree: typeof options.tree === "string" ? options.tree : undefined, hook: options["no-hook"] !== true });
    return 0;
  }
  if (top === "syncd") {
    const ctx = await loadContext(repoArgument(parseFlags(rest)));
    await runDaemon(ctx);
    return 0;
  }
  if (top === "blob") {
    const [verb, ...args] = rest;
    return commandBlob(verb, parseFlags(args));
  }
  if (top === "sync") {
    const [verb, ...args] = rest;
    const options = parseFlags(args);
    switch (verb) {
      case "status":
        return commandStatus(options);
      case "now":
        return commandNow(options);
      case "pause":
        return commandPause(options, true);
      case "resume":
        return commandPause(options, false);
      case "conflicts":
        return commandConflicts(options);
      case "resolve":
        return commandResolve(options);
      case "install": {
        const ctx = await loadContext(repoArgument(options));
        await ensureIndexChecksum(ctx.repo);
        process.stdout.write("index.skipHash=false: concurrent index refreshes use checksums\n");
        // a clone made before the credential reset would hang on the keychain under launchd
        for (const origin of await repairCredential(ctx.repo)) process.stdout.write(`credential for ${origin}: the token file is now its only helper\n`);
        // a clone made before the daemon kept them has its credentials at the umask's modes
        const { report } = await keepCredentialModes(ctx.repo, { fix: true });
        process.stdout.write(`${formatCredentialModes(report)}\n`);
        // enrich on autosave spawns the provider CLI: the job's PATH reaches it whether the switch is
        // on now or not, since the daemon reads the switch every tick
        const tools = [...SUPPORTED_ENRICH_PROVIDERS];
        const result = launchdInstall(ctx, { node: typeof options.node === "string" ? options.node : process.execPath, tools });
        process.stdout.write(`installed ${result.label}: ${result.plist}\n`);
        const found = result.tools?.found ?? [];
        const switchWord = ctx.settings.enrichOnAutosave ? "on" : "off";
        process.stdout.write(found.length
          ? `enrich on autosave (${switchWord}): the daemon's PATH reaches ${found.map((t) => `${t.name} (${t.dir})`).join(", ")}\n`
          : `enrich on autosave (${switchWord}): no provider CLI (${tools.join(", ")}) on PATH — with the switch on, the enrich alarm says so until one is installed and vault sync install is run again\n`);
        return report.looseCount ? 2 : 0;
      }
      case "uninstall": {
        const ctx = await loadContext(repoArgument(options));
        const result = launchdUninstall(ctx);
        process.stdout.write(`removed ${result.label}\n`);
        return 0;
      }
      default:
        process.stdout.write(USAGE);
        return verb === "--help-daemon" || verb === "--help" ? 0 : 1;
    }
  }
  process.stdout.write(USAGE);
  return 1;
}

function isDirectExecution() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    // realpath both sides: launchd and npm bins call this file through symlinks
    return realpathSync(new URL(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

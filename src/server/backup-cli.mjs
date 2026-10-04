// `vault server backup <verb>` (docs/server.md "Backup").

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { backupStores, drill, forgetOwnGroup, forgetPath, nightly, preCutoverRetention, readBackupStatus, restoreStore, runStoreBackup } from "./backup.mjs";
import { backupServiceProperties } from "./backup-units.mjs";
import { DEFAULT_BACKUP_CREDENTIALS_DIR, loadServerConfig, writeServerConfig } from "./server-config.mjs";
import { storePaths } from "./store-layout.mjs";

export const BACKUP_USAGE = `Usage:
  vault server backup configure --repository <restic repo> [--host <name, default this hostname>] [--stores <id,...>|--all-stores]
                                [--keep-daily N] [--keep-weekly N] [--keep-monthly N] [--retention-days N]
  vault server backup unconfigure                  (drop the backup block; install then disables the timer)
  vault server backup nightly                      (the timer: backup, forget, drill per store; pre-cutover retention)
  vault server backup run|forget|drill [--store <id>] [--snapshot <id>] [--keep]
  vault server backup retention [--now <iso>]      (pre-cutover retention only)
  vault server backup pre-cutover-clock --started-at <iso|YYYY-MM-DD> [--replace]   (start the clock)
  vault server backup forget-path --host <h> --path <p> [--dry-run]                (thin an old path)
  vault server backup restore --store <id> --target <dir> [--snapshot <id>]
  vault server backup status [--store <id>]
`;

// verbs that write into store directories: they must run as the store owner
const STORE_VERBS = new Set(["nightly", "run", "forget", "drill"]);

function parseNow(value) {
  if (value === undefined) return () => new Date();
  const fixed = new Date(String(value));
  if (Number.isNaN(fixed.getTime())) throw new Error(`--now ${value}: not a date`);
  return () => fixed;
}

/** `YYYY-MM-DD` is the start of that day in KST; a full ISO time is taken as is. */
export function parseClockStart(value) {
  const text = String(value ?? "");
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00+09:00` : text;
  if (!/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(iso) || Number.isNaN(Date.parse(iso))) throw new Error(`--started-at ${value}: give YYYY-MM-DD or an ISO time with an offset`);
  return iso;
}

function intOption(options, key) {
  if (options[key] === undefined) return undefined;
  const n = Number(options[key]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${key} must be a whole number >= 0`);
  return n;
}

function storesOption(config, options) {
  if (typeof options.store === "string") return [options.store];
  return backupStores(config);
}

/** Re-run this verb as the store owner, with the unit's credentials and sandbox. */
function reexecAsStoreOwner(config, configPath, argv) {
  const stores = Object.values(config.stores);
  const owner = stores.length ? statSync(stores[0].path).uid : statSync(config.dataDir).uid;
  const user = spawnSync("id", ["-nu", String(owner)], { encoding: "utf8" }).stdout.trim();
  const properties = backupServiceProperties({
    configPath,
    dataDir: config.dataDir,
    credentialsDir: config.backup?.credentialsDir ?? DEFAULT_BACKUP_CREDENTIALS_DIR,
    nodeBin: resolve(process.execPath, ".."),
    user,
  });
  const args = ["--wait", "--pipe", "--collect", "--quiet", ...properties.flatMap((p) => ["-p", p]), process.execPath, resolve(new URL("./server-cli.mjs", import.meta.url).pathname), "server", "backup", ...argv];
  process.stderr.write(`running as ${user} via systemd-run (the backup unit's credentials and sandbox)\n`);
  const result = spawnSync("systemd-run", args, { stdio: "inherit" });
  if (result.error) throw new Error(`systemd-run: ${result.error.message}`);
  return result.status ?? 1;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function commandBackup(argv, { parseFlags, configPathOf }) {
  const [verb, ...rest] = argv;
  const options = parseFlags(rest);
  const configPath = configPathOf(options);
  if (!verb || verb === "--help" || verb === "-h") {
    process.stdout.write(BACKUP_USAGE);
    return verb ? 0 : 1;
  }
  let config = loadServerConfig(configPath);

  if (verb === "configure") {
    if (typeof options.repository !== "string" && !config.backup) throw new Error("--repository <restic repository> required");
    const prev = config.backup ?? {};
    const keep = { ...prev.keep };
    for (const [flag, key] of [["keep-daily", "daily"], ["keep-weekly", "weekly"], ["keep-monthly", "monthly"]]) {
      const n = intOption(options, flag);
      if (n !== undefined) keep[key] = n;
    }
    const retentionDays = intOption(options, "retention-days");
    const stores = options["all-stores"] ? null : typeof options.stores === "string" ? options.stores.split(",").map((s) => s.trim()).filter(Boolean) : prev.stores ?? null;
    config = writeServerConfig(configPath, {
      ...config,
      backup: {
        ...prev,
        repository: typeof options.repository === "string" ? options.repository : prev.repository,
        // written once and kept: a later rename of the machine must not move the forget group
        host: typeof options.host === "string" ? options.host : prev.host ?? hostname(),
        stores,
        keep,
        preCutover: { ...prev.preCutover, ...(retentionDays !== undefined ? { retentionDays } : {}) },
      },
    });
    const { repository, ...shown } = config.backup;
    print({ backup: { ...shown, repository: repository.replace(/[0-9a-f]{32}/g, "<account>") } });
    process.stderr.write("enable the timer: re-run `vault server install` (it enables kuma-vault-backup.timer when backup is configured)\n");
    return 0;
  }

  if (verb === "unconfigure") {
    if (!config.backup) {
      process.stdout.write("backup is not configured\n");
      return 0;
    }
    const { backup, ...rest } = config;
    writeServerConfig(configPath, rest);
    process.stderr.write("backup block removed; re-run `vault server install` to disable the timer\n");
    return 0;
  }

  if (verb === "pre-cutover-clock") {
    if (!config.backup) throw new Error("backup is not configured");
    const startedAt = parseClockStart(options["started-at"]);
    if (config.backup.preCutover.clockStartedAt && !options.replace) {
      throw new Error(`the pre-cutover clock already started at ${config.backup.preCutover.clockStartedAt} (pass --replace to move it)`);
    }
    config = writeServerConfig(configPath, { ...config, backup: { ...config.backup, preCutover: { ...config.backup.preCutover, clockStartedAt: startedAt } } });
    const deadline = new Date(Date.parse(startedAt) + config.backup.preCutover.retentionDays * 86_400_000);
    print({ clockStartedAt: startedAt, retentionDays: config.backup.preCutover.retentionDays, deadline: deadline.toISOString() });
    return 0;
  }

  if (verb === "status") {
    const stores = typeof options.store === "string" ? [options.store] : Object.keys(config.stores);
    const out = {};
    for (const id of stores) out[id] = readBackupStatus(storePaths(config.stores[id].path).backupStatus);
    print(out);
    return 0;
  }

  if (!config.backup) throw new Error("backup is not configured (vault server backup configure --repository ...)");

  if (STORE_VERBS.has(verb) && process.getuid?.() === 0) return reexecAsStoreOwner(config, configPath, argv);

  const now = parseNow(options.now);
  switch (verb) {
    case "nightly": {
      const report = await nightly({ config, configPath, now, log: (line) => process.stdout.write(`${line}\n`) });
      return report.ok ? 0 : 1;
    }
    case "run": {
      let ok = true;
      for (const storeId of storesOption(config, options)) {
        const run = await runStoreBackup({ config, configPath, storeId, now });
        print({ store: storeId, ...run });
        ok &&= run.result === "ok";
      }
      return ok ? 0 : 1;
    }
    case "forget": {
      let ok = true;
      for (const storeId of storesOption(config, options)) {
        const record = await forgetOwnGroup({ config, storeId, now });
        print({ store: storeId, ...record });
        ok &&= record.result === "ok";
      }
      return ok ? 0 : 1;
    }
    case "drill": {
      let ok = true;
      for (const storeId of storesOption(config, options)) {
        const record = await drill({ config, storeId, snapshot: typeof options.snapshot === "string" ? options.snapshot : undefined, now, keep: Boolean(options.keep) });
        print({ store: storeId, ...record });
        ok &&= record.result === "ok";
      }
      return ok ? 0 : 1;
    }
    case "retention": {
      const record = await preCutoverRetention({ config, now });
      print(record);
      return 0;
    }
    case "forget-path": {
      print(await forgetPath({ config, host: options.host, path: options.path, dryRun: Boolean(options["dry-run"]) }));
      return 0;
    }
    case "restore": {
      if (typeof options.store !== "string" || typeof options.target !== "string") throw new Error("restore needs --store <id> --target <dir>");
      print(await restoreStore({ config, storeId: options.store, snapshot: typeof options.snapshot === "string" ? options.snapshot : undefined, target: resolve(options.target) }));
      return 0;
    }
    default:
      process.stdout.write(BACKUP_USAGE);
      return 1;
  }
}

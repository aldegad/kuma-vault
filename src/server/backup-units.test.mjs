import { describe, expect, it } from "vitest";

import { planPreCutover, preCutoverDeadline, recordRun, sample } from "./backup.mjs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { parseFlags } from "../cli/cli-options.mjs";
import { commandBackup, parseClockStart } from "./backup-cli.mjs";
import { BACKUP_ON_CALENDAR, renderBackupService, renderBackupTimer } from "./backup-units.mjs";
import { normalizeServerConfig } from "./server-config.mjs";

const base = { version: 1, listen: ["127.0.0.1:7741"], dataDir: "/data/vaults", stores: { a: {}, b: {} } };

describe("server.json backup block", () => {
  it("is absent unless configured, and fills defaults when present", () => {
    expect(normalizeServerConfig(base).backup).toBeUndefined();
    const { backup } = normalizeServerConfig({ ...base, backup: { repository: "s3:https://x.example/bucket", host: "vault-server" } });
    expect(backup).toEqual({
      repository: "s3:https://x.example/bucket",
      host: "vault-server",
      stores: null,
      credentialsDir: "/etc/kuma-vault/credentials",
      keep: { daily: 14, weekly: 8, monthly: 12 },
      drill: { text: 50, cas: 50 },
      preCutover: { tag: "pre-cutover", retentionDays: 14, clockStartedAt: null },
      retryLock: "2h",
    });
  });

  it("has no default host: a block without one is refused, not filled from this machine", () => {
    // the host is the group forget, drill and restore select by; a default read at load time
    // would move it when the machine is renamed
    expect(() => normalizeServerConfig({ ...base, backup: { repository: "r" } })).toThrow(/backup.host.*required/);
    expect(() => normalizeServerConfig({ ...base, backup: { repository: "r", host: null } })).toThrow(/backup.host.*required/);
  });

  it("rejects what would make forget unsafe or the config ambiguous", () => {
    const bad = (backup) => () => normalizeServerConfig({ ...base, backup: { host: "vault-server", ...backup } });
    expect(bad({})).toThrow(/backup.repository/);
    expect(bad({ repository: "r", keep: { daily: 0, weekly: 0, monthly: 0 } })).toThrow(/non-zero keep/);
    expect(bad({ repository: "r", stores: ["nope"] })).toThrow(/unknown store "nope"/);
    expect(bad({ repository: "r", host: "bad host" })).toThrow(/backup.host/);
    expect(bad({ repository: "r", preCutover: { clockStartedAt: "2026-10-05" } })).toThrow(/clockStartedAt/);
    expect(bad({ repository: "r", preCutover: { clockStartedAt: "2026-10-05T00:00:00Z junk" } })).toThrow(/clockStartedAt/);
    expect(bad({ repository: "r", surprise: 1 })).toThrow(/unknown key "surprise"/);
    expect(normalizeServerConfig({ ...base, backup: { repository: "r", host: "vault-server", preCutover: { clockStartedAt: "2026-10-05T00:00:00+09:00" } } }).backup.preCutover.clockStartedAt).toBe("2026-10-05T00:00:00+09:00");
  });
});

describe("pre-cutover clock", () => {
  it("reads a bare date as the start of that day in KST", () => {
    expect(parseClockStart("2026-10-05")).toBe("2026-10-05T00:00:00+09:00");
    expect(parseClockStart("2026-10-05T13:00:00Z")).toBe("2026-10-05T13:00:00Z");
    expect(() => parseClockStart("2026-10-05T13:00:00")).toThrow(/offset/);
    expect(() => parseClockStart(undefined)).toThrow();
  });

  const backup = (clockStartedAt, retentionDays = 14) => ({ preCutover: { tag: "pre-cutover", retentionDays, clockStartedAt } });
  const snaps = [
    { id: "a".repeat(64), short_id: "aaaaaaaa", time: "2026-10-04T05:00:00Z", hostname: "mac", paths: ["/old"], tags: ["scheduled", "pre-cutover"] },
    { id: "b".repeat(64), short_id: "bbbbbbbb", time: "2026-10-04T06:00:00Z", hostname: "mac", paths: ["/old"], tags: ["scheduled"] },
    { id: "c".repeat(64), short_id: "cccccccc", time: "2027-03-01T00:00:00Z", hostname: "mac", paths: ["/new"], tags: ["pre-cutover"] },
  ];

  it("keeps everything until the clock starts and until the deadline", () => {
    expect(planPreCutover(backup(null), snaps, new Date("2030-01-01")).state).toBe("clock-not-started");
    const keeping = planPreCutover(backup("2026-10-05T00:00:00+09:00"), snaps, new Date("2026-10-18T14:59:59Z"));
    expect(keeping).toMatchObject({ state: "keeping", deadline: "2026-10-18T15:00:00.000Z", forget: [] });
    expect(keeping.snapshots.map((s) => s.id)).toEqual(["aaaaaaaa", "cccccccc"]);
  });

  it("after the deadline forgets only tagged snapshots taken before the clock started", () => {
    const expired = planPreCutover(backup("2026-10-05T00:00:00+09:00"), snaps, new Date("2026-10-18T15:00:00Z"));
    expect(expired.state).toBe("expired");
    expect(expired.forget).toEqual(["a".repeat(64)]);
    expect(planPreCutover(backup("2026-10-05T00:00:00+09:00"), snaps.slice(1), new Date("2026-11-01")).state).toBe("deleted");
    expect(preCutoverDeadline(backup("2026-10-05T00:00:00+09:00", 0)).toISOString()).toBe("2026-10-04T15:00:00.000Z");
  });
});

describe("backup status", () => {
  it("counts consecutive successes and keeps lastBackupAt at the last good snapshot start", () => {
    let s = {};
    s = recordRun(s, { at: "t1", result: "ok", snapshotId: "s1", snapshotTime: "T1" });
    s = recordRun(s, { at: "t2", result: "ok", snapshotId: "s2", snapshotTime: "T2" });
    expect(s).toMatchObject({ consecutiveOk: 2, lastBackupAt: "T2", lastSnapshotId: "s2", lastResult: "ok", lastError: null });
    s = recordRun(s, { at: "t3", result: "failed", error: "boom" });
    expect(s).toMatchObject({ consecutiveOk: 0, lastBackupAt: "T2", lastResult: "failed", lastError: "boom" });
    for (let i = 0; i < 40; i += 1) s = recordRun(s, { at: `x${i}`, result: "ok", snapshotId: `x${i}`, snapshotTime: `X${i}` });
    expect(s.runs).toHaveLength(30);
    expect(s.consecutiveOk).toBe(30);
  });

  it("samples deterministically per snapshot", () => {
    const items = Array.from({ length: 500 }, (_, i) => i);
    expect(sample(items, 50, "abcdef12")).toEqual(sample(items, 50, "abcdef12"));
    expect(sample(items, 50, "abcdef12")).not.toEqual(sample(items, 50, "12abcdef"));
    expect(new Set(sample(items, 50, "abcdef12")).size).toBe(50);
    expect(sample(items.slice(0, 3), 50, "ff")).toHaveLength(3);
  });
});

describe("backup units", () => {
  const opts = { configPath: "/etc/kuma-vault/server.json", dataDir: "/data/vaults", credentialsDir: "/etc/kuma-vault/credentials", nodeBin: "/opt/node/current/bin", user: "kuma-vault", engineBase: "/opt/kuma-vault" };

  it("runs as the store owner with systemd credentials, never a secret on the command line", () => {
    const unit = renderBackupService(opts);
    expect(unit).toContain("User=kuma-vault");
    expect(unit).toContain("LoadCredential=restic-password:/etc/kuma-vault/credentials/restic-password");
    expect(unit).toContain("LoadCredential=s3-access-key-id:/etc/kuma-vault/credentials/s3-access-key-id");
    expect(unit).toContain("ReadWritePaths=/data/vaults");
    expect(unit).toContain("ExecStart=/opt/kuma-vault/current/bin/vault server backup nightly --config /etc/kuma-vault/server.json");
    expect(unit).not.toMatch(/AWS_|RESTIC_PASSWORD=/);
  });

  it("fires an hour after the Mac routine, catching up after downtime", () => {
    expect(BACKUP_ON_CALENDAR).toBe("*-*-* 04:30:00 Asia/Seoul");
    expect(renderBackupTimer()).toContain("Persistent=true");
  });
});

describe("backup configure / clock / unconfigure", () => {
  it("writes, guards and removes the backup block through the CLI", async () => {
    const configPath = join(mkdtempSync(join(tmpdir(), "kv-bcli-")), "server.json");
    writeFileSync(configPath, JSON.stringify(base));
    const run = (args) => commandBackup(args, { parseFlags, configPathOf: () => configPath });
    const read = () => JSON.parse(readFileSync(configPath, "utf8"));
    const out = process.stdout.write;
    const err = process.stderr.write;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try {
      await expect(run(["configure"])).rejects.toThrow(/--repository/);
      expect(await run(["configure", "--repository", "s3:https://e.example/b", "--stores", "a", "--retention-days", "21"])).toBe(0);
      expect(read().backup).toMatchObject({ repository: "s3:https://e.example/b", stores: ["a"], preCutover: { retentionDays: 21, clockStartedAt: null } });
      // no --host: this machine's hostname, written into server.json and kept on later runs
      expect(read().backup.host).toBe(hostname());
      expect(await run(["configure", "--host", "vault-server-2"])).toBe(0);
      expect(read().backup).toMatchObject({ host: "vault-server-2", repository: "s3:https://e.example/b" });
      expect(await run(["configure", "--keep-daily", "7"])).toBe(0);
      expect(read().backup).toMatchObject({ host: "vault-server-2", keep: { daily: 7 } });
      expect(await run(["pre-cutover-clock", "--started-at", "2026-10-05"])).toBe(0);
      await expect(run(["pre-cutover-clock", "--started-at", "2026-10-06"])).rejects.toThrow(/already started/);
      expect(await run(["pre-cutover-clock", "--started-at", "2026-10-06", "--replace"])).toBe(0);
      expect(read().backup.preCutover.clockStartedAt).toBe("2026-10-06T00:00:00+09:00");
      expect(await run(["unconfigure"])).toBe(0);
      expect(read().backup).toBeUndefined();
      await expect(run(["drill"])).rejects.toThrow(/not configured/);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
  });
});


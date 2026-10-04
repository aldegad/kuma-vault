import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { subGitignores } from "./backup-cli.mjs";
import { decide, judgeAlertPath, judgeClean72h, judgeServerBackups, judgeSubGitignores, redDurationMs, sampleFromSyncStatus } from "./retirement.mjs";

const NOW = new Date("2026-10-20T00:00:00Z");
const H = 3_600_000;

function hourlySamples({ dirtyAt = null, gapAt = null, aheadAtBackup = 0, backupDays = 3 } = {}) {
  const out = [];
  for (let h = 0; h < 72; h += 1) {
    if (h === gapAt) continue;
    const ts = new Date(NOW.getTime() - (72 - h) * H + 30 * 60_000).toISOString();
    out.push({ ts, kind: "hourly", ahead: 0, uncollected: h === dirtyAt ? 1 : 0, ignoredOutsideLfsExt: 0 });
  }
  for (let d = 0; d < backupDays; d += 1) {
    const ts = new Date(NOW.getTime() - (72 - d * 24 - 4) * H).toISOString();
    out.push({ ts, kind: "mac-backup", ahead: aheadAtBackup, uncollected: 0, ignoredOutsideLfsExt: 0 });
  }
  return out;
}

const goodStatus = {
  runs: [
    { at: "1", result: "ok", snapshotId: "s1" },
    { at: "2", result: "ok", snapshotId: "s2" },
    { at: "3", result: "ok", snapshotId: "s3" },
  ],
  lastDrill: { result: "ok", snapshotId: "s3", text: { live: 80, required: 50, available: 80, matched: 50, sampled: 50, mismatches: [] }, cas: { live: 70, required: 50, available: 70, matched: 50, sampled: 50, mismatches: [] } },
};
const goodProbe = { at: "2026-10-16T00:00:00Z", injected: "uncollected", chipRed: true, ownerMessage: { deliveredAt: "2026-10-16T00:00:05Z" } };
const inputs = { now: NOW, routineEnabled: true, retired: false, backupStatus: goodStatus, alertProbe: goodProbe, samples: hourlySamples(), subGitignores: [], syncStatus: null };

describe("condition 1: server backups", () => {
  it("needs three consecutive ok runs and a passing drill on one of them", () => {
    expect(judgeServerBackups(goodStatus).ok).toBe(true);
    expect(judgeServerBackups({ runs: goodStatus.runs.slice(1), lastDrill: goodStatus.lastDrill }).ok).toBe(false);
    expect(judgeServerBackups({ ...goodStatus, runs: [...goodStatus.runs.slice(0, 2), { result: "failed" }] }).ok).toBe(false);
    expect(judgeServerBackups({ ...goodStatus, lastDrill: { ...goodStatus.lastDrill, result: "failed", error: "cas 49/50" } }).detail).toMatch(/cas 49\/50/);
    expect(judgeServerBackups({ ...goodStatus, lastDrill: { ...goodStatus.lastDrill, snapshotId: "old" } }).ok).toBe(false);
    expect(judgeServerBackups(null).ok).toBe(false);
  });

  it("does not count a drill that sampled nothing, fell short of its floor or predates the floors", () => {
    const withDrill = (kind, patch) => ({ ...goodStatus, lastDrill: { ...goodStatus.lastDrill, [kind]: { ...goodStatus.lastDrill[kind], ...patch } } });
    // a drill that read no CAS listing (cas 0/0) is ok by sha256 but proves nothing
    const empty = judgeServerBackups(withDrill("cas", { live: 0, required: 0, available: 0, sampled: 0, matched: 0 }));
    expect(empty).toMatchObject({ ok: false });
    expect(empty.detail).toMatch(/sampled no cas/);
    expect(judgeServerBackups(withDrill("text", { required: 0, sampled: 0, matched: 0 })).detail).toMatch(/sampled no text/);
    expect(judgeServerBackups(withDrill("cas", { required: 50, sampled: 20, matched: 20 })).detail).toMatch(/below its floor 50/);
    expect(judgeServerBackups(withDrill("cas", { matched: 49 })).ok).toBe(false);
    const { required, ...noFloor } = goodStatus.lastDrill.cas;
    expect(judgeServerBackups({ ...goodStatus, lastDrill: { ...goodStatus.lastDrill, cas: noFloor } }).detail).toMatch(/before the sample floors/);
  });
});

describe("condition 2: alert path", () => {
  it("needs the injected uncollected alert seen as a red chip and a delivered owner message", () => {
    expect(judgeAlertPath(goodProbe).ok).toBe(true);
    expect(judgeAlertPath(null).ok).toBe(false);
    expect(judgeAlertPath({ ...goodProbe, chipRed: false }).ok).toBe(false);
    expect(judgeAlertPath({ ...goodProbe, ownerMessage: {} }).ok).toBe(false);
    expect(judgeAlertPath({ ...goodProbe, injected: "growth" }).ok).toBe(false);
  });
});

describe("condition 3: 72 clean hours", () => {
  it("passes a full clean window", () => {
    expect(judgeClean72h(hourlySamples(), NOW).ok).toBe(true);
  });
  it("fails a missing hour, a dirty sample, unpushed commits at a Mac backup, or too few backups", () => {
    expect(judgeClean72h(hourlySamples({ gapAt: 40 }), NOW).detail).toMatch(/1 of 72 hours have no sample/);
    expect(judgeClean72h(hourlySamples({ dirtyAt: 10 }), NOW).ok).toBe(false);
    expect(judgeClean72h(hourlySamples({ aheadAtBackup: 2 }), NOW).detail).toMatch(/unpushed/);
    expect(judgeClean72h(hourlySamples({ backupDays: 2 }), NOW).detail).toMatch(/2 of 3 days/);
    expect(judgeClean72h(hourlySamples(), new Date(NOW.getTime() + 2 * H)).ok).toBe(false); // window moved past the samples
  });
});

describe("condition 4: sub-directory .gitignore files", () => {
  it("passes only when none with an active rule is left", () => {
    expect(judgeSubGitignores([]).ok).toBe(true);
    expect(judgeSubGitignores(["vault/x/.gitignore"]).ok).toBe(false);
    expect(judgeSubGitignores(null).ok).toBe(false);
  });

  it("finds tracked and untracked sub .gitignore files with rules, not the root one or comment-only ones", () => {
    const repo = mkdtempSync(join(tmpdir(), "retire-gi-"));
    spawnSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".gitignore"), "*.tmp\n");
    mkdirSync(join(repo, "vault", "a"), { recursive: true });
    mkdirSync(join(repo, "vault", "b"), { recursive: true });
    mkdirSync(join(repo, "vault", "c"), { recursive: true });
    writeFileSync(join(repo, "vault", "a", ".gitignore"), "renders/\n");
    writeFileSync(join(repo, "vault", "b", ".gitignore"), "# only a comment\n\n");
    writeFileSync(join(repo, "vault", "c", ".gitignore"), "bg/\n");
    spawnSync("git", ["-C", repo, "add", "vault/a/.gitignore"]);
    expect(subGitignores(repo)).toEqual(["vault/a/.gitignore", "vault/c/.gitignore"]);
  });
});

describe("decision", () => {
  it("retires only when all four hold and the routine is on", () => {
    expect(decide(inputs).action).toBe("retire");
    expect(decide({ ...inputs, subGitignores: ["vault/x/.gitignore"] })).toMatchObject({ action: "keep-running", reason: "sub-gitignores" });
    expect(decide({ ...inputs, routineEnabled: false }).action).toBe("keep-running");
  });

  it("stays retired until uncollected has been red for six hours, then turns the routine back on", () => {
    const red = (sinceHoursAgo) => ({ alerts: { uncollected: { count: 3, since: new Date(NOW.getTime() - sinceHoursAgo * H).toISOString() } } });
    const retired = { ...inputs, routineEnabled: false, retired: true };
    expect(decide({ ...retired, syncStatus: null }).action).toBe("stay-retired");
    expect(decide({ ...retired, syncStatus: red(6.9) }).action).toBe("stay-retired"); // red for 5.9 h
    expect(decide({ ...retired, syncStatus: red(7) })).toMatchObject({ action: "reenable" }); // red since 1 h after `since`, now 6 h
    expect(redDurationMs(red(0.5), NOW)).toBe(0);
    expect(redDurationMs({ alerts: { uncollected: { count: 0, since: null } } }, NOW)).toBe(0);
  });
});

describe("samples", () => {
  it("copies the three judged fields and refuses a status without them", () => {
    const status = { state: "ok", ahead: 0, alerts: { uncollected: { count: 0, since: null, paths: [] }, ignoredOutside: { count: 1, bytes: 9, lfsExt: 0 } } };
    expect(sampleFromSyncStatus(status, { kind: "mac-backup", now: NOW })).toEqual({ ts: NOW.toISOString(), kind: "mac-backup", state: "ok", ahead: 0, uncollected: 0, ignoredOutsideLfsExt: 0 });
    expect(() => sampleFromSyncStatus({ state: "ok" })).toThrow(/lacks/);
  });
});

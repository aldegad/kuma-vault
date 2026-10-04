// End-to-end against a real restic repository on local disk: a store with commits and CAS
// objects, the nightly job (backup, own-group forget, drill), the forget range (another host's
// group and the pre-cutover tag stay), the old-path thinning, the pre-cutover retention clock,
// and the drill catching a wrong snapshot and a changed CAS object. A shim in front of restic
// changes the `ls --json` output and drops forget's filters, so the drill's sample floors and the
// forget checks that run before anything is forgotten are exercised. Needs git + restic on PATH.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyRefsManifest, drill, forgetOwnGroup, forgetPath, nightly, preCutoverRetention, readBackupStatus, restoreStore, runStoreBackup } from "./backup.mjs";
import { renderLfsPointer } from "./lfs-paths.mjs";
import { normalizeServerConfig } from "./server-config.mjs";
import { casObjectPath, initStore, storePaths } from "./store-layout.mjs";

const MAC = "users-macbook.local";
let root;
let repo;
let configPath;
let config;
let store;
let work;
let env;
let shimDir;
let realRestic;

function sh(cmd, args, { cwd, input, allowFail = false, extraEnv = {} } = {}) {
  const result = spawnSync(cmd, args, { cwd, input, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", ...extraEnv } });
  const out = { code: result.status, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
  if (out.code !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")} (${out.code})\n${out.stderr}`);
  return out;
}
const git = (cwd, args, opts) => sh("git", args, { cwd, ...opts });
const restic = (args, opts = {}) => sh("restic", ["-r", repo, ...args], { ...opts, extraEnv: { RESTIC_PASSWORD_FILE: join(root, "creds", "restic-password"), RESTIC_CACHE_DIR: join(root, "cache") } });
const snapshots = (filters = []) => JSON.parse(restic(["snapshots", "--json", ...filters]).stdout);
const ids = (list) => list.map((s) => s.short_id).sort();

function addCas(content) {
  const oid = createHash("sha256").update(content).digest("hex");
  const path = casObjectPath(store.lfsObjects, oid);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, { mode: 0o444 });
  return { oid, size: content.length };
}

/** Commit files in the work clone and bring them into origin.git (fetch: no receive hooks). */
function commitAndLand(files, message) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", message]);
  git(store.gitDir, ["fetch", "-q", work, "+main:refs/heads/main"]);
  return git(work, ["rev-parse", "HEAD"]).stdout.trim();
}

// KV_SHIM_LS=renamed|garbled|short changes `restic ls` output; KV_SHIM_FORGET_DROP drops the named
// flags (and their values) from `restic forget`, the way a filter regression would, and
// KV_SHIM_KEEP_TAG swaps the value of forget's --keep-tag.
const SHIM = `#!/bin/bash
real="$KV_REAL_RESTIC"
if [ "$1" = forget ] && [ -n "$KV_SHIM_FORGET_DROP$KV_SHIM_KEEP_TAG" ]; then
  args=(); skip=0; prev=
  for a in "$@"; do
    if [ $skip = 1 ]; then skip=0; continue; fi
    if [ "$prev" = --keep-tag ] && [ -n "$KV_SHIM_KEEP_TAG" ]; then a="$KV_SHIM_KEEP_TAG"; fi
    prev="$a"
    for d in $KV_SHIM_FORGET_DROP; do [ "$a" = "$d" ] && skip=1; done
    [ $skip = 1 ] && continue
    args+=("$a")
  done
  exec "$real" "\${args[@]}"
fi
if [ "$1" = ls ] && [ "$KV_SHIM_LS" = renamed ]; then
  "$real" "$@" | sed 's/"struct_type":"node"/"struct_type":"entry"/'; exit \${PIPESTATUS[0]}
fi
if [ "$1" = ls ] && [ "$KV_SHIM_LS" = short ]; then
  "$real" "$@" | awk 'NR % 2 == 1'; exit \${PIPESTATUS[0]}
fi
if [ "$1" = ls ] && [ "$KV_SHIM_LS" = garbled ]; then
  "$real" "$@" | sed 's/^{/entry {/'; exit \${PIPESTATUS[0]}
fi
exec "$real" "$@"
`;
const shimEnv = (extra = {}) => ({ ...env, PATH: `${shimDir}:${process.env.PATH}`, KV_REAL_RESTIC: realRestic, ...extra });
const allIds = () => ids(snapshots());

/** A snapshot of some other path, with a host, tags and a time of our choosing. */
function seed(host, path, time, tags = []) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "f.txt"), `${host} ${time} ${randomBytes(4).toString("hex")}`);
  restic(["backup", "-q", "--host", host, "--time", time, ...tags.flatMap((t) => ["--tag", t]), path]);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "kv-backup-"));
  repo = join(root, "repo");
  mkdirSync(join(root, "creds"), { mode: 0o700 });
  writeFileSync(join(root, "creds", "restic-password"), "test-password\n", { mode: 0o600 });
  writeFileSync(join(root, "creds", "s3-access-key-id"), "unused-for-local\n", { mode: 0o600 });
  writeFileSync(join(root, "creds", "s3-secret-access-key"), "unused-for-local\n", { mode: 0o600 });
  restic(["init", "-q"]);
  const etc = join(root, "etc");
  mkdirSync(join(etc, "credentials"), { recursive: true });
  writeFileSync(join(etc, "credentials", "secret"), "never in a snapshot");
  chmodSync(join(etc, "credentials"), 0o700);
  configPath = join(etc, "server.json");
  config = normalizeServerConfig({
    version: 1,
    listen: ["127.0.0.1:0"],
    dataDir: join(root, "data"),
    stores: { main: {} },
    backup: {
      repository: repo,
      host: "vault-server",
      credentialsDir: join(etc, "credentials"),
      keep: { daily: 2, weekly: 1, monthly: 0 },
      drill: { text: 50, cas: 50 },
      retryLock: "1m",
    },
  });
  writeFileSync(configPath, JSON.stringify(config));
  store = await initStore(config.stores.main.path, { vaultBin: "/bin/false" });
  env = { ...process.env, CREDENTIALS_DIRECTORY: join(root, "creds"), CACHE_DIRECTORY: join(root, "cache") };
  realRestic = sh("bash", ["-c", "command -v restic"]).stdout.trim();
  shimDir = join(root, "shim");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "restic"), SHIM, { mode: 0o755 });

  work = join(root, "work");
  git(root, ["init", "-q", "-b", "main", work]);
  git(work, ["config", "user.name", "t"]);
  git(work, ["config", "user.email", "t@test.invalid"]);
  const files = {};
  for (let i = 0; i < 80; i += 1) files[`vault/notes/n${i}.md`] = `# note ${i}\n${randomBytes(64).toString("hex")}\n`;
  for (let i = 0; i < 70; i += 1) {
    const cas = addCas(randomBytes(1000 + i * 37));
    files[`vault/media/m${i}.png`] = renderLfsPointer(cas.oid, cas.size);
  }
  commitAndLand(files, "first");
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("nightly against a local restic repository", () => {
  it("backs up the thin set, forgets nothing yet, and the drill matches 50 text + 50 CAS samples", async () => {
    const report = await nightly({ config, configPath, env });
    expect(report.ok).toBe(true);
    const status = readBackupStatus(store.backupStatus);
    expect(status).toMatchObject({ lastResult: "ok", consecutiveOk: 1, host: "vault-server" });
    expect(status.lastDrill).toMatchObject({ result: "ok", fsck: "ok", text: { sampled: 50, matched: 50 }, cas: { sampled: 50, matched: 50, restoredFiles: 50 } });
    expect(status.preCutover.state).toBe("clock-not-started");
    const [snap] = snapshots(["--host", "vault-server"]);
    expect(snap.tags).toEqual(["main"]);
    expect(snap.paths.sort()).toEqual([store.gitDir, store.lfsObjects, store.state, join(root, "etc")].sort());
    const listing = restic(["ls", "latest", "--host", "vault-server"]).stdout;
    expect(listing).toContain("/origin.git/HEAD");
    expect(listing).toContain("backup-refs.json");
    expect(listing).not.toContain("/tree/");
    expect(listing).not.toContain("/lfs/incoming");
    expect(listing).not.toContain("credentials");
  }, 120_000);

  it("restores whole to another path; refs reset to the manifest even if a push landed mid-backup", async () => {
    const before = git(store.gitDir, ["rev-parse", "refs/heads/main"]).stdout.trim();
    const run = await runStoreBackup({ config, configPath, storeId: "main", env });
    expect(run.result).toBe("ok");
    const target = join(root, "restore-elsewhere");
    const restored = await restoreStore({ config, storeId: "main", target, env });
    expect(restored).toMatchObject({ head: before, refs: 1, casFiles: 70 });
    expect(restored.gitFiles).toBeGreaterThan(0);
    expect(git(join(target, store.gitDir), ["rev-parse", "refs/heads/main"]).stdout.trim()).toBe(before);
    await expect(restoreStore({ config, storeId: "main", target, env })).rejects.toThrow(/not empty/);
  }, 120_000);

  it("applyRefsManifest drops a ref that points past the recorded objects and refuses a missing object", async () => {
    const bare = join(root, "race.git");
    git(root, ["clone", "-q", "--bare", store.gitDir, bare]);
    const a = git(bare, ["rev-parse", "refs/heads/main"]).stdout.trim();
    // a commit whose objects the "snapshot" did not capture
    const tree = git(bare, ["mktree"], { input: "" }).stdout.trim();
    const b = git(bare, ["commit-tree", tree, "-p", a, "-m", "pushed mid-backup"], { extraEnv: { GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).stdout.trim();
    git(bare, ["update-ref", "refs/heads/main", b]);
    git(bare, ["update-ref", "refs/heads/stray", b]);
    rmSync(join(bare, "objects", b.slice(0, 2), b.slice(2)));
    await applyRefsManifest(bare, { refs: { "refs/heads/main": a } });
    expect(git(bare, ["rev-parse", "refs/heads/main"]).stdout.trim()).toBe(a);
    expect(git(bare, ["for-each-ref", "--format=%(refname)"]).stdout.trim()).toBe("refs/heads/main");
    await expect(applyRefsManifest(bare, { refs: { "refs/heads/main": b } })).rejects.toThrow();
  }, 60_000);

  it("the drill fails when the CAS listing comes back empty or garbled, or the snapshot lacks lfs/objects", async () => {
    await runStoreBackup({ config, configPath, storeId: "main", env });
    // positive control: the shim passes restic through untouched
    const through = await drill({ config, storeId: "main", env: shimEnv() });
    expect(through).toMatchObject({ result: "ok", cas: { live: 70, required: 50, available: 70, sampled: 50, matched: 50 }, text: { live: 80, required: 50, sampled: 50, matched: 50 } });

    const renamed = await drill({ config, storeId: "main", env: shimEnv({ KV_SHIM_LS: "renamed" }) });
    expect(renamed).toMatchObject({ result: "failed", cas: { live: 70, available: 0, sampled: 0 } });
    expect(renamed.error).toMatch(/listed no CAS object .* holds 70/);
    expect(readBackupStatus(store.backupStatus).lastDrill.result).toBe("failed");

    // a listing that lost every other line (files and directories alike): under 50 of 70 listed
    const short = await drill({ config, storeId: "main", env: shimEnv({ KV_SHIM_LS: "short" }) });
    expect(short).toMatchObject({ result: "failed", cas: { live: 70, required: 50 } });
    expect(short.cas.sampled).toBeGreaterThan(0);
    expect(short.cas.sampled).toBeLessThan(50);
    expect(short.error).toMatch(/CAS sample \d+ below the floor 50/);

    // with CAS sampling turned off the floor is 0, but an empty listing of a non-empty store still fails
    const noCasAsked = { ...config, backup: { ...config.backup, drill: { ...config.backup.drill, cas: 0 } } };
    const off = await drill({ config: noCasAsked, storeId: "main", env: shimEnv({ KV_SHIM_LS: "renamed" }) });
    expect(off.result).toBe("failed");
    expect(off.error).toMatch(/listed no CAS object/);

    const garbled = await drill({ config, storeId: "main", env: shimEnv({ KV_SHIM_LS: "garbled" }) });
    expect(garbled.result).toBe("failed");
    expect(garbled.error).toMatch(/not JSON/);

    // a snapshot of this host and store that holds origin.git and state but not lfs/objects
    restic(["backup", "-q", "--host", "vault-server", "--tag", "main", store.gitDir, store.state]);
    const [noCas] = snapshots(["--host", "vault-server", "--latest", "1"]).filter((s) => !s.paths.includes(store.lfsObjects));
    const missing = await drill({ config, storeId: "main", snapshot: noCas.short_id, env });
    expect(missing.result).toBe("failed");
    expect(missing.error).toMatch(/listed no CAS object/);
    restic(["forget", "-q", noCas.id]);
  }, 180_000);

  it("the drill fails on a store with nothing to verify", async () => {
    const both = normalizeServerConfig({ ...config, stores: { main: {}, empty: {} } });
    const empty = await initStore(both.stores.empty.path, { vaultBin: "/bin/false" });
    const run = await runStoreBackup({ config: both, configPath, storeId: "empty", env });
    expect(run.result).toBe("ok");
    const record = await drill({ config: both, storeId: "empty", env });
    expect(record).toMatchObject({ result: "failed", text: { live: 0, sampled: 0 }, cas: { live: 0, sampled: 0 } });
    expect(record.error).toMatch(/nothing to verify/);
    expect(readBackupStatus(empty.backupStatus).lastDrill.result).toBe("failed");
    for (const s of snapshots(["--tag", "empty"])) restic(["forget", "-q", s.id]);
  }, 120_000);

  it("the drill fails on a snapshot that does not hold the store and on a changed CAS object", async () => {
    seed("elsewhere", join(root, "other"), "2026-09-01 00:00:00");
    const [other] = snapshots(["--host", "elsewhere"]);
    const wrong = await drill({ config, storeId: "main", snapshot: other.short_id, env });
    expect(wrong).toMatchObject({ result: "failed" });
    expect(wrong.error).toMatch(/does not hold/);

    await runStoreBackup({ config, configPath, storeId: "main", env });
    // corrupt every live CAS object after the backup: whichever 50 the drill samples, all differ
    const out = sh("find", [store.lfsObjects, "-type", "f"]).stdout.trim().split("\n");
    for (const path of out) {
      chmodSync(path, 0o644);
      writeFileSync(path, "changed after the backup");
    }
    const bad = await drill({ config, storeId: "main", env });
    expect(bad.result).toBe("failed");
    expect(bad.cas.mismatches).toHaveLength(50);
    expect(readBackupStatus(store.backupStatus).lastDrill.result).toBe("failed");
  }, 120_000);
});

describe("forget range", () => {
  it("server forget removes only its own host's snapshots; the Mac group and pre-cutover stay", async () => {
    const macOld = join(root, "Users", "alice", "kuma-brain");
    const macNew = join(root, "Users", "alice", ".kuma", "vaults", "kuma-main-vault");
    for (const day of ["2026-09-01", "2026-09-10", "2026-09-20", "2026-09-30"]) seed(MAC, macOld, `${day} 18:30:00`, ["scheduled"]);
    seed(MAC, macOld, "2026-10-04 18:00:00", ["scheduled", "pre-cutover"]);
    seed(MAC, macNew, "2026-10-06 18:30:00", ["scheduled"]);
    for (const day of ["2026-08-01", "2026-08-15", "2026-09-01", "2026-09-15", "2026-09-28", "2026-09-29"]) {
      restic(["backup", "-q", "--host", "vault-server", "--tag", "main", "--time", `${day} 19:30:00`, store.gitDir, store.lfsObjects, store.state, join(root, "etc"), "--exclude", join(root, "etc", "credentials")]);
    }
    const macBefore = ids(snapshots(["--host", MAC]));
    const otherBefore = ids(snapshots(["--host", "elsewhere"]));
    const serverBefore = snapshots(["--host", "vault-server"]);

    const record = await forgetOwnGroup({ config, storeId: "main", env });
    expect(record.result).toBe("ok");
    expect(record.removed.length).toBeGreaterThan(0);
    expect(ids(snapshots(["--host", MAC]))).toEqual(macBefore);
    expect(ids(snapshots(["--host", "elsewhere"]))).toEqual(otherBefore);
    const serverAfter = snapshots(["--host", "vault-server"]);
    // keep daily 2 + weekly 1 over the group
    expect(serverAfter.length).toBeLessThan(serverBefore.length);
    expect(serverAfter.length).toBeLessThanOrEqual(3);
    restic(["check", "-q"]);
  }, 180_000);

  it("forget-path refuses a group without pre-cutover, and thins the old path to the pre-cutover snapshot only", async () => {
    const macOld = join(root, "Users", "alice", "kuma-brain");
    const macNew = join(root, "Users", "alice", ".kuma", "vaults", "kuma-main-vault");
    await expect(forgetPath({ config, host: MAC, path: macNew, env })).rejects.toThrow(/refusing: no pre-cutover/);
    const newBefore = ids(snapshots(["--host", MAC, "--path", macNew]));
    const serverBefore = ids(snapshots(["--host", "vault-server"]));
    const dry = await forgetPath({ config, host: MAC, path: macOld, dryRun: true, env });
    expect(dry.removed).toHaveLength(4);
    expect(snapshots(["--host", MAC, "--path", macOld])).toHaveLength(5);
    const done = await forgetPath({ config, host: MAC, path: macOld, env });
    expect(done.removed).toHaveLength(4);
    const left = snapshots(["--host", MAC, "--path", macOld]);
    expect(left).toHaveLength(1);
    expect(left[0].tags).toContain("pre-cutover");
    expect(ids(snapshots(["--host", MAC, "--path", macNew]))).toEqual(newBefore);
    expect(ids(snapshots(["--host", "vault-server"]))).toEqual(serverBefore);
  }, 180_000);
});

describe("pre-cutover retention clock", () => {
  it("keeps the snapshot before the deadline and forgets + prunes it after; a later tagged snapshot stays", async () => {
    const later = join(root, "later-cutover");
    seed(MAC, later, "2027-01-10 00:00:00", ["pre-cutover"]);
    const clocked = { ...config, backup: { ...config.backup, preCutover: { ...config.backup.preCutover, clockStartedAt: "2026-10-06T00:00:00+09:00", retentionDays: 14 } } };
    const tagged = () => snapshots(["--tag", "pre-cutover"]).map((s) => s.time.slice(0, 10)).sort();
    expect(tagged()).toEqual(["2026-10-04", "2027-01-10"]);

    const notStarted = await preCutoverRetention({ config, env, now: () => new Date("2030-01-01T00:00:00Z") });
    expect(notStarted.state).toBe("clock-not-started");
    const keeping = await preCutoverRetention({ config: clocked, env, now: () => new Date("2026-10-19T14:59:00Z") });
    expect(keeping).toMatchObject({ state: "keeping", deadline: "2026-10-19T15:00:00.000Z" });
    expect(tagged()).toEqual(["2026-10-04", "2027-01-10"]);

    const deleted = await preCutoverRetention({ config: clocked, env, now: () => new Date("2026-10-19T15:00:00Z") });
    expect(deleted.state).toBe("deleted");
    expect(deleted.deleted).toHaveLength(1);
    expect(tagged()).toEqual(["2027-01-10"]);
    const again = await preCutoverRetention({ config: clocked, env, now: () => new Date("2026-10-20T00:00:00Z") });
    expect(again.state).toBe("deleted");
    expect(again.deleted).toBeUndefined();
    restic(["check", "-q"]);
  }, 180_000);
});

describe("credentials", () => {
  it("fails the run loudly when the systemd credential directory lacks a file (no other source is tried)", async () => {
    const empty = join(root, "empty-creds");
    mkdirSync(empty);
    const run = await runStoreBackup({ config, configPath, storeId: "main", env: { ...env, CREDENTIALS_DIRECTORY: empty } });
    expect(run.result).toBe("failed");
    expect(run.error).toMatch(/restic-password unreadable in .*empty-creds \(systemd LoadCredential\)/);
    expect(existsSync(store.backupStatus)).toBe(true);
    expect(JSON.parse(readFileSync(store.backupStatus, "utf8")).consecutiveOk).toBe(0);
  });
});

describe("store settings", () => {
  it("turns off git's own gc so objects stay put while the backup reads them", () => {
    expect(git(store.gitDir, ["config", "receive.autogc"]).stdout.trim()).toBe("false");
    expect(git(store.gitDir, ["config", "gc.auto"]).stdout.trim()).toBe("0");
    expect(storePaths(config.stores.main.path).backupRefs).toBe(join(config.stores.main.path, "state", "backup-refs.json"));
  });
});

describe("forget checks its removals before forgetting anything", () => {
  // three snapshots on days far apart: keep daily 2 + weekly 1 leaves the oldest to remove
  const three = (host, path, tags) => {
    for (const day of ["2026-07-01", "2026-07-20", "2026-08-10"]) seed(host, path, `${day} 12:00:00`, tags);
  };

  it("own-group forget stops with nothing forgotten when restic would select another host, tag or pre-cutover", async () => {
    three("vault-server-2", join(root, "mixed", "host"), ["main"]);
    three("vault-server", join(root, "mixed", "tag"), ["other-store"]);
    three("vault-server", join(root, "mixed", "pre"), ["main", "pre-cutover"]);
    const before = allIds();
    for (const [drop, culprit] of [["--host", /vault-server-2, main/], ["--tag", /vault-server, other-store/], ["--keep-tag", /vault-server, main,pre-cutover/]]) {
      const record = await forgetOwnGroup({ config, storeId: "main", env: shimEnv({ KV_SHIM_FORGET_DROP: drop }) });
      expect(record.result).toBe("failed");
      expect(record.error).toMatch(/outside host vault-server tag main; nothing forgotten/);
      expect(record.error).toMatch(culprit);
      expect(record.pruned).toBeUndefined();
      expect(allIds()).toEqual(before);
    }
    // positive control: the same forget without the shim's damage runs and keeps every foreign group
    const ok = await forgetOwnGroup({ config, storeId: "main", env: shimEnv() });
    expect(ok.result).toBe("ok");
    expect(snapshots(["--host", "vault-server-2"])).toHaveLength(3);
    expect(snapshots(["--host", "vault-server", "--tag", "other-store"])).toHaveLength(3);
    expect(snapshots(["--host", "vault-server", "--tag", "pre-cutover"])).toHaveLength(3);
    restic(["check", "-q"]);
  }, 300_000);

  it("forget-path stops with nothing forgotten when restic would select another host or path", async () => {
    const path = join(root, "Users", "alice", "old-brain");
    const otherPath = join(root, "Users", "alice", "other-path");
    seed(MAC, path, "2026-08-01 18:30:00", ["scheduled"]);
    seed(MAC, path, "2026-08-02 18:30:00", ["scheduled"]);
    seed(MAC, path, "2026-08-03 18:00:00", ["scheduled", "pre-cutover"]);
    three("other-mac.local", path, ["scheduled"]);
    three(MAC, otherPath, ["scheduled"]);
    const before = allIds();
    for (const [drop, culprit] of [["--host", /other-mac\.local/], ["--path", /other-path/]]) {
      for (const dryRun of [true, false]) {
        await expect(forgetPath({ config, host: MAC, path, dryRun, env: shimEnv({ KV_SHIM_FORGET_DROP: drop }) })).rejects.toThrow(culprit);
        expect(allIds()).toEqual(before);
      }
    }
    // with --keep-tag pointing elsewhere the pre-cutover snapshot itself would be selected
    await expect(forgetPath({ config, host: MAC, path, env: shimEnv({ KV_SHIM_KEEP_TAG: "no-such-tag" }) })).rejects.toThrow(/tagged pre-cutover; nothing forgotten/);
    expect(allIds()).toEqual(before);
    // with no keep policy at all restic prints nothing: that is an error, not "nothing to remove"
    await expect(forgetPath({ config, host: MAC, path, env: shimEnv({ KV_SHIM_FORGET_DROP: "--keep-tag" }) })).rejects.toThrow(/unexpected restic forget output/);
    expect(allIds()).toEqual(before);
    // positive control
    const done = await forgetPath({ config, host: MAC, path, env: shimEnv() });
    expect(done.removed).toHaveLength(2);
    expect(snapshots(["--host", MAC, "--path", path]).map((s) => s.tags)).toEqual([["scheduled", "pre-cutover"]]);
    expect(snapshots(["--host", "other-mac.local"])).toHaveLength(3);
    expect(snapshots(["--host", MAC, "--path", otherPath])).toHaveLength(3);
  }, 300_000);
});

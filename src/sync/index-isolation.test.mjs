import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { gitBin } from "./git.mjs";
import { cloneStore } from "./clone.mjs";
import { main } from "./sync-cli.mjs";
import { launchdInstall } from "./launchd.mjs";

// Exercise the real install CLI and config writes on every OS; only the OS service is fake.
vi.mock("./launchd.mjs", () => ({ launchdInstall: vi.fn(), launchdStatus: vi.fn(), launchdUninstall: vi.fn() }));

let repo;
let env;
let binary;
function git(...args) {
  const r = spawnSync(binary, args, { cwd: repo, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  binary = gitBin();
  repo = mkdtempSync(join(process.env.KV_SYNC_TMP ?? tmpdir(), "kv-index-"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(repo, "absent-config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("KUMA_VAULT_SYNC_DIR", join(repo, ".git", "sync-state"));
  env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].includes(key)) delete env[key];
  git("init", "-q", "-b", "main");
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "feature.manyFiles", "true");
  git("config", "index.skipHash", "true");
  git("remote", "add", "origin", "https://example.invalid/v1/stores/fixture.git");
  writeFileSync(join(repo, "probe.seed"), "unchanged\n");
  writeFileSync(join(repo, "note.md"), "initial\n");
  writeFileSync(join(repo, ".gitattributes"), "probe.seed filter=barrier\n");
  git("add", ".");
  git("commit", "-qm", "seed");
  vi.mocked(launchdInstall).mockReset().mockImplementation(() => {
    expect(git("config", "--local", "--get", "index.skipHash")).toBe("false");
    expect(readFileSync(join(repo, ".git", "index")).subarray(-20).some((b) => b !== 0)).toBe(true);
    return { label: "fixture", plist: "fixture.plist" };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(repo, { recursive: true, force: true });
});

it("sync install checksums an existing index without changing staged blobs, and repeats safely", async () => {
  writeFileSync(join(repo, "note.md"), "staged\n");
  git("add", "note.md");
  writeFileSync(join(repo, "note.md"), "still being edited\n");
  const staged = git("ls-files", "--stage");
  expect(readFileSync(join(repo, ".git", "index")).subarray(-20).every((b) => b === 0)).toBe(true);
  for (let i = 0; i < 2; i++) {
    expect(await main(["sync", "install", "--repo", repo])).toBe(0);
    expect(git("ls-files", "--stage")).toBe(staged);
    expect(readFileSync(join(repo, "note.md"), "utf8")).toBe("still being edited\n");
  }
  expect(launchdInstall).toHaveBeenCalledTimes(2);
});

it("sync install refuses an occupied index lock before starting the service", async () => {
  const index = readFileSync(join(repo, ".git", "index"));
  writeFileSync(join(repo, ".git", "index.lock"), "other writer\n");
  await expect(main(["sync", "install", "--repo", repo])).rejects.toThrow(/index.lock/);
  expect(launchdInstall).not.toHaveBeenCalled();
  expect(readFileSync(join(repo, ".git", "index"))).toEqual(index);
  expect(readFileSync(join(repo, ".git", "index.lock"), "utf8")).toBe("other writer\n");
});

it("a populated clone checks out cleanly with a checksummed index", async () => {
  const clone = join(repo, "new-clone");
  await cloneStore(new URL(`file://${repo}`).href, clone, { store: "fixture", hook: false, log: () => {} });
  expect(git("-C", clone, "config", "--get", "index.skipHash")).toBe("false");
  expect(git("-C", clone, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(clone, "note.md"), "utf8")).toBe("initial\n");
  expect(readFileSync(join(clone, ".git", "index")).subarray(-20).some((b) => b !== 0)).toBe(true);
});

// A real clean filter pauses status after it read the index, before its optional write.
// The writer stages a new path and a partial edit in that interval. No timing lottery.
it.each(["daemon scan", "remote search", "plain status after install"])("%s preserves concurrent staging", async (mode) => {
  if (mode === "plain status after install") await main(["sync", "install", "--repo", repo]);
  const entered = join(repo, ".git", "entered");
  const release = join(repo, ".git", "release");
  const filter = join(repo, ".git", "filter.mjs");
  writeFileSync(filter, `import {existsSync, writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
if (process.env.INDEX_BARRIER === '1') {
  writeFileSync(${JSON.stringify(entered)}, '');
  const end = Date.now() + 15000;
  while (!existsSync(${JSON.stringify(release)})) {
    if (Date.now() > end) process.exit(2);
    await delay(10);
  }
}
process.stdin.pipe(process.stdout);
`);
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  git("config", "filter.barrier.clean", `${quote(process.execPath)} ${quote(filter)}`);
  git("config", "filter.barrier.required", "true");
  const old = new Date(Date.now() - 60000);
  utimesSync(join(repo, "probe.seed"), old, old);
  const source = mode === "daemon scan"
    ? `import {scanWorktree} from ${JSON.stringify(new URL("./scan.mjs", import.meta.url).href)}; await scanWorktree(process.argv[1]);`
    : `import {localChangesSince} from ${JSON.stringify(new URL("../engine/vault-remote.mjs", import.meta.url).href)}; localChangesSince(process.argv[1], null);`;
  const child = mode === "plain status after install"
    ? spawn(binary, ["status", "--porcelain=v2"], { cwd: repo, env: { ...env, INDEX_BARRIER: "1" } })
    : spawn(process.execPath, ["--input-type=module", "-e", source, repo], { cwd: repo, env: { ...env, INDEX_BARRIER: "1" } });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (b) => { stderr += b; });
  const ended = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  try {
    const end = Date.now() + 10000;
    while (!existsSync(entered)) {
      if (child.exitCode !== null || Date.now() > end) throw new Error(`status missed the barrier: ${stderr}`);
      await delay(10);
    }
    writeFileSync(join(repo, "agent.md"), "new staged path\n");
    writeFileSync(join(repo, "note.md"), "staged\n");
    git("add", "agent.md", "note.md");
    writeFileSync(join(repo, "note.md"), "unstaged\n");
    const staged = git("ls-files", "--stage");
    writeFileSync(release, "");
    expect(await ended, stderr).toBe(0);
    expect(git("ls-files", "--stage")).toBe(staged);
    git("commit", "-qm", "agent");
    expect(git("show", "HEAD:agent.md")).toBe("new staged path");
    expect(git("show", "HEAD:note.md")).toBe("staged");
    expect(readFileSync(join(repo, "note.md"), "utf8")).toBe("unstaged\n");
  } finally {
    writeFileSync(release, "");
    await ended;
  }
}, 30000);

// Autosave on the real clock, with writers that keep writing while the tick runs.
//
// The injected-clock suite (sync.integration.test.mjs) sets every mtime before a tick, so nothing
// is written while `vault sync` regenerates the derivations. Here a recording is appended
// every 100 ms through whole ticks, with a 3 s quiet window: a quiet image elsewhere triggers the
// autosave and its derivation pass, and an incoming fast-forward triggers the post-merge pass.
// Neither may take the recording while it grows — not even when a slow fetch has left the tick's
// start further behind than the future-mtime margin. Also: a binary whose mtime lies days ahead.
// Needs git >= 2.38, git-lfs, Node 22. See docs/sync.md.

import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VAULT_BIN, createWorld, fixtureAttributes, fixtureGitignore, removeWorld, startServe } from "../../scripts/test/sync-harness.mjs";
import { parseLfsPointer } from "../server/lfs-paths.mjs";
import { loadContext } from "./context.mjs";
import { gitBin } from "./git.mjs";
import { createMemory, runTick } from "./daemon.mjs";

const HOUR = 3_600_000;

let world;
let serve;
let url;
let a;
let b;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function writeAt(root, rel, data) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}

function client(name) {
  const dir = join(world.root, name);
  const env = { ...process.env, ...world.env, KUMA_VAULT_SYNC_DIR: join(world.root, `state-${name}`) };
  world.sh(VAULT_BIN, ["clone", url, dir, "--token-file", join(world.root, "token")], { extraEnv: env });
  world.git(dir, ["config", "kuma-vault.host", name]);
  world.git(dir, ["config", "kuma-vault.quietseconds", "3"]);
  const c = {
    dir,
    mem: null,
    async tick({ now = Date.now(), mem } = {}) {
      const ctx = await loadContext(dir, { env });
      if (mem) return runTick(ctx, mem, { now });
      if (!c.mem) c.mem = createMemory(ctx);
      return runTick(ctx, c.mem, { now });
    },
    async freshMemory() {
      return createMemory(await loadContext(dir, { env }));
    },
    write: (rel, data) => writeAt(dir, rel, data),
    git: (args, opts) => world.git(dir, args, opts),
    tracked: (rel) => world.git(dir, ["ls-files", "--error-unmatch", "--", rel], { allowFail: true }).code === 0,
  };
  return c;
}

/** Distinct LFS objects the server's main ever held at `rel`. */
function serverOids(rel) {
  const log = world.sh("git", ["--git-dir", serve.paths.gitDir, "log", "--format=%H", "main", "--", rel], { allowFail: true });
  const oids = new Set();
  for (const commit of log.stdout.trim().split("\n").filter(Boolean)) {
    const shown = serve.show(commit, rel);
    const pointer = shown.code === 0 ? parseLfsPointer(Buffer.from(shown.stdout)) : null;
    if (pointer) oids.add(pointer.oid);
  }
  return oids;
}

/** b's agent commits a note without regenerating the index (no hook) and pushes it. */
function bPushesNote(stem) {
  b.git(["fetch", "--quiet", "origin"]);
  b.git(["merge", "--ff-only", "--quiet", "origin/main"]);
  b.write(`vault/domains/notes/${stem}.md`, `---\ntitle: ${stem}\ndescription: written on b\n---\n\n# ${stem}\n`);
  b.git(["add", `vault/domains/notes/${stem}.md`]);
  b.git(["commit", "--quiet", "--no-verify", "-m", `note ${stem}`]);
  b.git(["push", "--quiet", "origin", "HEAD:main"]);
}

/** A git for the daemon whose next `git fetch` sleeps `seconds` once `arm()` is called. */
function slowFetchGit(seconds) {
  const real = gitBin();
  const marker = join(world.root, "slow-fetch-once");
  const shim = join(world.root, "git-slow-fetch");
  writeFileSync(shim, `#!/bin/sh
git_command="$1"
if [ "$git_command" = --no-optional-locks ]; then git_command="$2"; fi
if [ "$git_command" = fetch ] && [ -f "${marker}" ]; then rm -f "${marker}"; sleep ${seconds}; fi
exec "${real}" "$@"
`);
  chmodSync(shim, 0o755);
  return { shim, arm: () => writeFileSync(marker, "1"), ran: () => !existsSync(marker) };
}

/** Append 8 KiB every 100 ms until stopped, as the Studio recorder does for a whole take. */
function startAppending(abs) {
  const timer = setInterval(() => appendFileSync(abs, randomBytes(8 * 1024)), 100);
  return () => clearInterval(timer);
}

beforeAll(async () => {
  world = createWorld("kv-sync-rt-");
  serve = await startServe(world, { reject: [] });
  url = `http://127.0.0.1:${serve.port}/v1/stores/s.git`;
  const seed = join(world.root, "seed");
  world.sh(VAULT_BIN, ["clone", url, seed, "--token-file", join(world.root, "token"), "--no-hook"]);
  writeAt(seed, ".gitattributes", fixtureAttributes("vault"));
  writeAt(seed, ".gitignore", fixtureGitignore({ tree: "vault", reject: [] }));
  writeAt(seed, "vault/vault.config.json", `${JSON.stringify({ profile: "kuma-vault", binaries: { reject: [] } }, null, 2)}\n`);
  writeAt(seed, "vault/README.md", "# Vault\n");
  writeAt(seed, "vault/domains/notes/seed.md", "---\ntitle: Seed\ndescription: seed note\n---\n\n# Seed\n");
  world.sh(VAULT_BIN, ["sync", "--root", join(seed, "vault")]);
  world.git(seed, ["add", "-A"]);
  world.git(seed, ["commit", "--quiet", "-m", "fixture"]);
  world.git(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  a = client("a");
  b = client("b");
}, 120_000);

afterAll(async () => {
  await serve?.stop();
  removeWorld(world);
});

describe.sequential("a recording appended in real time", { timeout: 240_000 }, () => {
  it("control: with nothing else to collect it stays out while appended and goes up once it stops", async () => {
    const stop = startAppending(a.write("vault/recordings/ctl.webm", randomBytes(32 * 1024)));
    try {
      for (let k = 0; k < 4; k += 1) {
        await sleep(1000);
        await a.tick();
      }
      expect(a.tracked("vault/recordings/ctl.webm")).toBe(false);
    } finally {
      stop();
    }
    await sleep(3500);
    await a.tick();
    expect(a.tracked("vault/recordings/ctl.webm")).toBe(true);
  });

  it("a quiet image elsewhere runs the autosave and its derivation pass: the image goes up, the recording does not", async () => {
    const stop = startAppending(a.write("vault/recordings/x.webm", randomBytes(32 * 1024)));
    const trackedDuring = [];
    try {
      for (let k = 0; k < 3; k += 1) {
        a.write(`vault/images/y${k}.png`, randomBytes(20 * 1024));
        await sleep(3600); // y{k}.png goes quiet; the recording does not
        const r = await a.tick();
        trackedDuring.push(a.tracked("vault/recordings/x.webm"));
        expect(a.tracked(`vault/images/y${k}.png`)).toBe(true);
        expect(r.status.ahead).toBe(0);
      }
    } finally {
      stop();
    }
    expect(trackedDuring, "recording collected while still being appended").toEqual([false, false, false]);
    expect(serverOids("vault/recordings/x.webm").size).toBe(0);
    await sleep(3500);
    await a.tick();
    expect(a.tracked("vault/recordings/x.webm")).toBe(true);
    expect(serverOids("vault/recordings/x.webm").size).toBe(1);
  });

  it("an incoming fast-forward runs the post-merge derivation pass: the index it rewrites goes up, the recording does not", async () => {
    await b.tick(); // b catches up to a
    // b's agent commits a note without regenerating the index (no hook), so a's post-merge pass
    // has a README to write and commit
    b.write("vault/domains/notes/from-b.md", "---\ntitle: From b\ndescription: written on b\n---\n\n# From b\n");
    b.git(["add", "vault/domains/notes/from-b.md"]);
    b.git(["commit", "--quiet", "--no-verify", "-m", "note from b"]);
    b.git(["push", "--quiet", "origin", "HEAD:main"]);

    const stop = startAppending(a.write("vault/recordings/during-ff.webm", randomBytes(32 * 1024)));
    let r;
    try {
      await sleep(500);
      r = await a.tick();
      expect(a.tracked("vault/recordings/during-ff.webm"), "recording collected by the post-merge pass").toBe(false);
    } finally {
      stop();
    }
    expect(a.git(["log", "--format=%s", "-3"]).stdout).toMatch(/note from b/);
    const regenerated = a.git(["log", "-1", "--format=%s", "--", "vault/domains/notes/README.md"]).stdout;
    expect(regenerated).toMatch(/vault-sync: autosave \(a, /);
    expect(world.sh("git", ["--git-dir", serve.paths.gitDir, "show", "main:vault/domains/notes/README.md"]).stdout).toMatch(/from-b\.md/);
    expect(r.status.ahead).toBe(0);
    expect(serverOids("vault/recordings/during-ff.webm").size).toBe(0);
    await sleep(3500);
    await a.tick();
    expect(a.tracked("vault/recordings/during-ff.webm")).toBe(true);
  });

  it("a fetch slower than the future-mtime margin: the post-merge pass still leaves the recording out", async () => {
    // The margin is 5 min in use; 2 s here, with a 6 s fetch, is the same race: every mtime the
    // recorder writes during the fetch lies past the tick's start + margin. Judged by the tick's
    // start, the recording looks like a wrong-clock file aged from when it was first seen — and
    // was collected while it grew. Judged by the clock after the post-merge scan, it is not quiet.
    const slow = slowFetchGit(6);
    a.git(["config", "kuma-vault.futuremtimeseconds", "2"]);
    const previousGit = process.env.KUMA_VAULT_GIT;
    process.env.KUMA_VAULT_GIT = slow.shim;
    const rec = "vault/recordings/slow-fetch.webm";
    const stop = startAppending(a.write(rec, randomBytes(32 * 1024)));
    let r;
    let trackedAfter;
    try {
      await a.tick(); // the daemon has seen it dirty
      expect(a.tracked(rec)).toBe(false);
      await sleep(4000); // longer than quietseconds since first seen; still appended
      bPushesNote("slow");
      slow.arm();
      const t0 = Date.now();
      r = await a.tick();
      expect(Date.now() - t0).toBeGreaterThan(6000);
      trackedAfter = a.tracked(rec);
    } finally {
      stop();
      if (previousGit === undefined) delete process.env.KUMA_VAULT_GIT;
      else process.env.KUMA_VAULT_GIT = previousGit;
      a.git(["config", "--unset", "kuma-vault.futuremtimeseconds"]);
    }
    expect(slow.ran()).toBe(true);
    expect(a.git(["log", "--format=%s", "-6"]).stdout).toMatch(/note slow/);
    expect(trackedAfter, "recording collected by the post-merge pass after a slow fetch").toBe(false);
    expect(serverOids(rec).size).toBe(0);
    expect(r.status.ahead).toBe(0);
    await sleep(3500);
    await a.tick();
    expect(a.tracked(rec)).toBe(true);
  });

  it("a binary whose mtime is 3 days ahead is collected from when the daemon first saw it", async () => {
    const abs = a.write("vault/_assets/cam/clip.mp4", randomBytes(20 * 1024));
    const ahead = Date.now() + 72 * HOUR; // a camera or an archive with its clock ahead
    utimesSync(abs, new Date(ahead), new Date(ahead));
    const mem = await a.freshMemory();
    const t0 = Date.now();
    const first = await a.tick({ now: t0, mem });
    expect(a.tracked("vault/_assets/cam/clip.mp4")).toBe(false); // just seen: not quiet yet
    expect(first.status.alerts.uncollected.count).toBe(0);
    await a.tick({ now: t0 + 2 * HOUR, mem });
    expect(a.tracked("vault/_assets/cam/clip.mp4")).toBe(true);
  });

  it("a future-mtime file the autosave cannot take ages into uncollected from when it was first seen", async () => {
    const abs = a.write("vault/data/ahead.bin", randomBytes(33 * 1024 * 1024)); // over 32 MiB, not LFS
    const ahead = Date.now() + 72 * HOUR;
    utimesSync(abs, new Date(ahead), new Date(ahead));
    const mem = await a.freshMemory();
    const t0 = Date.now();
    await a.tick({ now: t0, mem });
    const r1 = await a.tick({ now: t0 + HOUR, mem });
    expect(r1.status.alerts.uncollected.paths.map((p) => p.path)).toContain("vault/data/ahead.bin");
    const r2 = await a.tick({ now: t0 + 2.5 * HOUR, mem });
    expect(r2.status.alerts.uncollected.active).toBe(true);
    expect(a.tracked("vault/data/ahead.bin")).toBe(false);
  });
});

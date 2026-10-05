// Autosave against a writer that changes an indexed page between the derivation pass and the
// pre-commit gate.
//
// The autosave regenerates the folder README indexes, then commits through the gate, which reads
// the working tree when the hook runs. A page written in between (another agent saving a note, an
// enrich run filling descriptions one page at a time) leaves its folder README drifted, and the
// gate refuses. Here the race is made deterministic: the daemon's `vault` is a wrapper that runs
// the real derivation pass and then rewrites a page's description — exactly the write that lands
// between the regeneration and the gate. The hook itself runs the real engine.
//
// Pinned: drift alone is regenerated and committed again within the same pass, a bounded number
// of times, also when another writer already put the index right and the regeneration writes
// nothing; drift that outlasts the retries, and any other refusal, still blocks and waits
// `gateRetryMs`; the log records each retry, the block (with the drifted README) and its end.
//
// A git lock is not a refusal. A daemon killed in the middle of its commit leaves `index.lock`
// behind, and the daemon started after it meets that lock before the lock is old enough for the
// top of a tick to remove it. Pinned: the stale-lock rule is applied while the add or the commit
// waits on the lock, so the lock goes as soon as it is old enough and the pass commits — not the
// whole 60 s lock wait and then "Unable to create … index.lock" kept as a block for `gateRetryMs`.
// Needs git >= 2.38, git-lfs, Node 22. See docs/sync.md.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VAULT_BIN, createWorld, fixtureAttributes, fixtureGitignore, removeWorld, startServe } from "../../scripts/test/sync-harness.mjs";
import { loadContext } from "./context.mjs";
import { createMemory, runTick } from "./daemon.mjs";
import { gitBin } from "./git.mjs";
import { gateRefusal } from "./autosave.mjs";

const MIN = 60_000;
const RACER = "vault/domains/notes/racer.md";

let world;
let serve;
let url;
let dir;
let env;

function writeAt(rel, data, mtimeMs) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  if (mtimeMs !== undefined) utimesSync(abs, new Date(mtimeMs), new Date(mtimeMs));
  return abs;
}

const git = (args, opts) => world.git(dir, args, opts);
const tracked = (rel) => git(["ls-files", "--error-unmatch", "--", rel], { allowFail: true }).code === 0;

/** A quiet page for the autosave to collect: written `ageMs` before `now`. */
function quietPage(stem, now, ageMs = 5 * MIN) {
  const rel = `vault/domains/notes/${stem}.md`;
  writeAt(rel, `---\ntitle: ${stem}\ndescription: quiet note ${stem}\n---\n\n# ${stem}\n`, now - ageMs);
  return rel;
}

/**
 * The daemon's `vault`: runs the real one, then — on its first `drifts` calls — rewrites the
 * racer page's description, as another writer would right after the derivation pass. On call
 * `syncsFirst` another writer's own `vault sync` runs first and brings the indexes back in step,
 * so that call's regeneration has nothing left to write.
 */
function racingVault(name, { drifts, syncsFirst = 0 }) {
  const counter = join(world.root, `${name}.calls`);
  const bin = join(world.root, name);
  writeFileSync(bin, `#!/bin/sh
n=$(cat "${counter}" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "${counter}"
if [ "$n" -eq ${syncsFirst} ]; then "${VAULT_BIN}" sync --root "${join(dir, "vault")}" > /dev/null 2>&1; fi
"${VAULT_BIN}" "$@"
rc=$?
if [ "$n" -le ${drifts} ]; then
  printf -- '---\\ntitle: Racer\\ndescription: written by another agent (${name}), take %s\\n---\\n\\n# Racer\\n' "$n" > "${join(dir, RACER)}"
fi
exit $rc
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(counter) ? Number(readFileSync(counter, "utf8").trim()) : 0) };
}

/** A daemon of this clone whose derivation pass goes through `bin`, with its own memory and log. */
async function daemon(bin) {
  const ctx = await loadContext(dir, { env: { ...env, KUMA_VAULT_BIN: bin } });
  const mem = createMemory(ctx);
  const rows = [];
  return {
    rows,
    events: (name) => rows.filter((r) => r.event === name),
    tick: ({ now = Date.now(), force = false } = {}) => runTick(ctx, mem, { now, force, log: (row) => rows.push(row) }),
  };
}

beforeAll(async () => {
  world = createWorld("kv-sync-drift-");
  serve = await startServe(world, { reject: [] });
  url = `http://127.0.0.1:${serve.port}/v1/stores/s.git`;
  const seed = join(world.root, "seed");
  world.sh(VAULT_BIN, ["clone", url, seed, "--token-file", join(world.root, "token"), "--no-hook"]);
  const put = (rel, data) => {
    mkdirSync(dirname(join(seed, rel)), { recursive: true });
    writeFileSync(join(seed, rel), data);
  };
  put(".gitattributes", fixtureAttributes("vault"));
  put(".gitignore", fixtureGitignore({ tree: "vault", reject: [] }));
  put("vault/vault.config.json", `${JSON.stringify({ profile: "kuma-vault", binaries: { reject: [] } }, null, 2)}\n`);
  put("vault/README.md", "# Vault\n");
  put("vault/domains/notes/seed.md", "---\ntitle: Seed\ndescription: seed note\n---\n\n# Seed\n");
  world.sh(VAULT_BIN, ["sync", "--root", join(seed, "vault")]);
  world.git(seed, ["add", "-A"]);
  world.git(seed, ["commit", "--quiet", "-m", "fixture"]);
  world.git(seed, ["push", "--quiet", "origin", "HEAD:main"]);

  dir = join(world.root, "a");
  env = { ...process.env, ...world.env, KUMA_VAULT_SYNC_DIR: join(world.root, "state-a") };
  world.sh(VAULT_BIN, ["clone", url, dir, "--token-file", join(world.root, "token")], { extraEnv: env });
  git(["config", "kuma-vault.host", "a"]);
}, 120_000);

afterAll(async () => {
  await serve?.stop();
  removeWorld(world);
});

describe.sequential("autosave and a page written between the derivation pass and the gate", { timeout: 240_000 }, () => {
  it("drift alone is regenerated and committed again in the same pass, not left for gateRetryMs", async () => {
    const vault = racingVault("vault-race-once", { drifts: 1 });
    const d = await daemon(vault.bin);
    const now = Date.now();
    const note = quietPage("q1", now);

    const r = await d.tick({ now });

    expect(r.status.autosaveBlocked).toBeNull();
    expect(tracked(note)).toBe(true);
    expect(vault.calls()).toBe(2); // the raced pass and one clean pass
    expect(d.events("autosave-drift-retry")).toEqual([
      expect.objectContaining({ pass: "autosave", attempt: 1, drifted: ["vault/domains/notes/README.md"] }),
    ]);
    expect(d.events("autosave-blocked")).toEqual([]);
    expect(r.status.ahead).toBe(0);
    expect(world.sh(VAULT_BIN, ["sync", "--check", "--root", join(dir, "vault")], { allowFail: true }).code).toBe(0);
  });

  it("drift that another writer has already put right is committed again, though the regeneration writes nothing", async () => {
    // refused for drift; before the second pass the page's own writer runs `vault sync`, so the
    // second regeneration finds the indexes in step and writes nothing — the commit is still due
    const vault = racingVault("vault-race-healed", { drifts: 1, syncsFirst: 2 });
    const d = await daemon(vault.bin);
    const now = Date.now();
    const note = quietPage("q4", now);

    const r = await d.tick({ now });

    expect(vault.calls()).toBe(2);
    expect(r.status.autosaveBlocked).toBeNull();
    expect(tracked(note)).toBe(true);
    expect(d.events("autosave-drift-retry")).toHaveLength(1);
    expect(d.events("autosave-blocked")).toEqual([]);
  });

  it("drift that outlasts the retries blocks, waits gateRetryMs, and the log says when and which README", async () => {
    git(["config", "kuma-vault.gatedriftretries", "2"]);
    try {
      const vault = racingVault("vault-race-thrice", { drifts: 3 });
      const d = await daemon(vault.bin);
      const t0 = Date.now();
      const note = quietPage("q2", t0);

      const first = await d.tick({ now: t0 });
      expect(vault.calls()).toBe(3); // 1 + 2 retries, then it stops
      expect(first.status.autosaveBlocked).toMatch(/^자동 저장 막힘: index: 1 drifted/);
      expect(tracked(note)).toBe(false);
      expect(d.events("autosave-drift-retry").map((e) => e.attempt)).toEqual([1, 2]);
      const [blocked] = d.events("autosave-blocked");
      expect(blocked).toMatchObject({ pass: "autosave", reason: "drift", retries: 2, drifted: ["vault/domains/notes/README.md"] });
      expect(blocked.retryAt).toEqual(expect.any(String));

      // within gateRetryMs: no attempt at all, and nothing new in the log
      const waiting = await d.tick({ now: t0 + 5 * MIN });
      expect(vault.calls()).toBe(3);
      expect(waiting.status.autosaveBlocked).toMatch(/^자동 저장 막힘/);
      expect(d.events("autosave-blocked")).toHaveLength(1);

      // after gateRetryMs the writer has stopped (call 4 does not drift): committed, block ended
      const after = await d.tick({ now: t0 + 11 * MIN });
      expect(vault.calls()).toBe(4);
      expect(after.status.autosaveBlocked).toBeNull();
      expect(tracked(note)).toBe(true);
      const [unblocked] = d.events("autosave-unblocked");
      expect(unblocked).toMatchObject({ pass: "autosave", commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
      expect(unblocked.blockedSeconds).toBeGreaterThanOrEqual(600);
    } finally {
      git(["config", "--unset", "kuma-vault.gatedriftretries"], { allowFail: true });
    }
  });

  it("a block refused again after gateRetryMs is one block: its length counts from the first refusal", async () => {
    git(["config", "kuma-vault.gatedriftretries", "0"]);
    try {
      const vault = racingVault("vault-race-twice", { drifts: 2 });
      const d = await daemon(vault.bin);
      const t0 = Date.now();
      const note = quietPage("q5", t0);

      await d.tick({ now: t0 }); // refused: the block starts
      const again = await d.tick({ now: t0 + 11 * MIN }); // asked again, refused again
      expect(vault.calls()).toBe(2);
      expect(again.status.autosaveBlocked).toMatch(/^자동 저장 막힘: index: 1 drifted/);
      expect(d.events("autosave-blocked")).toHaveLength(2);

      await d.tick({ now: t0 + 22 * MIN }); // the writer has stopped: committed, the block ends
      expect(tracked(note)).toBe(true);
      const [unblocked] = d.events("autosave-unblocked");
      expect(unblocked.blockedSeconds).toBeGreaterThanOrEqual(22 * 60); // from the first refusal, not the last
      expect(unblocked).toMatchObject({ refusals: 2 });
      expect(Date.parse(unblocked.blockedAt)).toBeLessThan(Date.parse(unblocked.lastRefusedAt));
    } finally {
      git(["config", "--unset", "kuma-vault.gatedriftretries"], { allowFail: true });
    }
  });

  it("a refusal that is not drift (a freeze) is not retried: it blocks at once, as before", async () => {
    const freeze = join(world.env.HOME, ".kuma", "vault-freeze.json");
    mkdirSync(dirname(freeze), { recursive: true });
    writeFileSync(freeze, `${JSON.stringify({ id: "drift-test", reason: "test freeze" })}\n`);
    try {
      const vault = racingVault("vault-plain", { drifts: 0 });
      const d = await daemon(vault.bin);
      const now = Date.now();
      const note = quietPage("q3", now);

      const r = await d.tick({ now });
      expect(vault.calls()).toBe(1);
      expect(tracked(note)).toBe(false);
      expect(r.status.autosaveBlocked).toMatch(/동결/);
      expect(d.events("autosave-drift-retry")).toEqual([]);
      expect(d.events("autosave-blocked")).toEqual([
        expect.objectContaining({ reason: "refused", retries: 0, drifted: [] }),
      ]);

      rmSync(freeze);
      const forced = await d.tick({ now: Date.now(), force: true }); // vault sync now
      expect(tracked(note)).toBe(true);
      expect(forced.status.autosaveBlocked).toBeNull();
      expect(d.events("autosave-unblocked")).toHaveLength(1);
    } finally {
      rmSync(freeze, { force: true });
    }
  });

  it("a file its writer deletes between the scan and the add is left out; the rest is committed", async () => {
    // The daemon's git, wrapped: right before its `git add`, the writer deletes one of the pages
    // the scan found (a run clearing its own frames). Unwrapped, git refuses the whole add and the
    // tick fails ("unable to stat" / "did not match any files").
    const vault = racingVault("vault-plain-vanish", { drifts: 0 });
    const d = await daemon(vault.bin);
    const now = Date.now();
    const keep = quietPage("q6", now);
    const gone = quietPage("q7", now);
    const trigger = join(world.root, "vanish.once");
    writeFileSync(trigger, "");
    const wrapper = join(world.root, "git-vanish");
    writeFileSync(wrapper, `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "add" ] && [ -f "${trigger}" ]; then rm -f "${trigger}" "${join(dir, gone)}"; fi
done
exec "${gitBin()}" "$@"
`);
    chmodSync(wrapper, 0o755);
    const saved = process.env.KUMA_VAULT_GIT;
    process.env.KUMA_VAULT_GIT = wrapper;
    let r;
    try {
      r = await d.tick({ now });
    } finally {
      if (saved === undefined) delete process.env.KUMA_VAULT_GIT;
      else process.env.KUMA_VAULT_GIT = saved;
    }

    expect(existsSync(trigger)).toBe(false); // the writer did delete it, mid-pass
    expect(existsSync(join(dir, gone))).toBe(false);
    expect(tracked(keep)).toBe(true);
    expect(tracked(gone)).toBe(false);
    expect(r.status.autosaveBlocked).toBeNull();
    expect(d.events("autosave-vanished")).toEqual([expect.objectContaining({ pass: "autosave", count: 1, paths: [gone] })]);
    expect(world.sh(VAULT_BIN, ["sync", "--check", "--root", join(dir, "vault")], { allowFail: true }).code).toBe(0);
  });
});

describe.sequential("autosave and the index.lock a killed git left", { timeout: 240_000 }, () => {
  /** What a git killed in its commit leaves: an `index.lock` nobody holds, made just now. */
  function deadLock() {
    const lock = join(dir, ".git", "index.lock");
    writeFileSync(lock, "");
    return lock;
  }

  /** One tick of a fresh daemon over `note` under a dead lock that turns stale 2 s after it was left. */
  async function tickUnderDeadLock(stem, { staged }) {
    git(["config", "kuma-vault.stalelockseconds", "2"]);
    try {
      const d = await daemon(VAULT_BIN);
      const now = Date.now();
      const note = quietPage(stem, now);
      if (staged) git(["add", "--", note]); // the killed daemon's add went through; its commit did not
      const lock = deadLock();
      const r = await d.tick({ now });
      return { d, r, note, lock };
    } finally {
      git(["config", "--unset", "kuma-vault.stalelockseconds"], { allowFail: true });
    }
  }

  function expectSaved({ d, r, note, lock }) {
    expect(d.events("stale-git-lock-removed")).toEqual([expect.objectContaining({ path: expect.stringMatching(/\/\.git\/index\.lock$/) })]);
    expect(existsSync(lock)).toBe(false);
    expect(d.events("autosave-blocked")).toEqual([]);
    expect(r.status.autosaveBlocked).toBeNull();
    expect(d.events("autosave")).toHaveLength(1);
    expect(git(["log", "-1", "--format=%s", "--", note]).stdout).toMatch(/^vault-sync: autosave/);
    expect(git(["status", "--porcelain", "--", note]).stdout).toBe("");
    expect(r.status.ahead).toBe(0);
  }

  it("a page the killed daemon had staged: the commit's wait removes the lock once it is old enough, and nothing is blocked", async () => {
    expectSaved(await tickUnderDeadLock("q8", { staged: true }));
  });

  it("a page not yet added: the add's wait removes the lock once it is old enough, and the tick does not fail", async () => {
    expectSaved(await tickUnderDeadLock("q9", { staged: false }));
  });
});

it("reports a full first autosave and a scoped subsequent autosave through the real binary", async () => {
  const d = await daemon(VAULT_BIN);
  const now = Date.now();
  quietPage("scope-first", now);
  await d.tick({ now, force: true });
  expect(d.events("autosave-sync-scope")[0]).toMatchObject({ mode: "full", reason: "first-autosave" });
  const second = quietPage("scope-second", now);
  const result = await d.tick({ now, force: true });
  expect(result.status.autosaveBlocked).toBeNull();
  expect(tracked(second)).toBe(true);
  expect(d.events("autosave-sync-scope").at(-1)).toMatchObject({ mode: "incremental", reason: "changed-paths" });
}, 60_000);

it("does not mistake the scope report for a foreign hook's refusal", () => {
  const report = "vault sync — check (no writes)\nvault-dir: /fixture\nscope: incremental (changed-paths)\nindex: 0 drifted / 0 README(s) (0 in sync)\n";
  expect(gateRefusal(`${report}custom hook said no\n`, 1)).toBe("custom hook said no");
  expect(gateRefusal(report, 1)).toBe("git commit exited 1");
});

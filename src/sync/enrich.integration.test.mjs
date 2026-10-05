// Enrich on autosave, end to end: `vault serve` on loopback, one clone, in-process daemon ticks, and
// a fake `claude` CLI on PATH as the configured provider (it logs every prompt it is sent). The
// real `vault sync --enrich` run decides what is sent; this file checks what reached the "model".
// It also pins what autosave does when the commit gate refuses a tree that moved under it — the
// state a `vault sync --enrich` run outside the daemon leaves between its page write and its
// index pass. Needs git >= 2.38, git-lfs, Node 22. See docs/sync.md.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  VAULT_BIN, createWorld, fixtureAttributes, fixtureGitignore, removeWorld, startProxy, startServe,
} from "../../scripts/test/sync-harness.mjs";
import { loadContext } from "./context.mjs";
import { createMemory, runTick } from "./daemon.mjs";

const QUIET = 130_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

// The provider stand-in: same flags as the real CLI (the prompt is the last argument). It appends
// `{ path, prompt }` to calls.jsonl and answers in the adapter's three-line contract — or fails
// while a `fail` file exists.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.FAKE_PROVIDER_DIR;
const prompt = process.argv[process.argv.length - 1];
const path = (prompt.match(/^Path: (.*)$/m) || [])[1] || "?";
const title = (prompt.match(/^Title: (.*)$/m) || [])[1] || "?";
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ path, prompt }) + "\\n");
if (existsSync(join(dir, "fail"))) {
  process.stderr.write("fake provider down\\n");
  process.exit(1);
}
process.stdout.write("DESCRIPTION: Fake synopsis of " + title + "\\nTAGS: notes\\nALIASES: fake alias\\n");
`;

let world;
let serve;
let proxy;
let url;
let dir;
let env;
let mem;
let fakeDir;
let configPath;
const saved = {};

function write(rel, data) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}

const gitc = (args, opts) => world.git(dir, args, opts);
const setConfig = (key, value) => gitc(["config", `kuma-vault.${key}`, String(value)]);
const head = () => gitc(["rev-parse", "HEAD"]).stdout.trim();
const subject = (rev = "HEAD") => gitc(["log", "-1", "--format=%s", rev]).stdout.trim();
const read = (rel) => readFileSync(join(dir, rel), "utf8");
const statusFile = () => JSON.parse(readFileSync(join(env.KUMA_VAULT_SYNC_DIR, "s.json"), "utf8"));

function calls() {
  const log = join(fakeDir, "calls.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const events = []; // every log row of every tick
let onEvent = null; // a test's hook into the middle of a tick: called with each log row as it is written

async function tick({ advance = QUIET, vaultBin } = {}) {
  const ctx = await loadContext(dir, { env: vaultBin ? { ...env, KUMA_VAULT_BIN: vaultBin } : env });
  if (!mem) mem = createMemory(ctx);
  const log = (row) => {
    events.push(row);
    onEvent?.(row);
  };
  return runTick(ctx, mem, { now: Date.now() + advance, log });
}

/** An agent's own commit: regenerate the indexes the gate checks, stage, commit. */
function agentCommit(paths, message) {
  world.sh(VAULT_BIN, ["sync", "--root", join(dir, "vault")]);
  gitc(["add", "-A", "--", ...paths, ":(glob)vault/**/README.md", "vault/README.md"]);
  gitc(["commit", "--quiet", "-m", message]);
  return head();
}

const names = (rev = "HEAD") => gitc(["show", "--name-only", "--format=", rev]).stdout.trim().split("\n");
const pending = () => statusFile().enrichQueue.pending.map(([path]) => path);

function page(title, body) {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
}

beforeAll(async () => {
  world = createWorld("kv-enrich-");
  serve = await startServe(world);
  proxy = await startProxy(serve.port);
  url = `http://127.0.0.1:${proxy.port}/v1/stores/s.git`;

  const seedDir = join(world.root, "seed");
  world.sh(VAULT_BIN, ["clone", url, seedDir, "--token-file", join(world.root, "token"), "--no-hook"]);
  const seed = (rel, data) => {
    mkdirSync(dirname(join(seedDir, rel)), { recursive: true });
    writeFileSync(join(seedDir, rel), data);
  };
  seed(".gitattributes", fixtureAttributes("vault"));
  seed(".gitignore", fixtureGitignore({ tree: "vault" }));
  seed("README.md", "# enrich fixture\n");
  seed("vault/vault.config.json", `${JSON.stringify({ profile: "kuma-vault" }, null, 2)}\n`);
  seed("vault/README.md", "# Vault\n");
  seed("vault/domains/notes/seed.md", "---\ntitle: Seed\ndescription: seed note\n---\n\n# Seed\n");
  seed("vault/domains/personal/_credentials/svc.md", "# svc\n\ntoken: s3cret-0\n");
  seed("vault/plans/p/plan.md", "---\ntitle: a plan\n---\n\n# a plan\n");
  seed("vault/results/r.md", "# a result\n");
  seed("vault/dispatch-log.md", "# dispatch log\n\n- seed\n");
  world.sh(VAULT_BIN, ["sync", "--root", join(seedDir, "vault")]);
  world.git(seedDir, ["add", "-A"]);
  world.git(seedDir, ["commit", "--quiet", "-m", "fixture"]);
  world.git(seedDir, ["push", "--quiet", "origin", "HEAD:main"]);

  dir = join(world.root, "a");
  env = { ...process.env, ...world.env, KUMA_VAULT_SYNC_DIR: join(world.root, "state-a") };
  world.sh(VAULT_BIN, ["clone", url, dir, "--token-file", join(world.root, "token")], { extraEnv: env });
  gitc(["config", "kuma-vault.host", "a"]);

  // the provider: config as `vault setup --provider claude` writes it, the fake CLI first on PATH
  fakeDir = join(world.root, "provider");
  mkdirSync(join(fakeDir, "bin"), { recursive: true });
  writeFileSync(join(fakeDir, "bin", "claude"), FAKE_CLAUDE);
  chmodSync(join(fakeDir, "bin", "claude"), 0o755);
  configPath = join(world.root, "kuma-vault-config.json");
  writeFileSync(configPath, `${JSON.stringify({ provider: "claude", model: "fake-model" })}\n`);
  for (const key of ["PATH", "KUMA_VAULT_CONFIG", "FAKE_PROVIDER_DIR"]) saved[key] = process.env[key];
  process.env.PATH = `${join(fakeDir, "bin")}:${process.env.PATH}`; // the daemon's enrich run inherits these
  process.env.KUMA_VAULT_CONFIG = configPath;
  process.env.FAKE_PROVIDER_DIR = fakeDir;
}, 120_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await proxy?.close();
  await serve?.stop();
  removeWorld(world);
});

describe.sequential("enrich on autosave", { timeout: 120_000 }, () => {
  it("is off unless the clone turns it on: autosave commits, the model is never called", async () => {
    write("vault/domains/notes/off.md", page("Off", "written while enrich is off"));
    await tick();
    expect(subject()).toMatch(/^vault-sync: autosave \(a, \d+ files\)$/u);
    expect(read("vault/domains/notes/off.md")).not.toMatch(/^description:/mu);
    expect(calls()).toEqual([]);
    expect(statusFile().alerts.enrich).toEqual({ active: false, on: false });
  });

  it("describes a changed knowledge page and commits it in the same tick; records and secrets are never sent", async () => {
    setConfig("enrich.onAutosave", "true");
    write("vault/domains/notes/alpha.md", page("Alpha", "Alpha explains the alpha procedure."));
    write("vault/plans/p/plan2.md", page("Plan two", "plan body"));
    write("vault/results/r2.md", "# result two\n\nresult body\n");
    write("vault/dispatch-log.md", "# dispatch log\n\n- seed\n- another row\n");
    write("vault/domains/notes/_evidence/e.md", page("Evidence", "evidence body"));
    write("vault/domains/personal/_credentials/svc.md", "# svc\n\ntoken: s3cret-1\n");
    write("vault/domains/personal/_credentials/new.md", "# new\n\ntoken: s3cret-2\n");
    const before = head();

    const result = await tick();

    expect(result.ok).toBe(true);
    expect(calls().map((c) => c.path)).toEqual(["domains/notes/alpha.md"]);
    expect(calls().some((c) => /s3cret|plan body|result body|another row|evidence body/u.test(c.prompt))).toBe(false);
    // two commits this tick: what autosave collected, then what the enrich run wrote
    expect(gitc(["rev-list", "--count", `${before}..HEAD`]).stdout.trim()).toBe("2");
    expect(subject()).toMatch(/^vault-sync: autosave \(a, \d+ files, 1 enriched\)$/u);
    const described = gitc(["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n");
    expect(described).toContain("vault/domains/notes/alpha.md");
    expect(described.filter((p) => !p.endsWith("README.md"))).toEqual(["vault/domains/notes/alpha.md"]);
    expect(read("vault/domains/notes/alpha.md")).toMatch(/^description: Fake synopsis of Alpha$/mu);
    expect(read("vault/domains/notes/alpha.md")).toMatch(/^description_hash: [0-9a-f]{64}$/mu);
    for (const rel of ["vault/plans/p/plan2.md", "vault/results/r2.md", "vault/domains/notes/_evidence/e.md", "vault/domains/personal/_credentials/new.md"]) {
      expect(read(rel)).not.toMatch(/^description:/mu);
    }
    expect(gitc(["status", "--porcelain"]).stdout.trim()).toBe(""); // nothing left behind
    expect(serve.show("main", "vault/domains/notes/alpha.md").stdout).toMatch(/^description: Fake synopsis of Alpha$/mu); // pushed
    expect(statusFile().alerts.enrich).toMatchObject({ active: false, on: true, pending: 0, callsLastHour: 1, totals: { calls: 1, enriched: 1 } });
  });

  it("leaves the tree as the gate wants it: the description and its index are one commit, and the next autosave is not blocked", async () => {
    // the enrich commit carries the page and the README index regenerated from it, together
    expect(names()).toContain("vault/domains/notes/alpha.md");
    expect(names()).toContain("vault/domains/notes/README.md");
    expect(gitc(["show", "HEAD:vault/domains/notes/README.md"]).stdout).toMatch(/Fake synopsis of Alpha/u);
    expect(world.sh(VAULT_BIN, ["sync", "--check", "--root", join(dir, "vault")], { allowFail: true }).code).toBe(0);
    expect(statusFile()).toMatchObject({ state: "ok", autosaveBlocked: null });

    const n = calls().length;
    const before = head();
    write("vault/domains/notes/next.md", "---\ntitle: Next\ndescription: written by hand\ntags: [notes]\naliases: [after]\n---\n\n# Next\n");
    const result = await tick();
    expect(result.status).toMatchObject({ state: "ok", autosaveBlocked: null, ahead: 0 });
    expect(gitc(["rev-list", "--count", `${before}..HEAD`]).stdout.trim()).toBe("1");
    expect(names()).toContain("vault/domains/notes/next.md");
    expect(calls().length).toBe(n); // every field is hand-written: nothing to ask
    expect(events.some((e) => e.event === "autosave-blocked")).toBe(false);
  });

  it("a page already described is not sent again; a body change makes it stale and it is described anew", async () => {
    const n = calls().length;
    write("vault/domains/notes/alpha.md", read("vault/domains/notes/alpha.md").replace("alpha procedure.", "alpha procedure, revised."));
    await tick();
    expect(calls().slice(n).map((c) => c.path)).toEqual(["domains/notes/alpha.md"]);
    expect(calls().at(-1).prompt).toMatch(/revised/u);
    expect(subject()).toMatch(/1 enriched\)$/u);

    const m = calls().length;
    // hand-written metadata (no stamps) is the writer's: kept, and no call is made for it
    write("vault/domains/notes/seed.md", "---\ntitle: Seed\ndescription: seed note\ntags: [seed]\naliases: [first]\n---\n\n# Seed\n\nmore\n");
    await tick();
    expect(calls().length).toBe(m);
    expect(read("vault/domains/notes/seed.md")).toMatch(/^description: seed note$/mu);
  });

  it("caps calls per tick and per hour; what does not fit is described on a later tick", async () => {
    const spent = statusFile().alerts.enrich.callsLastHour;
    setConfig("enrich.perTick", 1);
    setConfig("enrich.perHour", spent + 2);
    const n = calls().length;
    write("vault/domains/notes/b1.md", page("B1", "one"));
    write("vault/domains/notes/b2.md", page("B2", "two"));
    write("vault/domains/notes/b3.md", page("B3", "three"));

    await tick();
    expect(calls().length).toBe(n + 1);
    await tick({ advance: QUIET + MIN });
    expect(calls().length).toBe(n + 2);
    await tick({ advance: QUIET + 2 * MIN });
    expect(calls().length).toBe(n + 2); // the hour is spent
    expect(statusFile().alerts.enrich).toMatchObject({ active: false, pending: 1, callsLastHour: spent + 2 });

    await tick({ advance: 2 * HOUR });
    expect(calls().slice(n).map((c) => c.path)).toEqual(["domains/notes/b1.md", "domains/notes/b2.md", "domains/notes/b3.md"]);
    for (const p of ["b1", "b2", "b3"]) expect(read(`vault/domains/notes/${p}.md`)).toMatch(/^description: Fake synopsis of B\d$/mu);
    setConfig("enrich.perTick", 2);
    setConfig("enrich.perHour", 1000);
  });

  it("a provider failure raises the enrich alarm in sync status and leaves the page as written", async () => {
    writeFileSync(join(fakeDir, "fail"), "");
    const n = calls().length;
    write("vault/domains/notes/c1.md", page("C1", "provider will fail"));
    await tick({ advance: 3 * HOUR });
    expect(calls().length).toBe(n + 1);
    expect(read("vault/domains/notes/c1.md")).not.toMatch(/^description:/mu);
    const alert = statusFile().alerts.enrich;
    expect(alert).toMatchObject({ active: true, pending: 1 });
    expect(alert.lastError).toMatch(/fake provider down/u);
    const status = world.sh(VAULT_BIN, ["sync", "status", "--json"], { cwd: dir, extraEnv: env, allowFail: true });
    expect(status.code).toBe(2);
    expect(JSON.parse(status.stdout).problems).toContain("경보 enrich");

    await tick({ advance: 3 * HOUR + MIN });
    expect(calls().length).toBe(n + 1); // waiting out the retry time

    rmSync(join(fakeDir, "fail"));
    await tick({ advance: 4 * HOUR });
    expect(calls().length).toBe(n + 2);
    expect(read("vault/domains/notes/c1.md")).toMatch(/^description: Fake synopsis of C1$/mu);
    expect(statusFile().alerts.enrich.active).toBe(false);
  });

  it("no provider configured: no call, the alarm says to run vault setup", async () => {
    renameSync(configPath, `${configPath}.away`);
    const n = calls().length;
    write("vault/domains/notes/d1.md", page("D1", "no provider yet"));
    await tick({ advance: 5 * HOUR });
    expect(calls().length).toBe(n);
    const alert = statusFile().alerts.enrich;
    expect(alert.active).toBe(true);
    expect(alert.lastError).toMatch(/vault setup/u);
    // the queue keeps d1 and only d1: the folder README autosave regenerated is no target and never entered
    expect(pending()).toEqual(["domains/notes/d1.md"]);
    expect(gitc(["status", "--porcelain"]).stdout.trim()).toBe(""); // d1 itself was autosaved
    renameSync(`${configPath}.away`, configPath);
  });

  it("turned off again: the queue is dropped and nothing is sent", async () => {
    setConfig("enrich.onAutosave", "false");
    const n = calls().length;
    write("vault/domains/notes/e1.md", page("E1", "after turning it off"));
    await tick({ advance: 7 * HOUR });
    expect(calls().length).toBe(n);
    expect(statusFile().alerts.enrich).toEqual({ active: false, on: false });
    expect(statusFile().enrichQueue.pending).toEqual([]);
  });
});

// The commit gate reads the work tree as it stands when it runs. These run with enrich off: they
// are about autosave and a tree that another writer moves between the regeneration and the gate.
describe.sequential("autosave and the commit gate", { timeout: 120_000 }, () => {
  // `vault` as the daemon runs it, followed once by a late writer: after the run it rewords a
  // page's description, the way a `vault sync --enrich` run outside the daemon does before its own
  // index pass. The trigger file is consumed by the first run that finds it.
  const LATE_WRITER = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } = require("node:fs");
const run = spawnSync(process.env.LATE_WRITER_VAULT, process.argv.slice(2), { stdio: "inherit" });
const trigger = process.env.LATE_WRITER_TRIGGER;
if (existsSync(trigger)) {
  const { page, from, to, mtime } = JSON.parse(readFileSync(trigger, "utf8"));
  rmSync(trigger);
  writeFileSync(page, readFileSync(page, "utf8").replace(from, to));
  utimesSync(page, new Date(mtime), new Date(mtime));
}
process.exit(run.status === null ? 1 : run.status);
`;
  const T = 8 * HOUR;
  let lateBin;
  let trigger;

  beforeAll(() => {
    lateBin = join(fakeDir, "bin", "vault-late-writer");
    trigger = join(fakeDir, "late-writer.json");
    writeFileSync(lateBin, LATE_WRITER);
    chmodSync(lateBin, 0o755);
    for (const key of ["LATE_WRITER_VAULT", "LATE_WRITER_TRIGGER"]) saved[key] = process.env[key];
    process.env.LATE_WRITER_VAULT = VAULT_BIN;
    process.env.LATE_WRITER_TRIGGER = trigger;
  });

  it("a description written between the regeneration and the gate: autosave regenerates again and commits", async () => {
    const seedPage = join(dir, "vault/domains/notes/seed.md");
    write("vault/domains/notes/q1.md", "---\ntitle: Q1\ndescription: a quiet note\ntags: [notes]\naliases: [q]\n---\n\n# Q1\n");
    // the late writer's page is being written as the tick judges it: it is not quiet, and it waits
    writeFileSync(trigger, JSON.stringify({ page: seedPage, from: "description: seed note", to: "description: seed note, reworded", mtime: Date.now() + T + QUIET }));
    const before = head();
    const mark = events.length;

    const result = await tick({ advance: T + QUIET, vaultBin: lateBin });

    expect(existsSync(trigger)).toBe(false); // the late writer ran, after the regeneration
    expect(result.status).toMatchObject({ state: "ok", autosaveBlocked: null, ahead: 0 });
    expect(gitc(["rev-list", "--count", `${before}..HEAD`]).stdout.trim()).toBe("1");
    expect(subject()).toMatch(/^vault-sync: autosave \(a, \d+ files\)$/u);
    expect(names()).toContain("vault/domains/notes/q1.md");
    expect(names()).toContain("vault/domains/notes/README.md"); // regenerated once more, for the reworded description
    expect(names()).not.toContain("vault/domains/notes/seed.md");
    expect(gitc(["show", "HEAD:vault/domains/notes/README.md"]).stdout).toMatch(/seed note, reworded/u);
    const row = events.slice(mark).find((e) => e.event === "autosave");
    expect(row).toMatchObject({ regenerations: 1 });
    expect(events.slice(mark).some((e) => e.event === "autosave-blocked")).toBe(false);
    // the page itself is its writer's until it is quiet
    expect(gitc(["status", "--porcelain"]).stdout.trim()).toBe("M vault/domains/notes/seed.md");

    await tick({ advance: T + 2 * QUIET + MIN });
    expect(gitc(["status", "--porcelain"]).stdout.trim()).toBe("");
    expect(statusFile()).toMatchObject({ state: "ok", autosaveBlocked: null });
  });

  it("a refusal the regeneration does not answer is a block: logged with its reason, retried after the wait, never bypassed", async () => {
    const hook = join(dir, gitc(["rev-parse", "--git-path", "hooks/pre-commit"]).stdout.trim());
    const original = readFileSync(hook, "utf8");
    writeFileSync(hook, "#!/bin/sh\necho 'gate: refused for a reason of its own' >&2\nexit 1\n");
    write("vault/domains/notes/r1.md", "---\ntitle: R1\ndescription: held by the gate\ntags: [notes]\naliases: [r]\n---\n\n# R1\n");
    const before = head();
    const mark = events.length;

    const blocked = await tick({ advance: T + 4 * QUIET });
    expect(blocked.status.state).toBe("blocked");
    expect(blocked.status.autosaveBlocked).toMatch(/자동 저장 막힘: gate: refused for a reason of its own/u);
    expect(head()).toBe(before);
    expect(gitc(["diff", "--cached", "--name-only"]).stdout.trim()).toBe(""); // nothing left staged
    expect(gitc(["status", "--porcelain", "--", "vault/domains/notes/r1.md"]).stdout.trim()).toBe("?? vault/domains/notes/r1.md");
    expect(events.slice(mark).filter((e) => e.event === "autosave-blocked")).toEqual([
      expect.objectContaining({ event: "autosave-blocked", message: "gate: refused for a reason of its own", reason: "refused", retries: 0, drifted: [] }),
    ]);

    writeFileSync(hook, original);
    const waiting = await tick({ advance: T + 4 * QUIET + MIN });
    expect(waiting.status.state).toBe("blocked"); // the gate is asked again only after gateRetrySeconds
    expect(head()).toBe(before);
    expect(events.slice(mark).filter((e) => e.event === "autosave-blocked")).toHaveLength(1);

    const retried = await tick({ advance: T + 4 * QUIET + 11 * MIN });
    expect(retried.status).toMatchObject({ state: "ok", autosaveBlocked: null, ahead: 0 });
    expect(names()).toContain("vault/domains/notes/r1.md");
  });
});

describe.sequential("enrich on autosave: commits made in the clone", { timeout: 120_000 }, () => {
  const T = 10 * HOUR;

  it("describes a page an agent committed itself, in the tick that sees the commit; records in that commit are not sent", async () => {
    setConfig("enrich.onAutosave", "true");
    await tick({ advance: T }); // turned on: starts from what the server does not have yet — nothing
    expect(statusFile().enrichQueue.seenHead).toBe(head());
    const n = calls().length;

    write("vault/domains/notes/g1.md", page("G1", "G1 is committed by an agent, with a message."));
    write("vault/plans/p/g-plan.md", page("G plan", "direct plan body"));
    write("vault/results/g-result.md", "# g result\n\ndirect result body\n");
    const direct = agentCommit(["vault/domains/notes/g1.md", "vault/plans/p/g-plan.md", "vault/results/g-result.md"], "agent: notes on G1");
    const mark = events.length;

    const result = await tick({ advance: T + MIN });

    expect(result.ok).toBe(true);
    expect(calls().slice(n).map((c) => c.path)).toEqual(["domains/notes/g1.md"]);
    expect(calls().slice(n).some((c) => /direct plan body|direct result body/u.test(c.prompt))).toBe(false);
    expect(events.slice(mark).find((e) => e.event === "enrich-commits")).toMatchObject({ commits: 1, queued: 1 });
    // one commit on top of the agent's: the description and its index
    expect(gitc(["rev-list", "--count", `${direct}..HEAD`]).stdout.trim()).toBe("1");
    expect(subject()).toMatch(/^vault-sync: autosave \(a, \d+ files, 1 enriched\)$/u);
    expect(names().filter((p) => !p.endsWith("README.md"))).toEqual(["vault/domains/notes/g1.md"]);
    expect(serve.show("main", "vault/domains/notes/g1.md").stdout).toMatch(/^description: Fake synopsis of G1$/mu);
    expect(gitc(["status", "--porcelain"]).stdout.trim()).toBe("");
    expect(statusFile()).toMatchObject({ state: "ok", autosaveBlocked: null, ahead: 0 });
    expect(pending()).toEqual([]);
  });

  it("does not queue its own commits again: the next ticks ask nothing", async () => {
    const n = calls().length;
    const mark = events.length;
    await tick({ advance: T + 2 * MIN });
    await tick({ advance: T + 3 * MIN });
    expect(calls().length).toBe(n);
    expect(events.slice(mark).some((e) => e.event === "enrich-commits" || e.event === "enrich")).toBe(false);
    expect(statusFile().enrichQueue.seenHead).toBe(head());
  });

  it("does not describe a page that came from another computer", async () => {
    const other = join(world.root, "seed"); // a second clone of the store, with no daemon
    world.git(other, ["pull", "--quiet", "--ff-only", "origin", "main"]);
    mkdirSync(join(other, "vault/domains/notes"), { recursive: true });
    writeFileSync(join(other, "vault/domains/notes/elsewhere.md"), page("Elsewhere", "written and committed on another computer"));
    world.sh(VAULT_BIN, ["sync", "--root", join(other, "vault")]);
    world.git(other, ["add", "-A"]);
    world.git(other, ["commit", "--quiet", "-m", "notes from another computer"]);
    world.git(other, ["push", "--quiet", "origin", "HEAD:main"]);
    const n = calls().length;
    const mark = events.length;

    await tick({ advance: T + 4 * MIN });
    expect(existsSync(join(dir, "vault/domains/notes/elsewhere.md"))).toBe(true); // it arrived
    await tick({ advance: T + 5 * MIN });

    expect(calls().length).toBe(n);
    expect(read("vault/domains/notes/elsewhere.md")).not.toMatch(/^description:/mu);
    expect(events.slice(mark).some((e) => e.event === "enrich-commits")).toBe(false);
    expect(pending()).toEqual([]);
    expect(statusFile().ahead).toBe(0);
  });

  it("does not describe a page from another computer that arrives by a git pull in the clone", async () => {
    const other = join(world.root, "seed");
    world.git(other, ["pull", "--quiet", "--ff-only", "origin", "main"]);
    writeFileSync(join(other, "vault/domains/notes/pulled.md"), page("Pulled", "written on another computer, pulled by hand"));
    world.sh(VAULT_BIN, ["sync", "--root", join(other, "vault")]);
    world.git(other, ["add", "-A"]);
    world.git(other, ["commit", "--quiet", "-m", "notes from another computer, pulled by hand"]);
    world.git(other, ["push", "--quiet", "origin", "HEAD:main"]);
    gitc(["pull", "--quiet", "--ff-only", "origin", "main"]); // an agent pulls by hand, between ticks
    expect(existsSync(join(dir, "vault/domains/notes/pulled.md"))).toBe(true);
    const n = calls().length;
    const mark = events.length;

    await tick({ advance: T + 5 * MIN + 20_000 });
    await tick({ advance: T + 5 * MIN + 40_000 });

    expect(calls().length).toBe(n);
    expect(read("vault/domains/notes/pulled.md")).not.toMatch(/^description:/mu);
    expect(events.slice(mark).some((e) => e.event === "enrich-commits")).toBe(false);
    expect(pending()).toEqual([]);
  });

  it("leaves a committed page alone while it has uncommitted changes, and describes it once they are saved", async () => {
    write("vault/domains/notes/h1.md", page("H1", "first draft"));
    agentCommit(["vault/domains/notes/h1.md"], "agent: h1, first draft");
    // the agent keeps writing: the page is dirty and, to the tick's clock, written just now
    const abs = write("vault/domains/notes/h1.md", page("H1", "second draft, still being written"));
    const at = Date.now() + T + 6 * MIN;
    utimesSync(abs, new Date(at), new Date(at));
    const n = calls().length;
    const before = head();

    await tick({ advance: T + 6 * MIN });
    expect(calls().length).toBe(n);
    expect(head()).toBe(before);
    expect(read("vault/domains/notes/h1.md")).toBe(page("H1", "second draft, still being written"));
    expect(pending()).toEqual(["domains/notes/h1.md"]);
    expect(statusFile().alerts.enrich).toMatchObject({ active: false, pending: 1 });

    await tick({ advance: T + 6 * MIN + QUIET + MIN }); // quiet now: autosave collects it, then it is described
    expect(calls().slice(n).map((c) => c.path)).toEqual(["domains/notes/h1.md"]);
    expect(calls().at(-1).prompt).toMatch(/second draft/u);
    expect(read("vault/domains/notes/h1.md")).toMatch(/^description: Fake synopsis of H1$/mu);
    expect(gitc(["status", "--porcelain"]).stdout.trim()).toBe("");
    expect(pending()).toEqual([]);
  });

  it("sees a commit made while a tick was running, although that tick pushed it", async () => {
    write("vault/domains/notes/j1.md", page("J1", "committed before the tick"));
    agentCommit(["vault/domains/notes/j1.md"], "agent: j1");
    const n = calls().length;
    // right after the tick has looked at the clone's commits, an agent commits another page
    onEvent = (row) => {
      if (row.event !== "enrich-commits") return;
      onEvent = null;
      write("vault/domains/notes/j2.md", page("J2", "committed while the daemon was busy"));
      agentCommit(["vault/domains/notes/j2.md"], "agent: j2");
    };

    await tick({ advance: T + 20 * MIN });
    expect(onEvent).toBeNull();
    expect(calls().slice(n).map((c) => c.path)).toEqual(["domains/notes/j1.md"]);
    expect(statusFile().ahead).toBe(0); // j2's commit went to the server with the rest
    expect(serve.show("main", "vault/domains/notes/j2.md").stdout).not.toMatch(/^description:/mu);

    await tick({ advance: T + 21 * MIN });
    expect(calls().slice(n).map((c) => c.path)).toEqual(["domains/notes/j1.md", "domains/notes/j2.md"]);
    expect(serve.show("main", "vault/domains/notes/j2.md").stdout).toMatch(/^description: Fake synopsis of J2$/mu);
    expect(pending()).toEqual([]);
  });

  it("offline, its own unpushed commits are still not queued again", async () => {
    const base = T + HOUR;
    await proxy.cut(); // offline from here: every commit below stays ahead of the server
    write("vault/domains/notes/m1.md", page("M1", "saved by autosave while offline"));
    const n = calls().length;

    await tick({ advance: base });
    expect(calls().slice(n).map((c) => c.path)).toEqual(["domains/notes/m1.md"]);
    expect(subject()).toMatch(/1 enriched\)$/u);
    expect(statusFile().ahead).toBe(2); // the autosave commit and the enrich commit

    const mark = events.length;
    await tick({ advance: base + MIN });
    expect(statusFile().ahead).toBe(2);
    expect(events.slice(mark).some((e) => e.event === "enrich-commits" || e.event === "enrich")).toBe(false);
    expect(calls().length).toBe(n + 1);
  });

  it("looks at a commit once: a page the provider keeps failing is given up, also while the commit waits unpushed", async () => {
    const base = T + HOUR + 2 * MIN;
    writeFileSync(join(fakeDir, "fail"), "");
    write("vault/domains/notes/k1.md", page("K1", "the provider is down for this one"));
    agentCommit(["vault/domains/notes/k1.md"], "agent: k1");
    const n = calls().length;

    for (let i = 0; i < 3; i += 1) {
      await tick({ advance: base + i * 31 * MIN });
      expect(calls().length).toBe(n + i + 1);
      expect(statusFile().ahead).toBe(3);
    }
    expect(statusFile().alerts.enrich).toMatchObject({ active: true, gaveUp: 1, pending: 0 });
    await tick({ advance: base + 3 * 31 * MIN });
    expect(calls().length).toBe(n + 3); // not queued again by the commit it was already taken from

    rmSync(join(fakeDir, "fail"));
    await proxy.restore();
    // committed again (an edit): out of the alarm, described, and everything reaches the server
    write("vault/domains/notes/k1.md", page("K1", "the provider is back"));
    agentCommit(["vault/domains/notes/k1.md"], "agent: k1 again");
    await tick({ advance: base + 3 * HOUR });
    await tick({ advance: base + 3 * HOUR + 10 * MIN });
    expect(read("vault/domains/notes/k1.md")).toMatch(/^description: Fake synopsis of K1$/mu);
    expect(statusFile().alerts.enrich).toMatchObject({ active: false, gaveUp: 0, pending: 0 });
    expect(statusFile().ahead).toBe(0);
    expect(serve.show("main", "vault/domains/notes/k1.md").stdout).toMatch(/^description: Fake synopsis of K1$/mu);
    expect(serve.show("main", "vault/domains/notes/m1.md").stdout).toMatch(/^description: Fake synopsis of M1$/mu);
  });
});

// The switch holds from the tick after it is turned, with no restart; and the files a person alone
// writes (a tree's decision ledgers) are declared out of enrich by the tree.
describe.sequential("enrich on autosave: declared exclusions and the live switch", { timeout: 120_000 }, () => {
  const T = 20 * HOUR;
  const DECLARATION = { profile: "kuma-vault", enrichExclude: ["/decisions.md", "projects/*.project-decisions.md"] };
  const LEDGER = "---\ntitle: Decisions\n---\n\n# Decisions\n\n- the owner decided this\n";
  const PROJECT_LEDGER = "---\ntitle: Acme decisions\n---\n\n# Acme decisions\n\n- keep it small\n";

  it("a switch turned while the daemon runs holds from its next tick, with no restart; status shows both values", async () => {
    const ctx = await loadContext(dir, { env }); // the daemon started while it was on
    expect(ctx.settings.enrichOnAutosave).toBe(true);
    const log = (row) => events.push(row);

    setConfig("enrich.onAutosave", "false");
    const turned = world.sh(VAULT_BIN, ["sync", "status", "--json"], { cwd: dir, extraEnv: env, allowFail: true });
    const n = calls().length;
    write("vault/domains/notes/s1.md", page("S1", "written after the switch was turned off"));
    await runTick(ctx, mem, { now: Date.now() + T, log });
    expect(calls().length).toBe(n);
    expect(read("vault/domains/notes/s1.md")).not.toMatch(/^description:/mu);
    expect(statusFile().alerts.enrich).toEqual({ active: false, on: false });
    // before that tick, status said the switch was turned but not yet run; after it, both agree
    expect(JSON.parse(turned.stdout).enrichSwitch).toEqual({ configured: false, daemon: true });
    const applied = world.sh(VAULT_BIN, ["sync", "status", "--json"], { cwd: dir, extraEnv: env, allowFail: true });
    expect(JSON.parse(applied.stdout).enrichSwitch).toEqual({ configured: false, daemon: false });

    setConfig("enrich.onAutosave", "true");
    write("vault/domains/notes/s2.md", page("S2", "written after the switch was turned on again"));
    await runTick(ctx, mem, { now: Date.now() + T + HOUR, log });
    expect(calls().slice(n).map((c) => c.path)).toEqual(["domains/notes/s2.md"]);
    expect(statusFile().alerts.enrich).toMatchObject({ on: true, active: false });
  });

  it("a decision file the tree declares out is never sent and keeps its bytes, committed by an agent or autosaved", async () => {
    setConfig("enrich.onAutosave", "true");
    await tick({ advance: T + 2 * HOUR });
    write("vault/vault.config.json", `${JSON.stringify(DECLARATION, null, 2)}\n`);
    write("vault/decisions.md", LEDGER);
    write("vault/projects/acme.project-decisions.md", PROJECT_LEDGER);
    write("vault/domains/notes/n1.md", page("N1", "an ordinary page committed with the ledgers"));
    agentCommit(
      ["vault/vault.config.json", "vault/decisions.md", "vault/projects/acme.project-decisions.md", "vault/domains/notes/n1.md"],
      "agent: declare the ledgers out of enrich",
    );
    const n = calls().length;

    await tick({ advance: T + 2 * HOUR + MIN });
    expect(calls().slice(n).map((c) => c.path)).toEqual(["domains/notes/n1.md"]);
    expect(read("vault/decisions.md")).toBe(LEDGER);
    expect(read("vault/projects/acme.project-decisions.md")).toBe(PROJECT_LEDGER);
    expect(statusFile().alerts.enrich).toMatchObject({ active: false, pending: 0 });

    // the owner edits a ledger; autosave commits it and nothing describes it
    const edited = LEDGER.replace("- the owner decided this", "- the owner decided this\n- and this");
    write("vault/decisions.md", edited);
    const m = calls().length;
    await tick({ advance: T + 3 * HOUR });
    await tick({ advance: T + 3 * HOUR + MIN });
    expect(calls().length).toBe(m);
    expect(read("vault/decisions.md")).toBe(edited);
    expect(serve.show("main", "vault/decisions.md").stdout).toBe(edited);
    expect(statusFile().alerts.enrich).toMatchObject({ active: false, pending: 0 });
  });
});

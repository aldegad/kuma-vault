// The enrich step's queue, caps, alarm and memory, with the enrich run injected (no git, no model).
// The real run, end to end against a server and a fake provider CLI: enrich.integration.test.mjs.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { gateRefusal } from "./autosave.mjs";
import { launchdPath } from "./launchd.mjs";
import { statusProblems } from "./sync-cli.mjs";
import {
  ENRICH_GIVE_UP_AFTER, ENRICH_PENDING_MAX, createEnrichMemory, enrichAlert, enrichStep as enrichStepWith, enrichTargets, noteCollected as noteCollectedBy,
  persistEnrichMemory, shortError,
} from "./enrich.mjs";

const MIN = 60_000;
const T0 = Date.parse("2026-10-05T09:00:00Z");

function makeCtx(settings = {}, treeAbs = null) {
  return {
    treeRel: "vault",
    treeAbs,
    settings: { enrichOnAutosave: true, enrichPerTick: 2, enrichPerHour: 10, enrichRetryMs: 30 * MIN, ...settings },
    treePath: (p) => (p.startsWith("vault/") ? p.slice("vault/".length) : null),
  };
}

/** A tree on disk with `declaration` as its vault.config.json (none when null), and its resolver. */
function declaredTree(declaration, settings) {
  const treeAbs = join(mkdtempSync(join(tmpdir(), "kv-enrich-unit-")), "vault");
  mkdirSync(treeAbs);
  if (declaration) writeFileSync(join(treeAbs, "vault.config.json"), JSON.stringify(declaration));
  const ctx = makeCtx(settings, treeAbs);
  const state = createEnrichMemory(null);
  return { ctx, state, isTarget: enrichTargets(ctx, state), remove: () => rmSync(join(treeAbs, ".."), { recursive: true, force: true }) };
}

// The step and the queue as the daemon drives them, under a stand-in resolver (the tree's own is
// covered by `enrichTargets` below) and with no page still being written unless a test says so.
const isTarget = (path) => path.startsWith("domains/") && path.endsWith(".md") && !/(^|\/)README\.md$/u.test(path);
const noteCollected = (ctx, state, committed, options) => noteCollectedBy(ctx, state, isTarget, committed, options);
const enrichStep = (ctx, mem, options = {}) => enrichStepWith(ctx, mem, { isTarget, uncommitted: async () => new Set(), ...options });

/** A fake enrich run: describes every queued page it is asked about, up to `limit`, unless `fail` names it. */
function fakeRun({ fail = new Set(), report = true } = {}) {
  const calls = [];
  const run = async (ctx, { paths, limit }) => {
    calls.push({ paths, limit });
    if (!report) return { preSync: { code: 1, line: "vault sync --enrich needs a provider. Run `vault setup`" }, written: [], report: null };
    const candidates = paths.filter((p) => p.startsWith("domains/"));
    const selected = candidates.slice(0, limit);
    const failed = selected.filter((p) => fail.has(p)).map((path) => ({ path, error: "model failed: provider down" }));
    const enriched = selected.filter((p) => !fail.has(p)).map((path) => ({ path, reason: "missing", wrote: true }));
    const excluded = paths.filter((p) => !p.startsWith("domains/")).map((path) => ({ path, reason: "not-a-target" }));
    return {
      preSync: { code: failed.length ? 1 : 0, line: "" },
      written: [], // nothing on disk to commit here; the integration test commits for real
      report: { enrich: { modelCalls: selected.length, enriched, failed, skipped: [], raced: [], excluded, overflow: candidates.slice(limit) } },
    };
  };
  run.calls = calls;
  return run;
}

function committed(...paths) {
  return { paths: paths.map((p) => `vault/${p}`) };
}

describe("enrichTargets", () => {
  it("is the engine's resolver under the tree's declaration: only knowledge pages enter the queue", () => {
    const { ctx, state, isTarget: declared, remove } = declaredTree({ profile: "kuma-vault" });
    try {
      expect(state.targetError).toBeNull();
      noteCollectedBy(ctx, state, declared, {
        paths: [
          "vault/domains/a.md",
          "vault/projects/app/note.md",
          "vault/plans/p/x.md",
          "vault/results/r.md",
          "vault/dispatch-log.md",
          "vault/log.md",
          "vault/domains/README.md",
          "vault/domains/doc.pdf.md",
          "vault/domains/a/_evidence/e.md",
          "vault/domains/.trash/old.md",
          "vault/domains/personal/_credentials/svc.md",
          "vault/domains/x/_Sync-Conflicts/a.md",
          "vault/img/p.png",
          "README.md",
          "notes/outside-the-tree.md",
        ],
      });
      expect([...state.pending.keys()]).toEqual(["domains/a.md", "projects/app/note.md"]);
    } finally {
      remove();
    }
  });

  it("follows what the tree declares", () => {
    const { ctx, state, isTarget: declared, remove } = declaredTree({ profile: "kuma-vault", rootNonNavFiles: ["journal.md"], ownerLocalBucketPrefix: "~" });
    try {
      noteCollectedBy(ctx, state, declared, committed("journal.md", "domains/~scratch/s.md", "domains/_notes/n.md", "domains/personal/_credentials/svc.md"));
      expect([...state.pending.keys()]).toEqual(["domains/_notes/n.md"]); // `_` is an ordinary folder here; a secret directory never is
    } finally {
      remove();
    }
  });

  it("records that are not targets cannot push a page out of the queue while no run reports", async () => {
    const { ctx, state, isTarget: declared, remove } = declaredTree({ profile: "kuma-vault" });
    try {
      noteCollectedBy(ctx, state, declared, committed("domains/kept.md"));
      for (let round = 0; round < 3; round += 1) {
        const records = Array.from({ length: ENRICH_PENDING_MAX }, (_, i) => `plans/p${round}/plan-${i}.md`);
        noteCollectedBy(ctx, state, declared, committed(...records, `results/r${round}.md`, "dispatch-log.md", "domains/README.md"));
        // no provider: the run prints no report, so nothing is taken out of the queue by a run
        await enrichStepWith(ctx, { enrich: state }, { clock: () => T0 + round * 31 * MIN, run: fakeRun({ report: false }), isTarget: declared, uncommitted: async () => new Set() });
      }
      expect([...state.pending.keys()]).toEqual(["domains/kept.md"]);
      expect(state.dropped).toBe(0);
    } finally {
      remove();
    }
  });

  it("a tree with no declaration, or one without enrich, queues nothing and raises the alarm", () => {
    for (const [declaration, message] of [[null, /No vault\.config\.json declaration/u], [{ profile: "kuma-vault", enrich: false }, /does not carry enrich/u]]) {
      const { ctx, state, isTarget: declared, remove } = declaredTree(declaration);
      try {
        expect(declared).toBeNull();
        noteCollectedBy(ctx, state, declared, committed("domains/a.md"));
        expect(state.pending.size).toBe(0);
        const alert = enrichAlert(ctx, state, { now: T0 });
        expect(alert.active).toBe(true);
        expect(alert.lastError).toMatch(message);
        expect(statusProblems({ state: "ok", alerts: { enrich: alert } }, { running: true })).toEqual(["경보 enrich"]);
      } finally {
        remove();
      }
    }
  });

  it("is not read while enrich is off: no resolver, no alarm", () => {
    const { ctx, state, isTarget: declared, remove } = declaredTree(null, { enrichOnAutosave: false });
    try {
      expect(declared).toBeNull();
      expect(state.targetError).toBeNull();
      expect(enrichAlert(ctx, state, { now: T0 })).toEqual({ active: false, on: false });
    } finally {
      remove();
    }
  });
});

describe("noteCollected", () => {
  it("queues a page once, at the queue's end, and skips what the enrich run itself wrote", () => {
    const ctx = makeCtx();
    const state = createEnrichMemory(null);
    noteCollected(ctx, state, committed("domains/a.md", "domains/b.md"));
    noteCollected(ctx, state, committed("domains/a.md", "domains/c.md", "domains/README.md"), { skip: ["vault/domains/c.md"] });
    expect([...state.pending.keys()]).toEqual(["domains/b.md", "domains/a.md"]);
  });

  it("does nothing when the clone has not turned enrich on", () => {
    const state = createEnrichMemory(null);
    noteCollected(makeCtx({ enrichOnAutosave: false }), state, committed("domains/a.md"));
    expect(state.pending.size).toBe(0);
  });

  it("holds at most ENRICH_PENDING_MAX paths and counts what it dropped", () => {
    const state = createEnrichMemory(null);
    const paths = Array.from({ length: ENRICH_PENDING_MAX + 3 }, (_, i) => `domains/p${i}.md`);
    noteCollected(makeCtx(), state, committed(...paths));
    expect(state.pending.size).toBe(ENRICH_PENDING_MAX);
    expect(state.dropped).toBe(3);
    expect(state.pending.has("domains/p0.md")).toBe(false);
  });
});

describe("enrichStep", () => {
  it("off: the run is never made and the queue is emptied", async () => {
    const state = createEnrichMemory(null);
    noteCollected(makeCtx(), state, committed("domains/a.md"));
    const run = fakeRun();
    const result = await enrichStep(makeCtx({ enrichOnAutosave: false }), { enrich: state }, { clock: () => T0, run });
    expect(result).toBeNull();
    expect(run.calls).toEqual([]);
    expect(state.pending.size).toBe(0);
    expect(enrichAlert(makeCtx({ enrichOnAutosave: false }), state, { now: T0 })).toEqual({ active: false, on: false });
  });

  it("caps model calls per tick and per hour; what does not fit waits for a later tick", async () => {
    const ctx = makeCtx({ enrichPerTick: 2, enrichPerHour: 3 });
    const mem = { enrich: createEnrichMemory(null) };
    const run = fakeRun();
    noteCollected(ctx, mem.enrich, committed("domains/a.md", "domains/b.md", "domains/c.md", "domains/d.md", "results/r.md"));

    await enrichStep(ctx, mem, { clock: () => T0, run });
    expect(run.calls[0]).toEqual({ paths: ["domains/a.md", "domains/b.md", "domains/c.md", "domains/d.md"], limit: 2 }); // results/ never queued
    expect([...mem.enrich.pending.keys()]).toEqual(["domains/c.md", "domains/d.md"]);

    await enrichStep(ctx, mem, { clock: () => T0 + MIN, run });
    expect(run.calls[1].limit).toBe(1); // 2 of the hour's 3 spent
    expect([...mem.enrich.pending.keys()]).toEqual(["domains/d.md"]);

    expect(await enrichStep(ctx, mem, { clock: () => T0 + 2 * MIN, run })).toBeNull();
    expect(run.calls.length).toBe(2); // the hour is spent: no run at all
    const alert = enrichAlert(ctx, mem.enrich, { now: T0 + 2 * MIN });
    expect(alert).toMatchObject({ active: false, on: true, pending: 1, callsLastHour: 3 });

    await enrichStep(ctx, mem, { clock: () => T0 + 60 * MIN + 30_000, run });
    expect(run.calls[2].limit).toBe(2); // T0's two calls have left the hour; T0+1m's is still in it
    expect(mem.enrich.calls).toEqual([T0 + MIN, T0 + 60 * MIN + 30_000]);
    expect(mem.enrich.pending.size).toBe(0);
    expect(mem.enrich.totals).toEqual({ runs: 3, calls: 4, enriched: 4 });
  });

  it("a page the model failed raises the alarm, waits the retry time, and is given up after three tries", async () => {
    const ctx = makeCtx();
    const mem = { enrich: createEnrichMemory(null) };
    const run = fakeRun({ fail: new Set(["domains/bad.md"]) });
    noteCollected(ctx, mem.enrich, committed("domains/bad.md"));

    let at = T0;
    await enrichStep(ctx, mem, { clock: () => at, run });
    let alert = enrichAlert(ctx, mem.enrich, { now: at });
    expect(alert.active).toBe(true);
    expect(alert.lastError).toMatch(/1 page\(s\) not described: model failed/u);
    expect(statusProblems({ state: "ok", alerts: { enrich: alert } }, { running: true })).toEqual(["경보 enrich"]);

    at += MIN;
    expect(await enrichStep(ctx, mem, { clock: () => at, run })).toBeNull(); // waiting to retry
    expect(run.calls.length).toBe(1);

    for (let i = 1; i < ENRICH_GIVE_UP_AFTER; i += 1) {
      at += 31 * MIN;
      await enrichStep(ctx, mem, { clock: () => at, run });
    }
    expect(run.calls.length).toBe(ENRICH_GIVE_UP_AFTER);
    expect(mem.enrich.pending.size).toBe(0);
    alert = enrichAlert(ctx, mem.enrich, { now: at });
    expect(alert).toMatchObject({ active: true, gaveUp: 1 });
    expect(alert.failed).toContainEqual({ path: "domains/bad.md", error: "model failed: provider down", gaveUp: true });

    // Collected again (someone edited it): back in the queue, out of the alarm once described.
    noteCollected(ctx, mem.enrich, committed("domains/bad.md"));
    expect(mem.enrich.gaveUp.size).toBe(0);
    at += 31 * MIN;
    await enrichStep(ctx, mem, { clock: () => at, run: fakeRun() });
    expect(enrichAlert(ctx, mem.enrich, { now: at }).active).toBe(false);
  });

  it("a page with uncommitted changes is not handed to the run; it stays queued until it is committed", async () => {
    const ctx = makeCtx();
    const mem = { enrich: createEnrichMemory(null) };
    const run = fakeRun();
    noteCollected(ctx, mem.enrich, committed("domains/typing.md", "domains/done.md"));

    await enrichStep(ctx, mem, { clock: () => T0, run, uncommitted: async () => new Set(["domains/typing.md"]) });
    expect(run.calls).toEqual([{ paths: ["domains/done.md"], limit: 2 }]);
    expect([...mem.enrich.pending.keys()]).toEqual(["domains/typing.md"]);

    // only pages still being written are left: no run, no call, no alarm
    expect(await enrichStep(ctx, mem, { clock: () => T0 + MIN, run, uncommitted: async () => new Set(["domains/typing.md"]) })).toBeNull();
    expect(run.calls.length).toBe(1);
    expect(enrichAlert(ctx, mem.enrich, { now: T0 + MIN })).toMatchObject({ active: false, pending: 1 });

    await enrichStep(ctx, mem, { clock: () => T0 + 2 * MIN, run });
    expect(run.calls[1].paths).toEqual(["domains/typing.md"]);
    expect(mem.enrich.pending.size).toBe(0);
  });

  it("without a resolver (a tree it could not judge) the step makes no run", async () => {
    const ctx = makeCtx();
    const mem = { enrich: createEnrichMemory({ enrichQueue: { pending: [["domains/a.md", 0]] } }) };
    const run = fakeRun();
    expect(await enrichStepWith(ctx, mem, { clock: () => T0, run, isTarget: null, uncommitted: async () => new Set() })).toBeNull();
    expect(run.calls).toEqual([]);
    expect(mem.enrich.pending.size).toBe(1);
  });

  it("a run with no report (no provider) raises the alarm and keeps the queue", async () => {
    const ctx = makeCtx();
    const mem = { enrich: createEnrichMemory(null) };
    noteCollected(ctx, mem.enrich, committed("domains/a.md"));
    const run = fakeRun({ report: false });
    expect(await enrichStep(ctx, mem, { clock: () => T0, run })).toEqual({ enrich: null, saved: null });
    const alert = enrichAlert(ctx, mem.enrich, { now: T0 });
    expect(alert).toMatchObject({ active: true, pending: 1, callsLastHour: 0 });
    expect(alert.lastError).toMatch(/vault setup/u);
    expect(alert.nextRetryAt).not.toBeNull();
  });

  it("the queue, the hour's calls and the totals survive a restart through the state file", async () => {
    const ctx = makeCtx({ enrichPerTick: 1 });
    const mem = { enrich: createEnrichMemory(null) };
    noteCollected(ctx, mem.enrich, committed("domains/a.md", "domains/b.md"));
    await enrichStep(ctx, mem, { clock: () => T0, run: fakeRun() });
    mem.enrich.seenHead = "0123456789abcdef0123456789abcdef01234567";
    mem.enrich.remoteSeen = "89abcdef0123456789abcdef0123456789abcdef";
    const reborn = createEnrichMemory(JSON.parse(JSON.stringify({ enrichQueue: persistEnrichMemory(mem.enrich) })));
    expect([...reborn.pending.keys()]).toEqual(["domains/b.md"]);
    // the commits already looked at stay looked at, and what came from the server stays known
    expect(reborn).toMatchObject({ seenHead: mem.enrich.seenHead, remoteSeen: mem.enrich.remoteSeen });
    expect(reborn.calls).toEqual([T0]);
    expect(reborn.totals).toEqual({ runs: 1, calls: 1, enriched: 1 });
  });
});

describe("shortError", () => {
  it("keeps a provider's first line and its last error line, never the prompt it echoed", () => {
    const echoed = [
      "model failed: OpenAI Codex v0.160.0",
      "--------",
      "user",
      "You are the vault curator.",
      "<document>",
      "token: s3cret-in-a-body",
      "</document>",
      'ERROR: {"type":"error","status":400,"error":{"message":"model not supported"}}',
    ].join("\n");
    const short = shortError(echoed);
    expect(short).toBe('model failed: OpenAI Codex v0.160.0 … ERROR: {"type":"error","status":400,"error":{"message":"model not supported"}}');
    expect(short).not.toMatch(/s3cret|curator/u);
    expect(shortError("model failed: provider down")).toBe("model failed: provider down");
  });

  it("is what the alarm and the state file keep of a failed page", async () => {
    const ctx = makeCtx();
    const mem = { enrich: createEnrichMemory(null) };
    noteCollected(ctx, mem.enrich, committed("domains/a.md"));
    const run = async () => ({
      preSync: { code: 1, line: "" },
      written: [],
      report: { enrich: { modelCalls: 1, enriched: [], skipped: [], raced: [], excluded: [], failed: [{ path: "domains/a.md", error: "model failed: x\n<document>\nbody s3cret\n</document>\nERROR: 400" }] } },
    });
    await enrichStep(ctx, mem, { clock: () => T0, run });
    expect(JSON.stringify(persistEnrichMemory(mem.enrich))).not.toMatch(/s3cret/u);
    expect(JSON.stringify(enrichAlert(ctx, mem.enrich, { now: T0 }))).not.toMatch(/s3cret/u);
  });
});

describe("gateRefusal", () => {
  it("keeps the gate's line and names the indexes it found out of step", () => {
    const output = [
      "vault sync — check (no writes)",
      "vault-dir: /srv/clone/vault",
      "index: 2 drifted / 78 README(s) (76 in sync)",
      "  - [drift] projects/app/README.md",
      "  - [create] projects/new/README.md",
      "sidecars: 0 would (re)generate / 3 binary source(s) (3 in sync)",
    ].join("\n");
    expect(gateRefusal(output, 1)).toBe("index: 2 drifted / 78 README(s) (76 in sync) — projects/app/README.md, projects/new/README.md");
    expect(gateRefusal("gate: refused for a reason of its own\n", 1)).toBe("gate: refused for a reason of its own");
    expect(gateRefusal("", 3)).toBe("git commit exited 3");
  });

  it("a refusal that is not drift says its own reason, never a report line that looks like drift", () => {
    const report = (vaultDir, extra) => [
      "vault sync — check (no writes)",
      `vault-dir: ${vaultDir}`,
      "index: 0 drifted / 78 README(s) (78 in sync)",
      ...extra,
    ].join("\n");
    const sidecar = report("/data/work/autosave-drift/clone/vault", [
      "sidecars: 0 would (re)generate / 3 binary source(s) (2 in sync)",
      "  - [fail] domains/x/_assets/scan.pdf: pdftotext exited 1",
    ]);
    expect(gateRefusal(sidecar, 1)).toBe("- [fail] domains/x/_assets/scan.pdf: pdftotext exited 1");
    const stale = report("/srv/clone/vault", ["lint: 1 issue(s) across 1 file(s)", "  stale vault-index regions: 1"]);
    expect(gateRefusal(stale, 1)).toBe("stale vault-index regions: 1");
    const both = [
      "vault-dir: /srv/clone/vault",
      "index: 1 drifted / 78 README(s) (77 in sync)",
      "  - [drift] domains/README.md",
      "sidecars: 0 would (re)generate / 1 binary source(s) (0 in sync)",
      "  - [fail] a.pdf: broken",
    ].join("\n");
    expect(gateRefusal(both, 1)).toBe("- [fail] a.pdf: broken; index: 1 drifted / 78 README(s) (77 in sync) — domains/README.md");
    expect(gateRefusal("vault gate [freeze] 동결 중: cutover\n", 1)).toBe("vault gate [freeze] 동결 중: cutover");
    // a hook of someone else's, after the gate's clean report
    expect(gateRefusal(report("/srv/drift-lab/vault", ["fts: in sync (3 doc(s))", "lint-staged: prettier failed on a.md"]), 1)).toBe("lint-staged: prettier failed on a.md");
  });
});

describe("launchdPath", () => {
  const base = { node: "/opt/node/bin/node", git: "/usr/bin/git", lfs: "/opt/tools/bin/git-lfs" };
  const find = (name) => ({ codex: "/home/u/.local/bin/codex" })[name] ?? null;

  it("carries node, git, git-lfs and the system directories; nothing else by default", () => {
    expect(launchdPath({ ...base, find })).toEqual({ path: "/opt/node/bin:/usr/bin:/opt/tools/bin:/bin:/usr/sbin:/sbin", found: [], missing: [] });
  });

  it("adds the directory of each provider CLI found and names the ones that are not", () => {
    const result = launchdPath({ ...base, tools: ["claude", "codex"], find });
    expect(result.path.split(":")).toContain("/home/u/.local/bin");
    expect(result.found).toEqual([{ name: "codex", dir: "/home/u/.local/bin" }]);
    expect(result.missing).toEqual(["claude"]);
  });
});

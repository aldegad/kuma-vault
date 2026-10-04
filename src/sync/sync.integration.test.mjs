// End-to-end: `vault serve` on loopback behind a cuttable TCP proxy, two clones (a, b) made by
// `vault clone`, and in-process daemon ticks on an injected clock — the design 2.7 scenario
// table, the Studio write places, the four alarms, blob get/evict and conflict handling.
// Real daemon processes cover kill -9 and the push killed mid LFS upload.
// Needs git >= 2.38, git-lfs, Node 22. See docs/sync.md.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { blobGet, syncStateDir } from "kuma-vault";
import {
  MiB, TOKEN, VAULT_BIN, createWorld, fixtureAttributes, fixtureGitignore, removeWorld, sha256, startProxy, startServe,
} from "../../scripts/test/sync-harness.mjs";
import { parseLfsPointer } from "../server/lfs-paths.mjs";
import { blobEvict } from "./blob.mjs";
import { repairCredential } from "./clone.mjs";
import { readConflicts } from "./conflicts.mjs";
import { loadContext } from "./context.mjs";
import { createMemory, runTick } from "./daemon.mjs";
import { createRemoteApi } from "./remote-api.mjs";

const SYNC_CLI = join(dirname(fileURLToPath(import.meta.url)), "sync-cli.mjs");
const TREE_REJECT = ["work/frames/**"]; // tree-relative, as vault.config.json carries it
const SERVER_REJECT = ["vault/work/frames/**"]; // repo-relative, as server rule 7 reads it
const MIN = 60_000;
const QUIET = 130_000;

let world;
let serve;
let proxy;
let url;
let a;
let b;

function writeAt(dir, rel, data) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}

function setMtime(abs, ms) {
  utimesSync(abs, new Date(ms), new Date(ms));
}

function client(name) {
  const dir = join(world.root, name);
  const env = { ...process.env, ...world.env, KUMA_VAULT_SYNC_DIR: join(world.root, `state-${name}`) };
  world.sh(VAULT_BIN, ["clone", url, dir, "--token-file", join(world.root, "token")], { extraEnv: env });
  world.git(dir, ["config", "kuma-vault.host", name]);
  const c = {
    name,
    dir,
    env,
    mem: null,
    async ctx() {
      return loadContext(dir, { env });
    },
    async tick({ advance = 0, force = false, now } = {}) {
      const ctx = await c.ctx();
      if (!c.mem) c.mem = createMemory(ctx);
      return runTick(ctx, c.mem, { now: now ?? Date.now() + advance, force });
    },
    write: (rel, data) => writeAt(dir, rel, data),
    read: (rel) => readFileSync(join(dir, rel)),
    git: (args, opts) => world.git(dir, args, opts),
    head: () => world.git(dir, ["rev-parse", "HEAD"]).stdout.trim(),
    /** An agent's commit: regenerate the indexes the gate checks (as the gate tells it to), stage, commit. */
    commit(paths, message, { allowFail = false } = {}) {
      world.sh(VAULT_BIN, ["sync", "--no-fts", "--root", join(dir, "vault")], { allowFail });
      if (paths.length) world.git(dir, ["add", "-A", "--", ...paths], { allowFail });
      world.git(dir, ["add", "-A", "--", ":(glob)vault/**/README.md", "vault/README.md"], { allowFail });
      const out = world.git(dir, ["commit", "--quiet", "-m", message], { allowFail });
      return out.code === 0 ? c.head() : null;
    },
    tracked: (rel) => world.git(dir, ["ls-files", "--error-unmatch", "--", rel], { allowFail: true }).code === 0,
    cli: (args, opts = {}) => world.sh(VAULT_BIN, args, { cwd: dir, extraEnv: env, allowFail: true, ...opts }),
    statusFile: () => JSON.parse(readFileSync(join(env.KUMA_VAULT_SYNC_DIR, "s.json"), "utf8")),
  };
  return c;
}

function serverPointer(rel, rev = "main") {
  const shown = serve.show(rev, rel);
  if (shown.code !== 0) return null;
  return parseLfsPointer(Buffer.from(shown.stdout));
}

beforeAll(async () => {
  world = createWorld();
  serve = await startServe(world, { reject: SERVER_REJECT });
  proxy = await startProxy(serve.port);
  url = `http://127.0.0.1:${proxy.port}/v1/stores/s.git`;

  // seed: the fixture tree, synced and pushed with plain git
  const seedDir = join(world.root, "seed");
  world.sh(VAULT_BIN, ["clone", url, seedDir, "--token-file", join(world.root, "token"), "--no-hook"]);
  writeAt(seedDir, ".gitattributes", fixtureAttributes("vault"));
  writeAt(seedDir, ".gitignore", fixtureGitignore({ tree: "vault", reject: TREE_REJECT }));
  writeAt(seedDir, "README.md", "# sync fixture\n");
  writeAt(seedDir, "vault/vault.config.json", `${JSON.stringify({ profile: "kuma-vault", binaries: { reject: TREE_REJECT } }, null, 2)}\n`);
  writeAt(seedDir, "vault/README.md", "# Vault\n");
  writeAt(seedDir, "vault/domains/notes/seed.md", "---\ntitle: Seed\ndescription: seed note\n---\n\n# Seed\n");
  writeAt(seedDir, "vault/domains/notes/shared.md", "# shared\n\nbase\n");
  writeAt(seedDir, "vault/domains/notes/dm.md", "# delete or modify\n");
  writeAt(seedDir, "vault/dispatch-log.md", "# dispatch log\n\n- seed\n");
  writeAt(seedDir, "vault/plans/p/x.graph.json", '{"v":0}\n');
  writeAt(seedDir, "vault/img/p1.png", randomBytes(150 * 1024));
  writeAt(seedDir, "vault/img/p2.png", randomBytes(150 * 1024));
  world.sh(VAULT_BIN, ["sync", "--no-fts", "--root", join(seedDir, "vault")]);
  world.git(seedDir, ["add", "-A"]);
  world.git(seedDir, ["commit", "--quiet", "-m", "fixture"]);
  world.git(seedDir, ["push", "--quiet", "origin", "HEAD:main"]);

  a = client("a");
  b = client("b");
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  await serve?.stop();
  removeWorld(world);
});

describe.sequential("vault clone + vault blob", { timeout: 120_000 }, () => {
  it("clones partially with LFS pointers, the replace refspec, the token helper and both hooks", () => {
    const cfg = (key) => a.git(["config", "--get-all", key], { allowFail: true }).stdout.trim();
    expect(cfg("remote.origin.partialclonefilter")).toMatch(/^blob:limit=(1m|1048576)$/); // git stores 1m as bytes
    expect(cfg("remote.origin.promisor")).toBe("true");
    expect(cfg("lfs.fetchexclude")).toBe("*");
    expect(cfg(`lfs.${url}/info/lfs.locksverify`)).toBe("false");
    expect(cfg("index.skipHash")).toBe("false");
    expect(cfg("remote.origin.fetch").split("\n")).toContain("+refs/replace/*:refs/replace/*");
    expect(cfg("kuma-vault.tree")).toBe("vault");
    expect(cfg(`credential.http://127.0.0.1:${proxy.port}.helper`)).toMatch(/kuma-vault\/token/);
    expect(statSync(join(a.dir, ".git/kuma-vault/token")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(a.dir, ".git/hooks/pre-commit"), "utf8")).toMatch(/kuma-vault-sync-hook/);
    expect(readFileSync(join(a.dir, ".git/hooks/pre-push"), "utf8")).toMatch(/git lfs pre-push/);
    // checked out as pointers
    expect(parseLfsPointer(a.read("vault/img/p1.png"))).not.toBeNull();
    expect(parseLfsPointer(a.read("vault/img/p2.png"))).not.toBeNull();
  });

  it("blob get fetches only the named path under lfs.fetchexclude=* (and -I alone fetches nothing)", () => {
    const seedBytes = readFileSync(join(world.root, "seed", "vault/img/p1.png"));
    const plain = a.git(["lfs", "pull", "-I", "vault/img/p1.png"], { allowFail: true });
    expect(plain.code).toBe(0);
    expect(parseLfsPointer(a.read("vault/img/p1.png"))).not.toBeNull(); // the trap -X "" avoids

    const got = a.cli(["blob", "get", "vault/img/p1.png"]);
    expect(got.code, got.stderr).toBe(0);
    expect(sha256(a.read("vault/img/p1.png"))).toBe(sha256(seedBytes));
    expect(parseLfsPointer(a.read("vault/img/p2.png"))).not.toBeNull();
    expect(a.git(["status", "--porcelain"]).stdout).toBe("");
  });

  it("the package API: blobGet fetches from inside the declared tree, paths relative to it, and rejects with the reason", async () => {
    const seedBytes = readFileSync(join(world.root, "seed", "vault/img/p2.png"));
    const tree = join(a.dir, "vault");
    expect(parseLfsPointer(a.read("vault/img/p2.png"))).toEqual({ oid: sha256(seedBytes), size: seedBytes.length });

    expect(await blobGet({ repo: tree, paths: ["img/p2.png"], env: a.env })).toEqual(["vault/img/p2.png"]);
    expect(sha256(a.read("vault/img/p2.png"))).toBe(sha256(seedBytes));
    expect(a.git(["status", "--porcelain"]).stdout).toBe("");

    await expect(blobGet({ repo: tree, paths: ["README.md"], env: a.env })).rejects.toThrow("vault/README.md is not an LFS file at HEAD");
    await expect(blobGet({ repo: tree, paths: ["../../outside.png"], env: a.env })).rejects.toThrow(/is outside the clone/);
    await expect(blobGet({ repo: tree, paths: [], env: a.env })).rejects.toThrow(/at least one file/);
    await expect(blobGet({ repo: world.root, paths: ["x.png"], env: a.env })).rejects.toThrow(/not inside a git work tree/);
    // the state directory the clone's daemon writes, by the same rule the engine uses
    expect(syncStateDir(a.env)).toBe(join(world.root, "state-a"));
  });
});

describe.sequential("token clone credential", { timeout: 120_000 }, () => {
  // An outer helper stands in for macOS git's `credential.helper=osxkeychain`: under launchd its
  // `store` waits on a keychain prompt. The token clone must never call it, and
  // `vault sync install` (repairCredential) must bring an older clone to the same state.
  it("makes the token file the only helper: an outer helper is never asked to get or store the token", async () => {
    const spyLog = join(world.root, "outer-helper.log");
    const outer = join(world.root, "outer.gitconfig");
    world.sh("git", ["config", "--file", outer, "include.path", join(world.env.HOME, ".gitconfig")]);
    world.sh("git", ["config", "--file", outer, "credential.helper", `!f() { echo "$1" >> '${spyLog}'; cat >/dev/null; }; f`]);
    const env = { GIT_CONFIG_GLOBAL: outer, KUMA_VAULT_SYNC_DIR: join(world.root, "state-k") };
    const dir = join(world.root, "k");
    world.sh(VAULT_BIN, ["clone", url, dir, "--token-file", join(world.root, "token")], { extraEnv: env });
    const key = `credential.http://127.0.0.1:${proxy.port}.helper`;
    const helpers = () => world.git(dir, ["config", "--local", "--get-all", key]).stdout.split("\n").slice(0, -1);
    expect(helpers()).toEqual(["", expect.stringMatching(/kuma-vault\/token'/)]);
    const fileHelper = helpers()[1];

    world.git(dir, ["fetch", "--quiet", "origin"], { extraEnv: env });
    expect(world.sh(VAULT_BIN, ["blob", "get", "vault/img/p2.png"], { cwd: dir, extraEnv: env, allowFail: true }).code).toBe(0);
    expect(world.git(dir, ["credential", "fill"], { input: `url=${url}\n\n`, extraEnv: env }).stdout).toContain(`password=${TOKEN}\n`);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = outer; // the daemon's own lookup reads process.env
    try {
      expect(await createRemoteApi({ repo: dir, remoteUrl: url }).authHeader()).toMatch(/^Basic /);
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
    expect(existsSync(spyLog)).toBe(false);

    // a clone set up before the reset: the file helper alone — the outer helper is asked to store
    world.git(dir, ["config", "--local", "--unset-all", key]);
    world.git(dir, ["config", "--local", key, fileHelper]);
    world.git(dir, ["fetch", "--quiet", "origin"], { extraEnv: env });
    expect(readFileSync(spyLog, "utf8").split("\n")).toEqual(expect.arrayContaining(["get", "store"]));

    expect(await repairCredential(dir)).toEqual([`http://127.0.0.1:${proxy.port}`]);
    expect(helpers()).toEqual(["", fileHelper]);
    expect(await repairCredential(dir)).toEqual([]);
    rmSync(spyLog);
    world.git(dir, ["fetch", "--quiet", "origin"], { extraEnv: env });
    expect(existsSync(spyLog)).toBe(false);
  });
});

describe.sequential("autosave collects what nobody committed", { timeout: 240_000 }, () => {
  it("a recording being appended is not collected; once it stops it goes up as an LFS pointer with images/ and an arbitrary .hwp", async () => {
    const t0 = Date.now();
    const webm = a.write("vault/recordings/x.webm", randomBytes(64 * 1024));
    a.write("vault/images/y.png", randomBytes(80 * 1024));
    a.write("vault/projects/demo/z.hwp", randomBytes(40 * 1024));
    // y.png and z.hwp go quiet; the recording keeps growing for 33 simulated minutes
    for (let k = 0; k <= 3; k += 1) {
      const now = t0 + k * 11 * MIN + QUIET;
      appendFileSync(webm, randomBytes(32 * 1024));
      setMtime(webm, now - 1000);
      await a.tick({ now });
      expect(a.tracked("vault/recordings/x.webm"), `appending, tick ${k}`).toBe(false);
    }
    expect(a.tracked("vault/images/y.png")).toBe(true);
    expect(a.tracked("vault/projects/demo/z.hwp")).toBe(true);
    // stops appending: collected after the quiet window
    const done = await a.tick({ now: t0 + 33 * MIN + 2 * QUIET });
    expect(a.tracked("vault/recordings/x.webm")).toBe(true);
    expect(done.status.ahead).toBe(0);
    for (const rel of ["vault/recordings/x.webm", "vault/images/y.png", "vault/projects/demo/z.hwp"]) {
      const pointer = serverPointer(rel);
      expect(pointer, rel).not.toBeNull();
      expect(serve.casHas(pointer.oid), rel).toBe(true);
      expect(pointer.oid).toBe(sha256(a.read(rel)));
    }
    const subjects = a.git(["log", "--format=%s", "-3"]).stdout;
    expect(subjects).toMatch(/vault-sync: autosave \(a, \d+ files\)/);
  });

  it("text still changing after 10 minutes is saved as it stands", async () => {
    const t0 = Date.now();
    const live = a.write("vault/domains/notes/live.md", "# live\n\n1\n");
    setMtime(live, t0);
    await a.tick({ now: t0 });
    expect(a.tracked("vault/domains/notes/live.md")).toBe(false);
    appendFileSync(live, "2\n");
    setMtime(live, t0 + 11 * MIN);
    await a.tick({ now: t0 + 11 * MIN });
    expect(a.tracked("vault/domains/notes/live.md")).toBe(true);
  });

  it("a new md and pdf in a nav folder go up with their README index lines and the pdf sidecar", async () => {
    a.write("vault/domains/notes/n1.md", "---\ntitle: N1\ndescription: first note\n---\n\n# N1\n");
    a.write("vault/domains/notes/doc.pdf", tinyPdf("hello sidecar"));
    const result = await a.tick({ advance: QUIET });
    expect(result.status.autosaveBlocked).toBeNull();
    expect(result.status.ahead).toBe(0);
    const readme = serve.show("main", "vault/domains/notes/README.md").stdout;
    expect(readme).toMatch(/n1\.md/);
    expect(readme).toMatch(/doc\.pdf/);
    expect(serve.show("main", "vault/domains/notes/doc.pdf.md").code).toBe(0);
    expect(serverPointer("vault/domains/notes/doc.pdf")).not.toBeNull();
    expect(a.git(["status", "--porcelain"]).stdout).toBe("");
    expect(world.sh(VAULT_BIN, ["sync", "--check", "--root", join(a.dir, "vault")], { allowFail: true }).code).toBe(0);
  });

  it("a pdf that arrives as a pointer does not block the other clone's autosave (the sidecar pass reads a pointer's oid)", async () => {
    // A pointer's oid is the sha256 of the content, so the sidecar stamp check needs no bytes:
    // the gate passes and the clone never has to fetch the pdf to commit.
    await b.tick({ force: true }); // receives the pdf (a tick autosaves before it fetches)
    expect(parseLfsPointer(b.read("vault/domains/notes/doc.pdf"))).not.toBeNull();
    b.write("vault/domains/notes/from-b.md", "---\ntitle: From b\ndescription: b note\n---\n\n# From b\n");
    const r = await b.tick({ advance: QUIET, force: true });
    expect(b.tracked("vault/domains/notes/from-b.md")).toBe(true);
    expect(r.status).toMatchObject({ state: "ok", ahead: 0, autosaveBlocked: null });
    expect(parseLfsPointer(b.read("vault/domains/notes/doc.pdf"))).not.toBeNull(); // still not fetched
    expect(world.sh(VAULT_BIN, ["sync", "--check", "--root", join(b.dir, "vault")], { allowFail: true }).code).toBe(0);
  });
});

describe.sequential("alarms", { timeout: 600_000 }, () => {
  it("a png in a binaries.reject place is not committed or pushed and shows as rejectResidue", async () => {
    a.write("vault/work/frames/f001.png", randomBytes(10 * 1024));
    const r1 = await a.tick({ advance: QUIET, force: true });
    expect(a.tracked("vault/work/frames/f001.png")).toBe(false);
    expect(serve.show("main", "vault/work/frames/f001.png").code).not.toBe(0);
    expect(r1.status.alerts.rejectResidue).toMatchObject({ count: 1, active: false });
    const r2 = await a.tick({ advance: 8 * 24 * 60 * MIN, force: true });
    expect(r2.status.alerts.rejectResidue.active).toBe(true);
    rmSync(join(a.dir, "vault/work"), { recursive: true });
  });

  it("a reject place the .gitignore does not cover is still held back (the server would refuse it)", async () => {
    const cfgPath = join(a.dir, "vault/vault.config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.binaries.reject = [...TREE_REJECT, "scratch/**"];
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    a.commit(["vault/vault.config.json"], "reject scratch/");
    a.write("vault/scratch/tmp.png", randomBytes(4096));
    a.write("vault/scratch/notes.md", "# text in a reject place is fine\n");
    const r = await a.tick({ advance: QUIET, force: true });
    expect(a.tracked("vault/scratch/tmp.png")).toBe(false);
    expect(a.tracked("vault/scratch/notes.md")).toBe(true);
    expect(r.status.state).not.toBe("blocked");
    expect(r.status.alerts.rejectResidue.paths.map((p) => p.path)).toContain("vault/scratch/tmp.png");
    rmSync(join(a.dir, "vault/scratch/tmp.png"));
  });

  it("a png ignored by a nested .gitignore raises ignoredOutside (yellow) with the rule", async () => {
    a.write("vault/projects/demo/.gitignore", "out/\n");
    a.write("vault/projects/demo/out/render.png", randomBytes(4096));
    const r = await a.tick({ advance: QUIET, force: true });
    expect(a.tracked("vault/projects/demo/.gitignore")).toBe(true);
    const alarm = r.status.alerts.ignoredOutside;
    expect(alarm).toMatchObject({ lfsExt: 1, active: true, level: "yellow" });
    expect(alarm.paths[0].rule).toMatch(/vault\/projects\/demo\/\.gitignore:1:out\//);
    const status = a.cli(["sync", "status"]);
    expect(status.code).toBe(2);
    rmSync(join(a.dir, "vault/projects/demo/out"), { recursive: true });
    a.git(["rm", "--quiet", "vault/projects/demo/.gitignore"]);
    a.commit([], "drop nested ignore");
    expect((await a.tick({ force: true })).status.alerts.ignoredOutside.count).toBe(0);
  });

  it("a 33 MiB .bin is not committed and becomes uncollected red after 30 min + 1 h", async () => {
    const t0 = Date.now();
    a.write("vault/data/big.bin", randomBytes(33 * MiB));
    const r0 = await a.tick({ now: t0 + QUIET });
    expect(a.tracked("vault/data/big.bin")).toBe(false);
    expect(r0.status.alerts.uncollected.count).toBe(0);
    const r1 = await a.tick({ now: t0 + 31 * MIN });
    expect(r1.status.alerts.uncollected).toMatchObject({ count: 1, active: false, level: "red" });
    expect(r1.status.alerts.uncollected.paths[0]).toMatchObject({ path: "vault/data/big.bin", reason: expect.stringMatching(/큰 일반 파일/) });
    const r2 = await a.tick({ now: t0 + 92 * MIN });
    expect(r2.status.alerts.uncollected.active).toBe(true);
    expect(serve.show("main", "vault/data/big.bin").code).not.toBe(0);
    rmSync(join(a.dir, "vault/data"), { recursive: true });
    const r3 = await a.tick({ now: t0 + 93 * MIN });
    expect(r3.status.alerts.uncollected).toMatchObject({ count: 0, active: false });
  });

  it("500 binaries in one autosave raise growth (yellow) naming the directory", async () => {
    for (let i = 0; i < 500; i += 1) a.write(`vault/media/burst/f${String(i).padStart(3, "0")}.png`, randomBytes(64));
    const r = await a.tick({ advance: QUIET });
    expect(r.status.alerts.growth).toMatchObject({ active: true, level: "yellow", topDir: "media/burst" });
    expect(r.status.alerts.growth.files).toBeGreaterThanOrEqual(500);
    expect(r.status.ahead).toBe(0);
  });

  it("a 1 GB autosave raises growth (yellow) and still goes up", async () => {
    const abs = join(a.dir, "vault/media/huge.mp4");
    mkdirSync(dirname(abs), { recursive: true });
    const fd = openSync(abs, "w");
    const block = randomBytes(MiB);
    for (let i = 0; i < 960; i += 1) writeSync(fd, block); // 1.007 GB, incompressible
    closeSync(fd);
    const r = await a.tick({ advance: QUIET });
    expect(r.status.alerts.growth.active).toBe(true);
    expect(r.status.alerts.growth.bytes).toBeGreaterThanOrEqual(1e9);
    expect(r.status.alerts.growth.label).toMatch(/큰 자동 저장: media/);
    expect(serverPointer("vault/media/huge.mp4")).not.toBeNull();
    // the alarm stays while the burst is inside the 24 h window, then clears
    const later = await a.tick({ advance: 25 * 60 * MIN });
    expect(later.status.alerts.growth).toBeNull();
  });

  it("binaries trickling in under the per-tick sizes raise growth within a day, and it clears a day later", async () => {
    const base = Date.now() + 2 * 24 * 60 * MIN; // past the window of the bursts above
    let r;
    let k = 0;
    for (; k < 30; k += 1) {
      for (let i = 0; i < 21; i += 1) a.write(`vault/media/trickle/t${k}-${i}.png`, randomBytes(64));
      r = await a.tick({ now: base + k * 20 * MIN });
      expect(r.status.ahead).toBe(0);
      if (r.status.alerts.growth) break;
      expect(21 * (k + 1)).toBeLessThan(500); // no alarm before the sum reaches 500
    }
    expect(21 * (k + 1)).toBeGreaterThanOrEqual(500);
    expect(k * 20 * MIN).toBeLessThan(24 * 60 * MIN);
    expect(r.status.alerts.growth).toMatchObject({ active: true, topDir: "media/trickle", files: 21 * (k + 1) });
    expect(r.status.alerts.growth.label).toMatch(/큰 자동 저장: media\/trickle .*24시간 합/);
    expect(a.statusFile().growthWindow.length).toBeGreaterThan(0); // survives a restart with the state file
    const later = await a.tick({ now: base + k * 20 * MIN + 25 * 60 * MIN });
    expect(later.status.alerts.growth).toBeNull();
  });
});

describe.sequential("drift scenarios (design 2.7)", { timeout: 300_000 }, () => {
  it("offline: commits keep landing locally, the daemon backs off, and everything goes up when the link returns", async () => {
    await proxy.cut();
    a.write("vault/domains/notes/off1.md", "# offline 1\n");
    a.commit(["vault/domains/notes/off1.md"], "agent commit while offline");
    const r1 = await a.tick({ advance: 0, force: true });
    expect(r1.status.state).toBe("offline");
    expect(r1.status.ahead).toBe(1);
    expect(r1.status.backoffUntil).not.toBeNull();
    // a mac off for days: still nothing lost, autosave keeps working without the network
    a.write("vault/domains/notes/off2.md", "# offline 2\n");
    const r2 = await a.tick({ advance: 3 * 24 * 60 * MIN });
    expect(a.tracked("vault/domains/notes/off2.md")).toBe(true);
    expect(r2.status.ahead).toBe(2);
    expect(["offline", "syncing"]).toContain(r2.status.state);
    await proxy.restore();
    const r3 = await a.tick({ force: true });
    expect(r3.status).toMatchObject({ state: "ok", ahead: 0 });
    expect(serve.head()).toBe(a.head());
  });

  it("server down and back: offline, then pushed", async () => {
    await serve.stop();
    a.write("vault/domains/notes/down.md", "# server down\n");
    a.commit(["vault/domains/notes/down.md"], "while the server is down");
    const r1 = await a.tick({ force: true });
    expect(r1.status.state).toBe("offline");
    await serve.restart();
    const r2 = await a.tick({ force: true });
    expect(r2.status.ahead).toBe(0);
    expect(serve.head()).toBe(a.head());
  });

  it("same file written on both sides: the server's version keeps the path, the late one is kept under _sync-conflicts", async () => {
    await b.tick({ force: true });
    a.write("vault/domains/notes/shared.md", "# shared\n\nfrom a\n");
    a.commit(["vault/domains/notes/shared.md"], "a edits shared");
    b.write("vault/domains/notes/shared.md", "# shared\n\nfrom b\n");
    const bLocal = b.commit(["vault/domains/notes/shared.md"], "b edits shared");
    await a.tick({ force: true });
    const rb = await b.tick({ force: true });
    expect(rb.status.ahead).toBe(0);
    expect(rb.status.state).toBe("conflict");
    expect(rb.status.openConflicts).toBe(1);
    expect(b.git(["merge-base", "--is-ancestor", bLocal, "HEAD"], { allowFail: true }).code).toBe(0); // b's commit kept, not rebased
    expect(b.git(["log", "--merges", "--format=%s", "-1"]).stdout).toMatch(/vault-sync: merge b/);
    expect(b.read("vault/domains/notes/shared.md").toString()).toMatch(/from a/);
    const [conflict] = readConflicts(await b.ctx()).filter((c) => c.status === "open");
    expect(conflict).toMatchObject({ path: "vault/domains/notes/shared.md", class: "general", kept: "remote", host: "b" });
    expect(conflict.copy).toMatch(/^vault\/_sync-conflicts\/\d{8}-\d{6}-b\/vault\/domains\/notes\/shared\.md$/);
    expect(b.read(conflict.copy).toString()).toMatch(/from b/);
    expect(serve.show("main", conflict.copy).stdout).toMatch(/from b/);
    expect(serve.show("main", "vault/domains/notes/shared.md").stdout).toMatch(/from a/);

    // a person picks the local version
    const resolved = b.cli(["sync", "resolve", conflict.id, "--take", "local"]);
    expect(resolved.code, resolved.stderr).toBe(0);
    const rb2 = await b.tick({ force: true });
    expect(rb2.status).toMatchObject({ openConflicts: 0, ahead: 0 });
    const ra = await a.tick({ force: true });
    expect(ra.status.openConflicts).toBe(0);
    expect(a.read("vault/domains/notes/shared.md").toString()).toMatch(/from b/);
    expect(existsSync(join(a.dir, conflict.copy))).toBe(false);
  });

  it("append-only ledgers merge both sides without a conflict (merge=union)", async () => {
    appendFileSync(join(a.dir, "vault/dispatch-log.md"), "- from a\n");
    a.commit(["vault/dispatch-log.md"], "a appends");
    appendFileSync(join(b.dir, "vault/dispatch-log.md"), "- from b\n");
    b.commit(["vault/dispatch-log.md"], "b appends");
    await a.tick({ force: true });
    const rb = await b.tick({ force: true });
    expect(rb.status.openConflicts).toBe(0);
    const log = serve.show("main", "vault/dispatch-log.md").stdout;
    expect(log).toMatch(/- from a/);
    expect(log).toMatch(/- from b/);
  });

  it("a derived plan graph takes the server's version; delete vs modify keeps the modification", async () => {
    a.write("vault/plans/p/x.graph.json", '{"v":"a"}\n');
    a.git(["rm", "--quiet", "vault/domains/notes/dm.md"]);
    a.commit(["vault/plans/p/x.graph.json"], "a regenerates the graph and deletes dm");
    b.write("vault/plans/p/x.graph.json", '{"v":"b"}\n');
    b.write("vault/domains/notes/dm.md", "# delete or modify\n\nb changed it\n");
    b.commit(["vault/plans/p/x.graph.json", "vault/domains/notes/dm.md"], "b touches graph and dm");
    await a.tick({ force: true });
    await b.tick({ force: true });
    expect(serve.show("main", "vault/plans/p/x.graph.json").stdout).toBe('{"v":"a"}\n');
    expect(serve.show("main", "vault/domains/notes/dm.md").stdout).toMatch(/b changed it/);
    const rows = readConflicts(await b.ctx());
    expect(rows.find((c) => c.path === "vault/plans/p/x.graph.json")).toMatchObject({ class: "derived", status: "resolved" });
    const dm = rows.find((c) => c.path === "vault/domains/notes/dm.md");
    expect(dm).toMatchObject({ class: "delete-modify", kept: "local", status: "open" });
    expect(b.cli(["sync", "resolve", dm.id, "--take", "local"]).code).toBe(0);
    await b.tick({ force: true });
    await a.tick({ force: true });
  });

  it("a file being written when the server's change arrives is not overwritten; it is merged once quiet", async () => {
    a.write("vault/domains/notes/seed.md", "---\ntitle: Seed\ndescription: seed note\n---\n\n# Seed\n\nserver side\n");
    a.commit(["vault/domains/notes/seed.md"], "a changes seed");
    await a.tick({ force: true });
    const t0 = Date.now();
    const mine = b.write("vault/domains/notes/seed.md", "---\ntitle: Seed\ndescription: seed note\n---\n\n# Seed\n\nb is typing\n");
    setMtime(mine, t0);
    const r1 = await b.tick({ now: t0, force: true });
    expect(r1.status.lastError).toMatch(/통합 대기/);
    expect(b.read("vault/domains/notes/seed.md").toString()).toMatch(/b is typing/);
    const r2 = await b.tick({ now: t0 + QUIET, force: true });
    expect(r2.status.ahead).toBe(0);
    const open = readConflicts(await b.ctx()).filter((c) => c.status === "open" && c.path === "vault/domains/notes/seed.md");
    expect(open).toHaveLength(1);
    expect(serve.show("main", "vault/domains/notes/seed.md").stdout).toMatch(/server side/);
    expect(serve.show("main", open[0].copy).stdout).toMatch(/b is typing/);
    expect(b.cli(["sync", "resolve", open[0].id, "--take", "remote"]).code).toBe(0);
    await b.tick({ force: true });
    await a.tick({ force: true });
  });

  it("a push the server refuses blocks with the server's reason and is never skipped", async () => {
    b.write("vault/domains/notes/bad.tmp", "lock-ish\n");
    b.git(["add", "-f", "vault/domains/notes/bad.tmp"]);
    b.git(["commit", "--quiet", "-m", "agent commits a temp file"]);
    const r1 = await b.tick({ force: true });
    expect(r1.status.state).toBe("blocked");
    expect(r1.status.lastError).toMatch(/규칙 6/);
    expect(r1.status.ahead).toBeGreaterThanOrEqual(1);
    const r2 = await b.tick({ force: true });
    expect(r2.status).toMatchObject({ state: "blocked", ahead: r1.status.ahead });
    expect(b.cli(["sync", "status"]).code).toBe(2);
    b.git(["rm", "--quiet", "--cached", "vault/domains/notes/bad.tmp"]);
    b.git(["commit", "--quiet", "-m", "drop the temp file"]);
    // the bad commit is still in history: the server checks every commit, so it stays refused
    const r3 = await b.tick({ force: true });
    expect(r3.status.state).toBe("blocked");
    // the fix that goes through: rewrite the unpushed commits (what a person does after reading the reason)
    const base = b.git(["rev-parse", "refs/remotes/origin/main"]).stdout.trim();
    b.git(["reset", "--soft", base]);
    if (b.git(["diff", "--cached", "--quiet"], { allowFail: true }).code !== 0) b.git(["commit", "--quiet", "-m", "without the temp file"]);
    const r4 = await b.tick({ force: true });
    expect(r4.status).toMatchObject({ state: "ok", ahead: 0 });
    expect(serve.show("main", "vault/domains/notes/bad.tmp").code).not.toBe(0);
    rmSync(join(b.dir, "vault/domains/notes/bad.tmp"));
  });

  it("pause stops the daemon's work, resume brings it back", async () => {
    expect(a.cli(["sync", "pause"]).code).toBe(0);
    a.write("vault/domains/notes/paused.md", "# paused\n");
    const r1 = await a.tick({ advance: QUIET, force: true });
    expect(r1.status.state).toBe("paused");
    expect(a.tracked("vault/domains/notes/paused.md")).toBe(false);
    expect(a.cli(["sync", "resume"]).code).toBe(0);
    const r2 = await a.tick({ advance: QUIET, force: true });
    expect(a.tracked("vault/domains/notes/paused.md")).toBe(true);
    expect(r2.status.ahead).toBe(0);
  });
});

describe.sequential("blob evict", { timeout: 120_000 }, () => {
  it("keeps the cached copy until a server backup covers it, then turns it back into a pointer", async () => {
    const ctx = await a.ctx();
    const api = createRemoteApi(ctx);
    const rel = "vault/images/y.png";
    const bytes = a.read(rel);
    expect(parseLfsPointer(bytes)).toBeNull();
    writeFileSync(serve.paths.backupStatus, JSON.stringify({ lastBackupAt: new Date(Date.now() - 3600_000).toISOString() }));
    const first = await blobEvict(ctx, api, { paths: [rel], cwd: a.dir });
    expect(first.evicted).toHaveLength(0);
    expect(first.skipped[0].reason).toMatch(/백업/);
    await new Promise((r) => setTimeout(r, 1100));
    writeFileSync(serve.paths.backupStatus, JSON.stringify({ lastBackupAt: new Date().toISOString() }));
    const second = await blobEvict(ctx, api, { paths: [rel], cwd: a.dir });
    expect(second.evicted).toHaveLength(1);
    expect(parseLfsPointer(a.read(rel))).toMatchObject({ oid: sha256(bytes) });
    expect(a.git(["status", "--porcelain"]).stdout).toBe("");
    expect(a.cli(["blob", "get", rel]).code).toBe(0);
    expect(sha256(a.read(rel))).toBe(sha256(bytes));
  });
});

// --- real daemon processes ---

function startDaemon(c, logName) {
  const log = openSync(join(world.root, `${logName}.log`), "a");
  const child = spawn(process.execPath, [SYNC_CLI, "syncd", "--repo", c.dir], { env: c.env, detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  return child;
}

function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function waitFor(predicate, { timeoutMs = 60_000, stepMs = 100 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe.sequential("daemon processes", { timeout: 600_000 }, () => {
  it("kill -9 at random moments loses nothing: every file written ends up on the server", async () => {
    a.git(["config", "kuma-vault.quietseconds", "1"]);
    a.git(["config", "kuma-vault.stalelockseconds", "3"]);
    a.git(["config", "kuma-vault.timerseconds", "2"]);
    const written = new Map();
    for (let round = 0; round < 6; round += 1) {
      const daemon = startDaemon(a, "kill9");
      for (let i = 0; i < 8; i += 1) {
        const rel = `vault/domains/k9/r${round}-${i}.md`;
        const body = `# r${round} ${i}\n${randomBytes(8).toString("hex")}\n`;
        a.write(rel, body);
        written.set(rel, body);
        if (i % 3 === 0) a.commit([rel], `agent ${round}/${i}`, { allowFail: true }); // may race the daemon's lock
        await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 400)));
      }
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 2500)));
      killGroup(daemon);
    }
    const daemon = startDaemon(a, "kill9");
    try {
      await waitFor(
        () => {
          const head = serve.head();
          if (!head || head !== a.head()) return false;
          return [...written].every(([rel, body]) => serve.show(head, rel).stdout === body);
        },
        { timeoutMs: 120_000, stepMs: 500 },
      );
    } finally {
      killGroup(daemon);
    }
    expect(a.git(["fsck", "--no-dangling", "--connectivity-only"], { allowFail: true }).code).toBe(0);
    const log = readFileSync(join(world.root, "kill9.log"), "utf8");
    expect(log).toMatch(/"event":"start"/);
  });

  it("a push killed in the middle of its LFS upload moves no ref; the next daemon finishes it", async () => {
    a.git(["config", "kuma-vault.quietseconds", "1"]);
    const before = serve.head();
    const blob = randomBytes(24 * MiB);
    a.write("vault/media/slow.mov", blob);
    await proxy.setThrottle(1 * MiB);
    const daemon = startDaemon(a, "pushkill");
    await waitFor(() => readdirSync(serve.paths.lfsIncoming).length > 0, { timeoutMs: 60_000, stepMs: 50 });
    killGroup(daemon);
    await proxy.setThrottle(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(serve.head()).toBe(before);
    expect(serve.casHas(sha256(blob))).toBe(false);
    const again = startDaemon(a, "pushkill");
    try {
      await waitFor(() => serve.head() === a.head() && serve.head() !== before, { timeoutMs: 120_000, stepMs: 200 });
    } finally {
      killGroup(again);
    }
    expect(serve.casHas(sha256(blob))).toBe(true);
    expect(serverPointer("vault/media/slow.mov")).toMatchObject({ oid: sha256(blob) });
  });

  it("a git lock left by a killed git is removed once old with no git running; a fresh one is respected", async () => {
    const ctx = await a.ctx();
    const lock = join(ctx.gitDir, "index.lock");
    writeFileSync(lock, "");
    const fresh = await a.tick({ force: true });
    expect(existsSync(lock)).toBe(true);
    expect(fresh.status).toBeDefined();
    setMtime(lock, Date.now() - 10 * MIN);
    await a.tick({ force: true });
    expect(existsSync(lock)).toBe(false);
  });

  it("only one daemon per clone", async () => {
    const first = startDaemon(a, "single");
    try {
      await waitFor(() => {
        try {
          return JSON.parse(readFileSync(join(a.dir, ".git/vault-syncd.lock"), "utf8")).pid === first.pid;
        } catch {
          return false;
        }
      });
      const second = a.cli(["syncd", "--repo", a.dir], { allowFail: true, timeout: 20_000 });
      expect(second.code).toBe(1);
      expect(second.stderr).toMatch(/another sync daemon holds/);
    } finally {
      killGroup(first);
    }
  });
});

function tinyPdf(text) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const content = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

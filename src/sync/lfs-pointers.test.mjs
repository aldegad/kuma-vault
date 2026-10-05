// lfs-pointers.mjs against git-lfs's own answer, and the kept map against a fresh computation:
// the map follows HEAD's tree (commits, a reset back, a cache of an unknown tree, a broken file),
// never the index, and never fetches a blob a partial clone left on the server.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderLfsPointer } from "../server/lfs-paths.mjs";
import { blobEvict } from "./blob.mjs";
import { gitBin } from "./git.mjs";
import { isHydrated, lfsPointers, lfsPointersCachePath, lfsPointersOf, treeOf } from "./lfs-pointers.mjs";

let root;
let repo;
let env;

function run(cwd, args, { input, allowFail = false } = {}) {
  const r = spawnSync(gitBin(), args, { cwd, env, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r;
}
const git = (...args) => run(repo, args).stdout.trim();
const hasLfs = spawnSync("git", ["lfs", "version"]).status === 0;

function write(rel, data) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}

/** A pointer committed as is (no filter): the work tree keeps the pointer unless `hydrate`. */
function pointer(rel, { hydrate = false, bytes = randomBytes(300 + Math.floor(Math.random() * 500)) } = {}) {
  const oid = createHash("sha256").update(bytes).digest("hex");
  write(rel, renderLfsPointer(oid, bytes.length));
  git("add", "--", rel);
  if (hydrate) write(rel, bytes);
  return { oid, size: bytes.length, bytes };
}

function commit(message) {
  git("commit", "-qm", message);
}

const ctx = () => ({ repo, privateDir: join(repo, ".git", "kuma-vault") });

/**
 * `git lfs ls-files -l` of HEAD as Map path -> { oid, hydrated }. git-lfs also takes a pointer
 * with CRLF line ends; the engine's pointer is the canonical one (parseLfsPointer), so the
 * non-canonical fixture is left out of the comparison and asserted apart.
 */
function lfsLsFiles() {
  const out = run(repo, ["lfs", "ls-files", "-l"]).stdout;
  const map = new Map();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{64}) ([*-]) (.*)$/.exec(line);
    if (m && m[3] !== "vault/notes/pointer-like.md") map.set(m[3], { oid: m[1], hydrated: m[2] === "*" });
  }
  return map;
}

/** Whether the object is here — without the lazy fetch `cat-file -e` would do in a partial clone. */
function present(oid) {
  return run(repo, ["cat-file", "--batch-check=%(objectname)", "--batch-all-objects"]).stdout.split("\n").includes(oid);
}

function ours(files) {
  return new Map([...files].map(([path, info]) => [path, { oid: info.oid, hydrated: isHydrated(ctx(), path, info.size) }]));
}

beforeEach(() => {
  root = mkdtempSync(join(process.env.KV_SYNC_TMP ?? tmpdir(), "kv-lfsptr-"));
  repo = join(root, "clone");
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "absent-config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].includes(key)) delete env[key];
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "feature.manyFiles", "true");
  git("config", "index.skipHash", "false");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function seed() {
  pointer("vault/img/a.png");
  pointer("vault/img/b.png", { hydrate: true });
  const shared = pointer("vault/img/same-1.png");
  pointer("vault/img/same-2.png", { bytes: shared.bytes }); // one object, two paths
  pointer("vault/odd name [1]*?.png");
  pointer("vault/run.bin");
  git("update-index", "--chmod=+x", "vault/run.bin");
  write("vault/notes/plain.md", "# a note\n");
  write("vault/notes/pointer-like.md", renderLfsPointer("a".repeat(64), 12).replace("\n", "\r\n")); // CRLF: not canonical
  write("vault/notes/big.txt", "x".repeat(4096));
  write("vault/notes/small.bin", Buffer.from([0, 1, 2, 3]));
  git("add", "-A", "--", "vault/notes");
  spawnSync("ln", ["-s", "img/a.png", join(repo, "vault", "link.png")]);
  git("add", "--", "vault/link.png");
  commit("seed");
}

describe("the pointer map", () => {
  it.skipIf(!hasLfs)("is what git lfs ls-files -l says, oid and hydrated, path for path", async () => {
    seed();
    const { files, tree } = await lfsPointers(ctx());
    expect(tree).toBe(git("rev-parse", "HEAD^{tree}"));
    expect(ours(files)).toEqual(lfsLsFiles());
    expect(files.has("vault/notes/pointer-like.md")).toBe(false);
    expect(files.has("vault/link.png")).toBe(false);
  });

  it("an unborn branch has no LFS files and keeps nothing", async () => {
    expect(await treeOf(ctx())).toBeNull();
    expect((await lfsPointers(ctx())).files.size).toBe(0);
    expect(await lfsPointersOf(ctx(), ["vault/img/a.png"])).toEqual(new Map());
  });

  it("keeps the map under the tree id and answers the same tree from it without recomputing", async () => {
    seed();
    const first = await lfsPointers(ctx());
    const kept = JSON.parse(readFileSync(lfsPointersCachePath(ctx()), "utf8"));
    expect(kept.tree).toBe(first.tree);
    // a doctored entry under the same tree id comes back as is: the kept map was read, not recomputed
    kept.files = kept.files.map((row) => (row[0] === "vault/img/a.png" ? [row[0], "f".repeat(64), 1] : row));
    writeFileSync(lfsPointersCachePath(ctx()), JSON.stringify(kept));
    expect((await lfsPointers(ctx())).files.get("vault/img/a.png")).toEqual({ oid: "f".repeat(64), size: 1 });
  });

  it("concurrent calls for one tree share one computation", async () => {
    seed();
    const [x, y] = await Promise.all([lfsPointers(ctx()), lfsPointers(ctx())]);
    expect(x).toBe(y);
  });

  it.skipIf(!hasLfs)("follows every kind of commit: add, change, delete, pointer to text, text to pointer, a reset back", async () => {
    seed();
    const before = await lfsPointers(ctx());
    pointer("vault/img/new.png");
    pointer("vault/img/a.png"); // new object at the same path
    git("rm", "-q", "-f", "--", "vault/img/b.png");
    write("vault/img/same-1.png", "now plain text\n");
    git("add", "--", "vault/img/same-1.png");
    pointer("vault/notes/plain.md"); // text became a pointer
    commit("change");
    const after = await lfsPointers(ctx());
    expect(after.tree).not.toBe(before.tree);
    expect(JSON.parse(readFileSync(lfsPointersCachePath(ctx()), "utf8")).tree).toBe(after.tree);
    expect(ours(after.files)).toEqual(lfsLsFiles());
    expect(after.files.has("vault/img/b.png")).toBe(false);
    expect(after.files.has("vault/img/same-1.png")).toBe(false);
    expect(after.files.has("vault/notes/plain.md")).toBe(true);
    expect(after.files.get("vault/img/a.png").oid).not.toBe(before.files.get("vault/img/a.png").oid);

    git("reset", "-q", "--hard", "HEAD~1");
    const back = await lfsPointers(ctx());
    expect(back.tree).toBe(before.tree);
    expect(back.files).toEqual(before.files);
  });

  it("recomputes in full from a kept map of a tree it does not have, and from a broken file", async () => {
    seed();
    const truth = (await lfsPointers(ctx())).files;
    writeFileSync(lfsPointersCachePath(ctx()), JSON.stringify({ version: 1, tree: "0".repeat(40), files: [["ghost.png", "e".repeat(64), 3]] }));
    expect((await lfsPointers(ctx())).files).toEqual(truth);
    writeFileSync(lfsPointersCachePath(ctx()), "{ not json");
    expect((await lfsPointers(ctx())).files).toEqual(truth);
    writeFileSync(lfsPointersCachePath(ctx()), JSON.stringify({ version: 99, tree: git("rev-parse", "HEAD^{tree}"), files: [] }));
    expect((await lfsPointers(ctx())).files).toEqual(truth);
  });

  it("is of HEAD, not the index; hydration is read from the work tree each time", async () => {
    seed();
    const head = await lfsPointers(ctx());
    pointer("vault/img/staged.png"); // staged, not committed
    const now = await lfsPointers(ctx());
    expect(now.files.has("vault/img/staged.png")).toBe(false);
    expect(now.files).toEqual(head.files);
    const a = head.files.get("vault/img/a.png");
    expect(isHydrated(ctx(), "vault/img/a.png", a.size)).toBe(false);
    write("vault/img/a.png", randomBytes(a.size));
    expect(isHydrated(ctx(), "vault/img/a.png", a.size)).toBe(true);
    write("vault/img/a.png", renderLfsPointer(a.oid, a.size));
    expect(isHydrated(ctx(), "vault/img/a.png", a.size)).toBe(false);
    // a pointer whose own text is exactly the object's size is still a pointer
    let size = 1;
    while (renderLfsPointer("c".repeat(64), size).length !== size) size += 1;
    write("vault/img/self.png", renderLfsPointer("c".repeat(64), size));
    expect(isHydrated(ctx(), "vault/img/self.png", size)).toBe(false);
  });
});

describe("the named paths", () => {
  it("answers only the paths asked, literally (no globbing), and not a directory's contents", async () => {
    seed();
    const all = (await lfsPointers(ctx())).files;
    const got = await lfsPointersOf(ctx(), ["vault/odd name [1]*?.png", "vault/notes/plain.md", "vault/img", "vault/missing.png"]);
    expect([...got.keys()]).toEqual(["vault/odd name [1]*?.png"]);
    expect(got.get("vault/odd name [1]*?.png")).toEqual(all.get("vault/odd name [1]*?.png"));
    expect(await lfsPointersOf(ctx(), ["vault/*.png"])).toEqual(new Map());
  });
});

describe("a partial clone", () => {
  it("never fetches a large blob the clone filter left on the server", async () => {
    seed();
    write("vault/notes/large.txt", "y".repeat(2 * 1024 * 1024));
    git("add", "--", "vault/notes/large.txt");
    commit("large text");
    git("config", "uploadpack.allowFilter", "true");
    const large = git("rev-parse", "HEAD:vault/notes/large.txt");
    const origin = repo;
    repo = join(root, "partial");
    // no checkout: a checkout would fetch HEAD's large blobs; history and sparse trees keep them away
    run(root, ["clone", "-q", "--no-checkout", "--filter=blob:limit=1m", `file://${origin}`, repo]);
    expect(present(large)).toBe(false);
    const files = (await lfsPointers(ctx())).files;
    expect(files.has("vault/img/a.png")).toBe(true);
    expect(files.has("vault/notes/large.txt")).toBe(false);
    expect(present(large)).toBe(false);
    expect(await lfsPointersOf(ctx(), ["vault/notes/large.txt"])).toEqual(new Map());
    expect(present(large)).toBe(false);
  });
});

describe("the daemon's hourly trim", () => {
  it("under the cache limit reads no map, asks no server and writes nothing", async () => {
    seed();
    const api = { serverHas: () => { throw new Error("asked the server"); }, backupStatus: () => { throw new Error("asked the server"); } };
    const result = await blobEvict({ ...ctx(), gitDir: join(repo, ".git"), settings: { lfsCacheMaxBytes: 10 * 1024 ** 3 } }, api, {});
    expect(result).toEqual({ evicted: [], skipped: [], cacheBytes: 0 });
    expect(() => readFileSync(lfsPointersCachePath(ctx()))).toThrow(/ENOENT/);
  });
});

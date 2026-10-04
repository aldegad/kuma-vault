// `vault server store rm` (docs/server.md "Removing a store"): one atomic server.json write
// takes the store, the tokens scoped only to it and its backup.stores entry out; every other
// store and token stays byte for byte. The directory is kept unless --purge --confirm <id>.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseFlags } from "../cli/cli-options.mjs";
import { createServeApp } from "./serve.mjs";
import { commandStore } from "./server-cli.mjs";
import { hashToken, loadServerConfig, writeServerConfig } from "./server-config.mjs";

let root;
let dataDir;
let configPath;
let lines;

const rm = (argv) => commandStore(parseFlags(["rm", ...argv, "--config", configPath]), { log: (line) => lines.push(line) });

function storeDir(id) {
  const dir = join(dataDir, id);
  mkdirSync(join(dir, "origin.git"), { recursive: true });
  writeFileSync(join(dir, "origin.git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kv-store-rm-"));
  dataDir = join(root, "vaults");
  configPath = join(root, "server.json");
  lines = [];
  storeDir("a");
  storeDir("b");
  writeServerConfig(configPath, {
    version: 1,
    listen: ["127.0.0.1:0"],
    dataDir,
    auth: { mode: "token" },
    tokens: [
      { id: "only-a", sha256: hashToken("t1"), role: "writer", stores: ["a"] },
      { id: "a-and-b", sha256: hashToken("t2"), role: "reader", stores: ["a", "b"] },
      { id: "every", sha256: hashToken("t3"), role: "admin", stores: ["*"] },
      { id: "only-b", sha256: hashToken("t4"), role: "writer", stores: ["b"] },
    ],
    stores: { a: { owners: ["alice"] }, b: { owners: ["bob"], binaries: { reject: ["*.mov"] } } },
    backup: { repository: "s3:https://example.invalid/bucket", host: "srv", stores: ["a", "b"] },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("vault server store rm", () => {
  it("removes the store and what was scoped only to it, leaves everything else, keeps the data by default", () => {
    const before = loadServerConfig(configPath);
    rm(["a"]);
    const after = loadServerConfig(configPath);
    expect(Object.keys(after.stores)).toEqual(["b"]);
    expect(after.stores.b).toEqual(before.stores.b);
    expect(after.tokens.map((t) => [t.id, t.stores])).toEqual([["a-and-b", ["b"]], ["every", ["*"]], ["only-b", ["b"]]]);
    expect(after.tokens.find((t) => t.id === "only-b")).toEqual(before.tokens.find((t) => t.id === "only-b"));
    expect(after.tokens.find((t) => t.id === "a-and-b").sha256).toBe(hashToken("t2"));
    expect(after.backup.stores).toEqual(["b"]);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dataDir, "a", "origin.git", "HEAD"))).toBe(true);
    expect(lines.join("\n")).toMatch(/removed token\(s\) scoped only to a: only-a/);
    expect(lines.join("\n")).toMatch(/kept .*vaults\/a/);
  });

  it("refuses an id that is not there and leaves server.json untouched", () => {
    const bytes = readFileSync(configPath);
    expect(() => rm(["nope"])).toThrow(/no store nope/);
    expect(() => commandStore(parseFlags(["rm", "--config", configPath]))).toThrow(/store rm <id>/);
    expect(readFileSync(configPath).equals(bytes)).toBe(true);
  });

  it("deletes the directory only with --purge --confirm <id>", () => {
    const bytes = readFileSync(configPath);
    expect(() => rm(["a", "--purge"])).toThrow(/--confirm a/);
    expect(() => rm(["a", "--purge", "--confirm", "b"])).toThrow(/--confirm a/);
    expect(() => rm(["a", "--purge", "--keep-data", "--confirm", "a"])).toThrow(/exclude each other/);
    expect(readFileSync(configPath).equals(bytes)).toBe(true);
    rm(["a", "--purge", "--confirm", "a"]);
    expect(existsSync(join(dataDir, "a"))).toBe(false);
    expect(existsSync(join(dataDir, "b", "origin.git", "HEAD"))).toBe(true);
    expect(Object.keys(loadServerConfig(configPath).stores)).toEqual(["b"]);
  });

  it("refuses to purge a path outside dataDir or one that is not a store, before changing server.json", () => {
    const outside = join(root, "elsewhere");
    mkdirSync(join(outside, "origin.git"), { recursive: true });
    const config = loadServerConfig(configPath);
    writeServerConfig(configPath, { ...config, stores: { ...config.stores, c: { path: outside }, d: { path: join(dataDir, "d") } } });
    mkdirSync(join(dataDir, "d"));
    const bytes = readFileSync(configPath);
    expect(() => rm(["c", "--purge", "--confirm", "c"])).toThrow(/not inside dataDir/);
    expect(() => rm(["d", "--purge", "--confirm", "d"])).toThrow(/not a store directory/);
    expect(readFileSync(configPath).equals(bytes)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("refuses to purge a directory another store shares — same path, inside it or around it — before changing server.json", () => {
    storeDir("a/nested");
    storeDir("outer");
    storeDir("outer/inner");
    symlinkSync(join(dataDir, "a"), join(root, "a-link"));
    const config = loadServerConfig(configPath);
    writeServerConfig(configPath, {
      ...config,
      stores: {
        ...config.stores,
        alias: { path: join(dataDir, "a") },
        linked: { path: join(root, "a-link") },
        nested: { path: join(dataDir, "a", "nested") },
        outer: {},
        inner: { path: join(dataDir, "outer", "inner") },
      },
    });
    const bytes = readFileSync(configPath);
    let error;
    try {
      rm(["a", "--purge", "--confirm", "a"]);
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toMatch(/shares its directory with store\(s\) that stay: alias .*linked .*nested /);
    expect(() => rm(["inner", "--purge", "--confirm", "inner"])).toThrow(/that stay: outer \(/);
    expect(() => rm(["outer", "--purge", "--confirm", "outer"])).toThrow(/that stay: inner \(/);
    expect(readFileSync(configPath).equals(bytes)).toBe(true);
    for (const dir of ["a", "a/nested", "outer", "outer/inner"]) expect(existsSync(join(dataDir, dir, "origin.git", "HEAD"))).toBe(true);
  });

  it("purges a store whose name only starts like another's (a beside ab)", () => {
    storeDir("ab");
    const config = loadServerConfig(configPath);
    writeServerConfig(configPath, { ...config, stores: { ...config.stores, ab: {} } });
    rm(["a", "--purge", "--confirm", "a"]);
    expect(existsSync(join(dataDir, "a"))).toBe(false);
    expect(existsSync(join(dataDir, "ab", "origin.git", "HEAD"))).toBe(true);
    expect(Object.keys(loadServerConfig(configPath).stores)).toEqual(["b", "ab"]);
  });

  it("purges the data a symlinked store path points to, then the link — never just the link", () => {
    storeDir("c-data");
    storeDir("d-data");
    symlinkSync(join(dataDir, "c-data"), join(root, "c-link")); // a link outside dataDir into it
    symlinkSync(join(dataDir, "d-data"), join(dataDir, "d")); // a link inside dataDir
    const config = loadServerConfig(configPath);
    writeServerConfig(configPath, { ...config, stores: { ...config.stores, c: { path: join(root, "c-link") }, d: { path: join(dataDir, "d") } } });
    const cData = realpathSync(join(dataDir, "c-data"));

    rm(["c", "--purge", "--confirm", "c"]);
    rm(["d", "--purge", "--confirm", "d"]);

    for (const gone of [join(dataDir, "c-data"), join(root, "c-link"), join(dataDir, "d-data"), join(dataDir, "d")]) {
      expect(() => lstatSync(gone), gone).toThrow(/ENOENT/);
    }
    expect(readdirSync(dataDir).sort()).toEqual(["a", "b"]); // no .removed-* left either
    expect(existsSync(join(dataDir, "a", "origin.git", "HEAD"))).toBe(true);
    expect(existsSync(join(dataDir, "b", "origin.git", "HEAD"))).toBe(true);
    expect(Object.keys(loadServerConfig(configPath).stores)).toEqual(["a", "b"]);
    expect(lines.join("\n")).toContain(`deleted ${cData} (the data ${join(root, "c-link")} linked to) and the link ${join(root, "c-link")}`);
  });

  it("deletes the link too when the configured path ends in /", () => {
    storeDir("e-data");
    symlinkSync(join(dataDir, "e-data"), join(root, "e-link"));
    const config = loadServerConfig(configPath);
    writeServerConfig(configPath, { ...config, stores: { ...config.stores, e: { path: `${join(root, "e-link")}/` } } });

    rm(["e", "--purge", "--confirm", "e"]);

    for (const gone of [join(dataDir, "e-data"), join(root, "e-link")]) {
      expect(() => lstatSync(gone), gone).toThrow(/ENOENT/);
    }
    expect(lines.join("\n")).toContain(`and the link ${join(root, "e-link")}/`);
  });

  it("empties backup.stores when it listed only that store, and says so", () => {
    const config = loadServerConfig(configPath);
    writeServerConfig(configPath, { ...config, backup: { ...config.backup, stores: ["a"] } });
    rm(["a"]);
    expect(loadServerConfig(configPath).backup.stores).toEqual([]);
    expect(lines.join("\n")).toMatch(/backups cover no store/);
  });

  it("lists the stores", () => {
    commandStore(parseFlags(["list", "--config", configPath]), { log: (line) => lines.push(line) });
    expect(lines).toEqual([`a\tvault\t${join(dataDir, "a")}`, `b\tvault\t${join(dataDir, "b")}`]);
  });

  it("serve stops listing the store on its next config read, with no request needed", async () => {
    const app = createServeApp({ configPath, log: () => {} });
    expect(Object.keys(app.getConfig().stores)).toEqual(["a", "b"]);
    rm(["a"]);
    await new Promise((r) => setTimeout(r, 1100)); // serve stats server.json at most once a second
    expect(Object.keys(app.getConfig().stores)).toEqual(["b"]);
  });
});

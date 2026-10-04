// `vault server init-store` gives the store's whole tree to the serve user, the same rule as
// install (docs/server.md, Install): a store left to root (0750) is a 404 for serve. As a
// normal user the test hands the tree to its own uid and one of its other groups — the gid is
// what shows the chown reached every path.

import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { commandInitStore } from "./server-cli.mjs";
import { writeServerConfig } from "./server-config.mjs";

const OTHER_GID = process.getgroups?.().find((g) => g !== process.getgid());
const VAULT_BIN = "/opt/kuma-vault/current/bin/vault";

let root;
let configPath;

function walk(path, out = []) {
  out.push(path);
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) walk(join(path, name), out);
  return out;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kv-init-store-"));
  configPath = join(root, "server.json");
  writeServerConfig(configPath, { version: 1, listen: ["127.0.0.1:0"], dataDir: join(root, "stores"), stores: {} });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("vault server init-store", () => {
  it.skipIf(OTHER_GID === undefined)("hands every path of the store to the serve user, and repairs a store owned by someone else", async () => {
    const quiet = process.stdout.write;
    process.stdout.write = () => true;
    try {
      await commandInitStore({ _: ["s"], config: configPath }, { owner: { uid: process.getuid(), gid: process.getgid() }, vaultBin: VAULT_BIN });
      const store = join(root, "stores", "s");
      expect(walk(store).filter((p) => lstatSync(p).gid !== process.getgid())).toEqual([]);
      // a second run, as for a store left to another owner, takes the whole tree over
      await commandInitStore({ _: ["s"], config: configPath }, { owner: { uid: process.getuid(), gid: OTHER_GID }, vaultBin: VAULT_BIN });
      const paths = walk(store);
      expect(paths.length).toBeGreaterThan(10);
      expect(paths.filter((p) => lstatSync(p).gid !== OTHER_GID || lstatSync(p).uid !== process.getuid())).toEqual([]);
      expect(lstatSync(store).mode & 0o777).toBe(0o750);
    } finally {
      process.stdout.write = quiet;
    }
  });

  it.skipIf(process.getuid?.() === 0)("refuses before creating anything when it could not hand the tree over (not root)", async () => {
    await expect(commandInitStore({ _: ["t"], config: configPath }, { owner: { uid: process.getuid() + 1, gid: process.getgid() }, vaultBin: VAULT_BIN }))
      .rejects.toThrow(/run this as root/);
    expect(existsSync(join(root, "stores", "t"))).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf8")).stores.t).toBeUndefined();
  });
});

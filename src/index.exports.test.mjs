// The package barrel carries what a host needs before it writes into a vault tree: the binary
// write verdict, the store registry reader and the sync conflict reader. Imported through the
// package name, as a host imports it, so an export missing from the barrel or the exports map
// fails here rather than in the host.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LFS_POINTER_MAX_BYTES,
  MAX_NON_LFS_BYTES,
  blobGet,
  judgeBinaryWrite,
  loadStoreRegistry,
  parseLfsPointer,
  readTreeSyncConflicts,
  resolveStoreRegistryPath,
  syncStateDir,
} from "kuma-vault";

let dirs = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "kuma-vault-exports-"));
  dirs.push(dir);
  return dir;
}

describe("package barrel — host-facing storage policy", () => {
  it("judgeBinaryWrite and MAX_NON_LFS_BYTES give the gate's verdict", () => {
    expect(MAX_NON_LFS_BYTES).toBe(32 * 1024 * 1024);
    const declaration = { profile: "kuma-vault", binaries: { reject: ["work/**"] } };
    const nul = Buffer.from([0x89, 0x50, 0x00, 0x01]);
    expect(judgeBinaryWrite({ path: "work/frame.png", size: 10, head: nul, declaration })?.rule).toBe("reject");
    expect(judgeBinaryWrite({ path: "big.bin", size: MAX_NON_LFS_BYTES + 1, head: nul, declaration })?.rule).toBe("size");
    expect(judgeBinaryWrite({ path: "assets/frame.png", size: 10, head: nul, declaration })).toBeNull();
    expect(judgeBinaryWrite({ path: "big.bin", size: MAX_NON_LFS_BYTES + 1, head: nul, declaration: { profile: "kuma-vault" } })).toBeNull();
  });

  it("loadStoreRegistry reads a v2 registry at resolveStoreRegistryPath", () => {
    const dir = scratch();
    const root = join(dir, "main", "vault");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "vault.config.json"), JSON.stringify({ id: "main-vault", profile: "kuma-vault" }));
    const registryPath = join(dir, "vault-stores.json");
    writeFileSync(registryPath, JSON.stringify({ version: 2, default: "main-vault", stores: { "main-vault": { root, mode: "local" } } }));
    const env = { KUMA_VAULT_STORES: registryPath, HOME: dir };
    expect(resolveStoreRegistryPath(env)).toBe(registryPath);
    const registry = loadStoreRegistry(env);
    expect(registry.default).toBe("main-vault");
    expect(registry.stores.get("main-vault")).toMatchObject({ status: "ok", rootDir: root, mode: "local" });
  });

  it("readTreeSyncConflicts folds the ledger by id and lists the open ones", () => {
    const repo = scratch();
    mkdirSync(join(repo, ".git"));
    const tree = join(repo, "vault");
    mkdirSync(join(tree, "_sync-conflicts"), { recursive: true });
    const rows = [
      { id: "c-1", path: "vault/plans/x/a.md", status: "open" },
      { id: "c-2", path: "vault/plans/x/b.md", status: "open" },
      { id: "c-1", status: "resolved" },
    ];
    writeFileSync(join(tree, "_sync-conflicts", "conflicts.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const read = readTreeSyncConflicts(tree);
    expect(read.conflicts.map((c) => `${c.id}:${c.status}`)).toEqual(["c-1:resolved", "c-2:open"]);
    expect(read.open.map((c) => c.path)).toEqual(["vault/plans/x/b.md"]);
    expect(readTreeSyncConflicts(join(repo, "vault"), { repoDir: repo }).open).toHaveLength(1);
    const clean = scratch();
    mkdirSync(join(clean, ".git"));
    expect(readTreeSyncConflicts(clean).conflicts).toEqual([]);
  });
});

describe("package barrel — reading a partial clone", () => {
  const oid = "a".repeat(64);
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12345\n`;

  it("parseLfsPointer takes only the canonical three lines git-lfs writes", () => {
    expect(parseLfsPointer(Buffer.from(pointer))).toEqual({ oid, size: 12345 });
    expect(parseLfsPointer(pointer)).toEqual({ oid, size: 12345 });
    expect(LFS_POINTER_MAX_BYTES).toBe(1024);
    for (const bad of [
      pointer.replace(/\n/g, "\r\n"), // CRLF
      `${pointer}extra\n`, // trailing bytes
      pointer.replace("size 12345", "size 012345"), // leading zero
      pointer.replace("spec/v1", "spec/v2"), // another version
      pointer.replace(oid, oid.toUpperCase()), // upper-case oid
      "",
      Buffer.alloc(LFS_POINTER_MAX_BYTES + 1, 0x61),
    ]) {
      expect(parseLfsPointer(bad), JSON.stringify(String(bad).slice(0, 40))).toBeNull();
    }
  });

  it("syncStateDir: KUMA_VAULT_SYNC_DIR, else <HOME>/.kuma-vault/sync", () => {
    expect(syncStateDir({ KUMA_VAULT_SYNC_DIR: "/srv/sync-state", HOME: "/home/u" })).toBe("/srv/sync-state");
    expect(syncStateDir({ HOME: "/home/u" })).toBe(join("/home/u", ".kuma-vault", "sync"));
  });

  it("blobGet refuses before touching git when it is not given a clone and paths", async () => {
    await expect(blobGet({ paths: ["a.png"] })).rejects.toThrow(/repo must be a directory/);
    await expect(blobGet({ repo: scratch(), paths: [] })).rejects.toThrow(/at least one file/);
    await expect(blobGet({ repo: scratch(), paths: ["a.png"] })).rejects.toThrow(/not inside a git work tree/);
  });
});

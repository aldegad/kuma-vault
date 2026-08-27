import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadStoreRegistry, resolveStoreRegistryPath } from "./vault-stores.mjs";

describe("vault store registry", () => {
  const tempRoots = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function scratch() {
    const root = await mkdtemp(join(tmpdir(), "kuma-stores-"));
    tempRoots.push(root);
    return root;
  }

  async function writeTree(root, id) {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "vault.config.json"), JSON.stringify({ id, profile: "kuma-vault" }), "utf8");
    return dir;
  }

  async function writeRegistry(root, stores) {
    const path = join(root, "vault-stores.json");
    await writeFile(path, JSON.stringify({ stores }), "utf8");
    return path;
  }

  it("resolves the default path from KUMA_HOME_DIR and honors KUMA_VAULT_STORES override", () => {
    expect(resolveStoreRegistryPath({ KUMA_HOME_DIR: "/tmp/kh" })).toBe("/tmp/kh/vault-stores.json");
    expect(resolveStoreRegistryPath({ KUMA_VAULT_STORES: "/tmp/custom/reg.json" })).toBe("/tmp/custom/reg.json");
  });

  it("reports absent when no registry file exists", async () => {
    const root = await scratch();
    const registry = loadStoreRegistry({ KUMA_VAULT_STORES: join(root, "nope.json") });
    expect(registry.present).toBe(false);
    expect(registry.invalid).toBeNull();
    expect(registry.stores.size).toBe(0);
  });

  it("resolves a valid store whose tree declares the matching id (status ok)", async () => {
    const root = await scratch();
    const treeDir = await writeTree(root, "kuma-brain");
    const path = await writeRegistry(root, { "kuma-brain": treeDir });
    const registry = loadStoreRegistry({ KUMA_VAULT_STORES: path });
    expect(registry.present).toBe(true);
    expect(registry.invalid).toBeNull();
    expect(registry.stores.get("kuma-brain")).toMatchObject({ status: "ok", rootDir: treeDir });
  });

  it("flags a registered store whose root is missing on this machine", async () => {
    const root = await scratch();
    const path = await writeRegistry(root, { "kuma-brain": join(root, "does-not-exist") });
    const registry = loadStoreRegistry({ KUMA_VAULT_STORES: path });
    expect(registry.stores.get("kuma-brain").status).toBe("root-missing");
  });

  it("flags a registry entry pointing at a tree that declares a different id (consistency)", async () => {
    const root = await scratch();
    const treeDir = await writeTree(root, "acme-ops");
    const path = await writeRegistry(root, { "kuma-brain": treeDir });
    const registry = loadStoreRegistry({ KUMA_VAULT_STORES: path });
    expect(registry.stores.get("kuma-brain")).toMatchObject({ status: "id-mismatch", declaredId: "acme-ops" });
  });

  it("marks a present-but-malformed registry invalid instead of throwing", async () => {
    const root = await scratch();
    const path = join(root, "vault-stores.json");
    await writeFile(path, "{ not json", "utf8");
    const registry = loadStoreRegistry({ KUMA_VAULT_STORES: path });
    expect(registry.present).toBe(true);
    expect(registry.invalid).toMatch(/not valid JSON/u);
  });

  it("rejects a bad shape (missing stores object) as invalid", async () => {
    const root = await scratch();
    const path = join(root, "vault-stores.json");
    await writeFile(path, JSON.stringify({ foo: 1 }), "utf8");
    const registry = loadStoreRegistry({ KUMA_VAULT_STORES: path });
    expect(registry.invalid).toMatch(/"stores"/u);
  });

  it("rejects a non-absolute store path as invalid", async () => {
    const root = await scratch();
    const path = await writeRegistry(root, { "kuma-brain": "relative/path" });
    const registry = loadStoreRegistry({ KUMA_VAULT_STORES: path });
    expect(registry.invalid).toMatch(/absolute/u);
  });
});

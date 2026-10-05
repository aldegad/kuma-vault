import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { formatVaultGetText, getVaultDocuments } from "./vault-get.mjs";

const execFile = promisify(execFileCallback);
const CLI_PATH = resolve(process.cwd(), "src/cli/cli.mjs");
const VAULT_BIN_PATH = resolve(process.cwd(), "bin/vault");

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTree(prefix, files) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  for (const [relativePath, body] of Object.entries(files)) {
    await mkdir(resolve(root, relativePath, ".."), { recursive: true });
    await writeFile(join(root, relativePath), body, "utf8");
  }
  return root;
}

function createVaultFixture() {
  return createTree("vault-get-", {
    "domains/security/README.md": "---\ntitle: Security\n---\n\nVault security baseline checklist.\n",
    "domains/lotus-playbook.md": "---\ntitle: Migration Playbook\n---\n\nLotus rollout notes are tracked here.\n",
    "README.md": "# Vault Topology\n",
  });
}

describe("vault get", () => {
  it("reads a folder as its README and a page with or without .md", async () => {
    const vaultDir = await createVaultFixture();

    const result = await getVaultDocuments({
      vaultDir,
      ids: ["domains/security", "domains/lotus-playbook"],
    });

    expect(result.hits).toEqual([
      expect.objectContaining({ id: "domains/security/README.md", path: "domains/security/README.md", title: "Security" }),
      expect.objectContaining({ id: "domains/lotus-playbook.md", path: "domains/lotus-playbook.md", title: "Migration Playbook" }),
    ]);

    const formatted = formatVaultGetText(result);
    expect(formatted).toContain("# /vault get");
    expect(formatted).toContain("Vault security baseline checklist.");
    expect(formatted).toContain("Lotus rollout notes are tracked here.");
  });

  it("fails explicitly for a path that does not exist", async () => {
    const vaultDir = await createVaultFixture();

    await expect(getVaultDocuments({ ids: ["domains/security.md"], vaultDir }))
      .rejects
      .toThrow("Vault document not found: domains/security.md");
  });

  it("resolves a <store>:<path> pointer through the store registry", async () => {
    // A store root is a declared tree whose id is its registry key.
    const primary = await createTree("vault-get-primary-", {
      "vault.config.json": JSON.stringify({ id: "get-primary", profile: "kuma-vault" }),
      "notes/a.md": "---\ntitle: A\n---\n\nprimary\n",
    });
    const secondary = await createTree("vault-get-second-", {
      "vault.config.json": JSON.stringify({ id: "get-second", profile: "kuma-vault" }),
      "rules/b.md": "---\ntitle: B\n---\n\nsecond store body\n",
    });
    const registryDir = await createTree("vault-get-registry-", {});
    const registry = join(registryDir, "vault-stores.json");
    await writeFile(registry, JSON.stringify({ stores: { "get-primary": primary, "get-second": secondary } }));
    const env = { KUMA_VAULT_STORES: registry };

    const got = await getVaultDocuments({ ids: ["get-second:rules/b.md"], vaultDir: primary, env });
    expect(got.hits[0]).toMatchObject({ id: "get-second:rules/b.md", path: "rules/b.md", storeId: "get-second", title: "B" });
    expect(got.hits[0].content).toContain("second store body");

    await expect(getVaultDocuments({ ids: ["no-such-store:rules/b.md"], vaultDir: primary, env }))
      .rejects
      .toThrow('Unknown store id "no-such-store"');
  });

  it("is reachable at the cli.mjs level and through the bin wrapper", async () => {
    const vaultDir = await createVaultFixture();

    const { stdout: getStdout } = await execFile("node", [CLI_PATH, "vault-get", "--vault-dir", vaultDir, "domains/security"]);
    expect(getStdout).toContain("# /vault get");
    expect(getStdout).toContain("Vault security baseline checklist.");

    // The domain-page shortcut: `vault <dir>` prints `<dir>/README.md`.
    const { stdout: shortcutStdout } = await execFile("bash", [VAULT_BIN_PATH, "--vault-dir", vaultDir, "domains/security"]);
    expect(shortcutStdout).toContain("title: Security");
    expect(shortcutStdout).toContain("Vault security baseline checklist.");
  });

  it("no longer has search or timeline verbs", async () => {
    const vaultDir = await createVaultFixture();

    for (const verb of ["search", "timeline"]) {
      await expect(execFile("bash", [VAULT_BIN_PATH, verb, "lotus", "--vault-dir", vaultDir]))
        .rejects
        .toMatchObject({ code: expect.any(Number) });
    }
    await expect(execFile("node", [CLI_PATH, "vault-search", "--query", "lotus", "--vault-dir", vaultDir]))
      .rejects
      .toMatchObject({ code: expect.any(Number) });
  });
});

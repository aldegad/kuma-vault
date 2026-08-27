import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lintVaultFiles, formatVaultLintReport } from "./vault-lint.mjs";

// Cross-store pointer resolution (vault-lint + vault-stores). Each test points
// KUMA_VAULT_STORES at a temp registry so the machine's real registry is never
// read; the env is restored in afterEach.

describe("cross-store pointer lint", () => {
  const tempRoots = [];
  const savedStoresEnv = process.env.KUMA_VAULT_STORES;

  afterEach(async () => {
    if (savedStoresEnv === undefined) {
      delete process.env.KUMA_VAULT_STORES;
    } else {
      process.env.KUMA_VAULT_STORES = savedStoresEnv;
    }
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function scratch() {
    const root = await mkdtemp(join(tmpdir(), "kuma-xstore-"));
    tempRoots.push(root);
    return root;
  }

  // A peer store `acme-ops` with a real file and a real directory to resolve to.
  async function writePeerStore(root, id = "acme-ops") {
    const dir = join(root, id);
    await mkdir(join(dir, "people"), { recursive: true });
    await mkdir(join(dir, "domains", "research", "pqc"), { recursive: true });
    await writeFile(join(dir, "vault.config.json"), JSON.stringify({ id, profile: "kuma-vault" }), "utf8");
    await writeFile(join(dir, "people", "인명록.md"), "# 인명록\n", "utf8");
    return dir;
  }

  async function writeSourceVault(root, body) {
    const vaultDir = join(root, "src-vault");
    await mkdir(vaultDir, { recursive: true });
    await writeFile(
      join(vaultDir, "note.md"),
      `---\ntitle: Note\ncreated: 2026-07-29T10:00:00Z\nupdated: 2026-07-29T10:00:00Z\n---\n\n## Body\n\n${body}\n`,
      "utf8",
    );
    return vaultDir;
  }

  async function writeRegistry(root, stores) {
    const path = join(root, "vault-stores.json");
    await writeFile(path, JSON.stringify({ stores }), "utf8");
    process.env.KUMA_VAULT_STORES = path;
    return path;
  }

  const crossStore = (result) => result.issues.filter((i) => i.code.startsWith("cross-store"));

  it("resolves existing file and directory pointers with no cross-store issue", async () => {
    const root = await scratch();
    const peer = await writePeerStore(root);
    await writeRegistry(root, { "acme-ops": peer });
    const vaultDir = await writeSourceVault(
      root,
      "See `acme-ops:people/인명록.md` and the folder `acme-ops:domains/research/pqc/`.",
    );
    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["note.md"] });
    expect(crossStore(result)).toEqual([]);
  });

  it("flags a pointer whose target file does not exist (unresolved)", async () => {
    const root = await scratch();
    const peer = await writePeerStore(root);
    await writeRegistry(root, { "acme-ops": peer });
    const vaultDir = await writeSourceVault(root, "Broken: `acme-ops:people/없는사람.md`.");
    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["note.md"] });
    expect(result.issues.some((i) => i.code === "cross-store-pointer-unresolved" && i.file === "note.md")).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("treats a trailing-slash pointer as a directory and fails when it is a file", async () => {
    const root = await scratch();
    const peer = await writePeerStore(root);
    await writeRegistry(root, { "acme-ops": peer });
    // 인명록.md exists as a FILE, but the pointer asks for a directory.
    const vaultDir = await writeSourceVault(root, "`acme-ops:people/인명록.md/`");
    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["note.md"] });
    expect(result.issues.some((i) => i.code === "cross-store-pointer-unresolved")).toBe(true);
  });

  it("loud-fails an unregistered store-id (unknown-store)", async () => {
    const root = await scratch();
    const peer = await writePeerStore(root);
    await writeRegistry(root, { "acme-ops": peer });
    const vaultDir = await writeSourceVault(root, "`kuma-brain:domains/personal/lotus.md`");
    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["note.md"] });
    expect(result.issues.some((i) => i.code === "cross-store-unknown-store")).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("rejects a pointer that escapes the store root (traversal)", async () => {
    const root = await scratch();
    const peer = await writePeerStore(root);
    await writeRegistry(root, { "acme-ops": peer });
    const vaultDir = await writeSourceVault(root, "`acme-ops:../outside.md`");
    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["note.md"] });
    expect(result.issues.some((i) => i.code === "cross-store-pointer-invalid")).toBe(true);
  });

  it("does not false-positive on URLs, times, key:value, or fenced examples", async () => {
    const root = await scratch();
    const peer = await writePeerStore(root);
    await writeRegistry(root, { "acme-ops": peer });
    const body = [
      "URL `https://example.com/a/b`, aspect `16:9`, time `12:30`, config `key: value`.",
      // Real-world classes seen in the trees: mail headers and URI schemes whose
      // value merely looks path-like must NOT be treated as cross-store pointers.
      "Mail `to:alex@example.com`, `from:partner.example`, `forward:x@gmail.com`.",
      "URI `file:../../shared-skills`, `data:image/png;base64,AAAA`.",
      "A real one resolves: `acme-ops:people/인명록.md`.",
      "",
      "```",
      "In a fence this is an EXAMPLE, not checked: `acme-ops:people/없는사람.md`",
      "```",
    ].join("\n");
    const vaultDir = await writeSourceVault(root, body);
    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["note.md"] });
    expect(crossStore(result)).toEqual([]);
  });

  it("explicitly reports (non-failing warn) when no registry exists on this machine", async () => {
    const root = await scratch();
    process.env.KUMA_VAULT_STORES = join(root, "absent.json");
    const vaultDir = await writeSourceVault(root, "`acme-ops:people/인명록.md`");
    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["note.md"] });
    const skip = result.issues.find((i) => i.code === "cross-store-check-skipped");
    expect(skip).toBeDefined();
    expect(skip.severity).toBe("warn");
    // The skip is a warning, so it must NOT contribute an error-severity issue.
    expect(crossStore(result).some((i) => (i.severity ?? "error") === "error")).toBe(false);
    expect(formatVaultLintReport(result)).toMatch(/\[warn\].*cross-store pointer/u);
  });

  it("loud-fails a present-but-invalid registry", async () => {
    const root = await scratch();
    const path = join(root, "vault-stores.json");
    await writeFile(path, "{ broken", "utf8");
    process.env.KUMA_VAULT_STORES = path;
    const vaultDir = await writeSourceVault(root, "`acme-ops:people/인명록.md`");
    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["note.md"] });
    expect(result.issues.some((i) => i.code === "cross-store-registry-invalid")).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("flags a registry entry whose tree declares a different id", async () => {
    const root = await scratch();
    const peer = await writePeerStore(root, "acme-ops");
    // Register the same directory under the WRONG id.
    await writeRegistry(root, { "kuma-brain": peer });
    const vaultDir = await writeSourceVault(root, "`kuma-brain:people/인명록.md`");
    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["note.md"] });
    expect(result.issues.some((i) => i.code === "cross-store-registry-mismatch")).toBe(true);
  });

  it("does not resolve cross-store pointers in fast mode", async () => {
    const root = await scratch();
    const peer = await writePeerStore(root);
    await writeRegistry(root, { "acme-ops": peer });
    const vaultDir = await writeSourceVault(root, "`acme-ops:people/없는사람.md`");
    const result = lintVaultFiles({ vaultDir, mode: "fast", files: ["note.md"] });
    expect(crossStore(result)).toEqual([]);
  });
});

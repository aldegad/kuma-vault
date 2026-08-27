// vault-config — repo self-declaration resolver tests.
//
// The resolver is the structural fix for the flag-pair accident class
// (2026-07-07: `--profile` without `--root` silently applied a foreign contract
// to the default brain vault). Every ambiguous case must throw; nothing may
// fall back to a default root or a default contract.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  VAULT_CONFIG_FILENAME,
  discoverVaultDeclaration,
  loadVaultDeclaration,
  resolveDeclaredProfile,
  resolveVaultContract,
} from "./vault-config.mjs";
import { DOCS_PROFILE, VAULT_PROFILE } from "./vault-profile.mjs";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vault-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeDeclaration(dir, declaration) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, VAULT_CONFIG_FILENAME), JSON.stringify(declaration, null, 2));
}

describe("loadVaultDeclaration", () => {
  it("returns null when the root has no declaration", () => {
    expect(loadVaultDeclaration(root)).toBeNull();
  });

  it("parses a minimal declaration", () => {
    writeDeclaration(root, { profile: "kuma-vault" });
    expect(loadVaultDeclaration(root)).toEqual({ profile: "kuma-vault" });
  });

  it("throws on malformed JSON (a broken contract file is never skipped)", () => {
    writeFileSync(join(root, VAULT_CONFIG_FILENAME), "{ nope");
    expect(() => loadVaultDeclaration(root)).toThrow(/Invalid vault declaration/u);
  });

  it("throws when the base contract id is missing", () => {
    writeDeclaration(root, { id: "some-tree" });
    expect(() => loadVaultDeclaration(root)).toThrow(/base contract id is required/u);
  });

  it("throws on unknown keys (typos never silently ignored)", () => {
    writeDeclaration(root, { profile: "docs", rootNonNavFile: ["AGENTS.md"] });
    expect(() => loadVaultDeclaration(root)).toThrow(/unknown key\(s\) rootNonNavFile/u);
  });

  it("validates override value types", () => {
    writeDeclaration(root, { profile: "docs", sidecar: "yes" });
    expect(() => loadVaultDeclaration(root)).toThrow(/"sidecar" must be a boolean/u);

    writeDeclaration(root, { profile: "docs", rootNonNavFiles: "AGENTS.md" });
    expect(() => loadVaultDeclaration(root)).toThrow(/array of non-empty strings/u);

    writeDeclaration(root, { profile: "docs", navScope: "everything" });
    expect(() => loadVaultDeclaration(root)).toThrow(/"navScope" must be/u);

    writeDeclaration(root, { profile: "docs", schema: { path: "x.md", extra: true } });
    expect(() => loadVaultDeclaration(root)).toThrow(/"schema" has unknown key\(s\) extra/u);
  });
});

describe("resolveDeclaredProfile", () => {
  it("layers overrides on the declared base and labels the contract", () => {
    const profile = resolveDeclaredProfile({
      id: "acme-ops",
      profile: "docs",
      rootNonNavFiles: ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "DESIGN.md"],
      schema: { path: "runbooks/knowledge-base-rules.md" },
    });
    expect(profile.id).toBe("acme-ops");
    expect(profile.navScope).toBe(DOCS_PROFILE.navScope);
    expect(profile.rootNonNavFiles).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "DESIGN.md"]);
    // schema merges shallowly over the base schema.
    expect(profile.schema).toEqual({ ...DOCS_PROFILE.schema, path: "runbooks/knowledge-base-rules.md" });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.rootNonNavFiles)).toBe(true);
  });

  it("defaults the contract id to the base profile id", () => {
    const profile = resolveDeclaredProfile({ profile: "kuma-vault" });
    expect(profile.id).toBe("kuma-vault");
    expect(profile).toEqual(VAULT_PROFILE);
  });

  it("throws on an unknown base profile id", () => {
    expect(() => resolveDeclaredProfile({ profile: "nope" })).toThrow(/Unknown vault profile/u);
  });
});

describe("discoverVaultDeclaration", () => {
  it("finds the nearest declaration walking up from a nested cwd", () => {
    const tree = join(root, "repo", "vault");
    writeDeclaration(tree, { profile: "kuma-vault" });
    const nested = join(tree, "domains", "deep");
    mkdirSync(nested, { recursive: true });
    const found = discoverVaultDeclaration(nested);
    expect(found?.rootDir).toBe(tree);
    expect(found?.declaration).toEqual({ profile: "kuma-vault" });
  });

  it("stops at the git toplevel — a declaration above the repo never applies", () => {
    writeDeclaration(root, { profile: "kuma-vault" }); // stray declaration above the repo
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const inside = join(repo, "docs");
    mkdirSync(inside, { recursive: true });
    expect(discoverVaultDeclaration(inside)).toBeNull();
  });

  it("finds a declaration at the git toplevel itself", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeDeclaration(repo, { profile: "docs" });
    const inside = join(repo, "docs");
    mkdirSync(inside, { recursive: true });
    expect(discoverVaultDeclaration(inside)?.rootDir).toBe(repo);
  });
});

describe("resolveVaultContract", () => {
  const noEnv = {};

  it("explicit root + declaration → the declaration decides the contract", () => {
    writeDeclaration(root, { id: "acme-ops", profile: "docs" });
    const result = resolveVaultContract({ root, env: noEnv });
    expect(result.vaultDir).toBe(root);
    expect(result.profile.id).toBe("acme-ops");
    expect(result.source).toBe("declaration");
  });

  it("a --profile flag matching the declared contract id is allowed (installed-hook compat)", () => {
    writeDeclaration(root, { id: "acme-ops", profile: "docs" });
    const result = resolveVaultContract({ root, profile: "acme-ops", env: noEnv });
    expect(result.profile.id).toBe("acme-ops");
  });

  it("a --profile flag disagreeing with the declaration throws (declaration owns the contract)", () => {
    writeDeclaration(root, { id: "acme-ops", profile: "docs" });
    expect(() => resolveVaultContract({ root, profile: "kuma-vault", env: noEnv })).toThrow(
      /conflicts with the vault\.config\.json declaration/u,
    );
  });

  it("explicit root without declaration + --profile → engine built-in (undeclared-tree compat)", () => {
    const result = resolveVaultContract({ root, profile: "docs", env: noEnv });
    expect(result.profile).toBe(DOCS_PROFILE);
    expect(result.source).toBe("flags");
  });

  it("explicit root without declaration and without --profile throws (no default contract)", () => {
    expect(() => resolveVaultContract({ root, env: noEnv })).toThrow(/no --profile given/u);
  });

  it("no root → discovers the declaration from the cwd", () => {
    writeDeclaration(root, { profile: "kuma-vault" });
    const nested = join(root, "domains");
    mkdirSync(nested, { recursive: true });
    const result = resolveVaultContract({ cwd: nested, env: noEnv });
    expect(result.vaultDir).toBe(root);
    expect(result.profile.id).toBe("kuma-vault");
  });

  it("no root and no discoverable declaration throws — the 2026-07-07 accident class", () => {
    const repo = join(root, "undeclared");
    mkdirSync(join(repo, ".git"), { recursive: true });
    // `--profile` alone (the exact mishap shape) must fail loud, never target the default vault.
    expect(() => resolveVaultContract({ profile: "docs", cwd: repo, env: noEnv })).toThrow(
      /No vault target/u,
    );
    expect(() => resolveVaultContract({ cwd: repo, env: noEnv })).toThrow(/No vault target/u);
  });

  it("KUMA_VAULT_DIR acts as an explicit root", () => {
    writeDeclaration(root, { profile: "kuma-vault" });
    const result = resolveVaultContract({ cwd: tmpdir(), env: { KUMA_VAULT_DIR: root } });
    expect(result.vaultDir).toBe(root);
    expect(result.profile.id).toBe("kuma-vault");
  });
});

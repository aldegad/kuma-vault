import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { syncVaultIndex } from "./vault-ingest.mjs";
import { lintVaultFiles } from "./vault-lint.mjs";
import {
  DOCS_PROFILE,
  VAULT_PROFILE,
  listProfileIds,
  resolveProfile,
} from "./vault-profile.mjs";

const execFile = promisify(execFileCallback);

async function makeTempTree(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeFileEnsuringDir(root, relativePath, content) {
  const absolute = join(root, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
  return absolute;
}

async function initGitRepo(root) {
  // `git ls-files` reads the index, so `git add` (no commit) is enough to make a
  // file "tracked" for the git-tracked nav scope — keeps the fixture cheap.
  await execFile("git", ["-C", root, "init", "-q"]);
  await execFile("git", ["-C", root, "add", "-A"]);
}

const README_WITH_EMPTY_INDEX = `---
title: t
---

# t

## Vault Index

<!-- vault-index:start -->

<!-- vault-index:end -->
`;

describe("resolveProfile", () => {
  it("returns the vault profile by default and for known ids", () => {
    expect(resolveProfile()).toBe(VAULT_PROFILE);
    expect(resolveProfile(null)).toBe(VAULT_PROFILE);
    expect(resolveProfile("kuma-vault")).toBe(VAULT_PROFILE);
    expect(resolveProfile("docs")).toBe(DOCS_PROFILE);
  });

  it("passes through a profile object unchanged (the consumer-profile seam)", () => {
    // Org/tree-specific profiles are NOT built into the engine — a consumer passes
    // its own profile object and the engine drives it verbatim.
    const custom = { ...DOCS_PROFILE, id: "acme-handbook" };
    expect(resolveProfile(custom)).toBe(custom);
  });

  it("throws on an unknown profile id (No Silent Fallback — never downgrade)", () => {
    expect(() => resolveProfile("does-not-exist")).toThrow(/Unknown vault profile/u);
  });

  it("ships generic built-in profiles only (no organization-specific ids)", () => {
    expect(listProfileIds()).toEqual(expect.arrayContaining(["kuma-vault", "docs"]));
  });
});

describe("audit F — same sync/lint entry point, only root/profile differ", () => {
  it("exposes a single sync/lint implementation (no per-profile fork/clone)", () => {
    // The profile is a parameter of the one engine, never a separate entry point.
    expect(typeof syncVaultIndex).toBe("function");
    expect(typeof lintVaultFiles).toBe("function");
    expect(syncVaultIndex.length).toBeLessThanOrEqual(1);
    expect(lintVaultFiles.length).toBeLessThanOrEqual(1);
  });

  it("drives the vault tree and a docs-as-code tree through the identical functions", async () => {
    // Vault-shaped tree (default profile).
    const vaultRoot = await makeTempTree("vault-profile-vault-");
    await writeFile(join(vaultRoot, "README.md"), README_WITH_EMPTY_INDEX, "utf8");
    await writeFileEnsuringDir(vaultRoot, "domains/README.md", README_WITH_EMPTY_INDEX);
    await writeFileEnsuringDir(vaultRoot, "domains/tools.md", "---\ntitle: tools\n---\n\n# tools\n\nA tool page.\n");

    // docs-as-code-shaped tree (git repo, docs profile).
    const docsRoot = await makeTempTree("vault-profile-docs-");
    await writeFile(join(docsRoot, "README.md"), README_WITH_EMPTY_INDEX, "utf8");
    await writeFile(join(docsRoot, "AGENTS.md"), "# agents\n", "utf8");
    await writeFileEnsuringDir(docsRoot, "runbooks/README.md", README_WITH_EMPTY_INDEX);
    await initGitRepo(docsRoot);

    const vaultSync = await syncVaultIndex({ vaultDir: vaultRoot, check: true });
    const docsSync = await syncVaultIndex({ vaultDir: docsRoot, check: true, profile: "docs" });

    // Same call shape, both return a coherent index report.
    expect(vaultSync.vaultDir).toBe(vaultRoot);
    expect(docsSync.vaultDir).toBe(docsRoot);
    expect(typeof vaultSync.changedCount).toBe("number");
    expect(typeof docsSync.changedCount).toBe("number");

    const vaultLint = lintVaultFiles({ vaultDir: vaultRoot });
    const docsLint = lintVaultFiles({ vaultDir: docsRoot, profile: "docs" });
    expect(vaultLint.vaultDir).toBe(vaultRoot);
    expect(docsLint.vaultDir).toBe(docsRoot);
  });
});

describe("docs profile contract (differs from the vault slot contract)", () => {
  it("skips the schema special-file lint in full mode (no schema.md required)", async () => {
    // A git tree with no schema.md must not produce a missing-schema issue under
    // the docs profile (its rules live in a runbook, not a schema). The vault
    // profile on the same tree WOULD flag the missing schema — proof the gate is
    // profile-driven, not accidental.
    const docsRoot = await makeTempTree("vault-profile-schema-");
    await writeFile(join(docsRoot, "README.md"), README_WITH_EMPTY_INDEX, "utf8");
    await initGitRepo(docsRoot);
    expect(existsSync(join(docsRoot, "schema.md"))).toBe(false);

    const docs = lintVaultFiles({ vaultDir: docsRoot, profile: "docs", mode: "full" });
    expect(docs.issues.some((issue) => issue.code === "missing-schema")).toBe(false);
    expect(docs.issues.some((issue) => issue.code === "schema-special-files-missing")).toBe(false);

    const vaultOnSameTree = lintVaultFiles({ vaultDir: docsRoot, mode: "full" });
    expect(vaultOnSameTree.issues.some((issue) => issue.code === "missing-schema")).toBe(true);
  });

  it("bounds the index nav scope to git-tracked directories", async () => {
    const docsRoot = await makeTempTree("vault-profile-scope-");
    await writeFile(join(docsRoot, "README.md"), README_WITH_EMPTY_INDEX, "utf8");
    await writeFileEnsuringDir(docsRoot, "tracked/README.md", README_WITH_EMPTY_INDEX);
    await initGitRepo(docsRoot);
    // Untracked subtree added AFTER `git add` — outside the managed handbook.
    await writeFileEnsuringDir(docsRoot, "vendored/deep/notes.md", "# notes\n");

    await syncVaultIndex({ vaultDir: docsRoot, profile: "docs" });
    const rootReadme = await readFile(join(docsRoot, "README.md"), "utf8");
    // The tracked folder is linked from the root index; the untracked vendored
    // subtree is pruned (neither linked nor minted a README).
    expect(rootReadme).toContain("tracked/README.md");
    expect(rootReadme).not.toContain("vendored");
    expect(existsSync(join(docsRoot, "vendored/deep/README.md"))).toBe(false);
    expect(existsSync(join(docsRoot, "vendored/README.md"))).toBe(false);
  });

  it("treats a plans/ folder as ordinary nav (no plans slot in this profile)", async () => {
    const docsRoot = await makeTempTree("vault-profile-plans-");
    await writeFile(join(docsRoot, "README.md"), README_WITH_EMPTY_INDEX, "utf8");
    await writeFileEnsuringDir(docsRoot, "plans/README.md", README_WITH_EMPTY_INDEX);
    await initGitRepo(docsRoot);

    await syncVaultIndex({ vaultDir: docsRoot, profile: "docs" });
    const rootReadme = await readFile(join(docsRoot, "README.md"), "utf8");
    // Under the vault profile plans/ is exempt; under docs it is a normal folder.
    expect(rootReadme).toContain("plans/README.md");
  });

  it("write sync converges and a second write is a no-op (idempotent)", async () => {
    const docsRoot = await makeTempTree("vault-profile-idem-");
    await writeFile(join(docsRoot, "README.md"), README_WITH_EMPTY_INDEX, "utf8");
    await writeFileEnsuringDir(docsRoot, "domains/README.md", README_WITH_EMPTY_INDEX);
    await writeFileEnsuringDir(docsRoot, "domains/a.md", "---\ntitle: a\n---\n\n# a\n\nPage a.\n");
    await initGitRepo(docsRoot);

    const first = await syncVaultIndex({ vaultDir: docsRoot, profile: "docs" });
    expect(first.converged).toBe(true);

    const check = await syncVaultIndex({ vaultDir: docsRoot, check: true, profile: "docs" });
    expect(check.changedCount).toBe(0);

    const second = await syncVaultIndex({ vaultDir: docsRoot, profile: "docs" });
    expect(second.changedCount).toBe(0);
    // The root index now links its tracked child folder.
    const rootReadme = await readFile(join(docsRoot, "README.md"), "utf8");
    expect(rootReadme).toContain("domains/README.md");
  });

  it("does not require git under the vault profile (navScope: all)", async () => {
    // A non-git temp tree must lint/sync fine with the default profile — the
    // git-tracked scope is opt-in per profile, never forced.
    const vaultRoot = await makeTempTree("vault-profile-nogit-");
    await writeFile(join(vaultRoot, "README.md"), README_WITH_EMPTY_INDEX, "utf8");
    expect(existsSync(join(vaultRoot, ".git"))).toBe(false);
    const sync = await syncVaultIndex({ vaultDir: vaultRoot, check: true });
    expect(sync.vaultDir).toBe(vaultRoot);
  });
});

describe("consumer profile object (org-specific trees inject, engine stays generic)", () => {
  it("drives sync + lint from a passed-in profile object the engine never registered", async () => {
    // This is exactly how a host resolves an org-specific tree now that the engine
    // ships generic profiles only: it builds its own profile object (here a docs
    // tree with a runbook rules-doc + extra root non-nav files) and passes it in.
    const consumerProfile = Object.freeze({
      ...DOCS_PROFILE,
      id: "acme-handbook",
      rootNonNavFiles: Object.freeze(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "DESIGN.md"]),
      schema: Object.freeze({
        path: "runbooks/handbook-rules.md",
        validateSpecialFiles: false,
        autoScaffold: false,
      }),
    });

    const root = await makeTempTree("vault-profile-consumer-");
    await writeFile(join(root, "README.md"), README_WITH_EMPTY_INDEX, "utf8");
    await writeFile(join(root, "AGENTS.md"), "# agents\n", "utf8");
    await writeFile(join(root, "DESIGN.md"), "# design\n", "utf8");
    await writeFileEnsuringDir(root, "runbooks/README.md", README_WITH_EMPTY_INDEX);
    await initGitRepo(root);

    const sync = await syncVaultIndex({ vaultDir: root, profile: consumerProfile });
    expect(sync.converged).toBe(true);
    const rootReadme = await readFile(join(root, "README.md"), "utf8");
    // runbooks is nav; the extra root non-nav files (AGENTS.md/DESIGN.md) are not linked.
    expect(rootReadme).toContain("runbooks/README.md");
    expect(rootReadme).not.toContain("AGENTS.md");
    expect(rootReadme).not.toContain("DESIGN.md");

    // Lint runs the docs-as-code contract (no missing-schema despite no schema.md).
    const lint = lintVaultFiles({ vaultDir: root, profile: consumerProfile, mode: "full" });
    expect(lint.issues.some((issue) => issue.code === "missing-schema")).toBe(false);
    expect(lint.vaultDir).toBe(root);
  });

  it("does NOT flag the deprecated `domain:` field under the docs profile (same gating as the old rule)", async () => {
    // The domain-deprecation block belongs to the canonical-page frontmatter contract, which
    // the docs profile does not enforce (enforcePageFrontmatter=false). A docs-tree page that
    // carries `domain:` must therefore NOT be flagged — identical gating to every other
    // page-frontmatter rule (and to the retired missing-frontmatter-domain requirement).
    const root = await makeTempTree("vault-profile-domain-gate-");
    await writeFile(join(root, "README.md"), README_WITH_EMPTY_INDEX, "utf8");
    await writeFileEnsuringDir(root, "guide/setup.md", "---\ntitle: Setup\ndomain: guide\n---\n\n# Setup\n\nbody.\n");
    await initGitRepo(root);

    const files = ["guide/setup.md"];
    // Under the vault profile the same page IS flagged — proves the fixture would trip the rule.
    const vaultLint = lintVaultFiles({ vaultDir: root, profile: VAULT_PROFILE, mode: "full", files });
    expect(vaultLint.issues.some(
      (issue) => issue.file === "guide/setup.md" && issue.code === "deprecated-frontmatter-domain",
    )).toBe(true);

    // Under the docs profile the whole page-frontmatter contract (incl. the domain block) is skipped.
    const docsLint = lintVaultFiles({ vaultDir: root, profile: DOCS_PROFILE, mode: "full", files });
    expect(docsLint.issues.some((issue) => issue.code === "deprecated-frontmatter-domain")).toBe(false);
  });
});

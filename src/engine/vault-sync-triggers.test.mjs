import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  VAULT_SYNC_BOUNDARIES,
  STALE_INDEX_CODE,
  triggerVaultSyncIndex,
  selfHealStaleIndex,
} from "./vault-sync-triggers.mjs";
import { syncVaultIndex, ingestGenericSource } from "./vault-ingest.mjs";
import { lintVaultFiles } from "./vault-lint.mjs";

function leafPage(title, summary) {
  return `---
title: ${title}
tags: []
created: 2026-07-03
updated: 2026-07-03
sources: []
---

## Summary
${summary}
`;
}

async function makeVault(prefix) {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  const vaultDir = join(tempRoot, "vault");
  await mkdir(join(vaultDir, "domains"), { recursive: true });
  return vaultDir;
}

function staleRegions(lintResult) {
  return (lintResult.issues ?? []).filter((issue) => issue.code === STALE_INDEX_CODE);
}

describe("vault-sync-triggers", () => {
  describe("triggerVaultSyncIndex — the shared engine funnel", () => {
    it("rejects an unknown boundary (only the declared trigger surfaces may fire)", async () => {
      const vaultDir = await makeVault("kuma-trigger-boundary-");
      await expect(
        triggerVaultSyncIndex({ vaultDir, boundary: "watcher" }),
      ).rejects.toThrow(/unknown boundary "watcher"/u);
      expect(VAULT_SYNC_BOUNDARIES).toEqual(["ingest", "cron", "lint-self-heal"]);
    });

    it("regenerates a stale vault-index region through syncVaultIndex (heal)", async () => {
      const vaultDir = await makeVault("kuma-trigger-heal-");
      await writeFile(join(vaultDir, "domains", "alpha.md"), leafPage("Alpha", "alpha"), "utf8");
      await syncVaultIndex({ vaultDir }); // clean baseline
      // New child → domains/README index region is now stale.
      await writeFile(join(vaultDir, "domains", "beta.md"), leafPage("Beta", "beta"), "utf8");
      expect(staleRegions(lintVaultFiles({ vaultDir, mode: "full" })).length).toBeGreaterThan(0);

      const result = await triggerVaultSyncIndex({ vaultDir, boundary: "cron" });

      expect(result.boundary).toBe("cron");
      expect(result.index.converged).toBe(true);
      expect(staleRegions(lintVaultFiles({ vaultDir, mode: "full" })).length).toBe(0);
      const readme = await readFile(join(vaultDir, "domains", "README.md"), "utf8");
      expect(readme).toContain("[Beta](beta.md)");
    });

    it("check mode reports drift without writing (drift gate)", async () => {
      const vaultDir = await makeVault("kuma-trigger-check-");
      await writeFile(join(vaultDir, "domains", "alpha.md"), leafPage("Alpha", "alpha"), "utf8");
      await syncVaultIndex({ vaultDir });
      await writeFile(join(vaultDir, "domains", "beta.md"), leafPage("Beta", "beta"), "utf8");

      const result = await triggerVaultSyncIndex({ vaultDir, boundary: "cron", check: true });

      expect(result.check).toBe(true);
      expect(result.index.changedCount).toBeGreaterThan(0);
      // Still stale — check mode never wrote.
      expect(staleRegions(lintVaultFiles({ vaultDir, mode: "full" })).length).toBeGreaterThan(0);
    });

    it("is idempotent: a second trigger over an unchanged tree is a no-op (원칙 5)", async () => {
      const vaultDir = await makeVault("kuma-trigger-idem-");
      await mkdir(join(vaultDir, "domains", "deepcat"), { recursive: true });
      await writeFile(join(vaultDir, "domains", "deepcat", "child.md"), leafPage("Child", "child"), "utf8");
      await writeFile(join(vaultDir, "domains", "alpha.md"), leafPage("Alpha", "alpha"), "utf8");

      const first = await triggerVaultSyncIndex({ vaultDir, boundary: "cron" });
      expect(first.index.converged).toBe(true);

      // Independent re-run over the now-converged tree writes nothing.
      const second = await triggerVaultSyncIndex({ vaultDir, boundary: "cron" });
      expect(second.index.changedCount).toBe(0);
      expect(second.index.converged).toBe(true);
      expect(staleRegions(lintVaultFiles({ vaultDir, mode: "full" })).length).toBe(0);
    });
  });

  describe("ingest boundary — vault-ingest funnels to the same engine", () => {
    it("leaves the index at the engine's fixed point after an ingest (a follow-up sync is a no-op)", async () => {
      const vaultDir = await makeVault("kuma-ingest-boundary-");
      // Pre-seed a multi-pass ripple: a nested folder with a child but no README.
      // A legacy single-pass ingest would leave the parent stale; the sync engine
      // ingest now calls converges inline, so a follow-up check finds zero drift.
      await mkdir(join(vaultDir, "domains", "deepcat"), { recursive: true });
      await writeFile(join(vaultDir, "domains", "deepcat", "child.md"), leafPage("Child", "child"), "utf8");

      await ingestGenericSource({
        source: "nova ingest boundary probe — 순수 함수 인덱스.",
        sourceType: "text",
        vaultDir,
        section: "domains",
        slug: "ingest-probe",
        title: "Ingest Probe",
      });

      // The ingested page exists.
      expect((await readFile(join(vaultDir, "domains", "ingest-probe.md"), "utf8"))).toContain("Ingest Probe");
      // Ingest reached the sync engine's fixed point: a check-mode sync sees no drift.
      const check = await syncVaultIndex({ vaultDir, check: true });
      expect(check.converged).toBe(true);
      expect(check.changedCount).toBe(0);
      // And no stale index regions remain (the nested-folder ripple converged too).
      expect(staleRegions(lintVaultFiles({ vaultDir, mode: "full" })).length).toBe(0);
    });
  });

  describe("cron boundary — `kuma vault sync` funnels to the same engine", () => {
    // Imports the distribution CLI adapter (src/cli/vault-commands.mjs) and drives the same
    // sync entry point the cron safety-net funnels through.
    it("commandVaultSync (the cron safety-net payload) heals a stale index via syncVaultIndex", async () => {
      const { commandVaultSync } = await import("../cli/vault-commands.mjs");
      const vaultDir = await makeVault("kuma-cron-boundary-");
      // The CLI resolves the tree's contract from its own root declaration (repo
      // self-declaration; an undeclared explicit root would fail loud).
      await writeFile(join(vaultDir, "vault.config.json"), JSON.stringify({ profile: "kuma-vault" }), "utf8");
      await writeFile(join(vaultDir, "domains", "alpha.md"), leafPage("Alpha", "alpha"), "utf8");
      await syncVaultIndex({ vaultDir });
      await writeFile(join(vaultDir, "domains", "beta.md"), leafPage("Beta", "beta"), "utf8");
      expect(staleRegions(lintVaultFiles({ vaultDir, mode: "full" })).length).toBeGreaterThan(0);

      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const priorExit = process.exitCode;
      try {
        await commandVaultSync({ json: true, "vault-dir": vaultDir });
      } finally {
        stdout.mockRestore();
        process.exitCode = priorExit;
      }

      // The cron payload reached the same fixed point as every other boundary.
      const check = await syncVaultIndex({ vaultDir, check: true });
      expect(check.converged).toBe(true);
      expect(staleRegions(lintVaultFiles({ vaultDir, mode: "full" })).length).toBe(0);
    });
  });

  describe("lint-self-heal boundary", () => {
    it("detects a stale region and heals it through the same engine, then confirms clean", async () => {
      const vaultDir = await makeVault("kuma-selfheal-heal-");
      await writeFile(join(vaultDir, "domains", "alpha.md"), leafPage("Alpha", "alpha"), "utf8");
      await syncVaultIndex({ vaultDir });
      await writeFile(join(vaultDir, "domains", "beta.md"), leafPage("Beta", "beta"), "utf8");

      const result = await selfHealStaleIndex({ vaultDir });

      expect(result.healed).toBe(true);
      expect(result.staleBefore).toBeGreaterThan(0);
      expect(result.staleAfter).toBe(0);
      expect(result.files).toContain("domains/README.md");
      expect(staleRegions(lintVaultFiles({ vaultDir, mode: "full" })).length).toBe(0);
    });

    it("is a no-op on a clean tree (idempotency — the engine is not run)", async () => {
      const vaultDir = await makeVault("kuma-selfheal-noop-");
      await writeFile(join(vaultDir, "domains", "alpha.md"), leafPage("Alpha", "alpha"), "utf8");
      await syncVaultIndex({ vaultDir });

      const result = await selfHealStaleIndex({ vaultDir });

      expect(result.healed).toBe(false);
      expect(result.staleBefore).toBe(0);
      expect(result.files).toEqual([]);
    });

    it("upgrades a fast-mode request to full so stale regions are actually detected", async () => {
      const vaultDir = await makeVault("kuma-selfheal-fast-");
      await writeFile(join(vaultDir, "domains", "alpha.md"), leafPage("Alpha", "alpha"), "utf8");
      await syncVaultIndex({ vaultDir });
      await writeFile(join(vaultDir, "domains", "beta.md"), leafPage("Beta", "beta"), "utf8");

      // Fast mode alone would miss the stale region; self-heal upgrades to full.
      const result = await selfHealStaleIndex({ vaultDir, mode: "fast" });
      expect(result.healed).toBe(true);
    });

    it("surfaces residual staleness after a heal — No Silent Fallback", async () => {
      vi.resetModules();
      // Force lint to keep reporting a stale region even after the engine ran, so
      // the heal cannot converge. The path must THROW, never swallow the drift.
      vi.doMock("./vault-lint.mjs", () => ({
        lintVaultFiles: () => ({
          ok: false,
          issues: [{ code: "vault-index-region-stale", file: "domains/README.md", message: "stuck stale" }],
        }),
      }));
      const { selfHealStaleIndex: isolatedSelfHeal } = await import("./vault-sync-triggers.mjs");
      const vaultDir = await makeVault("kuma-selfheal-nsf-");
      await writeFile(join(vaultDir, "domains", "alpha.md"), leafPage("Alpha", "alpha"), "utf8");
      await syncVaultIndex({ vaultDir });

      await expect(isolatedSelfHeal({ vaultDir })).rejects.toThrow(/self-heal ran but .* stale region/u);

      vi.doUnmock("./vault-lint.mjs");
      vi.resetModules();
    });
  });
});

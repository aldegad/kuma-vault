// The pre-commit drift gate — what it refuses and what it heals.
//
// `vault sync --check` is what the installed git hook runs, so this file pins the gate's
// contract at the exact seam the hook uses: `commandVaultSync({ check: true })` and the exit
// code it leaves behind.
//
// The gate splits derivations by RESIDENCE, not by how they look:
//   - TRACKED (README vault-index regions, binary sidecars) live inside the commit. Drift there
//     means the snapshot the commit would capture disagrees with its own generator → refuse.
//   - CACHE (the `.fts/` index) lives outside the commit. It cannot make a commit inconsistent
//     → heal it from the live tree and let the commit through (원칙 1's self-heal clause).
//
// The regression this guards: on 2026-07-31 three commits were refused because ANOTHER session
// had edited a page, moving the FTS corpus signature. Nothing about those commits was wrong.
// The negative controls below are the other half of that contract — healing a cache must never
// soften detection of drift that is actually in the commit.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { commandVaultSync } from "./vault-commands.mjs";
import { checkFtsIndex } from "../engine/vault-fts.mjs";

function leafPage(title, description, body) {
  return `---
title: ${title}
description: ${description}
tags: []
created: 2026-07-31
updated: 2026-07-31
sources: []
---

## Summary
${body}
`;
}

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A declared tree (root vault.config.json) with two leaf pages, fully converged: every
// derivation — index, sidecars, FTS cache — is at its fixed point before a scenario starts.
async function makeConvergedVault(prefix) {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(tempRoot);
  const vaultDir = join(tempRoot, "vault");
  await mkdir(join(vaultDir, "domains"), { recursive: true });
  await writeFile(
    join(vaultDir, "vault.config.json"),
    JSON.stringify({ id: "gate-fixture", profile: "kuma-vault" }),
    "utf8",
  );
  await writeFile(join(vaultDir, "domains", "alpha.md"), leafPage("Alpha", "alpha page", "alpha"), "utf8");
  await writeFile(join(vaultDir, "domains", "beta.md"), leafPage("Beta", "beta page", "beta"), "utf8");
  await runSync(vaultDir, { check: false });
  return vaultDir;
}

// Drive the real composed command the way the hook does, capturing stdout and the exit code it
// sets without letting either leak into the test runner's own process state.
async function runSync(vaultDir, { check }) {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const priorExit = process.exitCode;
  let written = "";
  stdout.mockImplementation((chunk) => {
    written += String(chunk);
    return true;
  });
  try {
    process.exitCode = 0;
    await commandVaultSync({ "vault-dir": vaultDir, ...(check ? { check: true } : {}) });
    return { exitCode: process.exitCode ?? 0, stdout: written };
  } finally {
    stdout.mockRestore();
    process.exitCode = priorExit;
  }
}

describe("pre-commit drift gate", () => {
  describe("cache drift — heals, never blocks", () => {
    it("lets a commit through when only another session's edit staled the FTS cache", async () => {
      const vaultDir = await makeConvergedVault("kuma-gate-cache-stale-");
      // Session A edits a page body. Title and description are untouched, so every TRACKED
      // derivation stays correct — only the FTS corpus signature moved.
      await writeFile(
        join(vaultDir, "domains", "beta.md"),
        leafPage("Beta", "beta page", "beta, edited by another session"),
        "utf8",
      );
      expect((await checkFtsIndex({ vaultDir })).wouldRebuild).toBe(true);

      const gate = await runSync(vaultDir, { check: true });

      expect(gate.exitCode).toBe(0);
      expect(gate.stdout).toContain("index: 0 drifted");
      // The heal is announced, not silent (원칙 6).
      expect(gate.stdout).toContain("fts: healed");
      // And it actually healed: the cache now matches the live tree.
      expect((await checkFtsIndex({ vaultDir })).wouldRebuild).toBe(false);
    });

    it("heals an absent cache at the gate instead of refusing the commit", async () => {
      const vaultDir = await makeConvergedVault("kuma-gate-cache-absent-");
      await rm(join(vaultDir, ".fts"), { recursive: true, force: true });

      const gate = await runSync(vaultDir, { check: true });

      expect(gate.exitCode).toBe(0);
      expect(gate.stdout).toContain("fts: healed");
      expect((await checkFtsIndex({ vaultDir })).wouldRebuild).toBe(false);
    });

    it("stays a no-op on a converged tree (원칙 5 — the gate does not rewrite what is in sync)", async () => {
      const vaultDir = await makeConvergedVault("kuma-gate-noop-");
      const before = await readFile(join(vaultDir, "domains", "README.md"), "utf8");

      const gate = await runSync(vaultDir, { check: true });

      expect(gate.exitCode).toBe(0);
      expect(gate.stdout).toContain("fts: in sync");
      expect(await readFile(join(vaultDir, "domains", "README.md"), "utf8")).toBe(before);
    });
  });

  describe("tracked drift — negative control, still refuses loudly", () => {
    it("refuses when a new page leaves its folder's vault-index region stale", async () => {
      const vaultDir = await makeConvergedVault("kuma-gate-tracked-new-page-");
      await writeFile(
        join(vaultDir, "domains", "gamma.md"),
        leafPage("Gamma", "gamma page", "gamma"),
        "utf8",
      );

      const gate = await runSync(vaultDir, { check: true });

      expect(gate.exitCode).toBe(1);
      expect(gate.stdout).toContain("index: 1 drifted");
    });

    it("refuses when a generated vault-index region is hand-edited (pollution, not staleness)", async () => {
      const vaultDir = await makeConvergedVault("kuma-gate-tracked-handedit-");
      const readmePath = join(vaultDir, "domains", "README.md");
      const polluted = (await readFile(readmePath, "utf8")).replace(
        /(<!-- vault-index:start -->\n)/u,
        "$1- [ghost](ghost.md) — hand-written line for a page that does not exist\n",
      );
      await writeFile(readmePath, polluted, "utf8");

      const gate = await runSync(vaultDir, { check: true });

      expect(gate.exitCode).toBe(1);
      expect(gate.stdout).toContain("- [drift] domains/README.md");
    });

    it("refuses tracked drift even while it heals the cache in the same run", async () => {
      const vaultDir = await makeConvergedVault("kuma-gate-both-");
      // Both at once: a new page (tracked drift) AND the cache behind the live tree.
      await writeFile(
        join(vaultDir, "domains", "delta.md"),
        leafPage("Delta", "delta page", "delta"),
        "utf8",
      );

      const gate = await runSync(vaultDir, { check: true });

      // The cache healed and the gate still refused — the two classes are decided separately.
      expect(gate.stdout).toContain("fts: healed");
      expect(gate.exitCode).toBe(1);
    });
  });
});

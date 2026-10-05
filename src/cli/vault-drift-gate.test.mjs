// The pre-commit drift gate — what it refuses.
//
// `vault sync --check` is what the installed git hook runs, so this file pins the gate's
// contract at the exact seam the hook uses: `commandVaultSync({ check: true })` and the exit
// code it leaves behind.
//
// The derivations (README vault-index regions, binary sidecars) live inside the commit. Drift
// there means the snapshot the commit would capture disagrees with its own generator → refuse.
// An edit that moves no derivation (a page body) passes: on 2026-07-31 three such commits were
// refused over a search cache, which no longer exists.

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { commandVaultSync } from "./vault-commands.mjs";

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
// derivation — index, sidecars — is at its fixed point before a scenario starts.
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
async function runSync(vaultDir, { check, extra = {} }) {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const priorExit = process.exitCode;
  let written = "";
  let errors = "";
  stdout.mockImplementation((chunk) => {
    written += String(chunk);
    return true;
  });
  stderr.mockImplementation((chunk) => {
    errors += String(chunk);
    return true;
  });
  try {
    process.exitCode = 0;
    await commandVaultSync({ "vault-dir": vaultDir, ...(check ? { check: true } : {}), ...extra });
    return { exitCode: process.exitCode ?? 0, stdout: written, stderr: errors };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    process.exitCode = priorExit;
  }
}

describe("pre-commit drift gate", () => {
  describe("no derivation moved — passes", () => {
    it("lets a commit through when another session edited only a page body", async () => {
      const vaultDir = await makeConvergedVault("kuma-gate-body-edit-");
      // Title and description are untouched, so every derivation stays correct.
      await writeFile(
        join(vaultDir, "domains", "beta.md"),
        leafPage("Beta", "beta page", "beta, edited by another session"),
        "utf8",
      );

      const gate = await runSync(vaultDir, { check: true });

      expect(gate.exitCode).toBe(0);
      expect(gate.stdout).toContain("index: 0 drifted");
      expect(gate.stdout).not.toMatch(/^fts:/mu);
      expect(existsSync(join(vaultDir, ".fts"))).toBe(false);
    });

    it("stays a no-op on a converged tree (원칙 5 — the gate does not rewrite what is in sync)", async () => {
      const vaultDir = await makeConvergedVault("kuma-gate-noop-");
      const before = await readFile(join(vaultDir, "domains", "README.md"), "utf8");

      const gate = await runSync(vaultDir, { check: true });

      expect(gate.exitCode).toBe(0);
      expect(await readFile(join(vaultDir, "domains", "README.md"), "utf8")).toBe(before);
    });

    it("accepts the retired --no-fts and says it has no effect", async () => {
      const vaultDir = await makeConvergedVault("kuma-gate-no-fts-");

      const gate = await runSync(vaultDir, { check: true, extra: { "no-fts": true } });

      expect(gate.exitCode).toBe(0);
      expect(gate.stderr).toBe("--no-fts has no effect: the FTS index was removed (accepted until the next release)\n");
      expect((await runSync(vaultDir, { check: true })).stderr).toBe("");
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
  });
});

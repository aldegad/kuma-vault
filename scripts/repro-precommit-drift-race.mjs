#!/usr/bin/env node
// Reproduction harness — "another session's edit blocks my commit".
//
// WHY THIS EXISTS
// Three times on 2026-07-31 a session was refused by the vault pre-commit drift gate for a
// change that was entirely its own and entirely in sync. The blocker was the `.fts/` search
// cache: any *other* session writing vault content moves the corpus signature, and the gate
// used to fail on that signature. Sessions were blocking each other, and the workaround was
// always the same manual `vault sync`.
//
// WHAT IT DOES
// Builds a throwaway git repo + fixture vault (never the real vault — no test commit ever
// touches ~/.kuma/vault), installs the REAL pre-commit gate via `vault hook install`, and drives
// real `git commit` calls through three scenarios. Deterministic: no clocks, no network, no
// concurrency; "session A" and "session B" are just ordered writes to one shared worktree, which
// is exactly what two agent sessions on one vault are.
//
// THE CONTRACT IT ASSERTS
//   1. cache-stale        — B's change is staged and synced; A edits another page's body and
//                           does not sync. Only the out-of-tree FTS cache is behind.
//                           → B MUST commit, with the cache healed in place.
//   2. tracked-drift      — B stages a new page and never syncs, so the folder README's
//                           generated vault-index region no longer matches its generator.
//                           → the gate MUST refuse (this is real drift, inside the commit).
//   3. hand-edited-region — the generated vault-index region is edited by hand.
//                           → the gate MUST refuse.
//
// Scenario 1 is the regression: run this on the pre-heal engine and it fails (B blocked); run it
// on the healed engine and it passes. Scenarios 2 and 3 are the negative control — they must
// refuse before AND after, because self-healing a cache must never soften drift detection.
//
// Usage: node scripts/repro-precommit-drift-race.mjs [--keep]

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT_BIN = resolve(HERE, "..", "bin", "vault");
const KEEP = process.argv.includes("--keep");

function run(command, args, options = {}) {
  const result = execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return String(result ?? "");
}

// Run a command that is EXPECTED to be able to fail, capturing status + output instead of
// throwing. The gate's refusal is data here, not an exception.
function tryRun(command, args, options = {}) {
  try {
    const stdout = run(command, args, options);
    return { ok: true, status: 0, output: stdout };
  } catch (error) {
    return {
      ok: false,
      status: typeof error.status === "number" ? error.status : 1,
      output: `${String(error.stdout ?? "")}${String(error.stderr ?? "")}`,
    };
  }
}

function git(repo, args) {
  return run("git", [
    "-C", repo,
    "-c", "user.email=harness@kuma.local",
    "-c", "user.name=drift harness",
    "-c", "commit.gpgsign=false",
    ...args,
  ]);
}

function tryGit(repo, args) {
  return tryRun("git", [
    "-C", repo,
    "-c", "user.email=harness@kuma.local",
    "-c", "user.name=drift harness",
    "-c", "commit.gpgsign=false",
    ...args,
  ]);
}

function page(title, body, description) {
  const describe = description ? `description: ${description}\n` : "";
  return `---
title: ${title}
${describe}created: 2026-07-31
updated: 2026-07-31
---

# ${title}

## Summary

${title} summary.

## Details

${body}

## Related

- none
`;
}

// A fixture repo in the shape the real vault has: the managed tree is a subdirectory of the git
// repo, and the derived `.fts/` cache is git-ignored (it is a cache, not content).
function createFixtureRepo(label) {
  const root = mkdtempSync(join(tmpdir(), `vault-drift-${label}-`));
  const repo = join(root, "repo");
  const vault = join(repo, "vault");
  mkdirSync(join(vault, "domains", "tools"), { recursive: true });

  run("git", ["init", "-q", repo]);
  // Pin the hook location to this repo so a global core.hooksPath cannot redirect either the
  // installer or the commit (the harness must exercise the gate it just installed).
  git(repo, ["config", "core.hooksPath", ".git/hooks"]);

  writeFileSync(join(repo, ".gitignore"), "vault/.fts/\n", "utf8");
  writeFileSync(
    join(vault, "vault.config.json"),
    `${JSON.stringify({ id: "drift-harness-vault", profile: "kuma-vault" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(vault, "README.md"), page("Harness Vault", "Fixture root."), "utf8");
  writeFileSync(join(vault, "domains", "tools", "README.md"), page("Tools", "Tools folder."), "utf8");
  // Two leaf pages: one for "session B" to change, one for "session A" to change concurrently.
  writeFileSync(
    join(vault, "domains", "tools", "kordoc.md"),
    page("kordoc", "Body written by the fixture.", "Rust CLI for parsing HWP"),
    "utf8",
  );
  writeFileSync(
    join(vault, "domains", "tools", "ripgrep.md"),
    page("ripgrep", "Body written by the fixture.", "Recursive line-oriented search"),
    "utf8",
  );

  // Converge every derivation, then take the baseline commit with the gate not yet installed.
  run(VAULT_BIN, ["sync", "--root", vault]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--no-verify", "-m", "baseline"]);
  run(VAULT_BIN, ["hook", "install", "--root", vault]);

  return { root, repo, vault };
}

function editBody(file, replacement) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(/^Body written by the fixture\.$/mu, replacement);
  if (after === before) {
    throw new Error(`harness fixture drifted: no body line to replace in ${file}`);
  }
  writeFileSync(file, after, "utf8");
}

const SCENARIOS = [
  {
    id: "cache-stale",
    what: "session A edits a page body without syncing; B's own change is staged and in sync",
    expect: "commit",
    why: "only the out-of-tree FTS cache is behind — nothing in the commit is inconsistent",
    act({ repo, vault }) {
      // Session B: makes its change, syncs every derivation, stages it. B is clean by any measure.
      editBody(join(vault, "domains", "tools", "kordoc.md"), "Body edited by session B.");
      run(VAULT_BIN, ["sync", "--root", vault]);
      git(repo, ["add", "vault/domains/tools/kordoc.md"]);

      // Session A: concurrently edits a DIFFERENT page and has not synced yet. A body-only edit
      // leaves every TRACKED derivation correct (the README index line is built from the title
      // and description, which A did not touch) — the FTS corpus signature is the only thing that
      // moved.
      editBody(join(vault, "domains", "tools", "ripgrep.md"), "Body edited by session A.");
    },
  },
  {
    id: "tracked-drift",
    what: "B stages a brand-new page without syncing, so the folder vault-index region is stale",
    expect: "refuse",
    why: "the README the commit would capture disagrees with its own generator — real drift",
    act({ repo, vault }) {
      writeFileSync(
        join(vault, "domains", "tools", "pandoc.md"),
        page("pandoc", "A new page nobody indexed.", "Universal document converter"),
        "utf8",
      );
      git(repo, ["add", "vault/domains/tools/pandoc.md"]);
    },
  },
  {
    id: "hand-edited-region",
    what: "the generated vault-index region is hand-edited",
    expect: "refuse",
    why: "a human-authored generated region is pollution, not staleness — it must stay loud",
    act({ repo, vault }) {
      const readme = join(vault, "domains", "tools", "README.md");
      const before = readFileSync(readme, "utf8");
      const after = before.replace(
        /(<!-- vault-index:start -->\n)/u,
        "$1- [ghost](ghost.md) — hand-written index line for a page that does not exist\n",
      );
      if (after === before) {
        throw new Error("harness fixture drifted: no vault-index region to pollute");
      }
      writeFileSync(readme, after, "utf8");
      git(repo, ["add", "vault/domains/tools/README.md"]);
    },
  },
];

function ftsSignature(vault) {
  // Read the published cache's own stamp without importing the engine — the harness stays a
  // black-box driver of the installed CLI.
  const db = join(vault, ".fts", "vault-fts.db");
  if (!existsSync(db)) {
    return null;
  }
  const script =
    "const {DatabaseSync}=require('node:sqlite');" +
    "const db=new DatabaseSync(process.argv[1],{readOnly:true});" +
    "process.stdout.write(String(db.prepare(\"SELECT value FROM fts_meta WHERE key='signature'\").get()?.value ?? ''));";
  return tryRun(process.execPath, ["--no-warnings", "-e", script, db]).output.trim() || null;
}

const results = [];
for (const scenario of SCENARIOS) {
  const fixture = createFixtureRepo(scenario.id);
  try {
    scenario.act(fixture);
    const signatureBefore = ftsSignature(fixture.vault);
    const commit = tryGit(fixture.repo, ["commit", "-q", "-m", `session B — ${scenario.id}`]);
    const signatureAfter = ftsSignature(fixture.vault);
    const actual = commit.ok ? "commit" : "refuse";
    results.push({
      id: scenario.id,
      what: scenario.what,
      why: scenario.why,
      expect: scenario.expect,
      actual,
      pass: actual === scenario.expect,
      cacheHealed: signatureBefore !== signatureAfter,
      gateOutput: commit.output
        .split("\n")
        .filter((line) => /^(index|sidecars|fts|lint|  stale)/u.test(line))
        .join("\n"),
    });
  } finally {
    if (!KEEP) {
      rmSync(fixture.root, { recursive: true, force: true });
    } else {
      process.stdout.write(`kept: ${fixture.root}\n`);
    }
  }
}

let failed = 0;
process.stdout.write("\npre-commit drift gate — cross-session reproduction\n");
process.stdout.write(`engine: ${VAULT_BIN}\n\n`);
for (const result of results) {
  if (!result.pass) {
    failed += 1;
  }
  process.stdout.write(`[${result.pass ? "PASS" : "FAIL"}] ${result.id}\n`);
  process.stdout.write(`   scenario : ${result.what}\n`);
  process.stdout.write(`   expected : ${result.expect} (${result.why})\n`);
  process.stdout.write(`   actual   : ${result.actual}${result.cacheHealed ? " (fts cache healed in place)" : ""}\n`);
  if (result.gateOutput) {
    process.stdout.write(`${result.gateOutput.split("\n").map((line) => `   | ${line}`).join("\n")}\n`);
  }
  process.stdout.write("\n");
}

if (failed > 0) {
  process.stdout.write(`${failed} of ${results.length} scenario(s) violated the gate contract.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`all ${results.length} scenario(s) hold the gate contract.\n`);
}

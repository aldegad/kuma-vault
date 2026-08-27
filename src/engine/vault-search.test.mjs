import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { formatVaultGetText, formatVaultSearchText, getVaultDocuments, searchVault } from "./vault-search.mjs";
import { buildFtsIndex } from "./vault-fts.mjs";

const execFile = promisify(execFileCallback);
const CLI_PATH = resolve(process.cwd(), "src/cli/cli.mjs");
const VAULT_BIN_PATH = resolve(process.cwd(), "bin/vault");

async function createVaultFixture() {
  const vaultDir = await mkdtemp(join(tmpdir(), "vault-search-"));

  await mkdir(join(vaultDir, "projects"), { recursive: true });
  await mkdir(join(vaultDir, "memos"), { recursive: true });
  await mkdir(join(vaultDir, "learnings"), { recursive: true });
  await mkdir(join(vaultDir, "domains", "security"), { recursive: true });

  await writeFile(
    join(vaultDir, "memos", "favorite-stack.md"),
    `---
title: Favorite Stack
created: 2026-04-20T09:00:00.000Z
updated: 2026-04-20T09:30:00.000Z
images: []
---

alpha-suite와 acme-app를 자주 같이 본다.
`,
    "utf8",
  );

  await writeFile(
    join(vaultDir, "projects", "entity-catalog.md"),
    `---
title: Entity Catalog
project: studio-alpha
owner: tookdaki
---

Plain background notes only.
`,
    "utf8",
  );

  await writeFile(
    join(vaultDir, "learnings", "plain-notes.md"),
    `---
title: General Notes
tags:
  - misc
---

Intro line before the match.
This paragraph mentions nebula-search only in body text.
Follow-up line after the body match.
`,
    "utf8",
  );

  await writeFile(
    join(vaultDir, "domains", "security", "README.md"),
    `---
title: Security
aliases:
  - vault shield
---

Vault security baseline checklist.
Never dump the full document from search results.
`,
    "utf8",
  );

  await writeFile(
    join(vaultDir, "domains", "lotus-playbook.md"),
    `---
title: Migration Playbook
project: acme-app
---

Lotus rollout notes are tracked here.
`,
    "utf8",
  );

  await writeFile(
    join(vaultDir, "domains", "persona-accounts.md"),
    `---
title: 노바 SNS/플랫폼 계정 레지스트리
aliases:
  - 내 계정
  - 내 아이디
  - 노바 계정
  - 노바링
  - novaring
  - novaring2002
---

노바(운영자)의 개인/운영 SNS 계정과 핸들 모음.
`,
    "utf8",
  );

  await writeFile(
    join(vaultDir, "learnings", "generic-id-note.md"),
    `---
title: Generic ID Note
---

아이디만 적힌 메모.
`,
    "utf8",
  );

  await writeFile(join(vaultDir, "README.md"), "# Vault Topology\n\n- [security/](domains/security/README.md)\n", "utf8");

  return vaultDir;
}

describe("vault search", () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns aggregated L1 hits with stable ids and snippets", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const result = await searchVault({
      vaultDir,
      query: "lotus",
    });

    expect(result.mode).toBe("search");
    expect(result.entityMatchCount).toBe(1);
    expect(result.contentMatchCount).toBe(1);
    expect(result.hits).toEqual([
      expect.objectContaining({
        id: "domains/lotus-playbook.md",
        path: "domains/lotus-playbook.md",
        title: "Migration Playbook",
        entityMatchCount: 1,
        contentMatchCount: 1,
      }),
    ]);

    const formatted = formatVaultSearchText(result);
    expect(formatted).toContain("# /vault search");
    expect(formatted).toContain("id: domains/lotus-playbook.md");
    expect(formatted).not.toContain("## Content Matches");
    expect(formatted).not.toContain("Lotus rollout notes are tracked here.\nLotus rollout notes are tracked here.");
  });

  it("returns explicit no matches when nothing is found", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const result = await searchVault({
      vaultDir,
      query: "does-not-exist",
    });

    expect(result.hits).toEqual([]);
    expect(formatVaultSearchText(result)).toContain("no matches");
  });

  it("distinguishes an FTS no-match from an empty search corpus", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);
    await buildFtsIndex({ vaultDir });

    const result = await searchVault({
      vaultDir,
      query: "definitely-absent-token",
      engine: "fts",
    });

    expect(result).toMatchObject({
      engine: "fts",
      corpusFiles: expect.any(Number),
      candidateFiles: 0,
      hits: [],
    });
    expect(result.corpusFiles).toBeGreaterThan(0);
    expect(result.scannedFiles).toBe(result.corpusFiles);
    const formatted = formatVaultSearchText(result);
    expect(formatted).toContain(`corpus_files: ${result.corpusFiles}`);
    expect(formatted).toContain("candidate_files: 0");
    expect(formatted).toContain("no matches");
  });

  it("fails explicitly when the scan or FTS corpus contains zero documents", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "vault-search-empty-"));
    tempDirs.push(vaultDir);

    await expect(searchVault({ vaultDir, query: "anything", engine: "scan" }))
      .rejects
      .toThrow(/search corpus is empty.*Check --vault-dir/isu);

    await buildFtsIndex({ vaultDir });
    await expect(searchVault({ vaultDir, query: "anything", engine: "fts" }))
      .rejects
      .toThrow(/FTS search corpus is empty.*vault sync --root <tree>/isu);
  });

  it("searches canonical vault memos without a separate memo backend", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const result = await searchVault({
      vaultDir,
      query: "alpha-suite",
    });

    expect(result.hits).toEqual([
      expect.objectContaining({
        id: "memos/favorite-stack.md",
        path: "memos/favorite-stack.md",
        title: "Favorite Stack",
      }),
    ]);
  });

  it("returns timeline snippets without dumping the full document", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const result = await searchVault({
      vaultDir,
      query: "nebula-search",
      mode: "timeline",
    });

    expect(result.mode).toBe("timeline");
    expect(result.hits).toEqual([
      expect.objectContaining({
        id: "learnings/plain-notes.md",
        path: "learnings/plain-notes.md",
        contentMatchCount: 1,
        snippets: [
          expect.objectContaining({
            lineNumber: 8,
            startLine: 6,
            endLine: 10,
          }),
        ],
      }),
    ]);

    const formatted = formatVaultSearchText(result);
    expect(formatted).toContain("# /vault timeline");
    expect(formatted).toContain("timeline_1: L6-L10");
    expect(formatted).toContain("L8: This paragraph mentions nebula-search only in body text.");
    expect(formatted).not.toContain("## Entity Matches");
  });

  it("preserves alias retrieval for framed natural-language queries", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const result = await searchVault({
      vaultDir,
      query: "내 노바링 아이디 알려줘",
    });

    expect(result.hits).toEqual([
      expect.objectContaining({
        id: "domains/persona-accounts.md",
        title: "노바 SNS/플랫폼 계정 레지스트리",
        entityMatchCount: 1,
      }),
    ]);
  });

  it("loads full document contents only through vault get", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const result = await getVaultDocuments({
      vaultDir,
      ids: ["domains/security", "domains/lotus-playbook.md"],
    });

    expect(result.hits).toEqual([
      expect.objectContaining({
        id: "domains/security/README.md",
        path: "domains/security/README.md",
        title: "Security",
      }),
      expect.objectContaining({
        id: "domains/lotus-playbook.md",
        path: "domains/lotus-playbook.md",
        title: "Migration Playbook",
      }),
    ]);

    const formatted = formatVaultGetText(result);
    expect(formatted).toContain("# /vault get");
    expect(formatted).toContain("Vault security baseline checklist.");
    expect(formatted).toContain("Lotus rollout notes are tracked here.");
  });

  // Exercises the distribution CLI surface (src/cli/cli.mjs) end-to-end.
  it("exposes vault-search CLI modes and vault-get at the cli.mjs level", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const { stdout: searchStdout } = await execFile("node", [
      CLI_PATH,
      "vault-search",
      "--mode",
      "search",
      "--vault-dir",
      vaultDir,
      "--query",
      "vault",
    ]);
    expect(searchStdout).toContain("# /vault search");
    expect(searchStdout).toContain("id: domains/security/README.md");
    expect(searchStdout).not.toContain("Vault security baseline checklist.\nNever dump the full document from search results.");

    const { stdout: timelineStdout } = await execFile("node", [
      CLI_PATH,
      "vault-search",
      "--mode",
      "timeline",
      "--vault-dir",
      vaultDir,
      "--query",
      "vault",
    ]);
    expect(timelineStdout).toContain("# /vault timeline");
    expect(timelineStdout).toContain("timeline_1:");

    const { stdout: getStdout } = await execFile("node", [
      CLI_PATH,
      "vault-get",
      "--vault-dir",
      vaultDir,
      "domains/security",
    ]);
    expect(getStdout).toContain("# /vault get");
    expect(getStdout).toContain("Vault security baseline checklist.");
  });

  it("parses search flags after the positional query through the bin wrapper", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const { stdout } = await execFile("bash", [
      VAULT_BIN_PATH,
      "search",
      "lotus",
      "--limit",
      "1",
      "--engine",
      "scan",
      "--format",
      "json",
      "--vault-dir",
      vaultDir,
    ]);
    const result = JSON.parse(stdout);

    expect(result).toMatchObject({
      query: "lotus",
      engine: "scan",
      limit: 1,
      corpusFiles: expect.any(Number),
      candidateFiles: expect.any(Number),
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].path).toBe("domains/lotus-playbook.md");
  });

  it("fails loudly instead of absorbing an unknown search flag into the query", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    await expect(execFile("bash", [
      VAULT_BIN_PATH,
      "search",
      "lotus",
      "--vault-dir",
      vaultDir,
      "--unknown-search-flag",
    ])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unknown option '--unknown-search-flag'"),
    });
  });

  // Exercises the bin wrapper (bin/vault) domain-page shortcut. The generic resolver maps a
  // directory to its README.md, so `vault <dir>` prints `<dir>/README.md`.
  it("keeps the vault domain shortcut working through the bin wrapper", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const { stdout } = await execFile("bash", [
      VAULT_BIN_PATH,
      "--vault-dir",
      vaultDir,
      "domains/security",
    ]);

    expect(stdout).toContain("title: Security");
    expect(stdout).toContain("Vault security baseline checklist.");
  });

  it("fails explicitly for retired sibling markdown paths", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    await expect(getVaultDocuments({ ids: ["domains/security.md"], vaultDir }))
      .rejects
      .toThrow("Vault document not found: domains/security.md");
  });

  it("scans by default when no FTS index exists, reporting the engine (self-heal, observable)", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const result = await searchVault({ vaultDir, query: "lotus" });
    expect(result.engine).toBe("scan");
    expect(result.engineReason).toBe("fts-index-absent");
    expect(result.hits.map((hit) => hit.path)).toContain("domains/lotus-playbook.md");
  });

  it("uses the FTS index once built and returns the same recall through the entry point (audit E)", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    const scan = await searchVault({ vaultDir, query: "lotus", engine: "scan" });
    await buildFtsIndex({ vaultDir });
    const auto = await searchVault({ vaultDir, query: "lotus" });

    expect(auto.engine).toBe("fts");
    expect(auto.engineReason).toBe("auto");
    // Recall parity with the scan (ordering may differ; the set for this query is identical).
    expect(auto.hits.map((hit) => hit.path).sort()).toEqual(scan.hits.map((hit) => hit.path).sort());
  });

  it("refuses to silently scan when the FTS engine is explicitly requested without an index", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);

    await expect(searchVault({ vaultDir, query: "lotus", engine: "fts" }))
      .rejects
      .toThrow(/no index exists/u);
  });

  // Exercises the FTS engine through the distribution CLI entry point after a sync build.
  it("exposes the FTS engine at the cli.mjs entry point after a sync build (audit E runtime smoke)", async () => {
    const vaultDir = await createVaultFixture();
    tempDirs.push(vaultDir);
    await buildFtsIndex({ vaultDir });

    const { stdout } = await execFile("node", [
      CLI_PATH,
      "vault-search",
      "--vault-dir",
      vaultDir,
      "--query",
      "lotus",
      "--format",
      "json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.engine).toBe("fts");
    expect(parsed.hits.map((hit) => hit.path)).toContain("domains/lotus-playbook.md");
  });
});

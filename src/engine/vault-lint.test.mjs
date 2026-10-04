import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { lintVaultFiles } from "./vault-lint.mjs";
import { rewriteIndex } from "./vault-ingest.mjs";

const execFile = promisify(execFileCallback);
const CLI_PATH = resolve(process.cwd(), "src/cli/cli.mjs");

// The tree declares its contract, as every linted tree does (lint resolves it from the root).
async function writeVaultDeclaration(vaultDir, declaration = { profile: "kuma-vault" }) {
  await writeFile(join(vaultDir, "vault.config.json"), JSON.stringify(declaration), "utf8");
}

async function writeVaultLintFixture(vaultDir) {
  await mkdir(vaultDir, { recursive: true });
  await writeVaultDeclaration(vaultDir);

  await writeFile(
    join(vaultDir, "schema.md"),
    `---
title: Kuma Wiki Schema
description: Wiki 페이지 작성 규칙과 운영 원칙
---

# Kuma Vault Schema

## Summary
fixture schema

## Directories
- domains/

## Special Files

### 1) \`dispatch-log.md\`

- **Primary writer:** \`kuma-dispatch lifecycle hook\`
- **Frontmatter type 표준:** \`type: special/dispatch-log\`

### 2) \`decisions.md\`

- **Primary writer:** \`user-direct\`
- **Frontmatter type 표준:** \`type: special/decisions\`
`,
    "utf8",
  );

  await writeFile(
    join(vaultDir, "dispatch-log.md"),
    `---
title: Dispatch Log
type: special/dispatch-log
updated: 2026-04-09T09:00:23Z
entry_format: append-only-ledger
source_of_truth: kuma-dispatch-lifecycle
boot_priority: 1
---

## Entries
- 2026-04-09T09:00:23Z | project=acme-app | task_id=nova-20260409-190014 | worker=surface:5 | qa=worker-self-report | signal=acme-app-nova-20260409-190014-done | state=dispatched
`,
    "utf8",
  );

  await writeFile(
    join(vaultDir, "decisions.md"),
    `---
title: Decisions
type: special/decisions
updated: 2026-04-09T09:00:23Z
entry_rule: explicit-user-decision-only
source_of_truth: user-direct
boot_priority: 3
---

## About

fixture

## Decisions
- [Dispatch Log](dispatch-log.md) 를 boot pack 에 포함할지 검토
`,
    "utf8",
  );

  await rewriteIndex(vaultDir);
}

describe("vault lint", () => {
  const tempRoots = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("passes fast lint across all special files within the smoke budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);

    const result = lintVaultFiles({ vaultDir, mode: "fast" });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
    expect(result.fileCount).toBe(2);
    expect(result.durationMs).toBeLessThan(100);
  });

  it("fails fast lint when a frontmatter type is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "decisions.md"),
      `---
title: Decisions
type: special/decisions
updated: 2026-04-09T09:00:23Z
entry_rule: explicit-user-decision-only
source_of_truth: user-direct
boot_priority: nope
---

## About

fixture

## Decisions
(비어 있음)
`,
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "fast" });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "decisions.md" && issue.code === "frontmatter-type-mismatch")).toBe(true);
  });

  it("passes full lint when schema, sections, and links are valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("full lint scans discovered vault markdown files when no file list is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "projects", "broken.md"),
      `---
title: Broken Project
tags: [project]
created: 2026-04-16
updated: 2026-04-16
sources: []
---

## Summary
요약만 있고 required generic sections 가 빠짐.
`,
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.ok).toBe(false);
    expect(result.fileCount).toBe(6);
    expect(result.issues.some((issue) => issue.file === "projects/broken.md" && issue.code === "missing-section")).toBe(true);
  });

  it("flags a shared owner-local bucket directly under projects/ (invariant #9)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "projects", "_evidence", "some-deal"), { recursive: true });
    await writeVaultLintFixture(vaultDir);
    await writeFile(
      join(vaultDir, "projects", "_evidence", "some-deal", "note.md"),
      "evidence stranded in a shared bucket\n",
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.issues.some((issue) =>
      issue.file === "projects/_evidence" && issue.code === "project-shared-evidence-bucket",
    )).toBe(true);
  });

  it("supports ingest follow-up lint for generic pages plus README/log", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "domains"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "domains", "security.md"),
      `---
title: Security
tags: [security]
created: 2026-04-16
updated: 2026-04-16
sources: [https://example.com/security]
---

## Summary
보안 도메인 요약.

## Details
세부 운영 원칙.

## Related
- [Dispatch Log](../dispatch-log.md) — 런타임 증적과 연결
`,
      "utf8",
    );

    await rewriteIndex(vaultDir);

    await writeFile(
      join(vaultDir, "log.md"),
      `# Kuma Vault Change Log

## 2026-04-16
- INGEST: \`security-note.md\` → \`domains/security.md\` (qa: passed)
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "fast",
      files: ["domains/security.md", "README.md", "log.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
    expect(result.fileCount).toBe(3);
  });

  it("blocks the deprecated `domain:` frontmatter field on a hand-authored leaf page", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "domains"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    // A generic leaf page that still carries the retired `domain:` field is drift and must
    // be flagged — `domain:` was deprecated 2026-07-05 (membership = path, classification = tags).
    await writeFile(
      join(vaultDir, "domains", "security.md"),
      `---
title: Security
domain: domains
tags: [security]
created: 2026-04-16
updated: 2026-04-16
sources: []
---

## Summary
보안 도메인 요약.

## Details
세부 운영 원칙.

## Related
(none)
`,
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["domains/security.md"] });

    expect(result.ok).toBe(false);
    const issue = result.issues.find(
      (i) => i.file === "domains/security.md" && i.code === "deprecated-frontmatter-domain",
    );
    expect(issue).toBeTruthy();
    // the message must spell out WHY (deprecated, dated), and the replacement rule
    // (membership = 경로/path, cross-cutting = tags) so a future edit can't silently gut it
    expect(issue.message).toContain("deprecated");
    expect(issue.message).toContain("2026-07-05");
    expect(issue.message).toContain("경로");
    expect(issue.message).toContain("tags");
    // the retired "domain is required" rule must never fire again
    expect(result.issues.some((i) => i.code === "missing-frontmatter-domain")).toBe(false);
  });

  it("blocks the deprecated `domain:` field across non-generic hand-authored page types", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "learnings"), { recursive: true });
    await mkdir(join(vaultDir, "calendar"), { recursive: true });
    await mkdir(join(vaultDir, "memos"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    // A learning page still carrying the retired field.
    await writeFile(
      join(vaultDir, "learnings", "flaky-tests.md"),
      `---
title: Flaky tests RCA
domain: learnings
tags: [testing]
created: 2026-04-16
updated: 2026-04-16
---

## Summary
정리한 원인 분석.
`,
      "utf8",
    );
    // A calendar EVENT page (the reachable calendar path) still carrying the retired field.
    await writeFile(
      join(vaultDir, "calendar", "2026-05-07-event.md"),
      `---
title: Example Event
date: 2026-05-07
type: deadline
domain: calendar
---

# Example Event

## 핵심
event body
`,
      "utf8",
    );
    // A memo page still carrying the retired field.
    await writeFile(
      join(vaultDir, "memos", "quick.md"),
      `---
title: Quick memo
domain: memos
images: []
created: 2026-04-16T09:00:00+09:00
updated: 2026-04-16T09:00:00+09:00
---

메모 본문.
`,
      "utf8",
    );

    const files = ["learnings/flaky-tests.md", "calendar/2026-05-07-event.md", "memos/quick.md"];
    const result = lintVaultFiles({ vaultDir, mode: "full", files });

    for (const file of files) {
      expect(result.issues.some(
        (i) => i.file === file && i.code === "deprecated-frontmatter-domain",
      )).toBe(true);
    }
    // the retired domain==calendar match rule must never fire again
    expect(result.issues.some((i) => i.code === "frontmatter-domain-mismatch")).toBe(false);
  });

  it("blocks the deprecated `domain:` field on README/index pages (routed via lintReadmePage)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "domains", "engineering"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    // A category-index README carries frontmatter too; it must not silently re-introduce the
    // retired field. These `domains/*/README.md` pages dispatch to lintReadmePage before the
    // per-type lint, so the block has to live there — this locks that path in.
    await writeFile(
      join(vaultDir, "domains", "engineering", "README.md"),
      `---
title: Engineering
domain: engineering
tags: [category-index]
created: 2026-04-25
updated: 2026-04-25
---

# Engineering

## Summary
엔지니어링 도메인.

<!-- vault-index:start -->
<!-- vault-index:end -->
`,
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "full", files: ["domains/engineering/README.md"] });

    expect(result.issues.some(
      (i) => i.file === "domains/engineering/README.md" && i.code === "deprecated-frontmatter-domain",
    )).toBe(true);
  });

  it("accepts calendar event pages with the calendar-specific contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "calendar"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "calendar", "2026-05-07-event.md"),
      `---
title: Example Event
date: 2026-05-07
type: deadline
---

# Example Event

## 핵심
event body
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["calendar/2026-05-07-event.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("accepts category index pages without forcing generic Details sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "domains", "tools"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "domains", "tools", "README.md"),
      `---
title: Tools
tags: [tools, category-index]
created: 2026-04-25
updated: 2026-04-25
---

# Tools

## Summary
도구 카테고리.

## Sub-pages
- item

## Vault Index

<!-- vault-index:start -->

<!-- vault-index:end -->
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["domains/tools/README.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("accepts persona memory pages the tree declares, with the persona-memory contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "domains"), { recursive: true });
    await writeVaultLintFixture(vaultDir);
    await writeVaultDeclaration(vaultDir, { profile: "kuma-vault", personaMemoryPages: ["domains/nova.md"] });

    await writeFile(
      join(vaultDir, "domains", "nova.md"),
      `---
title: 노바 (Nova) — 본인 기억
type: domain
slug: nova
updated: 2026-05-25T02:15:00.000+09:00
boot_priority: 3
---

## About
persona memory

## Timeline
- 2026-05-25 — memory entry
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["domains/nova.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  // A top-level domains/<name>.md is a persona-memory page only when the tree declares it
  // (vault.config.json personaMemoryPages). No page shape tells the two apart: the misplaced
  // topic page and the persona page below have the same shape, and a slug equal to the file
  // name is how this kind of tree writes every page that carries a slug.
  it("judges top-level domain pages by the tree's persona declaration, the same as the fixed list did", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "domains", "gardening"), { recursive: true });
    await writeVaultLintFixture(vaultDir);
    await mkdir(join(vaultDir, "domains", "cooking")); // after the fixture, which gives every folder a README
    await writeFile(
      join(vaultDir, "domains", "gardening", "README.md"),
      "---\ntitle: Gardening\ntags: [g]\n---\n\n## Summary\ng\n",
      "utf8",
    );

    const page = (title, slugLine, body) => `---\ntitle: ${title}\ntype: domain\n${slugLine}updated: 2026-05-25\n---\n\n${body}\n`;
    // Misplaced topic page in the persona shape, slug = file name.
    await writeFile(join(vaultDir, "domains", "topic-y.md"), page("Topic Y", "slug: topic-y\n", "## About\ny\n\n## Timeline\n- 2026-05-25 — y"), "utf8");
    // Misplaced reference page, slug = file name.
    await writeFile(join(vaultDir, "domains", "widget-x.md"), page("Widget X", "slug: widget-x\n", "## Summary\nx\n\n## Details\nx\n\n## Sources\nx"), "utf8");
    // Misplaced page without a slug.
    await writeFile(join(vaultDir, "domains", "topic-z.md"), page("Topic Z", "", "## Summary\nz\n\n## Details\nz"), "utf8");
    // The persona page.
    await writeFile(join(vaultDir, "domains", "nova.md"), page("Nova", "slug: nova\n", "## About\nn\n\n## Timeline\n- 2026-05-25 — n"), "utf8");

    const INDEX_CODES = new Set(["unreachable-vault-page", "vault-index-region-stale", "missing-vault-index-region"]);
    const verdicts = async (declaration) => {
      await writeVaultDeclaration(vaultDir, declaration);
      const result = lintVaultFiles({ vaultDir, mode: "full" });
      const byFile = {};
      for (const issue of result.issues) {
        // The fixture leaves the vault-index regions unwritten; index and reachability are judged elsewhere.
        if (!issue.file?.startsWith("domains/") || INDEX_CODES.has(issue.code)) continue;
        (byFile[issue.file] ??= []).push(issue.code);
      }
      return Object.fromEntries(Object.entries(byFile).map(([file, codes]) => [file, codes.sort()]));
    };

    // Each misplaced page as the built-in name list judged it: drift plus the generic page contract.
    const drift = (...missingSections) => [
      "domain-top-level-drift",
      "frontmatter-created-format",
      "frontmatter-tags-format",
      ...missingSections,
    ];
    const misplaced = {
      "domains/topic-y.md": drift("missing-section", "missing-section", "missing-section"),
      "domains/widget-x.md": drift("missing-section"),
      "domains/topic-z.md": drift("missing-section"),
    };
    const categoryDrift = {
      "domains/cooking": ["domain-category-dir-drift", "domain-folder-index-missing"],
    };

    // No persona page declared (the default): every top-level page is drift, the persona-shaped ones too.
    expect(await verdicts({ profile: "kuma-vault" })).toEqual({
      ...categoryDrift,
      ...misplaced,
      "domains/nova.md": drift("missing-section", "missing-section", "missing-section"),
    });
    // The declared page takes the persona contract and passes; the others stay drift.
    expect(await verdicts({ profile: "kuma-vault", personaMemoryPages: ["domains/nova.md"] })).toEqual({
      ...categoryDrift,
      ...misplaced,
    });
    // A declared page is linted with the persona contract, whatever it holds.
    expect(await verdicts({ profile: "kuma-vault", personaMemoryPages: ["domains/nova.md", "domains/widget-x.md"] })).toEqual({
      ...categoryDrift,
      "domains/topic-y.md": misplaced["domains/topic-y.md"],
      "domains/topic-z.md": misplaced["domains/topic-z.md"],
      "domains/widget-x.md": ["missing-section", "missing-section"],
    });
  });

  it("accepts learning pages with the learning-specific contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "learnings"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "learnings", "vault-search.md"),
      `---
name: vault-search
tags: [vault, search]
created: "2026-05-29T14:24:00.000Z"
---

# Vault Search

search implementation note
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["learnings/vault-search.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("ignores escaped bracket notation followed by parentheses", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "projects", "timeline.md"),
      `---
title: Timeline
tags: [timeline]
created: 2026-05-29
updated: 2026-05-29
sources: []
---

## Summary
Escaped list markers are prose, not links.

## Details
\\[1\\] 서버 정리 → \\[2\\] 재시작 (설명용 괄호)

## Related
- [Dispatch Log](../dispatch-log.md)
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["projects/timeline.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("accepts lesson pages with the lesson-specific contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "lessons"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "lessons", "vault-links.md"),
      `---
title: Vault Links
type: lesson
created: 2026-05-29
tags: [vault]
---

# Vault Links

검증된 링크만 유지한다.
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["lessons/vault-links.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("ignores markdown links inside inline and fenced code examples", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "projects", "examples.md"),
      `---
title: Examples
tags: [examples]
created: 2026-05-29
updated: 2026-05-29
sources: []
---

## Summary
Use \`[Missing](missing.md)\` as an example only.

## Details
\`\`\`md
[Missing Too](missing-too.md)
\`\`\`

## Related
- [Dispatch Log](../dispatch-log.md)
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["projects/examples.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("accepts canonical memo pages with memo-specific schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "memos"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "memos", "favorite.md"),
      `---
title: Favorite
created: 2026-04-16T09:00:00.000Z
updated: 2026-04-16T09:30:00.000Z
images: ["memo.png"]
---

자주 보는 메모.
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["memos/favorite.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("accepts canonical pages with block-array sources and explicit Details/Related sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "projects", "analytics.md"),
      `---
title: Analytics
tags: [analytics]
created: 2026-04-16
updated: 2026-04-16
sources:
  - https://example.com/analytics
---

## Summary
요약.

## Details
세부.

## Related
- [Dispatch Log](../dispatch-log.md) — runtime evidence
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["projects/analytics.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("rejects memo pages that miss the memo-specific frontmatter contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "memos"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "memos", "broken.md"),
      `---
title: Broken
created: 2026-04-16
---

누락된 메모.
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["memos/broken.md"],
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "memos/broken.md" && issue.code === "frontmatter-updated-format")).toBe(true);
    expect(result.issues.some((issue) => issue.file === "memos/broken.md" && issue.code === "frontmatter-images-format")).toBe(true);
  });

  it("reports legacy ingest markers inside project summary pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "projects", "acme-app.md"),
      `---
title: acme-app 프로젝트 지식
tags: [studio]
created: 2026-04-16
updated: 2026-04-16
sources: []
---

## Summary
에이콤 요약.

## Details
<!-- ingest:qa-auto-ingest:start -->
legacy result merge
<!-- ingest:qa-auto-ingest:end -->

## Related
(비어 있음)
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["projects/acme-app.md"],
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "projects/acme-app.md" && issue.code === "project-ingest-marker")).toBe(true);
  });

  it("reports result archives leaking into project summary frontmatter sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "projects", "acme-app.md"),
      `---
title: acme-app 프로젝트 지식
tags: [studio]
created: 2026-04-16
updated: 2026-04-16
sources: ["results/qa-auto-ingest.result.md"]
---

## Summary
에이콤 요약.

## Details
현재 상태.

## Related
(비어 있음)
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["projects/acme-app.md"],
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "projects/acme-app.md" && issue.code === "project-result-sources")).toBe(true);
  });

  it("reports managed skill documents staged in inbox as drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "inbox"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "inbox", "kuma-vault.md"),
      `---
title: kuma:vault
tags: []
created: 2026-04-16
updated: 2026-04-16
sources: []
source: skills/kuma-vault
---

managed skill mirror
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "inbox/kuma-vault.md" && issue.code === "managed-skill-inbox")).toBe(true);
  });

  it("reports top-level domain pages outside registered categories", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "domains"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "domains", "loose-topic.md"),
      `---
title: Loose Topic
tags: [loose]
created: 2026-05-29
updated: 2026-05-29
sources: []
---

## Summary
loose

## Details
loose

## Related
(none)
`,
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "domains/loose-topic.md" && issue.code === "domain-top-level-drift")).toBe(true);
  });

  it("reports domain folders that lack README entry points", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "domains", "research", "widget", "faq"), { recursive: true });
    await writeVaultLintFixture(vaultDir);
    await rm(join(vaultDir, "domains", "research", "widget", "faq", "README.md"), { force: true });

    await writeFile(
      join(vaultDir, "domains", "research.md"),
      `---
title: Research
tags: [research]
created: 2026-05-29
updated: 2026-05-29
---

## Summary
research

## Sub-pages
entries
`,
      "utf8",
    );
    await writeFile(join(vaultDir, "domains", "research", "widget.md"), "# Widget\n", "utf8");
    await writeFile(join(vaultDir, "domains", "research", "widget", "faq", "answer.md"), "# Answer\n", "utf8");

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "domains/research/widget/faq" && issue.code === "domain-folder-index-missing")).toBe(true);
  });

  it("reports legacy raw memo artifacts as canonical drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "raw", "memos", "images"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await Promise.all([
      writeFile(
        join(vaultDir, "raw", "memos", "favorite.md"),
        "---\ntitle: Favorite\ncreated: 2026-04-16T09:00:00.000Z\nupdated: 2026-04-16T09:30:00.000Z\nimages: [favorite.png]\n---\n\nmemo\n",
        "utf8",
      ),
      writeFile(join(vaultDir, "raw", "memos", "images", "favorite.png"), "png", "utf8"),
    ]);

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "raw/memos" && issue.code === "legacy-raw-memos")).toBe(true);
  });

  it("treats result archives as archive evidence instead of generic knowledge pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "results"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "results", "qa-pass.result.md"),
      `---
id: qa-pass
status: done
worker: surface:1
---

# QA PASS

- summary only archive evidence
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["results/qa-pass.result.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("reports schema/runtime special-file set mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "schema.md"),
      `---
title: Kuma Wiki Schema
description: Wiki 페이지 작성 규칙과 운영 원칙
---

# Kuma Wiki Schema

## Special Files

### 1) \`dispatch-log.md\`

- **Primary writer:** \`kuma-dispatch lifecycle hook\`
- **Frontmatter type 표준:** \`type: special/dispatch-log\`

### 2) \`legacy-skill-sync.md\`

- **Primary writer:** \`legacy skill sync\`
- **Frontmatter type 표준:** \`type: special/legacy\`
`,
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "schema.md" && issue.code === "schema-runtime-special-file-mismatch")).toBe(true);
  });

  it("accepts the canonical schema page when linted directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "schema.md"),
      `---
title: Kuma Vault Schema
description: Vault contract
updated: 2026-04-23
---

# Kuma Vault Schema

## Summary
contract summary

## Directories
- domains/

## Special Files

### 1) \`dispatch-log.md\`
- Primary writer: \`kuma-dispatch lifecycle hook\`

### 2) \`decisions.md\`
- Primary writer: \`user-direct\`
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["schema.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("reports top-level managed skill pages as domain tree drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "domains"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "domains", "kuma-vault.md"),
      `---
title: /vault
source: skills/kuma-vault
sourcePath: /Users/test/.claude/skills/kuma-vault/SKILL.md
---

# /vault

legacy skill mirror body
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "domains/kuma-vault.md" && issue.code === "domain-top-level-drift")).toBe(true);
  });

  it("accepts operational rule pages with the operational-rules contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "operational-rules"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "operational-rules", "code-hygiene.md"),
      `---
title: Code Hygiene Rules
source: migration
last_verified: 2026-04-09
tags: [code, hygiene]
---

# Code Hygiene Rules

## Summary
요약.

## Rules
1. stale fallback 금지

## Related
- [Dispatch Log](../dispatch-log.md) — runtime evidence
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["operational-rules/code-hygiene.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("accepts project decision pages with the dedicated project-decisions contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "projects", "acme-app.project-decisions.md"),
      `---
title: acme-app Project Decisions
type: special/project-decisions
project: acme-app
updated: 2026-04-23T01:00:00.000Z
boot_priority: 3
---

## About
결정 SSOT.

## Decisions
- 하나의 truth만 유지한다.
`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["projects/acme-app.project-decisions.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("treats nested project reference docs as non-canonical reference pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "projects", "widget", "faq"), { recursive: true });
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "projects", "widget", "faq", "tls.md"),
      `# TLS FAQ\n\nreference body only\n`,
      "utf8",
    );

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["projects/widget/faq/tls.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
  });

  it("fails full lint when a required section is missing and a link is broken", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "decisions.md"),
      `---
title: Decisions
type: special/decisions
updated: 2026-04-09T09:00:23Z
entry_rule: explicit-user-decision-only
source_of_truth: user-direct
boot_priority: 3
---

## About

- [Missing Page](missing-page.md) 확인 필요
`,
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.file === "decisions.md" && issue.code === "missing-section")).toBe(true);
    expect(result.issues.some((issue) => issue.file === "decisions.md" && issue.code === "broken-link")).toBe(true);
  });

  // Regression: base64 `data:` inline images (and any other non-file URI scheme —
  // mailto:, tel:, http(s):, obsidian:) must never be resolved as relative files
  // and reported as dead links. This was a large false-positive class on docs
  // trees that embed inline images. The scheme exclusion must NOT disable dead-link
  // detection for genuine relative paths.
  it("skips data: URIs and other non-file URI schemes in the broken-link check", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);

    await writeFile(
      join(vaultDir, "decisions.md"),
      `---
title: Decisions
type: special/decisions
updated: 2026-04-09T09:00:23Z
entry_rule: explicit-user-decision-only
source_of_truth: user-direct
boot_priority: 3
---

## About

- inline image: ![chart](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)
- contact: [mail](mailto:user@example.com), [call](tel:+821012345678)
- external: [site](https://example.com), [note](obsidian://open?vault=x)

## Decisions

- broken relative link is still caught: [gone](missing-page.md)
`,
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    const brokenLinks = result.issues.filter(
      (issue) => issue.file === "decisions.md" && issue.code === "broken-link",
    );

    // No non-file URI scheme may be flagged as a dead relative link.
    expect(brokenLinks.some((issue) => /data:/u.test(issue.message))).toBe(false);
    expect(brokenLinks.some((issue) => /mailto:|tel:|https:|obsidian:/u.test(issue.message))).toBe(false);
    // A genuine relative link to a missing file is still reported — and it is the
    // ONLY broken-link, proving the scheme exclusion did not silence real dead links.
    expect(brokenLinks.some((issue) => /missing-page\.md/u.test(issue.message))).toBe(true);
    expect(brokenLinks).toHaveLength(1);
  });

  // Exercises the distribution vault-lint CLI (JSON output + exit code).
  it("exposes the vault-lint CLI as JSON and returns exit 0 on success", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-lint-"));
    tempRoots.push(root);

    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);
    // The CLI resolves the tree's contract from its own root declaration (repo
    // self-declaration; an undeclared explicit root would fail loud).
    await writeFile(join(vaultDir, "vault.config.json"), JSON.stringify({ profile: "kuma-vault" }), "utf8");

    const { stdout } = await execFile("node", [CLI_PATH, "vault-lint", "--mode", "full", "--vault-dir", vaultDir, "--json"]);

    const payload = JSON.parse(stdout);
    expect(payload.ok).toBe(true);
    expect(payload.fileCount).toBe(4);
  });
});

describe("vault reachability topology lint (DEC-J)", () => {
  const tempRoots = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const TOPOLOGY_CODES = new Set([
    "unreachable-vault-page",
    "broken-link",
    "out-of-root",
    "case-mismatch",
    "vault-index-region-stale",
    "missing-vault-index-region",
    "missing-root-readme",
  ]);

  const contentPage = (title) => `---
title: ${title}
tags: [topology]
created: 2026-04-25
updated: 2026-04-25
---

# ${title}

## Summary
fixture summary

## Details
fixture details

## Related
- none
`;

  async function buildTopologyVault(root) {
    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);
    await mkdir(join(vaultDir, "domains", "security"), { recursive: true });
    await writeFile(join(vaultDir, "domains", "security", "baseline.md"), contentPage("Security Baseline"), "utf8");
    await rewriteIndex(vaultDir);
    return vaultDir;
  }

  // Inject an extra bullet into a README's generated vault-index region.
  async function injectRegionBullet(readmePath, bullet) {
    const contents = await readFile(readmePath, "utf8");
    await writeFile(
      readmePath,
      contents.replace("<!-- vault-index:end -->", `${bullet}\n<!-- vault-index:end -->`),
      "utf8",
    );
  }

  it("passes a clean generated topology with no reachability/region issues", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.issues.filter((issue) => TOPOLOGY_CODES.has(issue.code))).toEqual([]);
  });

  it("flags a navigable page that no README index region links to (orphan)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);
    // New page added without regenerating regions → not in any nav region.
    await writeFile(join(vaultDir, "domains", "security", "orphan.md"), contentPage("Orphan"), "utf8");

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.issues.some((issue) =>
      issue.file === "domains/security/orphan.md" && issue.code === "unreachable-vault-page")).toBe(true);
  });

  it("exempts owner-local bucket pages (_evidence/_sources/_assets) from reachability (DEC step 12)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);
    // A file-back evidence dump with NO README nav chain — exactly the kordoc-eval case.
    await mkdir(join(vaultDir, "domains", "security", "_evidence", "some-eval"), { recursive: true });
    await writeFile(
      join(vaultDir, "domains", "security", "_evidence", "some-eval", "sample-output.md"),
      contentPage("Sample Output"),
      "utf8",
    );
    // A nested underscore bucket (bucket-under-asset-dir) is exempt too.
    await mkdir(join(vaultDir, "domains", "security", "_sources", "raw-2026"), { recursive: true });
    await writeFile(
      join(vaultDir, "domains", "security", "_sources", "raw-2026", "snapshot.md"),
      contentPage("Snapshot"),
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    const unreachable = result.issues.filter((issue) => issue.code === "unreachable-vault-page");
    expect(unreachable.some((issue) => issue.file.split("/").some((seg) => seg.startsWith("_")))).toBe(false);
    // The bucket files are never even walked as reachability candidates.
    expect(unreachable.map((issue) => issue.file)).not.toContain(
      "domains/security/_evidence/some-eval/sample-output.md",
    );
  });

  it("still flags a non-bucket orphan when an owner-local bucket sibling exists (scope proof)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);
    // Owner-local evidence (exempt) …
    await mkdir(join(vaultDir, "domains", "security", "_evidence"), { recursive: true });
    await writeFile(
      join(vaultDir, "domains", "security", "_evidence", "note.md"),
      contentPage("Evidence Note"),
      "utf8",
    );
    // … next to a genuine navigable page that no region links to (real drift).
    await writeFile(join(vaultDir, "domains", "security", "orphan.md"), contentPage("Orphan"), "utf8");

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    const unreachable = result.issues.filter((issue) => issue.code === "unreachable-vault-page");
    expect(unreachable.map((issue) => issue.file)).toContain("domains/security/orphan.md");
    expect(unreachable.map((issue) => issue.file)).not.toContain("domains/security/_evidence/note.md");
  });

  it("keeps lint and the index generator in lockstep on non-nav slots (no bucket-README stale, no bucket subdir in a parent's expected region — step 13)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);

    // A leftover bucket README with a STALE (ghost) index region — exactly what a
    // pre-fix sync would have minted before buckets were excluded. The generator no
    // longer maintains it, so lint must not demand regeneration (else the two
    // builders contradict). Also seed an evidence doc so the bucket has real content.
    await mkdir(join(vaultDir, "domains", "security", "_evidence", "eval-1"), { recursive: true });
    await writeFile(
      join(vaultDir, "domains", "security", "_evidence", "eval-1", "sample.md"),
      contentPage("Sample"),
      "utf8",
    );
    await writeFile(
      join(vaultDir, "domains", "security", "_evidence", "README.md"),
      "---\ntitle: Evidence\nstatus: active\n---\n\n# Evidence\n\n## Vault Index\n\n"
        + "<!-- vault-index:start -->\n- [ghost](ghost.md) — stale leftover from a pre-fix sync\n<!-- vault-index:end -->\n",
      "utf8",
    );

    // Regenerate the topology the way sync does. The generator excludes the bucket,
    // so the owning README must NOT link `_evidence/`.
    await rewriteIndex(vaultDir);
    const securityReadme = await readFile(join(vaultDir, "domains", "security", "README.md"), "utf8");
    expect(securityReadme).not.toContain("_evidence");

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    // The bucket README (its ghost region, broken link and all) is exempt from the
    // nav index-region contract — zero findings against it.
    expect(result.issues.some((issue) => issue.file === "domains/security/_evidence/README.md")).toBe(false);
    // The owner is NOT flagged stale for omitting the bucket subdir: lint's expected
    // region and the generator agree that the bucket is non-nav.
    expect(result.issues.some((issue) =>
      issue.file === "domains/security/README.md" && issue.code === "vault-index-region-stale")).toBe(false);
  });

  it("does not flag a region stale when a page title puts `]` inside the link label", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);

    // Mail-subject style title. A naive [^\]]+ label class stops at the inner `]`,
    // silently drops this line from the actual link set, and mis-flags the
    // generator's own freshly-written region as stale.
    await writeFile(
      join(vaultDir, "domains", "security", "mail.md"),
      contentPage("메일 원문 — [미머디] 소셜매치 개발 제안 요청서 첨부의 건"),
      "utf8",
    );
    await rewriteIndex(vaultDir);

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.issues.some((issue) =>
      issue.file === "domains/security/README.md" && issue.code === "vault-index-region-stale")).toBe(false);
    // The reachability walker must also see the bracketed-label link as a nav edge.
    expect(result.issues.some((issue) =>
      issue.file === "domains/security/mail.md" && issue.code === "unreachable-vault-page")).toBe(false);
  });

  it("flags a navigation link to a missing target (dead nav-link)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);
    await injectRegionBullet(join(vaultDir, "domains", "security", "README.md"), "- [ghost](ghost.md)");

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.issues.some((issue) =>
      issue.file === "domains/security/README.md" && issue.code === "broken-link")).toBe(true);
  });

  it("flags a navigation link that escapes the vault root (out-of-root)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);
    // Real file that exists, but outside the vault root.
    await writeFile(join(root, "outside.md"), "# outside the vault\n", "utf8");
    await injectRegionBullet(join(vaultDir, "README.md"), "- [escape](../outside.md)");

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.issues.some((issue) =>
      issue.file === "README.md" && issue.code === "out-of-root")).toBe(true);
  });

  it("rejects a navigation link whose path case does not match disk (case-mismatch)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);
    // baseline.md exists; BASELINE.md differs only in case.
    await injectRegionBullet(join(vaultDir, "domains", "security", "README.md"), "- [dup](BASELINE.md)");

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    // Case-insensitive FS (macOS) → case-mismatch; case-sensitive FS → broken-link.
    // Either outcome proves the wrong-case navigation link is rejected.
    expect(result.issues.some((issue) =>
      issue.file === "domains/security/README.md"
      && (issue.code === "case-mismatch" || issue.code === "broken-link"))).toBe(true);
  });

  it("resolves a symlinked vault root without false out-of-root or unreachable issues (symlink-root)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);
    const linkedVault = join(root, "vault-symlink");
    await symlink(vaultDir, linkedVault);

    const result = lintVaultFiles({ vaultDir: linkedVault, mode: "full" });

    expect(result.issues.some((issue) =>
      ["out-of-root", "missing-root-readme", "unreachable-vault-page"].includes(issue.code))).toBe(false);
  });

  it("flags a README index region that no longer matches its folder (stale-region)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-reach-"));
    tempRoots.push(root);
    const vaultDir = await buildTopologyVault(root);
    // New child added without regeneration → region link set drifts from folder.
    await writeFile(join(vaultDir, "domains", "security", "added.md"), contentPage("Added"), "utf8");

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.issues.some((issue) =>
      issue.file === "domains/security/README.md" && issue.code === "vault-index-region-stale")).toBe(true);
  });
});

describe("plans slot delegation to plan-lint (vault-compiler step 1)", () => {
  const tempRoots = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  // A deliberately drift-heavy plans/ subtree: no canonical frontmatter (domain/tags/dates),
  // no required knowledge-page sections, a retired flat index.md, an orphan page unreachable
  // from any README nav region, and a body cross-reference that would be a broken link if the
  // canonical-page contract were applied. vault-lint must emit ZERO findings for all of it —
  // the plan contract belongs to `kuma plan lint`.
  async function writeDriftHeavyPlans(vaultDir) {
    const plansDir = join(vaultDir, "plans", "acme-app");
    await mkdir(plansDir, { recursive: true });
    // Retired flat index.md — would trigger legacy-index-file under the vault contract.
    await writeFile(join(vaultDir, "plans", "index.md"), "# plans index\n", "utf8");
    // Plan doc with plan-shaped frontmatter (no domain/tags/created/updated) and no
    // knowledge-page sections; body links to a sibling the vault contract would resolve.
    await writeFile(
      join(plansDir, "some-plan.md"),
      `---
title: Some Plan
status: active
plan_owner: nova
---

## Task Card

goal text

## Next

- [ ] [1] do a thing — see [neighbor](./ghost-neighbor.md)
`,
      "utf8",
    );
    // Orphan plan doc: never linked from any README index region.
    await writeFile(
      join(plansDir, "orphan-plan.md"),
      `---
title: Orphan Plan
status: active
---

## Next

- [ ] [1] orphan step
`,
      "utf8",
    );
  }

  it("emits zero findings for a drift-heavy plans/ subtree (full lint)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-plans-"));
    tempRoots.push(root);
    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);
    await writeDriftHeavyPlans(vaultDir);

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    const plansIssues = result.issues.filter((issue) =>
      String(issue.file ?? "").split("/")[0] === "plans");
    expect(plansIssues).toEqual([]);
    // The delegated slot pages are never even walked as lintable knowledge files.
    expect(result.files.some((entry) => String(entry.file ?? "").split("/")[0] === "plans")).toBe(false);
  });

  it("leaves non-plans findings unchanged when a plans/ subtree is added", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-plans-"));
    tempRoots.push(root);
    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);

    const before = lintVaultFiles({ vaultDir, mode: "full" });
    await writeDriftHeavyPlans(vaultDir);
    const after = lintVaultFiles({ vaultDir, mode: "full" });

    const codeCounts = (result) => {
      const counts = {};
      for (const issue of result.issues) {
        counts[issue.code] = (counts[issue.code] ?? 0) + 1;
      }
      return counts;
    };
    expect(codeCounts(after)).toEqual(codeCounts(before));
  });

  it("delegates an explicitly requested plan file to plan-lint (no findings)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-plans-"));
    tempRoots.push(root);
    const vaultDir = join(root, "vault");
    await writeVaultLintFixture(vaultDir);
    await writeDriftHeavyPlans(vaultDir);

    const result = lintVaultFiles({
      vaultDir,
      mode: "full",
      files: ["plans/acme-app/some-plan.md"],
    });

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

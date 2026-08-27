import { existsSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import {
  analyzeDocumentRouting,
  extractIndexStructure,
  formatFrontmatterValue,
  ingestGenericSource,
  ingestInbox,
  ingestResultFile,
  ingestResultFileWithGuards,
  parseFrontmatterDocument,
  resolveResultPathForTaskId,
  rewriteIndex,
  syncVaultIndex,
} from "./vault-ingest.mjs";

const execFile = promisify(execFileCallback);
const CLI_PATH = join(process.cwd(), "src/cli/cli.mjs");

async function createResultFile(dir, name, content) {
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

describe("inline-array frontmatter codec (formatFrontmatterValue <-> parseFrontmatterDocument)", () => {
  it("round-trips array items carrying internal double-quotes or backslashes (writer JSON-encodes, reader JSON-decodes)", () => {
    const aliases = ['C++ "smart" pointers', "foo\\bar", "C:\\Users\\alex", "plain phrase", "RAII", "한글 별칭"];
    const doc = `---\ntitle: T\naliases: ${formatFrontmatterValue(aliases)}\n---\n\nbody\n`;
    const { frontmatter } = parseFrontmatterDocument(doc);
    expect(frontmatter.aliases).toEqual(aliases);
  });

  it("still unwraps hand-authored single-quoted items and leaves barewords untouched", () => {
    const { frontmatter } = parseFrontmatterDocument("---\ntags: [cli, 'hand written', rust]\n---\n\nbody\n");
    expect(frontmatter.tags).toEqual(["cli", "hand written", "rust"]);
  });
});

describe("vault-ingest", () => {
  it("archives a result file by default and leaves the project summary page untouched", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-ingest-"));
    const vaultDir = join(tempRoot, "vault");
    const taskDir = join(tempRoot, "tasks");
    const resultDir = join(tempRoot, "results");

    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await mkdir(resultDir, { recursive: true });

    await writeFile(
      join(vaultDir, "projects", "acme-app.md"),
      `---
title: acme-app 프로젝트 지식
tags: [studio]
created: 2026-04-07
updated: 2026-04-07
sources: []
---

## Summary
에이콤 프로젝트 누적 지식.

## Details
(작업 결과 ingest 시 자동 누적)

## Related
(교차참조 추가 예정)
`,
      "utf8",
    );

    const resultPath = await createResultFile(
      resultDir,
      "vault-ingest-pipeline.result.md",
      `---
id: vault-ingest-pipeline
status: done
worker: surface:8
qa: surface:7
---

# Vault ingest 파이프라인 구현

## 변경 사항
- ingest CLI 추가
- index/log 자동 갱신
`,
    );

    await writeFile(
      join(taskDir, "vault-ingest-pipeline.task.md"),
      `---
id: vault-ingest-pipeline
project: acme-app
worker: surface:8
qa: surface:7
result: ${resultPath}
---
`,
      "utf8",
    );

    const first = await ingestResultFile({
      resultPath,
      vaultDir,
      taskDir,
      qaStatus: "passed",
    });

    expect(first.action).toBe("ARCHIVE");
    expect(first.relativeArchivePath).toBe("results/vault-ingest-pipeline.result.md");
    expect(first.relativePagePath).toBeUndefined();

    const pageAfterFirstIngest = await readFile(join(vaultDir, "projects", "acme-app.md"), "utf8");
    expect(pageAfterFirstIngest).not.toContain("<!-- ingest:vault-ingest-pipeline.result.md:start -->");
    expect(pageAfterFirstIngest).not.toContain("Vault ingest 파이프라인 구현");
    expect(pageAfterFirstIngest).toContain("sources: []");
    // `domain:` is deprecated (2026-07-05) — an archive-only ingest must not add it to the page.
    expect(pageAfterFirstIngest).not.toContain("domain:");
    expect(await readFile(join(vaultDir, "results", "vault-ingest-pipeline.result.md"), "utf8")).toContain("Vault ingest 파이프라인 구현");

    const readmeContent = await readFile(join(vaultDir, "README.md"), "utf8");
    expect(readmeContent).toContain("[projects/](projects/README.md)");
    expect(readmeContent).toContain("[results/](results/README.md)");
    // The retired flat cross-reference dump is no longer mirrored onto the root.
    expect(readmeContent).not.toContain("## Cross References");
    expect(readmeContent).not.toContain("(archived result evidence)");

    const logContent = await readFile(join(vaultDir, "log.md"), "utf8");
    expect(logContent).toContain("ARCHIVE: `vault-ingest-pipeline.result.md` → `results/vault-ingest-pipeline.result.md`");
  });

  it("creates a new learning page when an explicit canonical target is provided", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-ingest-"));
    const vaultDir = join(tempRoot, "vault");
    const resultDir = join(tempRoot, "results");

    await mkdir(resultDir, { recursive: true });

    const resultPath = await createResultFile(
      resultDir,
      "debug-playwright-timeouts.result.md",
      `---
task: debug-playwright-timeouts
status: done
---

# Playwright timeout 디버깅

첫 번째 재현 케이스를 정리하고 flaky 패턴을 기록했다.
`,
    );

    const result = await ingestResultFile({
      resultPath,
      vaultDir,
      taskDir: join(tempRoot, "missing-tasks"),
      qaStatus: "passed",
      section: "learnings",
    });

    expect(result.relativePagePath).toBe("learnings/debug-playwright-timeouts.md");
    expect(result.relativeArchivePath).toBe("results/debug-playwright-timeouts.result.md");

    const pageContent = await readFile(join(vaultDir, "learnings", "debug-playwright-timeouts.md"), "utf8");
    const parsed = parseFrontmatterDocument(pageContent);
    expect(parsed.frontmatter.title).toBe("Playwright timeout 디버깅");
    // ingest no longer stamps the deprecated `domain:` field (2026-07-05 폐기 결정).
    expect(parsed.frontmatter.domain).toBeUndefined();
    expect(parsed.body).toContain("Playwright timeout 디버깅");
    expect(await readFile(join(vaultDir, "results", "debug-playwright-timeouts.result.md"), "utf8")).toContain("Playwright timeout 디버깅");
  });

  it("promotes a result archive into a project summary only when an explicit page override is provided", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-ingest-"));
    const vaultDir = join(tempRoot, "vault");
    const taskDir = join(tempRoot, "tasks");
    const resultDir = join(tempRoot, "results");

    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await mkdir(resultDir, { recursive: true });

    await writeFile(
      join(vaultDir, "projects", "acme-app.md"),
      `---
title: acme-app 프로젝트 지식
tags: [studio]
created: 2026-04-07
updated: 2026-04-07
sources: ["results/legacy.result.md"]
---

## Summary
에이콤 현재 상태 요약.

## Details
기존 수동 메모.

## Related
(교차참조 추가 예정)
`,
      "utf8",
    );

    const resultPath = await createResultFile(
      resultDir,
      "acme-app-serve-hardening.result.md",
      `---
id: acme-app-serve-hardening
status: done
project: acme-app
---

# Acme App 서빙 하드닝

## 변경 사항
- workspace root 고정 로직 수정
- 서빙 진입점 검증
`,
    );

    await writeFile(
      join(taskDir, "acme-app-serve-hardening.task.md"),
      `---
id: acme-app-serve-hardening
project: acme-app
result: ${resultPath}
---
`,
      "utf8",
    );

    const result = await ingestResultFile({
      resultPath,
      vaultDir,
      taskDir,
      qaStatus: "passed",
      page: "projects/acme-app.md",
    });

    expect(result.relativeArchivePath).toBe("results/acme-app-serve-hardening.result.md");
    expect(result.relativePagePath).toBe("projects/acme-app.md");

    const pageContent = await readFile(join(vaultDir, "projects", "acme-app.md"), "utf8");
    expect(pageContent).toContain("## Details");
    expect(pageContent).toContain("기존 수동 메모.");
    expect(pageContent).toContain("### Current State");
    expect(pageContent).toContain("Latest topic: Acme App 서빙 하드닝");
    expect(pageContent).toContain("[acme-app-serve-hardening.result.md](../results/acme-app-serve-hardening.result.md)");
    expect(pageContent).not.toContain("<!-- ingest:");
    expect(pageContent).toContain("sources: []");
    expect(pageContent).not.toContain("legacy.result.md");
    expect(pageContent).not.toContain("## 변경 사항");
  });

  it("ingests a URL source into a domain page using fetched text", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-url-"));
    const vaultDir = join(tempRoot, "vault");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(
      "<html><body><main><h1>HAIIP</h1><p>IP rental service summary.</p></main></body></html>",
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    ));

    try {
      const result = await ingestGenericSource({
        source: "https://example.com/haiip",
        vaultDir,
        section: "domains",
        slug: "haiip",
        title: "하이아이피 조사 메모",
      });

      expect(result.relativePagePath).toBe("domains/haiip.md");
      const pageContent = await readFile(join(vaultDir, "domains", "haiip.md"), "utf8");
      expect(pageContent).toContain("하이아이피 조사 메모");
      expect(pageContent).toContain("IP rental service summary.");
      expect(pageContent).toContain("sources: [\"https://example.com/haiip\"]");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("routes debugging-oriented URL content into learnings automatically", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-url-learning-"));
    const vaultDir = join(tempRoot, "vault");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(
      "<html><body><main><h1>Playwright timeout RCA</h1><p>디버깅 규칙과 복구 패턴을 정리했다.</p></main></body></html>",
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    ));

    try {
      const result = await ingestGenericSource({
        source: "https://example.com/playwright-timeout-rca",
        vaultDir,
      });

      expect(result.relativePagePath).toBe("learnings/playwright-timeout-rca.md");
      const pageContent = await readFile(join(vaultDir, "learnings", "playwright-timeout-rca.md"), "utf8");
      expect(pageContent).toContain("Playwright timeout RCA");
      expect(pageContent).toContain("디버깅 규칙과 복구 패턴");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("routes project status text into the matching project page automatically", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-project-route-"));
    const vaultDir = join(tempRoot, "vault");

    const result = await ingestGenericSource({
      source: `# Acme App 배포 상태

Acme App 프로젝트 배포 이슈와 아키텍처 마이그레이션 TODO를 정리했다.
`,
      vaultDir,
      // C4 seam: the engine no longer reads a host project registry; known project
      // ids are injected by the consumer. The host passes its resolved list.
      knownProjectIds: ["acme-app"],
    });

    expect(result.relativePagePath).toBe("projects/acme-app.md");
    const pageContent = await readFile(join(vaultDir, "projects", "acme-app.md"), "utf8");
    expect(pageContent).toContain("Acme App 배포 상태");
    expect(pageContent).toContain("아키텍처 마이그레이션 TODO");
    // a freshly-routed project page carries no deprecated `domain:` stamp (2026-07-05 폐기 결정).
    expect(pageContent).not.toContain("domain:");
  });

  it("re-ingest into an existing page carries every non-managed frontmatter key forward", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-fm-carry-"));
    const vaultDir = join(tempRoot, "vault");
    await mkdir(join(vaultDir, "domains", "tooling"), { recursive: true });
    await writeFile(
      join(vaultDir, "domains", "tooling", "widget.md"),
      `---
title: Widget
description: 위젯 한 줄 요약
aliases: [Widget, "위젯"]
tags: [domains, tooling]
created: 2026-07-01
updated: 2026-07-01
sources: [https://example.com/widget]
source_grade: A
domain: tooling
---

## Summary
위젯 요약.

## Details
(없음)

## Related
(없음)
`,
      "utf8",
    );

    await ingestGenericSource({
      source: "# Widget 2026-08 갱신\n\n새 릴리스 노트.\n",
      vaultDir,
      page: "domains/tooling/widget.md",
    });

    const { frontmatter } = parseFrontmatterDocument(
      await readFile(join(vaultDir, "domains", "tooling", "widget.md"), "utf8"),
    );
    // carried forward verbatim
    expect(frontmatter.description).toBe("위젯 한 줄 요약");
    expect(frontmatter.aliases).toEqual(["Widget", "위젯"]);
    expect(frontmatter.source_grade).toBe("A");
    // managed keys still rebuilt
    expect(frontmatter.tags).toContain("tooling");
    expect(frontmatter.updated).not.toBe("2026-07-01");
    // deprecated key stays dropped (2026-07-05 폐기 결정)
    expect(frontmatter.domain).toBeUndefined();
  });

  it("archives an out-of-vault file source into the page's owner-local _sources bucket", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-ext-src-"));
    const vaultDir = join(tempRoot, "vault");
    const scratchDir = join(tempRoot, "scratch");
    await mkdir(scratchDir, { recursive: true });
    const scratchFile = join(scratchDir, "widget-notes.md");
    await writeFile(scratchFile, "# Widget notes\n\n외부 스크래치 파일 본문.\n", "utf8");

    const result = await ingestGenericSource({
      source: scratchFile,
      vaultDir,
      page: "domains/tooling/widget.md",
    });

    expect(result.relativePagePath).toBe("domains/tooling/widget.md");
    const pageContent = await readFile(join(vaultDir, "domains", "tooling", "widget.md"), "utf8");
    // no host absolute path leaks into the page
    expect(pageContent).not.toContain(scratchDir);
    // the snapshot lives next to the page and is what the page references
    const { frontmatter } = parseFrontmatterDocument(pageContent);
    const archived = frontmatter.sources.find((entry) => String(entry).includes("_sources/"));
    expect(archived).toMatch(/^_sources\/widget-notes-\d{4}-\d{2}-\d{2}\/source-snapshot\.md$/u);
    expect(existsSync(join(vaultDir, "domains", "tooling", archived))).toBe(true);
    expect(await readFile(join(vaultDir, "domains", "tooling", archived), "utf8")).toContain("외부 스크래치 파일 본문");
    // the original stays where it was (copy, not move — the caller owns it)
    expect(existsSync(scratchFile)).toBe(true);
  });

  it("marks mixed project/debug text as ambiguous for full-auto review", () => {
    const routing = analyzeDocumentRouting({
      documentMeta: {
        title: "Acme App 운영 메모",
        summary: "배포 이슈와 디버깅 패턴을 같이 정리했다.",
        body: "Acme App 프로젝트 배포 이슈, recovery pattern, debug checklist.",
        sourcePath: "text:acme-app-note",
        sourceName: "acme-app-note.md",
        sourceSlug: "acme-app-note",
        taskId: "acme-app-note",
        project: null,
      },
      sourceType: "text",
      // C4 seam: known project ids are injected by the consumer (see above).
      knownProjectIds: ["acme-app"],
    });

    expect(routing.project).toBe("acme-app");
    expect(routing.section).toBe("projects");
    expect(routing.ambiguous).toBe(true);
    expect(routing.candidates[0].section).toBe("projects");
    expect(routing.candidates[1].section).toBe("learnings");
  });

  it("ingests inbox files and archives them with .done suffix", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-inbox-"));
    const vaultDir = join(tempRoot, "vault");

    await mkdir(join(vaultDir, "inbox"), { recursive: true });
    await writeFile(
      join(vaultDir, "inbox", "playwright-timeout.md"),
      `# Playwright timeout 메모

재현 절차와 원인 후보를 정리했다.
`,
      "utf8",
    );

    const result = await ingestInbox({
      vaultDir,
      section: "learnings",
    });

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0].relativePagePath).toBe("learnings/playwright-timeout.md");
    const pageContent = await readFile(join(vaultDir, "learnings", "playwright-timeout.md"), "utf8");
    expect(pageContent).toContain("Playwright timeout 메모");
    expect(pageContent).toContain("sources: [");
    expect(pageContent).toContain("playwright-timeout.md.done");

    const archivedInbox = await readFile(join(vaultDir, "inbox", "playwright-timeout.md.done"), "utf8");
    expect(archivedInbox).toContain("재현 절차와 원인 후보");
  });

  // Spawns the distribution CLI vault-ingest and asserts the auto fast-lint runs after ingest.
  it("runs automatic fast lint after CLI ingest", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-cli-ingest-"));
    const vaultDir = join(tempRoot, "vault");
    const sourcePath = join(tempRoot, "playwright-timeout.md");

    await writeFile(
      sourcePath,
      `# Playwright timeout RCA

디버깅 규칙과 복구 절차를 정리했다.
`,
      "utf8",
    );

    const { stdout } = await execFile("node", [
      CLI_PATH,
      "vault-ingest",
      "--vault-dir",
      vaultDir,
      "--section",
      "learnings",
      sourcePath,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.relativePagePath).toBe("learnings/playwright-timeout.md");
    expect(payload.lint.ok).toBe(true);
    expect(payload.lint.fileCount).toBe(4);
    expect(payload.lint.files.map((entry) => entry.file)).toEqual([
      "learnings/playwright-timeout.md",
      "learnings/README.md",
      "README.md",
      "log.md",
    ]);
  });

  it("resolves a result file path from task id metadata", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-taskid-"));
    const taskDir = join(tempRoot, "tasks");
    const resultDir = join(tempRoot, "results");
    await mkdir(taskDir, { recursive: true });
    await mkdir(resultDir, { recursive: true });

    const resultPath = await createResultFile(
      resultDir,
      "sync-vault.result.md",
      `---
id: sync-vault
status: done
---

# Sync vault
`,
    );
    await writeFile(
      join(taskDir, "sync-vault.task.md"),
      `---
id: sync-vault
result: ${resultPath}
---
`,
      "utf8",
    );

    const resolved = await resolveResultPathForTaskId("sync-vault", {
      taskDir,
      resultDir,
      vaultDir: join(tempRoot, "vault"),
    });

    expect(resolved).toBe(resultPath);
  });

  it("guarded result ingest runs once and skips duplicates via stamp files", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-guarded-"));
    const vaultDir = join(tempRoot, "vault");
    const taskDir = join(tempRoot, "tasks");
    const resultDir = join(tempRoot, "results");
    const stampDir = join(tempRoot, "stamps");

    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await mkdir(resultDir, { recursive: true });

    const originalProjectPage = `---
title: acme-app 프로젝트 지식
tags: [studio]
created: 2026-04-07
updated: 2026-04-07
sources: []
---

## Summary
에이콤 프로젝트 누적 지식.

## Details
(작업 결과 ingest 시 자동 누적)

## Related
(교차참조 추가 예정)
`;

    await writeFile(
      join(vaultDir, "projects", "acme-app.md"),
      originalProjectPage,
      "utf8",
    );

    const resultPath = join(resultDir, "qa-auto-ingest.result.md");
    await writeFile(
      resultPath,
      `---
task: qa-auto-ingest
worker: surface:4
status: done
qa: surface:7
---

# QA guarded ingest 연결

## 변경 사항
- bypass ingest로 통합
`,
      "utf8",
    );

    await writeFile(
      join(taskDir, "qa-auto-ingest.task.md"),
      `---
id: qa-auto-ingest
project: acme-app
worker: surface:4
qa: surface:7
signal: acme-app-qa-auto-ingest-done
result: ${resultPath}
---
`,
      "utf8",
    );

    const first = await ingestResultFileWithGuards({
      resultPath,
      signal: "acme-app-qa-auto-ingest-done",
      taskDir,
      stampDir,
      vaultDir,
    });

    expect(first.status).toBe("ingested");
    expect(first.ingest.action).toBe("ARCHIVE");
    expect(first.ingest.relativePagePath).toBeUndefined();
    expect(first.ingest.relativeArchivePath).toBe("results/qa-auto-ingest.result.md");
    expect(existsSync(first.stampPath)).toBe(true);
    expect(await readFile(join(vaultDir, "projects", "acme-app.md"), "utf8")).toBe(originalProjectPage);
    expect(await readFile(join(vaultDir, "results", "qa-auto-ingest.result.md"), "utf8")).toContain("QA guarded ingest 연결");

    const second = await ingestResultFileWithGuards({
      resultPath,
      signal: "acme-app-qa-auto-ingest-done",
      taskDir,
      stampDir,
      vaultDir,
    });

    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("already-ingested");
  });

  it("guarded result ingest skips signal mismatch", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-guarded-"));
    const vaultDir = join(tempRoot, "vault");
    const taskDir = join(tempRoot, "tasks");
    const resultDir = join(tempRoot, "results");
    const stampDir = join(tempRoot, "stamps");

    await mkdir(taskDir, { recursive: true });
    await mkdir(resultDir, { recursive: true });

    const resultPath = join(resultDir, "mismatch.result.md");
    await writeFile(
      resultPath,
      `---
task: mismatch
status: done
qa: surface:7
---

# Signal mismatch
`,
      "utf8",
    );

    await writeFile(
      join(taskDir, "mismatch.task.md"),
      `---
id: mismatch
project: acme-app
qa: surface:7
signal: expected-signal
result: ${resultPath}
---
`,
      "utf8",
    );

    const skipped = await ingestResultFileWithGuards({
      resultPath,
      signal: "different-signal",
      taskDir,
      stampDir,
      vaultDir,
    });

    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toBe("signal-mismatch");
    expect(existsSync(join(vaultDir, "projects", "acme-app.md"))).toBe(false);
  });

  it("extractIndexStructure captures subsection + root placement per path", () => {
    const content = `# Kuma Vault Index

## Projects
- [alpha 프로젝트](projects/alpha.md) — root entry
- [beta 프로젝트](projects/beta.md) — root entry

### GroupA
- [gamma 프로젝트](projects/gamma.md) — manually grouped
- [delta 프로젝트](projects/delta.md) — manually grouped

### GroupB
- [epsilon 프로젝트](projects/epsilon.md) — manually grouped top-level
- [epsilon detail](projects/epsilon/detail.md) — subdir file grouped explicitly

## Learnings
- [loose learning](learnings/loose.md) — no subsection
`;
    const { pathToSubsection, subsectionOrder } = extractIndexStructure(content);

    expect(pathToSubsection.get("projects/alpha.md")).toBe(null);
    expect(pathToSubsection.get("projects/beta.md")).toBe(null);
    expect(pathToSubsection.get("projects/gamma.md")).toBe("GroupA");
    expect(pathToSubsection.get("projects/delta.md")).toBe("GroupA");
    expect(pathToSubsection.get("projects/epsilon.md")).toBe("GroupB");
    expect(pathToSubsection.get("projects/epsilon/detail.md")).toBe("GroupB");
    expect(pathToSubsection.get("learnings/loose.md")).toBe(null);
    expect(subsectionOrder.get("Projects")).toEqual(["GroupA", "GroupB"]);
  });

  it("rewriteIndex includes depth-3 markdown documents under vault sections", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-rewrite-"));
    const vaultDir = join(tempRoot, "vault");

    await mkdir(join(vaultDir, "domains", "research", "widget"), { recursive: true });

    await writeFile(
      join(vaultDir, "domains", "research", "widget", "faq.md"),
      `---
title: Widget FAQ
tags: []
created: 2026-06-15
updated: 2026-06-15
sources: []
---

## Summary
Depth-3 Widget FAQ summary.
`,
      "utf8",
    );

    await rewriteIndex(vaultDir);

    const regenerated = await readFile(join(vaultDir, "domains", "research", "widget", "README.md"), "utf8");
    expect(regenerated).toContain("[Widget FAQ](faq.md) — Depth-3 Widget FAQ summary.");
  });

  it("rewriteIndex derives the index line from frontmatter description, taking precedence over the Summary section", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-rewrite-"));
    const vaultDir = join(tempRoot, "vault");

    await mkdir(join(vaultDir, "domains"), { recursive: true });

    // A page carrying BOTH a curated frontmatter `description` and a longer
    // `## Summary` section. The index line must derive from `description`.
    await writeFile(
      join(vaultDir, "domains", "widget.md"),
      `---
title: Widget Reference
description: 위젯 표준·용어의 canonical 레퍼런스.
tags: []
created: 2026-07-03
updated: 2026-07-03
sources: []
---

## Summary
This much longer body summary should NOT win over the description field.
`,
      "utf8",
    );

    await rewriteIndex(vaultDir);

    const regenerated = await readFile(join(vaultDir, "domains", "README.md"), "utf8");
    expect(regenerated).toContain(
      "[Widget Reference](widget.md) — 위젯 표준·용어의 canonical 레퍼런스.",
    );
    expect(regenerated).not.toContain("should NOT win over the description field");
  });

  it("rewriteIndex keeps the summarize() fallback when a page has no frontmatter description", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-rewrite-"));
    const vaultDir = join(tempRoot, "vault");

    await mkdir(join(vaultDir, "domains"), { recursive: true });

    // No `description` field → the existing `## Summary` section drives the line.
    await writeFile(
      join(vaultDir, "domains", "legacy.md"),
      `---
title: Legacy Reference
tags: []
created: 2026-07-03
updated: 2026-07-03
sources: []
---

## Summary
Fallback summary derived from the Summary section.
`,
      "utf8",
    );

    await rewriteIndex(vaultDir);

    const regenerated = await readFile(join(vaultDir, "domains", "README.md"), "utf8");
    expect(regenerated).toContain(
      "[Legacy Reference](legacy.md) — Fallback summary derived from the Summary section.",
    );
  });

  it("rewriteIndex derives a folder README index line from the folder README's frontmatter description", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-rewrite-"));
    const vaultDir = join(tempRoot, "vault");

    await mkdir(join(vaultDir, "domains", "crypto"), { recursive: true });

    // A sub-folder README with its own frontmatter description; the parent
    // folder's index entry for it must derive from that description.
    await writeFile(
      join(vaultDir, "domains", "crypto", "README.md"),
      `---
title: Crypto
status: active
description: 암호학 도메인 페이지 모음.
---

# Crypto

Some intro prose that would otherwise become the folder summary.

## Vault Index

<!-- vault-index:start -->

<!-- vault-index:end -->
`,
      "utf8",
    );

    await rewriteIndex(vaultDir);

    const domainsReadme = await readFile(join(vaultDir, "domains", "README.md"), "utf8");
    expect(domainsReadme).toContain("[crypto/](crypto/README.md) — 암호학 도메인 페이지 모음.");
    expect(domainsReadme).not.toContain("Some intro prose");
  });

  it("rewriteIndex updates folder README regions without rewriting surrounding prose or creating index.md", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-rewrite-"));
    const vaultDir = join(tempRoot, "vault");

    await mkdir(join(vaultDir, "projects"), { recursive: true });
    await mkdir(join(vaultDir, "projects", "epsilon"), { recursive: true });
    await mkdir(join(vaultDir, "projects", "epsilon", "faq"), { recursive: true });
    await mkdir(join(vaultDir, "learnings"), { recursive: true });

    const pageFrontmatter = (title, summary) => `---
title: ${title}
tags: []
created: 2026-04-14
updated: 2026-04-14
sources: []
---

## Summary
${summary}
`;

    await writeFile(
      join(vaultDir, "projects", "gamma.md"),
      pageFrontmatter("gamma 프로젝트", "gamma summary"),
      "utf8",
    );
    await writeFile(
      join(vaultDir, "projects", "delta.md"),
      pageFrontmatter("delta 프로젝트", "delta summary"),
      "utf8",
    );
    await writeFile(
      join(vaultDir, "projects", "alpha.md"),
      pageFrontmatter("alpha 프로젝트", "alpha summary"),
      "utf8",
    );
    await writeFile(
      join(vaultDir, "projects", "epsilon", "detail.md"),
      pageFrontmatter("epsilon detail", "epsilon detail summary"),
      "utf8",
    );
    await writeFile(
      join(vaultDir, "projects", "epsilon", "faq", "deep.md"),
      pageFrontmatter("epsilon deep faq", "epsilon deep faq summary"),
      "utf8",
    );

    await writeFile(
      join(vaultDir, "projects", "README.md"),
      `---
title: Projects
status: active
---

# Projects

Manual prose must survive regeneration.

## Vault Index

<!-- vault-index:start -->
- [stale](stale.md) — stale generated content
<!-- vault-index:end -->
`,
      "utf8",
    );

    await rewriteIndex(vaultDir);

    const regenerated = await readFile(join(vaultDir, "projects", "README.md"), "utf8");

    expect(regenerated).toContain("Manual prose must survive regeneration.");
    expect(regenerated).toContain("[alpha 프로젝트](alpha.md) — alpha summary");
    expect(regenerated).toContain("[delta 프로젝트](delta.md) — delta summary");
    expect(regenerated).toContain("[epsilon/](epsilon/README.md)");
    expect(regenerated).not.toContain("stale.md");
    expect(existsSync(join(vaultDir, "index.md"))).toBe(false);

    const epsilonReadme = await readFile(join(vaultDir, "projects", "epsilon", "README.md"), "utf8");
    expect(epsilonReadme).toContain("[epsilon detail](detail.md) — epsilon detail summary");
    expect(epsilonReadme).toContain("[faq/](faq/README.md)");
  });

  it("rewriteIndex collapses duplicate or stray vault-index markers into one clean region (DEC-K self-heal)", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-rewrite-"));
    const vaultDir = join(tempRoot, "vault");
    await mkdir(join(vaultDir, "projects"), { recursive: true });

    // Malformed: a canonical region, then leftover bullets carrying their own
    // inline marker pairs, then a stray trailing end marker (the corruption a
    // non-greedy region replace would leave behind).
    await writeFile(
      join(vaultDir, "projects", "README.md"),
      `---
title: Projects
status: active
---

# Projects

Curated intro prose.

## Vault Index

<!-- vault-index:start -->
- [old](old.md) — old generated content
<!-- vault-index:end -->
- [old](old.md) — duplicate leftover <!-- vault-index:start --> <!-- vault-index:end -->
<!-- vault-index:end -->
`,
      "utf8",
    );

    await rewriteIndex(vaultDir);

    const regenerated = await readFile(join(vaultDir, "projects", "README.md"), "utf8");
    expect((regenerated.match(/<!-- vault-index:start -->/gu) ?? []).length).toBe(1);
    expect((regenerated.match(/<!-- vault-index:end -->/gu) ?? []).length).toBe(1);
    expect(regenerated).toContain("Curated intro prose.");
    expect(regenerated).not.toContain("duplicate leftover");

    // Idempotent: a second regeneration must not change the file.
    await rewriteIndex(vaultDir);
    const second = await readFile(join(vaultDir, "projects", "README.md"), "utf8");
    expect(second).toBe(regenerated);
  });

  it("rewriteIndex fails loud on a mid-batch atomic write failure and leaves written READMEs internally consistent (DEC-K)", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-atomic-"));
    const vaultDir = join(tempRoot, "vault");
    await mkdir(join(vaultDir, "domains", "security"), { recursive: true });
    const page = (title) => `---
title: ${title}
tags: []
created: 2026-04-14
updated: 2026-04-14
sources: []
---

## Summary
${title} summary
`;
    await writeFile(join(vaultDir, "domains", "security", "baseline.md"), page("baseline"), "utf8");

    // Clean baseline regions via the real (top-level) rewriteIndex.
    await rewriteIndex(vaultDir);
    // New child makes domains/security/README region stale until regenerated.
    await writeFile(join(vaultDir, "domains", "security", "extra.md"), page("extra"), "utf8");

    // Inject a deterministic failure when the security folder README is written.
    vi.resetModules();
    const actualStore = await vi.importActual("./atomic-file-store.mjs");
    vi.doMock("./atomic-file-store.mjs", () => ({
      ...actualStore,
      writeFileAtomic: async (path, data, encoding) => {
        if (String(path).endsWith(join("domains", "security", "README.md"))) {
          throw new Error("injected atomic write failure");
        }
        return actualStore.writeFileAtomic(path, data, encoding);
      },
    }));
    const { rewriteIndex: isolatedRewriteIndex } = await import("./vault-ingest.mjs");

    await expect(isolatedRewriteIndex(vaultDir)).rejects.toThrow("injected atomic write failure");

    vi.doUnmock("./atomic-file-store.mjs");
    vi.resetModules();
    const { lintVaultFiles } = await import("./vault-lint.mjs");
    const result = lintVaultFiles({ vaultDir, mode: "full" });

    // Fail-loud observability: the un-written README is flagged stale.
    expect(result.issues.some((issue) =>
      issue.file === "domains/security/README.md" && issue.code === "vault-index-region-stale")).toBe(true);
    // A README written before the failure stays internally consistent.
    expect(result.issues.some((issue) =>
      issue.file === "domains/README.md" && issue.code === "vault-index-region-stale")).toBe(false);
    // Per-file atomicity: no torn writes — every README keeps exactly one region.
    for (const relativePath of ["README.md", "domains/README.md", "domains/security/README.md"]) {
      const contents = await readFile(join(vaultDir, relativePath), "utf8");
      expect((contents.match(/<!-- vault-index:start -->/gu) ?? []).length).toBe(1);
      expect((contents.match(/<!-- vault-index:end -->/gu) ?? []).length).toBe(1);
    }
  });

  it("rewriteIndex strips a legacy root cross-references region (retired flat dump) and excludes runtime ledgers from root nav", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-rewrite-"));
    const vaultDir = join(tempRoot, "vault");

    await mkdir(join(vaultDir, "domains"), { recursive: true });
    await writeFile(
      join(vaultDir, "domains", "analytics.md"),
      `---
title: analytics
tags: []
created: 2026-04-23
updated: 2026-04-23
sources: []
---

## Summary
analytics summary

## Details
analytics details

## Related
- [Kuma Vault Schema](../schema.md) — parent schema
`,
      "utf8",
    );

    // Runtime ledgers must be reachable from curated prose, never the nav index.
    await writeFile(join(vaultDir, "dispatch-log.md"), "---\ntitle: Dispatch Log\ntype: special/dispatch-log\n---\n\n## Entries\n", "utf8");
    await writeFile(join(vaultDir, "log.md"), "# Kuma Vault Change Log\n", "utf8");

    // Seed a root README that still carries the retired flat cross-reference dump.
    await writeFile(
      join(vaultDir, "README.md"),
      [
        "---",
        "title: Kuma Vault Topology",
        "status: active",
        "---",
        "",
        "# Kuma Vault Topology",
        "",
        "## Vault Index",
        "",
        "<!-- vault-index:start -->",
        "<!-- vault-index:end -->",
        "",
        "## Special Files",
        "- [dispatch-log.md](dispatch-log.md) — runtime ledger.",
        "- [log.md](log.md) — change log.",
        "",
        "## Cross References",
        "<!-- vault-cross-references:start -->",
        "- analytics ← legacy dump line",
        "- content-pipeline [analytics](domains/analytics.md) — sibling",
        "<!-- vault-cross-references:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    await rewriteIndex(vaultDir);

    const regenerated = await readFile(join(vaultDir, "README.md"), "utf8");

    // The retired cross-reference dump (heading + region + content) is gone.
    expect(regenerated).not.toContain("## Cross References");
    expect(regenerated).not.toContain("<!-- vault-cross-references:start -->");
    expect(regenerated).not.toContain("legacy dump line");
    // The live navigation index survives and lists canonical slots...
    expect(regenerated).toContain("<!-- vault-index:start -->");
    expect(regenerated).toContain("](domains/README.md)");
    // ...but never the append-only runtime ledgers (they live in curated prose).
    expect(regenerated).not.toContain("](dispatch-log.md) — dispatch-log");
    expect(regenerated).not.toMatch(/<!-- vault-index:start -->[\s\S]*\]\(log\.md\)[\s\S]*<!-- vault-index:end -->/u);
    // Curated Special Files prose keeps the ledgers reachable.
    expect(regenerated).toContain("[dispatch-log.md](dispatch-log.md)");
  });

  it("rewriteIndex sanitizes result summaries so repo-local links do not leak broken markdown into the index", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-rewrite-"));
    const vaultDir = join(tempRoot, "vault");

    await mkdir(join(vaultDir, "results"), { recursive: true });

    await writeFile(
      join(vaultDir, "results", "speech-bubble.result.md"),
      `---
id: speech-bubble
status: done
---

# 말풍선 5줄 확장

**5줄 OK.** [StudioPage.tsx:295](packages/studio-web/src/pages/StudioPage.tsx) 에서 line cap 을 확인했다.
`,
      "utf8",
    );

    await rewriteIndex(vaultDir);

    const regenerated = await readFile(join(vaultDir, "README.md"), "utf8");

    expect(regenerated).toContain("[results/](results/README.md)");
    expect(regenerated).not.toContain("[말풍선 5줄 확장](results/speech-bubble.result.md)");
    expect(regenerated).not.toContain("StudioPage.tsx:295 에서 line cap 을 확인했다.");
    expect(regenerated).not.toContain("(packages/studio-web/src/pages/StudioPage.tsx)");
  });
});

describe("syncVaultIndex", () => {
  async function makeVaultWithStaleRegion() {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-sync-"));
    const vaultDir = join(tempRoot, "vault");
    await mkdir(join(vaultDir, "domains"), { recursive: true });

    // A real child page…
    await writeFile(
      join(vaultDir, "domains", "alpha.md"),
      `---
title: Alpha
description: Alpha canonical reference.
---

## Summary
Alpha body.
`,
      "utf8",
    );

    // …and a domains/README whose generated region is STALE: it links a page
    // that no longer exists and misses the real child.
    await writeFile(
      join(vaultDir, "domains", "README.md"),
      `---
title: Domains
status: active
---

# Domains

## Vault Index

<!-- vault-index:start -->
- [Ghost](ghost.md) — stale link to a deleted page
<!-- vault-index:end -->
`,
      "utf8",
    );

    return { tempRoot, vaultDir };
  }

  it("regenerates a stale vault-index region and is idempotent (2nd run is a no-op)", async () => {
    const { vaultDir } = await makeVaultWithStaleRegion();

    const first = await syncVaultIndex({ vaultDir });
    expect(first.check).toBe(false);
    expect(first.converged).toBe(true);
    expect(first.changedCount).toBeGreaterThan(0);
    expect(first.changed.map((entry) => entry.path)).toContain("domains/README.md");

    const domainsReadme = await readFile(join(vaultDir, "domains", "README.md"), "utf8");
    // Stale ghost link is gone; the real child is present.
    expect(domainsReadme).toContain("[Alpha](alpha.md) — Alpha canonical reference.");
    expect(domainsReadme).not.toContain("ghost.md");

    // Second, independent invocation writes nothing — the defining idempotency
    // guarantee (Done Criteria: 연속 2회 실행 시 2회차 no-op).
    const second = await syncVaultIndex({ vaultDir });
    expect(second.changedCount).toBe(0);
    expect(second.passes).toBe(1);
    expect(second.converged).toBe(true);
  });

  it("converges to a fixed point within one invocation when it must create a child README (parent ripple)", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-sync-"));
    const vaultDir = join(tempRoot, "vault");

    // A nested folder with a page but NO README. sync must create the child
    // README, whose existence then changes the parent's generated index entry —
    // a ripple that needs more than one pass to settle.
    await mkdir(join(vaultDir, "domains", "nested"), { recursive: true });
    await writeFile(
      join(vaultDir, "domains", "nested", "leaf.md"),
      `---
title: Leaf
description: Leaf page.
---

## Summary
Leaf body.
`,
      "utf8",
    );

    const first = await syncVaultIndex({ vaultDir });
    expect(first.converged).toBe(true);
    expect(first.passes).toBeGreaterThan(1);
    // The nested README was created…
    expect(existsSync(join(vaultDir, "domains", "nested", "README.md"))).toBe(true);
    expect(first.changed.some((entry) => entry.path === "domains/nested/README.md" && entry.created === true)).toBe(true);

    // …and a second invocation is a clean no-op despite the creation ripple.
    const second = await syncVaultIndex({ vaultDir });
    expect(second.changedCount).toBe(0);
    expect(second.converged).toBe(true);
  });

  it("--check reports drift without writing, then reports zero once the tree is synced", async () => {
    const { vaultDir } = await makeVaultWithStaleRegion();

    const before = await readFile(join(vaultDir, "domains", "README.md"), "utf8");
    const check = await syncVaultIndex({ vaultDir, check: true });
    expect(check.check).toBe(true);
    expect(check.changedCount).toBeGreaterThan(0);
    expect(check.converged).toBe(false);

    // check must not have touched disk.
    const after = await readFile(join(vaultDir, "domains", "README.md"), "utf8");
    expect(after).toBe(before);

    // Write, then check reports a clean, in-sync tree.
    await syncVaultIndex({ vaultDir });
    const cleanCheck = await syncVaultIndex({ vaultDir, check: true });
    expect(cleanCheck.changedCount).toBe(0);
    expect(cleanCheck.converged).toBe(true);
  });

  it("never mints or indexes a README into the plans slot or owner-local buckets (generator ↔ lint contract parity)", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-sync-"));
    const vaultDir = join(tempRoot, "vault");

    // A real navigable page under an owner (kept in the index).
    await mkdir(join(vaultDir, "domains", "tools"), { recursive: true });
    await writeFile(
      join(vaultDir, "domains", "tools", "extractor.md"),
      `---
title: Extractor
description: Extractor reference.
---

## Summary
Extractor body.
`,
      "utf8",
    );

    // Owner-local evidence bucket (underscore-prefixed) — non-nav, must be skipped.
    await mkdir(join(vaultDir, "domains", "tools", "_evidence", "run-1"), { recursive: true });
    await writeFile(
      join(vaultDir, "domains", "tools", "_evidence", "run-1", "sample.md"),
      "# Evidence sample\n",
      "utf8",
    );

    // Plans slot re-parent — owned by kuma plan lint, must be skipped.
    await mkdir(join(vaultDir, "plans", "acme-app"), { recursive: true });
    await writeFile(
      join(vaultDir, "plans", "acme-app", "some-plan.md"),
      "---\ntitle: Some Plan\nstatus: active\n---\n\n# Some Plan\n",
      "utf8",
    );

    const first = await syncVaultIndex({ vaultDir });
    expect(first.converged).toBe(true);

    // No README was minted into the non-nav slots…
    expect(existsSync(join(vaultDir, "domains", "tools", "_evidence", "README.md"))).toBe(false);
    expect(existsSync(join(vaultDir, "domains", "tools", "_evidence", "run-1", "README.md"))).toBe(false);
    expect(existsSync(join(vaultDir, "plans", "README.md"))).toBe(false);
    expect(existsSync(join(vaultDir, "plans", "acme-app", "README.md"))).toBe(false);

    // …and no generated index entry links to them.
    const changedPaths = first.changed.map((entry) => entry.path);
    expect(changedPaths.some((path) => path.includes("_evidence"))).toBe(false);
    expect(changedPaths.some((path) => path.startsWith("plans/"))).toBe(false);

    const toolsReadme = await readFile(join(vaultDir, "domains", "tools", "README.md"), "utf8");
    expect(toolsReadme).toContain("[Extractor](extractor.md)");
    expect(toolsReadme).not.toContain("_evidence");

    const rootReadme = existsSync(join(vaultDir, "README.md"))
      ? await readFile(join(vaultDir, "README.md"), "utf8")
      : "";
    expect(rootReadme).not.toMatch(/\(plans\//u);

    // `--check` on the synced tree reports zero drift for the non-nav slots.
    const check = await syncVaultIndex({ vaultDir, check: true });
    expect(check.changedCount).toBe(0);
    expect(check.converged).toBe(true);
  });

  it("never mints or indexes a README into a dot-directory (the .fts index cache is machine-only)", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-sync-"));
    const vaultDir = join(tempRoot, "vault");

    await mkdir(join(vaultDir, "domains"), { recursive: true });
    await writeFile(
      join(vaultDir, "domains", "alpha.md"),
      "---\ntitle: Alpha\ndescription: Alpha reference.\n---\n\n## Summary\nAlpha body.\n",
      "utf8",
    );
    // A dot-directory holding a derived binary cache (mirrors the `.fts/` FTS index location).
    await mkdir(join(vaultDir, ".fts"), { recursive: true });
    await writeFile(join(vaultDir, ".fts", "vault-fts.db"), "binary-cache", "utf8");

    const first = await syncVaultIndex({ vaultDir });
    expect(first.converged).toBe(true);

    // The dot-dir is a machine artifact: no README minted, no index entry links to it, and a
    // subsequent check reports zero drift (generator ↔ child-listing dot-skip parity, 원칙 3).
    expect(existsSync(join(vaultDir, ".fts", "README.md"))).toBe(false);
    const changedPaths = first.changed.map((entry) => entry.path);
    expect(changedPaths.some((path) => path.includes(".fts"))).toBe(false);

    const rootReadme = await readFile(join(vaultDir, "README.md"), "utf8");
    expect(rootReadme).not.toContain(".fts");

    const check = await syncVaultIndex({ vaultDir, check: true });
    expect(check.changedCount).toBe(0);
    expect(check.converged).toBe(true);
  });
});

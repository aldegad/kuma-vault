// Derived-pass scope bounding (2026-07-07, acme-ops full-contract promotion).
//
// The index generator and lint already bound their walks by the profile's navScope;
// these tests pin the same bound onto the DERIVED passes — sidecar extraction, LLM
// enrich candidate collection, and the scan/FTS corpus — so an untracked vendored or
// secret subtree inside a git-tracked knowledge repo is never extracted, sent to a
// model, or indexed (원칙 3 Consistency). Also pins:
//   - dot-directory parity: `.claude/`-style config dirs are never knowledge pages
//     (lint walk == generator descent).
//   - `genericPageSections` profile knob: `[]` keeps frontmatter enforcement without
//     demanding a Summary/Details/Related body restructure.

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadVaultDeclaration, resolveDeclaredProfile } from "./vault-config.mjs";
import { enrichVaultDescriptions } from "./vault-enrich.mjs";
import { buildFtsIndex } from "./vault-fts.mjs";
import { lintVaultFiles } from "./vault-lint.mjs";
import { resolveSearchScope, walkVaultMarkdownFiles } from "./vault-search.mjs";
import { syncVaultSidecars } from "./vault-sidecar.mjs";

function git(repoDir, ...args) {
  execFileSync("git", ["-C", repoDir, ...args], { stdio: "ignore" });
}

const PAGE = (title) => `---\ntitle: ${title}\ncreated: 2026-07-07\nupdated: 2026-07-07\ntags: []\n---\n\n# ${title}\n\nbody\n`;

// A tiny one-page PDF (same synthetic shape as vault-sidecar.test.mjs).
function buildPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 24 Tf 72 720 Td (tracked pdf text) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// A git repo declaring the full contract bounded to the tracked layer — the
// acme-ops shape: tracked handbook + untracked vendored/secret subtrees.
async function scaffoldTrackedRepo() {
  const repo = await mkdtemp(join(tmpdir(), "kuma-vault-scope-"));
  git(repo, "init", "-q");

  await writeFile(join(repo, "vault.config.json"), `${JSON.stringify({
    id: "scope-test",
    profile: "kuma-vault",
    archiveTreeDirs: ["archive"],
    rootNonNavFiles: ["AGENTS.md"],
    navScope: "git-tracked",
    canonicalChecks: false,
    genericPageSections: [],
    schema: { path: "schema.md", validateSpecialFiles: false, autoScaffold: false },
  }, null, 2)}\n`, "utf8");

  await writeFile(
    join(repo, "README.md"),
    "---\ntitle: scope-test\n---\n\n# scope-test\n\nSee [notes](notes/page.md).\n\n## Vault Index\n\n<!-- vault-index:start -->\n- [notes](notes/README.md) — notes\n<!-- vault-index:end -->\n",
    "utf8",
  );
  await mkdir(join(repo, "notes"), { recursive: true });
  await writeFile(
    join(repo, "notes", "README.md"),
    "---\ntitle: notes\n---\n\n# notes\n\n## Vault Index\n\n<!-- vault-index:start -->\n- [page](page.md) — page\n<!-- vault-index:end -->\n",
    "utf8",
  );
  await writeFile(join(repo, "notes", "page.md"), PAGE("page"));
  await writeFile(join(repo, "notes", "tracked.pdf"), buildPdf());
  await writeFile(join(repo, "AGENTS.md"), "agent instructions, not a nav page\n");

  git(repo, "add", ".");
  git(
    repo,
    "-c", "user.email=test@example.com",
    "-c", "user.name=test",
    "commit", "-q", "-m", "seed",
  );

  // Untracked vendored/secret material next to the handbook (never committed).
  await mkdir(join(repo, "secrets"), { recursive: true });
  await writeFile(join(repo, "secrets", "creds.md"), "---\ntitle: creds\n---\n\nTOKEN=super-secret\n");
  await writeFile(join(repo, "secrets", "leak.pdf"), buildPdf());
  await mkdir(join(repo, "vendor", "candidate-repo"), { recursive: true });
  await writeFile(join(repo, "vendor", "candidate-repo", "README.md"), "# vendored candidate readme\n");
  await writeFile(join(repo, "vendor", "candidate-repo", "doc.pdf"), buildPdf());

  // Dot-config dir with a page-shaped file (the `.claude/skills` accident class).
  await mkdir(join(repo, ".claude", "skills"), { recursive: true });
  await writeFile(join(repo, ".claude", "skills", "SKILL.md"), "# not a knowledge page\n");

  const profile = resolveDeclaredProfile(loadVaultDeclaration(repo));
  return { repo, profile };
}

describe("derived-pass scope bounding (git-tracked navScope)", () => {
  it("sidecar sync never extracts from untracked or dot subtrees", async () => {
    const { repo, profile } = await scaffoldTrackedRepo();
    const report = await syncVaultSidecars({ vaultDir: repo, profile });

    const touched = [...report.regenerated, ...report.skipped, ...report.failed]
      .map((entry) => (typeof entry === "string" ? entry : entry.path));
    expect(touched).toContain("notes/tracked.pdf.md");
    expect(touched.some((p) => p.startsWith("secrets/") || p.startsWith("vendor/") || p.startsWith("."))).toBe(false);
  });

  it("sidecar sync rejects a profile extension with no registered extractor", async () => {
    const { repo, profile } = await scaffoldTrackedRepo();
    await expect(
      syncVaultSidecars({ vaultDir: repo, profile: { ...profile, sidecarSourceExtensions: [".hwp"] } }),
    ).rejects.toThrow(/no extractor is registered/u);
  });

  it("enrich candidate collection never reaches untracked, dot, or root non-nav files", async () => {
    const { repo, profile } = await scaffoldTrackedRepo();
    const report = await enrichVaultDescriptions({ vaultDir: repo, check: true, profile });

    // Candidates are pending entries; the only leaf page is notes/page.md
    // (READMEs and AGENTS.md are excluded; secrets/vendor/.claude are out of scope).
    const candidatePaths = report.overflow.length > 0
      ? report.overflow.map((entry) => entry.path)
      : report.enriched.map((entry) => entry.path);
    const seen = [...candidatePaths, ...report.skipped.map((entry) => entry.path ?? entry)];
    expect(report.total).toBe(1);
    expect(seen.some((p) => String(p).startsWith("secrets/") || String(p).startsWith("vendor/") || String(p).startsWith("."))).toBe(false);
  });

  it("scan/FTS corpus excludes untracked subtrees and profile root non-nav files", async () => {
    const { repo, profile } = await scaffoldTrackedRepo();

    const files = await walkVaultMarkdownFiles(repo, repo, resolveSearchScope(repo, profile));
    const paths = files.map((file) => file.relativePath);
    expect(paths).toContain("notes/page.md");
    expect(paths.some((p) => p.startsWith("secrets/") || p.startsWith("vendor/") || p.startsWith("."))).toBe(false);
    expect(paths).not.toContain("AGENTS.md");

    // walkVaultMarkdownFiles with no ctx discovers the declaration itself (same corpus).
    const discovered = await walkVaultMarkdownFiles(repo);
    expect(discovered.map((file) => file.relativePath)).toEqual(paths);

    const fts = await buildFtsIndex({ vaultDir: repo, profile });
    expect(fts.docCount).toBe(paths.length);
  });
});

describe("lint parity + genericPageSections knob", () => {
  it("never lints dot-directory files, and `[]` drops the section demands while frontmatter stays enforced", async () => {
    const { repo, profile } = await scaffoldTrackedRepo();
    const result = lintVaultFiles({ vaultDir: repo, mode: "full", profile });

    const lintedFiles = result.files.map((entry) => entry.file);
    expect(lintedFiles.some((file) => file.startsWith("."))).toBe(false);

    // notes/page.md has full frontmatter but NO Summary/Details/Related sections:
    // with genericPageSections [] it must pass.
    expect(result.issues.filter((issue) => issue.code === "missing-section")).toEqual([]);
    expect(result.issues.filter((issue) => issue.file === "notes/page.md")).toEqual([]);
  });

  it("keeps demanding frontmatter under the knob — a bare page still fails", async () => {
    const { repo, profile } = await scaffoldTrackedRepo();
    await writeFile(join(repo, "notes", "bare.md"), "# bare page without frontmatter\n");
    git(repo, "add", "notes/bare.md");

    const result = lintVaultFiles({ vaultDir: repo, mode: "full", profile });
    expect(result.issues.some((issue) => issue.file === "notes/bare.md" && issue.code === "missing-frontmatter")).toBe(true);
  });

  it("default profiles keep the historical Summary/Details/Related demand", async () => {
    const { repo, profile } = await scaffoldTrackedRepo();
    const result = lintVaultFiles({
      vaultDir: repo,
      mode: "full",
      profile: { ...profile, genericPageSections: ["Summary", "Details", "Related"] },
    });
    const sectionIssues = result.issues.filter((issue) => issue.file === "notes/page.md" && issue.code === "missing-section");
    expect(sectionIssues.length).toBe(3);
  });
});

describe("declaration override: genericPageSections", () => {
  it("accepts an empty list and threads it into the resolved contract", async () => {
    const { profile } = await scaffoldTrackedRepo();
    expect(profile.genericPageSections).toEqual([]);
    expect(profile.enforcePageFrontmatter).toBe(true);
    expect(profile.canonicalChecks).toBe(false);
  });
});

describe("index link target encoding (parser-hostile filenames)", () => {
  it("round-trips a sidecar name with parens and spaces through generate → parse", async () => {
    const { repo, profile } = await scaffoldTrackedRepo();
    await writeFile(join(repo, "notes", "(주)회사 소개 (v2).pdf"), buildPdf());
    git(repo, "add", ".");

    const { syncVaultIndex } = await import("./vault-ingest.mjs");
    await syncVaultSidecars({ vaultDir: repo, profile });
    git(repo, "add", ".");
    await syncVaultIndex({ vaultDir: repo, profile });

    const notesReadme = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(repo, "notes", "README.md"), "utf8"));
    expect(notesReadme).toContain("%28주%29회사%20소개%20%28v2%29.pdf.md");

    const result = lintVaultFiles({ vaultDir: repo, mode: "full", profile });
    const bad = result.issues.filter((issue) =>
      issue.code === "broken-link" || issue.code === "unreachable-vault-page");
    expect(bad).toEqual([]);
  });
});

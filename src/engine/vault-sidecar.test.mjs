import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { isSidecarPath, SIDECAR_SOURCE_EXTENSIONS, syncVaultIndex } from "./vault-ingest.mjs";
import { SIDECAR_EXTRACTORS, syncVaultSidecars } from "./vault-sidecar.mjs";
import { searchVault } from "./vault-search.mjs";
import { lintVaultFiles } from "./vault-lint.mjs";

// Minimal dependency-free single-page PDF containing the given lines. Enough for pdfjs/kordoc to
// extract the text (no images, standard Helvetica). Offsets are computed so the xref is valid.
function makePdf(lines) {
  let content = "BT\n/F1 18 Tf\n72 720 Td\n";
  lines.forEach((line, index) => {
    const escaped = line.replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
    if (index > 0) content += "0 -28 Td\n";
    content += `(${escaped}) Tj\n`;
  });
  content += "ET";

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}

async function scaffoldVault() {
  const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-sidecar-"));
  const vaultDir = join(tempRoot, "vault");
  await mkdir(join(vaultDir, "domains", "tools"), { recursive: true });
  await writeFile(join(vaultDir, "vault.config.json"), JSON.stringify({ profile: "kuma-vault" }), "utf8");
  await writeFile(
    join(vaultDir, "README.md"),
    "---\ntitle: Kuma Vault\nstatus: active\n---\n\n# Kuma Vault\n\n## Vault Index\n\n<!-- vault-index:start -->\n\n<!-- vault-index:end -->\n",
    "utf8",
  );
  await writeFile(
    join(vaultDir, "domains", "tools", "README.md"),
    "---\ntitle: Tools\nstatus: active\n---\n\n# Tools\n\n## Vault Index\n\n<!-- vault-index:start -->\n\n<!-- vault-index:end -->\n",
    "utf8",
  );
  return vaultDir;
}

describe("vault-sidecar predicate + registry", () => {
  it("isSidecarPath recognizes registered-extension sidecars only", () => {
    expect(isSidecarPath("domains/tools/report.pdf.md")).toBe(true);
    expect(isSidecarPath("report.PDF.md")).toBe(true); // case-insensitive
    expect(isSidecarPath("domains/tools/report.pdf")).toBe(false); // the binary itself
    expect(isSidecarPath("domains/tools/notes.md")).toBe(false); // plain page
    expect(isSidecarPath("domains/tools/data.txt.md")).toBe(false); // .txt not registered
    expect(isSidecarPath("README.md")).toBe(false);
  });

  it("extractor registry keys equal the topology source-extension SSoT (parity)", () => {
    expect([...SIDECAR_EXTRACTORS.keys()].sort()).toEqual([...SIDECAR_SOURCE_EXTENSIONS].sort());
  });
});

describe("vault-sidecar sync (kordoc PDF extractor)", () => {
  it("E2E: extracts a PDF into a sidecar and exposes it in the folder index", async () => {
    const vaultDir = await scaffoldVault();
    const pdfPath = join(vaultDir, "domains", "tools", "fixture.pdf");
    await writeFile(pdfPath, makePdf(["Sidecar E2E document.", "Unique token: ZORBAXQUOKKA7."]));

    const sidecarReport = await syncVaultSidecars({ vaultDir });
    expect(sidecarReport.ok).toBe(true);
    expect(sidecarReport.regeneratedCount).toBe(1);
    expect(sidecarReport.regenerated[0]).toMatchObject({
      path: "domains/tools/fixture.pdf.md",
      created: true,
    });

    const sidecarPath = `${pdfPath}.md`;
    expect(existsSync(sidecarPath)).toBe(true);
    const sidecar = await readFile(sidecarPath, "utf8");
    expect(sidecar).toContain("kind: sidecar");
    expect(sidecar).toContain("source: domains/tools/fixture.pdf");
    expect(sidecar).toMatch(/sha256: [0-9a-f]{64}/u);
    expect(sidecar).toMatch(/extractor: kordoc@/u);
    expect(sidecar).toContain("ZORBAXQUOKKA7");

    // Index pass lists the sidecar in its folder README (일반 페이지처럼 index 에 잡힘).
    await syncVaultIndex({ vaultDir });
    const toolsReadme = await readFile(join(vaultDir, "domains", "tools", "README.md"), "utf8");
    expect(toolsReadme).toContain("[fixture.pdf](fixture.pdf.md)");
  }, 30000);

  it("is a no-op on the second run when the source hash is unchanged", async () => {
    const vaultDir = await scaffoldVault();
    const pdfPath = join(vaultDir, "domains", "tools", "fixture.pdf");
    await writeFile(pdfPath, makePdf(["Idempotent document.", "Token: NOOPTOKEN42."]));

    const first = await syncVaultSidecars({ vaultDir });
    expect(first.regeneratedCount).toBe(1);

    const sidecarPath = `${pdfPath}.md`;
    const afterFirst = await readFile(sidecarPath, "utf8");
    const mtimeFirst = (await stat(sidecarPath)).mtimeMs;

    const second = await syncVaultSidecars({ vaultDir });
    expect(second.regeneratedCount).toBe(0);
    expect(second.skippedCount).toBe(1);
    expect(second.skipped).toEqual(["domains/tools/fixture.pdf.md"]);

    // Byte-identical and untouched on disk.
    expect(await readFile(sidecarPath, "utf8")).toBe(afterFirst);
    expect((await stat(sidecarPath)).mtimeMs).toBe(mtimeFirst);
  }, 30000);

  it("regenerates the sidecar when the source binary changes", async () => {
    const vaultDir = await scaffoldVault();
    const pdfPath = join(vaultDir, "domains", "tools", "fixture.pdf");
    await writeFile(pdfPath, makePdf(["Version one.", "Token: FIRSTTOKEN11."]));
    await syncVaultSidecars({ vaultDir });

    const sidecarPath = `${pdfPath}.md`;
    const firstSha = (await readFile(sidecarPath, "utf8")).match(/sha256: ([0-9a-f]{64})/u)[1];

    // Replace the binary with new content → new hash → regeneration.
    await writeFile(pdfPath, makePdf(["Version two.", "Token: SECONDTOKEN22."]));
    const report = await syncVaultSidecars({ vaultDir });
    expect(report.regeneratedCount).toBe(1);
    expect(report.regenerated[0]).toMatchObject({ created: false, reason: "hash-changed" });

    const updated = await readFile(sidecarPath, "utf8");
    const secondSha = updated.match(/sha256: ([0-9a-f]{64})/u)[1];
    expect(secondSha).not.toBe(firstSha);
    expect(updated).toContain("SECONDTOKEN22");
    expect(updated).not.toContain("FIRSTTOKEN11");
  }, 30000);

  it("audit D: searching an extracted token surfaces the sidecar path and source meta", async () => {
    const vaultDir = await scaffoldVault();
    const pdfPath = join(vaultDir, "domains", "tools", "fixture.pdf");
    await writeFile(pdfPath, makePdf(["Search integration doc.", "Token: QWXZSEARCH99."]));
    await syncVaultSidecars({ vaultDir });

    const result = await searchVault({ query: "QWXZSEARCH99", vaultDir });
    const sidecarHit = result.hits.find((hit) => hit.path === "domains/tools/fixture.pdf.md");
    expect(sidecarHit).toBeDefined();
    expect(sidecarHit.source).toBe("domains/tools/fixture.pdf");
  }, 30000);

  it("No Silent Fallback: an unparseable binary is reported, not written as an empty sidecar", async () => {
    const vaultDir = await scaffoldVault();
    const badPath = join(vaultDir, "domains", "tools", "broken.pdf");
    await writeFile(badPath, Buffer.from("this is not a valid PDF at all", "utf8"));

    const report = await syncVaultSidecars({ vaultDir });
    expect(report.ok).toBe(false);
    expect(report.failedCount).toBe(1);
    expect(report.failed[0].path).toBe("domains/tools/broken.pdf");
    // No partial/empty sidecar left behind.
    expect(existsSync(`${badPath}.md`)).toBe(false);
  }, 30000);

  it("reports orphan sidecars (source binary missing) without deleting them", async () => {
    const vaultDir = await scaffoldVault();
    const orphanSidecar = join(vaultDir, "domains", "tools", "gone.pdf.md");
    await writeFile(
      orphanSidecar,
      "---\ntitle: gone.pdf\nkind: sidecar\nsource: domains/tools/gone.pdf\nsha256: abc\nextractor: kordoc@0\n---\n\n# gone.pdf\n",
      "utf8",
    );

    const report = await syncVaultSidecars({ vaultDir });
    expect(report.orphans).toContain("domains/tools/gone.pdf.md");
    expect(existsSync(orphanSidecar)).toBe(true); // not deleted (No Silent Fallback)
  });

  it("check mode reports would-regenerate drift without writing", async () => {
    const vaultDir = await scaffoldVault();
    const pdfPath = join(vaultDir, "domains", "tools", "fixture.pdf");
    await writeFile(pdfPath, makePdf(["Check mode doc.", "Token: CHECKDRIFT55."]));

    const report = await syncVaultSidecars({ vaultDir, check: true });
    expect(report.regeneratedCount).toBe(1);
    expect(report.regenerated[0]).toMatchObject({ reason: "missing" });
    expect(existsSync(`${pdfPath}.md`)).toBe(false); // no write in check mode
  });
});

describe("vault-sidecar lint contract", () => {
  it("exempts a generated sidecar from the canonical-page authoring contract", async () => {
    const vaultDir = await scaffoldVault();
    const pdfPath = join(vaultDir, "domains", "tools", "fixture.pdf");
    await writeFile(pdfPath, makePdf(["Lint doc.", "Token: LINTOK1234."]));
    await syncVaultSidecars({ vaultDir });
    await syncVaultIndex({ vaultDir });

    const lint = lintVaultFiles({ vaultDir, mode: "full", files: ["domains/tools/fixture.pdf.md"] });
    // No canonical-page findings (no deprecated-domain / created/updated rules) for a derived sidecar.
    const codes = lint.issues.map((issue) => issue.code);
    expect(codes).not.toContain("deprecated-frontmatter-domain");
    expect(codes).not.toContain("frontmatter-created-format");
    expect(codes).not.toContain("unreachable-vault-page");
    // No issue is attributed to the sidecar file itself (schema.md-missing etc. are global,
    // not the sidecar's — this vault scaffold intentionally omits schema.md).
    const sidecarIssues = lint.issues.filter((issue) => issue.file === "domains/tools/fixture.pdf.md");
    expect(sidecarIssues).toEqual([]);
  }, 30000);

  it("flags a sidecar that is missing a required stamp field", async () => {
    const vaultDir = await scaffoldVault();
    // Hand-written sidecar-shaped file missing sha256/extractor.
    await writeFile(
      join(vaultDir, "domains", "tools", "partial.pdf.md"),
      "---\ntitle: partial.pdf\nkind: sidecar\nsource: domains/tools/partial.pdf\n---\n\n# partial.pdf\n",
      "utf8",
    );
    const lint = lintVaultFiles({ vaultDir, mode: "full", files: ["domains/tools/partial.pdf.md"] });
    const codes = lint.issues.map((issue) => issue.code);
    expect(codes).toContain("sidecar-stamp-missing-field");
  });
});

describe("vault-sidecar dependency pin (audit I fresh-install smoke)", () => {
  it("depends on kordoc >=4 (bundled PDF engine) with no external pdfjs-dist", async () => {
    const nodeRequire = createRequire(import.meta.url);
    const serverManifest = nodeRequire("../../package.json");
    // kordoc 4.x bundles its PDF engine (pdfjs) in dist — an external pdfjs-dist dep would
    // reintroduce the obsolete 5.x pin surface (pdfjs 6.x doc.destroy crash, fixed in 4.x).
    expect(serverManifest.dependencies?.kordoc ?? "").toMatch(/^\^?4(\.|$)/u);
    expect(serverManifest.dependencies?.["pdfjs-dist"]).toBeUndefined();

    // kordoc 4.x seals its exports map (no ./package.json subpath) — use the VERSION export.
    const kordoc = await import("kordoc");
    expect(String(kordoc.VERSION).startsWith("4.")).toBe(true);
  });
});

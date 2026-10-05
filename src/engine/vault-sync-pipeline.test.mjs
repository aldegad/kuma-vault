// The two injection seams the composed sync exposes to a consumer, and why they are a PAIR.
//
// `runVaultSync` is one implementation with two consumers (this package's CLI, kuma-studio's
// host CLI). Everything they may vary goes through these seams, so this file pins what the
// seams promise — a host that folds its fork onto them is relying on exactly this.
//
//   1. `createGenerateDescription` is LAZY. kuma-studio's generator reads team config at
//      CONSTRUCTION time and throws when the tool profile is absent, so a factory called
//      eagerly would break plain `vault sync` for a tree that never asked to enrich.
//   2. `enrichFields` must match what the injected generator actually returns. A description-only
//      generator paired with the full field set does not fail loudly — it writes empty `tags: []`
//      / `aliases: []` AND their freshness stamps, which silently suppresses enrichment of those
//      fields forever after. The negative control below is that harm, pinned, so nobody
//      "simplifies" the two CLIs onto one field set without seeing what it costs.

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { formatVaultSyncReport, parseVaultSyncCheckDrift, runVaultSync, vaultSyncExitCode } from "./vault-sync-pipeline.mjs";
import { ENRICH_FIELDS_ALL } from "./vault-enrich.mjs";
import { parseFrontmatterDocument } from "./vault-ingest.mjs";

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A declared tree with one leaf page that has no description — the only enrich target.
async function makeVault(declaration = { id: "pipeline-fixture", profile: "kuma-vault" }) {
  const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-sync-pipeline-"));
  tempRoots.push(tempRoot);
  const vaultDir = join(tempRoot, "vault");
  await mkdir(join(vaultDir, "domains"), { recursive: true });
  await writeFile(
    join(vaultDir, "vault.config.json"),
    JSON.stringify(declaration),
    "utf8",
  );
  await writeFile(
    join(vaultDir, "domains", "alpha.md"),
    "---\ntitle: Alpha\ncreated: 2026-07-31\nupdated: 2026-07-31\nsources: []\n---\n\n## Summary\nAlpha does the alpha thing.\n",
    "utf8",
  );
  return vaultDir;
}

async function readAlpha(vaultDir) {
  return parseFrontmatterDocument(await readFile(join(vaultDir, "domains", "alpha.md"), "utf8")).frontmatter;
}

// A generator that returns a bare synopsis string — the shape kuma-studio's prompt
// produces (one line, no labeled TAGS/ALIASES sections).
function descriptionOnlyGenerator(text = "Alpha streams the alpha payload.") {
  const calls = [];
  const generate = async (input) => {
    calls.push(input);
    return text;
  };
  generate.calls = calls;
  return generate;
}

describe("runVaultSync — consumer injection seams", () => {
  it("never calls the generator factory when enrich is off", async () => {
    const vaultDir = await makeVault();
    let constructed = 0;
    const report = await runVaultSync({
      vaultDir,
      createGenerateDescription: () => {
        constructed += 1;
        throw new Error("team config missing — construction must not happen here");
      },
    });

    // A factory that throws on construction is the real kuma-studio case; a plain sync must
    // never touch it.
    expect(constructed).toBe(0);
    expect(report.enrich).toBeNull();
    expect(vaultSyncExitCode(report)).toBe(0);
  });

  it("never calls the generator factory in check mode, even with --enrich", async () => {
    const vaultDir = await makeVault();
    let constructed = 0;
    const report = await runVaultSync({
      vaultDir,
      check: true,
      enrich: true,
      createGenerateDescription: () => {
        constructed += 1;
        throw new Error("check mode must never construct a generator");
      },
    });

    expect(constructed).toBe(0);
    // Check mode still reports what a write run would enrich.
    expect(report.enrich.candidateCount).toBe(1);
  });

  it("constructs the generator exactly once, lazily, for a write-mode enrich", async () => {
    const vaultDir = await makeVault();
    const generate = descriptionOnlyGenerator();
    let constructed = 0;

    const report = await runVaultSync({
      vaultDir,
      enrich: true,
      enrichFields: ["description"],
      createGenerateDescription: () => {
        constructed += 1;
        return generate;
      },
    });

    expect(constructed).toBe(1);
    expect(report.enrich.enrichedCount).toBe(1);
    expect(generate.calls.length).toBe(1);
  });

  it("a description-only generator + description-only fields writes description and nothing else", async () => {
    const vaultDir = await makeVault();
    const report = await runVaultSync({
      vaultDir,
      enrich: true,
      enrichFields: ["description"],
      generateDescription: descriptionOnlyGenerator(),
    });

    expect(report.enrich.fields).toEqual(["description"]);
    const frontmatter = await readAlpha(vaultDir);
    expect(frontmatter.description).toBe("Alpha streams the alpha payload.");
    expect(typeof frontmatter.description_hash).toBe("string");
    // The fields this generator cannot produce are left ABSENT — a later run with a richer
    // generator can still fill them.
    expect(frontmatter.tags).toBeUndefined();
    expect(frontmatter.aliases).toBeUndefined();
    expect(frontmatter.tags_hash).toBeUndefined();
    expect(frontmatter.aliases_hash).toBeUndefined();
  });

  it("negative control: the same generator with the full field set stamps empty tags/aliases", async () => {
    const vaultDir = await makeVault();
    await runVaultSync({
      vaultDir,
      enrich: true,
      enrichFields: ENRICH_FIELDS_ALL,
      generateDescription: descriptionOnlyGenerator(),
    });

    // This is the harm the pairing rule exists to prevent: empty values written AND stamped
    // fresh, so no later run sees these fields as needing enrichment.
    const frontmatter = await readAlpha(vaultDir);
    expect(frontmatter.tags).toEqual([]);
    expect(frontmatter.aliases).toEqual([]);
    expect(typeof frontmatter.tags_hash).toBe("string");
    expect(typeof frontmatter.aliases_hash).toBe("string");
  });

  it("threads the tree's declared contract into the derived passes, not just the index pass", async () => {
    const vaultDir = await makeVault({ id: "pipeline-fixture", profile: "kuma-vault", archiveTreeDirs: [] });
    // `docs/` is an archive tree under the built-in vault contract but a normal nav folder for
    // a tree that declares its own archiveTreeDirs. If a derived pass silently fell back to the
    // built-in profile, this page would be excluded from the enrich walk.
    await mkdir(join(vaultDir, "docs"), { recursive: true });
    await writeFile(
      join(vaultDir, "docs", "guide.md"),
      "---\ntitle: Guide\ncreated: 2026-07-31\nupdated: 2026-07-31\nsources: []\n---\n\n## Summary\nA guide.\n",
      "utf8",
    );

    const report = await runVaultSync({
      vaultDir,
      check: true,
      enrich: true,
    });

    const paths = report.enrich.enriched.map((entry) => entry.path);
    expect(paths).toContain("docs/guide.md");
  });
});

describe("formatVaultSyncReport — the header says what the run did", () => {
  it("check mode writes nothing, and no run builds a search cache", async () => {
    const vaultDir = await makeVault();
    const report = await runVaultSync({ vaultDir, check: true });
    expect(formatVaultSyncReport(report).split("\n")[0]).toBe("vault sync — check (no writes)");
    expect(report).not.toHaveProperty("fts");
    expect(formatVaultSyncReport(report)).not.toMatch(/^fts:/mu);
    expect(existsSync(join(vaultDir, ".fts"))).toBe(false);
  });

  it("leaves the write-mode header alone", async () => {
    const vaultDir = await makeVault();
    const report = await runVaultSync({ vaultDir });
    expect(formatVaultSyncReport(report).split("\n")[0]).toBe("vault sync — write");
    expect(existsSync(join(vaultDir, ".fts"))).toBe(false);
  });
});

describe("vaultSyncExitCode", () => {
  it("passes a converged tree in check mode", async () => {
    const vaultDir = await makeVault();
    await runVaultSync({ vaultDir });
    expect(vaultSyncExitCode(await runVaultSync({ vaultDir, check: true }))).toBe(0);
  });

  it("still refuses tracked drift in check mode", async () => {
    const vaultDir = await makeVault();
    await runVaultSync({ vaultDir });
    // Break a tracked derivation: wipe a generated index region.
    const readmePath = join(vaultDir, "domains", "README.md");
    const readme = await readFile(readmePath, "utf8");
    await writeFile(readmePath, readme.replace(/<!-- vault-index:start -->[\s\S]*?<!-- vault-index:end -->/u, "<!-- vault-index:start -->\n\n<!-- vault-index:end -->"), "utf8");

    const report = await runVaultSync({ vaultDir, check: true });
    expect(report.changedCount).toBeGreaterThan(0);
    expect(vaultSyncExitCode(report)).toBe(1);
  });
});

describe("parseVaultSyncCheckDrift — reads the gate's refusal back from the formatter's text", () => {
  // The sync daemon regenerates and commits again only when the gate refused for tracked drift
  // alone. It reads that from the gate's text, so the reader is pinned against the formatter.
  it("names the drifted README of a real check run, created READMEs included", async () => {
    const vaultDir = await makeVault();
    await runVaultSync({ vaultDir });
    await writeFile(join(vaultDir, "domains", "beta.md"), "---\ntitle: Beta\ndescription: beta\n---\n\n# Beta\n", "utf8");
    await mkdir(join(vaultDir, "domains", "gamma"), { recursive: true });
    await writeFile(join(vaultDir, "domains", "gamma", "g.md"), "---\ntitle: G\ndescription: g\n---\n\n# G\n", "utf8");

    const report = await runVaultSync({ vaultDir, check: true });
    const parsed = parseVaultSyncCheckDrift(formatVaultSyncReport(report));
    expect(parsed.driftOnly).toBe(true);
    expect(parsed.reasons).toEqual([]); // the stale regions drift leaves are drift, not another refusal
    expect(parsed.drifted).toEqual(expect.arrayContaining(["domains/README.md", "domains/gamma/README.md"]));
    expect(parsed.drifted).toHaveLength(report.changedCount);
    expect(parsed.summary).toBe(`index: ${report.changedCount} drifted / ${report.total} README(s) (${report.unchangedCount} in sync)`);
  });

  it("an in-sync run, a commit-policy refusal, a failed sidecar or foreign text is not drift", async () => {
    const vaultDir = await makeVault();
    await runVaultSync({ vaultDir });
    const clean = formatVaultSyncReport(await runVaultSync({ vaultDir, check: true }));
    expect(parseVaultSyncCheckDrift(clean)).toEqual({ driftOnly: false, drifted: [], summary: "", reasons: [] });

    const drift = "index: 1 drifted / 3 README(s) (2 in sync)\n  - [drift] domains/README.md\n";
    expect(parseVaultSyncCheckDrift(drift)).toEqual({
      driftOnly: true,
      drifted: ["domains/README.md"],
      summary: "index: 1 drifted / 3 README(s) (2 in sync)",
      reasons: [],
    });
    // a path that happens to contain "drift" does not stand in for the count line
    expect(parseVaultSyncCheckDrift(`vault-dir: /work/autosave-drift/vault\n${drift}`).summary).toBe("index: 1 drifted / 3 README(s) (2 in sync)");
    expect(parseVaultSyncCheckDrift(`vault gate [freeze] frozen\n${drift}`)).toMatchObject({ driftOnly: false, reasons: ["vault gate [freeze] frozen"] });
    const failedSidecar = `${drift}sidecars: 0 would (re)generate / 1 binary source(s) (0 in sync)\n  - [fail] a.pdf: broken\n`;
    expect(parseVaultSyncCheckDrift(failedSidecar)).toMatchObject({ driftOnly: false, reasons: ["- [fail] a.pdf: broken"] });
    const disagree = "index: 0 drifted / 3 README(s) (3 in sync)\nlint: 1 issue(s) across 1 file(s)\n  stale vault-index regions: 1\n";
    expect(parseVaultSyncCheckDrift(disagree)).toMatchObject({ driftOnly: false, reasons: ["stale vault-index regions: 1"] });
    expect(parseVaultSyncCheckDrift("pre-commit: some other hook said no\n")).toEqual({ driftOnly: false, drifted: [], summary: "", reasons: [] });
  });
});

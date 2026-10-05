import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { resolveDeclaredProfile, resolveTreeContract } from "./vault-config.mjs";
import { parseFrontmatterDocument } from "./vault-ingest.mjs";
import { VAULT_PROFILE } from "./vault-profile.mjs";
import {
  DEFAULT_ENRICH_FIELDS,
  ENRICH_FIELDS_ALL,
  ENRICH_HASH_FIELD,
  enrichExcludedBy,
  enrichStampField,
  enrichVaultDescriptions,
  isEnrichTargetPath,
  sanitizeAliases,
  sanitizeDescription,
  sanitizeTags,
  upsertFrontmatterFields,
} from "./vault-enrich.mjs";

// --- Fixtures --------------------------------------------------------------------------

async function scaffoldVault() {
  const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-enrich-"));
  const vaultDir = join(tempRoot, "vault");
  await mkdir(join(vaultDir, "domains", "tools", "_evidence"), { recursive: true });
  await mkdir(join(vaultDir, "plans", "acme-app"), { recursive: true });
  await mkdir(join(vaultDir, "results"), { recursive: true });

  // README (derived nav index) — must NEVER be written by enrich.
  await writeFile(
    join(vaultDir, "README.md"),
    "---\ntitle: vault\n---\n\n# vault\n\nRoot topology.\n",
    "utf8",
  );
  await writeFile(
    join(vaultDir, "domains", "tools", "README.md"),
    "---\ntitle: tools\n---\n\n# tools\n\n<!-- vault-index:start -->\n<!-- vault-index:end -->\n",
    "utf8",
  );

  // Leaf knowledge page WITHOUT description — enrich target.
  await writeFile(
    join(vaultDir, "domains", "tools", "alpha.md"),
    "---\ntitle: Alpha Tool\ntags: [cli, alpha]\n---\n\n# Alpha Tool\n\nAlpha does the alpha thing over the wire.\n",
    "utf8",
  );

  // Leaf page WITH a hand-authored description and NO stamp — must never be clobbered.
  await writeFile(
    join(vaultDir, "domains", "tools", "beta.md"),
    "---\ntitle: Beta\ndescription: Human wrote this synopsis by hand.\n---\n\n# Beta\n\nBeta body.\n",
    "utf8",
  );

  // Non-nav / derived / non-leaf files enrich must skip:
  await writeFile(
    join(vaultDir, "domains", "tools", "sample.pdf.md"),
    "---\ntitle: sample.pdf\nkind: sidecar\nsource: domains/tools/sample.pdf\nsha256: abc\nextractor: kordoc@1\n---\n\n# sample.pdf\n",
    "utf8",
  );
  await writeFile(
    join(vaultDir, "domains", "tools", "_evidence", "note.md"),
    "---\ntitle: evidence\n---\n\n# evidence\n\nOwner-local bucket note.\n",
    "utf8",
  );
  await writeFile(
    join(vaultDir, "plans", "acme-app", "some-plan.md"),
    "---\ntitle: a plan\n---\n\n# a plan\n",
    "utf8",
  );
  await writeFile(
    join(vaultDir, "results", "r1.md"),
    "---\ntitle: a result\n---\n\n# a result\n",
    "utf8",
  );
  await writeFile(join(vaultDir, "log.md"), "# log\n\nroot log prose\n", "utf8");

  return { tempRoot, vaultDir };
}

async function snapshotTree(dir, base = dir, out = new Map()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await snapshotTree(full, base, out);
    } else if (entry.isFile()) {
      out.set(relative(base, full).split("\\").join("/"), await readFile(full, "utf8"));
    }
  }
  return out;
}

function changedPaths(before, after) {
  const changed = [];
  for (const [path, content] of after) {
    if (before.get(path) !== content) changed.push(path);
  }
  return changed.sort();
}

// A deterministic mock provider generator. Records every call so tests can assert the model
// was (or was not) invoked, and how many times.
function makeMockGenerator(text = "Generated one-line synopsis of the page.") {
  const calls = [];
  const generate = async (input) => {
    calls.push(input);
    return typeof text === "function" ? text(input) : text;
  };
  generate.calls = calls;
  return generate;
}

// --- Predicate -------------------------------------------------------------------------

describe("isEnrichTargetPath", () => {
  it("accepts leaf knowledge pages and rejects every derived/non-nav class", () => {
    expect(isEnrichTargetPath("domains/tools/alpha.md")).toBe(true);
    expect(isEnrichTargetPath("decisions.md")).toBe(true);

    // derived nav index
    expect(isEnrichTargetPath("README.md")).toBe(false);
    expect(isEnrichTargetPath("domains/tools/README.md")).toBe(false);
    expect(isEnrichTargetPath("domains/tools/index.md")).toBe(false);
    // generated sidecar
    expect(isEnrichTargetPath("domains/tools/sample.pdf.md")).toBe(false);
    // plans slot (owned by kuma plan lint)
    expect(isEnrichTargetPath("plans/acme-app/some-plan.md")).toBe(false);
    // owner-local bucket
    expect(isEnrichTargetPath("domains/tools/_evidence/note.md")).toBe(false);
    // archive tree
    expect(isEnrichTargetPath("results/r1.md")).toBe(false);
    // root non-nav prose
    expect(isEnrichTargetPath("log.md")).toBe(false);
    expect(isEnrichTargetPath("dispatch-log.md")).toBe(false);
    // non-markdown
    expect(isEnrichTargetPath("domains/tools/sample.pdf")).toBe(false);
    // a hidden or vendored directory: the walk never enters one, so a named path there is no target
    expect(isEnrichTargetPath(".obsidian/notes.md")).toBe(false);
    expect(isEnrichTargetPath("domains/tools/.trash/alpha.md")).toBe(false);
    expect(isEnrichTargetPath("domains/tools/node_modules/pkg/readme.md")).toBe(false);
    expect(isEnrichTargetPath("domains/tools/.draft.md")).toBe(true); // a hidden file name is still a page
  });
});

// --- sanitizeDescription ---------------------------------------------------------------

describe("sanitizeDescription", () => {
  it("keeps the first non-empty line, strips quotes/markdown, collapses whitespace, caps length", () => {
    expect(sanitizeDescription('"A quoted synopsis."')).toBe("A quoted synopsis.");
    expect(sanitizeDescription("\n\n  # Heading noise\nsecond line")).toBe("Heading noise");
    expect(sanitizeDescription("a   b\tc")).toBe("a b c");
    expect(sanitizeDescription("")).toBe("");
    expect(sanitizeDescription("x".repeat(500)).length).toBe(240);
  });
});

// --- upsertFrontmatterFields -----------------------------------------------------------

describe("upsertFrontmatterFields", () => {
  it("rewrites only the given keys, preserving body and other frontmatter lines verbatim", () => {
    const input = "---\ntitle: T\ntags: [a, b]\n---\n\n# Body\n\nUntouched.\n";
    const out = upsertFrontmatterFields(input, { description: "New syn", [ENRICH_HASH_FIELD]: "deadbeef" });
    expect(out).toContain("title: T");
    expect(out).toContain("tags: [a, b]");
    expect(out).toContain("description: New syn");
    expect(out).toContain(`${ENRICH_HASH_FIELD}: deadbeef`);
    // body preserved byte-for-byte
    expect(out.endsWith("\n# Body\n\nUntouched.\n")).toBe(true);
  });

  it("replaces an existing single-line description in place", () => {
    const input = "---\ntitle: T\ndescription: old\n---\nbody\n";
    const out = upsertFrontmatterFields(input, { description: "fresh", [ENRICH_HASH_FIELD]: "h" });
    expect(out).toContain("description: fresh");
    expect(out).not.toContain("description: old");
  });

  it("drops continuation lines of a replaced multi-line array key (malformed description)", () => {
    const input = "---\ntitle: T\ndescription:\n  - line one\n  - line two\n---\nbody\n";
    const out = upsertFrontmatterFields(input, { description: "single", [ENRICH_HASH_FIELD]: "h" });
    expect(out).toContain("description: single");
    expect(out).not.toContain("- line one");
    expect(out).not.toContain("- line two");
  });

  it("mints a frontmatter block when the document has none", () => {
    const out = upsertFrontmatterFields("# No frontmatter\n\nbody\n", { description: "d", [ENRICH_HASH_FIELD]: "h" });
    expect(out.startsWith("---\ndescription: d\n")).toBe(true);
    expect(out).toContain("# No frontmatter");
  });
});

// --- Engine ----------------------------------------------------------------------------

describe("enrichVaultDescriptions", () => {
  it("enriches only leaf pages missing a description, writing description + hash stamp", async () => {
    const { vaultDir } = await scaffoldVault();
    const generate = makeMockGenerator();

    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: generate });

    expect(result.ok).toBe(true);
    expect(result.enrichedCount).toBe(1);
    expect(result.enriched[0].path).toBe("domains/tools/alpha.md");
    expect(result.enriched[0].reason).toBe("missing");
    // model was called exactly once (only alpha needs it)
    expect(generate.calls.length).toBe(1);
    expect(generate.calls[0].relativePath).toBe("domains/tools/alpha.md");
    expect(generate.calls[0].title).toBe("Alpha Tool");

    const { frontmatter, body } = parseFrontmatterDocument(
      await readFile(join(vaultDir, "domains", "tools", "alpha.md"), "utf8"),
    );
    expect(frontmatter.description).toBe("Generated one-line synopsis of the page.");
    expect(typeof frontmatter[ENRICH_HASH_FIELD]).toBe("string");
    expect(frontmatter[ENRICH_HASH_FIELD].length).toBe(64);
    // original frontmatter + body preserved; the deprecated `domain` field is never (re)introduced
    expect(frontmatter.title).toBe("Alpha Tool");
    expect(frontmatter.domain).toBeUndefined();
    expect(body).toContain("Alpha does the alpha thing over the wire.");
  });

  it("never clobbers a hand-authored description with no stamp (model not called)", async () => {
    const { vaultDir } = await scaffoldVault();
    const generate = makeMockGenerator();

    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: generate });

    expect(result.skipped).toContain("domains/tools/beta.md");
    expect(generate.calls.some((call) => call.relativePath === "domains/tools/beta.md")).toBe(false);
    const raw = await readFile(join(vaultDir, "domains", "tools", "beta.md"), "utf8");
    expect(raw).toContain("description: Human wrote this synopsis by hand.");
    expect(raw).not.toContain(ENRICH_HASH_FIELD);
  });

  it("is idempotent: a second run over an unchanged tree enriches nothing (no-op)", async () => {
    const { vaultDir } = await scaffoldVault();
    const generate = makeMockGenerator();

    await enrichVaultDescriptions({ vaultDir, generateDescription: generate });
    const afterFirst = await snapshotTree(vaultDir);

    const generate2 = makeMockGenerator();
    const second = await enrichVaultDescriptions({ vaultDir, generateDescription: generate2 });
    const afterSecond = await snapshotTree(vaultDir);

    expect(second.enrichedCount).toBe(0);
    expect(generate2.calls.length).toBe(0);
    expect(changedPaths(afterFirst, afterSecond)).toEqual([]);
  });

  it("re-enriches a stamped page whose body changed (hash-stale)", async () => {
    const { vaultDir } = await scaffoldVault();
    await enrichVaultDescriptions({ vaultDir, generateDescription: makeMockGenerator("First synopsis.") });

    // mutate alpha's body -> stamp goes stale
    const alphaPath = join(vaultDir, "domains", "tools", "alpha.md");
    const current = await readFile(alphaPath, "utf8");
    await writeFile(alphaPath, `${current}\nNew paragraph changes the body hash.\n`, "utf8");

    const generate = makeMockGenerator("Second synopsis after edit.");
    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: generate });

    expect(result.enrichedCount).toBe(1);
    expect(result.enriched[0].reason).toBe("hash-stale");
    expect(generate.calls.length).toBe(1);
    const { frontmatter } = parseFrontmatterDocument(await readFile(alphaPath, "utf8"));
    expect(frontmatter.description).toBe("Second synopsis after edit.");
  });

  it("reports model failures and leaves the file untouched (No Silent Fallback)", async () => {
    const { vaultDir } = await scaffoldVault();
    const alphaPath = join(vaultDir, "domains", "tools", "alpha.md");
    const before = await readFile(alphaPath, "utf8");

    const failing = async () => {
      throw new Error("generator exploded");
    };
    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: failing });

    expect(result.ok).toBe(false);
    expect(result.failedCount).toBe(1);
    expect(result.failed[0].path).toBe("domains/tools/alpha.md");
    expect(result.failed[0].error).toContain("generator exploded");
    expect(await readFile(alphaPath, "utf8")).toBe(before);
  });

  it("treats an empty model description as a failure, not a write", async () => {
    const { vaultDir } = await scaffoldVault();
    const result = await enrichVaultDescriptions({
      vaultDir,
      generateDescription: makeMockGenerator("   \n  "),
    });
    expect(result.failedCount).toBe(1);
    expect(result.failed[0].error).toContain("empty description");
  });

  it("check mode reports would-enrich targets without writing or calling the model", async () => {
    const { vaultDir } = await scaffoldVault();
    const before = await snapshotTree(vaultDir);
    const generate = makeMockGenerator();

    const result = await enrichVaultDescriptions({ vaultDir, check: true, generateDescription: generate });

    expect(result.check).toBe(true);
    expect(result.candidateCount).toBe(1);
    expect(result.enriched[0].path).toBe("domains/tools/alpha.md");
    expect(result.enriched[0].wrote).toBe(false);
    expect(generate.calls.length).toBe(0);
    expect(changedPaths(before, await snapshotTree(vaultDir))).toEqual([]);
  });

  it("caps a write run at maxFiles and reports the overflow (no silent drop)", async () => {
    const { vaultDir } = await scaffoldVault();
    // Add a second missing-description leaf.
    await writeFile(
      join(vaultDir, "domains", "tools", "gamma.md"),
      "---\ntitle: Gamma\n---\n\n# Gamma\n\nGamma body.\n",
      "utf8",
    );

    const result = await enrichVaultDescriptions({
      vaultDir,
      generateDescription: makeMockGenerator(),
      maxFiles: 1,
    });

    expect(result.enrichedCount).toBe(1);
    expect(result.capped).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.overflow.length).toBe(1);
  });

  // audit C: the enrich pass's ONLY writes are leaf frontmatter (description + hash stamp).
  it("write-allowlist: touches only leaf pages, never README/index/sidecar/bucket/plans/log, body preserved", async () => {
    const { vaultDir } = await scaffoldVault();
    const before = await snapshotTree(vaultDir);

    await enrichVaultDescriptions({ vaultDir, generateDescription: makeMockGenerator() });

    const after = await snapshotTree(vaultDir);
    const changed = changedPaths(before, after);

    // Exactly one file changed: the missing-description leaf.
    expect(changed).toEqual(["domains/tools/alpha.md"]);

    // No derived/generated/non-nav file was touched.
    for (const forbidden of [
      "README.md",
      "domains/tools/README.md",
      "domains/tools/sample.pdf.md",
      "domains/tools/_evidence/note.md",
      "plans/acme-app/some-plan.md",
      "results/r1.md",
      "log.md",
    ]) {
      expect(after.get(forbidden)).toBe(before.get(forbidden));
    }

    // Within the changed leaf: body byte-identical, and every pre-existing frontmatter line
    // is preserved verbatim — the only new lines are description + hash stamp.
    const beforeDoc = parseFrontmatterDocument(before.get("domains/tools/alpha.md"));
    const afterDoc = parseFrontmatterDocument(after.get("domains/tools/alpha.md"));
    expect(afterDoc.body).toBe(beforeDoc.body);

    const frontmatterLines = (content) => {
      const lines = content.replace(/\r\n/gu, "\n").split("\n");
      const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
      return lines.slice(1, close);
    };
    const beforeLines = frontmatterLines(before.get("domains/tools/alpha.md"));
    const afterLines = frontmatterLines(after.get("domains/tools/alpha.md"));
    // Original lines all still present, verbatim.
    for (const line of beforeLines) {
      expect(afterLines).toContain(line);
    }
    // The only added lines are description + hash stamp.
    const added = afterLines.filter((line) => !beforeLines.includes(line)).sort();
    expect(added).toEqual([
      "description: Generated one-line synopsis of the page.",
      `${ENRICH_HASH_FIELD}: ${afterDoc.frontmatter[ENRICH_HASH_FIELD]}`,
    ].sort());
  });
});

// --- Field sanitizers (tags / aliases) -------------------------------------------------

describe("sanitizeTags / sanitizeAliases", () => {
  it("splits a comma string, trims, drops empties, dedupes case-insensitively", () => {
    expect(sanitizeTags("cli, Rust , cli,  ,rust")).toEqual(["cli", "Rust"]);
    expect(sanitizeAliases("Alt Name, 별칭 , alt name")).toEqual(["Alt Name", "별칭"]);
  });

  it("accepts a real array and strips parser-breaking characters (commas/brackets/newlines)", () => {
    expect(sanitizeTags(["  a  ", "", "b,c", "[d]"])).toEqual(["a", "b c", "d"]);
  });

  it("caps token length and list size (tags: 40 chars / 8 items, aliases: 60 chars / 12 items)", () => {
    expect(sanitizeTags(["x".repeat(50)])[0].length).toBe(40);
    expect(sanitizeAliases(["y".repeat(80)])[0].length).toBe(60);
    expect(sanitizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length).toBe(8);
    expect(sanitizeAliases(Array.from({ length: 20 }, (_, i) => `a${i}`)).length).toBe(12);
  });

  it("returns an empty list for undefined / empty model output (no throw)", () => {
    expect(sanitizeTags(undefined)).toEqual([]);
    expect(sanitizeAliases("")).toEqual([]);
  });
});

// --- Three-field metadata enrichment (description + tags + aliases) ---------------------

// A deterministic mock that returns the structured { description, tags, aliases } object the new
// contract expects. Records every call (with its tagPool) so tests can assert bounded-vocab input.
function makeMetaGenerator(meta = { description: "Generated synopsis.", tags: ["cli", "gen-tag"], aliases: ["alt name", "별칭"] }) {
  const calls = [];
  const generate = async (input) => {
    calls.push(input);
    return typeof meta === "function" ? meta(input) : meta;
  };
  generate.calls = calls;
  return generate;
}

// A vault exercising every field-provenance combination the enrich pass must respect.
async function scaffoldMetaVault() {
  const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-meta-"));
  const vaultDir = join(tempRoot, "vault");
  await mkdir(join(vaultDir, "domains", "tools", "_evidence"), { recursive: true });
  await mkdir(join(vaultDir, "plans", "acme-app"), { recursive: true });
  await mkdir(join(vaultDir, "results"), { recursive: true });

  await writeFile(join(vaultDir, "README.md"), "---\ntitle: vault\n---\n\n# vault\n", "utf8");
  await writeFile(
    join(vaultDir, "domains", "tools", "README.md"),
    "---\ntitle: tools\n---\n\n# tools\n\n<!-- vault-index:start -->\n<!-- vault-index:end -->\n",
    "utf8",
  );

  // gamma: missing all three enrich fields.
  await writeFile(
    join(vaultDir, "domains", "tools", "gamma.md"),
    "---\ntitle: Gamma\n---\n\n# Gamma\n\nGamma body prose.\n",
    "utf8",
  );
  // alpha: hand-authored tags (no stamp) — must be protected.
  await writeFile(
    join(vaultDir, "domains", "tools", "alpha.md"),
    "---\ntitle: Alpha\ntags: [cli, alpha]\n---\n\n# Alpha\n\nAlpha body.\n",
    "utf8",
  );
  // beta: hand-authored description (no stamp) — protected; tags/aliases must still be filled.
  await writeFile(
    join(vaultDir, "domains", "tools", "beta.md"),
    "---\ntitle: Beta\ndescription: Human wrote this synopsis by hand.\n---\n\n# Beta\n\nBeta body.\n",
    "utf8",
  );
  // zeta: hand-authored aliases (no stamp) — protected; description/tags must be filled.
  await writeFile(
    join(vaultDir, "domains", "tools", "zeta.md"),
    "---\ntitle: Zeta\naliases: [zed, zee]\n---\n\n# Zeta\n\nZeta body.\n",
    "utf8",
  );
  // delta: hand-authored tags (contributes to the bounded-vocab pool).
  await writeFile(
    join(vaultDir, "domains", "tools", "delta.md"),
    "---\ntitle: Delta\ntags: [parser]\n---\n\n# Delta\n\nDelta body.\n",
    "utf8",
  );

  // non-nav / derived — enrich must never write these.
  await writeFile(
    join(vaultDir, "domains", "tools", "sample.pdf.md"),
    "---\ntitle: sample.pdf\nkind: sidecar\nsource: domains/tools/sample.pdf\nsha256: abc\nextractor: kordoc@1\n---\n\n# sample.pdf\n",
    "utf8",
  );
  await writeFile(join(vaultDir, "domains", "tools", "_evidence", "note.md"), "---\ntitle: evidence\n---\n\n# evidence\n", "utf8");
  await writeFile(join(vaultDir, "plans", "acme-app", "some-plan.md"), "---\ntitle: a plan\n---\n\n# a plan\n", "utf8");
  await writeFile(join(vaultDir, "results", "r1.md"), "---\ntitle: a result\n---\n\n# a result\n", "utf8");
  await writeFile(join(vaultDir, "log.md"), "# log\n\nroot log prose\n", "utf8");

  return { tempRoot, vaultDir };
}

async function readFrontmatter(vaultDir, ...segments) {
  return parseFrontmatterDocument(await readFile(join(vaultDir, ...segments), "utf8"));
}

const HEX64 = /^[0-9a-f]{64}$/u;

describe("enrichVaultDescriptions — description + tags + aliases (fields)", () => {
  it("generates all three fields in ONE model call and stamps each with the body hash", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    const gen = makeMetaGenerator({ description: "Gamma synopsis.", tags: ["cli", "gen-tag"], aliases: ["alt name", "별칭"] });

    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: gen, fields: ENRICH_FIELDS_ALL });
    expect(result.ok).toBe(true);
    expect(result.fields).toEqual(["description", "tags", "aliases"]);

    // gamma needs all three, so the model is called exactly once for it (call count unchanged).
    const gammaCalls = gen.calls.filter((call) => call.relativePath === "domains/tools/gamma.md");
    expect(gammaCalls.length).toBe(1);

    const { frontmatter } = await readFrontmatter(vaultDir, "domains", "tools", "gamma.md");
    expect(frontmatter.description).toBe("Gamma synopsis.");
    expect(frontmatter.tags).toEqual(["cli", "gen-tag"]);
    expect(frontmatter.aliases).toEqual(["alt name", "별칭"]);

    const descHash = frontmatter[enrichStampField("description")];
    expect(descHash).toMatch(HEX64);
    // All three per-field stamps are the same body-content hash.
    expect(frontmatter[enrichStampField("tags")]).toBe(descHash);
    expect(frontmatter[enrichStampField("aliases")]).toBe(descHash);
  });

  it("is idempotent: a second 3-field run over an unchanged tree enriches nothing (no-op)", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    await enrichVaultDescriptions({ vaultDir, generateDescription: makeMetaGenerator(), fields: ENRICH_FIELDS_ALL });
    const afterFirst = await snapshotTree(vaultDir);

    const gen2 = makeMetaGenerator();
    const second = await enrichVaultDescriptions({ vaultDir, generateDescription: gen2, fields: ENRICH_FIELDS_ALL });

    expect(second.enrichedCount).toBe(0);
    expect(gen2.calls.length).toBe(0);
    expect(changedPaths(afterFirst, await snapshotTree(vaultDir))).toEqual([]);
  });

  it("protects a hand-authored tags list (no stamp) while filling description + aliases", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    const gen = makeMetaGenerator({ description: "Alpha synopsis.", tags: ["ignored"], aliases: ["a1"] });

    await enrichVaultDescriptions({ vaultDir, generateDescription: gen, fields: ENRICH_FIELDS_ALL });

    // Model IS called for alpha (it needs description + aliases).
    expect(gen.calls.some((call) => call.relativePath === "domains/tools/alpha.md")).toBe(true);

    const raw = await readFile(join(vaultDir, "domains", "tools", "alpha.md"), "utf8");
    const { frontmatter } = parseFrontmatterDocument(raw);
    // tags untouched (human) — value preserved, NO tags stamp minted.
    expect(frontmatter.tags).toEqual(["cli", "alpha"]);
    expect(frontmatter[enrichStampField("tags")]).toBeUndefined();
    expect(raw).toContain("tags: [cli, alpha]");
    // description + aliases were filled (machine), each stamped.
    expect(frontmatter.description).toBe("Alpha synopsis.");
    expect(frontmatter[enrichStampField("description")]).toMatch(HEX64);
    expect(frontmatter.aliases).toEqual(["a1"]);
    expect(frontmatter[enrichStampField("aliases")]).toMatch(HEX64);
  });

  it("protects a hand-authored aliases list (no stamp) while filling description + tags", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    await enrichVaultDescriptions({
      vaultDir,
      generateDescription: makeMetaGenerator({ description: "Zeta synopsis.", tags: ["cli"], aliases: ["ignored"] }),
      fields: ENRICH_FIELDS_ALL,
    });

    const raw = await readFile(join(vaultDir, "domains", "tools", "zeta.md"), "utf8");
    const { frontmatter } = parseFrontmatterDocument(raw);
    expect(frontmatter.aliases).toEqual(["zed", "zee"]);
    expect(frontmatter[enrichStampField("aliases")]).toBeUndefined();
    expect(raw).toContain("aliases: [zed, zee]");
    expect(frontmatter.description).toBe("Zeta synopsis.");
    expect(frontmatter.tags).toEqual(["cli"]);
    expect(frontmatter[enrichStampField("tags")]).toMatch(HEX64);
  });

  it("never clobbers a hand-authored description (no stamp) but still backfills tags + aliases", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    const gen = makeMetaGenerator({ description: "MUST NOT WIN.", tags: ["cli"], aliases: ["b1"] });

    await enrichVaultDescriptions({ vaultDir, generateDescription: gen, fields: ENRICH_FIELDS_ALL });

    // Under the 3-field contract the model IS called for beta (it needs tags + aliases) — but the
    // hand-authored description is preserved, not regenerated.
    expect(gen.calls.some((call) => call.relativePath === "domains/tools/beta.md")).toBe(true);

    const { frontmatter } = await readFrontmatter(vaultDir, "domains", "tools", "beta.md");
    expect(frontmatter.description).toBe("Human wrote this synopsis by hand.");
    expect(frontmatter[enrichStampField("description")]).toBeUndefined();
    expect(frontmatter.tags).toEqual(["cli"]);
    expect(frontmatter[enrichStampField("tags")]).toMatch(HEX64);
    expect(frontmatter.aliases).toEqual(["b1"]);
    expect(frontmatter[enrichStampField("aliases")]).toMatch(HEX64);
  });

  it("backfills tags + aliases on an already-description-stamped page WITHOUT re-generating the description", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    // Phase 1: legacy description-only enrich stamps gamma's description.
    await enrichVaultDescriptions({ vaultDir, generateDescription: makeMockGenerator("Original synopsis.") });
    const legacy = await readFrontmatter(vaultDir, "domains", "tools", "gamma.md");
    const legacyStamp = legacy.frontmatter[ENRICH_HASH_FIELD];
    expect(legacyStamp).toMatch(HEX64);
    expect(legacy.frontmatter.tags).toBeUndefined();

    // Phase 2: 3-field enrich. Description is fresh-stamped, so it must NOT be re-derived; only
    // tags + aliases are added.
    const gen2 = makeMetaGenerator({ description: "SHOULD NOT REPLACE.", tags: ["cli"], aliases: ["gamma-alias"] });
    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: gen2, fields: ENRICH_FIELDS_ALL });

    const gammaEntry = result.enriched.find((entry) => entry.path === "domains/tools/gamma.md");
    expect(gammaEntry.fields).toEqual(["tags", "aliases"]); // description NOT re-written
    expect(gen2.calls.some((call) => call.relativePath === "domains/tools/gamma.md")).toBe(true);

    const after = await readFrontmatter(vaultDir, "domains", "tools", "gamma.md");
    expect(after.frontmatter.description).toBe("Original synopsis."); // preserved
    expect(after.frontmatter[ENRICH_HASH_FIELD]).toBe(legacyStamp); // description stamp unchanged
    expect(after.frontmatter.tags).toEqual(["cli"]);
    expect(after.frontmatter.aliases).toEqual(["gamma-alias"]);
    expect(after.frontmatter[enrichStampField("tags")]).toBe(legacyStamp);
    expect(after.frontmatter[enrichStampField("aliases")]).toBe(legacyStamp);
  });

  it("re-generates every machine field when the body changes (hash-stale), leaving human fields alone", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    await enrichVaultDescriptions({
      vaultDir,
      generateDescription: makeMetaGenerator({ description: "First.", tags: ["cli"], aliases: ["a"] }),
      fields: ENRICH_FIELDS_ALL,
    });

    const gammaPath = join(vaultDir, "domains", "tools", "gamma.md");
    await writeFile(gammaPath, `${await readFile(gammaPath, "utf8")}\nNew paragraph changes the body hash.\n`, "utf8");

    const gen = makeMetaGenerator({ description: "Second.", tags: ["rust"], aliases: ["b"] });
    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: gen, fields: ENRICH_FIELDS_ALL });

    const entry = result.enriched.find((item) => item.path === "domains/tools/gamma.md");
    expect(entry.reason).toBe("hash-stale");
    expect(entry.fields).toEqual(["description", "tags", "aliases"]);
    const { frontmatter } = parseFrontmatterDocument(await readFile(gammaPath, "utf8"));
    expect(frontmatter.description).toBe("Second.");
    expect(frontmatter.tags).toEqual(["rust"]);
    expect(frontmatter.aliases).toEqual(["b"]);
  });

  it("bounded-vocab: seeds the generator with the existing tag pool and records only newly-minted tags", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    const gen = makeMetaGenerator({ description: "d", tags: ["cli", "fresh-tag"], aliases: ["x"] });

    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: gen, fields: ENRICH_FIELDS_ALL });

    // The tree's existing tags (alpha + delta) are passed in, deduped and sorted.
    const gammaCall = gen.calls.find((call) => call.relativePath === "domains/tools/gamma.md");
    expect(gammaCall.tagPool).toEqual(["alpha", "cli", "parser"]);
    expect(result.tagPoolSize).toBe(3);

    // "cli" was reused from the pool; only "fresh-tag" is reported as newly minted (근거 기록).
    const gammaEntry = result.enriched.find((entry) => entry.path === "domains/tools/gamma.md");
    expect(gammaEntry.newTags).toEqual(["fresh-tag"]);
  });

  it("write-allowlist (extended surface): only the six enrich keys are ever added; body + every pre-existing frontmatter line verbatim; no non-leaf file touched", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    const before = await snapshotTree(vaultDir);

    await enrichVaultDescriptions({ vaultDir, generateDescription: makeMetaGenerator(), fields: ENRICH_FIELDS_ALL });

    const after = await snapshotTree(vaultDir);
    const changed = changedPaths(before, after);

    // Only the five leaf knowledge pages changed.
    expect(changed).toEqual([
      "domains/tools/alpha.md",
      "domains/tools/beta.md",
      "domains/tools/delta.md",
      "domains/tools/gamma.md",
      "domains/tools/zeta.md",
    ]);

    // No derived / generated / non-nav file was touched.
    for (const forbidden of [
      "README.md",
      "domains/tools/README.md",
      "domains/tools/sample.pdf.md",
      "domains/tools/_evidence/note.md",
      "plans/acme-app/some-plan.md",
      "results/r1.md",
      "log.md",
    ]) {
      expect(after.get(forbidden)).toBe(before.get(forbidden));
    }

    // The write surface is bounded to exactly six frontmatter keys — a write of any key outside this
    // allowlist fails the test (criterion 3 negative coverage).
    const ALLOWED_ENRICH_KEYS = new Set([
      "description",
      "description_hash",
      "tags",
      "tags_hash",
      "aliases",
      "aliases_hash",
    ]);
    for (const path of changed) {
      const beforeDoc = parseFrontmatterDocument(before.get(path));
      const afterDoc = parseFrontmatterDocument(after.get(path));
      // body byte-identical.
      expect(afterDoc.body, `${path} body`).toBe(beforeDoc.body);

      const beforeKeys = Object.keys(beforeDoc.frontmatter);
      const afterKeys = Object.keys(afterDoc.frontmatter);
      // Every newly-added frontmatter key is in the enrich allowlist.
      for (const key of afterKeys.filter((k) => !beforeKeys.includes(k))) {
        expect(ALLOWED_ENRICH_KEYS.has(key), `${path} added disallowed key ${key}`).toBe(true);
      }
      // Every pre-existing frontmatter value is preserved verbatim (no human value clobbered).
      for (const key of beforeKeys) {
        expect(afterDoc.frontmatter[key], `${path} preserved ${key}`).toEqual(beforeDoc.frontmatter[key]);
      }
    }
  });

  it("defaults to description-only (DEFAULT_ENRICH_FIELDS) so a plain-string generator keeps its prior behavior", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    expect(DEFAULT_ENRICH_FIELDS).toEqual(["description"]);

    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: makeMockGenerator("Legacy synopsis.") });

    const { frontmatter } = await readFrontmatter(vaultDir, "domains", "tools", "gamma.md");
    expect(frontmatter.description).toBe("Legacy synopsis.");
    expect(frontmatter[ENRICH_HASH_FIELD]).toMatch(HEX64);
    // No tags/aliases written under the legacy default field set.
    expect(frontmatter.tags).toBeUndefined();
    expect(frontmatter.aliases).toBeUndefined();
    expect(frontmatter[enrichStampField("tags")]).toBeUndefined();
    // A page whose only need is tags/aliases (beta: human description) is NOT a candidate here.
    expect(result.skipped).toContain("domains/tools/beta.md");
  });

  it("preserves alias fidelity for values with internal quotes/backslashes (round-trips through the writer)", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    const aliases = ['C++ "smart" pointers', "path\\to\\thing", "한글 별칭"];
    await enrichVaultDescriptions({
      vaultDir,
      generateDescription: makeMetaGenerator({ description: "d", tags: ["cli"], aliases }),
      fields: ENRICH_FIELDS_ALL,
    });
    const { frontmatter } = await readFrontmatter(vaultDir, "domains", "tools", "gamma.md");
    expect(frontmatter.aliases).toEqual(aliases);
  });

  it("bounded-vocab: a tag differing from a pool tag only in case is reused, not newly minted (newTags)", async () => {
    const { vaultDir } = await scaffoldMetaVault();
    // pool is lowercase ["alpha","cli","parser"]; the model returns UPPERCASE "CLI" + a genuinely new tag.
    const gen = makeMetaGenerator({ description: "d", tags: ["CLI", "brand-new"], aliases: ["x"] });

    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: gen, fields: ENRICH_FIELDS_ALL });

    const gammaEntry = result.enriched.find((entry) => entry.path === "domains/tools/gamma.md");
    // "CLI" case-folds onto pool "cli" -> reused; only "brand-new" is reported as newly minted.
    expect(gammaEntry.newTags).toEqual(["brand-new"]);
  });

  it("collects the tag pool case-insensitively across pages, collapsing a case-variant to one entry (first spelling wins)", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kuma-vault-pool-"));
    const vaultDir = join(tempRoot, "vault");
    await mkdir(join(vaultDir, "domains", "tools"), { recursive: true });
    await writeFile(join(vaultDir, "domains", "tools", "README.md"), "---\ntitle: tools\n---\n\n# tools\n", "utf8");
    // a-cap sorts before b-low, so "Rust" (that spelling) is encountered first and wins.
    await writeFile(join(vaultDir, "domains", "tools", "a-cap.md"), "---\ntitle: A\ntags: [Rust]\n---\n\n# A\n\nbody.\n", "utf8");
    await writeFile(join(vaultDir, "domains", "tools", "b-low.md"), "---\ntitle: B\ntags: [rust]\n---\n\n# B\n\nbody.\n", "utf8");
    await writeFile(join(vaultDir, "domains", "tools", "needy.md"), "---\ntitle: Needy\n---\n\n# Needy\n\nbody.\n", "utf8");

    const gen = makeMetaGenerator({ description: "d", tags: ["cli"], aliases: ["z"] });
    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: gen, fields: ENRICH_FIELDS_ALL });

    // The [Rust]/[rust] case-variant collapses to ONE pool entry passed to every generator call.
    const needyCall = gen.calls.find((call) => call.relativePath === "domains/tools/needy.md");
    expect(needyCall.tagPool).toEqual(["Rust"]);
    expect(result.tagPoolSize).toBe(1);
  });
});

// --- Named pages (the sync daemon's autosave paths) and secret directories ----------------

describe("enrichVaultDescriptions with paths", () => {
  async function addSecrets(vaultDir) {
    await mkdir(join(vaultDir, "domains", "personal", "_credentials"), { recursive: true });
    await mkdir(join(vaultDir, "domains", "tools", "_Credentials"), { recursive: true });
    await mkdir(join(vaultDir, "domains", "tools", "_assets"), { recursive: true });
    await writeFile(join(vaultDir, "domains", "personal", "_credentials", "svc.md"), "# svc\n\ntoken: s3cret-value\n", "utf8");
    await writeFile(join(vaultDir, "domains", "tools", "_Credentials", "other.md"), "# other\n\ntoken: s3cret-other\n", "utf8");
    await writeFile(join(vaultDir, "domains", "tools", "_assets", "shot.md"), "# shot\n\nasset note\n", "utf8");
    await writeFile(join(vaultDir, "dispatch-log.md"), "# dispatch log\n\n- a row\n", "utf8");
    await writeFile(join(vaultDir, "domains", "tools", "gamma.md"), "---\ntitle: Gamma\n---\n\n# Gamma\n\nGamma body.\n", "utf8");
  }
  const sentBodies = (generate) => generate.calls.map((call) => call.body).join("\n");

  it("describes only the named knowledge pages; records, buckets and secrets are excluded with a reason", async () => {
    const { vaultDir } = await scaffoldVault();
    await addSecrets(vaultDir);
    const before = await snapshotTree(vaultDir);
    const generate = makeMockGenerator();

    const result = await enrichVaultDescriptions({
      vaultDir,
      generateDescription: generate,
      paths: [
        "domains/tools/alpha.md",
        "domains/tools/beta.md",
        "plans/acme-app/some-plan.md",
        "results/r1.md",
        "dispatch-log.md",
        "log.md",
        "domains/tools/_evidence/note.md",
        "domains/tools/_assets/shot.md",
        "domains/personal/_credentials/svc.md",
        "domains/tools/_Credentials/other.md",
        "domains/tools/README.md",
        "domains/tools/.trash/old.md",
        "domains/tools/gone.md",
      ],
    });

    expect(generate.calls.map((call) => call.relativePath)).toEqual(["domains/tools/alpha.md"]);
    expect(sentBodies(generate)).not.toMatch(/s3cret/u);
    expect(result.modelCalls).toBe(1);
    expect(result.enriched.map((e) => e.path)).toEqual(["domains/tools/alpha.md"]);
    expect(result.skipped).toEqual(["domains/tools/beta.md"]); // hand-written description
    expect(Object.fromEntries(result.excluded.map((e) => [e.path, e.reason]))).toEqual({
      "plans/acme-app/some-plan.md": "not-a-target",
      "results/r1.md": "not-a-target",
      "dispatch-log.md": "not-a-target",
      "log.md": "not-a-target",
      "domains/tools/_evidence/note.md": "not-a-target",
      "domains/tools/_assets/shot.md": "not-a-target",
      "domains/personal/_credentials/svc.md": "not-a-target",
      "domains/tools/_Credentials/other.md": "not-a-target",
      "domains/tools/README.md": "not-a-target",
      "domains/tools/.trash/old.md": "not-a-target",
      "domains/tools/gone.md": "missing",
    });
    // gamma needs a description too, but was not named: a paths run never walks for work.
    expect(changedPaths(before, await snapshotTree(vaultDir))).toEqual(["domains/tools/alpha.md"]);
  });

  it("never sends a secret directory, even when the tree declares another bucket prefix", async () => {
    const { vaultDir } = await scaffoldVault();
    await addSecrets(vaultDir);
    const profile = { ...VAULT_PROFILE, ownerLocalBucketPrefix: "~" }; // `_` no longer marks a bucket

    expect(isEnrichTargetPath("domains/personal/_credentials/svc.md", profile)).toBe(false);
    expect(isEnrichTargetPath("domains/x/_SYNC-conflicts/a.md", profile)).toBe(false);
    expect(isEnrichTargetPath("domains/tools/_assets/shot.md", profile)).toBe(true); // an ordinary folder now

    const walked = makeMockGenerator();
    await enrichVaultDescriptions({ vaultDir, profile, generateDescription: walked });
    const named = makeMockGenerator();
    await enrichVaultDescriptions({
      vaultDir,
      profile,
      generateDescription: named,
      paths: ["domains/personal/_credentials/svc.md", "domains/tools/_Credentials/other.md"],
    });

    expect(walked.calls.map((call) => call.relativePath)).not.toContain("domains/personal/_credentials/svc.md");
    expect(walked.calls.some((call) => /_credentials\//iu.test(call.relativePath))).toBe(false);
    expect(sentBodies(walked)).not.toMatch(/s3cret/u);
    expect(named.calls.length).toBe(0);
  });

  it("does not follow a symlink into a secret directory (named or walked)", async () => {
    const { vaultDir } = await scaffoldVault();
    await addSecrets(vaultDir);
    await symlink(join(vaultDir, "domains", "personal", "_credentials", "svc.md"), join(vaultDir, "domains", "tools", "link.md"));
    await symlink(join(vaultDir, "domains", "personal", "_credentials"), join(vaultDir, "domains", "tools", "linked-dir"));

    const named = makeMockGenerator();
    const result = await enrichVaultDescriptions({
      vaultDir,
      generateDescription: named,
      paths: ["domains/tools/link.md", "domains/tools/linked-dir/svc.md"],
    });
    const walked = makeMockGenerator();
    await enrichVaultDescriptions({ vaultDir, generateDescription: walked });

    expect(named.calls.length).toBe(0);
    expect(Object.fromEntries(result.excluded.map((e) => [e.path, e.reason]))).toEqual({
      "domains/tools/link.md": "not-a-file",
      "domains/tools/linked-dir/svc.md": "symlinked",
    });
    expect(sentBodies(walked)).not.toMatch(/s3cret/u);
  });

  it("caps model calls at maxFiles and leaves the rest as overflow", async () => {
    const { vaultDir } = await scaffoldVault();
    await addSecrets(vaultDir);
    const generate = makeMockGenerator();
    const result = await enrichVaultDescriptions({
      vaultDir,
      generateDescription: generate,
      maxFiles: 1,
      paths: ["domains/tools/gamma.md", "domains/tools/alpha.md"],
    });
    expect(result.modelCalls).toBe(1);
    expect(result.enriched.map((e) => e.path)).toEqual(["domains/tools/alpha.md"]);
    expect(result.overflow.map((e) => e.path)).toEqual(["domains/tools/gamma.md"]);
  });

  it("reads the tag pool only when it calls the model", async () => {
    const { vaultDir } = await scaffoldVault();
    const generate = makeMockGenerator({ description: "Synopsis.", tags: ["cli"], aliases: [] });
    const result = await enrichVaultDescriptions({
      vaultDir,
      generateDescription: generate,
      fields: ENRICH_FIELDS_ALL,
      paths: ["domains/tools/alpha.md"],
    });
    expect(generate.calls[0].tagPool).toEqual(["alpha", "cli"]);
    expect(result.tagPoolSize).toBe(2);
    const idle = await enrichVaultDescriptions({ vaultDir, fields: ENRICH_FIELDS_ALL, generateDescription: generate, paths: ["domains/tools/alpha.md"] });
    expect(idle.modelCalls).toBe(0); // alpha is described now: nothing to ask, no pool read
    expect(idle.tagPoolSize).toBe(0);
  });
});

describe("when a described page is written", () => {
  const second = "---\ntitle: Gamma\n---\n\n# Gamma\n\nGamma body.\n";

  // The generator reads the first page from disk each time it is called for the second one.
  async function runTwoPages(paths) {
    const { vaultDir } = await scaffoldVault();
    await writeFile(join(vaultDir, "domains", "tools", "gamma.md"), second, "utf8");
    const alpha = join(vaultDir, "domains", "tools", "alpha.md");
    const seen = [];
    const generate = makeMockGenerator(async ({ relativePath }) => {
      if (relativePath === "domains/tools/gamma.md") seen.push(await readFile(alpha, "utf8"));
      return "Synopsis.";
    });
    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: generate, ...(paths ? { paths } : {}) });
    return { result, seen, alpha: await readFile(alpha, "utf8"), gamma: await readFile(join(vaultDir, "domains", "tools", "gamma.md"), "utf8") };
  }

  it("a paths run writes nothing until its last model call has returned, then every page", async () => {
    const { result, seen, alpha, gamma } = await runTwoPages(["domains/tools/alpha.md", "domains/tools/gamma.md"]);
    expect(result.modelCalls).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/^description:/mu); // alpha was described already, and is not on disk yet
    expect(result.enriched.map((e) => e.path)).toEqual(["domains/tools/alpha.md", "domains/tools/gamma.md"]);
    expect(alpha).toMatch(/^description: Synopsis\.$/mu);
    expect(gamma).toMatch(/^description: Synopsis\.$/mu);
  });

  it("a walk writes each page as it is described", async () => {
    const { result, seen, gamma } = await runTwoPages(null);
    expect(result.modelCalls).toBe(2);
    expect(seen[0]).toMatch(/^description: Synopsis\.$/mu);
    expect(gamma).toMatch(/^description: Synopsis\.$/mu);
  });

  it("a paths run still leaves a page saved during a later call as its writer saved it", async () => {
    const { vaultDir } = await scaffoldVault();
    await writeFile(join(vaultDir, "domains", "tools", "gamma.md"), second, "utf8");
    const alpha = join(vaultDir, "domains", "tools", "alpha.md");
    const edited = "---\ntitle: Alpha Tool\n---\n\n# Alpha Tool\n\nRewritten during the second call.\n";
    const generate = makeMockGenerator(async ({ relativePath }) => {
      if (relativePath === "domains/tools/gamma.md") await writeFile(alpha, edited, "utf8");
      return "Synopsis.";
    });
    const result = await enrichVaultDescriptions({
      vaultDir,
      generateDescription: generate,
      paths: ["domains/tools/alpha.md", "domains/tools/gamma.md"],
    });
    expect(await readFile(alpha, "utf8")).toBe(edited);
    expect(result.raced).toEqual([{ path: "domains/tools/alpha.md" }]);
    expect(result.enriched.map((e) => e.path)).toEqual(["domains/tools/gamma.md"]);
  });
});

describe("a page edited while the model ran", () => {
  it("is left as its writer saved it and reported raced", async () => {
    const { vaultDir } = await scaffoldVault();
    const page = join(vaultDir, "domains", "tools", "alpha.md");
    const edited = "---\ntitle: Alpha Tool\n---\n\n# Alpha Tool\n\nRewritten while the model was thinking.\n";
    const generate = makeMockGenerator(async () => {
      await writeFile(page, edited, "utf8");
      return "Stale synopsis.";
    });

    const result = await enrichVaultDescriptions({ vaultDir, generateDescription: generate });

    expect(await readFile(page, "utf8")).toBe(edited);
    expect(result.raced).toEqual([{ path: "domains/tools/alpha.md" }]);
    expect(result.enrichedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.modelCalls).toBe(1);
  });
});

describe("pages a tree declares out of enrich (enrichExclude)", () => {
  // A tree's decision ledgers: the person alone writes them, so no model may touch them — not even
  // a description in the frontmatter. The tree names them; the engine names none.
  const DECLARATION = {
    profile: "kuma-vault",
    enrichExclude: ["/decisions.md", "projects/*.project-decisions.md"],
  };

  async function addDecisionFiles(vaultDir) {
    await mkdir(join(vaultDir, "projects", "acme"), { recursive: true });
    await writeFile(join(vaultDir, "vault.config.json"), `${JSON.stringify(DECLARATION, null, 2)}\n`, "utf8");
    await writeFile(join(vaultDir, "decisions.md"), "---\ntitle: Decisions\n---\n\n# Decisions\n\n- the owner decided this\n", "utf8");
    await writeFile(join(vaultDir, "projects", "acme.project-decisions.md"), "---\ntitle: Acme decisions\n---\n\n# Acme decisions\n\n- keep it small\n", "utf8");
    await writeFile(join(vaultDir, "projects", "acme", "decisions.md"), "---\ntitle: Acme notes on decisions\n---\n\n# Notes\n\nnot a ledger\n", "utf8");
  }

  it("the one resolver leaves out what the declaration names, case-insensitively, and only that", async () => {
    const profile = resolveDeclaredProfile(DECLARATION);
    expect(isEnrichTargetPath("decisions.md", profile)).toBe(false);
    expect(isEnrichTargetPath("Decisions.md", profile)).toBe(false);
    expect(isEnrichTargetPath("projects/acme.project-decisions.md", profile)).toBe(false);
    expect(enrichExcludedBy("projects/acme.project-decisions.md", profile)).toBe("projects/*.project-decisions.md");
    // anchored patterns: a page of the same name elsewhere is still a page
    expect(isEnrichTargetPath("projects/acme/decisions.md", profile)).toBe(true);
    expect(isEnrichTargetPath("projects/acme/x.project-decisions.md", profile)).toBe(true);
    expect(isEnrichTargetPath("domains/tools/alpha.md", profile)).toBe(true);
    // without the declaration the engine excludes nothing of the kind
    expect(isEnrichTargetPath("decisions.md")).toBe(true);
    expect(enrichExcludedBy("decisions.md")).toBeNull();
  });

  it("a declared decision file costs no model call and keeps its bytes, walked or named", async () => {
    const { vaultDir } = await scaffoldVault();
    await addDecisionFiles(vaultDir);
    const profile = resolveTreeContract(vaultDir);
    const before = await snapshotTree(vaultDir);

    const walked = makeMockGenerator();
    await enrichVaultDescriptions({ vaultDir, profile, generateDescription: walked, fields: ENRICH_FIELDS_ALL });
    const walkedPaths = walked.calls.map((call) => call.relativePath);
    expect(walkedPaths).not.toContain("decisions.md");
    expect(walkedPaths).not.toContain("projects/acme.project-decisions.md");
    expect(walkedPaths).toContain("projects/acme/decisions.md");

    const named = makeMockGenerator();
    const result = await enrichVaultDescriptions({
      vaultDir,
      profile,
      generateDescription: named,
      fields: ENRICH_FIELDS_ALL,
      paths: ["decisions.md", "projects/acme.project-decisions.md"],
    });
    expect(named.calls.length).toBe(0);
    expect(result.modelCalls).toBe(0);
    expect(Object.fromEntries(result.excluded.map((e) => [e.path, e.reason]))).toEqual({
      "decisions.md": "declared-exclude",
      "projects/acme.project-decisions.md": "declared-exclude",
    });

    const after = await snapshotTree(vaultDir);
    expect(after.get("decisions.md")).toBe(before.get("decisions.md"));
    expect(after.get("projects/acme.project-decisions.md")).toBe(before.get("projects/acme.project-decisions.md"));
  });
});

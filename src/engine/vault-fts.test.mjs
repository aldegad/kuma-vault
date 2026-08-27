import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildFtsIndex,
  buildFtsMatchExpression,
  checkFtsIndex,
  ftsQueryServiceable,
  healFtsIndex,
  resolveFtsDbPath,
  searchFtsIndex,
} from "./vault-fts.mjs";
import { searchVault } from "./vault-search.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// audit H — FTS recall comparison baseline (fixed contract).
//
// A representative fixture covering the four document kinds the compiler vault produces, each
// paired with a query that should recall it and the *only* field the match lives in. The FTS
// engine (trigram/BM25) must recall the same document the linear scan does for every row below
// (recall parity); ranking order is intentionally NOT asserted (BM25 ≠ scan's match-count sort).
//
// Regression tolerance:
//  - Queries are ≥ 3 code points (the trigram tokenizer minimum). Shorter queries deterministically
//    route to the canonical scan (`engineReason: query-below-trigram-min`) — see the dedicated test.
//  - FTS recall is a *superset* guarantee: the expected path MUST appear; extra hits are allowed
//    (they are re-analyzed by the shared scan analyzer, so they are never false positives).
// ─────────────────────────────────────────────────────────────────────────────
const RECALL_FIXTURES = [
  {
    kind: "plain-md-body",
    query: "물비늘무늬",
    expectedPath: "domains/tools/kordoc.md",
    field: "body prose (CJK, no whitespace boundary)",
  },
  {
    kind: "frontmatter-description",
    query: "parsing HWP",
    expectedPath: "domains/tools/kordoc.md",
    field: "frontmatter description",
  },
  {
    kind: "readme-index-line",
    query: "watermark-lattice",
    expectedPath: "domains/tools/README.md",
    field: "generated vault-index line text",
  },
  {
    kind: "sidecar-extracted-text",
    query: "ZORBAX7QUOKKA",
    expectedPath: "domains/tools/report.pdf.md",
    field: "sidecar extracted body (binary provenance)",
  },
  {
    kind: "sidecar-source-provenance",
    query: "ZORBAX7QUOKKA",
    expectedPath: "domains/tools/report.pdf.md",
    expectSource: "domains/tools/report.pdf",
    field: "sidecar frontmatter source surfaced on the hit",
  },
];

async function createFtsFixture() {
  const vaultDir = await mkdtemp(join(tmpdir(), "vault-fts-"));
  await mkdir(join(vaultDir, "domains", "tools"), { recursive: true });

  // (1) plain leaf md — body prose match (CJK) + (2) frontmatter description match.
  await writeFile(
    join(vaultDir, "domains", "tools", "kordoc.md"),
    `---
title: kordoc
description: Rust CLI for parsing HWP documents into structured JSON
---

kordoc 는 물비늘무늬처럼 정교하게 HWP 문서를 파싱한다.
`,
    "utf8",
  );

  // (3) folder README whose generated index line text ("watermark-lattice") is searchable.
  await writeFile(
    join(vaultDir, "domains", "tools", "README.md"),
    `---
title: Tools
---

# Tools

## Vault Index

<!-- vault-index:start -->
- [kordoc](kordoc.md) — watermark-lattice extraction toolkit
<!-- vault-index:end -->
`,
    "utf8",
  );

  // (4) binary sidecar — extracted-text token + source provenance frontmatter.
  await writeFile(
    join(vaultDir, "domains", "tools", "report.pdf.md"),
    `---
title: report.pdf
source: domains/tools/report.pdf
sha256: 0000000000000000000000000000000000000000000000000000000000000000
extractor: kordoc
kind: sidecar
generated: true
description: Extracted text of report.pdf
---

# report.pdf

ZORBAX7QUOKKA appears in the extracted binary text.
`,
    "utf8",
  );

  await writeFile(join(vaultDir, "README.md"), "# Vault Topology\n", "utf8");
  return vaultDir;
}

function dumpFtsRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT path, canonical_id, frontmatter, body FROM vault_fts ORDER BY path")
      .all();
  } finally {
    db.close();
  }
}

describe("vault-fts", () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds a full index and is idempotent (a second build on an unchanged corpus is a no-op)", async () => {
    const vaultDir = await createFtsFixture();
    tempDirs.push(vaultDir);

    const first = await buildFtsIndex({ vaultDir });
    expect(first.rebuilt).toBe(true);
    expect(first.docCount).toBe(4);
    expect(existsSync(resolveFtsDbPath(vaultDir))).toBe(true);

    const second = await buildFtsIndex({ vaultDir });
    expect(second.rebuilt).toBe(false);
    expect(second.signature).toBe(first.signature);
    expect(second.docCount).toBe(first.docCount);
  });

  it("is a pure function of source: a forced full rebuild yields byte-identical rows and signature", async () => {
    const vaultDir = await createFtsFixture();
    tempDirs.push(vaultDir);

    const first = await buildFtsIndex({ vaultDir });
    const rowsBefore = dumpFtsRows(resolveFtsDbPath(vaultDir));

    const forced = await buildFtsIndex({ vaultDir, force: true });
    const rowsAfter = dumpFtsRows(resolveFtsDbPath(vaultDir));

    expect(forced.rebuilt).toBe(true);
    expect(forced.signature).toBe(first.signature);
    expect(rowsAfter).toEqual(rowsBefore);
  });

  it("detects drift in check mode when the corpus changes, and reports in-sync otherwise", async () => {
    const vaultDir = await createFtsFixture();
    tempDirs.push(vaultDir);

    const beforeBuild = await checkFtsIndex({ vaultDir });
    expect(beforeBuild.present).toBe(false);
    expect(beforeBuild.wouldRebuild).toBe(true);

    await buildFtsIndex({ vaultDir });
    const clean = await checkFtsIndex({ vaultDir });
    expect(clean.present).toBe(true);
    expect(clean.wouldRebuild).toBe(false);

    await writeFile(join(vaultDir, "domains", "tools", "new-note.md"), "---\ntitle: New\n---\n\nnew body\n", "utf8");
    const drifted = await checkFtsIndex({ vaultDir });
    expect(drifted.wouldRebuild).toBe(true);
  });

  it("recalls every representative document kind (audit H recall parity with the scan)", async () => {
    const vaultDir = await createFtsFixture();
    tempDirs.push(vaultDir);
    await buildFtsIndex({ vaultDir });

    for (const fixture of RECALL_FIXTURES) {
      const ftsResult = await searchFtsIndex({ query: fixture.query, vaultDir, limit: 20 });
      const ftsPaths = ftsResult.hits.map((hit) => hit.path);
      expect(ftsResult.engine, `fts engine for "${fixture.query}"`).toBe("fts");
      expect(ftsPaths, `fts recall for ${fixture.kind} ("${fixture.query}")`).toContain(fixture.expectedPath);

      // Recall parity: the canonical scan recalls the same document.
      const scanResult = await searchVault({ vaultDir, query: fixture.query, engine: "scan" });
      expect(scanResult.hits.map((hit) => hit.path), `scan recall for ${fixture.kind}`).toContain(
        fixture.expectedPath,
      );

      if (fixture.expectSource) {
        const hit = ftsResult.hits.find((candidate) => candidate.path === fixture.expectedPath);
        expect(hit.source, `sidecar source provenance for ${fixture.kind}`).toBe(fixture.expectSource);
      }
    }
  });

  it("returns deterministic results across an index rebuild (audit E determinism)", async () => {
    const vaultDir = await createFtsFixture();
    tempDirs.push(vaultDir);

    await buildFtsIndex({ vaultDir });
    const before = await searchFtsIndex({ query: "물비늘무늬", vaultDir, limit: 20 });

    await buildFtsIndex({ vaultDir, force: true });
    const after = await searchFtsIndex({ query: "물비늘무늬", vaultDir, limit: 20 });

    expect(after.hits).toEqual(before.hits);
    expect(after.entityMatchCount).toBe(before.entityMatchCount);
    expect(after.contentMatchCount).toBe(before.contentMatchCount);
  });

  it("self-heals a stale row: a hit whose source was deleted after indexing is dropped, not dangling", async () => {
    const vaultDir = await createFtsFixture();
    tempDirs.push(vaultDir);
    await buildFtsIndex({ vaultDir });

    await rm(join(vaultDir, "domains", "tools", "kordoc.md"));
    const result = await searchFtsIndex({ query: "물비늘무늬", vaultDir, limit: 20 });
    expect(result.hits.map((hit) => hit.path)).not.toContain("domains/tools/kordoc.md");
  });

  it("routes queries below the trigram minimum away from FTS (documented tolerance)", () => {
    // "of" / "계정" (< 3 code points) cannot be served by the trigram tokenizer.
    expect(buildFtsMatchExpression(["of"])).toBe("");
    expect(ftsQueryServiceable(["of", "계정"])).toBe(false);
    expect(ftsQueryServiceable(["물비늘무늬"])).toBe(true);
    // OR-of-quoted-phrases form for serviceable terms.
    expect(buildFtsMatchExpression(["kordoc", "물비늘무늬"])).toBe('"kordoc" OR "물비늘무늬"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEC vault-compiler step 15 — the `plans/` slot is excluded from the search corpus.
//
// Plan documents are owned by `kuma plan lint` and edited outside the vault boundary (plan CLI /
// panel). Including them in the scan / FTS corpus would let out-of-band plan edits perpetually
// stale the FTS signature, breaking the canonical `kuma vault sync` no-op invariant. Both the scan
// and the FTS index reuse `walkVaultMarkdownFiles`, so pruning the slot there keeps recall
// identical by construction (parity).
// ─────────────────────────────────────────────────────────────────────────────
describe("vault-fts plans-slot exclusion (DEC vault-compiler step 15)", () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writePlanFile(vaultDir, body) {
    await mkdir(join(vaultDir, "plans", "acme-app"), { recursive: true });
    await writeFile(
      join(vaultDir, "plans", "acme-app", "some-plan.md"),
      `---\ntitle: Some Plan\nstatus: active\n---\n\n${body}\n`,
      "utf8",
    );
  }

  it("excludes plan documents from the FTS signature: adding or editing a plan is not corpus drift", async () => {
    const vaultDir = await createFtsFixture();
    tempDirs.push(vaultDir);

    const built = await buildFtsIndex({ vaultDir });
    const docCountBefore = built.docCount;
    const clean = await checkFtsIndex({ vaultDir });
    expect(clean.wouldRebuild).toBe(false);

    // A brand-new plan file must NOT count as corpus drift.
    await writePlanFile(vaultDir, "ZQPLANTOKEN99 first version of the plan body");
    const afterAdd = await checkFtsIndex({ vaultDir });
    expect(afterAdd.signature).toBe(built.signature);
    expect(afterAdd.wouldRebuild).toBe(false);
    expect(afterAdd.docCount).toBe(docCountBefore);

    // Editing the plan (the out-of-band case that used to stale the signature) is still a no-op.
    await writePlanFile(vaultDir, "ZQPLANTOKEN99 heavily edited plan body with new checklist items");
    const afterEdit = await checkFtsIndex({ vaultDir });
    expect(afterEdit.signature).toBe(built.signature);
    expect(afterEdit.wouldRebuild).toBe(false);
    expect(afterEdit.docCount).toBe(docCountBefore);
  });

  it("keeps existing (non-plans) corpus recall unchanged while a plan file is present", async () => {
    const vaultDir = await createFtsFixture();
    tempDirs.push(vaultDir);
    await writePlanFile(vaultDir, "ZQPLANTOKEN99 plan body that must never surface in vault search");
    await buildFtsIndex({ vaultDir });

    // Non-plans recall is intact: the known fixture document is still recalled by both engines.
    for (const fixture of RECALL_FIXTURES) {
      const ftsResult = await searchFtsIndex({ query: fixture.query, vaultDir, limit: 20 });
      expect(ftsResult.hits.map((hit) => hit.path), `fts recall for ${fixture.kind}`).toContain(
        fixture.expectedPath,
      );
      const scanResult = await searchVault({ vaultDir, query: fixture.query, engine: "scan" });
      expect(scanResult.hits.map((hit) => hit.path), `scan recall for ${fixture.kind}`).toContain(
        fixture.expectedPath,
      );
    }

    // The plan token is recalled by NEITHER engine (plans belong to the plan tool, not vault search).
    const ftsPlan = await searchFtsIndex({ query: "ZQPLANTOKEN99", vaultDir, limit: 20 });
    expect(ftsPlan.hits.map((hit) => hit.path)).not.toContain("plans/acme-app/some-plan.md");
    const scanPlan = await searchVault({ vaultDir, query: "ZQPLANTOKEN99", engine: "scan" });
    expect(scanPlan.hits.map((hit) => hit.path)).not.toContain("plans/acme-app/some-plan.md");
    // scan↔FTS parity: both exclude the plan, so both return zero hits for the plan-only token.
    expect(scanPlan.hits).toEqual([]);
    expect(ftsPlan.hits).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEC vault-compiler step 16 — the runtime ledgers are excluded from the search corpus.
//
// `dispatch-log.md` and `log.md` (VAULT_ROOT_NON_NAV_FILES) are machine-event append-only ledgers
// declared non-navigable. Every dispatch / ingest event appends to them, so including them in the
// scan / FTS corpus perpetually staled the FTS signature — re-breaking the canonical `kuma vault
// sync` no-op invariant that step 15 restored for plans. Both the scan and the FTS index reuse
// `walkVaultMarkdownFiles`, so pruning the ledgers there keeps recall identical by construction
// (parity). Ledger reads belong to `kuma vault timeline`, not vault search.
// ─────────────────────────────────────────────────────────────────────────────
describe("vault-fts runtime-ledger exclusion (DEC vault-compiler step 16)", () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function appendLedgerEvent(vaultDir, ledgerName, line) {
    await writeFile(join(vaultDir, ledgerName), `${line}\n`, { flag: "a", encoding: "utf8" });
  }

  it("excludes the runtime ledgers from the FTS signature: an append is not corpus drift", async () => {
    const vaultDir = await createFtsFixture();
    tempDirs.push(vaultDir);

    // The ledgers exist at rest (as they do in the canonical vault) before the index is built.
    await appendLedgerEvent(vaultDir, "dispatch-log.md", "ZQLEDGERTOKEN77 initial dispatch event");
    await appendLedgerEvent(vaultDir, "log.md", "ZQLEDGERTOKEN77 initial ingest event");

    const built = await buildFtsIndex({ vaultDir });
    const docCountBefore = built.docCount;
    const clean = await checkFtsIndex({ vaultDir });
    expect(clean.wouldRebuild).toBe(false);

    // A dispatch event appends to the ledger — this must NOT count as corpus drift (the exact
    // canonical failure: FTS built, then a later dispatch append flipped `wouldRebuild` to true).
    await appendLedgerEvent(vaultDir, "dispatch-log.md", "ZQLEDGERTOKEN77 later dispatch event");
    const afterDispatch = await checkFtsIndex({ vaultDir });
    expect(afterDispatch.signature).toBe(built.signature);
    expect(afterDispatch.wouldRebuild).toBe(false);
    expect(afterDispatch.docCount).toBe(docCountBefore);

    // An ingest event appends to the other ledger — still a no-op.
    await appendLedgerEvent(vaultDir, "log.md", "ZQLEDGERTOKEN77 later ingest event");
    const afterIngest = await checkFtsIndex({ vaultDir });
    expect(afterIngest.signature).toBe(built.signature);
    expect(afterIngest.wouldRebuild).toBe(false);
    expect(afterIngest.docCount).toBe(docCountBefore);
  });

  it("keeps existing (non-ledger) corpus recall unchanged while the ledgers are present", async () => {
    const vaultDir = await createFtsFixture();
    tempDirs.push(vaultDir);
    await appendLedgerEvent(vaultDir, "dispatch-log.md", "ZQLEDGERTOKEN77 dispatch event that must never surface");
    await appendLedgerEvent(vaultDir, "log.md", "ZQLEDGERTOKEN77 ingest event that must never surface");
    await buildFtsIndex({ vaultDir });

    // Non-ledger recall is intact: every known fixture document is still recalled by both engines.
    for (const fixture of RECALL_FIXTURES) {
      const ftsResult = await searchFtsIndex({ query: fixture.query, vaultDir, limit: 20 });
      expect(ftsResult.hits.map((hit) => hit.path), `fts recall for ${fixture.kind}`).toContain(
        fixture.expectedPath,
      );
      const scanResult = await searchVault({ vaultDir, query: fixture.query, engine: "scan" });
      expect(scanResult.hits.map((hit) => hit.path), `scan recall for ${fixture.kind}`).toContain(
        fixture.expectedPath,
      );
    }

    // The ledger token is recalled by NEITHER engine (ledgers belong to `kuma vault timeline`).
    const ftsLedger = await searchFtsIndex({ query: "ZQLEDGERTOKEN77", vaultDir, limit: 20 });
    expect(ftsLedger.hits.map((hit) => hit.path)).not.toContain("dispatch-log.md");
    expect(ftsLedger.hits.map((hit) => hit.path)).not.toContain("log.md");
    const scanLedger = await searchVault({ vaultDir, query: "ZQLEDGERTOKEN77", engine: "scan" });
    expect(scanLedger.hits.map((hit) => hit.path)).not.toContain("dispatch-log.md");
    expect(scanLedger.hits.map((hit) => hit.path)).not.toContain("log.md");
    // scan↔FTS parity: both exclude the ledgers, so both return zero hits for the ledger-only token.
    expect(scanLedger.hits).toEqual([]);
    expect(ftsLedger.hits).toEqual([]);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Self-heal — the cache recovers from the live tree instead of reporting a miss upward
// (원칙 1). This is what lets the commit-boundary gate stop blocking one session for
// another session's edit.
// ─────────────────────────────────────────────────────────────────────────────
describe("vault-fts self-heal", () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe("healFtsIndex", () => {
    it("rebuilds a stale cache from the live tree and verifies what it published", async () => {
      const vaultDir = await createFtsFixture();
      tempDirs.push(vaultDir);
      await buildFtsIndex({ vaultDir });

      await writeFile(
        join(vaultDir, "domains", "tools", "new-note.md"),
        "---\ntitle: New\n---\n\nQUOKKA9 new body\n",
        "utf8",
      );
      expect((await checkFtsIndex({ vaultDir })).wouldRebuild).toBe(true);

      const healed = await healFtsIndex({ vaultDir });
      expect(healed.healed).toBe(true);
      expect(healed.verified).toBe(true);
      expect(healed.raced).toBe(false);
      // The published index is the one it says it published, and the tree is now in sync.
      expect(healed.publishedSignature).toBe(healed.signature);
      expect((await checkFtsIndex({ vaultDir })).wouldRebuild).toBe(false);
      // The heal is a real rebuild, not a stamp bump: the new document is searchable.
      const hits = await searchFtsIndex({ query: "QUOKKA9", vaultDir, limit: 20 });
      expect(hits.hits.map((hit) => hit.path)).toContain("domains/tools/new-note.md");
    });

    it("is a genuine no-op on an in-sync cache (원칙 5 — a heal is not a rewrite)", async () => {
      const vaultDir = await createFtsFixture();
      tempDirs.push(vaultDir);
      const built = await buildFtsIndex({ vaultDir });

      const healed = await healFtsIndex({ vaultDir });
      expect(healed.healed).toBe(false);
      expect(healed.rebuilt).toBe(false);
      expect(healed.signature).toBe(built.signature);
    });

    it("heals an absent cache rather than reporting the miss upward", async () => {
      const vaultDir = await createFtsFixture();
      tempDirs.push(vaultDir);

      const healed = await healFtsIndex({ vaultDir });
      expect(healed.healed).toBe(true);
      expect(healed.verified).toBe(true);
      expect(existsSync(resolveFtsDbPath(vaultDir))).toBe(true);
    });

    it("surfaces a heal it cannot carry out instead of pretending the cache is fine (원칙 6)", async () => {
      const vaultDir = await createFtsFixture();
      tempDirs.push(vaultDir);
      // `.fts` occupied by a regular file: the index directory can never be created, so the
      // rebuild fails. A failed heal is an error, never a quiet "in sync".
      await writeFile(join(vaultDir, ".fts"), "not a directory\n", "utf8");

      await expect(healFtsIndex({ vaultDir })).rejects.toThrow();
    });

    it("leaves no scratch database behind when a build fails", async () => {
      const vaultDir = await createFtsFixture();
      tempDirs.push(vaultDir);
      const dbPath = join(vaultDir, ".fts", "vault-fts.db");
      // The scratch database's parent is a regular FILE, so creating it fails once the build is
      // already past the corpus walk — exercising the build's own cleanup path.
      await mkdir(join(vaultDir, ".fts"), { recursive: true });
      await writeFile(join(vaultDir, ".fts", "occupied"), "not a directory\n", "utf8");

      await expect(
        buildFtsIndex({ vaultDir, dbPath: join(vaultDir, ".fts", "occupied", "x.db") }),
      ).rejects.toThrow();
      expect(existsSync(dbPath)).toBe(false);
      const leftovers = (await readdir(join(vaultDir, ".fts"))).filter((name) => name.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    });

    it("reclaims a scratch database abandoned by a dead builder, and leaves a live builder's alone", async () => {
      const vaultDir = await createFtsFixture();
      tempDirs.push(vaultDir);
      await buildFtsIndex({ vaultDir });
      const indexDir = join(vaultDir, ".fts");

      // A killed build cannot clean up after itself. Its pid is gone, so the next build reclaims
      // the file; a scratch file owned by THIS (live) process must survive untouched.
      const abandoned = join(indexDir, "vault-fts.db.999999.1.tmp");
      const liveOwned = join(indexDir, `vault-fts.db.${process.pid}.99.tmp`);
      // Left by the retired shared-name scheme: no live builder can be holding it.
      const legacy = join(indexDir, "vault-fts.db.tmp");
      // Not this database's scratch file — the reaper stays out of it.
      const unrelated = join(indexDir, "something-else.tmp");
      await writeFile(abandoned, "abandoned scratch\n", "utf8");
      await writeFile(liveOwned, "in-flight scratch\n", "utf8");
      await writeFile(legacy, "legacy scratch\n", "utf8");
      await writeFile(unrelated, "not ours\n", "utf8");

      await buildFtsIndex({ vaultDir, force: true });

      expect(existsSync(abandoned)).toBe(false);
      expect(existsSync(legacy)).toBe(false);
      expect(existsSync(liveOwned)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    });

    it("survives concurrent builders: no shared scratch file, and the published index is whole (원칙 8)", async () => {
      const vaultDir = await createFtsFixture();
      tempDirs.push(vaultDir);

      // Four builders racing on one vault — the shape of several agent sessions committing at
      // once. A shared `<db>.tmp` used to let one builder delete another's half-written database.
      const builds = await Promise.all(
        Array.from({ length: 4 }, () => buildFtsIndex({ vaultDir, force: true })),
      );
      for (const build of builds) {
        expect(build.rebuilt).toBe(true);
      }
      // Whoever won the rename, the published index is complete and readable, and it matches the
      // tree — a later reader never sees a torn database.
      expect((await checkFtsIndex({ vaultDir })).wouldRebuild).toBe(false);
      expect(dumpFtsRows(resolveFtsDbPath(vaultDir)).length).toBe(4);
      const leftovers = (await readdir(join(vaultDir, ".fts"))).filter((name) => name.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    });
  });
});

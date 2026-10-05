import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatVaultLintReport, lintVaultFiles } from "./vault-lint.mjs";
import { rewriteIndex } from "./vault-ingest.mjs";

// The connection counts a whole-tree full lint reports next to its issues. Each test
// points KUMA_VAULT_STORES at a temp path so the machine's real registry is never read.

const SCHEMA = `---
title: Kuma Wiki Schema
description: fixture schema
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
`;

const DISPATCH_LOG = `---
title: Dispatch Log
type: special/dispatch-log
updated: 2026-04-09T09:00:23Z
entry_format: append-only-ledger
source_of_truth: kuma-dispatch-lifecycle
boot_priority: 1
---

## Entries
- 2026-04-09T09:00:23Z | project=acme-app | task_id=t-1 | worker=surface:5 | qa=worker-self-report | signal=s | state=dispatched
`;

const DECISIONS = `---
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
`;

function page(title, related) {
  return `---
title: ${title}
tags: [notes]
created: 2026-10-05
updated: 2026-10-05
sources: [https://example.com/${title.toLowerCase()}]
---

## Summary
${title} 요약.

## Details
${title} 세부.

## Related
${related}
`;
}

describe("vault lint connection counts", () => {
  const tempRoots = [];
  const savedStoresEnv = process.env.KUMA_VAULT_STORES;

  afterEach(async () => {
    if (savedStoresEnv === undefined) {
      delete process.env.KUMA_VAULT_STORES;
    } else {
      process.env.KUMA_VAULT_STORES = savedStoresEnv;
    }
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  // A canonical tree that passes full lint: three special files plus `domains/notes/`
  // with pages a and b linking each other and page c that nobody links to.
  async function writeTree(root) {
    const vaultDir = join(root, "vault");
    await mkdir(join(vaultDir, "domains", "notes"), { recursive: true });
    await writeFile(join(vaultDir, "vault.config.json"), JSON.stringify({ profile: "kuma-vault" }), "utf8");
    await writeFile(join(vaultDir, "schema.md"), SCHEMA, "utf8");
    await writeFile(join(vaultDir, "dispatch-log.md"), DISPATCH_LOG, "utf8");
    await writeFile(join(vaultDir, "decisions.md"), DECISIONS, "utf8");
    await writeFile(join(vaultDir, "domains", "notes", "a.md"), page("Alpha", "- [Beta](b.md)"), "utf8");
    await writeFile(join(vaultDir, "domains", "notes", "b.md"), page("Beta", "- [Alpha](./a) — extensionless\n- [Self](b.md)"), "utf8");
    await writeFile(join(vaultDir, "domains", "notes", "c.md"), page("Gamma", "- [Self](c.md#details) — a page linking itself is still an orphan"), "utf8");
    await rewriteIndex(vaultDir);
    return vaultDir;
  }

  async function scratch() {
    const root = await mkdtemp(join(tmpdir(), "kuma-vault-connections-"));
    tempRoots.push(root);
    process.env.KUMA_VAULT_STORES = join(root, "no-registry.json");
    return root;
  }

  it("counts orphans without failing the lint; generated index links do not count", async () => {
    const vaultDir = await writeTree(await scratch());

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.ok).toBe(true);
    expect(result.issueCount).toBe(0);
    // schema.md, decisions.md and c.md: every one sits in a generated README index,
    // but no page refers to it. dispatch-log.md is one of the profile's root non-nav
    // files (rootNonNavFiles), outside the count; decisions.md and schema.md are pages.
    expect(result.connections).toEqual({
      pages: 5,
      orphans: 3,
      unresolvedRefs: 0,
      crossStorePointers: 0,
      unknownStore: null,
    });
    expect(formatVaultLintReport(result)).toContain(
      "INFO connections pages=5 orphans=3 unresolved_refs=0 cross_store_pointers=0 unknown_store=unchecked (no valid store registry)",
    );
    expect(formatVaultLintReport(result).startsWith("VAULT_LINT_OK")).toBe(true);
  });

  it("counts a README's hand-written link as a reference", async () => {
    const vaultDir = await writeTree(await scratch());
    const readmePath = join(vaultDir, "domains", "notes", "README.md");
    const readme = await readFile(readmePath, "utf8");
    await writeFile(readmePath, readme.replace("<!-- vault-index:start -->", "Start with [Gamma](c.md).\n\n<!-- vault-index:start -->"), "utf8");

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(readme).toContain("<!-- vault-index:start -->");
    expect(result.connections.orphans).toBe(2);
  });

  it("counts unresolved links and unknown-store pointers; outside-tree, asset and code links are not counted", async () => {
    const root = await scratch();
    const vaultDir = await writeTree(root);
    const peer = join(root, "acme-ops");
    await mkdir(join(peer, "people"), { recursive: true });
    await writeFile(join(peer, "vault.config.json"), JSON.stringify({ id: "acme-ops", profile: "kuma-vault" }), "utf8");
    await writeFile(join(peer, "people", "x.md"), "# x\n", "utf8");
    const registryPath = join(root, "vault-stores.json");
    await writeFile(registryPath, JSON.stringify({ stores: { "acme-ops": peer } }), "utf8");
    process.env.KUMA_VAULT_STORES = registryPath;
    await writeFile(join(vaultDir, "domains", "notes", "pic.png"), "png", "utf8");
    await writeFile(
      join(vaultDir, "domains", "notes", "c.md"),
      page("Gamma", [
        "- [Gone](gone.md) — names nothing",
        "- [Picture](pic.png) — an asset resolves",
        "- [Outside](../../../outside.md) — leaves the tree, not counted",
        "- [Web](https://example.com/x.md)",
        "- `[Code](code.md)` is an example",
        "- `acme-ops:people/x.md` and `nowhere:people/y.md`",
      ].join("\n")),
      "utf8",
    );

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    expect(result.connections).toEqual({
      pages: 5,
      orphans: 3,
      unresolvedRefs: 1,
      crossStorePointers: 2,
      unknownStore: 1,
    });
    expect(formatVaultLintReport(result)).toContain(
      "INFO connections pages=5 orphans=3 unresolved_refs=1 cross_store_pointers=2 unknown_store=1",
    );
  });

  it("resolves a link the way lint checks it: a folder README wins over a same-named page", async () => {
    const vaultDir = await writeTree(await scratch());
    // domains/notes/d.md and the folder domains/notes/d/ (README + e.md) both answer "d".
    await writeFile(join(vaultDir, "domains", "notes", "d.md"), page("Delta", "- [Alpha](a.md)"), "utf8");
    await mkdir(join(vaultDir, "domains", "notes", "d"), { recursive: true });
    await writeFile(join(vaultDir, "domains", "notes", "d", "e.md"), page("Epsilon", "- [Alpha](../a.md)"), "utf8");
    await writeFile(
      join(vaultDir, "domains", "notes", "a.md"),
      page("Alpha", [
        "- [Beta](b.md)",
        "- [D](d) — the folder, as lint resolves it",
        "- [Beta again](B.md) — wrong case",
        "- [Shots](_assets/shots/) — an existing folder with no README: not a page, not dead",
      ].join("\n")),
      "utf8",
    );
    await mkdir(join(vaultDir, "domains", "notes", "_assets", "shots"), { recursive: true });
    await writeFile(join(vaultDir, "domains", "notes", "_assets", "shots", "one.png"), "png", "utf8");
    await rewriteIndex(vaultDir);

    const result = lintVaultFiles({ vaultDir, mode: "full" });

    // "d" is d/README.md, so d.md stays an orphan next to schema.md, decisions.md, c.md and
    // d/e.md; "B.md" names b.md with the wrong case, unresolved on every filesystem.
    expect(result.connections).toMatchObject({ pages: 7, orphans: 5, unresolvedRefs: 1 });
  });

  it("reports no counts for fast mode or an explicit file list", async () => {
    const vaultDir = await writeTree(await scratch());

    expect(lintVaultFiles({ vaultDir, mode: "fast" }).connections).toBeNull();
    const subset = lintVaultFiles({ vaultDir, mode: "full", files: ["domains/notes/a.md"] });
    expect(subset.connections).toBeNull();
    expect(formatVaultLintReport(subset)).not.toContain("INFO connections");
  });
});

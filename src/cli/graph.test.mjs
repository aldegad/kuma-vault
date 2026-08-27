import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGraphData } from "./graph.mjs";

// A tiny synthetic vault exercising every connection methodology the graph classifies.
let VAULT, EXT, REGISTRY, NO_REGISTRY;
beforeAll(() => {
  VAULT = mkdtempSync(join(tmpdir(), "kv-graph-"));
  mkdirSync(join(VAULT, "domains"), { recursive: true });
  mkdirSync(join(VAULT, "plans", "proj-a"), { recursive: true });

  writeFileSync(join(VAULT, "domains", "alpha.md"), [
    "---",
    "title: Alpha",
    "domain: research",
    "tags: [shared, alpha-only]",
    "aliases: [\"알파\"]",
    "related:",
    "  - beta.md",
    "---",
    "# Alpha",
    "",
    "Company truth lives at `ext-store:office/wifi.md` and `ext-store:projects/`.",
    "An unregistered id like `ghost-store:notes/x.md` is counted, not drawn.",
    "```",
    "`ext-store:fenced/ignored.md` inside a fence is an example, not a pointer.",
    "```",
  ].join("\n"));

  writeFileSync(join(VAULT, "domains", "beta.md"), [
    "---",
    "title: Beta",
    "domain: research",
    "tags: [shared]",
    "type: special/decisions",
    "---",
    "# Beta",
    "",
    "Also points at `ext-store:office/wifi.md` (same target dedups to one xdoc node).",
    "A pointer to THIS tree's own registered id resolves internally: `self-store:domains/alpha.md`.",
    "An internal miss is counted, not invented: `self-store:domains/missing.md`.",
  ].join("\n"));

  writeFileSync(join(VAULT, "plans", "proj-a", "master.md"), [
    "---",
    "title: Master plan",
    "project: proj-a",
    "---",
    "# Master",
  ].join("\n"));

  writeFileSync(join(VAULT, "plans", "proj-a", "child.md"), [
    "---",
    "title: Child plan",
    "project: proj-a",
    "parent_plan: proj-a/master.md",
    "---",
    "# Child",
  ].join("\n"));

  // A second knowledge tree + machine registry, mirroring the vault-stores fixtures.
  // The scanned vault itself is also registered (as "self-store") to exercise the
  // self-pointer path: those must resolve to internal nodes, never phantom externals.
  EXT = mkdtempSync(join(tmpdir(), "kv-graph-ext-"));
  writeFileSync(join(EXT, "vault.config.json"), JSON.stringify({ id: "ext-store", profile: "kuma-vault" }));
  mkdirSync(join(EXT, "office"), { recursive: true });
  writeFileSync(join(EXT, "office", "wifi.md"), "---\ntitle: Wifi\n---\n# Wifi\n");
  writeFileSync(join(VAULT, "vault.config.json"), JSON.stringify({ id: "self-store", profile: "kuma-vault" }));
  REGISTRY = join(mkdtempSync(join(tmpdir(), "kv-graph-reg-")), "vault-stores.json");
  writeFileSync(REGISTRY, JSON.stringify({ stores: { "ext-store": EXT, "self-store": VAULT } }));
  NO_REGISTRY = join(VAULT, "absent-registry.json");
});
afterAll(() => { for (const p of [VAULT, EXT]) if (p) rmSync(p, { recursive: true, force: true }); });

describe("buildGraphData", () => {
  it("builds a rooted graph with one edge set per connection methodology", () => {
    const d = buildGraphData(VAULT, { env: { KUMA_VAULT_STORES: NO_REGISTRY } });

    // root + folders + 4 docs + hubs
    expect(d.rootIdx).toBe(0);
    expect(d.nodes[d.rootIdx].type).toBe("root");
    expect(d.counts.docs).toBe(4);
    expect(d.counts.folders).toBeGreaterThanOrEqual(3); // domains, plans, plans/proj-a

    // hierarchy connects every non-root node to a parent (folders + docs)
    expect(d.counts.hier).toBe(d.counts.folders + d.counts.docs);

    // explicit reference: alpha -> beta
    expect(d.counts.ref).toBe(1);

    // shared tag "shared" (alpha, beta) becomes a hub; "alpha-only" (1 doc) does not
    expect(d.counts.tagHubs).toBe(1);
    expect(d.counts.tag).toBe(2);

    // `domain:` is a DEPRECATED field (2026-07-05): the graph keeps reading it purely as a
    // DRIFT detector — leftover values still form hubs so `vault graph` can show migration
    // progress (count 0 = clean). These two fixtures intentionally retain `domain:` to exercise
    // that drift layer; the research hub links both research docs.
    expect(d.counts.domain).toBe(2);

    // schema type hub from beta's `type: special/decisions`
    expect(d.counts.schema).toBe(1);

    // project hub "proj-a" links the two plan docs
    expect(d.counts.project).toBe(2);

    // parent_plan chain: child -> master
    expect(d.counts.planline).toBe(1);

    // every layer key is present as an array
    for (const key of ["hier", "ref", "xstore", "alias", "tag", "domain", "schema", "project", "planline"]) {
      expect(Array.isArray(d.layers[key])).toBe(true);
    }
  });

  it("with no store registry the xstore layer is empty and the skip is reported, not silent", () => {
    const d = buildGraphData(VAULT, { env: { KUMA_VAULT_STORES: NO_REGISTRY } });
    expect(d.xstoreEnabled).toBe(false);
    expect(d.xstoreSkipReason).toMatch(/no store registry/u);
    expect(d.counts.xstore).toBe(0);
    expect(d.counts.xstoreHubs).toBe(0);
  });

  it("draws registered cross-store pointers as store hub + external doc nodes", () => {
    const d = buildGraphData(VAULT, { env: { KUMA_VAULT_STORES: REGISTRY } });
    expect(d.xstoreEnabled).toBe(true);
    expect(d.xstoreSkipReason).toBeNull();

    // one store hub; two distinct targets (wifi.md referenced by both docs dedups; projects/)
    expect(d.counts.xstoreHubs).toBe(1);
    expect(d.counts.xstoreDocs).toBe(2);
    // edges: hub->wifi, hub->projects/, alpha->wifi, alpha->projects/, beta->wifi,
    // plus beta->alpha resolved INTERNALLY from the self-store pointer
    expect(d.counts.xstore).toBe(6);

    // the unregistered store-id is counted, never drawn (the lint owns failing it loud);
    // the fenced example is not extracted at all
    expect(d.counts.xstoreUnknown).toBe(1);
    const ids = d.nodes.map((n) => n.id);
    expect(ids).toContain("xst:ext-store");
    expect(ids).toContain("xdoc:ext-store:office/wifi.md");
    expect(ids.some((i) => i.includes("ghost-store"))).toBe(false);
    expect(ids.some((i) => i.includes("fenced"))).toBe(false);

    // self-store pointers never mint phantom external nodes: no self hub, no self xdoc,
    // and the internal miss is surfaced as a count
    expect(ids.some((i) => i.includes("self-store"))).toBe(false);
    expect(d.counts.xstoreUnresolved).toBe(1);
    const alphaIdx = d.nodes.findIndex((n) => n.id === "doc:domains/alpha.md");
    const betaIdx = d.nodes.findIndex((n) => n.id === "doc:domains/beta.md");
    const pair = [Math.min(alphaIdx, betaIdx), Math.max(alphaIdx, betaIdx)];
    expect(d.layers.xstore.some(([a, b]) => a === pair[0] && b === pair[1])).toBe(true);

    const hub = d.nodes.find((n) => n.id === "xst:ext-store");
    expect(hub.type).toBe("xstore");
    const xdoc = d.nodes.find((n) => n.id === "xdoc:ext-store:office/wifi.md");
    expect(xdoc.type).toBe("xdoc");
    expect(xdoc.title).toBe("wifi.md");
  });

  it("--all-stores unions every scannable registered store with real doc-to-doc bridges", () => {
    const d = buildGraphData(VAULT, { env: { KUMA_VAULT_STORES: REGISTRY }, allStores: true });
    expect(d.union).toBe(true);
    expect(d.stores.map((s) => s.storeId).sort()).toEqual(["ext-store", "self-store"]);
    expect(d.rootIdxs).toHaveLength(2);
    for (const r of d.rootIdxs) expect(d.nodes[r].type).toBe("root");
    // the primary tree's identity self-heals from the registry, not from its basename
    expect(d.rootName).toBe("self-store");

    // both trees' documents are REAL nodes, ids namespaced by store
    const ids = d.nodes.map((n) => n.id);
    expect(ids).toContain("doc:self-store:domains/alpha.md");
    expect(ids).toContain("doc:ext-store:office/wifi.md");

    // every node carries its store index so the renderer can anchor stores separately
    expect(d.nodes.every((n) => n.st === 0 || n.st === 1)).toBe(true);
    expect(d.nodes.find((n) => n.id === "doc:self-store:domains/alpha.md").st)
      .not.toBe(d.nodes.find((n) => n.id === "doc:ext-store:office/wifi.md").st);

    // every scanned store resolves internally: zero phantom hubs/xdocs remain
    expect(d.counts.xstoreHubs).toBe(0);
    expect(d.counts.xstoreDocs).toBe(0);
    expect(ids.some((i) => i.startsWith("xst:") || i.startsWith("xdoc:"))).toBe(false);

    // edges: alpha->wifi (bridge), beta->wifi (bridge), beta->alpha (within self-store)
    expect(d.counts.xstore).toBe(3);
    expect(d.counts.xstoreBridges).toBe(2);
    // misses stay counts, never invented nodes: ext-store:projects/ and self-store:domains/missing.md
    expect(d.counts.xstoreUnresolved).toBe(2);
    expect(d.counts.xstoreUnknown).toBe(1); // ghost-store

    // the tree view groups each store under its own top-level entry
    expect(d.tree.map((t) => t.name).sort()).toEqual(["ext-store", "self-store"]);
  });

  it("--all-stores without a registry is a loud error, not a silent single-store render", () => {
    expect(() => buildGraphData(VAULT, { env: { KUMA_VAULT_STORES: NO_REGISTRY }, allStores: true }))
      .toThrow(/store registry/u);
  });
});

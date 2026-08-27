import { describe, expect, it } from "vitest";

import {
  buildEnrichPrompt,
  createCliDescriptionGenerator,
  isSupportedEnrichProvider,
  parseEnrichResponse,
  SUPPORTED_ENRICH_PROVIDERS,
} from "./provider-adapter.mjs";

describe("SUPPORTED_ENRICH_PROVIDERS", () => {
  it("supports exactly claude and codex", () => {
    expect([...SUPPORTED_ENRICH_PROVIDERS].sort()).toEqual(["claude", "codex"]);
    expect(isSupportedEnrichProvider("claude")).toBe(true);
    expect(isSupportedEnrichProvider("codex")).toBe(true);
    expect(isSupportedEnrichProvider("gemini")).toBe(false);
    expect(isSupportedEnrichProvider(undefined)).toBe(false);
  });
});

describe("createCliDescriptionGenerator", () => {
  it("adopts the requested provider and model", () => {
    const generate = createCliDescriptionGenerator({ provider: "codex", model: "gpt-5.5" });
    expect(generate.provider).toBe("codex");
    expect(generate.model).toBe("gpt-5.5");
    expect(typeof generate).toBe("function");
  });

  it("defaults the model per provider when omitted", () => {
    expect(createCliDescriptionGenerator({ provider: "claude" }).model).toBe("claude-sonnet-5");
    expect(createCliDescriptionGenerator({ provider: "codex" }).model).toBe("gpt-5.4-mini");
  });

  it("trims a whitespace-only model down to the provider default", () => {
    expect(createCliDescriptionGenerator({ provider: "claude", model: "   " }).model).toBe("claude-sonnet-5");
  });

  it("throws on an unsupported provider (No Silent Fallback)", () => {
    expect(() => createCliDescriptionGenerator({ provider: "gemini" })).toThrow(/not supported/u);
    expect(() => createCliDescriptionGenerator({})).toThrow(/not supported/u);
  });
});

describe("buildEnrichPrompt", () => {
  it("embeds the title, path, and a truncated body between document tags", () => {
    const prompt = buildEnrichPrompt({
      relativePath: "domains/foo.md",
      title: "Foo domain",
      body: "x".repeat(20_000),
    });
    expect(prompt).toContain("Title: Foo domain");
    expect(prompt).toContain("Path: domains/foo.md");
    expect(prompt).toContain("<document>");
    expect(prompt).toContain("</document>");
    // Body is capped at 8000 chars, so the raw 20k-char body must be truncated.
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("asks for all three labeled fields (description + tags + aliases)", () => {
    const prompt = buildEnrichPrompt({ relativePath: "a.md", title: "A", body: "b" });
    expect(prompt).toContain("DESCRIPTION:");
    expect(prompt).toContain("TAGS:");
    expect(prompt).toContain("ALIASES:");
  });

  it("bounded-vocab: seeds the existing tag pool and instructs reuse over minting new tags", () => {
    const prompt = buildEnrichPrompt({
      relativePath: "a.md",
      title: "A",
      body: "b",
      tagPool: ["cli", "parser", "rust"],
    });
    // The exact vocabulary is injected so the model reuses it.
    expect(prompt).toContain("cli, parser, rust");
    expect(prompt.toLowerCase()).toContain("prefer reusing");
  });

  it("degrades gracefully when the vault has no tags yet (no empty pool line)", () => {
    const prompt = buildEnrichPrompt({ relativePath: "a.md", title: "A", body: "b", tagPool: [] });
    expect(prompt).toContain("No tags exist in the vault yet");
    expect(prompt).toContain("TAGS:");
  });
});

describe("parseEnrichResponse", () => {
  it("parses the labeled three-line response into description/tags/aliases", () => {
    const parsed = parseEnrichResponse(
      "DESCRIPTION: A Rust CLI for parsing HWP documents.\nTAGS: cli, rust, parser\nALIASES: 한글파서, hwp reader",
    );
    expect(parsed.description).toBe("A Rust CLI for parsing HWP documents.");
    expect(parsed.tags).toEqual(["cli", "rust", "parser"]);
    expect(parsed.aliases).toEqual(["한글파서", "hwp reader"]);
  });

  it("is case-insensitive on labels and tolerates surrounding prose", () => {
    const parsed = parseEnrichResponse(
      "Here is the metadata you asked for:\ndescription: Synopsis line.\ntags: alpha, beta\naliases: \nThanks!",
    );
    expect(parsed.description).toBe("Synopsis line.");
    expect(parsed.tags).toEqual(["alpha", "beta"]);
    // An empty ALIASES value yields an empty list, not [""].
    expect(parsed.aliases).toEqual([]);
  });

  it("falls back to a bare first line as the description when the label is omitted (legacy habit)", () => {
    const parsed = parseEnrichResponse("A one-line synopsis with no label.\n");
    expect(parsed.description).toBe("A one-line synopsis with no label.");
    expect(parsed.tags).toEqual([]);
    expect(parsed.aliases).toEqual([]);
  });

  it("returns an empty description when the model produced nothing usable", () => {
    expect(parseEnrichResponse("").description).toBe("");
    expect(parseEnrichResponse("   \n  ").description).toBe("");
  });
});

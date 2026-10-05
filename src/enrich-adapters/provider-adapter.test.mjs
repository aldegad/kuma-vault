import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    // claude: the family alias, which the CLI maps to the latest model; codex: an id its catalog
    // lists for a ChatGPT sign-in (gpt-5.4-mini is refused there).
    expect(createCliDescriptionGenerator({ provider: "claude" }).model).toBe("sonnet");
    expect(createCliDescriptionGenerator({ provider: "codex" }).model).toBe("gpt-6-luna");
  });

  it("trims a whitespace-only model down to the provider default", () => {
    expect(createCliDescriptionGenerator({ provider: "claude", model: "   " }).model).toBe("sonnet");
  });

  it("throws on an unsupported provider (No Silent Fallback)", () => {
    expect(() => createCliDescriptionGenerator({ provider: "gemini" })).toThrow(/not supported/u);
    expect(() => createCliDescriptionGenerator({})).toThrow(/not supported/u);
  });
});

// Stand-ins for the provider CLIs, first on PATH. Each records its argv and answers in the
// three-line contract. The claude one behaves as `claude --help` documents `--bare`: auth is then
// ANTHROPIC_API_KEY or an apiKeyHelper only, so a subscription sign-in gets "Not logged in".
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: "claude", args, cwd: process.cwd() }) + "\\n");
if (args.includes("--bare") && !process.env.ANTHROPIC_API_KEY) {
  process.stdout.write("Not logged in · Please run /login\\n");
  process.exit(1);
}
process.stdout.write("DESCRIPTION: A synopsis.\\nTAGS: notes\\nALIASES: \\n");
`;
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: "codex", args, cwd: process.cwd() }) + "\\n");
writeFileSync(args[args.indexOf("--output-last-message") + 1], "DESCRIPTION: A synopsis.\\nTAGS: notes\\nALIASES: \\n");
`;

describe("the provider CLI call", () => {
  let dir;
  const saved = {};
  const calls = () => readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const page = { relativePath: "domains/a.md", title: "A", body: "a body" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kv-adapter-"));
    mkdirSync(join(dir, "bin"));
    for (const [name, source] of [["claude", FAKE_CLAUDE], ["codex", FAKE_CODEX]]) {
      writeFileSync(join(dir, "bin", name), source);
      chmodSync(join(dir, "bin", name), 0o755);
    }
    for (const key of ["PATH", "FAKE_CLI_LOG", "ANTHROPIC_API_KEY"]) saved[key] = process.env[key];
    process.env.PATH = `${join(dir, "bin")}:${process.env.PATH}`;
    process.env.FAKE_CLI_LOG = join(dir, "calls.jsonl");
    delete process.env.ANTHROPIC_API_KEY; // signed in by subscription, as most users are
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("claude: a subscription sign-in is used, and nothing of the user's setup is loaded", async () => {
    const result = await createCliDescriptionGenerator({ provider: "claude" })(page);
    expect(result.description).toBe("A synopsis.");
    const [call] = calls();
    expect(call.args).not.toContain("--bare");
    expect(call.args).toContain("--safe-mode"); // no CLAUDE.md, hooks, MCP servers, skills or plugins
    expect(call.args[call.args.indexOf("--tools") + 1]).toBe(""); // no tools at all
    expect(call.args).not.toContain("--dangerously-skip-permissions"); // nothing left to permit
    expect(call.args).toContain("--no-session-persistence");
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("sonnet");
    expect(call.args.at(-1)).toContain("Path: domains/a.md");
    expect(call.cwd).not.toBe(process.cwd()); // an empty temp dir, never the caller's repo
  });

  it("codex: the default model is passed, from an empty temp dir", async () => {
    const result = await createCliDescriptionGenerator({ provider: "codex", effort: "low" })(page);
    expect(result.description).toBe("A synopsis.");
    const [call] = calls();
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("gpt-6-luna");
    expect(call.args).toContain('model_reasoning_effort="low"');
    expect(call.cwd).not.toBe(process.cwd());
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

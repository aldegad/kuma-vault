import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  normalizeProviderChoice,
  isAffirmative,
  resolveStarRepo,
  writeProviderConfig,
  starRepository,
  commandVaultSetup,
  checkProviderModel,
  DEFAULT_STAR_REPO,
  SETUP_PROVIDERS,
} from "./setup.mjs";

// A minimal writable sink that records everything the orchestrator prints.
function makeOutput() {
  const lines = [];
  return { write: (chunk) => lines.push(String(chunk)), text: () => lines.join("") };
}

// A scripted `gh`/bin runner: pops one result per call and records the argv.
// The provider check as setup calls it: records what it was asked, fails when told to.
function makeCheck(failure) {
  const calls = [];
  const check = async (args) => {
    calls.push(args);
    if (failure) throw new Error(failure);
    return args;
  };
  check.calls = calls;
  return check;
}

function makeRunner(results) {
  const calls = [];
  const queue = [...results];
  const run = (command, args) => {
    calls.push({ command, args });
    return queue.shift() ?? { status: 0, stdout: "", stderr: "" };
  };
  run.calls = calls;
  return run;
}

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kv-setup-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pure helpers", () => {
  it("normalizeProviderChoice maps numbers, ids, and case; rejects junk", () => {
    expect(normalizeProviderChoice("1")).toBe(SETUP_PROVIDERS[0]);
    expect(normalizeProviderChoice("2")).toBe(SETUP_PROVIDERS[1]);
    expect(normalizeProviderChoice("claude")).toBe("claude");
    expect(normalizeProviderChoice("CODEX")).toBe("codex");
    expect(normalizeProviderChoice("  Claude ")).toBe("claude");
    expect(normalizeProviderChoice("9")).toBeNull();
    expect(normalizeProviderChoice("gpt")).toBeNull();
    expect(normalizeProviderChoice("")).toBeNull();
  });

  it("isAffirmative only accepts explicit yes (default is No)", () => {
    for (const yes of ["y", "Y", "yes", "YES", " yes "]) expect(isAffirmative(yes)).toBe(true);
    for (const no of ["", "n", "no", "sure", "1", undefined]) expect(isAffirmative(no)).toBe(false);
  });

  it("resolveStarRepo prefers flag > config > built-in default, and rejects malformed", () => {
    expect(resolveStarRepo({})).toBe(DEFAULT_STAR_REPO);
    expect(resolveStarRepo({ configStarRepo: "org/mirror" })).toBe("org/mirror");
    expect(resolveStarRepo({ repoFlag: "me/fork", configStarRepo: "org/mirror" })).toBe("me/fork");
    expect(resolveStarRepo({ repoFlag: "not-a-repo" })).toBeNull();
    expect(resolveStarRepo({ repoFlag: "a/b/c" })).toBeNull();
  });

});

describe("writeProviderConfig", () => {
  it("writes {provider, model} with the default model when omitted", () => {
    const configPath = join(tmp, "config.json");
    const saved = writeProviderConfig({ configPath, provider: "claude" });
    expect(saved).toEqual({ provider: "claude", model: "sonnet" });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(saved);
  });

  it("honors an explicit model and optional effort/serviceTier", () => {
    const configPath = join(tmp, "config.json");
    const saved = writeProviderConfig({
      configPath,
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      serviceTier: "flex",
    });
    expect(saved).toMatchObject({ provider: "codex", model: "gpt-5.5", effort: "high", serviceTier: "flex" });
  });

  it("merges into an existing config, preserving unrelated keys (e.g. starRepo)", () => {
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify({ starRepo: "org/mirror", provider: "codex" }));
    const saved = writeProviderConfig({ configPath, provider: "claude" });
    expect(saved.starRepo).toBe("org/mirror");
    expect(saved.provider).toBe("claude");
  });

  it("rejects an unsupported provider (no silent default)", () => {
    expect(() => writeProviderConfig({ configPath: join(tmp, "c.json"), provider: "gpt" })).toThrow(/Unsupported provider/);
  });
});

describe("starRepository (explicit-consent, no silent fallback)", () => {
  it("skips when the repo is unknown", () => {
    const run = makeRunner([]);
    const result = starRepository({ repo: null, runCommand: run });
    expect(result).toMatchObject({ starred: false, reason: "no-repo" });
    expect(run.calls).toHaveLength(0);
  });

  it("skips with an explicit notice when gh is not installed", () => {
    const run = makeRunner([{ error: { code: "ENOENT" } }]);
    const result = starRepository({ repo: "aldegad/kuma-vault", runCommand: run });
    expect(result).toMatchObject({ starred: false, reason: "gh-missing" });
    expect(result.message).toMatch(/not installed/);
  });

  it("skips when gh is unauthenticated", () => {
    const run = makeRunner([{ status: 0 }, { status: 1, stderr: "not logged in" }]);
    const result = starRepository({ repo: "aldegad/kuma-vault", runCommand: run });
    expect(result).toMatchObject({ starred: false, reason: "gh-unauthed" });
  });

  it("stars via PUT /user/starred on the happy path", () => {
    const run = makeRunner([{ status: 0 }, { status: 0 }, { status: 0 }]);
    const result = starRepository({ repo: "aldegad/kuma-vault", runCommand: run });
    expect(result).toMatchObject({ starred: true, reason: "ok" });
    expect(run.calls.at(-1)).toEqual({
      command: "gh",
      args: ["api", "--method", "PUT", "/user/starred/aldegad/kuma-vault"],
    });
  });

  it("reports a gh API failure without throwing", () => {
    const run = makeRunner([{ status: 0 }, { status: 0 }, { status: 1, stderr: "HTTP 403" }]);
    const result = starRepository({ repo: "aldegad/kuma-vault", runCommand: run });
    expect(result).toMatchObject({ starred: false, reason: "gh-error" });
    expect(result.message).toMatch(/403/);
  });
});

describe("commandVaultSetup (non-interactive / agent + CI path)", () => {
  const notty = { isTTY: false };

  it("requires an explicit provider when not a TTY (no silent default)", async () => {
    await expect(
      commandVaultSetup({ yes: true, config: join(tmp, "c.json") }, { input: notty, output: makeOutput() }),
    ).rejects.toThrow(/--provider/);
  });

  it("persists the provider and skips the star unless --star is given", async () => {
    const configPath = join(tmp, "config.json");
    const output = makeOutput();
    const run = makeRunner([]);
    const saved = await commandVaultSetup(
      { provider: "claude", yes: true, config: configPath },
      { input: notty, output, runCommand: run, checkModel: makeCheck() },
    );
    expect(saved).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(JSON.parse(readFileSync(configPath, "utf8")).provider).toBe("claude");
    expect(run.calls).toHaveLength(0); // no star attempted
    expect(output.text()).toMatch(/Skipped the GitHub star/);
  });

  it("stars only on explicit --star opt-in, routed through the injected runner", async () => {
    const configPath = join(tmp, "config.json");
    const output = makeOutput();
    const run = makeRunner([{ status: 0 }, { status: 0 }, { status: 0 }]);
    await commandVaultSetup(
      { provider: "codex", yes: true, star: true, repo: "me/fork", config: configPath },
      { input: notty, output, runCommand: run, checkModel: makeCheck() },
    );
    expect(run.calls.at(-1)).toEqual({
      command: "gh",
      args: ["api", "--method", "PUT", "/user/starred/me/fork"],
    });
    expect(output.text()).toMatch(/Starred me\/fork/);
  });

  it("checks the chosen model with one real call before saving anything", async () => {
    const configPath = join(tmp, "config.json");
    const check = makeCheck();
    const output = makeOutput();
    await commandVaultSetup(
      { provider: "codex", model: "gpt-6-astra", effort: "low", yes: true, config: configPath },
      { input: notty, output, runCommand: makeRunner([]), checkModel: check },
    );
    expect(check.calls).toEqual([{ provider: "codex", model: "gpt-6-astra", effort: "low", serviceTier: null }]);
    expect(output.text()).toMatch(/Checking codex with model gpt-6-astra/);
  });

  it("fails, saving nothing, when the provider refuses the model", async () => {
    const configPath = join(tmp, "config.json");
    const check = makeCheck("Enrich provider check failed: codex with model \"gpt-5.4-mini\" did not answer");
    await expect(
      commandVaultSetup(
        { provider: "codex", model: "gpt-5.4-mini", yes: true, config: configPath },
        { input: notty, output: makeOutput(), runCommand: makeRunner([]), checkModel: check },
      ),
    ).rejects.toThrow(/check failed: codex with model "gpt-5.4-mini"/);
    expect(existsSync(configPath)).toBe(false);
  });

  it("rejects an unsupported provider up front", async () => {
    await expect(
      commandVaultSetup({ provider: "gpt", yes: true, config: join(tmp, "c.json") }, { input: notty, output: makeOutput() }),
    ).rejects.toThrow(/Unsupported provider/);
  });
});

describe("commandVaultSetup (interactive TTY readline path)", () => {
  // A fake TTY driven reactively: each time the orchestrator prints a prompt (a chunk ending
  // in ": "), feed the next queued answer. readline/promises drops un-awaited `line` events,
  // so answers must arrive one-per-prompt, not all up front.
  function interactiveHarness(answers) {
    const input = new PassThrough();
    input.isTTY = true;
    const queue = [...answers];
    const lines = [];
    const output = {
      write(chunk) {
        const text = String(chunk);
        lines.push(text);
        if (/: $/.test(text)) {
          queueMicrotask(() => {
            if (queue.length) input.write(`${queue.shift()}\n`);
          });
        }
        return true;
      },
      text: () => lines.join(""),
    };
    return { input, output };
  }

  it("prompts for provider/model/star/hook and persists the picks; retries a bad provider", async () => {
    const configPath = join(tmp, "config.json");
    const run = makeRunner([{ status: 0 }, { status: 0 }, { status: 0 }]);
    // answers: bad provider -> retry "2" (codex); model = Enter (default); star = "y"; hook = Enter (skip)
    const { input, output } = interactiveHarness(["banana", "2", "", "y", ""]);
    const saved = await commandVaultSetup(
      { config: configPath, repo: "me/fork" },
      { input, output, runCommand: run, checkModel: makeCheck() },
    );
    expect(saved).toMatchObject({ provider: "codex", model: "gpt-6-luna" });
    expect(JSON.parse(readFileSync(configPath, "utf8")).provider).toBe("codex");
    // star consented in the prompt -> routed through the injected runner (PUT /user/starred/me/fork)
    expect(run.calls.at(-1)).toEqual({
      command: "gh",
      args: ["api", "--method", "PUT", "/user/starred/me/fork"],
    });
    const text = output.text();
    expect(text).toMatch(/Enrich provider/);
    expect(text).toMatch(/star .*github/i);
    expect(text).toMatch(/Not recognized/); // the bad-provider retry prompt fired
  });

  it("keeps the default provider on an empty answer and declines the star by default", async () => {
    const configPath = join(tmp, "config.json");
    const run = makeRunner([]);
    // answers: provider = Enter (default = first = claude); model = Enter; star = Enter (No); hook = Enter
    const { input, output } = interactiveHarness(["", "", "", ""]);
    const saved = await commandVaultSetup({ config: configPath }, { input, output, runCommand: run, checkModel: makeCheck() });
    expect(saved.provider).toBe("claude");
    expect(run.calls).toHaveLength(0); // star declined by default
    expect(output.text()).toMatch(/Skipped the GitHub star/);
  });
});

describe("checkProviderModel (the real call, against a stand-in CLI)", () => {
  // A codex stand-in that refuses a model the way codex-cli 0.160.0 does for a ChatGPT sign-in,
  // and answers in the adapter's contract for any other.
  const FAKE_CODEX = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
if (model === "gpt-5.4-mini") {
  process.stderr.write('ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \\'gpt-5.4-mini\\' model is not supported when using Codex with a ChatGPT account."}}\\n');
  process.exit(1);
}
writeFileSync(args[args.indexOf("--output-last-message") + 1], model === "silent" ? "\\n" : "DESCRIPTION: Checks the provider.\\nTAGS: setup\\nALIASES: \\n");
`;
  let savedPath;

  beforeEach(() => {
    mkdirSync(join(tmp, "bin"));
    writeFileSync(join(tmp, "bin", "codex"), FAKE_CODEX);
    chmodSync(join(tmp, "bin", "codex"), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${join(tmp, "bin")}:${process.env.PATH}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("passes when the CLI answers with a description", async () => {
    await expect(checkProviderModel({ provider: "codex", model: "gpt-6-luna" })).resolves.toEqual({ provider: "codex", model: "gpt-6-luna" });
  });

  it("fails loudly, in the CLI's words, when the CLI refuses the model", async () => {
    await expect(checkProviderModel({ provider: "codex", model: "gpt-5.4-mini" })).rejects.toThrow(
      /check failed: codex with model "gpt-5\.4-mini" did not answer \(.*not supported when using Codex with a ChatGPT account/,
    );
  });

  it("fails when the CLI answers with no description", async () => {
    await expect(checkProviderModel({ provider: "codex", model: "silent" })).rejects.toThrow(/answered without a description/);
  });
});

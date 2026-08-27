// Generic provider-adapter for `vault sync --enrich`.
//
// The enrich engine (vault-enrich.mjs) is pure: it takes an injected async
// `generateDescription({ relativePath, title, body, tagPool }) => { description, tags, aliases }`.
// This adapter is the engine-side factory that turns a provider choice (`claude` | `codex`) into
// that injected function by spawning the provider's CLI once per page.
//
// It lives outside the engine core so the core stays process-free and unit-testable with a mock.
// The provider CLI runs in a per-call EMPTY temp dir — never the caller's repo — so it can't load
// project instructions, see uncommitted work, or answer the repo instead of summarizing the page.
//
// The wire contract is a labeled three-line response (DESCRIPTION/TAGS/ALIASES). `buildEnrichPrompt`
// owns the prompt (and seeds the existing tag pool for bounded-vocab reuse); `parseEnrichResponse`
// owns turning the model's text back into `{ description, tags, aliases }`. Both are exported so a
// consumer wiring its own tool-model can reuse the exact contract instead of re-deriving it.
//
// Host policy (which provider/model to use — e.g. resolved from a team config) is a CONSUMER
// concern: the consumer picks provider+model and calls this factory. The engine only owns the
// generic spawn mechanism. Supported providers are held locally here (no host engine-registry import).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeCliOutput, runProcess } from "./process-util.mjs";

// Supported enrich providers. Kept local (inline) instead of importing a host engine registry —
// the adapter is the single source of truth for what it can spawn.
export const SUPPORTED_ENRICH_PROVIDERS = new Set(["claude", "codex"]);

export function isSupportedEnrichProvider(provider) {
  return SUPPORTED_ENRICH_PROVIDERS.has(provider);
}

const DEFAULT_MODEL_BY_PROVIDER = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.4-mini",
};

// Keep a page's body from blowing past a sane prompt budget; a synopsis only needs the opening of
// the document, not its entire contents.
const ENRICH_BODY_MAX_CHARS = 8_000;
// Bound the tag pool injected into the prompt so a large vault can't blow the prompt budget; the
// most-common vocabulary is what the model needs to reuse.
const ENRICH_TAG_POOL_MAX = 200;

const ENRICH_RESPONSE_LABEL_PATTERN = /^\s*(DESCRIPTION|TAGS|ALIASES)\s*:\s*(.*)$/iu;

export function buildEnrichPrompt({ relativePath, title, body, tagPool = [] }) {
  const pool = (Array.isArray(tagPool) ? tagPool : [])
    .map((tag) => String(tag ?? "").trim())
    .filter(Boolean)
    .slice(0, ENRICH_TAG_POOL_MAX);
  const tagGuidance = pool.length > 0
    ? `PREFER reusing one of the vault's existing tags below; only coin a new tag when none fit: ${pool.join(", ")}`
    : "No tags exist in the vault yet — choose concise, reusable topic tags a future page could share.";

  return [
    "You are the vault curator. Produce canonical search metadata for the document below.",
    "Return EXACTLY these three labeled lines and nothing else (no preface, no markdown, no code fence):",
    "DESCRIPTION: <one-line synopsis, about 10-25 words>",
    "TAGS: <2 to 6 comma-separated topic tags>",
    "ALIASES: <comma-separated alternate names, acronyms, and cross-language (e.g. Korean<->English) search terms; leave blank after the colon if none apply>",
    "",
    "Rules:",
    "- Write DESCRIPTION in the same language as the document; one line, no surrounding quotes.",
    `- ${tagGuidance}`,
    "- ALIASES are how a person might search for this from memory: synonyms, romanizations, and the other-language name.",
    "- Never put a comma inside an individual tag or alias.",
    "",
    `Title: ${title}`,
    `Path: ${relativePath}`,
    "",
    "<document>",
    String(body ?? "").slice(0, ENRICH_BODY_MAX_CHARS),
    "</document>",
  ].join("\n");
}

// Parse the model's labeled response into { description, tags, aliases }. Tolerant of extra prose
// around the labels (only the labeled lines are read). If the model ignored the DESCRIPTION label
// and returned a bare synopsis line (the legacy single-line habit), the first non-empty, non-label
// line is used as the description; tags/aliases require their labels. The engine sanitizes whatever
// comes back, so this stays a thin extractor.
export function parseEnrichResponse(rawText) {
  const lines = String(rawText ?? "").replace(/\r\n/gu, "\n").split("\n");
  const labeled = { description: null, tags: null, aliases: null };
  let firstBareLine = "";
  for (const line of lines) {
    const match = line.match(ENRICH_RESPONSE_LABEL_PATTERN);
    if (match) {
      labeled[match[1].toLowerCase()] = match[2].trim();
      continue;
    }
    if (!firstBareLine && line.trim()) {
      firstBareLine = line.trim();
    }
  }

  const splitList = (value) =>
    String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  const description = labeled.description != null ? labeled.description : firstBareLine;
  return {
    description,
    tags: splitList(labeled.tags),
    aliases: splitList(labeled.aliases),
  };
}

async function runCodexPrompt({ prompt, model, effort, serviceTier }) {
  const tempDir = await mkdtemp(join(tmpdir(), "kuma-enrich-"));
  const outputPath = join(tempDir, "description.txt");
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    tempDir,
    "--model",
    model,
    "--output-last-message",
    outputPath,
  ];
  if (effort) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }
  if (serviceTier) {
    args.push("-c", `service_tier="${serviceTier}"`);
  }
  args.push("-");

  try {
    const { stdout } = await runProcess("codex", args, { cwd: tempDir, input: prompt });
    try {
      return normalizeCliOutput(await readFile(outputPath, "utf8"));
    } catch {
      // No silent stdout fallback: exec stdout is progress/log noise, not the final message.
      const error = new Error("codex enrich produced no output-last-message file");
      error.details = normalizeCliOutput(stdout).slice(-2000);
      throw error;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runClaudePrompt({ prompt, model }) {
  const tempDir = await mkdtemp(join(tmpdir(), "kuma-enrich-"));
  const args = [
    "--print",
    "--output-format",
    "text",
    "--bare",
    "--no-session-persistence",
    "--dangerously-skip-permissions",
    "--model",
    model,
    prompt,
  ];
  try {
    const { stdout } = await runProcess("claude", args, { cwd: tempDir, input: "" });
    return normalizeCliOutput(stdout);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Build the injected `generateDescription` for the enrich engine from a provider choice.
 *
 * @param {object} opts
 * @param {"claude"|"codex"} opts.provider  Which provider CLI to spawn (required).
 * @param {string} [opts.model]             Model id; defaults per provider when omitted.
 * @param {string} [opts.effort]            codex reasoning effort (opt).
 * @param {string} [opts.serviceTier]       codex service tier (opt).
 * @returns {(page: {relativePath: string, title: string, body: string, tagPool?: string[]}) =>
 *          Promise<{description: string, tags: string[], aliases: string[]}>}
 *          The returned function also carries `.provider` and `.model`.
 */
export function createCliDescriptionGenerator({ provider, model, effort, serviceTier } = {}) {
  if (!isSupportedEnrichProvider(provider)) {
    throw new Error(
      `Enrich provider "${provider}" is not supported. Supported: ${[...SUPPORTED_ENRICH_PROVIDERS].join(", ")}.`,
    );
  }
  const resolvedModel = typeof model === "string" && model.trim()
    ? model.trim()
    : DEFAULT_MODEL_BY_PROVIDER[provider];

  const generator = async ({ relativePath, title, body, tagPool }) => {
    const prompt = buildEnrichPrompt({ relativePath, title, body, tagPool });
    const raw = provider === "claude"
      ? await runClaudePrompt({ prompt, model: resolvedModel })
      : await runCodexPrompt({ prompt, model: resolvedModel, effort, serviceTier });
    return parseEnrichResponse(raw);
  };
  generator.provider = provider;
  generator.model = resolvedModel;
  return generator;
}

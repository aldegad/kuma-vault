// Resolve the default enrich `generateDescription` for `vault sync --enrich`.
//
// The enrich engine is pure and takes an injected generator. The generic CLI has no team
// config (that is a host concern), so it reads the provider choice from a small config file
// that `vault setup` writes: ~/.kuma-vault/config.json (env KUMA_VAULT_CONFIG override).
//
//   { "provider": "claude" | "codex", "model": "<id>", "effort"?: "...", "serviceTier"?: "..." }
//
// No silent fallback: if the file is missing or lacks a supported provider, enrich fails
// with an explicit message pointing at `vault setup` — it never guesses a provider.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createCliDescriptionGenerator, isSupportedEnrichProvider } from "../index.mjs";

export function resolveEnrichConfigPath() {
  return process.env.KUMA_VAULT_CONFIG?.trim() || join(homedir(), ".kuma-vault", "config.json");
}

function readEnrichConfig(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`vault enrich config is not valid JSON: ${configPath} (${error.message})`);
  }
}

/**
 * Build the injected generateDescription from ~/.kuma-vault/config.json.
 * Throws (never returns a silent default) when no supported provider is configured.
 */
export function resolveDefaultEnrichGenerator() {
  const configPath = resolveEnrichConfigPath();
  const config = readEnrichConfig(configPath);
  if (!config || !isSupportedEnrichProvider(config.provider)) {
    throw new Error(
      `vault sync --enrich needs a provider. Run \`vault setup\` to choose one, ` +
        `or write { "provider": "claude"|"codex", "model": "<id>" } to ${configPath} ` +
        `(override the path with KUMA_VAULT_CONFIG).`,
    );
  }
  return createCliDescriptionGenerator({
    provider: config.provider,
    model: config.model,
    effort: config.effort,
    serviceTier: config.serviceTier,
  });
}

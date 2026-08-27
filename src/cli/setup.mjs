// `kuma-vault setup` — interactive, plugin-style setup for the kuma-vault distribution.
// `vault setup` remains a short alias for the same binary.
//
// Two surfaces, one deterministic core (see docs/design.md §9 and docs/setup.md):
//   - A human runs `kuma-vault setup` in a TTY: node:readline/promises prompts present the
//     choices (enrich provider, GitHub star, optional git-hook install).
//   - An agent runtime (Claude Code / Codex) triggers the bundled setup skill, gathers the
//     user's choices with its OWN native ask surface, then calls `kuma-vault setup` with flags
//     (`--provider <id> --yes [--star]`) to persist them non-interactively.
//
// No forcing: the provider is always the user's pick, and the GitHub star only happens on
// explicit consent (default is No). No silent fallback: a missing/unauthenticated `gh`, or
// an unresolvable star repo, prints an explicit notice and skips — it never guesses a
// provider, never stars without consent, and never fails the whole setup over an optional
// step.

import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeFileAtomicSync, readJsonFileOrDefaultSync } from "../engine/atomic-file-store.mjs";
import {
  createCliDescriptionGenerator,
  SUPPORTED_ENRICH_PROVIDERS,
} from "../enrich-adapters/provider-adapter.mjs";
import { resolveEnrichConfigPath } from "./enrich-config.mjs";
import { readOptionalString } from "./cli-options.mjs";

// The kuma-vault distribution's own canonical GitHub repo — the target of the optional
// star-ask. This is the TOOL's identity, not the consumer's cwd repo: starring the cwd
// git remote would star whatever project the user happens to be sitting in. Override at a
// fork/mirror with `--repo <owner/repo>` or config `starRepo`. Confirm at publish time.
export const DEFAULT_STAR_REPO = "aldegad/kuma-vault";

// Ordered provider ids for numbered menu choices (insertion order of the adapter's set).
export const SETUP_PROVIDERS = [...SUPPORTED_ENRICH_PROVIDERS];

// ── pure helpers (unit-testable, no I/O) ───────────────────────────────────────────────

// Map a free-form provider answer ("1", "claude", "CODEX", ...) to a canonical provider id,
// or null when unrecognized. A bare integer selects by menu position.
export function normalizeProviderChoice(answer) {
  const value = String(answer ?? "").trim().toLowerCase();
  if (/^\d+$/.test(value)) {
    return SETUP_PROVIDERS[Number.parseInt(value, 10) - 1] ?? null;
  }
  if (SUPPORTED_ENRICH_PROVIDERS.has(value)) {
    return value;
  }
  return null;
}

// A star/hook prompt defaults to No — only an explicit yes/y counts as consent.
export function isAffirmative(answer) {
  return /^(y|yes)$/i.test(String(answer ?? "").trim());
}

// The default model for a provider, sourced from the adapter (single source of truth) so
// this file never duplicates the DEFAULT_MODEL_BY_PROVIDER table.
export function defaultModelForProvider(provider) {
  return createCliDescriptionGenerator({ provider }).model;
}

// Resolve the star target as `owner/repo`, or null when it cannot be determined (caller
// then prints a notice and skips — no silent guess). Order: flag > config > built-in.
export function resolveStarRepo({ repoFlag, configStarRepo } = {}) {
  const candidate = String(repoFlag ?? configStarRepo ?? DEFAULT_STAR_REPO ?? "").trim();
  return /^[^/\s]+\/[^/\s]+$/.test(candidate) ? candidate : null;
}

// The `gh` argv that stars a repo for the authenticated user (REST: PUT
// /user/starred/{owner}/{repo}). `gh` has no `repo star` subcommand, so the API call is the
// documented path (verified against gh 2.80.0).
export function buildStarApiArgs(repo) {
  return ["api", "--method", "PUT", `/user/starred/${repo}`];
}

// ── side effects (injectable for tests) ────────────────────────────────────────────────

function defaultRunCommand(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

// Persist the provider choice to the config SSoT (~/.kuma-vault/config.json), merging with
// any existing keys so a host override or prior star target survives. Atomic write.
export function writeProviderConfig({ configPath, provider, model, effort, serviceTier }) {
  if (!SUPPORTED_ENRICH_PROVIDERS.has(provider)) {
    throw new Error(
      `Unsupported provider "${provider}". Choose one of: ${SETUP_PROVIDERS.join(", ")}.`,
    );
  }
  const existing = readJsonFileOrDefaultSync(configPath, () => ({}));
  const chosenModel = typeof model === "string" && model.trim()
    ? model.trim()
    : defaultModelForProvider(provider);
  const next = { ...existing, provider, model: chosenModel };
  if (typeof effort === "string" && effort.trim()) next.effort = effort.trim();
  if (typeof serviceTier === "string" && serviceTier.trim()) next.serviceTier = serviceTier.trim();
  writeFileAtomicSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// Star the tool's repo on the user's behalf, only after consent. Returns a {starred,
// reason, message} outcome; a missing/unauthenticated `gh` or unknown repo is an explicit
// skip, never a thrown error (an optional courtesy must not break setup).
export function starRepository({ repo, runCommand = defaultRunCommand } = {}) {
  if (!repo) {
    return {
      starred: false,
      reason: "no-repo",
      message: "Could not determine which repository to star; skipping (pass --repo <owner/repo>).",
    };
  }
  const version = runCommand("gh", ["--version"]);
  if (version?.error?.code === "ENOENT") {
    return {
      starred: false,
      reason: "gh-missing",
      message:
        "GitHub CLI (`gh`) is not installed — skipping the star. Install gh, then `gh api --method PUT /user/starred/" +
        `${repo}\` (or re-run \`kuma-vault setup\`) to star.`,
    };
  }
  const auth = runCommand("gh", ["auth", "status"]);
  if (auth?.status !== 0) {
    return {
      starred: false,
      reason: "gh-unauthed",
      message: "GitHub CLI is not authenticated — run `gh auth login`, then re-run `kuma-vault setup` to star. Skipping.",
    };
  }
  const result = runCommand("gh", buildStarApiArgs(repo));
  if (result?.status === 0) {
    return { starred: true, reason: "ok", message: `Starred ${repo} — thank you!` };
  }
  const detail = String(result?.stderr ?? "").trim() || `gh exited ${result?.status}`;
  return { starred: false, reason: "gh-error", message: `Could not star ${repo}: ${detail}. Skipping.` };
}

// Install the pre-commit drift gate by delegating to the sibling `bin/vault hook install`
// (the [4] installer is the SSoT — this never re-implements the hook logic). Optional step.
function installPrecommitHook({ root, runCommand = defaultRunCommand }) {
  const binPath = fileURLToPath(new URL("../../bin/vault", import.meta.url));
  // The contract comes from the repo's own vault.config.json declaration — the hook
  // installer takes no profile flag anymore.
  const args = ["hook", "install", "--root", root];
  const result = runCommand(binPath, args);
  if (result?.error?.code === "ENOENT") {
    return { installed: false, message: `Could not locate the kuma-vault bin at ${binPath}; run \`kuma-vault hook install --root ${root}\` manually.` };
  }
  if (result?.status === 0) {
    return { installed: true, message: String(result.stdout ?? "").trim() || `Installed pre-commit drift gate in ${root}.` };
  }
  const detail = String(result?.stderr ?? "").trim() || `exited ${result?.status}`;
  return { installed: false, message: `Could not install the hook in ${root}: ${detail}.` };
}

// ── orchestrator ───────────────────────────────────────────────────────────────────────

export async function commandVaultSetup(
  options = {},
  { input = process.stdin, output = process.stdout, runCommand = defaultRunCommand } = {},
) {
  const out = (line = "") => output.write(`${line}\n`);
  const configPath = readOptionalString(options, "config") ?? resolveEnrichConfigPath();
  const interactive = Boolean(input?.isTTY) && options.yes !== true;

  let provider = readOptionalString(options, "provider");
  let model = readOptionalString(options, "model");
  let hookRoot = readOptionalString(options, "hook-root");
  let wantStar;

  if (provider && !SUPPORTED_ENRICH_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported provider "${provider}". Choose one of: ${SETUP_PROVIDERS.join(", ")}.`);
  }

  if (interactive) {
    // terminal:false = cooked line mode. A real TTY still echoes/edits via the kernel, and it
    // avoids raw-mode keypress handling (which a piped/test stream can't provide).
    const rl = createInterface({ input, output, terminal: false });
    try {
      out("kuma-vault setup — the choice is always yours. Press Enter to keep a default; Ctrl-C to abort.");
      out("");
      out("1) Enrich provider — which CLI generates document synopses for `kuma-vault sync --enrich`?");
      SETUP_PROVIDERS.forEach((id, index) => {
        out(`     ${index + 1}. ${id}   (default model: ${defaultModelForProvider(id)})`);
      });
      const defaultProvider = provider ?? SETUP_PROVIDERS[0];
      let pick = await rl.question(`   Pick a provider [${defaultProvider}]: `);
      provider = pick.trim() ? normalizeProviderChoice(pick) : defaultProvider;
      while (!provider) {
        pick = await rl.question(`   Not recognized. Enter a number or ${SETUP_PROVIDERS.join("/")} [${defaultProvider}]: `);
        provider = pick.trim() ? normalizeProviderChoice(pick) : defaultProvider;
      }
      const modelDefault = model ?? defaultModelForProvider(provider);
      const modelAnswer = await rl.question(`   Model for ${provider} [${modelDefault}]: `);
      if (modelAnswer.trim()) model = modelAnswer.trim();

      out("");
      const starRepo = resolveStarRepo({ repoFlag: readOptionalString(options, "repo") });
      const starTarget = starRepo ? `github.com/${starRepo}` : "the project";
      const starAnswer = await rl.question(`2) If kuma-vault is useful, star ${starTarget} on GitHub? [y/N]: `);
      wantStar = isAffirmative(starAnswer);

      out("");
      const hookAnswer = await rl.question("3) Install the pre-commit drift gate into a git repo now? Enter a repo path, or Enter to skip: ");
      if (hookAnswer.trim()) hookRoot = hookAnswer.trim();
    } finally {
      rl.close();
    }
  } else {
    // Non-interactive (agent / CI): the provider must be explicit — no silent default.
    if (!provider) {
      throw new Error(
        "kuma-vault setup (non-interactive): --provider <" + SETUP_PROVIDERS.join("|") + "> is required. " +
          "Run in a terminal for interactive setup, or pass --provider.",
      );
    }
    wantStar = options.star === true; // star only on an explicit opt-in flag
  }

  const saved = writeProviderConfig({
    configPath,
    provider,
    model,
    effort: readOptionalString(options, "effort"),
    serviceTier: readOptionalString(options, "service-tier"),
  });
  out(`Saved provider config -> ${configPath}`);
  out(`   provider: ${saved.provider}`);
  out(`   model:    ${saved.model}`);
  out("");

  if (wantStar) {
    const repo = resolveStarRepo({
      repoFlag: readOptionalString(options, "repo"),
      configStarRepo: typeof saved.starRepo === "string" ? saved.starRepo : undefined,
    });
    out(starRepository({ repo, runCommand }).message);
  } else {
    out("Skipped the GitHub star (no consent given).");
  }

  if (hookRoot) {
    out("");
    out(installPrecommitHook({ root: hookRoot, runCommand }).message);
  }

  out("");
  out("Setup complete. Run `kuma-vault sync --enrich` to fill synopses, or `kuma-vault --help` for all commands.");
  return saved;
}

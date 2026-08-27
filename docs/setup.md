---
title: kuma-vault interactive setup — doc-first research + design + evidence
type: doc/design
status: current
verified: 2026-07-04
---

# Interactive setup (`kuma-vault setup`)

First-run setup (`vault setup` is a short alias) records the user's **enrich provider**
(`claude` | `codex`) and, on explicit consent, **stars the project on GitHub**. It is exposed two
ways from one deterministic core:

- **TTY** — a human runs `kuma-vault setup`; `node:readline/promises` prompts present the choices.
- **Agent runtime** — Claude Code / Codex trigger the bundled `kuma:vault-setup` skill, gather the
  choices with the runtime's own ask surface, then invoke `kuma-vault setup --provider <id> --yes
  [--star]` to persist them.

Two invariants shape everything below: the provider and the star are **always the user's choice**
(no forcing), and a missing/unauthenticated `gh` or an unresolvable repo is an **explicit skip**,
never a silent guess or a thrown setup failure (No Silent Fallback).

## 1. Doc-first: how each runtime triggers install-time user choices

Source of truth for the cross-runtime facts is the vendor daily-refresh wiki
(`skill-hook-authoring`), backed here by each vendor's own docs.

### Claude Code
- Package = `.claude-plugin/plugin.json`. Only `name` is required (kebab-case); `version`,
  `description`, `author` (an **object** with `name`/`email`/`url`), `homepage`, `repository`,
  `license`, `keywords` are optional.
- A top-level `skills/` directory is **auto-discovered** (each subfolder with `SKILL.md`), and a
  top-level `bin/` directory is **auto-added to the Bash tool's PATH** while the plugin is enabled.
  So the CLI and both skills ship without being listed in the manifest.
- User-invocable skills surface as `/<plugin>:<skill>` slash commands; description-matching also
  triggers them. Structural check: `claude plugin validate <path>` (`--strict` fails on unknown
  fields). Local session install: `claude --plugin-dir <path>`.
- Sources: <https://code.claude.com/docs/en/plugins-reference>,
  <https://code.claude.com/docs/en/plugins>.

### Codex
- Package = `.codex-plugin/plugin.json` at the plugin root. Required: `name` (kebab-case,
  identifier + namespace), `version`, `description`. `skills` is a **relative path string**
  (`"./skills/"`) pointing at the dir of skill subfolders — not an array. `author` is an object;
  an optional `interface` block carries `displayName`/`shortDescription`/`category` (and more).
- Skills are invoked via the `/skills` selector or `$<skill>` mention (typed `/<skill>` is not a
  documented Codex form). Plugins install from a marketplace snapshot (`codex plugin add`); the
  app-server protocol JSON Schema is generated with `codex app-server generate-json-schema --out
  <dir>` (its `PluginInterface` definition confirms the `interface` field names used here).
- Source: <https://developers.openai.com/codex/plugins> (build page).

### Portable layer (the rule we follow)
- The portable trigger across engines is **description-triggered invocation**; the typed token is
  per-engine sugar. We therefore ship the capability as a **skill + CLI**, and do **not**
  re-implement a slash surface in any host layer above the engine (a second input path would have
  to re-derive session context and would flatten the per-engine token differences). The agent asks
  with its native surface, then forwards the decision to the `kuma-vault setup` CLI verbatim.

## 2. The mechanism shipped

| Piece | Path | Role |
|---|---|---|
| Setup CLI | `src/cli/setup.mjs` (`kuma-vault setup`; alias `vault setup`) | Deterministic core: readline prompts, config write, `gh` star, optional hook install. |
| Setup skill | `skills/kuma-vault-setup/SKILL.md` (`kuma:vault-setup`) | Agent-facing: present the choices with the runtime's native ask, then call the CLI. |
| Claude manifest | `.claude-plugin/plugin.json` | Packages the two skills + `bin/vault` for Claude Code (auto-discovery). |
| Codex manifest | `.codex-plugin/plugin.json` | Packages `./skills/` for Codex (skills path string + interface block). |
| Config SSoT | `~/.kuma-vault/config.json` (env `KUMA_VAULT_CONFIG`) | The single place the provider choice is persisted; `kuma-vault sync --enrich` reads it. |

## 3. Setup flow

1. **Provider pick (required).** `claude` (default model `claude-sonnet-5`) or `codex` (default
   model `gpt-5.4-mini`). The default model comes from the enrich adapter (single source of truth,
   `createCliDescriptionGenerator({provider}).model`) — this file never re-lists model ids. The
   pick is written to the config SSoT, merging with any existing keys.
2. **Star-ask (optional, explicit opt-in).** Default is **No**. On yes, the tool stars its own
   canonical repo via `gh` (see §4). It never stars the consumer's cwd repo.
3. **Git hook (optional).** A repo path installs the pre-commit drift gate by delegating to
   `bin/vault hook install` (the hook installer is the SSoT — setup never re-implements it).

Non-interactive (agent / CI) mode: prompts are replaced by flags. `--provider` is **required**
(no silent default), and the star only happens on an explicit `--star`.

## 4. GitHub star command (doc-first)

`gh` has **no `repo star` subcommand** (verified against gh 2.80.0). The documented path is the
REST endpoint "Star a repository for the authenticated user":

```
gh api --method PUT /user/starred/{owner}/{repo}
```

(built by `buildStarApiArgs`). The star target is a baked-in constant `DEFAULT_STAR_REPO`
(`aldegad/kuma-vault`) — the tool's own identity — overridable with `--repo <owner/repo>` or config
`starRepo`. Resolution order: flag > config > constant. If `gh` is absent (`ENOENT`),
unauthenticated (`gh auth status` non-zero), or the API call fails, setup prints the reason and
skips; it is a courtesy, so it never throws.

## 5. Verification / smoke evidence (2026-07-04)

**Unit tests** — `src/cli/setup.test.mjs`, 20 cases: pure helpers (provider normalization,
consent, star-repo resolution, PUT argv, default-model SSoT), config persistence (merge, default
model, unsupported-provider throw), `starRepository` (no-repo / gh-missing / gh-unauthed / happy /
gh-error — all via an injected runner, never spawning real `gh`), the non-interactive orchestrator
(missing-provider throw, star gated on `--star`), and the **interactive readline path** (a reactive
fake TTY: bad-provider retry, default-on-Enter, star consent). Full package suite: **178 passed**.

**Claude engine install smoke** — `claude plugin validate .` and `claude plugin validate . --strict`
both `Validation passed` (exit 0). This validates `.claude-plugin/plugin.json` and the bundled
skill frontmatter.

**Codex engine schema smoke** — `codex app-server generate-json-schema --out <dir>` generates the
protocol schema; its `PluginInterface` definition lists `displayName`, `shortDescription`,
`category` (+ more), confirming the manifest's `interface` field names. The `.codex-plugin/plugin.json`
matches the official build-page authoring schema (name/version/description + `skills: "./skills/"`).

**CLI end-to-end** (through `bin/vault`, exposed as `kuma-vault setup` and `vault setup`):
- provider write -> `{ "provider": "claude", "model": "claude-sonnet-5" }`, star skipped, exit 0.
- missing provider (non-interactive) -> `--provider ... is required`, exit 1 (fail-loud).
- `--provider codex --yes --star` -> real `gh` call; the repo is not yet published, so `gh: Not
  Found (HTTP 404)` -> `Could not star aldegad/kuma-vault ... Skipping`, exit 0 (graceful).
- re-run merges: a pre-existing unrelated key (`starRepo`) survives a provider re-write.

**Packaging** — `npm pack --dry-run` ships `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`skills/kuma-vault-setup/SKILL.md`, and `src/cli/setup.mjs`.

## Open item

`DEFAULT_STAR_REPO` (`aldegad/kuma-vault`) is the intended slug; confirm/adjust it when the repo is
published (the star 404s until then, by design). npm-registry publish is out of scope for this step.

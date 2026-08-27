---
name: kuma-vault-setup
description: "First-run setup for the kuma-vault knowledge-base compiler. Trigger on installing/enabling kuma-vault, first `kuma-vault sync --enrich`, or a request to configure/choose the enrich provider (claude vs codex) or star the project. Presents the choices to the user and records them via `kuma-vault setup`."
---

# kuma-vault-setup — first-run setup

One interactive setup that records the user's **enrich provider** and, on consent, **stars the
project on GitHub**. The choice is always the user's — never decide for them, never star
without an explicit yes.

This skill is the agent-facing surface. The deterministic work (writing config, calling `gh`)
lives in the `kuma-vault setup` CLI (`vault setup` is a short alias) — you present the choices
with your own native ask surface, then hand the decision to the CLI. Do not re-implement the
config write or the star call yourself.

## When to run

- The user just installed or enabled the kuma-vault plugin, or asks to "set up" / "configure" it.
- `kuma-vault sync --enrich` failed with "needs a provider. Run `kuma-vault setup`".
- The user asks to change which provider generates document synopses, or to star the repo.

If a provider is already configured (`~/.kuma-vault/config.json` has a `provider`), say so and
only re-run when the user wants to change it.

## Flow

Present these as real choices using your runtime's native question/選択 surface (Claude Code:
the AskUserQuestion tool; Codex: ask in chat). Keep it short — this is a courtesy, not a wizard.

1. **Enrich provider (required).** Ask which CLI should generate one-line document synopses for
   `kuma-vault sync --enrich`:
   - `claude` — spawns the Claude CLI (default model `claude-sonnet-5`).
   - `codex` — spawns the Codex CLI (default model `gpt-5.4-mini`).
   Only these two are supported. Do not pick for the user. If they don't care, offer `claude` as a
   neutral default but let them confirm.

2. **GitHub star (optional, explicit opt-in).** Ask: "If kuma-vault is useful, star it on GitHub?"
   Default is No. Only pass `--star` when the user clearly says yes. Starring uses their `gh`
   login; if `gh` is missing or not authenticated the CLI prints a notice and skips (that's fine).

3. **Persist via the CLI.** Run exactly one command with the collected choices:

   ```
   kuma-vault setup --provider <claude|codex> --yes            # star declined
   kuma-vault setup --provider <claude|codex> --yes --star     # star consented
   ```

   Add `--model <id>` only if the user asked for a non-default model. Add `--repo <owner/repo>`
   only if starring a fork/mirror instead of the canonical repo.

4. **Report** what was written (provider, model, config path) and whether the star happened,
   using the CLI's own output. Then point them at `kuma-vault sync --enrich` and `kuma-vault --help`.

## Rules

- **No forcing.** The provider and the star are the user's decisions. `--yes` only skips the CLI's
  own re-prompt; it does not skip *your* asking the user.
- **No silent fallback.** If the user hasn't chosen a provider, ask — never invent one. If `gh`
  fails, relay the CLI's skip notice; do not retry or work around it.
- **Deterministic core stays in the CLI.** Everything that writes `~/.kuma-vault/config.json` or
  calls `gh` is `kuma-vault setup`. Your job is to ask, then invoke it — nothing more.

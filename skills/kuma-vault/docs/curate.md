# vault curate — tidy / repair the vault

Read the existing vault and clean up broken links, wrong source paths, duplicate/abnormal pages, and index/log drift.

> **Core role:** `ingest` puts a new source in; `curate` tidies what is already in the vault.

## Usage

```text
vault curate                  curate the whole vault
vault curate links            check source/evidence links (broken links / wrong source paths)
vault curate page <path>      focus on one page
vault curate domain <slug>    check one domain / project cluster
```

## When to use

- "the vault feels disorganized"
- "check for orphan evidence/sources"
- "fix up the weird existing docs"
- "repair broken links / source paths"
- "consolidate duplicate pages / canonical"
- "not ingest — let's tidy the existing vault"

## Scope

This subcommand is for **repairing the existing vault** only.

- Included:
  - checking owner-local evidence/sources and inbox-triage candidates
  - repairing a doc's `sources` / in-body evidence links
  - repairing folder README generated `vault-index` region drift / staleness (`index.md` is retired)
  - deciding the canonical page and merge/relink
  - structural repair driven by `vault-lint` results
- Excluded:
  - first-time promotion of a new external source
  - new dispatch-result / inbox ingest
  - editing the content of owner-local original files

If you need to add a new source, hand off to `vault ingest`.

## Curation procedure

### Step 1 — fix the scope

Fix the scope to one of:

- the whole vault
- one page
- one domain/project cluster

If no scope is given, the default is **check everything, apply only safe fixes**.

### Step 2 — gather facts

Always look in this order:

1. `vault-lint --mode full`
2. the target page / affected folder README `vault-index` / `log.md`
3. owner-local `_assets`/`_sources`/`_evidence` and `inbox/` entries
4. the `sources:` lines and any old raw-path links inside the docs

In this step, first isolate **what is wrong**.

## Anomaly types

| Type | Example | Default handling |
|------|---------|------------------|
| broken source path | a doc points at a non-existent old source path | repair to the real owner-local evidence/source path |
| duplicate page | the same knowledge duplicated across pages | merge into one canonical, relink the rest |
| stale index | a folder README `vault-index` region differs from the real child set | regenerate via `rewriteIndex` (vault ingest) |
| special file drift | `dispatch-log.md` / `decisions.md` missing the `type: special/*` frontmatter or a required section | repair against `<vault>/schema.md` |
| duplicate slot | the same knowledge category scattered across paths | consolidate per schema.md and the host repo docs; relink or archive the rest (e.g. product operating rules → host repo `docs/operations/`; runtime behavior rules live outside the vault — the host repo's decision log for decisions, the owning skill for procedures) |
| mixed page | project knowledge and domain knowledge over-mixed in one page | keep canonical + split out only the reusable part |

## Judgment principles

- **SSoT first:** do not leave the same knowledge in two places.
- **No top-level raw:** it is not a new default path and is a removed slot. Evidence goes owner-local or into a TTL'd inbox only.
- **Merge before delete:** decide the canonical before removing anything.
- **Safe fixes first:** obvious broken links, obvious frontmatter drift, obvious index drift are repaired immediately.
- **Ask on ambiguous consolidation:** if it is unclear which of two pages is canonical, confirm with the user.

## Handling incomplete evidence

Not every unreferenced owner-local evidence/source or inbox entry is a problem. During curation, classify each into one state.

### Classification

- `owner-local-migrate` — a clear related canonical page/folder exists; move or link the evidence into that owner's `_assets/`, `_sources/`, `_evidence/`.
- `canonical-promotion` — genuinely important memo/domain knowledge that should be promoted to `domains/`, `projects/`, `learnings/`.
- `inbox-triage` — owner unclear, so send to `inbox/` with owner/TTL/next-action.
- `keep-historical` — a clear reason to keep as-is (immutable reference, audit evidence, legal/contractual original).
- `delete-candidate` — duplicate, obsolete, unsafe-retention candidate. Do not delete immediately; go through owner review.

### Handling

1. If a related canonical page exists, repair the owner-local evidence path and the `sources`/in-body links.
2. If no related page exists and reuse value is high, propose it as a `vault ingest` target.
3. If the owner is unclear, record it as an `inbox/` triage candidate.
4. If there is a clear reason to keep it, record it as `keep-historical`.
5. Record duplicate/obsolete candidates as `delete-candidate` and get owner review before any bulk deletion.

## Output format

Always organize the curation result into three blocks.

### Findings

- what was wrong
- what is a normal orphan
- what needs further judgment

### Applied

- the files actually modified
- which links / frontmatter / index were repaired

### Follow-up

- candidates to hand to `ingest`
- items where a human must set the canonical
- items needing a periodic check

## Invariants

- Deleting/moving an original/evidence without classification is forbidden
- Do not carelessly remove existing page content
- Do not force ambiguous duplicate consolidation without asking
- `log.md` stays append-only
- A folder README `vault-index` region is regenerated against the live child set (`index.md` is retired — do not create it)

## Current implementation notes

- Curation is currently done by combining `vault-ingest`, `vault-lint`, and manual edits.
- That is, `curate` is an **operating subcommand, not a dedicated CLI**.
- Find the mechanically checkable parts first with `vault-lint` and Grep/Glob, and curate only the parts that need structural judgment.
- Skill docs are SSoT in their source repo; no managed skill mirror is created in the vault, and a legacy skill-inbox doc is reported only as drift by `vault-lint --mode full`.
- If a pattern recurs often, it can later be split into a dedicated `vault-curate` CLI.

## Vault directory structure (reference)

```
<vault>/                  (default ~/.kuma/vault, or $KUMA_VAULT_DIR)
├── README.md (topology entry point) / architecture.md / schema.md / decisions.md
├── log.md / dispatch-log.md   (append-only runtime ledgers — not navigation)
├── domains/              Domain knowledge
├── projects/             Thin canonical project summaries
├── learnings/            Debugging patterns, insights
├── docs/                 Reference docs
├── images/               Image archive
├── inbox/                Awaiting ingest
└── results/              Dispatch result / evidence archive
```

## Related

- `vault` (default) — read / query
- `vault ingest` — promote a new source (`references/ingest.md`)

## Tools

Read, Edit, Write, Glob, Grep, Bash(date)

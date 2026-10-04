# vault ingest — promote knowledge into the vault

Read `inbox/` (or an explicit source), file it under the right canonical owner, then refresh the folder README generated `vault-index` region and `log.md`. Result files are preserved as evidence in `results/`; canonical page promotion happens only explicitly. (`index.md` is retired — do not use it.)

> **Core invariant:** canonical-owner-first. New material is never dropped into a top-level `raw/`. If the owner is unclear, put it in `inbox/` with owner/TTL/next-action; results are preserved in the `results/` evidence archive; `projects/<slug>.md` is a thin summary.

For facts verified during search, apply the claim-level source, freshness and
history-preservation rules in [information retrieval](info-retrieval.md#4-answer-then-refresh-reusable-knowledge).
A document's `updated` field does not replace a claim's `verified_at`. Refresh
only successfully checked claims, including their timestamps when still unchanged.

## Usage

```
vault ingest                              process every inbox/ entry
vault ingest <file-or-path>               ingest one file (absolute or relative path)
vault ingest result <task-id>             archive a dispatch result into results/
vault ingest <url-or-text>                a URL or raw text → processed directly (no inbox detour)
vault ingest --bypass                     unattended mode. no questions, best guess applied directly
```

### Key options

| Option | Description |
|--------|-------------|
| `--full-auto` | Default. When routing is ambiguous, show candidates and ask for a choice |
| `--bypass` | Unattended mode. Cannot be combined with `--full-auto` |
| `--dry-run` | Preview the routing result without writing |
| `--qa-status passed` | Set the QA status explicitly (default: `passed`) |
| `--section projects\|domains\|learnings` | Override the canonical-promotion target section |
| `--page projects/<slug>.md` | Set the target page path directly |
| `--slug custom-slug` | Override the page slug |
| `--title "Custom Title"` | Override the page title |
| `--project <slug>` | Name the project id (routing hint) |
| `--signal task-done` | Send a signal on completion (enables guarded-ingest mode) |
| `--stamp-dir <path>` | Stamp directory used to de-duplicate ingest |

Tree layout and special-file ownership: [layout](layout.md).

## Ingest procedure (fixed order)

### Step 1 — resolve the source

| Input | Handling |
|-------|----------|
| no argument | read the whole `<vault>/inbox/` listing |
| a file path | Read that file |
| `result <id>` | Read the dispatch result for `<id>` (or `vault/results/`) and ensure it is archived |
| URL | WebFetch, then summarize |
| raw text | use as-is |

### Step 2 — decide the target

Read the content and choose a target directory by these criteria.

| Content type | Target |
|--------------|--------|
| domain knowledge (security, analytics, a specific external service/product …) | `domains/<domain>.md` |
| current project-state summary | `projects/<slug>.md` |
| product operating rules / feedback | the host repo's `docs/operations/` or `docs/conventions/` |
| the vault owner's operational rules / debugging patterns | rules live outside the vault (the host repo's decision log for decisions, the owning skill for procedures) · `learnings/` (repeatable insights/debugging) |
| benchmarks / performance measurements | `learnings/` |
| system ontology / design principles | `learnings/` (a dedicated page) |

### Step 3 — decide whether to promote to a canonical page

```
if source is a result:
  default → results/<name>.result.md evidence archive + refresh affected folder README vault-index / log.md
  exception → canonical page promotion only when --page or --section is given

if source is generic:
  Glob → check whether the target path exists
    exists → update while preserving the summary contract
    absent → Write a new file (standard frontmatter required)
```

**Standard frontmatter for a new page:**

```markdown
---
title: {title}
tags: [{tag1}, {tag2}]
created: {YYYY-MM-DD}
updated: {YYYY-MM-DD}
sources: [{source file/link}]
source_grade: {foundation|supporting|exploratory|historical}   # optional — records the primary-source nature
---

## Summary
{1-3 line summary}

## Details
{bounded current state or curated details}

## Related
- [{related page}]({path}) — {why linked}
```

**Special-files caution:** `dispatch-log.md` / `decisions.md` are **not** ordinary ingest targets. They are the runtime memory layer marked by `type: special/*` frontmatter, each with a fixed writer: dispatch-log by the dispatch lifecycle hook, decisions by `user-direct` only. Do not overwrite them via ingest. See `<vault>/schema.md` for the detailed rules.

**Project-summary rules:**
- `projects/<slug>.md` keeps the `## Summary / ## Details / ## Related` structure.
- `## Details` holds only bounded current state. No result-body dumps, no `<!-- ingest:... -->` markers, no append-only chronicle.
- Do not put a result archive path in the project page `frontmatter.sources`; link evidence from the body only.

### Step 4 — refresh the README topology (generated `vault-index`)

`index.md` is retired. Topology is expressed by each folder's `README.md` `<!-- vault-index:start/end -->` generated region, and the ingest tooling (`rewriteIndex`) **regenerates** the affected regions automatically:
- a new/updated page must be reachable from its parent folder `README.md`. A canonical page is picked up by the generated `vault-index`; exceptions needing curated prose links (runtime ledgers, etc.) get a direct prose link.
- a result archive is preserved as `results/` evidence only. Do not build a flat cross-reference dump in the root README (retired).
- repair broken links using [curate](curate.md); regenerate stale regions with `vault sync --root <absolute-target-tree>`.

### Step 5 — append to log.md

Add an entry to the end of `<vault>/log.md`:

```
{YYYY-MM-DD HH:MM} INGEST: {source} → {target path} ({new|merge}) — {one-line summary}
```

### Step 6 — report

```
Ingest complete: {source} → {target path} ({newly created|merged into existing})
README topology updated: {regenerated folder vault-index items}
log.md append: {one line}
```

## Constraints / invariants

- Top-level `raw/` is removed. New and existing evidence go owner-local (`_assets`/`_sources`/`_evidence`), into `results/`, or into a TTL'd `inbox/` only.
- **Do not delete** existing page content — though a legacy ingest block that breaks the project-summary contract is a removal target.
- Ingest into an **existing** page owns only `## Summary / ## Details / ## Related`. Everything else the page already holds — prose above the first `##`, an H1, tables, and any other `##` section — is carried forward verbatim in its original order; the managed sections the page lacked are appended after it. Preserved text is carried line for line: blank lines at a section's edges are dropped, indentation (an indented code block on a section's first line) is kept. A body the tool cannot rewrite losslessly is **refused before any write** with a non-zero exit — nothing is snapshotted, logged, or scaffolded. Refused shapes: duplicate `##` headings; a `## ` line inside a code fence (``` or ~~~, managed or not — the splitter is not fence-aware and would treat it as a real section); a code fence that is never closed. Fences that contain no `## ` line are preserved as ordinary text. `inspectExistingPageBodyShape(body)` is the read-only inspector behind that decision.
- Special files (`dispatch-log.md`, `decisions.md`) are not overwritten by ingest — dispatch-log is owned by the lifecycle hook, decisions is `user-direct` only.
- `<vault>/memos/` is the user-owned favorites layer. Background ingest does not write there.
- A file pulled from `inbox/` is removed or marked with a `_done` suffix after ingest. TTL-expired entries are not left dangling; they are reported as a failure state.
- `log.md` is always **append-only** (no overwriting).
- A source you cannot classify stays in `inbox/` and is reported under Findings only.

## Current implementation notes

- The `vault ingest` CLI supports `result-file`, `result <task-id>`, batch `inbox/` processing, a plain file, a `URL`, and direct `raw text` ingest.
- `--full-auto` is the default (omitting the flag behaves identically). When routing is ambiguous it shows candidates (up to 3) and asks for a number. In a non-TTY environment (pipe, worker) it throws automatically — you must pass `--bypass` or an explicit `--section`/`--page`. Unattended workers/cron pass `--bypass` to proceed without questions.
- When an ingest actually writes, it runs an automatic `fast lint` right after on the updated page and the affected folder README / `log.md`.
- Result auto-ingest is evidence-preserving. The default path updates only `results/`, the affected folder README `vault-index`, and `log.md`; it does not grow `projects/<slug>.md` on its own.
- Manual canonical promotion is allowed only with an explicit override: `--page ...` or `--section ...`.
- Target classification runs in the order: **explicit override (`--section`, `--page`) > project detection > learnings/domains heuristic**.
- The auto-classification is a keyword / project-id heuristic, not an LLM judgment. In `--full-auto` it confirms ambiguous hits with the user; in `--bypass` it applies the best guess directly.
- Repairing broken source paths, duplicate pages, and canonical re-org in the existing vault is the `curate` operating procedure's scope (see [curate](curate.md)).
- Skill docs are SSoT in their source repo; no managed skill mirror is auto-created in the vault.
- Routine post-ingest checks use `vault lint --mode full --root <absolute-target-tree>`, with the same target tree used for ingest.

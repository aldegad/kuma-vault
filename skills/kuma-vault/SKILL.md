---
name: kuma-vault
description: 'kuma-vault knowledge-base retrieval — the agent memory layer. Trigger BEFORE answering any lookup, especially an unfamiliar proper noun (tool, library, repo, product, person, coined term) or an existence/identity question: "X 있냐?", "X 뭐야?", "그거 알아?", "찾아봐", "우리 이거 봤었나", "is there an X", "what is X", "look it up", "have we seen this", plus comparison against prior work, 새 작업/플랜, vault-backed 도메인/프로젝트 키워드, domains/* edits, previous-context recall, decisions/principles. A name the agent does not recognize is itself the trigger — search the vault before grep or the web. Modes: search/timeline/get/ingest/curate.'
---

# kuma-vault — knowledge serving

> 스킬 이름 = `kuma-vault` (등록명·발동명). CLI 는 `kuma-vault`, 짧은 alias `vault` — 문서의 `vault <mode>` 표기는 CLI alias 다. (`/vault`·`kuma:vault` 옛 표기는 2026-07-29 폐기 — 콜론 name 은 스킬 규약 위반이고, `/<name>` 타이핑 발동은 엔진마다 달라 표기로 쓰지 않는다)

A single interface for loading knowledge stored in a kuma-vault knowledge base.

> **The vault is the agent's brain.** Operate on the amnesiac assumption — nothing outside the vault is remembered. Semantic knowledge, working memory, episodic memory, and procedural memory all come out of the vault.

## Intent Router (takes priority over the literal "vault" keyword)

Recognize **memory intent** on every user message, not just the literal `vault` keyword. When one of these
appears, run the retrieval chain immediately — do not reach for chat history first.

- **memory-recall** — "지금 뭐 하던 중이지?", "어디까지 했지?", "이전 결정", "지난번", a deictic "그 작업/그 워커/그 프로젝트", a worker name + a status question, "where's that thread", resuming after a dropped session.
- **domain-keyword** — a topic keyword that has a vault page appears in the message, an edited file, or a plan body. **Do not hard-code the topic list here**: which topics exist is discovered at runtime from `<vault>/README.md` → `domains/**/README.md` + `projects/**`. Baking them in would leak the vault's domain list and would drift on every new page. Entering the vault at the start of non-trivial work is a duty, not a suggestion.
- **decision / principle cues** — `SSoT`, `SRP`, atomicity, idempotency, consistency, silent fallback, failover → load the operative decision docs first (`decisions.md`, `projects/<slug>.project-decisions.md`).
- **writing or updating a plan** — load the work domain + `projects/<slug>.md` + the relevant decision/convention docs, then write the plan body.

### Retrieval chain (boot pack load order)

1. `<vault>/dispatch-log.md` **tail 20** — episodic ledger
2. `<vault>/decisions.md` + the current project's `*.project-decisions.md` — latest ~10 entries
3. Active plans index (if the deployment tracks plans)
4. Vault retrieval, **3-layer progressive disclosure**: `vault search <q>` (L1: hits only) → `vault timeline <q>` (L2: ±2-line snippets) → `vault get <id|path>` (L3: full text)

Stop at the highest layer that answers. External search (chat history, Grep, the web) only after step 4 yields nothing.
**Invariant:** never dump full text at L1; the order `search → timeline → get` is fixed.

**Query shape** — `search`/`timeline` are **not semantic search**: they are phrase-substring plus entity matching.

- Do not throw a whole fuzzy sentence. Start with the single most distinctive token (proper noun, coined term, file stem, handle, date); drop emoji and symbols.
- **0 hits on a multi-word query is not "it does not exist."** Reduce one token at a time before concluding NOT FOUND — search brittleness is not absence (No Silent Fallback).
- A specific artifact name may live only in a page body or its `## Related` line — `get` the page or `timeline` a distinctive token.
- When ingesting, put the phrases a user would actually type into frontmatter `aliases`; a phrase-substring search only hits once an alias contains that phrase.

**Priority for canonical truth:** decision/principle docs → `calendar/` (time/place-bound) → `projects/<slug>.md` → `memos/` → `learnings/`·`domains/` → `results/` and owner-local `_assets`·`_sources`·`_evidence`. Result reports, the dispatch log, and classification reports are evidence layers, not the policy SSoT.

**Anti-patterns:** skipping the vault because the word "vault" was not used · fetching chat history first · grepping the codebase before the vault · expecting a full-body dump from `search`.

## Usage

```
vault <path>         Load a page (a file, <path>.md, or <dir>/README.md)
vault index          List the whole topology (root README)
vault search <q>     Keyword search (L1)
vault timeline <q>   Snippets around matching lines (L2)
vault get <id>       Load one document's full text (L3)
vault ingest [args]  Promote a new source into a canonical vault page
vault curate [args]  Repair orphan evidence, broken links, duplicate pages, and drift
vault graph [--open] Render the vault topology as an interactive HTML graph
```

From a shell, invoke as `vault <subcommand>` (the `kuma-vault` bin dispatches to `vault`, works from any CWD). The `vault ...` notation above is the slash form of the same CLI.

## Subcommands

`ingest` / `curate` are subcommands of this skill. Load the matching reference file with Read when you enter them.

| Subcommand | Reference doc | Summary |
|------------|---------------|---------|
| (none) / path / index / search / timeline / get | this file | read / query paths |
| `ingest` | `docs/ingest.md` | promote a new source — canonical-owner-first, explicit promotion, evidence preservation |
| `curate` | `docs/curate.md` | tidy the existing vault — broken links / orphan evidence / duplicate pages / drift |
| `graph` | `docs/graph.md` | render the topology as an interactive node-link graph, one toggleable layer per frontmatter connection methodology |

**Execution rule:**
- `vault ingest ...` → Read `docs/ingest.md` → run the promotion procedure by its rules
- `vault curate ...` → Read `docs/curate.md` → run the cleanup procedure by its rules
- Read/query paths need only this file. No reference load required.

### Examples

```
vault index                       → print the root README topology (all top-level slots)
vault search vault                → title / path / one-line snippet list
vault timeline vault              → 2-3 snippets of surrounding lines
vault get domains/security.md     → that document's full text
vault domains/security            → load domains/security/README.md
vault curate links                → check source/evidence links (per docs/curate.md)
```

## Vault layout & special files

The tree, the slot contract (owner-first, attachment/diagram/media preservation duties, human/agent role split),
and the `type: special/*` runtime files (`dispatch-log.md`, `decisions.md`, `projects/*.project-decisions.md`)
live in [`docs/layout.md`](docs/layout.md). Read it before ingesting, curating, or filing an attachment.

Two rules that never move: `decisions.md` and `*.project-decisions.md` have a **`user-direct` writer only**
(an agent proposes candidates, never appends), and their text is stored **exactly as the user stated it** —
no summarizing, no inference.

## Domain load

The alias list is not baked into this skill body. Current topics and aliases are found at runtime by searching
`<vault>/README.md`, `domains/**/README.md`, and `projects/**`. There is no fixed role→topic mapping — run the
`search → timeline → get` chain against the domain cues in the task and the user's message.

## Cautions

- Vault content is **read-only** here; modify only via `vault ingest` / `vault curate`.
- Summarize large files first; load full text only on request.
- `inbox/` content is unverified — do not cite it without fact-checking.

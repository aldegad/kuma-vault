---
name: kuma-vault
description: 'Search and research entry point: search, web search, internet search, look up, research, verify, latest, official docs, 검색, 서치, 웹 검색, 인터넷 찾아봐, 조사, 알아봐, 확인해봐, 최신정보, 공식문서, 출처. Search the vault first, then consult official sources when evidence is missing, incomplete, stale or explicitly requested; refresh reusable verified knowledge. Also use for unfamiliar names/acronyms, existence/identity questions, previous work and memory recall, domain/project knowledge, plans, decisions and principles. Routes dynamic or authenticated pages to kuma-computer-use. Modes: search/timeline/get/ingest/curate; web research uses available tools, not a vault web-search CLI.'
---

# kuma-vault — knowledge serving

CLI: `kuma-vault`, short alias `vault`.

A single entry point for retrieving knowledge, verifying it at its source, and
updating reusable facts. `vault search` searches every registered vault store;
the agent uses its own web tools for internet searches. Browser work for dynamic or
signed-in pages belongs to the host's browser skill — in Kuma Studio, `kuma-computer-use`.

## Search contract — read before answering

- Search the vault first. **No relevant answer, an incomplete answer, or an unknown
  name/acronym means continue to web search and open the primary source**; do not
  stop at a vault miss to ask the user what a public term means. Ask only if source
  checks leave material ambiguity. Never send private vault content or credentials
  to a public search engine; use public terms only.
- A hit is not a freshness verdict. For changeable external facts, recheck the
  authoritative source when the claim was last verified **24 hours or more ago**, or
  its verification time/source is missing. A request to search the web, verify,
  or find the current/latest answer, conflicting evidence, and rapidly changing
  live facts require a check now. Respect explicit offline/no-browse requests.
- Historical facts and user decisions do not expire after a day. Current local
  machine/repo/session facts need local observation; the web cannot confirm them.
  Measure live state now; the 24-hour rule is not permission to reuse stale state.
- Start with web search and a lightweight page fetch. **HTTP 200 is not success:**
  require the facts needed by the question. For an empty shell, CSR, async/lazy
  loading, tabs, pagination or authenticated content, read the host's browser
  skill (`kuma-computer-use` in Kuma Studio) and use its supported path to obtain
  the actual data.
- Open official documentation for vendor behavior, versions, pricing, supported
  hardware and model availability. Search snippets alone are not verification.
  Cite the exact supporting page and distinguish published facts from inference.
- Refresh reusable verified facts through [ingest](docs/ingest.md), with a source
  and a claim-level verification timestamp. Preserve history and user decisions.
  A failed check must not advance that timestamp or be reported as current.

Full procedure, boundary cases and source routing:
[Information retrieval](docs/info-retrieval.md). This is agent procedure, not an
automatic network refresh or an enforced CLI freshness gate.

> **The vault is the agent's brain.** Operate on the amnesiac assumption — nothing outside the vault is remembered. Semantic knowledge, working memory, episodic memory, and procedural memory all come out of the vault.

## Intent Router (takes priority over the literal "vault" keyword)

Recognize **search and memory intent** on every user message, not just the literal `vault` keyword. When one of these
appears, run the retrieval chain immediately — do not reach for chat history first.

- **search / research** — "검색해", "서치", "웹에서 찾아봐", "알아봐", "최신 정보", "공식 문서", "search", "research", "look it up", "verify"; also an unfamiliar public name or acronym. Continue through the search contract above even when the vault has no answer.

- **memory-recall** — "지금 뭐 하던 중이지?", "어디까지 했지?", "이전 결정", "지난번", a deictic "그 작업/그 워커/그 프로젝트", a worker name + a status question, "where's that thread", resuming after a dropped session.
- **domain-keyword** — a topic keyword that has a vault page appears in the message, an edited file, or a plan body. **Do not hard-code the topic list here**: which topics exist is discovered at runtime from `<vault>/README.md` → `domains/**/README.md` + `projects/**`. Baking them in would leak the vault's domain list and would drift on every new page. Entering the vault at the start of non-trivial work is a duty, not a suggestion.
- **decision / principle cues** — `SSoT`, `SRP`, atomicity, idempotency, consistency, silent fallback, failover → load the operative decision docs first (`decisions.md`, `projects/<slug>.project-decisions.md`).
- **writing or updating a plan** — load the work domain + `projects/<slug>.md` + the relevant decision/convention docs, then write the plan body.

### Retrieval chain (boot pack load order)

1. `<vault>/dispatch-log.md` **tail 20** — episodic ledger
2. `<vault>/decisions.md` + the current project's `*.project-decisions.md` — latest ~10 entries
3. Active plans index (if the deployment tracks plans)
4. Vault retrieval, **3-layer progressive disclosure**: `vault search <q>` (L1: hits only) → `vault timeline <q>` (L2: ±2-line snippets) → `vault get <id|path>` (L3: full text)

Stop expanding vault results at the highest layer that answers, then apply the
search contract's source and freshness checks. A relevant hit can still require
external verification. On a miss, simplify the query once and continue to the
appropriate source; repeated vault-only queries are not a substitute for searching.
**Invariant:** never dump full text at L1; the order `search → timeline → get` is fixed.

Query shape, the canonical-truth priority and the anti-patterns:
[docs/info-retrieval.md](docs/info-retrieval.md#query-shape-and-canonical-priority).

## Usage

```
vault <path>         Load a page (a file, <path>.md, or <dir>/README.md)
vault index          List the whole topology (root README)
vault search <q>     Keyword search (L1) — spans every registered store
vault timeline <q>   Snippets around matching lines (L2)
vault get <id>       Load one document's full text (L3; accepts <store>:<path>)
vault ingest [args]  Promote a new source into a canonical vault page
vault graph [--open] Render the vault topology as an interactive HTML graph
vault lint --mode full --root <absolute-target-tree>   Check the selected declared tree
```

On a server-backed store, `search`/`timeline` ask the server and add this copy's
unpushed and uncommitted changes. If the server cannot be reached the search fails
and names `--local` (search this copy instead) — say so rather than switching
silently. A large file may be a small LFS pointer here; `vault get` says so, and
`vault blob get <path>` fetches it. Details: the engine's `docs/remote-mode.md`.

## Procedures

Read the relevant document before acting. `curate` is an agent procedure, not an executable CLI subcommand.

| Subcommand | Reference doc | Summary |
|------------|---------------|---------|
| (none) / path / index / search / timeline / get | this file | read / query paths |
| search / research / freshness check (agent procedure) | [docs/info-retrieval.md](docs/info-retrieval.md) | vault → authoritative source → verified answer → reusable knowledge refresh |
| `ingest` | [docs/ingest.md](docs/ingest.md) | promote a new source — canonical-owner-first, explicit promotion, evidence preservation |
| `curate` | [docs/curate.md](docs/curate.md) | tidy the existing vault — broken links / orphan evidence / duplicate pages / drift |
| `lint` / file-back / lint cadence | [docs/vault-workflow.md](docs/vault-workflow.md) | what lint checks, when to run it, when an answer is filed back into the vault |
| `graph` | [docs/graph.md](docs/graph.md) | render the topology as an interactive node-link graph, one toggleable layer per connection type |
| tree, slots, special files | [docs/layout.md](docs/layout.md) | where each kind of page lives and who may write the special files |
| storage location / sync policy | [docs/storage-policy.md](docs/storage-policy.md) | where a vault repository lives and what it may push to (P1–P3); no registered store yet → run skill `kuma-vault-setup` first |
| backup | skill `kuma-vault-remote-backup` | client-encrypted offsite backup of a local-only vault |

## Vault layout & special files

The tree, the slot contract (owner-first, attachment/diagram/media preservation duties, human/agent role split),
and the `type: special/*` runtime files (`dispatch-log.md`, `decisions.md`, `projects/*.project-decisions.md`)
live in [`docs/layout.md`](docs/layout.md). Read it before ingesting, curating, or filing an attachment.

Two rules that never move: `decisions.md` and `*.project-decisions.md` have a **`user-direct` writer only**
(an agent proposes candidates, never appends), and their text is stored **exactly as the user stated it** —
no summarizing, no inference.

## Cautions

- Retrieval does not itself write. Verified knowledge refresh follows the ingest
  or curate procedure; do not bulk-refresh unrelated pages or write user decisions.
- Summarize large files first; load full text only on request.
- `inbox/` content is unverified — do not cite it without fact-checking.

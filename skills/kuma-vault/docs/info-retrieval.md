# Information retrieval and freshness

This is the search procedure entered by [kuma-vault](../SKILL.md). The skill
routes research; `vault search` itself queries registered knowledge stores and
does not search the internet. Browser mechanics belong to the host's browser
skill — in Kuma Studio, `kuma-computer-use`; below, "the browser skill".

## 1. Resolve the question and search the vault

Identify the fact needed, its scope (version, region, account, hardware), and
whether the user wants a present fact or a historical answer. Follow the root
skill's `search → timeline → get` order, expanding only useful hits.

For no hits, shorten a compound query to its distinctive public term or a known
alias. Then continue to the appropriate source. An unrelated hit is still a miss;
a partial answer requires checking the missing part. Do not keep searching only
the vault or ask the user to explain a public acronym before external discovery.
Search the public acronym plus the task context, open credible candidates, and
ask a focused question only if materially different candidates remain.

Honor explicit source restrictions: an offline or vault-only request stays within
that boundary, with any uncertainty stated. A request to search the web or verify
must actually reach external sources even when the vault has a plausible answer.
Before any external query, remove private context, names, credentials, internal
URLs and identifiers that the user has not authorized disclosing. Use public
product terms; resolve private facts locally or through the authorized service.

### Query shape and canonical priority

**Query shape** — `search`/`timeline` are **not semantic search**: they are phrase-substring plus entity matching.

- Do not throw a whole fuzzy sentence. Start with the single most distinctive token (proper noun, coined term, file stem, handle, date); drop emoji and symbols.
- **0 hits on a multi-word query is not "it does not exist."** Reduce one token at a time before concluding NOT FOUND — search brittleness is not absence (No Silent Fallback).
- A specific artifact name may live only in a page body or its `## Related` line — `get` the page or `timeline` a distinctive token.
- When ingesting, put the phrases a user would actually type into frontmatter `aliases`; a phrase-substring search only hits once an alias contains that phrase.

**Priority for canonical truth:** decision/principle docs → `calendar/` (time/place-bound) → `projects/<slug>.md` → `memos/` → `learnings/`·`domains/` → `results/` and owner-local `_assets`·`_sources`·`_evidence`. Result reports, the dispatch log, and classification reports are evidence layers, not the policy SSoT.

**Anti-patterns:** skipping the vault because the word "vault" was not used · fetching chat history first · grepping the codebase before the vault · expecting a full-body dump from `search`.

## 2. Choose the authoritative source and freshness rule

| Kind of claim | Where to verify | When |
|---|---|---|
| Vendor behavior, model availability, version support, prices, API/CLI contracts, hardware requirements | Official docs, release notes, official repository/model card, or the relevant account console | Last claim verification is at least 24 hours old, missing, invalid, future-dated, or lacks its source |
| Explicit current/latest/verify request, conflicting evidence, or rapidly changing state such as live availability | Appropriate authoritative source | Now, even if the stored claim is younger than 24 hours |
| Current local machine, installed version, repository or session state | Read-only local/remote observation in the authorized environment | Measure live state now; a vendor page cannot verify a particular machine |
| Stable definitions, dated historical facts, archived experiments | Original source/evidence | Reuse when relevant and sourced; recheck gaps or conflicts, not merely age |
| User decisions, preferences, private records | User-owned decision record or authorized original service | Never replace them with web claims; ask only if their meaning remains unclear |

Freshness is per **claim**, not per file. File `updated`, filesystem mtime, an
index rebuild, or another paragraph's timestamp does not prove verification.
Use a timezone-aware ISO timestamp for the last successful source check. Treat a
date-only stamp conservatively as unknown for the 24-hour boundary. At exactly
24 hours, recheck. This is an on-demand procedure for facts needed by this task,
not a daily sweep of the vault. High-stakes or faster-changing facts may need a
stricter rule. A check younger than 24 hours is never a guarantee of correctness.

## 3. Retrieve the actual source, cheapest sufficient method first

Search discovers pages; open the source that supports the claim. Prefer official
material for technical facts, original research for research claims, and the
original record for historical claims. Secondary sources can identify leads;
label claims that only secondary sources support. Do not treat search snippets,
an AI summary, a page title or HTTP 200 as verification.

Define the expected evidence before choosing a tool: a supported-model row, a
price with currency/billing period, a versioned requirement, or the relevant
passage. Use available web search and a lightweight fetch (`curl`/web read) first
when suitable. Existing authorized service connectors can directly provide the
record; a host's service skill (in Kuma Studio, `kuma-apps`) routes service workflows.

| Observed result or task | Next action |
|---|---|
| Source contains the required passage/data | Extract it with URL, scope and check time; stop escalating |
| Empty HTML shell, hydration payload, CSR, placeholder, async or lazy loading | Read the browser skill, select its public browser route, wait for the expected content and inspect the rendered result |
| Data behind tabs, filters, pagination, infinite scroll or a separate console route | Navigate the relevant controls, inspect each resulting state, and record coverage/selection; do not call the first page exhaustive |
| Login redirect, expired session or account chooser | Use the authenticated browser route below; verify identity and the requested record after login |
| Permission denied, subscription required or missing entitlement | Report the actual access boundary; a login alone does not establish permission, and research does not authorize buying access or changing roles |
| Explicit bot challenge, CAPTCHA or repeated redirect loop | Use the browser skill's challenge handling and its stop/handoff rules; do not repeat a rejected challenge or silently switch profiles |
| 429, network failure or server error | Honor retry guidance, make a bounded retry or use another authoritative source, and retain the failed-check evidence |
| PDF, screenshot, canvas, iframe or download hides the evidence | Use the appropriate document reader or the browser's supported inspection; verify the relevant page/content, origin and version |
| User specifies a selected/open tab | Use the browser skill's selected-tab route for that target; do not replace it with an unrelated session |

Wait for an observable condition (expected text, row, completed loading indicator)
with a bounded timeout. A fixed sleep or network-idle alone does not establish
that the requested information loaded. Re-snapshot after navigation or rerender;
verify what changed, and stop with a precise limitation if data never appears.
A rendered screenshot is useful for visual-only evidence; ordinary text should
remain traceable to the source. Avoid irrelevant personal data in captures.

### Browser identity and authentication

Load the browser skill and the relevant documents it links **before** browser
actions. Its current surface, input, concurrency and login contracts own
the implementation; do not copy cookie extraction, browser-launch flags or an
alternative automation stack into this skill.

- Public dynamic pages use its unauthenticated scratch/render path. Do not leak
  logged-in state to arbitrary research sites.
- Account-specific pages use its authorized robot-browser/login path. Reuse
  existing authenticated sessions or stored credentials through that skill's
  credential mechanism. Choose the intended account/workspace/tenant and verify
  that login actually reaches the requested content. Persistent login belongs to
  the skill's login owner, not an improvised disposable profile.
- A selected user tab uses the picker contract. Borrowing the user's local browser
  authentication for reading/downloading requires the explicitly selected
  borrowed-session workflow; a failed fetch or connector does not authorize it.
- Login forms, OAuth consent, MFA and challenges follow the owning skill's rules.
  Do not invent an approval requirement for ordinary authorized login, nor assume
  permission to create/reset credentials, use recovery codes or expand access.
- Distinguish login required, expired login, wrong account, missing permission,
  challenge and loading failure. When human input is genuinely required, report
  the attempted route and exact remaining input; do not claim generic "needs a
  person" merely because a browser is needed.
- Research authorizes navigation and reading within scope. It does not authorize
  sending messages, submitting orders, changing account settings or other writes.
  Open the minimum tabs needed; close only task-owned temporary sessions through
  the browser lifecycle. Preserve the user's tabs and durable login profile.
- Keep passwords, session cookies, authorization headers, OTPs and signed download
  tokens out of queries, evidence and vault summaries. Record stable sanitized
  source links. Verify downloads by actual content, not a successful transfer that
  saved an HTML login page as a PDF.

For region-, account-, currency-, plan- or version-specific results, record that
scope and do not generalize them to everyone. Official documentation and observed
runtime behavior can disagree: report both, with their versions and dates.

Browser extraction, authentication and challenge policy stay with the browser
skill and its linked procedures. A specialized retrieval helper the host may
offer works within those boundaries; it is not a mandatory step for every URL,
nor permission to bypass access controls. A platform the host routes to a
dedicated research path (for example X/Twitter) follows that path. If the
required tool is unavailable, report that limitation; never claim to have browsed.

## 4. Answer, then refresh reusable knowledge

State the supported conclusion, direct source links, relevant verification date
and limits. Separate source statements, measurements and your inference. If the
source is inaccessible or contradictory, say exactly what is unverified; an old
vault claim can be given as dated context, not as confirmed current information.

For reusable verified facts, follow [ingest](ingest.md) and [layout](layout.md):

1. Find the existing canonical page; refresh the relevant claim instead of making
   a second page. Select the owner explicitly for a new reusable fact.
2. Record the claim's supporting source, timezone-aware `verified_at`, and any
   version/account/region scope. A body table or adjacent citation is sufficient;
   this is provenance, not a new required frontmatter schema.
3. After successfully rechecking an unchanged claim, advance its verification
   stamp. After a failed check, preserve its old value and mark currentness as
   unverified separately. Never refresh unrelated claims' timestamps.
4. Replace stale present-tense wording while retaining relevant dated history and
   evidence. Conflicts remain explicit until resolved. Do not overwrite original
   measurements, user decisions or preferences. Decision files are user-direct.
5. Run the existing ingest/curate sync and lint procedure. Respect a read-only or
   no-save request; one-off live state and unverified guesses need no canonical
   page. If persistence fails, distinguish a verified answer from an unsaved update.

Example provenance (synthetic):

| Claim | Scope | Source | verified_at |
|---|---|---|---|
| Feature A is supported | Product Q v2, Linux | https://example.com/docs/feature-a | 2026-10-02T09:00:00Z |

## Opinions and non-research work

Code edits, design judgment and casual conversation do not require web research
unless they rely on uncertain or changeable facts. For opinion questions, load
relevant domain context and prior user decisions; consult the vault's philosophy
reference when making philosophical attributions. Distinguish your judgment from
factual premises and verify those premises through this procedure. User positions
are candidates for user-owned decision records, never automatically ingested.

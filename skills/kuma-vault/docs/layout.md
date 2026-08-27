# Vault layout, slot contract, and special files

SKILL.md routes; this file owns the tree, the slot contract, and the `type: special/*` runtime files.

## Vault layout

The vault is a folder tree whose topology is the root `README.md` → folder `README.md` chain. A typical layout:

```
<vault>/                  (default ~/.kuma/vault, or $KUMA_VAULT_DIR)
├── README.md             Topology entry point (folder README tree + generated vault-index)
│                         # root support files (below) are not navigation slots
├── architecture.md       Vault architecture definition / invariants (if present)
├── schema.md             Slot contract / page rules (if present)
├── decisions.md          User-confirmed decisions (user-direct writer only)
├── dispatch-log.md       Dispatch/runtime event ledger (append-only, not navigation)
├── log.md                Change history (append-only, not navigation)
├── calendar/             Time/place-bound schedule/event catalog
├── domains/              Domain knowledge
├── projects/             Thin canonical project summaries
├── memos/                User favorites layer (read-only, user-owned)
├── learnings/            Benchmarks, debugging patterns, accumulated observations
├── lessons/              Lesson archive (canon is promoted to learnings/, or out of the vault — the host repo's decision log / the owning skill)
├── recordings/           Transcript / meeting source-media archive
├── docs/                 Reference docs
├── images/               Image archive
├── inbox/                Staging with owner/TTL/next-action, awaiting triage
└── results/              Worker result / evidence archive
```

> `index.md` is retired — it lives nowhere in the vault (its presence fails lint). The topology entry point is the root `README.md` → folder `README.md` chain. `dispatch-log.md` / `log.md` are append-only runtime ledgers, so they are not exposed in the generated `vault-index`; they are reachable only from the curated "Root Support Files" prose in the root README.

**Slot contract:**
- Folder topology is expressed by each folder's `README.md` `<!-- vault-index:start/end -->` generated region; the ingest tooling regenerates the affected regions automatically.
- `projects/<slug>.md` is a current-state summary, not a chronicle. Long history and result bodies live in `results/`.
- `calendar/` is the canonical slot for schedule recall ("today / tomorrow / what time / where / event"). Look at `calendar/README.md` before an external calendar or the web.
- `memos/` is the memo-only canonical slot. Do not mix it with decisions or general knowledge; treat it as read-only for background agents.
- Skill docs are SSoT in their source repo. The vault keeps only curated output; there is no skill → vault auto-sync.
- **Human / agent role split** — vault maintenance (summarizing, cross-referencing, filing, bookkeeping, lint, cleanup) is the agent's responsibility. Do not ask the user to "tidy it up" or push the maintenance burden onto them. The user owns source curation, exploration direction, good questions, and decisions.
- **Attachment / image co-preservation duty** — when saving a vault page (memo, plan, learning, etc.), if the context carries an attachment or a pasted image, pick a canonical owner first and copy it into that owner's `_assets/`, `_sources/`, `_evidence/`, or a domain catalog, and record the durable path in the page body. If the owner is unclear, put it in `inbox/` with owner/TTL/next-action. Never keep only a text summary while leaving the original outside the vault. Top-level `raw/` is removed; new and existing evidence go owner-local or into a TTL'd `inbox/` only.
- **Diagram / rendered-artifact source-preservation duty** — for diagrams and visual artifacts rendered from HTML/SVG, durably preserve the editable/re-renderable source (the HTML, etc.) in the vault. Copy the source next to the related knowledge page (`domains/<category>/_diagrams/` or an owner-local `_assets/`/`_sources/`) and link the artifact from the page body. **A PNG (or other render output) is a generated artifact; the HTML source is canonical** — one best-resolution PNG may sit alongside, but there must be a source. Never keep a volatile path (like `/tmp`) as the final home (lost on reboot → not editable/regenerable).
- **Media-resource catalog duty** — for reusable/publishable/reviewable generated media (video/audio/image sets), follow the vault's Media Resource Contract (in `schema.md` if present). Record `title / aliases / tags / engine / style / status / canonical_final / variants / source_assets / related_threads / notes`. A meaningful file found under `Downloads/`, an external project folder, or `/tmp` is not a canonical owner — report it as "not in the vault catalog" and leave it as an ingest/curate candidate.
- **Topology-first + inbox-only staging** — new knowledge/attachments/originals pick a canonical owner first. Do not drop into a top-level `raw/` to "sort later." If the owner is unclear, put it only in `inbox/` with owner/TTL/next-action recorded. Past raw material is resolved as owner-local migrate / canonical-promotion / inbox-triage / keep-historical / delete-candidate — never returned to raw.


## Special Files

The runtime memory layer, marked by `type: special/*` frontmatter. Unlike a normal vault page, its writer/reader/trigger/retention are fixed.

| File | type | Role | Primary writer | Boot-pack load |
|------|------|------|----------------|----------------|
| `dispatch-log.md` | `special/dispatch-log` | episodic ledger (a stream of task events) | dispatch lifecycle hook | tail 20 |
| `decisions.md` | `special/decisions` | global decision memory (a single layer of user-confirmed decisions) | `user-direct` only | latest ~10 entries |
| `projects/<slug>.project-decisions.md` | `special/project-decisions` | per-project execution/design decisions | `user-direct` only (project scope) | current project only |

**`decisions.md` single-layer structure:**
- Only two sections exist: `## About` + `## Decisions`. No Inbox / Ledger / Open-Decisions subsections.
- `## Decisions` holds one `- <resolved_text>` line each. No date / id / action / scope / context_ref fields.
- The writer is always `user-direct`. There is no detector/lifecycle/audit auto-append path. An assistant may propose candidates but is not the canonical writer.
- No AI interpretation, summarization, or inference — store the resolved text exactly as the user stated it.


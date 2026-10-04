# Vault workflow — ingest, query, lint

The rules that keep a vault useful over time, one section per operation. The step-by-step
procedures live elsewhere and are linked, not repeated: [ingest](ingest.md),
[curate](curate.md), [information retrieval](info-retrieval.md) and [layout](layout.md). A
tree's own `architecture.md` and `schema.md` (when it has them) own its slot contract; this
page owns how the three operations are run on top of it.

## Ingest

- **Owner first.** Choose the canonical owner before saving anything, then keep the source
  next to it (`_sources/`, `_evidence/`, `_assets/`) or in `results/`. If the owner is unclear,
  park it in `inbox/` with an owner, a TTL and a next action. There is no top-level `raw/`.
  Procedure: [ingest](ingest.md); evidence rules: [layout](layout.md).
- **A source you could not fetch is said so.** Record "source not retrieved — URL only" on the
  page or the inbox note; never pass a summary off as the original.
- **No improvised folders.** If a page fits no slot, extend the tree's `schema.md` first, then
  file it.
- Exempt from keeping a copy: public repositories (re-fetchable at any time), API
  specifications whose official URL is the canonical source, and the user's own notes.

## Query

- **Vault first, then the source.** Follow [information retrieval](info-retrieval.md): a hit
  still gets its claim-level source and freshness check.
- **File back what will be reused.** When an answer produces something reusable, save it as
  a canonical page — `learnings/` when it generalises, `domains/` when it belongs to one
  domain. Otherwise the next session starts from scratch.

  | File back | Do not file back |
  |---|---|
  | a conclusion drawn from two or more sources | one-off debugging |
  | a question the user is likely to ask again | session-only state |
  | a fact we verified ourselves | small talk |
  | a comparison table or decision matrix | what a canonical page already says |

  `memos/` is the user's own layer; agents do not file answers there.

## Lint

### When

- **On demand:** `vault lint --mode full --root <tree>` (`--json` for machines). The tree's
  root `vault.config.json` names its contract.
- **After structural change:** a schema or architecture edit, a large move, a canonical reset.
- **Routinely:** at least monthly, both passes below.

### What the deterministic pass catches

`vault lint` reports these as failures:

- **Dead relative links** — `[text](path.md)` and `[text](path.md#anchor)` whose target does
  not exist. Inline and fenced code examples are not links.
- **Special-file sanity** — the root `README.md`, `schema.md`, `log.md`, `decisions.md` and
  `dispatch-log.md` exist with their required frontmatter. A retired `index.md` fails lint.
- **Slot contracts** — the frontmatter and section contract of project summaries, project
  decisions, calendar, memos, learnings, lessons, the result archive, persona-memory pages and
  category indexes.
- **Canonical drift** — legacy ingest markers or result sources leaking into a project page,
  a schema/special-file mismatch.
- **Folder topology** — every navigable folder has a `README.md`; a sibling `X.md` beside an
  `X/` folder is drift. Asset and archive folders are exempt from per-item indexing but keep
  a thin `README.md` that says so.
- **Reachability** — starting at the root `README.md` and following folder READMEs and
  relative links, every navigable page is reachable. Dead links, orphans, case mismatches,
  links out of the root, symlink escapes and stale generated regions are failures.
- **Cross-store pointers** — see the engine's `docs/cross-store-pointers.md`.

How reachability is judged:

- The root is resolved with `realpath`; every resolved link must stay inside it.
- Path segments must match the real directory entry's case exactly, even on a
  case-insensitive filesystem.
- The walk starts at `README.md` links and keeps a visited set; `#anchor` and query suffixes
  are dropped before resolving.
- `results/`, `memos/`, `inbox/`, `images/`, `recordings/`, `lessons/` and `docs/` are exempt
  from per-item reachability; their own thin `README.md` must still be reachable.
- A `<!-- vault-index:start/end -->` region must equal what the folder's direct children
  generate. A difference is a failure, never silently regenerated.

Lint finds; `vault sync` regenerates. Both use the same rules, so the checker and the
generator cannot disagree (the engine's `docs/architecture.md`, "The commit gate").

### What only a model can judge

Stale evidence, contradictions and missing cross-references are not deterministic checks yet;
an agent pass looks for them:

- two pages making different claims about one subject;
- a concept mentioned on several pages with no page of its own;
- a page that mentions a concept without linking its page;
- "to be confirmed" left in strategy or FAQ pages, or a claim resting on stale evidence.

Record the findings in `log.md` with a `- LINT:` line and turn them into follow-up items.

### Finding is not fixing

A lint pass only reports. Fixes are a separate ingest or [curate](curate.md) task, because an
automatic fix in the same pass can change meaning.

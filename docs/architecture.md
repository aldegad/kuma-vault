# Architecture

kuma-vault compiles a Markdown knowledge base the way a build tool compiles code. This page
explains the model: what is source, what is derived, where a model is allowed to write, and
how a tree declares its own rules.

## The problem

A knowledge base kept with an LLM usually decays in one of two ways:

1. **A hand-kept central index** drifts from the files. Once the index and the files disagree,
   neither search nor trust survives.
2. **A vector dump** chops documents into embedded chunks. Search works, but nobody knows which
   page owns a fact any more, so nothing can be updated, owned or tidied.

The common cause is one: **the truth lives in two places.**

## Every view is a pure function of the source

People and agents maintain one thing: the source pages. Folder indexes and binary-file
sidecars are **derived** by one `vault sync`. Derivation is content-hash
idempotent — when the source has not changed, running it again changes nothing — so an index
cannot drift from its pages.

```mermaid
flowchart LR
    subgraph SRC["Source (the only truth)"]
        MD["Pages .md<br/>(frontmatter + body)"]
        BIN["Binary originals<br/>(PDF, ...)"]
    end

    subgraph SYNC["vault sync (the compiler)"]
        S1["1. Sidecar extraction<br/>sha256 stamp — changed files only"]
        S2["2. Enrich (--enrich)<br/>description · tags · aliases<br/>for empty or stale fields only<br/>one model call per page"]
        S3["3. Folder README indexes<br/>from descriptions · fixed point"]
    end

    subgraph OUT["Derived (always regenerable)"]
        SC["Sidecars &lt;file&gt;.pdf.md"]
        IDX["Folder README<br/>vault-index region"]
    end

    BIN --> S1 --> SC
    MD --> S2 --> MD
    MD --> S3 --> IDX
    SC --> S3
```

## The folder tree is the ownership map

Every piece of knowledge lives in exactly one folder, its canonical owner, and each folder's
`README.md` is both its entry point and its index. Tags, aliases and other frontmatter are
search handles only: **the topology decides what is true; tags help you find it.**

- **Sources sit next to their owner.** Originals, attachments and intermediate files go in
  `_sources/`, `_evidence/` and `_assets/` beside the owning page. These folders are not
  navigation and are not indexed.
- **Indexes are derived.** A folder README's `<!-- vault-index -->` region is generated from
  its children's frontmatter `description`. Nobody edits it by hand.

## Where a model may write — enrich

A model writes in exactly one place: three search fields in a page's frontmatter —
`description` (a one-line synopsis), `tags` (topic tags) and `aliases` (synonyms,
abbreviations, other-language search terms) — plus their idempotency stamps
`description_hash`, `tags_hash` and `aliases_hash`. One model call fills all three.

1. When a page is new or its body changes, the next `vault sync --enrich` picks it up — or,
   on a server-backed clone that turned it on, the [sync daemon](sync.md#descriptions-enrich-on-autosave)
   right after the page is committed there, by its autosave or by an agent's own commit
   (`--enrich-paths-from`, capped per tick and per hour). Such a run writes its pages together
   after its last model call, so a description never sits in the tree without its index line
   for longer than the index pass that follows.
2. Only pages with an empty field, or a field whose stamp no longer matches the body hash, get
   a call. A page whose three fields are current costs nothing.
3. The description flows into the folder index by derivation; tags and aliases stay in the
   page's frontmatter, where `rg` finds them. The model never writes an index.
4. A value a person wrote (a field with no stamp) is never overwritten, field by field.
   Filling only tags and aliases on a page whose description is already stamped does not
   regenerate the description. New tags reuse the tree's existing tag pool first; a new tag
   is allowed when none fits.
5. A failed call leaves the file untouched and is reported per file. There is no fallback.
6. Which pages are targets is one resolver (`isEnrichTargetPath`) under the tree's declared
   profile: leaf knowledge pages, not the plans slot, archive slots, root ledgers, indexes,
   sidecars or owner-local buckets, and not the pages the tree declares out (`enrichExclude`,
   below) — the files a person alone writes, such as decision ledgers, get no model-written
   field at all. A secret directory (`_credentials/`, `_sync-conflicts/`,
   the resolver in `src/server/secret-dirs.mjs`) is never a target whatever the declaration
   says, and a page is never reached through a symlink, so a secret is never sent to a model.
7. A page saved again while the model ran is not overwritten; it is reported `raced`.

`vault sync` without `--enrich` calls no model at all: sidecars and indexes are pure
functions, offline and free. Enrich is an optional layer on top.

**The provider is plugged in.** The pure enrich engine needs one injected function,
`generateDescription({ relativePath, title, body, tagPool }) => { description, tags, aliases }`.
An adapter supplies it by spawning the chosen CLI once per page in an **empty temporary
directory** — never inside the vault — so the model sees that page and nothing else: no
project instructions, no uncommitted work.

```mermaid
flowchart LR
    E["vault sync --enrich"] --> A{"provider adapter"}
    A --> CL["Claude<br/>(claude CLI)"]
    A --> CX["Codex<br/>(codex CLI)"]
```

The adapter owns the list of supported providers. The chosen `{ provider, model }` is stored
by [`kuma-vault setup`](setup.md#enrich-provider); with no choice stored, `--enrich` is an
error, not a quiet default.

## When sync runs — boundaries, not a watcher

The compiler runs at well-defined boundaries, and every boundary calls the same sync engine:

```mermaid
flowchart TD
    T1["right after an ingest"] --> E
    T2["git pre-commit hook<br/>(--check gate)"] --> E
    T3["a sync daemon or scheduled run<br/>(optional)"] --> E
    T4["lint self-heal<br/>(on a stale index, optional)"] --> E
    E["one sync engine<br/>no convergence = an error"]
```

No boundary has its own regenerator; they all funnel into `syncVaultIndex`, so the result is
the same whichever way you came in. If a run cannot converge, the leftover drift is reported
as an error. (On a server-backed vault the [sync daemon](sync.md) also runs `vault sync`
before each autosave commit.)

### What happens when a file changes

| Event | Who handles it | What happens |
|---|---|---|
| **Page added** | script, plus one model call with `--enrich` or the daemon's enrich on autosave | the next sync lists it in its folder index; enrich fills `description`, `tags` and `aliases` in one call and stamps each field, so a rerun makes no call |
| **Page body changed** | script, plus one model call with `--enrich` or the daemon's enrich on autosave | the body hash no longer matches a field's stamp, so only that page is enriched again; person-written fields are kept |
| **Page moved** | script only | the search fields travel with the file's frontmatter; the next sync removes it from the old folder's index and adds it to the new one. No model call |
| **Page deleted** | script only | its index line goes. No model call |
| **Folder created** | script only | a folder holding pages gets a generated `README.md` and an entry in its parent's index; the chain converges within one sync |
| **Binary added or changed** (PDF, ...) | script plus extractor | only files whose sha256 changed get their sidecar (`<file>.pdf.md`) extracted again; sidecars are indexed like pages and are plain text for `rg` |
| **Binary deleted** | script, report only | the leftover sidecar is reported as an orphan, never deleted silently; a person decides |
| **Model call failed** | explicit report | the file is untouched and listed among the per-file failures |

## The commit gate

`vault sync --check` is a gate on **the tree being committed**. Every derived file (the folder
README `vault-index` regions, binary sidecars) is inside the commit. If one disagrees with its
generator, the snapshot being committed contradicts itself, and regenerating during the commit
would only fix unstaged files → exit 1; run `vault sync` and commit again. An edit that moves no
derived file (a page body) passes.

On a server-backed store the gate also refuses commits during a freeze, binaries in
`binaries.reject` places and oversized non-LFS files — see
[remote mode](remote-mode.md#the-commit-gate-vault-sync---check-the-pre-commit-hook).

## Finding a page — from a vague question to the right file

```mermaid
flowchart LR
    Q["vague question"] --> F["scoped rg over the tree<br/>files (-l), then lines (-n -C2)"]
    F --> R["topology entry point<br/>folder README = owner"]
    R --> G["read the page (vault get)"]
    G --> V["check the source, then answer"]
```

- The pages are plain Markdown on disk, so `rg` reads them directly: no index to build, keep in
  step or wait for. Sidecars put a binary's text beside it for the same search.
- Scope it — Markdown only (`-t md`) and a folder when one is known; an unscoped `rg` also reads
  every binary in the tree.
- `_credentials/` and `_sync-conflicts/` are skipped by default: setup writes a generated
  `.rgignore` naming them. git does not read it, so they stay tracked and synced; an explicit
  path or `--no-ignore` still reads them.
- There is no search index. The earlier one (`vault search`, SQLite FTS5 with a trigram
  tokenizer) could not match a word shorter than three characters, left `plans/` out and was
  rebuilt on the server after every push; a scoped `rg` has none of those limits, so it was
  removed.

## Engine, host and content trees

The engine is one of three separate roles, and it hard-codes no tree:

```mermaid
flowchart TD
    HOST["Host application (e.g. Kuma Studio)<br/>consumes the engine; injects task-result paths,<br/>a project registry and the enrich model policy"]
    ENG["kuma-vault (this repository)<br/>sync / lint / enrich compiler,<br/>the vault CLI and the git hook installer"]
    K1["Knowledge tree A<br/>declares itself in vault.config.json"]
    K2["Knowledge tree B<br/>declares itself in vault.config.json"]
    HOST -->|"depends on"| ENG
    ENG -->|"sync / lint"| K1
    ENG -->|"sync / lint"| K2
```

- **The engine** is the only owner of the contract and the compiler, the `vault` CLI and the
  pre-commit hook installer.
- **A host** consumes the engine and injects its own concerns ([design](design.md)); it owns
  no engine code.
- **Knowledge trees** are siblings, never nested, all governed by the same engine. What
  differs per tree — index scope, checks, sidecar / enrich switches — is declared at
  that tree's root.

No tree gets a fork of the engine; an engine improvement reaches every tree at once.

## Trees declare themselves — `vault.config.json`

A managed tree carries a `vault.config.json` at its root that **declares its own contract**:
a base contract id (`profile`, one of the engine's built-in profiles), tree-local overrides
(extra non-navigation root files, the schema path, feature switches) and an optional `id`:

```json
{ "profile": "kuma-vault" }
```

Decisions that need the tree's own names live there too. For example, persona-memory pages at
the top of `domains/` are listed by the tree, `"personaMemoryPages": ["domains/<name>.md", …]`
(no default — a page's shape cannot tell a persona page from a misplaced topic page). An
undeclared top-level page is `domain-top-level-drift`. Likewise the pages no model may write
in, `"enrichExclude": ["/decisions.md", "projects/*.project-decisions.md"]` — gitignore syntax,
relative to the tree, matched without regard to case, no default. A declaration is read strictly:
an engine older than a key it carries refuses the whole file (`unknown key(s) …`) rather than
ignoring the key, so a tree adopts a new key after every engine that reads it (each clone's
`vault`, the server) has the release that knows it.

A profile is plain data: which slots are not navigation, which root files are ledgers, whether
sidecars and enrich are on. One declaration gives the full pipeline; another gives only a
pre-commit gate that checks the git-tracked topology.

The CLI resolves **root and contract together** from this declaration, so a root can never be
paired with someone else's contract by a forgotten flag. The rules fail loudly:

- **The declaration owns the contract.** A `--profile` flag that disagrees with it is an
  error (the declared id itself is accepted).
- **An explicit root without a declaration** needs an explicit `--profile`; with neither, it
  is an error.
- **Without a root flag** the CLI walks up from the current directory, stopping at the git
  top level, so a declaration outside the repository you are in is never used. Nothing found
  is an error; sync and lint have no default vault.
- **A broken declaration** (bad JSON, an unknown key, a wrong type) is an error, never skipped.

Engine entry points that already know the root (`lintVaultFiles`, `runVaultSync`) resolve the
contract the same way (`resolveTreeContract`): no contract passed means the root's declaration;
a contract passed must match it; an undeclared tree needs one. So the lint after an ingest, a
host's lifecycle hook, self-heal and any host call get the declared rules too, and `vault
ingest` resolves the contract before writing — it writes nothing into a tree it cannot
resolve. Implementation: `src/engine/vault-config.mjs`.

## Invariants

| # | Invariant | How it is enforced |
|---|---|---|
| 1 | Every view is a pure function of the source | the sync pipeline is the only derivation path |
| 2 | A model writes only the enrich fields of a page's frontmatter | a write-allowlist test fails on any other change |
| 3 | Derivation is hash-idempotent: a second run is a no-op | sha256, per-field enrich stamps |
| 4 | The checker (lint) and the generator share their rules | shared predicate modules |
| 5 | Failures are reported, never silently replaced | per-file failure lists, convergence failure throws |
| 6 | Volatile slots are left out of derivation | one exclusion rule shared by the index and enrich walks |

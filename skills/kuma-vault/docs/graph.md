# vault graph — topology graph reference

`vault graph` renders the whole vault as an interactive node-link graph in a single
self-contained HTML file (no external dependencies, opens over `file://`). It exists to make
the vault's **connection structure** legible: not just the folder tree, but every distinct
way the frontmatter links knowledge together.

```
vault graph [--all-stores] [--open] [--out <path>] [--vault-dir <path>]
```

- Default output: `<vault>/.graph/topology.html` — a machine-only derived artifact, exactly
  like `.fts/`. It is a pure function of the leaf markdown, regenerable at any time, and the
  `.graph/` dir self-ignores (`.gitignore` = `*`) so it is never committed.
- `--open` launches the file in the default browser (`open` / `xdg-open` / `start`).
- `--out <path>` writes elsewhere (e.g. a shared location) instead of the default.
- `--all-stores` renders the **union view** (`union.html`): every registered, scannable store
  from `vault-stores.json` is walked as its own rooted component, and cross-store pointers
  become real document-to-document **bridges** into the target store's actual nodes. The
  picture answers "can an agent traverse from one store into the other, and through how many
  links" — only edges an agent can actually follow are drawn, so two stores with no pointers
  between them honestly render as separate islands. The bridge count is printed with the
  render (`cross-store bridges: N`; 0 = not navigably connected). Requires the registry; its
  absence is a loud error, never a silent single-store render.

## What the graph shows

- **Root** — the vault itself, pinned at center. The topology's starting point.
- **Nodes** — every `.md` document, every folder, plus hub nodes for tags / domains / schema
  types / projects.
- **Edges** — one classified, independently toggleable **layer per connection methodology**.
  Each layer has its own color, count, WHY (why the vault uses it) and ROLE (what it does),
  shown in the GUI's per-layer `ⓘ` panel. `◎` solos a single layer so you can inspect one
  methodology at a time.

## Connection methodologies (the classified layers)

The layers mirror the vault's canonical linking contract (`schema.md`). Counts below are
illustrative from a large vault; yours will differ.

| Layer | Frontmatter / source | Why it exists | Role |
|---|---|---|---|
| **hier** (hierarchy) | folder README topology | the vault's canonical ownership structure is the folder tree; every doc is owned by exactly one folder | the SSoT of *where a doc lives*; the backbone reaching every doc from the root |
| **ref** (reference) | `related:`, `## Related`, relative `.md` links, `[[wikilinks]]` | hand-authored, explicit cross-reference between pages | "see this, then see that" — deliberate related-knowledge navigation |
| **xstore** (cross-store) | inline-code cross-store pointer `` `<store-id>:<path>` `` (parser shared with `vault lint`; store roots from the machine registry `vault-stores.json`) | a fact lives in exactly one store, so a page in this tree points at the owning document in another tree (the engine's `docs/cross-store-pointers.md`) | shows where two knowledge stores connect: referencing doc → external doc → external store hub. A pointer whose registered root is *this* tree resolves to the internal node instead (one document, one node). No registry on the machine → the layer is empty and the skip is printed at generation time, never silent |
| **alias** | reference resolved via a page `aliases` value | per `schema.md`, `aliases` are **search handles** (synonyms / abbreviations / cross-language), not page-to-page links — they connect a *query* to a page | find-by-fuzzy-memory. Structurally near-empty as a doc→doc layer: almost no references resolve through an alias, and that emptiness is the honest truth, not a bug |
| **tag** | shared `tags:` → tag hubs | bounded-vocab topic tags (one of the three enrich fields) shared across docs | cross-groups docs by topic even across folders; a `#hub` reveals a topic cluster |
| **domain** (deprecated field) | `domain:` → drift hubs | the `domain:` field is **deprecated**: membership is declared by the path, cross-cutting classification by `tags` | surfaces any *leftover* `domain:` values as drift; a clean vault shows 0 hubs and 0 edges here |
| **schema** | `type:` / `kind:` → type hubs | schema classification fields (`special/decisions`, `special/dispatch-log`, `sidecar`, `tech`, …) | groups by document *kind/role*, surfacing the special-file contracts |
| **project** | `project:` → project hubs | the project a work artifact belongs to | bundles per-project output; the primary way the `plans/` subtree interconnects |
| **planline** (plan lineage) | `parent_plan:` chain | a plan points at its parent plan (plan id `<project>/<stem>`) | plan parent-child lineage / orchestration flow, master plan → derived plans |

## Notes

- **`tags`/`aliases` are search handles, not owners** (`schema.md`). They never replace a
  canonical owner, which is why the hierarchy layer is the backbone and the alias layer is
  near-empty.
- **`plans/` connects via `project` + `parent_plan`, not `related`.** A plan subtree with no
  `related:` frontmatter still links up through its project hub and its parent-plan chain —
  solo those two layers to see per-project clusters break out cleanly.
- **On-screen distance means connectivity.** Gravity pulls every node toward its OWN store's
  anchor (stores are laid out with a real gap), and each section toward a stable slot inside
  its store — so unconnected stores sit apart, cross-store bridges render as visibly taut
  thick lines, and sections separate into same-colored continents. No shared center exists to
  glue unrelated components together. Precise relations still live in the click-detail panel;
  the layout is the tendency, the panel is the truth.
- **Local graph (N-hop focus).** Selecting a node offers 1/2/3-hop buttons that hide everything
  outside that radius over the ACTIVE layers — the Obsidian-style answer to "how is THIS node
  connected". Esc restores the full view.
- Unresolved references (external URLs, owner-local asset paths, ambiguous stems) are counted
  but not drawn — the graph is link-based, and an unresolvable target is not a node edge. The
  counts are printed with the render (`unresolved: ref=… plan=… xstore-unknown-store=…
  xstore-self=…`) so what is absent from the picture is still visible.
- **Operational-artifact sections start hidden.** `plans/`, `results/`, and `_archive/` are
  most of a working vault's documents and drown the knowledge
  topology, so the default view excludes them. They stay listed (dimmed, with counts) in the
  Sections legend — one click, or the show-all action, brings them back.
- The render is a snapshot. Re-run `vault graph` after the vault changes to refresh it.

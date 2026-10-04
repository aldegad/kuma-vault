# Curate existing knowledge

Curate repairs existing pages, links, duplicate content, and generated indexes. It is an agent procedure, not a CLI subcommand. New sources use [ingest](ingest.md); tree ownership and special-file writers follow [layout](layout.md) and the target tree's schema.

## Procedure

1. Select the target tree and scope: one page, a domain/project, or the whole tree. If unspecified, inspect the tree and apply only unambiguous fixes.
2. Run `vault lint --mode full --root <absolute-target-tree>`. Read affected pages, folder README indexes, source links, and owner-local evidence to identify the problem.
3. Repair broken links to verified targets. Merge duplicate pages into the identified owner and update their references. Split mixed pages only when they contain separate concerns. Ask when ownership is ambiguous.
4. Regenerate stale indexes with `vault sync --root <absolute-target-tree>`; do not hand-edit generated index regions.
5. Preserve original evidence using the classifications below. Respect special-file writers: decision files remain user-written and logs remain append-only.
6. Re-run the scoped checks and full lint. Report applied changes, evidence retained, and unresolved decisions; omit empty report sections.

## Evidence disposition

An unreferenced file is not automatically disposable. Classify it before moving or deleting it:

| Classification | Action |
|---|---|
| `owner-local-migrate` | Move into the identified owner's `_assets/`, `_sources/`, or `_evidence/`; repair references. |
| `canonical-promotion` | Use [ingest](ingest.md) to promote reusable knowledge into its owner page. |
| `inbox-triage` | Record owner, TTL, and next action in `inbox/` when ownership is unresolved. |
| `keep-historical` | Preserve immutable references, audit evidence, and legal originals with their retention reason. |
| `delete-candidate` | Identify duplicate or obsolete material and obtain owner authorization before bulk deletion. |

Do not create a top-level `raw/` staging area. Skills remain in their source repository; the vault stores knowledge and evidence, not copies of installed skills.

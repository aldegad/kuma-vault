# git-filter-repo --commit-callback body (rewrite pipeline step 4, attrs.py).
# Arguments: commit, metadata. Environment: BRW_TOOLS, BRW_RUN (attrs-blob.txt
# written by prepare_attrs.py), BRW_GITDIR (the repo being rewritten).
# Root commits get the generated root .gitattributes. A history change to
# the root .gitattributes is rewritten as generated block + that version's
# lines; a deletion of it becomes the generated block alone, so every rewritten
# commit carries the LFS rules. Every path is put in NFC first (server receive
# rule 2; filter-repo refuses a filename callback next to a file-info callback),
# dropping the deletions nfc_plan.py listed in BRW_RUN/nfc-keep.tsv.
import os, sys
sys.path.insert(0, os.environ["BRW_TOOLS"])
import brainrw
st = brainrw.attrs_state()
changes = commit.file_changes
commit.file_changes = changes = brainrw.nfc_file_changes(changes, st["nfcKeep"].get(commit.original_id, ()),
                                                          st["stats"])
touched = False
for i, c in enumerate(changes):
    if c.filename != b".gitattributes":
        continue
    touched = True
    if c.type == b"D":
        changes[i] = FileChange(b"M", b".gitattributes", st["blob"], b"100644")
        st["stats"]["deleteReplaced"] += 1
    elif c.type == b"M" and c.blob_id != st["blob"]:
        changes[i] = FileChange(b"M", b".gitattributes", brainrw.attrs_merged_blob(c.blob_id), c.mode)
        st["stats"]["modifyMerged"] += 1
if not commit.parents and not touched:
    changes.append(FileChange(b"M", b".gitattributes", st["blob"], b"100644"))
    st["stats"]["rootAdded"] += 1

# git-filter-repo --file-info-callback body (rewrite pipeline step 4, rules 0/a/b/c).
# Arguments: filename, mode, blob_id, value. Environment: BRW_TOOLS (this
# directory), BRW_RUN (run dir with final-map.tsv, strip-blob-ids.txt; this
# callback writes lfsify-stats.json there at exit).
# Only blob ids are looked up; contents are read for blobs under 1 KiB only
# (existing-pointer check), so binary bytes never pass through Python.
D = value.data
if "brw" not in D:
    import atexit, os, sys
    sys.path.insert(0, os.environ["BRW_TOOLS"])
    import brainrw
    run = os.environ["BRW_RUN"]
    rows = brainrw.read_final_map(os.path.join(run, "final-map.tsv"))
    D["brw"] = brainrw
    D["fm"] = brainrw.final_map_by_sha1(rows)
    D["fm256"] = set(r["sha256"] for r in rows if r["kind"] in ("file", "pointer"))
    D["strip"] = brainrw.read_strip(os.path.join(run, "strip-blob-ids.txt"))
    D["ptr"] = {}
    D["stats"] = {"empty": 0, "strip": 0, "pointer": 0, "existingPointer": 0, "nonRegularMode": 0}
    atexit.register(lambda: brainrw.write_json(os.path.join(run, "lfsify-stats.json"), D["stats"]))
brw = D["brw"]
if not brw.is_lfs_path(filename):
    return (filename, mode, blob_id)
st = D["stats"]
if mode not in brw.REGULAR_MODES:
    st["nonRegularMode"] += 1
    return (filename, mode, blob_id)
if blob_id == brw.EMPTY_BLOB:
    st["empty"] += 1                                   # 0: empty blob passes through
    return (filename, mode, blob_id)
if blob_id in D["strip"]:
    st["strip"] += 1                                   # a: delete the path in this commit
    return (filename, None, blob_id)
hit = D["fm"].get(blob_id)
if hit is not None:
    size, sha256 = hit
    pid = D["ptr"].get(sha256)
    if pid is None:
        pid = value.insert_file_with_contents(brw.pointer_bytes(sha256, size))
        D["ptr"][sha256] = pid
    st["pointer"] += 1                                 # b: pointer blob
    return (filename, mode, pid)
if value.get_size_by_identifier(blob_id) < brw.POINTER_MAX:
    parsed = brw.parse_pointer(value.get_contents_by_identifier(blob_id))
    if parsed and parsed[0] in D["fm256"]:
        st["existingPointer"] += 1                     # c: existing pointer, object already in CAS
        return (filename, mode, blob_id)
raise SystemExit("lfsify: unclassified LFS-path blob %s at %r" % (blob_id.decode(), filename))

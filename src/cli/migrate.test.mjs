// `vault migrate refmap` and `rollback-export`, on a scratch cutover:
//
//   old repo O (master): raw binaries in history, two files already LFS by a sub-.gitattributes,
//     a freeze commit HEAD_final with text only; at freeze the work tree also holds an untracked
//     binary, a modified tracked binary and one untracked binary nobody touches later.
//   rewrite into N (main): every old commit replayed with large files as LFS pointers (bytes in a
//     CAS dir), commit map old -> new, refs/replace/<old> for each; then P (the freeze-time
//     binaries as pointers) and the configuration commit + forward refmap = the cutover tip.
//   after the cutover N gets text edits, a new binary, changes to P's binaries, a merge, an empty
//   png, a symlink, an LFS mp4 change and a change to .gitattributes/vault.config.json.
//
// rollback-export replays tip..main onto O and the reverse refmap restores old shas. The round
// trip holds when O's work tree equals N's main with pointers resolved, except the paths the
// export skips by design (.gitattributes, the tree's vault.config.json) and the shas refmap
// rewrites.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLfsPath, parseLfsPointer, renderLfsGitattributesLines, renderLfsPointer } from "../server/lfs-paths.mjs";

const VAULT_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vault");

let root;
let home;
let O;
let N;
let CAS;
let mapFile;
const oldShas = {};
const newShas = {};
let headFinal;
let tip;

function sh(cmd, args, { cwd, input, env = {}, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, HOME: home, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1", GIT_LFS_SKIP_SMUDGE: "1", LC_ALL: "C", ...env },
  });
  const out = { code: r.status, stdout: r.stdout, stderr: r.stderr.toString("utf8"), text: r.stdout.toString("utf8").trim() };
  if (out.code !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")} (${out.code}): ${out.stderr}`);
  return out;
}
const git = (cwd, args, opts) => sh("git", args, { cwd, ...opts });
const vault = (args, opts = {}) => sh(VAULT_BIN, args, { allowFail: true, ...opts });

function write(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function commitAll(dir, message, date) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "--no-verify", "-m", message], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return git(dir, ["rev-parse", "HEAD"]).text;
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const casPath = (oid) => join(CAS, oid.slice(0, 2), oid.slice(2, 4), oid);
function toCas(bytes) {
  const oid = sha256(bytes);
  mkdirSync(dirname(casPath(oid)), { recursive: true });
  writeFileSync(casPath(oid), bytes);
  return renderLfsPointer(oid, bytes.length);
}

/** Write `bytes` at an LFS path of N's work tree as a pointer (+ CAS), the way git-lfs would. */
function writeLfs(dir, path, bytes) {
  write(dir, path, bytes.length === 0 ? "" : toCas(bytes));
}

/** Rewrite one old commit into N: same message/author/dates, large files as pointers. */
function replayIntoN(oldCommit, parent) {
  const listing = git(O, ["ls-tree", "-r", "-z", oldCommit]).stdout.toString("utf8").split("\0").filter(Boolean);
  const lines = [];
  for (const record of listing) {
    const tab = record.indexOf("\t");
    const [mode, , sha] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    let blob = git(O, ["cat-file", "blob", sha]).stdout;
    if (mode !== "120000" && isLfsPath(path) && blob.length > 0 && !parseLfsPointer(blob)) blob = Buffer.from(toCas(blob));
    if (parseLfsPointer(blob)) {
      // already a pointer in O (the sub-.gitattributes files): move its object to the CAS
      const { oid } = parseLfsPointer(blob);
      const src = join(O, ".git/lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid);
      if (existsSync(src) && !existsSync(casPath(oid))) {
        mkdirSync(dirname(casPath(oid)), { recursive: true });
        writeFileSync(casPath(oid), readFileSync(src));
      }
    }
    const newSha = git(N, ["hash-object", "-w", "--no-filters", "--stdin"], { input: blob }).text;
    lines.push(`${mode} ${newSha}\t${path}`);
  }
  const index = join(root, "rewrite.index");
  rmSync(index, { force: true });
  const env = { GIT_INDEX_FILE: index };
  git(N, ["update-index", "-z", "--index-info"], { env, input: `${lines.join("\0")}\0` });
  const tree = git(N, ["write-tree"], { env }).text;
  const raw = git(O, ["cat-file", "commit", oldCommit]).stdout.toString("utf8");
  const header = raw.slice(0, raw.indexOf("\n\n"));
  const person = (k) => /^\S+ (.*) <(.*)> (\d+ [+-]\d{4})$/m.exec(header.split("\n").find((l) => l.startsWith(`${k} `)));
  const [, an, ae, ad] = person("author");
  const [, cn, ce, cd] = person("committer");
  return git(N, ["commit-tree", tree, ...(parent ? ["-p", parent] : [])], {
    input: raw.slice(raw.indexOf("\n\n") + 2),
    env: { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd },
  }).text;
}

function treeFiles(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full);
      if (rel === ".git") continue;
      if (entry.isSymbolicLink()) out.set(rel, `link:${readlinkSync(full)}`);
      else if (entry.isDirectory()) walk(full);
      else out.set(rel, readFileSync(full).toString("base64"));
    }
  };
  walk(dir);
  return out;
}

/** N's tree at `commit` with pointers resolved from the CAS. */
function resolvedTree(commit) {
  const out = new Map();
  const listing = git(N, ["ls-tree", "-r", "-z", commit]).stdout.toString("utf8").split("\0").filter(Boolean);
  for (const record of listing) {
    const tab = record.indexOf("\t");
    const [mode, , sha] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    let blob = git(N, ["cat-file", "blob", sha]).stdout;
    if (mode === "120000") {
      out.set(path, `link:${blob.toString("utf8")}`);
      continue;
    }
    const pointer = isLfsPath(path) ? parseLfsPointer(blob) : null;
    if (pointer) blob = readFileSync(casPath(pointer.oid));
    out.set(path, blob.toString("base64"));
  }
  return out;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kv-migrate-"));
  home = join(root, "home");
  mkdirSync(home);
  CAS = join(root, "cas");
  sh("git", ["lfs", "install", "--skip-repo"], { cwd: root });
  O = join(root, "kuma-brain");
  N = join(root, "new");

  // ── old repository ──
  git(root, ["init", "--quiet", "-b", "master", O]);
  for (const r of [O]) {
    git(r, ["config", "user.name", "Old Author"]);
    git(r, ["config", "user.email", "old@test.invalid"]);
  }
  write(O, "README.md", "# brain\n");
  write(O, "vault/vault.config.json", JSON.stringify({ id: "brain", profile: "docs" }));
  write(O, "vault/a.md", "# A\n\nfirst\n");
  write(O, "vault/notes/old.md", "old note\n");
  write(O, "vault/img/x.png", randomBytes(3000));
  // two files already LFS in the old layout (sub-.gitattributes + pointer + object)
  write(O, "vault/talks/_media/.gitattributes", "*.mp4 filter=lfs diff=lfs merge=lfs -text\n");
  const mp4 = randomBytes(5000);
  const mp4Oid = sha256(mp4);
  write(O, "vault/talks/_media/v.mp4", renderLfsPointer(mp4Oid, mp4.length));
  mkdirSync(join(O, ".git/lfs/objects", mp4Oid.slice(0, 2), mp4Oid.slice(2, 4)), { recursive: true });
  writeFileSync(join(O, ".git/lfs/objects", mp4Oid.slice(0, 2), mp4Oid.slice(2, 4), mp4Oid), mp4);
  git(O, ["add", "-A"]);
  git(O, ["commit", "--quiet", "-m", "c1 initial"], { env: { GIT_AUTHOR_DATE: "1696000000 +0900", GIT_COMMITTER_DATE: "1696000000 +0900" } });
  oldShas.c1 = git(O, ["rev-parse", "HEAD"]).text;
  write(O, "vault/a.md", "# A\n\nsecond\n");
  oldShas.c2 = commitAll(O, "c2 edit a", "1696000100 +0900");
  write(O, "vault/img/x.png", randomBytes(3000));
  oldShas.c3 = commitAll(O, "c3 new x.png", "1696000200 +0900");
  // references written before the cutover
  write(O, "vault/notes/ref.md", `# refs\n\nsee ${oldShas.c2.slice(0, 7)} and ${oldShas.c3.slice(0, 9)}.\nfull ${oldShas.c1}\ndate 20261003, not a sha deadbeefcafe\n`);
  // freeze: text committed (HEAD_final), binaries left in the work tree
  write(O, "vault/img/x.png", randomBytes(3100)); // modified tracked binary
  write(O, "vault/img/new.png", randomBytes(1200)); // untracked binary, touched later
  write(O, "vault/img/keep.png", randomBytes(900)); // untracked binary, never touched
  git(O, ["add", "--", "vault/notes/ref.md", "vault/a.md"]);
  git(O, ["commit", "--quiet", "-m", "vault-migrate: freeze snapshot (text only)"], { env: { GIT_AUTHOR_DATE: "1696000300 +0900", GIT_COMMITTER_DATE: "1696000300 +0900" } });
  headFinal = git(O, ["rev-parse", "HEAD"]).text;
  oldShas.final = headFinal;

  // ── rewrite into N ──
  git(root, ["init", "--quiet", "-b", "main", N]);
  git(N, ["config", "user.name", "New Author"]);
  git(N, ["config", "user.email", "new@test.invalid"]);
  const order = git(O, ["rev-list", "--reverse", "HEAD"]).text.split("\n");
  let parent = null;
  const mapLines = ["old                                      new"];
  for (const oldCommit of order) {
    parent = replayIntoN(oldCommit, parent);
    mapLines.push(`${oldCommit} ${parent}`);
    git(N, ["update-ref", `refs/replace/${oldCommit}`, parent]);
  }
  newShas.c1 = mapLines.find((l) => l.startsWith(oldShas.c1)).split(" ")[1];
  newShas.c2 = mapLines.find((l) => l.startsWith(oldShas.c2)).split(" ")[1];
  newShas.c3 = mapLines.find((l) => l.startsWith(oldShas.c3)).split(" ")[1];
  newShas.final = parent;
  mapFile = join(root, "commit-map");
  writeFileSync(mapFile, `${mapLines.join("\n")}\n`);
  git(N, ["update-ref", "refs/heads/main", parent]);
  git(N, ["reset", "--quiet", "--hard", "main"]);
  // P: the freeze-time binaries as pointers
  for (const path of ["vault/img/x.png", "vault/img/new.png", "vault/img/keep.png"]) writeLfs(N, path, readFileSync(join(O, path)));
  commitAll(N, "vault-migrate: binaries as LFS pointers (A 2, M 1, D 0)", "1696000400 +0900");
  // configuration commit (6단계)
  write(N, ".gitattributes", `${renderLfsGitattributesLines().join("\n")}\n`);
  write(N, "vault/vault.config.json", JSON.stringify({ id: "brain-main", profile: "docs", visibility: "private" }));
  commitAll(N, "vault-migrate: configuration", "1696000500 +0900");
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("vault migrate refmap", { timeout: 60_000 }, () => {
  it("dry-run classifies: old commits in the map are replaced at the same length, the rest left alone", () => {
    const out = vault(["migrate", "refmap", "--repo", N, "--map", mapFile, "--from-git-dir", join(O, ".git"), "--review-out", join(root, "review.tsv"), "--applied-out", join(root, "applied.tsv")]);
    expect(out.code, out.stderr).toBe(0);
    const report = JSON.parse(out.stdout.toString("utf8"));
    expect(report).toMatchObject({ direction: "forward", replaced: 3, replacedUnique: 3, written: false, commit: null });
    const applied = readFileSync(join(root, "applied.tsv"), "utf8");
    expect(applied).toContain(`${oldShas.c2.slice(0, 7)}\t${newShas.c2.slice(0, 7)}`);
    expect(applied).toContain(`${oldShas.c3.slice(0, 9)}\t${newShas.c3.slice(0, 9)}`);
    expect(applied).toContain(`${oldShas.c1}\t${newShas.c1}`);
    expect(readFileSync(join(N, "vault/notes/ref.md"), "utf8")).toContain(oldShas.c2.slice(0, 7));
  });

  it("other repositories and all-digit tokens go to review; detached HEAD refuses --commit", () => {
    // a dangling commit in O whose sha starts with 7 digits, written into the text
    let digits = null;
    for (let i = 0; i < 4000 && !digits; i += 1) {
      const sha = git(O, ["commit-tree", git(O, ["write-tree"]).text, "-m", `probe ${i}`]).text;
      if (/^[0-9]{7}/.test(sha)) digits = sha;
    }
    expect(digits).not.toBeNull();
    const work = join(root, "n-probe");
    git(N, ["worktree", "add", "--quiet", "--detach", work, "HEAD"]);
    write(work, "vault/notes/digits.md", `probe ${digits.slice(0, 7)}\n`);
    git(work, ["add", "vault/notes/digits.md"]);
    const prefixes = join(root, "prefixes.txt");
    writeFileSync(prefixes, `# from the mac\n${oldShas.c3.slice(0, 9)}\tkuma-studio\n`);
    const others = join(root, "others.txt");
    writeFileSync(others, `${join(O, ".git")}\n`);
    let out = vault(["migrate", "refmap", "--repo", work, "--map", mapFile, "--from-git-dir", join(O, ".git"), "--other-repo-prefixes", prefixes, "--review-out", join(root, "r2.tsv")]);
    expect(out.code, out.stderr).toBe(0);
    let report = JSON.parse(out.stdout.toString("utf8"));
    expect(report.reviewByReason).toMatchObject({ "all-digits": 1, "other-repo": 1 });
    expect(report.replaced).toBe(2);
    expect(readFileSync(join(root, "r2.tsv"), "utf8")).toContain(`${oldShas.c3.slice(0, 9)}\tother-repo:prefixes:`);
    out = vault(["migrate", "refmap", "--repo", work, "--map", mapFile, "--from-git-dir", join(O, ".git"), "--other-repos", others]);
    report = JSON.parse(out.stdout.toString("utf8"));
    expect(report.replaced).toBe(0);
    // --to-git-dir defaults to the common dir of a linked worktree; --commit refuses a detached HEAD
    out = vault(["migrate", "refmap", "--repo", work, "--map", mapFile, "--from-git-dir", join(O, ".git"), "--commit"]);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("detached HEAD");
    git(N, ["worktree", "remove", "--force", work]);
  });

  it("--commit rewrites the text and commits only those files — the cutover tip", () => {
    const before = git(O, ["for-each-ref", "--format=%(objectname) %(refname)"]).text;
    const oldIndex = readFileSync(join(O, ".git/index"));
    const out = vault(["migrate", "refmap", "--repo", N, "--map", mapFile, "--from-git-dir", join(O, ".git"), "--commit", "--map-label", "projects/x/commit-map.tsv"]);
    expect(out.code, out.stderr).toBe(0);
    const report = JSON.parse(out.stdout.toString("utf8"));
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
    tip = report.commit;
    expect(git(N, ["log", "-1", "--format=%s", tip]).text).toBe("vault-migrate: 커밋 sha 참조 갱신 (3건, 지도 projects/x/commit-map.tsv)");
    expect(git(N, ["show", "--name-only", "--format=", tip]).text).toBe("vault/notes/ref.md");
    const text = readFileSync(join(N, "vault/notes/ref.md"), "utf8");
    expect(text).toContain(newShas.c2.slice(0, 7));
    expect(text).toContain(newShas.c1);
    expect(text).toContain("20261003");
    // the source repository was only read
    expect(git(O, ["for-each-ref", "--format=%(objectname) %(refname)"]).text).toBe(before);
    expect(readFileSync(join(O, ".git/index")).equals(oldIndex)).toBe(true);
  });
});

describe("vault migrate rollback-export", { timeout: 120_000 }, () => {
  let main;

  it("post-cutover history: text, binaries, a merge, empty file, symlink, LFS mp4, layout files", () => {
    write(N, "vault/a.md", "# A\n\nafter cutover\n");
    write(N, "vault/notes/post.md", `after: ${newShas.c3.slice(0, 8)} and ${tip.slice(0, 10)}, pasted old ${oldShas.c1}\n`);
    commitAll(N, "d1 notes", "1696100000 +0900");
    const d1 = git(N, ["rev-parse", "HEAD"]).text;
    git(N, ["checkout", "--quiet", "-b", "side"]);
    write(N, "vault/b.md", "# B from the side\n");
    commitAll(N, "e1 side", "1696100050 +0900");
    git(N, ["checkout", "--quiet", "main"]);
    writeLfs(N, "vault/img/post.png", randomBytes(2000));
    writeLfs(N, "vault/img/new.png", randomBytes(1300)); // P binary changed
    writeLfs(N, "vault/img/x.png", randomBytes(3200)); // P binary (modified at freeze) changed again
    rmSync(join(N, "vault/notes/old.md"));
    commitAll(N, "d2 binaries", "1696100100 +0900");
    git(N, ["merge", "--quiet", "--no-ff", "-m", "vault-sync: merge mbp", "side"], { env: { GIT_AUTHOR_DATE: "1696100200 +0900", GIT_COMMITTER_DATE: "1696100200 +0900" } });
    write(N, "vault/img/empty.png", "");
    symlinkSync("a.md", join(N, "vault/link.md"));
    writeLfs(N, "vault/talks/_media/v.mp4", randomBytes(4000));
    write(N, ".gitattributes", `${renderLfsGitattributesLines().join("\n")}\n*.foo filter=lfs\n`);
    write(N, "vault/vault.config.json", JSON.stringify({ id: "brain-main", profile: "docs", visibility: "private", remotes: { allowed: ["http://srv/v1/stores/brain-main.git"] } }));
    commitAll(N, "d3 misc", "1696100300 +0900");
    main = git(N, ["rev-parse", "HEAD"]).text;
    expect(d1).not.toBe(main);
  });

  it("dry-run plans the replay and writes nothing", () => {
    const head = git(O, ["rev-parse", "HEAD"]).text;
    const out = vault(["migrate", "rollback-export", `${tip}..main`, "--new", N, "--old", O, "--map", mapFile, "--cas", CAS, "--dry-run"]);
    expect(out.code, out.stderr).toBe(0);
    const report = JSON.parse(out.stdout.toString("utf8"));
    expect(report).toMatchObject({ dryRun: true, replayed: 5, oldHead: headFinal });
    expect(report.skippedPaths.map((s) => s.path).sort()).toEqual([".gitattributes", "vault/vault.config.json"]);
    expect(git(O, ["rev-parse", "HEAD"]).text).toBe(head);
  });

  it("replays tip..main onto HEAD_final; the old work tree equals the new main (round trip)", () => {
    const out = vault(["migrate", "rollback-export", `${tip}..main`, "--new", N, "--old", O, "--map", mapFile, "--cas", CAS, "--old-head", headFinal]);
    expect(out.code, out.stderr).toBe(0);
    const report = JSON.parse(out.stdout.toString("utf8"));
    expect(report).toMatchObject({ replayed: 5, oldHead: headFinal });

    // history: same messages, authors, dates; first parent chain ends at HEAD_final; merge kept
    const newLog = git(N, ["log", "--topo-order", "--format=%s|%an|%ae|%ad|%cn|%cd|%P", "--date=raw", `${tip}..main`]).text.split("\n");
    const oldLog = git(O, ["log", "--topo-order", "--format=%s|%an|%ae|%ad|%cn|%cd|%P", "--date=raw", `${headFinal}..HEAD`]).text.split("\n");
    expect(oldLog.map((l) => l.split("|").slice(0, 6).join("|"))).toEqual(newLog.map((l) => l.split("|").slice(0, 6).join("|")));
    expect(oldLog.find((l) => l.startsWith("vault-sync: merge")).split("|")[6].split(" ")).toHaveLength(2);
    expect(git(O, ["rev-parse", "HEAD~4"]).text === headFinal || git(O, ["merge-base", "--is-ancestor", headFinal, "HEAD"]).code === 0).toBe(true);
    expect(git(O, ["log", "--format=%P", "--reverse", `${headFinal}..HEAD`]).text.split("\n")[0]).toBe(headFinal);
    expect(git(O, ["symbolic-ref", "HEAD"]).text).toBe("refs/heads/master");
    expect(git(O, ["fsck", "--strict"], { allowFail: true }).code).toBe(0);

    // the work tree: equal to N's main with pointers resolved, except the skipped layout files
    const expected = resolvedTree(main);
    const actual = treeFiles(O);
    // paths only the cutover's own commits (P, configuration, refmap) changed keep their
    // freeze-time state in the old layout — P's bytes are the old work tree's files already
    const freezeState = resolvedTree(newShas.final);
    const touched = new Set(git(N, ["diff", "--name-only", tip, main]).text.split("\n"));
    for (const path of git(N, ["diff", "--name-only", newShas.final, tip]).text.split("\n")) {
      if (touched.has(path) || path.endsWith(".png")) continue;
      if (freezeState.has(path)) expected.set(path, freezeState.get(path));
      else expected.delete(path);
    }
    for (const skipped of [".gitattributes", "vault/vault.config.json"]) expected.delete(skipped);
    actual.delete("vault/vault.config.json");
    expect(actual.get("vault/img/keep.png")).toBe(expected.get("vault/img/keep.png"));
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [path, content] of expected) expect([path, actual.get(path) === content]).toEqual([path, true]);
    expect(lstatSync(join(O, "vault/link.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(O, "vault/img/empty.png")).length).toBe(0);
    expect(git(O, ["rev-parse", "HEAD:vault/img/empty.png"]).text).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");

    // binaries are raw blobs in the old layout; the old LFS path keeps pointer + object
    const png = git(O, ["cat-file", "-s", "HEAD:vault/img/post.png"]).text;
    expect(Number(png)).toBe(2000);
    const mp4 = parseLfsPointer(git(O, ["cat-file", "blob", "HEAD:vault/talks/_media/v.mp4"]).stdout);
    expect(mp4).not.toBeNull();
    expect(existsSync(join(O, ".git/lfs/objects", mp4.oid.slice(0, 2), mp4.oid.slice(2, 4), mp4.oid))).toBe(true);
    // no LFS rule leaked into the old layout
    expect(existsSync(join(O, ".gitattributes"))).toBe(false);
    // only the never-touched freeze-time binary stays outside the index
    const status = git(O, ["status", "--porcelain", "--untracked-files=all"]).text;
    expect(status).toBe("?? vault/img/keep.png");
  });

  it("the reverse refmap turns post-cutover shas back into old ones; old shas pasted after the cutover stay", () => {
    const exportMap = join(O, ".git/vault-rollback-export-map.tsv");
    const out = vault(["migrate", "refmap", "--repo", O, "--map", mapFile, "--reverse", "--extra-map", exportMap, "--from-git-dir", join(N, ".git"), "--to-git-dir", join(O, ".git"), "--commit", "--review-out", join(root, "rev-review.tsv")]);
    expect(out.code, out.stderr).toBe(0);
    const report = JSON.parse(out.stdout.toString("utf8"));
    expect(report.direction).toBe("reverse");
    const post = readFileSync(join(O, "vault/notes/post.md"), "utf8");
    expect(post).toContain(`after: ${oldShas.c3.slice(0, 8)}`);
    // the tip itself is a configuration commit with no old twin: reviewed, not invented
    expect(post).toContain(tip.slice(0, 10));
    expect(readFileSync(join(root, "rev-review.tsv"), "utf8")).toContain(`${tip.slice(0, 10)}\tnot-in-map`);
    // refs/replace in N must not make an old full sha "resolve" there
    expect(post).toContain(oldShas.c1);
    expect(readFileSync(join(root, "rev-review.tsv"), "utf8")).not.toContain(oldShas.c1);
    const ref = readFileSync(join(O, "vault/notes/ref.md"), "utf8");
    expect(ref).toContain(oldShas.c2.slice(0, 7));
    expect(ref).toContain(oldShas.c1);
    expect(git(O, ["log", "-1", "--format=%s"]).text).toMatch(/^vault-migrate: 커밋 sha 참조 되돌림 \(\d+건/u);
  });

  it("refuses when the old repository moved since the cutover", () => {
    const out = vault(["migrate", "rollback-export", `${tip}..main`, "--new", N, "--old", O, "--map", mapFile, "--cas", CAS, "--old-head", headFinal]);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("moved after the cutover");
  });
});

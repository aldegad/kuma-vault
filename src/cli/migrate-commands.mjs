// `vault migrate` — moving a vault between storage layouts (docs/migrate.md).
//
//   to-remote          a local store that already keeps large files as LFS pointers moves to a
//                      server: allowlist the remote, push, register the store as remote.
//   refmap             rewrite abbreviated commit shas in the text of a tree through a commit map
//                      (after a history rewrite, or --reverse when rolling back).
//   other-repo-prefixes  list the sha-like tokens of a tree that resolve to a commit in OTHER
//                      repositories (run where those repos live; feed the file to refmap).
//   rollback-export    replay the commits made after a cutover onto the pre-cutover repository.
//
// Git is always run with GIT_NO_REPLACE_OBJECTS=1 when judging objects: a rewritten repository
// carries refs/replace/<old sha> for every old commit, which would make an old sha "resolve" in
// the new repository. A repository that must stay byte-identical (the pre-cutover source in
// refmap) is read with --no-optional-locks and read-only commands only.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { readCommitMap, reverseCommitMap } from "../engine/commit-map.mjs";
import { loadVaultDeclaration, VAULT_CONFIG_FILENAME } from "../engine/vault-config.mjs";
import { normalizeStoreEntry, updateStoreRegistry, loadStoreRegistry, findStoreByRoot } from "../engine/vault-stores.mjs";
import { isLfsPath, parseLfsPointer, renderLfsPointer } from "../server/lfs-paths.mjs";
import { credentialEntries } from "../sync/clone.mjs";
import { readOptionalString } from "./cli-options.mjs";

const USAGE = `Usage:
  vault migrate to-remote --root <tree> --server <url> [--remote-store <id>] [--remote <name>] [--token-file <path>]
  vault migrate refmap --repo <work tree> --map <commit-map> --from-git-dir <git dir> [--to-git-dir <git dir>]
        [--reverse] [--extra-map <tsv>]... [--other-repos <file>] [--other-repo-prefixes <file>]
        [--exclude <repo path>]... [--review-out <tsv>] [--applied-out <tsv>] [--write | --commit] [--map-label <text>]
  vault migrate other-repo-prefixes --repo <work tree> --other-repos <file> [--out <file>]
  vault migrate rollback-export <tip>..<main> --new <new work tree> --old <old work tree> --map <commit-map>
        [--old-head <sha>] [--cas <lfs/objects dir>] [--export-map-out <tsv>] [--dry-run]
`;

const ZERO = /^0+$/;
const MAX_BUFFER = 1024 * 1024 * 1024;

function baseEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  const merged = { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", ...extra };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  return merged;
}

/** Run git; returns stdout Buffer. `readOnly` adds --no-optional-locks. */
function git(args, { cwd, gitDir, input, env, readOnly = false, allowFail = false } = {}) {
  const full = [...(readOnly ? ["--no-optional-locks"] : []), ...(gitDir ? ["--git-dir", gitDir] : []), ...args];
  try {
    return execFileSync("git", full, { cwd, input, env: env ?? baseEnv(), maxBuffer: MAX_BUFFER, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  } catch (error) {
    if (allowFail) return null;
    const stderr = error.stderr ? error.stderr.toString("utf8").trim() : error.message;
    throw new Error(`git ${full.join(" ")}: ${stderr}`);
  }
}

const text = (buffer) => (buffer ? buffer.toString("utf8").trim() : "");

function listOption(options, key) {
  const value = options[key];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((v) => typeof v === "string" && v.trim());
}

/** parseFlags keeps the last of a repeated flag; collect every occurrence from argv instead. */
function repeated(argv, key) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${key}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`--${key}=`)) out.push(argv[i].slice(key.length + 3));
  }
  return out;
}

function workTreeOf(path) {
  const top = text(git(["rev-parse", "--show-toplevel"], { cwd: resolve(path) }));
  const common = text(git(["rev-parse", "--git-common-dir"], { cwd: top }));
  return { top, gitDir: resolve(top, common) };
}

// ── token scanning (shared by refmap and other-repo-prefixes) ────────────────

const TOKEN = /(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?![0-9A-Za-z_])/g;

/** Tracked text files of a work tree to scan/rewrite: [{ path, full }]. */
function scanTargets(top, excludes) {
  const listing = git(["ls-files", "-s", "-z"], { cwd: top }).toString("utf8").split("\0");
  const out = [];
  for (const record of listing) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (mode !== "100644" && mode !== "100755") continue;
    if (isLfsPath(path) || excludes.has(path)) continue;
    const full = join(top, path);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue; // deleted in the work tree
    }
    if (!stat.isFile()) continue;
    out.push({ path, full });
  }
  return out;
}

function scanTokens(targets) {
  const files = [];
  for (const target of targets) {
    const buffer = readFileSync(target.full);
    if (buffer.subarray(0, 8000).includes(0)) continue;
    const content = buffer.toString("utf8");
    const occurrences = [];
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(TOKEN)) occurrences.push({ line: index + 1, token: match[0] });
    });
    files.push({ ...target, content, occurrences });
  }
  return files;
}

/** cat-file --batch-check of names; returns Map<name, {sha, type} | "missing" | "ambiguous">. */
function batchCheck(gitDir, names, { readOnly = false } = {}) {
  const result = new Map();
  const list = [...names];
  for (let i = 0; i < list.length; i += 5000) {
    const chunk = list.slice(i, i + 5000);
    const lines = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { gitDir, input: `${chunk.join("\n")}\n`, readOnly })
      .toString("utf8").split("\n");
    chunk.forEach((name, k) => {
      const line = lines[k] ?? "";
      if (line.endsWith(" missing")) result.set(name, "missing");
      else if (line.endsWith(" ambiguous")) result.set(name, "ambiguous");
      else {
        const [sha, type] = line.split(" ");
        result.set(name, { sha, type });
      }
    });
  }
  return result;
}

function readGitDirList(path) {
  return readFileSync(resolve(path), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function otherRepoHits(tokens, gitDirs) {
  const hits = new Map(); // token -> git dir
  for (const dir of gitDirs) {
    const checked = batchCheck(dir, tokens, { readOnly: true });
    for (const [token, verdict] of checked) {
      if (hits.has(token)) continue;
      if (verdict === "ambiguous" || (verdict !== "missing" && verdict.type === "commit")) hits.set(token, dir);
    }
  }
  return hits;
}

// ── refmap ──────────────────────────────────────────────────────────────────

function loadMaps(options, argv) {
  const mapPath = readOptionalString(options, "map");
  if (!mapPath) throw new Error("--map <commit-map> required");
  let map = readCommitMap(resolve(mapPath));
  if (options.reverse === true) map = reverseCommitMap(map, mapPath);
  for (const extraPath of repeated(argv, "extra-map")) {
    for (const [from, to] of readCommitMap(resolve(extraPath))) {
      if (map.has(from) && map.get(from) !== to) throw new Error(`${extraPath}: ${from} maps to ${to} but ${mapPath} says ${map.get(from)}`);
      map.set(from, to);
    }
  }
  return { map, mapPath };
}

export function runRefmap(options, argv = []) {
  const repo = readOptionalString(options, "repo");
  const fromGitDir = readOptionalString(options, "from-git-dir");
  if (!repo || !fromGitDir) throw new Error("vault migrate refmap --repo <work tree> --map <commit-map> --from-git-dir <git dir>");
  const write = options.write === true || options.commit === true;
  const { top, gitDir: repoGitDir } = workTreeOf(repo);
  const toGitDir = resolve(readOptionalString(options, "to-git-dir") ?? repoGitDir);
  const { map, mapPath } = loadMaps(options, argv);

  if (options.commit === true && git(["symbolic-ref", "-q", "HEAD"], { cwd: top, allowFail: true }) === null) {
    throw new Error(`${top} is on a detached HEAD — --commit would not move a branch. Run it in a branch work tree (e.g. git worktree add <tmp> main)`);
  }

  const excludes = new Set(repeated(argv, "exclude"));
  for (const p of [mapPath, ...repeated(argv, "extra-map")]) {
    const rel = relative(top, resolve(p)).split("\\").join("/");
    if (!rel.startsWith("..")) excludes.add(rel);
  }
  const files = scanTokens(scanTargets(top, excludes));
  const tokens = new Set(files.flatMap((f) => f.occurrences.map((o) => o.token)));

  const fromVerdicts = batchCheck(resolve(fromGitDir), tokens, { readOnly: true });
  const otherDirs = readOptionalString(options, "other-repos") ? readGitDirList(options["other-repos"]) : [];
  const otherHits = otherRepoHits(tokens, otherDirs);
  const prefixFile = readOptionalString(options, "other-repo-prefixes");
  if (prefixFile) {
    for (const line of readFileSync(resolve(prefixFile), "utf8").split(/\r?\n/)) {
      const token = line.split(/\s+/)[0];
      if (/^[0-9a-f]{7,40}$/.test(token ?? "") && !otherHits.has(token)) otherHits.set(token, `prefixes:${prefixFile}`);
    }
  }

  // classify each distinct token
  const decision = new Map(); // token -> { replace } | { review } | null (not a commit reference here)
  const pending = new Map(); // token -> target full sha
  for (const token of tokens) {
    const verdict = fromVerdicts.get(token);
    if (verdict === "missing") {
      decision.set(token, null);
      continue;
    }
    if (/^[0-9]+$/.test(token)) {
      decision.set(token, { review: "all-digits" });
      continue;
    }
    if (verdict === "ambiguous") {
      decision.set(token, { review: "ambiguous-from" });
      continue;
    }
    if (verdict.type !== "commit") {
      decision.set(token, null);
      continue;
    }
    if (!map.has(verdict.sha)) {
      decision.set(token, { review: "not-in-map" });
      continue;
    }
    if (otherHits.has(token)) {
      decision.set(token, { review: `other-repo:${otherHits.get(token)}` });
      continue;
    }
    pending.set(token, map.get(verdict.sha));
  }
  // shortest unique spelling in the target repository, never shorter than the original
  let lengths = new Map([...pending].map(([token, target]) => [token, token.length]));
  while (lengths.size > 0) {
    const names = new Map([...lengths].map(([token, len]) => [token, pending.get(token).slice(0, len)]));
    const verdicts = batchCheck(toGitDir, new Set(names.values()));
    const next = new Map();
    for (const [token, len] of lengths) {
      const target = pending.get(token);
      const verdict = verdicts.get(names.get(token));
      if (verdict !== "missing" && verdict !== "ambiguous" && verdict.sha === target && verdict.type === "commit") {
        decision.set(token, { replace: names.get(token) });
      } else if (verdict === "missing") {
        decision.set(token, { review: "target-missing" });
      } else if (len >= 40) {
        decision.set(token, { review: "target-ambiguous" });
      } else {
        next.set(token, len + 1);
      }
    }
    lengths = next;
  }

  const review = [];
  const applied = [];
  const changedFiles = [];
  for (const file of files) {
    let changed = false;
    for (const occurrence of file.occurrences) {
      const d = decision.get(occurrence.token);
      if (!d) continue;
      if (d.review) review.push([file.path, occurrence.line, occurrence.token, d.review]);
      else {
        applied.push([file.path, occurrence.line, occurrence.token, d.replace]);
        changed = true;
      }
    }
    if (!changed) continue;
    changedFiles.push(file.path);
    if (write) {
      const next = file.content.replace(TOKEN, (token) => decision.get(token)?.replace ?? token);
      const temp = `${file.full}.${process.pid}.refmap`;
      writeFileSync(temp, next, "utf8");
      renameSync(temp, file.full);
    }
  }

  const writeTsv = (key, header, rows) => {
    const out = readOptionalString(options, key);
    if (out) writeFileSync(resolve(out), `${header}\n${rows.map((r) => r.join("\t")).join("\n")}${rows.length ? "\n" : ""}`, "utf8");
  };
  writeTsv("review-out", "path\tline\ttoken\treason", review);
  writeTsv("applied-out", "path\tline\told\tnew", applied);

  let commit = null;
  if (options.commit === true && changedFiles.length > 0) {
    const label = readOptionalString(options, "map-label") ?? relative(top, resolve(mapPath));
    const verb = options.reverse === true ? "되돌림" : "갱신";
    const message = `vault-migrate: 커밋 sha 참조 ${verb} (${applied.length}건, 지도 ${label})`;
    git(["add", "--", ...changedFiles], { cwd: top, env: baseEnv({ GIT_NO_REPLACE_OBJECTS: undefined }) });
    git(["commit", "-q", "-m", message, "--", ...changedFiles], { cwd: top, env: baseEnv({ GIT_NO_REPLACE_OBJECTS: undefined }) });
    commit = text(git(["rev-parse", "HEAD"], { cwd: top }));
  }

  const uniqueReplaced = new Set(applied.map((a) => a[2]));
  return {
    direction: options.reverse === true ? "reverse" : "forward",
    files: files.length,
    tokens: tokens.size,
    candidates: [...decision.values()].filter(Boolean).length,
    replaced: applied.length,
    replacedUnique: uniqueReplaced.size,
    review: review.length,
    reviewByReason: review.reduce((acc, r) => ({ ...acc, [r[3].split(":")[0]]: (acc[r[3].split(":")[0]] ?? 0) + 1 }), {}),
    changedFiles: changedFiles.length,
    written: write,
    commit,
  };
}

function commandOtherRepoPrefixes(options) {
  const repo = readOptionalString(options, "repo");
  const list = readOptionalString(options, "other-repos");
  if (!repo || !list) throw new Error("vault migrate other-repo-prefixes --repo <work tree> --other-repos <file>");
  const { top } = workTreeOf(repo);
  const tokens = new Set(scanTokens(scanTargets(top, new Set())).flatMap((f) => f.occurrences.map((o) => o.token)));
  const hits = otherRepoHits(tokens, readGitDirList(list));
  const lines = [`# tokens of ${top} that resolve to a commit (or are ambiguous) in another repository`, ...[...hits].sort().map(([token, dir]) => `${token}\t${dir}`)];
  const out = readOptionalString(options, "out");
  if (out) writeFileSync(resolve(out), `${lines.join("\n")}\n`, "utf8");
  else process.stdout.write(`${lines.join("\n")}\n`);
  process.stderr.write(`${hits.size} of ${tokens.size} token(s) resolve in another repository\n`);
}

// ── rollback-export ─────────────────────────────────────────────────────────

function parseCommitObject(raw) {
  const split = raw.indexOf(Buffer.from("\n\n"));
  const header = raw.subarray(0, split).toString("utf8");
  const message = raw.subarray(split + 2);
  const person = (key) => {
    const line = header.split("\n").find((l) => l.startsWith(`${key} `));
    const match = /^\S+ (.*) <(.*)> (\d+ [+-]\d{4})$/.exec(line ?? "");
    if (!match) throw new Error(`commit has no parsable ${key} line`);
    return { name: match[1], email: match[2], date: match[3] };
  };
  const encoding = header.split("\n").find((l) => l.startsWith("encoding "))?.slice("encoding ".length) ?? null;
  return { author: person("author"), committer: person("committer"), message, encoding };
}

function readBlob(gitDir, sha) {
  return git(["cat-file", "blob", sha], { gitDir });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** The declared tree's prefix in a repo at `commit` ("" or "vault/"), or null. */
function treePrefixAt(gitDir, commit) {
  for (const prefix of ["", "vault/"]) {
    const out = text(git(["ls-tree", "--name-only", commit, "--", `${prefix}${VAULT_CONFIG_FILENAME}`], { gitDir }));
    if (out) return prefix;
  }
  return null;
}

export function runRollbackExport(options) {
  const range = options._[0];
  const match = /^([^.]+)\.\.([^.]+)$/.exec(range ?? "");
  if (!match) throw new Error("vault migrate rollback-export <tip>..<main> --new <work tree> --old <work tree> --map <commit-map>");
  const newPath = readOptionalString(options, "new");
  const oldPath = readOptionalString(options, "old");
  const mapPath = readOptionalString(options, "map");
  if (!newPath || !oldPath || !mapPath) throw new Error("--new, --old and --map are required");
  const dryRun = options["dry-run"] === true;
  const fresh = workTreeOf(newPath);
  const old = workTreeOf(oldPath);
  const casDir = readOptionalString(options, "cas") ? resolve(options.cas) : null;
  const reverse = reverseCommitMap(readCommitMap(resolve(mapPath)), mapPath);

  const tip = text(git(["rev-parse", "--verify", `${match[1]}^{commit}`], { gitDir: fresh.gitDir }));
  const main = text(git(["rev-parse", "--verify", `${match[2]}^{commit}`], { gitDir: fresh.gitDir }));
  const currentOldHead = text(git(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: old.gitDir }));
  const oldHead = readOptionalString(options, "old-head")
    ? text(git(["rev-parse", "--verify", `${options["old-head"]}^{commit}`], { gitDir: old.gitDir }))
    : currentOldHead;
  if (currentOldHead !== oldHead) {
    throw new Error(`the old repository moved after the cutover: HEAD is ${currentOldHead}, expected ${oldHead} — refusing (nothing may be written there after step 9)`);
  }
  const prefix = treePrefixAt(fresh.gitDir, main) ?? "";
  const skipPath = (path) => path === ".gitattributes" || path.endsWith("/.gitattributes") || path === `${prefix}${VAULT_CONFIG_FILENAME}`;

  const commits = git(["rev-list", "--reverse", "--topo-order", "--parents", `${tip}..${main}`], { gitDir: fresh.gitDir })
    .toString("utf8").split("\n").filter(Boolean).map((line) => {
      const [sha, ...parents] = line.split(" ");
      return { sha, parents };
    });

  const exported = new Map();
  const skippedPaths = [];
  const lfsFetched = [];
  const isAncestorOfTip = (sha) => git(["merge-base", "--is-ancestor", sha, tip], { gitDir: fresh.gitDir, allowFail: true }) !== null;
  const mapParent = (sha) => {
    if (exported.has(sha)) return exported.get(sha);
    if (reverse.has(sha)) return reverse.get(sha);
    if (sha === tip || isAncestorOfTip(sha)) return oldHead; // P, the configuration commits: not replayed
    throw new Error(`parent ${sha} is neither in ${range}, in the commit map, nor an ancestor of the tip`);
  };

  const oldLfsDir = join(old.gitDir, "lfs", "objects");
  const lfsBytes = (pointer, path, commit) => {
    const candidates = [casDir, join(fresh.gitDir, "lfs", "objects")].filter(Boolean);
    const locate = () => candidates.map((dir) => join(dir, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid)).find((p) => existsSync(p));
    let found = locate();
    if (!found && !casDir) {
      git(["lfs", "fetch", "-I", path, "-X", "", "origin", commit], { cwd: fresh.top, env: baseEnv({ GIT_NO_REPLACE_OBJECTS: undefined }) });
      lfsFetched.push(path);
      found = locate();
    }
    if (!found) throw new Error(`LFS object ${pointer.oid} (${path} in ${commit}) is not available${casDir ? ` in ${casDir}` : ""}`);
    const bytes = readFileSync(found);
    if (bytes.length !== pointer.size || sha256(bytes) !== pointer.oid) throw new Error(`LFS object ${pointer.oid} (${path}) does not match its pointer`);
    return bytes;
  };
  const oldUsesLfs = (path) => /: filter: lfs$/m.test(text(git(["check-attr", "filter", "--", path], { cwd: old.top })));
  const storeInOld = (bytes) => text(git(["hash-object", "-w", "--no-filters", "--stdin"], { gitDir: old.gitDir, input: bytes }));

  const plan = [];
  const tempIndex = join(old.gitDir, `vault-rollback-export.${process.pid}.index`);
  try {
    for (const commit of commits) {
      const parents = [...new Set(commit.parents.map(mapParent))];
      const changes = git(["diff-tree", "-r", "-z", "--no-renames", "--raw", commit.parents[0], commit.sha], { gitDir: fresh.gitDir })
        .toString("utf8").split("\0");
      const lines = [];
      for (let i = 0; i < changes.length; i += 1) {
        if (!changes[i].startsWith(":")) continue;
        const [, newMode, , newSha] = changes[i].slice(1).split(" ");
        const path = changes[i + 1];
        i += 1;
        if (skipPath(path)) {
          skippedPaths.push({ commit: commit.sha, path });
          continue;
        }
        if (dryRun) continue;
        if (ZERO.test(newSha)) {
          lines.push(`0 ${"0".repeat(40)}\t${path}`);
          continue;
        }
        if (newMode === "160000") {
          lines.push(`${newMode} ${newSha}\t${path}`);
          continue;
        }
        let blob = readBlob(fresh.gitDir, newSha);
        if (newMode !== "120000" && isLfsPath(path) && blob.length > 0) {
          const pointer = parseLfsPointer(blob);
          if (pointer) {
            const bytes = lfsBytes(pointer, path, commit.sha);
            if (oldUsesLfs(path)) {
              const target = join(oldLfsDir, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
              if (!existsSync(target)) {
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, bytes);
              }
              blob = Buffer.from(renderLfsPointer(pointer.oid, pointer.size));
            } else {
              blob = bytes;
            }
          }
        }
        lines.push(`${newMode} ${storeInOld(blob)}\t${path}`);
      }
      if (dryRun) {
        plan.push({ sha: commit.sha, parents });
        exported.set(commit.sha, `(replay of ${commit.sha.slice(0, 9)})`);
        continue;
      }
      const env = baseEnv({ GIT_INDEX_FILE: tempIndex });
      git(["read-tree", parents[0]], { gitDir: old.gitDir, env });
      if (lines.length > 0) git(["update-index", "-z", "--index-info"], { gitDir: old.gitDir, env, input: `${lines.join("\0")}\0` });
      const tree = text(git(["write-tree"], { gitDir: old.gitDir, env }));
      const meta = parseCommitObject(git(["cat-file", "commit", commit.sha], { gitDir: fresh.gitDir }));
      const commitEnv = baseEnv({
        GIT_AUTHOR_NAME: meta.author.name,
        GIT_AUTHOR_EMAIL: meta.author.email,
        GIT_AUTHOR_DATE: meta.author.date,
        GIT_COMMITTER_NAME: meta.committer.name,
        GIT_COMMITTER_EMAIL: meta.committer.email,
        GIT_COMMITTER_DATE: meta.committer.date,
      });
      const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])];
      const encodingArgs = meta.encoding ? ["-c", `i18n.commitEncoding=${meta.encoding}`] : [];
      const replayed = text(git([...encodingArgs, ...args], { gitDir: old.gitDir, env: commitEnv, input: meta.message }));
      exported.set(commit.sha, replayed);
    }
  } finally {
    rmSync(tempIndex, { force: true });
  }

  const report = {
    range: `${tip}..${main}`,
    oldHead,
    replayed: dryRun ? plan.length : exported.size,
    skippedPaths,
    lfsFetched,
    dryRun,
  };
  if (dryRun) return { ...report, plan };
  if (commits.length === 0) return { ...report, head: oldHead, changedPaths: 0 };

  const newHead = exported.get(main);
  const exportMapOut = resolve(readOptionalString(options, "export-map-out") ?? join(old.gitDir, "vault-rollback-export-map.tsv"));
  writeFileSync(exportMapOut, `old new\n${[...exported].map(([n, o]) => `${n} ${o}`).join("\n")}\n`, "utf8");
  // the new-repo sha is the left column: refmap --extra-map takes it as from -> to as written

  // Move the branch (compare-and-swap on the HEAD we started from), then the index (two-tree
  // merge keeps stat data of untouched entries), then exactly the paths the replay changed.
  git(["update-ref", "-m", `vault-migrate: rollback-export ${tip.slice(0, 9)}..${main.slice(0, 9)}`, "HEAD", newHead, oldHead], { gitDir: old.gitDir });
  // -i: the work tree is not consulted — freeze-time binaries are dirty there on purpose, and
  // the paths the replay changed are rewritten below anyway
  git(["read-tree", "-m", "-i", oldHead, newHead], { cwd: old.top });
  const touched = new Set(
    git(["diff-tree", "-r", "-z", "--no-renames", "--name-only", tip, main], { gitDir: fresh.gitDir })
      .toString("utf8").split("\0").filter(Boolean).filter((p) => !skipPath(p)),
  );
  const finalEntries = new Map();
  if (touched.size > 0) {
    const listing = git(["ls-tree", "-r", "-z", "--full-tree", newHead, "--", ...touched], { gitDir: old.gitDir }).toString("utf8").split("\0");
    for (const record of listing) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [mode, , sha] = record.slice(0, tab).split(" ");
      finalEntries.set(record.slice(tab + 1), { mode, sha });
    }
  }
  for (const path of touched) {
    const full = join(old.top, path);
    const entry = finalEntries.get(path);
    if (existsSync(full) || isSymlink(full)) {
      if (lstatSync(full).isDirectory()) rmSync(full, { recursive: true });
      else unlinkSync(full);
    }
    if (!entry || entry.mode === "160000") continue;
    mkdirSync(dirname(full), { recursive: true });
    let bytes = readBlob(old.gitDir, entry.sha);
    if (entry.mode === "120000") {
      symlinkSync(bytes.toString("utf8"), full);
      continue;
    }
    const pointer = isLfsPath(path) ? parseLfsPointer(bytes) : null;
    if (pointer) bytes = readFileSync(join(oldLfsDir, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid));
    writeFileSync(full, bytes);
    if (entry.mode === "100755") chmodSync(full, 0o755);
  }
  git(["update-index", "-q", "--refresh"], { cwd: old.top, allowFail: true });
  return { ...report, head: newHead, exportMap: exportMapOut, changedPaths: touched.size };
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// ── to-remote ───────────────────────────────────────────────────────────────

function tokenEnv(tokenFile) {
  if (!tokenFile) return {};
  const raw = readFileSync(resolve(tokenFile), "utf8").trim();
  const token = raw.startsWith("{") ? JSON.parse(raw).token : raw;
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` };
}

export function runToRemote(options) {
  const root = readOptionalString(options, "root");
  const server = readOptionalString(options, "server");
  if (!root || !server) throw new Error("vault migrate to-remote --root <tree> --server <url> [--remote-store <id>]");
  const treeDir = resolve(root);
  const declaration = loadVaultDeclaration(treeDir);
  if (!declaration?.id) throw new Error(`${treeDir} has no vault.config.json with an id`);
  const remoteStore = readOptionalString(options, "remote-store") ?? declaration.id;
  const remoteName = readOptionalString(options, "remote") ?? "origin";
  const tokenFile = readOptionalString(options, "token-file");
  const entry = normalizeStoreEntry(declaration.id, { root: treeDir, mode: "remote", remote: { server, store: remoteStore, ...(tokenFile ? { tokenFile: resolve(tokenFile) } : {}) } });
  const url = `${entry.remote.server}/v1/stores/${remoteStore}.git`;
  const { top, gitDir } = workTreeOf(treeDir);
  const env = baseEnv({ GIT_NO_REPLACE_OBJECTS: undefined });
  if (git(["lfs", "version"], { cwd: top, allowFail: true, env }) === null) throw new Error("git-lfs is not installed");

  // Every large-file path in history must already be a pointer: the server refuses anything else
  // (receive rule 3) on every pushed commit. A store with raw binaries in history needs the
  // history rewrite, not this command.
  const objects = git(["rev-list", "--objects", "--all"], { cwd: top, env }).toString("utf8").split("\n").filter(Boolean);
  const lfsBlobs = objects.map((line) => {
    const space = line.indexOf(" ");
    return space < 0 ? null : { sha: line.slice(0, space), path: line.slice(space + 1) };
  }).filter((o) => o && isLfsPath(o.path));
  if (lfsBlobs.length > 0) {
    const sizes = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { cwd: top, env, input: `${lfsBlobs.map((b) => b.sha).join("\n")}\n` })
      .toString("utf8").split("\n");
    const raw = [];
    lfsBlobs.forEach((blob, i) => {
      const [, type, size] = (sizes[i] ?? "").split(" ");
      if (type !== "blob" || Number(size) === 0) return;
      if (Number(size) > 1024 || !parseLfsPointer(readBlob(gitDir, blob.sha))) raw.push(blob.path);
    });
    if (raw.length > 0) {
      throw new Error(`history holds ${raw.length} large file(s) as raw bytes, not LFS pointers (e.g. ${raw.slice(0, 3).join(", ")}) — this store needs the history rewrite before it can move to a server`);
    }
  }

  const existing = git(["remote", "get-url", remoteName], { cwd: top, allowFail: true, env });
  if (existing && text(existing) !== url) throw new Error(`remote ${remoteName} already points at ${text(existing)} — choose another --remote name`);

  // 1. policy: private + allowlist, committed (the pre-push hook reads it)
  const configPath = join(treeDir, VAULT_CONFIG_FILENAME);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const allowed = new Set(config.remotes?.allowed ?? []);
  let configCommit = null;
  if (config.visibility !== "private" || !allowed.has(url)) {
    config.visibility = "private";
    config.remotes = { ...(config.remotes ?? {}), allowed: [...allowed, ...(allowed.has(url) ? [] : [url])] };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    loadVaultDeclaration(treeDir);
    const rel = relative(top, configPath);
    git(["add", "--", rel], { cwd: top, env });
    git(["commit", "-q", "-m", `vault-migrate: allow remote ${url}`, "--", rel], { cwd: top, env });
    configCommit = text(git(["rev-parse", "HEAD"], { cwd: top, env }));
  }
  // 2. remote + hooks (pre-commit gate, pre-push allowlist + git-lfs upload)
  if (!existing) git(["remote", "add", remoteName, url], { cwd: top, env });
  git(["config", `lfs.${url}/info/lfs.locksverify`, "false"], { cwd: top, env });
  if (tokenFile) {
    // the sync daemon, git-lfs and remote search use the same credential `vault clone` sets up
    const raw = readFileSync(resolve(tokenFile), "utf8").trim();
    const token = raw.startsWith("{") ? JSON.parse(raw).token : raw;
    const privateDir = join(gitDir, "kuma-vault");
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    chmodSync(privateDir, 0o700);
    writeFileSync(join(privateDir, "token"), `${token}\n`, { mode: 0o600 });
    chmodSync(join(privateDir, "token"), 0o600);
    const entries = credentialEntries(new URL(url).origin, join(privateDir, "token"));
    git(["config", "--local", "--unset-all", entries[0][0]], { cwd: top, env, allowFail: true });
    for (const [key, value] of entries) git(["config", "--local", "--add", key, value], { cwd: top, env });
    entry.remote.tokenFile = join(privateDir, "token");
  }
  const vaultBin = resolve(new URL("../../bin/vault", import.meta.url).pathname);
  // the hooks resolve `vault` at run time; when this shell has none on PATH, pin this one
  const onPath = spawnSync("sh", ["-c", "command -v vault"], { stdio: ["ignore", "pipe", "ignore"] }).status === 0;
  execFileSync(vaultBin, ["hook", "install", "--root", treeDir, ...(onPath ? [] : ["--bin", vaultBin])], { stdio: ["ignore", "pipe", "pipe"] });
  // 3. push
  const branch = text(git(["symbolic-ref", "--short", "HEAD"], { cwd: top, env }));
  git(["push", remoteName, `${branch}:refs/heads/main`], { cwd: top, env: { ...env, ...tokenEnv(tokenFile) } });
  // 4. register as remote
  const registry = loadStoreRegistry();
  updateStoreRegistry((doc) => {
    const id = findStoreByRoot(registry, treeDir)?.id ?? declaration.id;
    doc.stores[id] = { ...(doc.stores[id] ?? {}), ...entry };
    return doc;
  });
  return { store: declaration.id, url, remote: remoteName, configCommit, pushed: text(git(["rev-parse", "HEAD"], { cwd: top, env })) };
}

export async function commandVaultMigrate(options, argv = []) {
  const [verb, ...rest] = options._;
  const sub = { ...options, _: rest };
  switch (verb) {
    case "refmap":
      process.stdout.write(`${JSON.stringify(runRefmap(sub, argv), null, 2)}\n`);
      return;
    case "other-repo-prefixes":
      commandOtherRepoPrefixes(sub);
      return;
    case "rollback-export":
      process.stdout.write(`${JSON.stringify(runRollbackExport(sub), null, 2)}\n`);
      return;
    case "to-remote":
      process.stdout.write(`${JSON.stringify(runToRemote(sub), null, 2)}\n`);
      return;
    default:
      process.stdout.write(USAGE);
      process.exitCode = verb ? 1 : 0;
  }
}

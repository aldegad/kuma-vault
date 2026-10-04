// Server receive rules — `origin.git/hooks/pre-receive` -> `vault server receive-check`
// (docs/server.md). Seven rules over the refs and the paths the pushed commits
// change. Every new commit is checked (not only the tip): a blob that lands in history stays
// in history, so an intermediate commit cannot smuggle what the tip later deletes.
//
//   1 refs/heads/main only, no deletes, fast-forward only; refs/replace/* only with an admin token
//   2 every client can check the paths out (checkout-paths.mjs): UTF-8, code points macOS knows,
//     NFC, no two paths of one tree with one caseKey (full case folding), no empty, `.`, `..` or
//     `.git` component, no symlinked `.gitmodules`, components <= NAME_MAX_BYTES, paths <=
//     PATH_MAX_BYTES, symlink targets <= CHECKOUT_LINK_TARGET_MAX_BYTES
//   3 LFS-extension paths (lower-case compare) hold a canonical pointer whose object is in the
//     CAS with the same size; an empty blob passes (git-lfs does not turn empty files into pointers)
//   4 non-pointer blobs <= maxNonLfsBlobBytes (32MiB); above warnNonLfsBlobBytes is accepted with a log warning.
//     Every object the push brings is held to the same cap, so an object no path names (a
//     gitlink target, an unreferenced object in a hand-made pack) cannot slip past it
//   5 the data volume keeps diskReserveGB free
//   6 no `.fts/`, lock or temp paths (server.json junkPatterns, default DEFAULT_JUNK_PATTERNS)
//   7 no binaries in `binaries.reject` places — read from server.json, never from the pushed tree
//
// Path patterns of rules 6 and 7 match case-insensitively: a macOS clone (core.ignorecase=true)
// ignores `Work/` and `work/` alike, so the server must refuse both.
//
// Rules 3, 4 and 7 cover every entry that carries a blob — regular files and symlinks alike;
// only gitlinks (no blob) are left out. A symlink's blob is its link target: git-lfs never
// turns a symlink into a pointer, so a symlink passes rule 3 at an LFS path only while it is a
// link target (1..LINK_TARGET_MAX_BYTES bytes, no NUL). Anything else in a symlink is refused
// under the rule its path falls in (3 at an LFS path, 7 in a reject place, 4 elsewhere). A link
// target longer than a macOS checkout can write is refused by rule 2.

import { existsSync, statSync, statfsSync, appendFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { CHECKOUT_LINK_TARGET_MAX_BYTES, caseKey, checkoutPathProblems, decodePath, isDotGitmodules } from "./checkout-paths.mjs";
import { compileGitignore } from "./gitignore-match.mjs";
import { DEFAULT_JUNK_PATTERNS, isLfsPath, parseLfsPointer, LFS_POINTER_MAX_BYTES } from "./lfs-paths.mjs";
import { casObjectPath, runGit, storePaths } from "./store-layout.mjs";

const ZERO = /^0+$/;
const GITLINK_MODE = "160000";
const SYMLINK_MODE = "120000";
const LINK_TARGET_MAX_BYTES = 4096; // PATH_MAX on Linux: longer is never a link target
const MiB = 1024 * 1024;

const carriesBlob = (entry) => entry.newMode !== GITLINK_MODE;

function hookGitEnv() {
  // Keep the hook's repository + quarantine context (GIT_DIR, GIT_QUARANTINE_PATH, alternates)
  // but never let replace refs swap the objects we are judging.
  return { ...process.env, LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1" };
}

export function parseRefUpdates(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [oldSha, newSha, ref] = line.split(" ");
      return { oldSha, newSha, ref };
    });
}

function formatGB(bytes) {
  return (bytes / 1e9).toFixed(1);
}

export function diskFreeBytes(path) {
  const st = statfsSync(path);
  return Number(st.bavail) * Number(st.bsize);
}

async function listNewCommits(gitDir, tips, env) {
  if (tips.length === 0) return [];
  const { stdout } = await runGit(
    ["--git-dir", gitDir, "rev-list", "--reverse", "--topo-order", "--parents", ...tips, "--not", "--all"],
    { env },
  );
  return stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit, ...parents] = line.split(" ");
      return { commit, firstParent: parents[0] ?? null };
    });
}

/** Split git's `-z` output into its NUL-terminated byte fields (paths are bytes, not UTF-8). */
function nulFields(buffer) {
  const fields = [];
  let start = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(0, start);
    if (end < 0) end = buffer.length;
    fields.push(buffer.subarray(start, end));
    start = end + 1;
  }
  return fields;
}

/** Changed paths of each commit against its first parent (root commits against the empty tree). */
async function diffCommits(gitDir, commits, env) {
  if (commits.length === 0) return new Map();
  const input = commits.map((c) => (c.firstParent ? `${c.commit} ${c.firstParent}` : c.commit)).join("\n") + "\n";
  const { stdout } = await runGit(
    ["--git-dir", gitDir, "diff-tree", "--stdin", "-r", "-z", "--raw", "--no-renames", "--root"],
    { env, input },
  );
  const fields = nulFields(stdout);
  const byCommit = new Map(commits.map((c) => [c.commit, []]));
  let current = null;
  for (let i = 0; i < fields.length; i += 1) {
    if (fields[i].length === 0) continue;
    const token = fields[i].toString("latin1");
    if (token.startsWith(":")) {
      const [oldMode, newMode, oldSha, newSha, status] = token.slice(1).split(" ");
      const { path, utf8 } = decodePath(fields[i + 1] ?? Buffer.alloc(0));
      i += 1;
      if (current) current.push({ oldMode, newMode, oldSha, newSha, status, path, utf8 });
      continue;
    }
    const commit = token.trim().split(/\s+/)[0];
    current = byCommit.get(commit) ?? null;
  }
  return byCommit;
}

async function batchCheck(gitDir, shas, env) {
  const info = new Map();
  if (shas.length === 0) return info;
  const { stdout } = await runGit(
    ["--git-dir", gitDir, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { env, input: `${shas.join("\n")}\n` },
  );
  for (const line of stdout.toString("utf8").split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (sha && type !== "missing") info.set(sha, { type, size: Number(size) });
  }
  return info;
}

async function batchContents(gitDir, shas, env) {
  const contents = new Map();
  if (shas.length === 0) return contents;
  const { stdout } = await runGit(["--git-dir", gitDir, "cat-file", "--batch"], { env, input: `${shas.join("\n")}\n` });
  let offset = 0;
  while (offset < stdout.length) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline < 0) break;
    const [sha, type, size] = stdout.subarray(offset, newline).toString("utf8").split(" ");
    if (type === "missing") {
      offset = newline + 1;
      continue;
    }
    const length = Number(size);
    contents.set(sha, stdout.subarray(newline + 1, newline + 1 + length));
    offset = newline + 1 + length + 1;
  }
  return contents;
}

async function caseCollisions(gitDir, commit, addedPaths, env) {
  const { stdout } = await runGit(["--git-dir", gitDir, "ls-tree", "-r", "-t", "-z", "--name-only", commit], { env });
  const byKey = new Map();
  for (const field of nulFields(stdout)) {
    if (field.length === 0) continue;
    const { path } = decodePath(field);
    const key = caseKey(path);
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(path);
  }
  const collisions = [];
  for (const path of addedPaths) {
    const parts = path.split("/");
    for (let k = 1; k <= parts.length; k += 1) {
      const names = byKey.get(caseKey(parts.slice(0, k).join("/")));
      if (names && names.size > 1) collisions.push([...names].sort());
    }
  }
  return collisions;
}

function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function isLinkTarget(size, content) {
  return size > 0 && size <= LINK_TARGET_MAX_BYTES && content !== undefined && !content.includes(0);
}

/**
 * Objects the push brought that exceed `maxBytes`, from the receive quarantine only
 * (GIT_QUARANTINE_PATH). Objects the store already had (thin-pack bases index-pack appended)
 * are left out. Without a quarantine (not run by receive-pack) there is nothing to list.
 */
async function oversizedIncomingObjects(gitDir, env, maxBytes) {
  const quarantine = env.GIT_QUARANTINE_PATH;
  if (!quarantine) return [];
  const only = (objectDir) => {
    const scoped = { ...env, GIT_OBJECT_DIRECTORY: objectDir };
    delete scoped.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    return scoped;
  };
  const { stdout } = await runGit(
    ["--git-dir", gitDir, "cat-file", "--batch-all-objects", "--unordered", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { env: only(quarantine) },
  );
  const oversized = [];
  for (const line of stdout.toString("utf8").split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (sha && Number(size) > maxBytes) oversized.push({ sha, type, size: Number(size) });
  }
  const fresh = [];
  for (const object of oversized) {
    const { code } = await runGit(["--git-dir", gitDir, "cat-file", "-e", object.sha], {
      env: only(resolve(gitDir, "objects")),
      allowFail: true,
    });
    if (code !== 0) fresh.push(object);
  }
  return fresh;
}

/**
 * Judge one push. Returns `{ violations: [{rule, message, path?}], warnings: [...] }`.
 * `diskFree` is injectable for tests (bytes).
 */
export async function checkReceive({ config, storeId, role, gitDir, updates, env = hookGitEnv(), diskFree }) {
  const store = config.stores[storeId];
  const paths = storePaths(store.path);
  const violations = [];
  const warnings = [];
  const add = (rule, message, path) => violations.push({ rule, message, ...(path ? { path } : {}) });

  // Rule 1 — refs.
  for (const { oldSha, newSha, ref } of updates) {
    const deleting = ZERO.test(newSha);
    if (ref === "refs/heads/main") {
      if (deleting) add(1, `지우기는 받지 않습니다: ${ref}`);
      else if (!ZERO.test(oldSha)) {
        const { code } = await runGit(["--git-dir", gitDir, "merge-base", "--is-ancestor", oldSha, newSha], { env, allowFail: true });
        if (code !== 0) add(1, `fast-forward 만 받습니다: ${ref} — 먼저 fetch 해서 합친 뒤 push 하세요`);
      }
    } else if (ref.startsWith("refs/replace/")) {
      if (role !== "admin") add(1, `refs/replace/* 는 컷오버 관리자 토큰으로만 받습니다: ${ref}`);
      else if (deleting) add(1, `지우기는 받지 않습니다: ${ref}`);
    } else {
      add(1, `main 만 받습니다: ${ref}`);
    }
  }

  const tips = [...new Set(updates.filter((u) => !ZERO.test(u.newSha)).map((u) => u.newSha))];

  // Rule 5 — disk reserve (any push that brings something).
  if (tips.length > 0) {
    const free = diskFree ?? diskFreeBytes(paths.root);
    if (free < config.diskReserveGB * 1e9) add(5, `서버 디스크 부족(여유 ${formatGB(free)}GB, 예비 ${config.diskReserveGB}GB)`);
  }

  const commits = await listNewCommits(gitDir, tips, env);
  const diffs = await diffCommits(gitDir, commits, env);

  const junk = compileGitignore(config.junkPatterns ?? DEFAULT_JUNK_PATTERNS, { ignoreCase: true });
  const reject = compileGitignore(store.binaries.reject, { ignoreCase: true });
  const seen = new Set();
  const entries = [];
  for (const { commit } of commits) {
    const added = [];
    for (const entry of diffs.get(commit) ?? []) {
      if (ZERO.test(entry.newSha)) continue; // deletion
      if (entry.status === "A") added.push(entry.path);
      const key = `${entry.path}\0${entry.newSha}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
    if (added.length > 0) {
      for (const names of await caseCollisions(gitDir, commit, added, env)) {
        const message = `대소문자만 다른 경로(macOS 에서 한 파일): ${names.join(", ")}`;
        if (!violations.some((v) => v.message === message)) add(2, message, names[0]);
      }
    }
  }

  const reported = new Set();
  const once = (rule, message, path) => {
    const key = `${rule}\0${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    add(rule, message, path);
  };

  const blobShas = [...new Set(entries.filter(carriesBlob).map((e) => e.newSha))];
  const info = await batchCheck(gitDir, blobShas, env);
  const needContent = new Set();
  for (const entry of entries) {
    if (!carriesBlob(entry)) continue;
    const size = info.get(entry.newSha)?.size ?? 0;
    if (entry.newMode === SYMLINK_MODE) {
      if (size > 0 && size <= LINK_TARGET_MAX_BYTES) needContent.add(entry.newSha);
      continue;
    }
    if (isLfsPath(entry.path) && size > 0 && size <= LFS_POINTER_MAX_BYTES) needContent.add(entry.newSha);
    if (!isLfsPath(entry.path) && reject(entry.path)) needContent.add(entry.newSha);
  }
  const contents = await batchContents(gitDir, [...needContent], env);

  for (const entry of entries) {
    const { path } = entry;
    for (const message of checkoutPathProblems(path, entry.utf8)) once(2, message, path);
    const junkRule = junk(path);
    if (junkRule) once(6, `잠금·임시 파일은 올리지 않습니다: ${path} (${junkRule})`, path);
    if (!carriesBlob(entry)) continue;

    const object = info.get(entry.newSha);
    if (object === undefined || object.type !== "blob") {
      once(3, `blob 을 읽지 못했습니다: ${path} (${entry.newSha}${object ? `, ${object.type}` : ""})`, path);
      continue;
    }
    const { size } = object;
    const lfs = isLfsPath(path);
    const rejectRule = reject(path);

    if (entry.newMode === SYMLINK_MODE) {
      if (!isLinkTarget(size, contents.get(entry.newSha))) {
        const rule = lfs ? 3 : rejectRule ? 7 : 4;
        once(rule, `링크 대상이 아닌 심링크: ${path} (${size}B) — 심링크는 ${LINK_TARGET_MAX_BYTES}B 이하, NUL 없는 경로만 받습니다`, path);
        continue;
      }
      if (isDotGitmodules(path)) once(2, `심링크인 .gitmodules 는 체크아웃되지 않습니다: ${path}`, path);
      if (size > CHECKOUT_LINK_TARGET_MAX_BYTES) {
        once(2, `체크아웃 못 하는 심링크: ${path} — 대상이 ${size}B, ${CHECKOUT_LINK_TARGET_MAX_BYTES}B 이하만 받습니다(macOS 상한)`, path);
      }
      if (rejectRule && lfs) {
        once(7, `중간물 자리입니다: ${path} (${rejectRule}) — 볼트 밖에 두세요`, path);
      }
      continue;
    }

    if (rejectRule && (lfs || looksBinary(contents.get(entry.newSha) ?? Buffer.alloc(0)))) {
      once(7, `중간물 자리입니다: ${path} (${rejectRule}) — 볼트 밖에 두세요`, path);
    }

    if (lfs) {
      if (size === 0) continue; // empty files stay empty blobs
      const pointer = size <= LFS_POINTER_MAX_BYTES ? parseLfsPointer(contents.get(entry.newSha)) : null;
      if (!pointer) {
        once(3, `LFS 포인터가 아닙니다: ${path} (${size}B) — git lfs 가 설치된 클론에서 커밋하세요(.gitattributes)`, path);
        continue;
      }
      const casPath = casObjectPath(paths.lfsObjects, pointer.oid);
      let casSize = null;
      try {
        casSize = statSync(casPath).size;
      } catch {
        casSize = null;
      }
      if (casSize === null) once(3, `LFS 객체 없음: ${pointer.oid} (${path}) — git lfs push 가 먼저 돌아야 합니다`, path);
      else if (casSize !== pointer.size) once(3, `LFS 포인터 크기가 객체와 다릅니다: ${path} (포인터 ${pointer.size}B, 객체 ${casSize}B)`, path);
      continue;
    }

    if (size > config.maxNonLfsBlobBytes) {
      once(4, `${Math.round(config.maxNonLfsBlobBytes / MiB)}MiB 넘는 일반 blob: ${path} (${size}B) — .gitattributes 에 확장자를 더하세요`, path);
    } else if (size > config.warnNonLfsBlobBytes) {
      warnings.push({ rule: 4, message: `큰 일반 blob(받음): ${path} (${size}B)`, path, size });
    }
  }

  // Rule 4 over every object the push brings, named by a path or not.
  if (tips.length > 0) {
    const named = new Set(entries.filter(carriesBlob).map((e) => e.newSha)); // a gitlink's sha names no blob
    for (const { sha, type, size } of await oversizedIncomingObjects(gitDir, env, config.maxNonLfsBlobBytes)) {
      if (named.has(sha)) continue; // already judged with its path above
      once(4, `${Math.round(config.maxNonLfsBlobBytes / MiB)}MiB 넘는 객체(경로 없음): ${type} ${sha} (${size}B) — 커밋 트리의 파일로만 올리세요`);
    }
  }

  return { violations, warnings, commits: commits.length };
}

/** Resolve which store a hook runs for: serve passes it; a direct local push derives it from GIT_DIR. */
export function resolveHookStore(config, env, cwd) {
  const gitDir = resolve(env.GIT_DIR ? resolve(cwd, env.GIT_DIR) : cwd);
  if (env.KUMA_VAULT_STORE) {
    const store = config.stores[env.KUMA_VAULT_STORE];
    if (!store) throw new Error(`unknown store ${env.KUMA_VAULT_STORE}`);
    return { storeId: env.KUMA_VAULT_STORE, gitDir };
  }
  const id = basename(dirname(gitDir));
  const store = config.stores[id];
  if (!store || resolve(store.path, "origin.git") !== gitDir) {
    throw new Error(`push to ${gitDir} is not a store in server.json`);
  }
  return { storeId: id, gitDir };
}

export function appendReceiveLog(storeRoot, record) {
  const paths = storePaths(storeRoot);
  try {
    if (existsSync(paths.state)) appendFileSync(paths.receiveLog, `${JSON.stringify(record)}\n`);
  } catch {
    // the log is diagnostics only; the verdict already went to the pusher
  }
}

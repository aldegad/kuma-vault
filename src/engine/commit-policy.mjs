// Commit policy of a vault tree — the part of the pre-commit gate (`vault sync --check`) that
// judges what is being COMMITTED, not what is derived:
//
//   freeze   `~/.kuma/vault-freeze.json` exists → every commit is refused, except the one whose
//            environment carries `KUMA_VAULT_FREEZE_ID` equal to the file's `id` (the cutover's
//            own freeze commit). A freeze file may name one `store` (declared id); without it,
//            every vault tree on the machine is frozen. An unreadable freeze file refuses.
//   reject   a staged binary (LFS extension, or NUL in its first 8000 bytes) inside a
//            `binaries.reject` place (gitignore syntax, tree-relative) — intermediates belong
//            outside the vault. The server refuses the same push (receive rule 7).
//   size     a staged non-LFS-extension file over 32MiB — the server would refuse the push
//            (receive rule 4) and every later commit would queue behind it.
//
// `reject` and `size` apply to trees whose declaration carries a `binaries` block (the storage
// policy a remote-capable vault declares); a generic docs tree is not held to them. The same
// verdict function serves hosts that write binaries into a vault (Studio routes).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

import { compileGitignore } from "../server/gitignore-match.mjs";
import { isLfsPath } from "../server/lfs-paths.mjs";

export const MAX_NON_LFS_BYTES = 32 * 1024 * 1024;
const MiB = 1024 * 1024;

export function resolveFreezeFile(env = process.env) {
  if (env.KUMA_VAULT_FREEZE_FILE) return resolve(env.KUMA_VAULT_FREEZE_FILE);
  const home = env.HOME ?? homedir();
  return join(resolve(env.KUMA_HOME_DIR ?? join(home, ".kuma")), "vault-freeze.json");
}

/** Freeze verdict for a commit to the tree declaring `storeId`. Returns null (allowed) or a violation. */
export function checkFreeze({ storeId = null, env = process.env } = {}) {
  const path = resolveFreezeFile(env);
  if (!existsSync(path)) return null;
  let freeze;
  try {
    freeze = JSON.parse(readFileSync(path, "utf8"));
    if (!freeze || typeof freeze.id !== "string" || !freeze.id) throw new Error("no id");
  } catch (error) {
    return { rule: "freeze", message: `볼트 동결 파일을 읽을 수 없어 커밋을 받지 않습니다: ${path} (${error.message})` };
  }
  if (typeof freeze.store === "string" && freeze.store && storeId && freeze.store !== storeId) return null;
  if (env.KUMA_VAULT_FREEZE_ID && env.KUMA_VAULT_FREEZE_ID === freeze.id) return null;
  const why = [freeze.reason, freeze.plan, freeze.since ? `since ${freeze.since}` : null].filter(Boolean).join(", ");
  return { rule: "freeze", message: `볼트 동결 중이라 커밋을 받지 않습니다(${why || freeze.id}). 동결 해제를 기다리세요 — ${path}` };
}

function looksBinary(head) {
  return Boolean(head) && head.subarray(0, 8000).includes(0);
}

/**
 * Verdict for writing/committing one file into a tree. `path` is tree-relative; `head` is the
 * first bytes of the content (enough for the NUL test), `size` its length. Returns null or
 * `{ rule, message }`. A declaration without `binaries` is not judged.
 */
export function judgeBinaryWrite({ path, size, head, declaration }) {
  if (!declaration?.binaries) return null;
  const lfs = isLfsPath(path);
  const reject = compileGitignore(declaration.binaries.reject ?? [], { ignoreCase: true });
  const rule = reject(path);
  if (rule && (lfs || looksBinary(head))) {
    return { rule: "reject", path, message: `중간물 자리입니다: ${path} (${rule}) — 볼트 밖에 두세요` };
  }
  if (!lfs && size > MAX_NON_LFS_BYTES) {
    return { rule: "size", path, message: `${MAX_NON_LFS_BYTES / MiB}MiB 넘는 일반 파일: ${path} (${size}B) — .gitattributes 에 확장자를 더하세요` };
  }
  return null;
}

function git(cwd, args, input) {
  return execFileSync("git", ["-C", cwd, ...args], { input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
}

/** Repo toplevel and the tree's prefix inside it, or null outside a git work tree. */
export function locateTreeInRepo(vaultDir) {
  let top;
  try {
    top = git(vaultDir, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  } catch {
    return null;
  }
  const rel = relative(realpathSync(top), realpathSync(vaultDir)).split("\\").join("/");
  return { top, prefix: rel ? `${rel}/` : "" };
}

/** Staged additions/modifications under the tree: [{ path (tree-relative), sha, size }]. */
function stagedEntries(top, prefix) {
  const raw = git(top, ["diff", "--cached", "--raw", "-z", "--no-renames", "--diff-filter=AMT", "--", prefix || "."]).toString("utf8");
  const tokens = raw.split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!tokens[i].startsWith(":")) continue;
    const [, newMode, , newSha] = tokens[i].slice(1).split(" ");
    const repoPath = tokens[i + 1];
    i += 1;
    if (newMode === "160000") continue;
    entries.push({ path: repoPath.slice(prefix.length), sha: newSha });
  }
  if (entries.length === 0) return entries;
  const sizes = git(top, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], `${entries.map((e) => e.sha).join("\n")}\n`).toString("utf8").split("\n");
  entries.forEach((entry, index) => {
    entry.size = Number(sizes[index]?.split(" ")[1] ?? 0);
  });
  return entries;
}

function blobHead(top, sha) {
  // first 8000 bytes are enough for the NUL test; cat-file streams the blob
  return git(top, ["cat-file", "blob", sha]).subarray(0, 8000);
}

/**
 * Judge the commit about to be made in the tree at `vaultDir`. Returns
 * `{ violations: [{rule, message, path?}], freezeException: boolean, staged: n }`.
 */
export function checkCommitPolicy({ vaultDir, declaration, env = process.env }) {
  const located = locateTreeInRepo(vaultDir);
  if (!located) return { violations: [], freezeException: false, staged: 0 };
  const violations = [];
  const freeze = checkFreeze({ storeId: declaration?.id ?? null, env });
  if (freeze) violations.push(freeze);
  const freezeException = !freeze && existsSync(resolveFreezeFile(env)) && Boolean(env.KUMA_VAULT_FREEZE_ID);
  if (!declaration?.binaries) return { violations, freezeException, staged: 0 };
  const staged = stagedEntries(located.top, located.prefix);
  const reject = compileGitignore(declaration.binaries.reject ?? [], { ignoreCase: true });
  for (const entry of staged) {
    const needsHead = Boolean(reject(entry.path)) && !isLfsPath(entry.path) && entry.size <= MAX_NON_LFS_BYTES;
    const verdict = judgeBinaryWrite({
      path: entry.path,
      size: entry.size,
      head: needsHead ? blobHead(located.top, entry.sha) : null,
      declaration,
    });
    if (verdict) violations.push(verdict);
  }
  return { violations, freezeException, staged: staged.length };
}

// `GET /v1/stores/<id>/file` — one regular file of a served store, read from git objects.
//
// Never from the `tree/` checkout: a pushed tree may carry symlinks (receive rule 3 accepts link
// targets, even ones pointing outside the store), and anything read through the filesystem would
// follow them. Reading `ls-tree` + blobs means a symlink is just a mode-120000 entry that is
// refused, and nothing outside the object store is ever opened. `_credentials/` and
// `_sync-conflicts/` (any depth, any case) are never served.

import { crossesSecretDir } from "./secret-dirs.mjs";
import { runGit, storePaths } from "./store-layout.mjs";

const REGULAR_MODES = new Set(["100644", "100755"]);
const DOTGIT = /^(\.git[. ]*|git~1)$/i;
const REV = /^(main|HEAD|[0-9a-f]{7,40})$/;

function gitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return { ...env, LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
}

async function git(gitDir, args, options = {}) {
  return runGit(["--git-dir", gitDir, ...args], { env: gitEnv(), ...options });
}

async function mainHead(gitDir) {
  const { stdout, code } = await git(gitDir, ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"], { allowFail: true });
  return code === 0 ? stdout.toString("utf8").trim() : null;
}

async function isAncestor(gitDir, ancestor, descendant) {
  const { code } = await git(gitDir, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true });
  return code === 0;
}

async function readBlob(gitDir, sha) {
  const { stdout } = await git(gitDir, ["cat-file", "--batch"], { input: `${sha}\n` });
  const newline = stdout.indexOf(0x0a);
  if (newline < 0) return null;
  const header = stdout.subarray(0, newline).toString("utf8");
  if (header.endsWith(" missing") || header.endsWith(" ambiguous")) return null;
  const [, type, size] = header.split(" ");
  if (type !== "blob") return null;
  return stdout.subarray(newline + 1, newline + 1 + Number(size));
}

/** Where the declared tree sits in the repo at `commit`: "" (vault.config.json at the root), "vault/" (the brain layout), or "" when neither declares. */
async function treePrefixAt(gitDir, commit) {
  for (const prefix of ["", "vault/"]) {
    const { stdout } = await git(gitDir, ["ls-tree", "-z", commit, "--", `${prefix}vault.config.json`]);
    const line = stdout.toString("utf8").split("\0").find(Boolean);
    if (!line) continue;
    const [mode, type] = line.split("\t")[0].split(" ");
    if (type === "blob" && REGULAR_MODES.has(mode)) return prefix;
  }
  return "";
}

export class FileRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Validate a tree-relative path for the file API. Throws FileRequestError. */
export function checkServedPath(path) {
  if (typeof path !== "string" || !path) throw new FileRequestError(400, "path required");
  if (path !== path.normalize("NFC")) throw new FileRequestError(400, "path must be NFC");
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) throw new FileRequestError(400, "path must be tree-relative");
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new FileRequestError(400, "path must not contain empty, . or .. components");
  if (parts.some((p) => DOTGIT.test(p))) throw new FileRequestError(403, "path is not served");
  if (crossesSecretDir(path)) throw new FileRequestError(403, "path is not served");
  return path;
}

/**
 * Read one regular file of the tree at `rev` (default main) from git objects. Symlinks,
 * gitlinks and directories are refused; `rev` must be main or an ancestor of it.
 * Returns `{ commit, mode, sha, size, content }`.
 */
export async function readServedFile(storeRoot, { path, rev = "main" }) {
  checkServedPath(path);
  if (!REV.test(rev)) throw new FileRequestError(400, "rev must be main, HEAD or a commit sha");
  const { gitDir } = storePaths(storeRoot);
  const head = await mainHead(gitDir);
  if (!head) throw new FileRequestError(404, "store is empty");
  const name = rev === "main" || rev === "HEAD" ? head : rev;
  const { stdout, code } = await git(gitDir, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`], { allowFail: true });
  if (code !== 0) throw new FileRequestError(404, `no commit ${rev}`);
  const commit = stdout.toString("utf8").trim();
  if (commit !== head && !(await isAncestor(gitDir, commit, head))) throw new FileRequestError(404, `no commit ${rev} on main`);
  const prefix = await treePrefixAt(gitDir, commit);
  const listing = await git(gitDir, ["ls-tree", "-z", "--full-tree", commit, "--", `${prefix}${path}`]);
  const record = listing.stdout.toString("utf8").split("\0").find(Boolean);
  if (!record) throw new FileRequestError(404, `not found: ${path}`);
  const tab = record.indexOf("\t");
  const [mode, type, sha] = record.slice(0, tab).split(" ");
  if (record.slice(tab + 1) !== `${prefix}${path}`) throw new FileRequestError(404, `not found: ${path}`);
  if (type !== "blob" || !REGULAR_MODES.has(mode)) throw new FileRequestError(403, `not a regular file: ${path} (${mode})`);
  const content = await readBlob(gitDir, sha);
  if (!content) throw new FileRequestError(500, `blob ${sha} unreadable`);
  return { commit, mode, sha, size: content.length, content };
}

// The tree's generated `.rgignore`: a plain `rg` in a vault skips the secret directories
// (`_credentials`, `_sync-conflicts`), while an explicit path or `--no-ignore` still reads them,
// and git tracks and syncs them as before. Runs the real `rg` and `git` against a tree that
// `vault binaries apply` (the refresh path of an existing vault) wrote the block into.
// Needs rg, git and Node 22.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SECRET_DIR_NAMES, crossesSecretDir, secretDirIgnorePatterns } from "../server/secret-dirs.mjs";
import { RGIGNORE_BLOCK, RGIGNORE_FILENAME, renderTreeRgignore } from "./policy-commands.mjs";

const VAULT_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vault");
const MARK = "rgignore-probe-7c1e";

// tree-relative files that hold MARK; `secret` is what the resolver says about the path
const FILES = [
  { path: "notes/plain.md", secret: false },
  { path: "domains/ops/credentials.md", secret: false },
  { path: "domains/ops/my_credentials/note.md", secret: false },
  { path: "domains/personal/_credentials/service.json", secret: true },
  { path: "projects/p/_Credentials/upper.json", secret: true },
  { path: "_credentials/root.json", secret: true },
  { path: "_sync-conflicts/20261005-010203-host/notes/plain.md", secret: true },
  { path: "domains/x/_SYNC-CONFLICTS/conflicts.jsonl", secret: true },
];

let root;
let top;
let tree;

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Files under `cwd` that `rg` prints for MARK, as sorted paths relative to `cwd`. The path is
 * always given: without one, rg searches a piped stdin instead of the directory.
 */
function rgFiles(cwd, extra = [], paths = ["."]) {
  const out = run("rg", ["-l", "--sort", "path", ...extra, MARK, ...paths], cwd);
  expect(out.code === 0 || out.code === 1, out.stderr).toBe(true);
  return out.stdout.split("\n").filter(Boolean).map((line) => line.replace(/^\.\//u, "")).sort();
}

const visible = FILES.filter((f) => !f.secret).map((f) => f.path).sort();
const everything = FILES.map((f) => f.path).sort();

beforeAll(() => {
  expect(run("rg", ["--version"]).code, "rg is not installed").toBe(0);
  root = mkdtempSync(join(tmpdir(), "kv-rgignore-"));
  top = join(root, "repo");
  tree = join(top, "vault");
  mkdirSync(tree, { recursive: true });
  run("git", ["init", "-q", "-b", "main", top]);
  writeFileSync(join(tree, "vault.config.json"), JSON.stringify({ id: "rgignore", profile: "kuma-vault" }));
  for (const { path } of FILES) {
    mkdirSync(join(tree, path, ".."), { recursive: true });
    writeFileSync(join(tree, path), `${MARK}\n`);
  }
  writeFileSync(join(root, "reject.json"), JSON.stringify({ reject: [] }));
  const apply = run(VAULT_BIN, ["binaries", "apply", "--from", join(root, "reject.json"), "--root", tree], root);
  expect(apply.code, apply.stderr).toBe(0);
  expect(JSON.parse(apply.stdout).files).toContain(join(tree, RGIGNORE_FILENAME));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the generated block", () => {
  it("is derived from the one secret-directory resolver", () => {
    expect(secretDirIgnorePatterns()).toHaveLength(SECRET_DIR_NAMES.length);
    expect(secretDirIgnorePatterns()).toEqual(["_[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS]", "_[sS][yY][nN][cC]-[cC][oO][nN][fF][lL][iI][cC][tT][sS]"]);
    for (const { path, secret } of FILES) expect(crossesSecretDir(path), path).toBe(secret);
  });

  it("replaces only its own block and is idempotent", () => {
    const once = renderTreeRgignore("*.log\n");
    expect(once.startsWith("*.log\n\n")).toBe(true);
    expect(renderTreeRgignore(once)).toBe(once);
    const stale = once.replace(secretDirIgnorePatterns()[1], "_old-name");
    expect(renderTreeRgignore(stale)).toBe(once);
    expect(() => renderTreeRgignore(`${RGIGNORE_BLOCK[0]}\n_x\n`)).toThrow(/without its end marker/);
    expect(readFileSync(join(tree, RGIGNORE_FILENAME), "utf8")).toBe(renderTreeRgignore(""));
  });
});

describe("rg in a vault (counterexamples)", () => {
  it("a plain rg in the tree prints no file under a secret directory", () => {
    expect(rgFiles(tree)).toEqual(visible);
    expect(rgFiles(tree, ["--hidden"])).toEqual(visible);
    const listed = run("rg", ["--files", "."], tree).stdout.split("\n").filter(Boolean).map((line) => line.replace(/^\.\//u, ""));
    expect(listed).toEqual(expect.arrayContaining(visible));
    expect(listed.filter(crossesSecretDir)).toEqual([]);
  });

  it("the same from the repository root, a subdirectory and a link to the tree (~/.kuma/vault)", () => {
    expect(rgFiles(top)).toEqual(visible.map((p) => `vault/${p}`));
    expect(rgFiles(join(tree, "domains"))).toEqual(["ops/credentials.md", "ops/my_credentials/note.md"]);
    const link = join(root, "vault-link");
    symlinkSync(tree, link);
    expect(rgFiles(root, [], ["vault-link"])).toEqual(visible.map((p) => `vault-link/${p}`));
  });

  it("an explicit path or --no-ignore still reads them", () => {
    expect(rgFiles(tree, [], ["domains/personal/_credentials/service.json"])).toEqual(["domains/personal/_credentials/service.json"]);
    expect(rgFiles(tree, [], ["domains/personal/_credentials"])).toEqual(["domains/personal/_credentials/service.json"]);
    expect(rgFiles(tree, ["--no-ignore"])).toEqual(everything);
  });

  it("git still tracks them: nothing is git-ignored and every file is committed", () => {
    for (const { path } of FILES) expect(run("git", ["check-ignore", "-q", `vault/${path}`], top).code, path).toBe(1);
    run("git", ["add", "-A"], top);
    const staged = run("git", ["ls-files"], top).stdout.split("\n").filter(Boolean);
    expect(staged).toEqual(expect.arrayContaining([...FILES.map((f) => `vault/${f.path}`), `vault/${RGIGNORE_FILENAME}`]));
  });
});

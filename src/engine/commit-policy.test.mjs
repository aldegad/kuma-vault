// The commit side of the vault gate, through real git: `vault hook install` writes the pre-commit
// gate (freeze, binaries.reject, 32MiB) and — for a tree with a storage policy — the pre-push
// remote allowlist that chains git-lfs. The hooks resolve `vault` through `git config
// kuma-vault.bin`, not a baked path.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkFreeze, judgeBinaryWrite } from "./commit-policy.mjs";
import { judgePush, normalizeRemoteUrl } from "../cli/policy-commands.mjs";

const VAULT_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vault");
const MiB = 1024 * 1024;

let root;
let home;

function sh(cmd, args, { cwd, input, env = {}, allowFail = true } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    input,
    maxBuffer: 256 * MiB,
    env: {
      ...process.env,
      HOME: home,
      KUMA_HOME_DIR: join(home, ".kuma"),
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
      ...env,
    },
  });
  const out = { code: result.status, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
  if (out.code !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")}: ${out.stderr}`);
  return out;
}
const git = (cwd, args, opts = {}) => sh("git", args, { cwd, ...opts });

/** Regenerate the tree's tracked derivations, so the gate judges only what a test stages. */
function converge(repo) {
  // the docs profile scopes navigation to git-tracked files: stage first, then derive
  git(repo, ["add", "-A"], { allowFail: false });
  const out = sh(VAULT_BIN, ["sync", "--root", join(repo, "vault")]);
  if (out.code !== 0) throw new Error(`vault sync: ${out.stderr}\n${out.stdout}`);
  git(repo, ["add", "-A"], { allowFail: false });
}

function makeRepo(name, config) {
  const dir = join(root, name);
  mkdirSync(join(dir, "vault"), { recursive: true });
  git(dir, ["init", "--quiet", "-b", "main"], { allowFail: false });
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "user.email", "t@test.invalid"]);
  writeFileSync(join(dir, "vault", "vault.config.json"), JSON.stringify({ id: name, profile: "docs", ...config }));
  writeFileSync(join(dir, ".gitignore"), ".fts/\nvault/.fts/\n");
  converge(dir);
  git(dir, ["commit", "--quiet", "-m", "init", "--no-verify"], { allowFail: false });
  const install = sh(VAULT_BIN, ["hook", "install", "--root", join(dir, "vault"), "--bin", VAULT_BIN]);
  expect(install.code, install.stderr).toBe(0);
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kv-policy-"));
  home = join(root, "home");
  mkdirSync(join(home, ".kuma"), { recursive: true });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("verdict functions", () => {
  it("freeze: absent passes, present refuses, the matching id passes, another store passes, junk refuses", () => {
    const file = join(root, "freeze.json");
    const env = { KUMA_VAULT_FREEZE_FILE: file };
    expect(checkFreeze({ env })).toBeNull();
    writeFileSync(file, JSON.stringify({ id: "f-1", reason: "cutover", since: "2026-10-05T01:00:00+09:00" }));
    expect(checkFreeze({ env })?.message).toContain("동결");
    expect(checkFreeze({ env: { ...env, KUMA_VAULT_FREEZE_ID: "f-1" } })).toBeNull();
    expect(checkFreeze({ env: { ...env, KUMA_VAULT_FREEZE_ID: "f-2" } })).not.toBeNull();
    writeFileSync(file, JSON.stringify({ id: "f-1", store: "kuma-brain" }));
    expect(checkFreeze({ storeId: "other-store", env })).toBeNull();
    expect(checkFreeze({ storeId: "kuma-brain", env })).not.toBeNull();
    writeFileSync(file, "{ nope");
    expect(checkFreeze({ env })?.message).toContain("읽을 수 없어");
  });

  it("binary writes: reject places refuse binaries (any case), text passes, >32MiB non-LFS refuses; no binaries block = no judgement", () => {
    const declaration = { binaries: { reject: ["projects/x/_assets/**/frames/**", "canvas/"] } };
    const png = { path: "projects/x/_assets/run/frames/000.png", size: 10, head: Buffer.from("x"), declaration };
    expect(judgeBinaryWrite(png)?.rule).toBe("reject");
    expect(judgeBinaryWrite({ ...png, path: "projects/x/_assets/run/FRAMES/000.PNG" })?.rule).toBe("reject");
    expect(judgeBinaryWrite({ ...png, path: "a/canvas/b.bin", head: Buffer.from([1, 0, 2]) })?.rule).toBe("reject");
    expect(judgeBinaryWrite({ ...png, path: "a/canvas/notes.md", head: Buffer.from("text") })).toBeNull();
    expect(judgeBinaryWrite({ path: "big.bin", size: 33 * MiB, head: null, declaration })?.rule).toBe("size");
    expect(judgeBinaryWrite({ path: "big.png", size: 300 * MiB, head: null, declaration })).toBeNull();
    for (const path of ["out/mesh.ply", "out/SLICE.GCODE", "out/part.obj", "out/plate.3mf", "out/cad.step"]) {
      expect(judgeBinaryWrite({ path, size: 300 * MiB, head: Buffer.from("G1 X0 Y0\n"), declaration }), path).toBeNull();
    }
    expect(judgeBinaryWrite({ path: "big.bin", size: 33 * MiB, head: null, declaration: {} })).toBeNull();
  });

  it("pre-push allowlist: private trees push only to listed URLs, credentials ignored", () => {
    const url = "http://oracle.example.ts.net:7741/v1/stores/brain.git";
    const declaration = { visibility: "private", remotes: { allowed: [url] } };
    expect(judgePush(declaration, "origin", url)).toBeNull();
    expect(judgePush(declaration, "origin", "http://user:tok@oracle.example.ts.net:7741/v1/stores/brain.git/")).toBeNull();
    expect(judgePush(declaration, "gh", "https://github.com/me/brain.git")).toContain("허용 목록 밖");
    expect(judgePush(declaration, "x", "git@github.com:me/brain.git")).toContain("허용 목록 밖");
    expect(judgePush({ visibility: "private" }, "o", url)).toContain("(없음)");
    expect(judgePush({ profile: "docs" }, "gh", "https://github.com/me/docs.git")).toBeNull();
    expect(normalizeRemoteUrl("http://a:b@h/x/")).toBe("http://h/x");
  });
});

describe("hooks through real git", { timeout: 60_000 }, () => {
  it("pre-commit refuses during a freeze, lets KUMA_VAULT_FREEZE_ID through", () => {
    const repo = makeRepo("frozen", {});
    writeFileSync(join(repo, "vault", "a.md"), "a\n");
    converge(repo);
    const freeze = join(home, ".kuma", "vault-freeze.json");
    writeFileSync(freeze, JSON.stringify({ id: "cut-1", reason: "cutover" }));
    try {
      const refused = git(repo, ["commit", "--quiet", "-m", "x"]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("볼트 동결 중");
      const allowed = git(repo, ["commit", "--quiet", "-m", "freeze snapshot"], { env: { KUMA_VAULT_FREEZE_ID: "cut-1" } });
      expect(allowed.code, allowed.stderr).toBe(0);
    } finally {
      rmSync(freeze);
    }
  });

  it("pre-commit refuses an intermediate in a reject place and a 33MiB non-LFS file; other binaries pass", () => {
    const repo = makeRepo("rejecting", { binaries: { reject: ["projects/x/frames/**"] } });
    mkdirSync(join(repo, "vault/projects/x/frames"), { recursive: true });
    writeFileSync(join(repo, "vault/projects/x/frames/000.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
    git(repo, ["add", "-A"]);
    let result = git(repo, ["commit", "--quiet", "-m", "frames"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("중간물 자리입니다: projects/x/frames/000.png");
    git(repo, ["rm", "--quiet", "--cached", "-r", "vault/projects"]);
    rmSync(join(repo, "vault/projects"), { recursive: true });

    writeFileSync(join(repo, "vault/huge.bin"), Buffer.alloc(33 * MiB, 1));
    git(repo, ["add", "-A"]);
    result = git(repo, ["commit", "--quiet", "-m", "huge"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("32MiB 넘는 일반 파일: huge.bin");
    git(repo, ["rm", "--quiet", "--cached", "vault/huge.bin"]);
    rmSync(join(repo, "vault/huge.bin"));

    mkdirSync(join(repo, "vault/projects/x/final"), { recursive: true });
    writeFileSync(join(repo, "vault/projects/x/final/clip.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
    converge(repo);
    result = git(repo, ["commit", "--quiet", "-m", "final"]);
    expect(result.code, result.stderr).toBe(0);
  });

  it("pre-push sends only to remotes.allowed, replacing the stock git-lfs hook and still running git lfs", () => {
    const allowedBare = join(root, "allowed.git");
    const otherBare = join(root, "public.git");
    git(root, ["init", "--quiet", "--bare", allowedBare], { allowFail: false });
    git(root, ["init", "--quiet", "--bare", otherBare], { allowFail: false });
    const dir = join(root, "pushy");
    mkdirSync(join(dir, "vault"), { recursive: true });
    git(dir, ["init", "--quiet", "-b", "main"], { allowFail: false });
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "user.email", "t@test.invalid"]);
    // the stock hook `git lfs install` writes
    mkdirSync(join(dir, ".git/hooks"), { recursive: true });
    writeFileSync(join(dir, ".git/hooks/pre-push"), "#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo missing; exit 2; }\ngit lfs pre-push \"$@\"\n");
    chmodSync(join(dir, ".git/hooks/pre-push"), 0o755);
    writeFileSync(join(dir, "vault/vault.config.json"), JSON.stringify({ id: "pushy", profile: "docs", visibility: "private", remotes: { allowed: [allowedBare] } }));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "--quiet", "-m", "init", "--no-verify"], { allowFail: false });
    const install = sh(VAULT_BIN, ["hook", "install", "--root", join(dir, "vault"), "--bin", VAULT_BIN]);
    expect(install.code, install.stderr).toBe(0);
    expect(readFileSync(join(dir, ".git/hooks/pre-push"), "utf8")).toContain("kuma-vault-push-hook");
    expect(readFileSync(join(dir, ".git/hooks/pre-push"), "utf8")).toContain("git lfs pre-push");
    expect(git(dir, ["config", "--get", "kuma-vault.bin"]).stdout.trim()).toBe(VAULT_BIN);
    expect(readFileSync(join(dir, ".git/hooks/pre-commit"), "utf8")).not.toContain(VAULT_BIN);

    git(dir, ["remote", "add", "origin", allowedBare]);
    git(dir, ["remote", "add", "public", otherBare]);
    const ok = git(dir, ["push", "--quiet", "origin", "main"]);
    expect(ok.code, ok.stderr).toBe(0);
    const refused = git(dir, ["push", "--quiet", "public", "main"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("허용 목록 밖 원격");
    expect(git(otherBare, ["rev-parse", "--verify", "--quiet", "refs/heads/main"]).code).not.toBe(0);
    const byUrl = git(dir, ["push", "--quiet", otherBare, "main"]);
    expect(byUrl.code).not.toBe(0);
  });

  it("refuses to overwrite a foreign pre-push hook; a missing vault executable refuses the commit", () => {
    const dir = join(root, "foreign");
    mkdirSync(join(dir, "vault"), { recursive: true });
    git(dir, ["init", "--quiet", "-b", "main"], { allowFail: false });
    mkdirSync(join(dir, ".git/hooks"), { recursive: true });
    writeFileSync(join(dir, ".git/hooks/pre-push"), "#!/bin/sh\necho mine\nexit 0\n");
    writeFileSync(join(dir, "vault/vault.config.json"), JSON.stringify({ id: "foreign", profile: "docs", visibility: "private" }));
    const install = sh(VAULT_BIN, ["hook", "install", "--root", join(dir, "vault")]);
    expect(install.code).not.toBe(0);
    expect(install.stderr).toContain("neither ours nor the stock git-lfs hook");
    expect(existsSync(join(dir, ".git/hooks/pre-commit"))).toBe(false);

    const repo = makeRepo("nobin", {});
    git(repo, ["config", "kuma-vault.bin", join(root, "no-such-vault")]);
    writeFileSync(join(repo, "vault", "b.md"), "b\n");
    converge(repo);
    const result = git(repo, ["commit", "--quiet", "-m", "b"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not found");
  });
});

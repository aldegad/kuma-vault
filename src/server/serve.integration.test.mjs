// End-to-end: `vault serve` on loopback with a scratch store, two git clients (clones A, B)
// pushing and fetching through it — plain git, git-lfs uploads/downloads, the seven receive
// rules, and the loopback token rule. Needs git + git-lfs on PATH. See docs/server.md.

import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { raceLfsReserve } from "../../scripts/server/lfs-reserve-race.mjs";
import { renderLfsGitattributesLines, renderLfsPointer } from "./lfs-paths.mjs";
import { hashToken, writeServerConfig } from "./server-config.mjs";
import { casObjectPath, initStore, storePaths } from "./store-layout.mjs";

const VAULT_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vault");
const SERVER_CLI = join(dirname(fileURLToPath(import.meta.url)), "server-cli.mjs");
const TOKENS = { writer: "tok-writer", reader: "tok-reader", admin: "tok-admin" };
const MiB = 1024 * 1024;

let root;
let home;
let configPath;
let baseConfig;
let serve;
let base;
let store;

function sh(cmd, args, { cwd, input, allowFail = false, env = {} } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    input,
    maxBuffer: 256 * MiB,
    env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
  });
  const out = { code: result.status, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
  if (out.code !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(" ")} (${out.code})\n${out.stderr}`);
  return out;
}

const git = (cwd, args, opts) => sh("git", args, { cwd, ...opts });

function clone(name, token = TOKENS.writer, extra = []) {
  const dir = join(root, name);
  sh("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, "clone", "--quiet", ...extra, `${base}/v1/stores/scratch.git`, dir], { cwd: root });
  git(dir, ["config", "http.extraHeader", `Authorization: Bearer ${token}`]);
  git(dir, ["config", "user.name", name]);
  git(dir, ["config", "user.email", `${name}@test.invalid`]);
  git(dir, ["config", `lfs.${base}/v1/stores/scratch.git/info/lfs.locksverify`, "false"]);
  git(dir, ["lfs", "install", "--local"]);
  return dir;
}

function writeIn(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** Commit raw blob content at `path` with plumbing (no clean filter) — for forged content and modes. */
function commitRaw(dir, files, message, mode = "100644") {
  for (const [path, content] of Object.entries(files)) {
    const sha = git(dir, ["hash-object", "-w", "--stdin"], { input: content }).stdout.trim();
    git(dir, ["update-index", "--add", "--cacheinfo", `${mode},${sha},${path}`]);
  }
  git(dir, ["commit", "--quiet", "-m", message]);
}

/**
 * `git mktree -z` over `entries` ({ name, content?, mode?, tree? }), after the raw `existing`
 * listing. Names are bytes: this is how a client pushes a name no index or argv would carry.
 */
function mktreeZ(dir, entries, existing = "") {
  const lines = entries.map((e) => {
    const [mode, type, sha] = e.tree
      ? ["040000", "tree", mktreeZ(dir, e.tree)]
      : [e.mode ?? "100644", "blob", git(dir, ["hash-object", "-w", "--stdin"], { input: e.content ?? "x\n" }).stdout.trim()];
    return Buffer.concat([Buffer.from(`${mode} ${type} ${sha}\t`), Buffer.from(e.name), Buffer.from([0])]);
  });
  return git(dir, ["mktree", "-z"], { input: Buffer.concat([Buffer.from(existing), ...lines]) }).stdout.trim();
}

/** Commit `entries` added to HEAD's `vault/` (see mktreeZ) without touching the index. */
function commitVaultEntries(dir, entries, message) {
  const vault = mktreeZ(dir, entries, git(dir, ["ls-tree", "-z", "HEAD:vault"]).stdout);
  const rest = git(dir, ["ls-tree", "HEAD"]).stdout.split("\n").filter((l) => l && !l.endsWith("\tvault")).join("\n");
  return commitTree(dir, `${rest}\n040000 tree ${vault}\tvault\n`, message);
}

/** Commit `tree` (a mktree listing of the root) on top of HEAD without touching the index. */
function commitTree(dir, rootListing, message) {
  const tree = git(dir, ["mktree"], { input: rootListing }).stdout.trim();
  const commit = git(dir, ["commit-tree", tree, "-p", "HEAD", "-m", message]).stdout.trim();
  git(dir, ["update-ref", "HEAD", commit]);
  return commit;
}

const pkt = (text) => {
  const body = Buffer.from(text);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
};

/**
 * Push by hand: one ref update plus a pack of exactly `objects` — what a hostile client can
 * send that `git push` never would (objects no commit reaches). Returns the report-status text.
 */
async function rawPush(dir, oldSha, newSha, objects) {
  const pack = spawnSync("git", ["pack-objects", "--stdout"], { cwd: dir, input: `${objects.join("\n")}\n`, maxBuffer: 256 * MiB });
  if (pack.status !== 0) throw new Error(pack.stderr.toString("utf8"));
  const body = Buffer.concat([pkt(`${oldSha} ${newSha} refs/heads/main\0report-status\n`), Buffer.from("0000"), pack.stdout]);
  const res = await http("/v1/stores/scratch.git/git-receive-pack", {
    method: "POST",
    token: TOKENS.writer,
    headers: { "Content-Type": "application/x-git-receive-pack-request" },
    body,
  });
  return res.text;
}

function push(dir, refspec = "HEAD:main", opts = {}) {
  return git(dir, ["push", "origin", refspec], { allowFail: true, ...opts });
}

function resetTo(dir, ref = "origin/main") {
  git(dir, ["fetch", "--quiet", "origin"]);
  git(dir, ["reset", "--quiet", "--hard", ref]);
  git(dir, ["clean", "-fdq"]);
}

function setConfig(patch) {
  writeServerConfig(configPath, { ...baseConfig, ...patch });
}

async function http(path, { method = "GET", token, body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  });
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "kv-serve-it-"));
  home = join(root, "home");
  mkdirSync(home);
  // global (test-HOME) LFS filters, so clones smudge LFS files on checkout
  sh("git", ["lfs", "install", "--skip-repo"], { cwd: root });
  const storeRoot = join(root, "stores", "scratch");
  configPath = join(root, "server.json");
  baseConfig = {
    version: 1,
    listen: ["127.0.0.1:0"],
    dataDir: join(root, "stores"),
    diskReserveGB: 0.001,
    growthAlert: { windowDays: 7, thresholdGB: 1e-7 }, // 100 bytes, so the first LFS upload trips it
    tokens: [
      { id: "w", sha256: hashToken(TOKENS.writer), role: "writer", stores: ["scratch"] },
      { id: "r", sha256: hashToken(TOKENS.reader), role: "reader", stores: ["scratch"] },
      { id: "a", sha256: hashToken(TOKENS.admin), role: "admin", stores: ["*"] },
    ],
    stores: { scratch: { path: storeRoot, binaries: { reject: ["vault/_work/", "*.scratch/"] } } },
  };
  writeServerConfig(configPath, baseConfig);
  await initStore(storeRoot, { vaultBin: VAULT_BIN });
  store = storePaths(storeRoot);
  // serve runs in its own process: the clients below use spawnSync, which would block an
  // in-process server's event loop.
  serve = spawn(process.execPath, [SERVER_CLI, "serve", "--config", configPath], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    let buffered = "";
    serve.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const match = /"event":"listening","listen":"127\.0\.0\.1:(\d+)"/.exec(buffered);
      if (match) resolve(Number(match[1]));
    });
    serve.on("exit", (code) => reject(new Error(`serve exited ${code}`)));
  });
  base = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  serve?.kill("SIGTERM");
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("vault serve — two clones over git smart HTTP + LFS", { timeout: 60_000 }, () => {
  let a;
  let b;
  let png;

  it("A pushes text, an LFS png and an empty png; the CAS holds the object read-only and tree/ follows", () => {
    a = clone("a");
    writeIn(a, ".gitattributes", `${renderLfsGitattributesLines().join("\n")}\n`);
    writeIn(a, "README.md", "# scratch\n");
    png = randomBytes(200 * 1024);
    writeIn(a, "vault/img/a.png", png);
    writeIn(a, "vault/img/empty.png", "");
    git(a, ["add", "-A"]);
    git(a, ["commit", "--quiet", "-m", "first"]);
    const result = push(a);
    expect(result.code, result.stderr).toBe(0);

    const oid = createHash("sha256").update(png).digest("hex");
    const casPath = casObjectPath(store.lfsObjects, oid);
    expect(statSync(casPath).mode & 0o777).toBe(0o444);
    expect(readFileSync(casPath).equals(png)).toBe(true);
    expect(readdirSync(store.lfsIncoming)).toEqual([]);
    // tree/ is the follow-only worktree: pointers stay pointers
    expect(readFileSync(join(store.tree, "vault/img/a.png"), "utf8")).toBe(renderLfsPointer(oid, png.length));
    expect(readFileSync(join(store.tree, "README.md"), "utf8")).toBe("# scratch\n");
    const events = readFileSync(store.events, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ seq: 1, ref: "refs/heads/main" });
  });

  it("B clones, gets the LFS bytes back, pushes; A fetches it", () => {
    b = clone("b");
    expect(readFileSync(join(b, "vault/img/a.png")).equals(png)).toBe(true);
    writeIn(b, "vault/notes/b.md", "from b\n");
    git(b, ["add", "-A"]);
    git(b, ["commit", "--quiet", "-m", "b note"]);
    expect(push(b).code).toBe(0);
    git(a, ["pull", "--quiet", "--ff-only", "origin", "main"]);
    expect(readFileSync(join(a, "vault/notes/b.md"), "utf8")).toBe("from b\n");
    expect(readFileSync(join(store.tree, "vault/notes/b.md"), "utf8")).toBe("from b\n");
  });

  it("serves a partial clone (blob filter) and lazily fetches a missing blob", () => {
    const c = join(root, "c");
    sh("git", ["-c", `http.extraHeader=Authorization: Bearer ${TOKENS.reader}`, "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false",
      "clone", "--quiet", "--no-checkout", "--filter=blob:limit=1", `${base}/v1/stores/scratch.git`, c], { cwd: root });
    git(c, ["config", "http.extraHeader", `Authorization: Bearer ${TOKENS.reader}`]);
    const out = git(c, ["cat-file", "-p", "origin/main:README.md"]).stdout;
    expect(out).toBe("# scratch\n");
  });

  it("events long-poll returns what happened after a seq", async () => {
    const res = await http("/v1/stores/scratch/events?after=1", { token: TOKENS.reader });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.events.map((e) => e.seq)).toEqual([2]);
    expect(body.lastSeq).toBe(2);
  });

  describe("receive rules", () => {
    it("rule 1: other refs, non-fast-forward, deletes, replace refs without admin", () => {
      resetTo(a);
      resetTo(b);
      writeIn(a, "vault/x.md", "x\n");
      git(a, ["add", "-A"]);
      git(a, ["commit", "--quiet", "-m", "x"]);
      let r = push(a, "HEAD:refs/heads/topic");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 1] main 만 받습니다: refs/heads/topic");

      writeIn(b, "vault/y.md", "y\n");
      git(b, ["add", "-A"]);
      git(b, ["commit", "--quiet", "-m", "y"]);
      expect(push(b).code).toBe(0);
      r = push(a); // a is now behind and diverged
      expect(r.code).not.toBe(0);
      r = push(a, "+HEAD:main"); // forced
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 1] fast-forward 만 받습니다");

      r = push(a, ":main");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("지우기는 받지 않습니다");

      resetTo(a);
      const head = git(a, ["rev-parse", "HEAD"]).stdout.trim();
      r = push(a, `HEAD:refs/replace/${"1".repeat(40)}`);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("refs/replace/* 는 컷오버 관리자 토큰으로만");
      // an empty http.extraHeader resets the list, so only the admin header is sent
      const adminPush = sh("git", ["-c", "http.extraHeader=", "-c", `http.extraHeader=Authorization: Bearer ${TOKENS.admin}`, "push", `${base}/v1/stores/scratch.git`, `${head}:refs/replace/${"1".repeat(40)}`], { cwd: a, allowFail: true });
      expect(adminPush.code, adminPush.stderr).toBe(0);
    });

    it("rule 2: case-only collisions and non-NFC paths", () => {
      resetTo(a);
      writeIn(a, "readme.md", "dup\n");
      git(a, ["add", "readme.md"]);
      git(a, ["commit", "--quiet", "-m", "case"]);
      let r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 2] 대소문자만 다른 경로(macOS 에서 한 파일): README.md, readme.md");

      resetTo(a);
      writeIn(a, "Vault/z.md", "dir case\n");
      git(a, ["add", "Vault/z.md"]);
      git(a, ["commit", "--quiet", "-m", "dir case"]);
      r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("대소문자만 다른 경로(macOS 에서 한 파일): Vault, vault");

      resetTo(a);
      const nfd = "vault/한.md"; // 한 decomposed
      commitRaw(a, { [nfd]: "nfd\n" }, "nfd");
      r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 2] NFC 정규형이 아닌 경로");
    });

    it("rule 2: names, paths and symlink targets a checkout cannot write are refused; the limits themselves check out", () => {
      const before = git(store.tree, ["rev-parse", "HEAD"]).stdout.trim();
      const over = [
        // ext4 NAME_MAX is 255 bytes: counted in bytes of the NFC name, so 86 Hangul syllables are over
        [{ [`vault/${"n".repeat(300)}.md`]: "x\n" }, "100644", "이름 하나가 303B, 255B 이하만 받습니다"],
        [{ [`vault/${"한".repeat(86)}.md`]: "x\n" }, "100644", "이름 하나가 261B, 255B 이하만 받습니다"],
        [{ [`${`${"d".repeat(200)}/`.repeat(4)}x.md`]: "x\n" }, "100644", "경로가 808B, 768B 이하만 받습니다"],
        // Linux takes at most 4095 bytes, macOS 1023
        [{ "vault/l4096": "a/".repeat(2048) }, "120000", "체크아웃 못 하는 심링크: vault/l4096 — 대상이 4096B, 1023B 이하만 받습니다"],
        [{ "vault/l1024": "a".repeat(1024) }, "120000", "체크아웃 못 하는 심링크: vault/l1024 — 대상이 1024B, 1023B 이하만 받습니다"],
      ];
      for (const [files, mode, message] of over) {
        resetTo(a);
        commitRaw(a, files, `over ${message}`, mode);
        const r = push(a);
        expect(r.code, message).not.toBe(0);
        expect(r.stderr).toContain(`[규칙 2] `);
        expect(r.stderr).toContain(message);
      }
      expect(git(store.tree, ["rev-parse", "HEAD"]).stdout.trim()).toBe(before);

      resetTo(a);
      const atLimit = {
        [`vault/${"n".repeat(252)}.md`]: "255B name\n",
        [`vault/${"한".repeat(84)}.md`]: "255B name in Hangul\n",
        [`vault/${`${"d".repeat(200)}/`.repeat(3)}${"e".repeat(156)}.md`]: "768B path\n",
      };
      commitRaw(a, atLimit, "names and a path at the limits");
      commitRaw(a, { "vault/l1023": "a".repeat(1023) }, "a link target at the limit", "120000");
      const r = push(a);
      expect(r.code, r.stderr).toBe(0);
      for (const path of Object.keys(atLimit)) expect(readFileSync(join(store.tree, path), "utf8")).toBe(atLimit[path]);
      expect(Buffer.byteLength(readlinkSync(join(store.tree, "vault/l1023")))).toBe(1023);
      const fresh = clone("after-limits");
      expect(git(fresh, ["status", "--porcelain"]).stdout).toBe("");
      expect(readlinkSync(join(fresh, "vault/l1023"))).toBe("a".repeat(1023));
    });

    it("rule 2: every axis a macOS or Linux checkout breaks on is refused; what both write is taken", () => {
      const before = git(store.tree, ["rev-parse", "HEAD"]).stdout.trim();
      const latin1 = (text) => Buffer.from(text, "latin1");
      const refused = [
        // encoding: APFS refuses a name that is not UTF-8 (EILSEQ); a lossy decode would read U+FFFD, which is NFC
        [[{ name: latin1("caf\xe9.md") }], "UTF-8 이 아닌 경로: vault/caf\\xe9.md"],
        [[{ name: Buffer.from([0x61, 0xc0, 0xaf, 0x62]) }], "UTF-8 이 아닌 경로: vault/a\\xc0\\xafb"],
        [[{ name: Buffer.from([0x61, 0xed, 0xa0, 0x80, 0x62]) }], "UTF-8 이 아닌 경로: vault/a\\xed\\xa0\\x80b"],
        // code points APFS does not know (EILSEQ): noncharacter, unassigned, a Unicode 17.0 addition
        [[{ name: "a\ufdd0b.md" }], "macOS 가 모르는 문자가 든 경로: vault/a\ufdd0b.md (U+FDD0)"],
        [[{ name: "a\u0378b.md" }], "(U+0378) — Unicode 16.0.0 에 할당된 문자만 받습니다"],
        [[{ name: "a\ua7ceb.md" }], "(U+A7CE)"],
        // full case folding: one file on a Mac, so one of the pair is lost (or the tree is dirty)
        [[{ name: "ß.md" }, { name: "ss.md" }], "대소문자만 다른 경로(macOS 에서 한 파일): vault/ss.md, vault/ß.md"],
        [[{ name: "\u1e9e.md" }, { name: "SS.md" }], "vault/SS.md, vault/\u1e9e.md"],
        [[{ name: "ς.md" }, { name: "σ.md" }], "vault/ς.md, vault/σ.md"],
        [[{ name: "ﬀ.md" }, { name: "ff.md" }], "vault/ff.md, vault/ﬀ.md"],
        [[{ name: "\u212a.md" }, { name: "k.md" }], "vault/k.md, vault/\u212a.md"],
        // a symlink and a directory one fold apart: the Mac writes one through the other, silently
        [[{ name: "Lnk", mode: "120000", content: "/tmp" }, { name: "lnk", tree: [{ name: "x.md" }] }], "vault/Lnk, vault/lnk"],
        // a named fork: macOS reads d/..namedfork/rsrc as the resource fork of the directory d
        [[{ name: "..namedfork", tree: [{ name: "rsrc" }] }], "macOS 가 리소스 포크로 읽는 경로 성분: vault/..namedfork/rsrc"],
        [[{ name: "d", tree: [{ name: "..namedfork", tree: [{ name: "rsrc", tree: [{ name: "x.md" }] }] }] }], "vault/d/..namedfork/rsrc/x.md"],
      ];
      for (const [entries, message] of refused) {
        resetTo(a);
        commitVaultEntries(a, entries, `axis ${message}`);
        const r = push(a);
        expect(r.code, message).not.toBe(0);
        expect(r.stderr, message).toContain("[규칙 2] ");
        expect(r.stderr).toContain(message);
      }

      // components git never checks out: index-pack --strict refuses them first, the hook on its own
      const components = [
        [[{ name: ".", tree: [{ name: "x.md" }] }], "체크아웃 못 하는 경로 성분: vault/./x.md"],
        [[{ name: "..", tree: [{ name: "x.md" }] }], "체크아웃 못 하는 경로 성분: vault/../x.md"],
        [[{ name: ".g\u200cit", tree: [{ name: "config" }] }], ".git 경로 성분은 받지 않습니다: vault/.g\u200cit/config"],
        [[{ name: ".gitmodules", mode: "120000", content: "/etc/passwd" }], "심링크인 .gitmodules 는 체크아웃되지 않습니다: vault/.gitmodules"],
      ];
      for (const [entries, message] of components) {
        resetTo(a);
        commitVaultEntries(a, entries, `component ${message}`);
        let r = push(a);
        expect(r.code, message).not.toBe(0);
        expect(r.stderr).toMatch(/hasDot|gitmodulesSymlink|fsck|unpacker error/);
        git(root, ["--git-dir", store.gitDir, "config", "receive.fsckObjects", "false"]);
        try {
          r = push(a);
          expect(r.code, message).not.toBe(0);
          expect(r.stderr).toContain(`[규칙 2] ${message}`);
        } finally {
          git(root, ["--git-dir", store.gitDir, "config", "receive.fsckObjects", "true"]);
        }
      }
      expect(git(store.tree, ["rev-parse", "HEAD"]).stdout.trim()).toBe(before);

      // control: names both clients write (measured), and pairs APFS keeps apart
      resetTo(a);
      const taken = ["a\u{1fae9}b.md", "a\ue000b.md", "a\x01b.md", "a\x7fb.md", "a:b.md", "a\\b.md", "a.", "a ", "CON", "aux.md", 'a<>|?*"b.md', "..NAMEDFORK", "\u0131.md", "i.md", "a\u200cb.md", "ab.md", "\uff21.md"];
      commitVaultEntries(a, taken.map((name) => ({ name, content: `${name}\n` })), "names every client writes");
      const r = push(a);
      expect(r.code, r.stderr).toBe(0);
      for (const name of taken) expect(readFileSync(join(store.tree, "vault", name), "utf8")).toBe(`${name}\n`);
      const fresh = clone("after-axes");
      expect(git(fresh, ["status", "--porcelain"]).stdout).toBe("");
    });

    it("rule 3: raw binaries, forged pointers, size lies, upper-case extensions; empty files pass", () => {
      resetTo(a);
      commitRaw(a, { "vault/raw.png": randomBytes(5000) }, "raw png");
      let r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 3] LFS 포인터가 아닙니다: vault/raw.png");

      resetTo(a);
      commitRaw(a, { "vault/tiny.PNG": Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, "upper ext");
      r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("LFS 포인터가 아닙니다: vault/tiny.PNG");

      resetTo(a);
      const ghost = "b".repeat(64);
      commitRaw(a, { "vault/ghost.jpg": renderLfsPointer(ghost, 10) }, "forged pointer");
      // a hostile client skips git-lfs' own pre-push check; the server must still refuse
      r = git(a, ["push", "--no-verify", "origin", "HEAD:main"], { allowFail: true });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`[규칙 3] LFS 객체 없음: ${ghost} (vault/ghost.jpg)`);

      resetTo(a);
      const oid = createHash("sha256").update(png).digest("hex");
      commitRaw(a, { "vault/liar.png": renderLfsPointer(oid, png.length + 1) }, "size lie");
      r = git(a, ["push", "--no-verify", "origin", "HEAD:main"], { allowFail: true });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("LFS 포인터 크기가 객체와 다릅니다: vault/liar.png");

      resetTo(a);
      commitRaw(a, { "vault/also-empty.PDF": "" }, "empty pdf");
      r = push(a);
      expect(r.code, r.stderr).toBe(0);
    });

    it("rule 4: a 33MiB plain blob is refused even when a later commit deletes it, a big .gcode falls under rule 3; 11MiB passes with a warning", () => {
      resetTo(a);
      commitRaw(a, { "vault/big.bin": Buffer.alloc(33 * MiB, 1) }, "big");
      git(a, ["rm", "--quiet", "vault/big.bin"]);
      git(a, ["commit", "--quiet", "-m", "remove big"]);
      let r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 4] 32MiB 넘는 일반 blob: vault/big.bin");

      // a print job is text but an LFS extension: a raw one is refused as a non-pointer (rule 3), not by size
      resetTo(a);
      commitRaw(a, { "vault/slice.gcode": Buffer.from("G1 X0 Y0\n".repeat(Math.ceil((33 * MiB) / 9))) }, "raw gcode");
      r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 3] LFS 포인터가 아닙니다: vault/slice.gcode");
      expect(r.stderr).not.toContain("[규칙 4]");

      resetTo(a);
      commitRaw(a, { "vault/medium.bin": Buffer.alloc(11 * MiB, 2) }, "medium");
      r = push(a);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toContain("kuma-vault 경고 [규칙 4] 큰 일반 blob(받음): vault/medium.bin");
      const log = readFileSync(store.receiveLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(log.at(-1).warnings[0]).toMatchObject({ rule: 4, path: "vault/medium.bin" });
    });

    it("rule 5: the disk reserve refuses pushes and LFS uploads", async () => {
      resetTo(a);
      setConfig({ diskReserveGB: 1e9 });
      try {
        writeIn(a, "vault/disk.md", "d\n");
        git(a, ["add", "-A"]);
        git(a, ["commit", "--quiet", "-m", "disk"]);
        const r = push(a);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain("[규칙 5] 서버 디스크 부족");
        await new Promise((res) => setTimeout(res, 1100)); // serve re-reads server.json at most once a second
        const batch = await http("/v1/stores/scratch.git/info/lfs/objects/batch", {
          method: "POST",
          token: TOKENS.writer,
          headers: { "Content-Type": "application/vnd.git-lfs+json" },
          body: JSON.stringify({ operation: "upload", objects: [{ oid: "c".repeat(64), size: 10 }] }),
        });
        expect(batch.status).toBe(507);
      } finally {
        setConfig({});
        await new Promise((res) => setTimeout(res, 1100));
      }
    });

    it("rule 6: .fts, lock and temp files", () => {
      for (const path of ["vault/.fts/vault-fts.db", "vault/plans/x.md.commit-lock", "vault/a.tmp", ".DS_Store", "vault/.~lock.x#"]) {
        resetTo(a);
        commitRaw(a, { [path]: "junk\n" }, `junk ${path}`);
        const r = push(a);
        expect(r.code, path).not.toBe(0);
        expect(r.stderr).toContain(`[규칙 6] 잠금·임시 파일은 올리지 않습니다: ${path}`);
      }
    });

    it("rule 7: binaries in binaries.reject places (server.json, case-insensitive); text there passes", () => {
      resetTo(a);
      writeIn(a, "vault/_work/frame.png", randomBytes(1000));
      git(a, ["add", "-A"]);
      git(a, ["commit", "--quiet", "-m", "intermediate"]);
      let r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 7] 중간물 자리입니다: vault/_work/frame.png");

      resetTo(a);
      commitRaw(a, { "vault/_WORK/blob.bin": Buffer.from([0, 1, 2, 3]) }, "case bypass");
      r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 7] 중간물 자리입니다: vault/_WORK/blob.bin");

      resetTo(a);
      // the pushed tree cannot unlist the place: rule 7 reads server.json only
      commitRaw(a, { "vault.config.json": '{"binaries":{"reject":[]}}\n', "x/run.scratch/out.bin": Buffer.from([0, 9]) }, "unlist");
      r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("중간물 자리입니다: x/run.scratch/out.bin");

      resetTo(a);
      commitRaw(a, { "vault/_work/notes.md": "text is fine\n" }, "text");
      r = push(a);
      expect(r.code, r.stderr).toBe(0);
    });

    it("rules 3, 4, 7 hold for symlinks (mode 120000): only a link target passes", () => {
      // P1: a 40MiB blob as a symlink outside LFS paths (rule 4)
      resetTo(a);
      commitRaw(a, { "vault/huge.bin": randomBytes(40 * MiB) }, "p1", "120000");
      let r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`[규칙 4] 링크 대상이 아닌 심링크: vault/huge.bin (${40 * MiB}B)`);

      // P2: a binary as a symlink at an LFS path (rule 3)
      resetTo(a);
      const bin = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), randomBytes(200_000)]);
      commitRaw(a, { "vault/pic.png": bin }, "p2", "120000");
      r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 3] 링크 대상이 아닌 심링크: vault/pic.png");

      // P3: a binary as a symlink in a reject place (rule 7)
      resetTo(a);
      commitRaw(a, { "vault/_work/x.bin": bin }, "p3", "120000");
      r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 7] 링크 대상이 아닌 심링크: vault/_work/x.bin");

      // a short binary (NUL) symlink and an over-long text symlink are not link targets either
      resetTo(a);
      commitRaw(a, { "vault/nul-link": Buffer.from([0x61, 0, 0x62]), "vault/long-link": "a/".repeat(2100) }, "odd links", "120000");
      r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 4] 링크 대상이 아닌 심링크: vault/nul-link (3B)");
      expect(r.stderr).toContain("[규칙 4] 링크 대상이 아닌 심링크: vault/long-link (4200B)");

      // an LFS-extension symlink in a reject place is an LFS file there (rule 7)
      resetTo(a);
      commitRaw(a, { "vault/_work/clip.mp4": "../media/clip.mp4" }, "lfs link in reject place", "120000");
      r = push(a);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("[규칙 7] 중간물 자리입니다: vault/_work/clip.mp4");

      // real symlinks pass, at LFS paths too (git-lfs never turns a symlink into a pointer)
      resetTo(a);
      commitRaw(a, { "vault/media/song.mp3": "../../shared/song.mp3", "vault/latest": "notes" }, "links", "120000");
      r = push(a);
      expect(r.code, r.stderr).toBe(0);
    });

    it("rule 2 and fsck: a .git path component (any case) never lands, and tree/ keeps following", () => {
      resetTo(a);
      const before = git(store.tree, ["rev-parse", "HEAD"]).stdout.trim();
      expect(git(root, ["--git-dir", store.gitDir, "config", "receive.fsckObjects"]).stdout.trim()).toBe("true");
      const hook = git(a, ["hash-object", "-w", "--stdin"], { input: "#!/bin/sh\n" }).stdout.trim();
      const withDotgit = (name) => {
        resetTo(a);
        const dotgit = git(a, ["mktree"], { input: `100644 blob ${hook}\tconfig\n` }).stdout.trim();
        const vault = git(a, ["mktree"], { input: `${git(a, ["ls-tree", "HEAD:vault"]).stdout}040000 tree ${dotgit}\t${name}\n` }).stdout.trim();
        const rest = git(a, ["ls-tree", "HEAD"]).stdout.split("\n").filter((l) => l && !l.endsWith("\tvault")).join("\n");
        commitTree(a, `${rest}\n040000 tree ${vault}\tvault\n`, `dotgit ${name}`);
        return push(a);
      };
      // P5: index-pack --strict refuses it before the hooks run
      let r = withDotgit(".git");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/hasDotgit|fsck|unpacker error/);
      // the hook refuses it on its own as well (fsck off for this case only)
      git(root, ["--git-dir", store.gitDir, "config", "receive.fsckObjects", "false"]);
      try {
        r = withDotgit(".GIT");
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain("[규칙 2] .git 경로 성분은 받지 않습니다: vault/.GIT/config");
        r = withDotgit(".git.");
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain("[규칙 2] .git 경로 성분은 받지 않습니다: vault/.git./config");
      } finally {
        git(root, ["--git-dir", store.gitDir, "config", "receive.fsckObjects", "true"]);
      }
      expect(git(store.tree, ["rev-parse", "HEAD"]).stdout.trim()).toBe(before);
      // a fresh clone still checks out
      const fresh = clone("after-dotgit");
      expect(git(fresh, ["status", "--porcelain"]).stdout).toBe("");
    });

    it("rule 4: an object no path names (gitlink target in a hand-made pack) is held to the cap too", async () => {
      resetTo(a);
      const main = git(a, ["rev-parse", "origin/main"]).stdout.trim();
      const viaGitlink = async (content) => {
        git(a, ["reset", "--quiet", "--hard", main]);
        const blob = git(a, ["hash-object", "-w", "--stdin"], { input: content }).stdout.trim();
        git(a, ["update-index", "--add", "--cacheinfo", `160000,${blob},vault/sub`]);
        git(a, ["commit", "--quiet", "-m", "gitlink"]);
        const head = git(a, ["rev-parse", "HEAD"]).stdout.trim();
        // what git push would send (commit + trees; it never follows a gitlink) plus the blob
        const reachable = git(a, ["rev-list", "--objects", `${main}..HEAD`]).stdout.split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
        return { blob, head, report: await rawPush(a, main, head, [...reachable, blob]) };
      };
      const big = await viaGitlink(Buffer.alloc(33 * MiB, 7));
      expect(big.report).toContain("ng refs/heads/main");
      expect(git(root, ["--git-dir", store.gitDir, "rev-parse", "refs/heads/main"]).stdout.trim()).toBe(main);
      expect(git(root, ["--git-dir", store.gitDir, "cat-file", "-e", big.blob], { allowFail: true }).code).not.toBe(0);
      const log = readFileSync(store.receiveLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(JSON.stringify(log.at(-1))).toContain(`32MiB 넘는 객체(경로 없음): blob ${big.blob}`);
      // control: the same hand-made push with a small object is accepted
      const small = await viaGitlink("small\n");
      expect(small.report, small.report).toContain("ok refs/heads/main");
      resetTo(a);
    });
  });

  describe("access", () => {
    it("loopback without a token gets 401 everywhere except health", async () => {
      for (const [method, path] of [
        ["GET", "/v1/stores/scratch.git/info/refs?service=git-upload-pack"],
        ["GET", "/v1/stores/scratch.git/info/refs?service=git-receive-pack"],
        ["POST", "/v1/stores/scratch.git/git-receive-pack"],
        ["POST", "/v1/stores/scratch.git/info/lfs/objects/batch"],
        ["GET", "/v1/stores/scratch/events?after=0"],
        ["GET", "/v1/stores/scratch/file?path=README.md"],
        ["GET", "/v1/stores/scratch/backup-status"],
        ["GET", "/v1/stores/nope.git/info/refs?service=git-upload-pack"],
      ]) {
        const res = await http(path, { method });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
      const health = await http("/v1/health");
      expect(health.status).toBe(200);
      const body = JSON.parse(health.text);
      expect(body.stores).toEqual([]);
      expect(body.service).toBe("kuma-vault-serve");
      // the CAS growth alarm is visible to anyone, the store name only to its readers
      expect(body.growthAlert).toMatchObject({ windowDays: 7, count: 1, stores: [] });
    });

    it("git without a token cannot clone or push from loopback", () => {
      const r = sh("git", ["clone", "--quiet", `${base}/v1/stores/scratch.git`, join(root, "anon")], { cwd: root, allowFail: true });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/401|Authentication failed|could not read Username/);
    });

    it("wrong token 401, reader cannot push (403), health shows readable stores", async () => {
      expect((await http("/v1/stores/scratch/backup-status", { token: "nope" })).status).toBe(401);
      expect((await http("/v1/health", { token: "nope" })).status).toBe(401);
      const reader = clone("reader", TOKENS.reader);
      writeIn(reader, "vault/r.md", "r\n");
      git(reader, ["add", "-A"]);
      git(reader, ["commit", "--quiet", "-m", "r"]);
      const r = push(reader);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/403/);
      const health = JSON.parse((await http("/v1/health", { token: TOKENS.reader })).text);
      expect(health.stores.map((s) => s.id)).toEqual(["scratch"]);
      expect(health.growthAlert.stores).toEqual([{ id: "scratch", windowGB: expect.any(Number) }]);
      expect(health.stores[0].cas.windowBytes).toBeGreaterThan(200 * 1024);
      const backup = JSON.parse((await http("/v1/stores/scratch/backup-status", { token: TOKENS.reader })).text);
      expect(backup).toMatchObject({ store: "scratch", lastBackupAt: null });
    });

    it("an LFS upload without Content-Length (chunked) is refused with 411 and leaves nothing", async () => {
      const oid = createHash("sha256").update("chunked").digest("hex");
      const status = await new Promise((resolve, reject) => {
        const req = request(`${base}/v1/stores/scratch.git/info/lfs/objects/${oid}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${TOKENS.writer}`, "Transfer-Encoding": "chunked" },
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
        req.write("chun");
        req.end("ked");
      });
      expect(status).toBe(411);
      expect(existsSync(casObjectPath(store.lfsObjects, oid))).toBe(false);
      expect(readdirSync(store.lfsIncoming)).toEqual([]);
    });

    it("two LFS uploads at once cannot both spend the same free space: each PUT reserves its size", async () => {
      const result = await raceLfsReserve({ base, store: "scratch", token: TOKENS.writer, storeRoot: store.root, reserveBytes: baseConfig.diskReserveGB * 1e9 });
      expect(result.steps.filter((s) => !s.pass), JSON.stringify(result.steps)).toEqual([]);
      expect(readdirSync(store.lfsIncoming)).toEqual([]);
    });

    it("an LFS upload whose bytes do not hash to the oid is refused and leaves nothing", async () => {
      const oid = createHash("sha256").update("real").digest("hex");
      const res = await http(`/v1/stores/scratch.git/info/lfs/objects/${oid}`, { method: "PUT", token: TOKENS.writer, body: "fake" });
      expect(res.status).toBe(422);
      expect(existsSync(casObjectPath(store.lfsObjects, oid))).toBe(false);
      expect(readdirSync(store.lfsIncoming)).toEqual([]);
      const ok = await http(`/v1/stores/scratch.git/info/lfs/objects/${oid}`, { method: "PUT", token: TOKENS.reader, body: "real" });
      expect(ok.status).toBe(403);
    });
  });
});

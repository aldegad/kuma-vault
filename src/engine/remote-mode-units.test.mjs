// Remote-mode engine pieces that need no server: registry v2 + `vault store`, the secret-directory
// predicate, the reject-list generator, the PDF sidecar on an LFS pointer, lint over pointers
// and sync-conflict copies, the locked ledger rewrite, and the commit-map lookup.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anchorPatternsToTree, compileGitignore } from "../server/gitignore-match.mjs";
import { renderLfsPointer } from "../server/lfs-paths.mjs";
import { crossesSecretDir } from "../server/secret-dirs.mjs";
import { foldGitignoreDecisions, renderRootGitignore } from "../cli/policy-commands.mjs";
import { lookupCommitMap, parseCommitMap, reverseCommitMap } from "./commit-map.mjs";
import { lockPathFor } from "./file-commit-lock.mjs";
import { runVaultLifecycleHook } from "./vault-lifecycle-hook.mjs";
import { lintVaultFiles } from "./vault-lint.mjs";
import { syncVaultSidecars } from "./vault-sidecar.mjs";
import { loadStoreRegistry, parseStoreRegistry } from "./vault-stores.mjs";

const VAULT_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vault");
let root;

function vault(args, env = {}) {
  const r = spawnSync(VAULT_BIN, args, {
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, ...env },
  });
  return { code: r.status, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
}

function tree(id) {
  const dir = join(root, id, "vault");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vault.config.json"), JSON.stringify({ id, profile: "kuma-vault" }));
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kv-remote-units-"));
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("store registry v2", () => {
  it("reads v1 strings as local stores and validates v2 entries strictly", () => {
    const v1 = parseStoreRegistry({ stores: { "kuma-brain": "/x/vault" } });
    expect(v1.entries.get("kuma-brain")).toEqual({ root: "/x/vault", mode: "local" });
    const v2 = parseStoreRegistry({
      version: 2,
      default: "kuma-main-vault",
      stores: {
        "kuma-main-vault": { root: "/x/vault", mode: "remote", remote: { server: "http://srv.ts.net:7741/", store: "kuma-main-vault" }, lfsCacheMaxGB: 10 },
        "other-store": { root: "/y", mode: "local" },
      },
    });
    expect(v2.entries.get("kuma-main-vault")).toEqual({
      root: "/x/vault",
      mode: "remote",
      remote: { server: "http://srv.ts.net:7741", store: "kuma-main-vault" },
      lfsCacheMaxGB: 10,
    });
    const bad = [
      { version: 2, stores: { a: { root: "/x", mode: "remote" } } },
      { version: 2, stores: { a: { root: "/x", search: "fts" } } },
      { version: 2, stores: { a: { root: "/x", mode: "remote", remote: { server: "ftp://h", store: "a" } } } },
      { version: 2, stores: { a: { root: "/x", mode: "remote", remote: { server: "http://u:p@h", store: "a" } } } },
      { version: 2, stores: { a: { root: "/x", colour: "red" } } },
      { version: 2, default: "b", stores: { a: { root: "/x" } } },
      { version: 3, stores: {} },
      { version: 1, stores: { a: { root: "/x" } } },
    ];
    for (const doc of bad) expect(() => parseStoreRegistry(doc)).toThrow();
  });

  it("vault store add/set/rename/rm write v2 under the tree's own id", () => {
    const registry = join(root, "stores.json");
    writeFileSync(registry, JSON.stringify({ stores: { legacy: tree("legacy") } }));
    const env = { KUMA_VAULT_STORES: registry };
    const brain = tree("kuma-brain");
    expect(vault(["store", "add", "kuma-brain", "--root", brain, "--default"], env).code).toBe(0);
    let doc = JSON.parse(readFileSync(registry, "utf8"));
    expect(doc).toMatchObject({ version: 2, default: "kuma-brain", stores: { legacy: { mode: "local" }, "kuma-brain": { root: brain, mode: "local" } } });
    expect(doc.stores["kuma-brain"]).not.toHaveProperty("search");

    expect(vault(["store", "set", "kuma-brain", "--mode", "remote", "--server", "http://srv:7741", "--lfs-cache-max-gb", "5"], env).code).toBe(0);
    doc = JSON.parse(readFileSync(registry, "utf8"));
    expect(doc.stores["kuma-brain"]).toMatchObject({ mode: "remote", remote: { server: "http://srv:7741", store: "kuma-brain" }, lfsCacheMaxGB: 5 });
    expect(doc.stores["kuma-brain"]).not.toHaveProperty("search");

    // the tree owns the id: renaming to an id the tree does not declare is refused
    const refused = vault(["store", "rename", "kuma-brain", "kuma-main-vault"], env);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('declares id "kuma-brain"');
    const renamed = tree("kuma-main-vault");
    const ok = vault(["store", "rename", "kuma-brain", "kuma-main-vault", "--root", renamed], env);
    expect(ok.code, ok.stderr).toBe(0);
    doc = JSON.parse(readFileSync(registry, "utf8"));
    expect(doc.default).toBe("kuma-main-vault");
    expect(doc.stores["kuma-main-vault"]).toMatchObject({ root: renamed, mode: "remote" });
    expect(doc.stores["kuma-brain"]).toBeUndefined();

    expect(vault(["store", "add", "x", "--root", tree("y")], env).code).not.toBe(0);
    expect(vault(["store", "rm", "legacy"], env).code).toBe(0);
    const listed = vault(["store", "list"], env);
    expect(listed.stdout).toContain("kuma-main-vault (default)\tremote");
    expect(loadStoreRegistry(env).stores.get("kuma-main-vault")).toMatchObject({ status: "ok", mode: "remote" });
    expect(existsSync(lockPathFor(registry))).toBe(false);
  });
});

describe("retired registry search key", () => {
  it("is read and kept, named by vault store list/show, and removed only by --clear-search", () => {
    const registry = join(root, "legacy-search.json");
    const brain = tree("legacy-brain");
    writeFileSync(registry, JSON.stringify({ version: 2, stores: { "legacy-brain": { root: brain, mode: "local", search: "local" } } }));
    const env = { KUMA_VAULT_STORES: registry };
    expect(loadStoreRegistry(env).invalid).toBeNull();

    const notice = "legacy-brain: legacy search field ignored (remove with `vault store set legacy-brain --clear-search`)";
    expect(vault(["store", "list"], env).stdout).toContain(notice);
    expect(vault(["store", "show", "legacy-brain"], env).stdout).toContain(notice);

    // another change leaves it as written
    expect(vault(["store", "set", "legacy-brain", "--lfs-cache-max-gb", "3"], env).code).toBe(0);
    expect(JSON.parse(readFileSync(registry, "utf8")).stores["legacy-brain"]).toMatchObject({ search: "local", lfsCacheMaxGB: 3 });

    const cleared = vault(["store", "set", "legacy-brain", "--clear-search"], env);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(JSON.parse(readFileSync(registry, "utf8")).stores["legacy-brain"]).not.toHaveProperty("search");
    expect(vault(["store", "list"], env).stdout).not.toContain("legacy search field");
    expect(vault(["store", "add", "x", "--root", tree("x"), "--search", "local"], env).code).not.toBe(0);
  });
});

describe("secret directories", () => {
  it("_credentials/_sync-conflicts match at any depth and case, and only as whole components", () => {
    for (const path of ["_credentials/k.md", "domains/_Credentials/k.md", "_sync-conflicts/2026/plans/p.md", "domains/_SYNC-CONFLICTS/p.md", "x/_credentials"]) {
      expect([path, crossesSecretDir(path)]).toEqual([path, true]);
    }
    for (const path of ["domains/a.md", "domains/_credentials-notes.md"]) {
      expect([path, crossesSecretDir(path)]).toEqual([path, false]);
    }
  });
});

describe("binaries.reject generator", () => {
  it("re-anchors tree-relative patterns at the tree for the repo root and the server", () => {
    const tree = ["projects/demo-app/_assets/**/canvas/**", "domains/**/_assets/**/node_modules/**", "*.tmp", "canvas/", "/top.png"];
    const repo = anchorPatternsToTree(tree, "vault");
    expect(repo).toEqual([
      "vault/projects/demo-app/_assets/**/canvas/**",
      "vault/domains/**/_assets/**/node_modules/**",
      "vault/**/*.tmp",
      "vault/**/canvas/",
      "vault/top.png",
    ]);
    const treeMatch = compileGitignore(tree, { ignoreCase: true });
    const repoMatch = compileGitignore(repo, { ignoreCase: true });
    for (const path of ["projects/demo-app/_assets/run/canvas/a.png", "domains/x/_assets/y/node_modules/m.js", "a/b.tmp", "q/canvas/z.png", "top.png", "domains/top.png", "projects/other/canvas.md"]) {
      expect([path, Boolean(repoMatch(`vault/${path}`))]).toEqual([path, Boolean(treeMatch(path))]);
    }
    expect(repoMatch("other/projects/demo-app/_assets/run/canvas/a.png")).toBeNull();
    expect(repoMatch("vault-other/a.tmp")).toBeNull();
    expect(() => anchorPatternsToTree(["!keep.png"], "vault")).toThrow(/negation/);
  });

  it("folds sub-.gitignore decisions and rewrites the generated blocks idempotently", () => {
    const top = join(root, "gen");
    const sub = "vault/domains/sns/_assets/s/src";
    mkdirSync(join(top, sub), { recursive: true });
    writeFileSync(join(top, sub, ".gitignore"), "node_modules/\nrenders/\n");
    mkdirSync(join(top, "vault/projects/p"), { recursive: true });
    writeFileSync(join(top, "vault/projects/p/.gitignore"), "# promo\nbg/\nthumb/_plate.png\n_sources/docs/\n");
    const rows = [
      { ignore_file: `${sub}/.gitignore`, rule: "node_modules/", decision: "reject로 올림" },
      { ignore_file: `${sub}/.gitignore`, rule: "renders/", decision: "reject로 올림" },
      { ignore_file: "vault/projects/p/.gitignore", rule: "bg/", decision: "reject로 올림" },
      { ignore_file: "vault/projects/p/.gitignore", rule: "thumb/_plate.png", decision: "reject로 올림" },
      { ignore_file: "vault/projects/p/.gitignore", rule: "_sources/docs/", decision: "하위 줄 삭제 권고" },
    ];
    const folded = foldGitignoreDecisions(rows, { repoTop: top, treePrefix: "vault/" });
    expect(folded.added).toEqual([
      "domains/sns/_assets/s/src/**/node_modules/",
      "domains/sns/_assets/s/src/**/renders/",
      "projects/p/**/bg/",
      "projects/p/thumb/_plate.png",
    ]);
    expect(folded.edits.get(`${sub}/.gitignore`)).toBeNull();
    expect(folded.edits.get("vault/projects/p/.gitignore")).toBeNull();
    // the promoted rule means what the sub-.gitignore meant
    const match = compileGitignore(folded.added, { ignoreCase: true });
    expect(match("projects/p/x/bg/1.png")).toBeTruthy();
    expect(match("projects/p/thumb/_plate.png")).toBeTruthy();
    expect(match("projects/p/x/thumb/_plate.png")).toBeNull();
    expect(() => foldGitignoreDecisions([{ ...rows[0], rule: "nope/" }], { repoTop: top, treePrefix: "vault/" })).toThrow(/stale/);

    const once = renderRootGitignore(".env\n.env.*\n", { junk: ["*.tmp"], reject: ["vault/a/**"] });
    const twice = renderRootGitignore(once, { junk: ["*.tmp"], reject: ["vault/a/**", "vault/b/**"] });
    expect(once.startsWith(".env\n.env.*\n")).toBe(true);
    expect(twice.match(/kuma-vault generated: binaries.reject — /g)).toHaveLength(1);
    expect(twice).toContain("vault/b/**");
    expect(renderRootGitignore(twice, { junk: ["*.tmp"], reject: ["vault/a/**", "vault/b/**"] })).toBe(twice);
  });

  it("vault binaries apply writes vault.config.json and the root .gitignore", () => {
    const top = join(root, "apply");
    mkdirSync(join(top, "vault"), { recursive: true });
    spawnSync("git", ["init", "--quiet", top]);
    writeFileSync(join(top, "vault", "vault.config.json"), JSON.stringify({ id: "apply", profile: "kuma-vault" }));
    writeFileSync(join(top, ".gitignore"), ".env\n");
    writeFileSync(join(root, "reject.json"), JSON.stringify({ reject: ["projects/x/frames/**"] }));
    const out = vault(["binaries", "apply", "--from", join(root, "reject.json"), "--root", join(top, "vault")]);
    expect(out.code, out.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(top, "vault", "vault.config.json"), "utf8")).binaries).toEqual({ reject: ["projects/x/frames/**"] });
    const gitignore = readFileSync(join(top, ".gitignore"), "utf8");
    expect(gitignore).toContain("vault/projects/x/frames/**");
    expect(gitignore).toContain("*.commit-lock");
    expect(spawnSync("git", ["-C", top, "check-ignore", "-q", "vault/projects/x/frames/0.png"]).status).toBe(0);
    expect(spawnSync("git", ["-C", top, "check-ignore", "-q", "projects/x/frames/0.png"]).status).not.toBe(0);
    expect(JSON.parse(out.stdout).server).toContain("--tree-prefix vault");
    expect(readFileSync(join(top, "vault", ".rgignore"), "utf8")).toContain("_[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS]");

    // the server takes the same list from vault.config.json, re-anchored at the tree
    const serverConfig = join(root, "server.json");
    writeFileSync(serverConfig, JSON.stringify({ version: 1, listen: ["127.0.0.1:0"], dataDir: join(root, "srv"), stores: { apply: { path: join(root, "srv", "apply") } } }));
    const set = spawnSync(process.execPath, [join(dirname(VAULT_BIN), "..", "src", "server", "server-cli.mjs"), "server", "set-reject", "--store", "apply", "--from", join(top, "vault", "vault.config.json"), "--tree-prefix", "vault", "--config", serverConfig]);
    expect(set.status, set.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(serverConfig, "utf8")).stores.apply.binaries.reject).toEqual(["vault/projects/x/frames/**"]);
  });
});

describe("large files as LFS pointers", () => {
  it("a PDF that is a pointer is in sync with a sidecar stamped with its oid, and refuses extraction otherwise", async () => {
    const dir = tree("pdfs");
    const pdf = Buffer.from("%PDF-1.4 fake bytes");
    const oid = createHash("sha256").update(pdf).digest("hex");
    writeFileSync(join(dir, "doc.pdf"), renderLfsPointer(oid, pdf.length));
    writeFileSync(join(dir, "doc.pdf.md"), `---\ntitle: doc.pdf\nkind: sidecar\nsource: doc.pdf\nsha256: ${oid}\nextractor: kordoc@test\n---\n\n# doc.pdf\n`);
    const inSync = await syncVaultSidecars({ vaultDir: dir, check: true });
    expect(inSync).toMatchObject({ regeneratedCount: 0, skippedCount: 1, failedCount: 0 });
    writeFileSync(join(dir, "doc.pdf"), renderLfsPointer("0".repeat(64), 5));
    const stale = await syncVaultSidecars({ vaultDir: dir, check: false });
    expect(stale.failed[0].error).toContain("LFS pointer");
    expect(readFileSync(join(dir, "doc.pdf.md"), "utf8")).toContain(oid);
  });

  it("lint: links to pointer files resolve (the path exists); sync-conflict copies are not linted", () => {
    const dir = tree("linty");
    mkdirSync(join(dir, "domains", "d", "_assets"), { recursive: true });
    writeFileSync(join(dir, "domains", "d", "_assets", "pic.png"), renderLfsPointer("a".repeat(64), 10));
    writeFileSync(join(dir, "domains", "d", "page.md"), "---\ntitle: Page\ndescription: p\n---\n\n![pic](_assets/pic.png)\n");
    mkdirSync(join(dir, "_sync-conflicts", "20261005-mbp", "domains"), { recursive: true });
    writeFileSync(join(dir, "_sync-conflicts", "20261005-mbp", "domains", "copy.md"), "[broken](nowhere/at/all.md)\n");
    const result = lintVaultFiles({ vaultDir: dir, mode: "full" });
    const messages = (result.issues ?? []).map((i) => `${i.file} ${i.message}`).join("\n");
    expect(messages).not.toContain("pic.png");
    expect(messages).not.toContain("_sync-conflicts");
  });
});

describe("dispatch ledger rewrite holds the shared commit lock", () => {
  function setup(name) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dispatch-log.md"), "---\ntitle: Dispatch Log\nupdated: x\n---\n\n## Entries\n\n- 2026-01-01 | task_id=old | state=dispatched\n");
    const taskFile = join(dir, "t.task.md");
    writeFileSync(taskFile, "---\nid: t-1\nproject: p\nworker: w\n---\n# t\n");
    return { dir, taskFile };
  }

  it("writes under the lock and leaves no lock behind", async () => {
    const { dir, taskFile } = setup("ledger-ok");
    const out = await runVaultLifecycleHook({ event: "dispatched", taskFile, vaultDir: dir });
    expect((out.warnings ?? []).map((w) => w.key)).not.toContain("dispatch-log.md:locked");
    const text = readFileSync(join(dir, "dispatch-log.md"), "utf8");
    expect(text).toContain("task_id=old");
    expect(text).toContain("task_id=t-1");
    expect(existsSync(lockPathFor(join(dir, "dispatch-log.md")))).toBe(false);
  });

  it("a held lock leaves the ledger untouched and says so", async () => {
    const { dir, taskFile } = setup("ledger-held");
    const lock = lockPathFor(join(dir, "dispatch-log.md"));
    writeFileSync(lock, JSON.stringify({ pid: 1, token: "other" }));
    const before = readFileSync(join(dir, "dispatch-log.md"), "utf8");
    const out = await runVaultLifecycleHook({ event: "dispatched", taskFile, vaultDir: dir });
    expect(readFileSync(join(dir, "dispatch-log.md"), "utf8")).toBe(before);
    expect(out.warnings.map((w) => w.key)).toContain("dispatch-log.md:locked");
    expect(existsSync(lock)).toBe(true);
  }, 15_000);
});

describe("commit map", () => {
  it("parses filter-repo's file, reverses, and looks prefixes up both ways", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const map = parseCommitMap(`old new\n${a} ${b}\n${"c".repeat(40)} ${"0".repeat(40)}\n`);
    expect([...map]).toEqual([[a, b]]);
    expect([...reverseCommitMap(map)]).toEqual([[b, a]]);
    expect(lookupCommitMap(map, "aaaaaaa")).toEqual([{ old: a, new: b }]);
    expect(lookupCommitMap(map, "bbbbbbb")).toEqual([{ old: a, new: b }]);
    expect(() => parseCommitMap(`${a} ${b}\n${a} ${b}\n`)).toThrow(/twice/);
    expect(() => parseCommitMap("x y\n")).toThrow();
    const mapFile = join(root, "map.tsv");
    writeFileSync(mapFile, `${a}\t${b}\n`);
    const out = vault(["commit-map", "aaaaaaaa", "--map", mapFile]);
    expect(out.stdout.trim()).toBe(`${a} ${b}`);
    expect(vault(["commit-map", "deadbeef", "--map", mapFile]).code).not.toBe(0);
  });
});

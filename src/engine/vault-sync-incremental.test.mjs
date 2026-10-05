import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { runVaultSync, vaultSyncExitCode } from "./vault-sync-pipeline.mjs";
import { SIDECAR_EXTRACTORS } from "./vault-sidecar.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const page = (description) => `---\ntitle: Entry\ndescription: ${description}\n---\n# Entry\n\n${description}\n`;
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-scope-")); roots.push(root);
  const put = (path, content) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), content); };
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  put("vault.config.json", JSON.stringify({ profile: "kuma-vault", canonicalChecks: false, enforcePageFrontmatter: false, schema: { path: "rules.md", validateSpecialFiles: false, autoScaffold: false } }));
  put("a/deep/page.md", page("before")); put("b/page.md", page("other"));
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await runVaultSync({ vaultDir: root });
  git("add", "."); git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "baseline");
  const sync = (options = {}) => runVaultSync({ vaultDir: root, check: true, ...options });
  return { root, put, git, sync };
}
const judgement = (r) => ({ code: vaultSyncExitCode(r), changed: r.changed, sidecars: r.sidecars.regenerated, stale: r.lint.staleIndexRegionCount });

it.each(["description", "addition", "deletion", "rename", "readme"])("matches full gate for %s and its ancestor dependencies", async (kind) => {
  const f = await fixture();
  if (kind === "description") f.put("a/deep/page.md", page("after"));
  if (kind === "addition") f.put("a/new/entry.md", page("new"));
  if (kind === "deletion") rmSync(join(f.root, "a/deep/page.md"));
  if (kind === "rename") f.git("mv", "a/deep/page.md", "b/moved.md");
  if (kind === "readme") f.put("a/deep/README.md", readFileSync(join(f.root, "a/deep/README.md"), "utf8").replace("status: active", "status: active\ndescription: Changed folder description"));
  const incremental = await f.sync({ incremental: true });
  expect(judgement(incremental)).toEqual(judgement(await f.sync()));
  expect(vaultSyncExitCode(incremental)).toBe(1);
  await f.sync({ check: false, incremental: true });
  expect(vaultSyncExitCode(await f.sync())).toBe(0);
});

it("does zero derivation work without changes; full finds unrelated pre-existing drift", async () => {
  const f = await fixture();
  const empty = await f.sync({ incremental: true });
  expect([empty.total, empty.sidecars.total, empty.lint.checkedCount]).toEqual([0, 0, 0]);
  f.put("b/page.md", page("old drift")); f.git("add", "."); f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "preexisting drift");
  f.put("a/deep/page.md", page("new edit"));
  const inc = await f.sync({ incremental: true });
  expect(inc.changed.map((c) => c.path)).not.toContain("b/README.md");
  expect((await f.sync()).changed.map((c) => c.path)).toContain("b/README.md");
});

it("checks changed binary, edited/deleted sidecar, and deleted binary orphan without hashing unrelated sources", async () => {
  const f = await fixture();
  const original = SIDECAR_EXTRACTORS.get(".pdf");
  SIDECAR_EXTRACTORS.set(".pdf", async () => ({ text: "Extracted text", warnings: [], extractor: "fixture" }));
  try {
    f.put("a/deep/file.pdf", "binary one"); f.put("b/other.pdf", "binary two");
    await f.sync({ check: false }); f.git("add", "."); f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "sources");
    f.put("a/deep/file.pdf", "changed binary");
    const inc = await f.sync({ incremental: true });
    expect(inc.sidecars.total).toBe(1); expect(judgement(inc)).toEqual(judgement(await f.sync()));
    await f.sync({ check: false, incremental: true });
    rmSync(join(f.root, "a/deep/file.pdf.md"));
    expect((await f.sync({ incremental: true })).sidecars.regeneratedCount).toBe(1);
    await f.sync({ check: false, incremental: true });
    rmSync(join(f.root, "a/deep/file.pdf"));
    expect((await f.sync({ incremental: true })).sidecars.orphans).toEqual(["a/deep/file.pdf.md"]);
  } finally { SIDECAR_EXTRACTORS.set(".pdf", original); }
});

it("promotes declaration, attributes, rules, unknown paths and first git pass with observable reasons", async () => {
  const f = await fixture();
  for (const path of ["vault.config.json", ".gitattributes", "rules.md"]) {
    const report = await f.sync({ changedPaths: [path] });
    expect(report.scope).toMatchObject({ mode: "full", reason: `contract-changed:${path}` });
  }
  expect((await f.sync({ changedPaths: null })).scope.mode).toBe("full");
  expect((await f.sync({ changedPaths: [], full: true })).scope.reason).toBe("explicit-full");
  rmSync(join(f.root, ".git"), { recursive: true });
  expect((await f.sync({ incremental: true })).scope.reason).toBe("no-git-baseline");
});

it("includes staged edits even when worktree restores the HEAD bytes", async () => {
  const f = await fixture();
  f.put("a/deep/page.md", page("staged")); f.git("add", "a/deep/page.md"); f.put("a/deep/page.md", page("before"));
  expect((await f.sync({ incremental: true })).scope.paths).toContain("a/deep/page.md");
});

// Rollout contract: callers installed before incremental support keep full semantics.
it("accepts old hook and daemon argv, and new NUL paths without splitting spaces or newlines", async () => {
  const f = await fixture();
  const bin = new URL("../../bin/vault", import.meta.url).pathname;
  const call = (args, input) => spawnSync(bin, ["sync", "--root", f.root, "--json", ...args], { cwd: f.root, input, encoding: "utf8" });
  f.put("b/page.md", page("drift"));
  const oldHook = call(["--check"]);
  expect(oldHook.status).toBe(1);
  expect(JSON.parse(oldHook.stdout).scope.mode).toBe("full");
  const oldDaemon = call([]);
  expect(oldDaemon.status).toBe(0);
  expect(JSON.parse(oldDaemon.stdout).scope.mode).toBe("full");
  f.put("a/deep/a space.md", page("space"));
  f.put("a/deep/a\nnewline.md", page("newline"));
  const paths = ["a/deep/a space.md", "a/deep/a\nnewline.md"];
  const newDaemon = call(["--changed-paths-from", "-"], `${paths.join("\0")}\0`);
  expect(newDaemon.status).toBe(0);
  expect(JSON.parse(newDaemon.stdout).scope.paths).toEqual([...paths].sort());
  expect(vaultSyncExitCode(await f.sync())).toBe(0);
});

it.each(["add", "delete"])("includes another folder's index when a description link target is %s", async (change) => {
  const f = await fixture();
  f.put("b/page.md", page("See [target](../a/target.md)."));
  if (change === "delete") f.put("a/target.md", page("target"));
  await f.sync({ check: false }); f.git("add", "."); f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "link baseline");
  if (change === "delete") rmSync(join(f.root, "a/target.md"));
  else f.put("a/target.md", page("target"));
  const inc = await f.sync({ incremental: true });
  expect(inc.changed.map((entry) => entry.path)).toContain("b/README.md");
  expect(judgement(inc)).toEqual(judgement(await f.sync()));
  await f.sync({ check: false, incremental: true });
  expect(vaultSyncExitCode(await f.sync())).toBe(0);
});

// A child timeout is the boundary under test: a synchronous ancestor loop would
// prevent the test runner's own timeout from firing in the same process.
it.each(["add", "delete"])("relative API root terminates with the absolute result for %s", async (change) => {
  const f = await fixture();
  if (change === "add") f.put("a/new.md", page("new"));
  else rmSync(join(f.root, "a/deep/page.md"));
  const expected = await f.sync({ incremental: true });
  const module = new URL("./vault-sync-pipeline.mjs", import.meta.url).href;
  const script = `import { runVaultSync } from ${JSON.stringify(module)};
    process.stdout.write(JSON.stringify(await runVaultSync({ vaultDir: process.argv[1], check: true, incremental: true })));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, basename(f.root)], {
    cwd: dirname(f.root), encoding: "utf8", timeout: 5000,
  });
  expect(child.error, `relative-root child: ${child.error?.code}; ${child.stderr}`).toBeUndefined();
  expect(child.status).toBe(0);
  const actual = JSON.parse(child.stdout);
  expect(actual.vaultDir).toBe(expected.vaultDir);
  expect(actual.scope).toEqual(expected.scope);
  expect(judgement(actual)).toEqual(judgement(expected));
  expect(actual.total).toBe(expected.total);
}, 15_000);

it("ancestor discovery stops when a topology target is outside the root", async () => {
  const f = await fixture();
  const module = new URL("./vault-ingest.mjs", import.meta.url).href;
  const script = `import { affectedVaultReadmes } from ${JSON.stringify(module)};
    process.stdout.write(JSON.stringify(await affectedVaultReadmes(process.argv[1], [], { topologyPaths: ["../outside.md"] })));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.root], {
    encoding: "utf8", timeout: 5000,
  });
  expect(child.error, `outside-root child: ${child.error?.code}; ${child.stderr}`).toBeUndefined();
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual([]);
}, 15_000);

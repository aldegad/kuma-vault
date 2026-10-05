// Autosave blocked under one declaration, then the tree's `vault.config.json` changes.
//
// The gate (`vault sync --check`, run by the pre-commit hook) reads the declaration afresh on every
// run, and reads it more than once in a run: the contract it resolved first must be the one the
// tree declares when the pipeline asks again. A declaration edited while the gate reads it is
// refused ("The contract passed for … is not the one its vault.config.json declares") — loudly, as
// it should. The block that refusal leaves must not outlive the declaration it was made under: the
// next pass asks the gate again under the declaration that now stands, instead of waiting
// `gateRetryMs` or a daemon restart. Here the edit is made deterministic: the hook's `vault` loads
// a module that rewrites the declaration right after the gate's first read of it, as a person
// saving the file at that moment would.
//
// Pinned: a block made under one declaration is asked again at the next tick once the declaration
// changes, and the commit goes through; a declaration that is still wrong is refused again with its
// own reason, and nothing is committed under the one before it; an unchanged declaration still
// waits `gateRetryMs` (autosave-drift.integration.test.mjs). Needs git >= 2.38, git-lfs, Node 22.
// See docs/sync.md.

import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VAULT_BIN, createWorld, fixtureAttributes, fixtureGitignore, removeWorld, startServe } from "../../scripts/test/sync-harness.mjs";
import { loadContext } from "./context.mjs";
import { createMemory, runTick } from "./daemon.mjs";

const MIN = 60_000;
const DECLARATION = "vault/vault.config.json";
const declared = (extra = {}) => `${JSON.stringify({ profile: "kuma-vault", binaries: { reject: [] }, ...extra }, null, 2)}\n`;

let world;
let serve;
let url;
let dir;
let env;

const git = (args, opts) => world.git(dir, args, opts);
const tracked = (rel) => git(["ls-files", "--error-unmatch", "--", rel], { allowFail: true }).code === 0;

/** A quiet page for the autosave to collect: written `ageMs` before `now`. */
function quietPage(stem, now, ageMs = 5 * MIN) {
  const rel = `vault/domains/notes/${stem}.md`;
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\ntitle: ${stem}\ndescription: quiet note ${stem}\n---\n\n# ${stem}\n`);
  utimesSync(abs, new Date(now - ageMs), new Date(now - ageMs));
  return rel;
}

/**
 * The hook's `vault`: on its first run, the gate's process rewrites the declaration with `next`
 * right after its first read of it — the declaration is edited while the gate reads it. Later runs
 * are the plain engine. Returns how many runs were made.
 */
function editedWhileGateReads(name, next) {
  const counter = join(world.root, `${name}.calls`);
  const nextFile = join(world.root, `${name}.next.json`);
  writeFileSync(nextFile, next);
  const preload = join(world.root, `${name}.preload.mjs`);
  writeFileSync(preload, `import fs from "node:fs";
import { resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const target = resolve(${JSON.stringify(join(dir, DECLARATION))});
const read = fs.readFileSync;
let edited = false;
fs.readFileSync = function readFileSync(path, ...rest) {
  const out = read.call(this, path, ...rest);
  if (!edited && typeof path === "string" && resolve(path) === target) {
    edited = true;
    fs.writeFileSync(target, read(${JSON.stringify(nextFile)}));
  }
  return out;
};
syncBuiltinESMExports();
`);
  const bin = join(world.root, name);
  writeFileSync(bin, `#!/bin/sh
n=$(cat "${counter}" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "${counter}"
if [ "$n" -eq 1 ]; then NODE_OPTIONS="--import=${pathToFileURL(preload).href}" exec "${VAULT_BIN}" "$@"; fi
exec "${VAULT_BIN}" "$@"
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(counter) ? Number(readFileSync(counter, "utf8").trim()) : 0) };
}

/** A daemon of this clone, with its own memory and log. */
async function daemon() {
  const ctx = await loadContext(dir, { env });
  const mem = createMemory(ctx);
  const rows = [];
  return {
    rows,
    events: (name) => rows.filter((r) => r.event === name),
    tick: ({ now = Date.now(), force = false } = {}) => runTick(ctx, mem, { now, force, log: (row) => rows.push(row) }),
  };
}

/** Commit the declaration as it stands, as its editor would (through the plain gate). */
function commitDeclaration(message) {
  git(["commit", "--quiet", "--only", "-m", message, "--", DECLARATION]);
}

beforeAll(async () => {
  world = createWorld("kv-sync-decl-");
  serve = await startServe(world, { reject: [] });
  url = `http://127.0.0.1:${serve.port}/v1/stores/s.git`;
  const seed = join(world.root, "seed");
  world.sh(VAULT_BIN, ["clone", url, seed, "--token-file", join(world.root, "token"), "--no-hook"]);
  const put = (rel, data) => {
    mkdirSync(dirname(join(seed, rel)), { recursive: true });
    writeFileSync(join(seed, rel), data);
  };
  put(".gitattributes", fixtureAttributes("vault"));
  put(".gitignore", fixtureGitignore({ tree: "vault", reject: [] }));
  put(DECLARATION, declared());
  put("vault/README.md", "# Vault\n");
  put("vault/domains/notes/seed.md", "---\ntitle: Seed\ndescription: seed note\n---\n\n# Seed\n");
  world.sh(VAULT_BIN, ["sync", "--no-fts", "--root", join(seed, "vault")]);
  world.git(seed, ["add", "-A"]);
  world.git(seed, ["commit", "--quiet", "-m", "fixture"]);
  world.git(seed, ["push", "--quiet", "origin", "HEAD:main"]);

  dir = join(world.root, "a");
  env = { ...process.env, ...world.env, KUMA_VAULT_SYNC_DIR: join(world.root, "state-a") };
  world.sh(VAULT_BIN, ["clone", url, dir, "--token-file", join(world.root, "token")], { extraEnv: env });
  git(["config", "kuma-vault.host", "a"]);
}, 120_000);

afterAll(async () => {
  await serve?.stop();
  removeWorld(world);
});

describe.sequential("autosave blocked under one declaration, then the declaration changes", { timeout: 240_000 }, () => {
  it("a declaration edited while the gate reads it: refused, and asked again at the next tick once the edit is committed", async () => {
    const hook = editedWhileGateReads("vault-decl-edit", declared({ enrichExclude: ["/decisions.md"] }));
    git(["config", "kuma-vault.bin", hook.bin]);
    try {
      const d = await daemon();
      const t0 = Date.now();
      const note = quietPage("d1", t0);

      // the incident: the gate's contract and the declaration it then reads are two versions
      const first = await d.tick({ now: t0 });
      expect(hook.calls()).toBe(1);
      expect(tracked(note)).toBe(false);
      expect(first.status.autosaveBlocked).toMatch(
        /^자동 저장 막힘: The contract passed for .* \(kuma-vault\) is not the one its vault\.config\.json declares \(kuma-vault\)/,
      );
      expect(d.events("autosave-blocked")).toEqual([expect.objectContaining({ pass: "autosave", reason: "refused" })]);
      expect(readFileSync(join(dir, DECLARATION), "utf8")).toContain("enrichExclude"); // the edit landed

      // its editor commits it; the next tick is a minute later, well within gateRetryMs
      commitDeclaration("vault: declare enrichExclude");
      const next = await d.tick({ now: t0 + MIN });
      expect(tracked(note)).toBe(true);
      expect(next.status.autosaveBlocked).toBeNull();
      const [unblocked] = d.events("autosave-unblocked");
      expect(unblocked).toMatchObject({ pass: "autosave", refusals: 1, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
      expect(world.sh(VAULT_BIN, ["sync", "--check", "--root", join(dir, "vault")], { allowFail: true }).code).toBe(0);
    } finally {
      git(["config", "kuma-vault.bin", VAULT_BIN]);
    }
  });

  it("a declaration that is still wrong is refused again with its own reason; nothing is committed under the one before", async () => {
    const before = readFileSync(join(dir, DECLARATION), "utf8");
    const d = await daemon();
    const t0 = Date.now();
    const note = quietPage("d2", t0);

    // a key the engine does not know: every run of the gate refuses it
    writeFileSync(join(dir, DECLARATION), declared({ enrichExclud: ["/decisions.md"] }));
    const first = await d.tick({ now: t0 });
    expect(tracked(note)).toBe(false);
    expect(first.status.autosaveBlocked).toMatch(/^자동 저장 막힘: .*enrichExclud\b/);
    expect(d.events("autosave-blocked")).toHaveLength(1);

    // changed, but still wrong: asked again at the next tick, and refused for the new reason
    writeFileSync(join(dir, DECLARATION), declared({ enrichExcludes: ["/decisions.md"] }));
    const second = await d.tick({ now: t0 + MIN });
    expect(tracked(note)).toBe(false);
    expect(second.status.autosaveBlocked).toMatch(/^자동 저장 막힘: .*enrichExcludes/);
    expect(d.events("autosave-blocked")).toHaveLength(2);
    expect(d.events("autosave")).toEqual([]);

    // unchanged and still wrong: the wait holds, no new attempt
    const third = await d.tick({ now: t0 + 2 * MIN });
    expect(third.status.autosaveBlocked).toMatch(/enrichExcludes/);
    expect(d.events("autosave-blocked")).toHaveLength(2);

    // put right: the next tick commits what waited
    writeFileSync(join(dir, DECLARATION), before);
    const fixed = await d.tick({ now: t0 + 3 * MIN });
    expect(fixed.status.autosaveBlocked).toBeNull();
    expect(tracked(note)).toBe(true);
    expect(d.events("autosave-unblocked")).toEqual([expect.objectContaining({ refusals: 2 })]);
    expect(git(["status", "--porcelain", "--", DECLARATION]).stdout.toString("utf8")).toBe("");
  });
});

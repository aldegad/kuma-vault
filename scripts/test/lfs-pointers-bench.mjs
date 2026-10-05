#!/usr/bin/env node
// CPU of the clone-side LFS lookups on a large synthetic clone (~120k pointers), for two
// engine trees (before / after a change). Linux only: the git children's CPU is read from
// /proc/self/stat (cutime + cstime), which counts every waited-for descendant, git-lfs included.
//
//   node scripts/test/lfs-pointers-bench.mjs build <dir> [--pointers 123000] [--texts 48000]
//   node scripts/test/lfs-pointers-bench.mjs run <dir> --engine <engine-root> [--label name]
//
// `build` makes <dir>/clone: LFS pointers (most without an object; HYDRATABLE of them with the
// object in the local LFS store, so `git lfs pull -I` checks them out without a server), plain
// text files, `lfs.fetchexclude=*`, an origin that does not answer. `run` measures, each in a
// fresh node process: `vault blob get` of one path and of 8 paths, `vault blob status`, a
// repeat of it, the same after one commit, the daemon's hourly trim under the cache limit, and
// the daemon's status scan. Every git the engine starts goes through a counting wrapper
// (KUMA_VAULT_GIT). Prints one JSON object.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HYDRATABLE = 64;
const CLK_TCK = 100;

function flag(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { maxBuffer: 1024 * 1024 * 1024, ...opts });
}

function pointerText(oid, size) {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}

function build(dir, { pointers, texts }) {
  const clone = join(dir, "clone");
  rmSync(clone, { recursive: true, force: true });
  mkdirSync(clone, { recursive: true });
  const git = (...args) => sh("git", args, { cwd: clone });
  git("init", "-q", "-b", "main");
  for (const [k, v] of [
    ["user.name", "bench"], ["user.email", "bench@example.invalid"], ["feature.manyFiles", "true"], ["index.skipHash", "false"],
    ["core.untrackedCache", "true"], ["lfs.fetchexclude", "*"], ["remote.origin.url", "http://127.0.0.1:9/v1/stores/bench.git"],
    ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], ["lfs.url", "http://127.0.0.1:9/v1/stores/bench.git/info/lfs"],
    ["kuma-vault.store", "bench"], ["kuma-vault.tree", "vault"],
  ]) git("config", k, v);
  git("lfs", "install", "--local", "--skip-smudge");

  // fast-import stream: one commit with every file
  const chunks = [];
  const blob = (mark, data) => chunks.push(Buffer.from(`blob\nmark :${mark}\ndata ${data.length}\n`), data, Buffer.from("\n"));
  const files = [];
  let mark = 1;
  const attrs = Buffer.from("*.png filter=lfs diff=lfs merge=lfs -text\n*.mp4 filter=lfs diff=lfs merge=lfs -text\n");
  blob(mark, attrs);
  files.push([".gitattributes", mark++]);
  const hydratable = [];
  for (let i = 0; i < pointers; i += 1) {
    const path = `vault/media/d${String(i % 500).padStart(3, "0")}/f${String(i).padStart(6, "0")}.${i % 7 === 0 ? "mp4" : "png"}`;
    let oid;
    let size;
    if (i < HYDRATABLE) {
      const bytes = randomBytes(2048 + i);
      oid = createHash("sha256").update(bytes).digest("hex");
      size = bytes.length;
      const dirPath = join(clone, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4));
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, oid), bytes);
      hydratable.push(path);
    } else {
      oid = randomBytes(32).toString("hex");
      size = 1000 + (i % 100000) * 37;
    }
    blob(mark, Buffer.from(pointerText(oid, size)));
    files.push([path, mark++]);
  }
  for (let i = 0; i < texts; i += 1) {
    const path = `vault/notes/d${String(i % 300).padStart(3, "0")}/n${String(i).padStart(6, "0")}.md`;
    blob(mark, Buffer.from(`# note ${i}\n\n${"lorem ipsum ".repeat(20 + (i % 200))}\n`));
    files.push([path, mark++]);
  }
  chunks.push(Buffer.from(`commit refs/heads/main\ncommitter bench <bench@example.invalid> 1790000000 +0000\ndata 5\nseed\n`));
  for (const [path, m] of files) chunks.push(Buffer.from(`M 100644 :${m} ${path}\n`));
  chunks.push(Buffer.from("\n"));
  sh("git", ["fast-import", "--quiet"], { cwd: clone, input: Buffer.concat(chunks) });
  sh("git", ["reset", "-q", "--hard", "main"], { cwd: clone, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });
  sh("git", ["update-ref", "refs/remotes/origin/main", "main"], { cwd: clone });
  writeFileSync(join(dir, "hydratable.json"), JSON.stringify(hydratable));
  return { clone, files: files.length, pointers, texts };
}

/** The wrapper every engine git goes through: one line per call, then the real git. */
function gitWrapper(dir) {
  const log = join(dir, "git-calls.log");
  const real = sh("sh", ["-c", "command -v git"]).toString().trim();
  const path = join(dir, "git-counting");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(path, 0o755);
  return { path, log };
}

function procCpu() {
  const stat = readFileSync("/proc/self/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // fields[11..14] = utime stime cutime cstime (stat fields 14-17)
  const [utime, stime, cutime, cstime] = fields.slice(11, 15).map(Number);
  return { selfS: (utime + stime) / CLK_TCK, childrenS: (cutime + cstime) / CLK_TCK };
}

/** Child mode: one scenario in this process, JSON on stdout. */
async function scenario(name, dir, engine) {
  const blob = await import(pathToFileURL(join(engine, "src/sync/blob.mjs")).href);
  const { loadContext } = await import(pathToFileURL(join(engine, "src/sync/context.mjs")).href);
  const { scanWorktree } = await import(pathToFileURL(join(engine, "src/sync/scan.mjs")).href);
  const clone = join(dir, "clone");
  const ctx = await loadContext(clone);
  const hydratable = JSON.parse(readFileSync(join(dir, "hydratable.json"), "utf8"));
  const used = existsSync(join(dir, "used.json")) ? JSON.parse(readFileSync(join(dir, "used.json"), "utf8")) : 0;
  const take = (n) => {
    const paths = hydratable.slice(used, used + n);
    if (paths.length < n) throw new Error("bench: out of hydratable paths — build again");
    writeFileSync(join(dir, "used.json"), JSON.stringify(used + n));
    return paths;
  };
  const api = { serverHas: async () => [], backupStatus: async () => null };
  const started = performance.now();
  const before = procCpu();
  let detail = null;
  if (name === "get-1" || name === "get-8") {
    const paths = take(name === "get-1" ? 1 : 8);
    detail = { fetched: (await blob.fetchLfsPaths(ctx, paths, { cwd: clone })).length };
  } else if (name.startsWith("status")) {
    const s = await blob.blobStatus(ctx, [], { cwd: clone });
    detail = { lfsFiles: s.lfsFiles, hydrated: s.hydrated };
  } else if (name === "evict-under-limit") {
    const r = await blob.blobEvict(ctx, api, {});
    detail = { evicted: r.evicted.length, cacheBytes: r.cacheBytes };
  } else if (name === "scan") {
    detail = { entries: (await scanWorktree(ctx.repo)).length };
  } else {
    throw new Error(`unknown scenario ${name}`);
  }
  const after = procCpu();
  return {
    scenario: name,
    wallS: Number(((performance.now() - started) / 1000).toFixed(3)),
    cpuSelfS: Number((after.selfS - before.selfS).toFixed(2)),
    cpuChildrenS: Number((after.childrenS - before.childrenS).toFixed(2)),
    detail,
  };
}

function commitOne(clone) {
  const oid = randomBytes(32).toString("hex");
  writeFileSync(join(clone, "vault", "media", "d000", "new.png"), pointerText(oid, 4242));
  sh("git", ["add", "vault/media/d000/new.png"], { cwd: clone, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });
  sh("git", ["commit", "-qm", "one more"], { cwd: clone });
}

function runAll(dir, engine, label) {
  const clone = join(dir, "clone");
  const { path: wrapper, log } = gitWrapper(dir);
  rmSync(join(clone, ".git", "kuma-vault", "lfs-pointers.json"), { force: true });
  const results = [];
  const one = (name) => {
    writeFileSync(log, "");
    const out = spawnSync(process.execPath, [process.argv[1], "scenario", name, dir, "--engine", engine], {
      env: { ...process.env, KUMA_VAULT_GIT: wrapper, KUMA_VAULT_SYNC_DIR: join(dir, "sync-state") },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (out.status !== 0) throw new Error(`${name}: ${out.stderr}`);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const byVerb = {};
    for (const c of calls) {
      const verb = c.replace(/^--no-optional-locks /, "").replace(/^--literal-pathspecs /, "").split(" ").slice(0, c.includes(" lfs ") || c.startsWith("--no-optional-locks lfs") ? 2 : 1).join(" ");
      byVerb[verb] = (byVerb[verb] ?? 0) + 1;
    }
    results.push({ ...JSON.parse(out.stdout), gitCalls: calls.length, byVerb });
  };
  one("status-cold");
  one("status-warm");
  commitOne(clone);
  one("status-after-commit");
  one("get-1");
  one("get-8");
  one("evict-under-limit");
  one("scan");
  one("scan");
  return { label, engine, results };
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "build") {
  const dir = resolve(rest[0]);
  mkdirSync(dir, { recursive: true });
  console.log(JSON.stringify(build(dir, { pointers: Number(flag(rest, "pointers", 123000)), texts: Number(flag(rest, "texts", 48000)) })));
} else if (mode === "run") {
  const dir = resolve(rest[0]);
  console.log(JSON.stringify(runAll(dir, resolve(flag(rest, "engine")), flag(rest, "label", "")), null, 1));
} else if (mode === "scenario") {
  const [name, dir] = rest;
  console.log(JSON.stringify(await scenario(name, resolve(dir), resolve(flag(rest, "engine")))));
} else {
  console.error("usage: lfs-pointers-bench.mjs build <dir> | run <dir> --engine <root>");
  process.exitCode = 1;
}

// Which commits on `main` are this clone's (enrich on autosave queues their pages) and which came
// from the server, against real git: a bare "server", the daemon's clone `a` and another computer
// `b`. No serve, no daemon, no model: the daemon's fetch and push are the git calls it makes, the
// person's are `git pull`/`git push` in the clone. The whole tick, end to end:
// enrich.integration.test.mjs.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEnrichMemory, directCommits, noteDirectCommits, noteFetched, persistEnrichMemory } from "./enrich.mjs";

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const isTarget = (path) => path.startsWith("domains/") && path.endsWith(".md");

let root;
let a;
let b;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Write `vault/<rel>` in `clone` and commit it the way an agent does. */
function commit(clone, rel, message = `add ${rel}`) {
  const abs = join(clone, "vault", rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `# ${rel}\n`);
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "--quiet", "-m", message]);
  return git(clone, ["rev-parse", "HEAD"]);
}

const ctx = () => ({
  repo: a,
  settings: { enrichOnAutosave: true },
  treePath: (p) => (p.startsWith("vault/") ? p.slice("vault/".length) : null),
});

/** The daemon's network step: fetch, note it, take the server's commits, push what is ahead. */
async function daemonSync(state) {
  git(a, ["fetch", "--quiet", "--no-tags", "origin"]);
  await noteFetched(ctx(), state);
  git(a, ["merge", "--ff-only", "--quiet", "refs/remotes/origin/main"]);
  git(a, ["push", "--quiet", "--porcelain", "origin", "refs/heads/main:refs/heads/main"]);
}

/** Another computer writes a page and pushes it. */
function elsewhere(rel) {
  git(b, ["pull", "--quiet", "--ff-only", "origin", "main"]);
  return commit(b, rel, `${rel} from another computer`);
}
const pushElsewhere = () => git(b, ["push", "--quiet", "origin", "HEAD:main"]);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kv-provenance-"));
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", "srv.git"]);
  const seed = join(root, "seed");
  git(root, ["clone", "--quiet", join(root, "srv.git"), seed]);
  commit(seed, "domains/seed.md", "fixture");
  git(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  a = join(root, "a");
  b = join(root, "b");
  git(root, ["clone", "--quiet", join(root, "srv.git"), a]);
  git(root, ["clone", "--quiet", join(root, "srv.git"), b]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A clone with enrich on, after one tick: everything so far looked at. */
async function judgedState() {
  const state = createEnrichMemory(null);
  await noteDirectCommits(ctx(), state, isTarget);
  await daemonSync(state);
  return state;
}

describe("which commits are this clone's", () => {
  it("a commit another computer pushed, taken by the daemon's own fetch, is not", async () => {
    const state = await judgedState();
    elsewhere("domains/r.md");
    pushElsewhere();
    await daemonSync(state);

    expect(await directCommits(ctx(), state)).toMatchObject({ commits: 0, paths: [] });
  });

  it("a commit another computer pushed, pulled by hand in the clone, is not", async () => {
    const state = await judgedState();
    elsewhere("domains/r.md");
    pushElsewhere();
    git(a, ["pull", "--quiet", "--ff-only", "origin", "main"]); // a person or an agent, between ticks

    expect(await directCommits(ctx(), state)).toMatchObject({ commits: 0, paths: [] });
  });

  it("a merge made by hand: the clone's own commit is, the pulled one is not", async () => {
    const state = await judgedState();
    commit(a, "domains/mine.md");
    elsewhere("domains/r.md");
    pushElsewhere();
    git(a, ["pull", "--quiet", "--no-rebase", "--no-edit", "origin", "main"]);
    git(a, ["push", "--quiet", "origin", "HEAD:main"]); // and pushed by hand before any tick

    expect(await directCommits(ctx(), state)).toMatchObject({ commits: 1, paths: ["vault/domains/mine.md"] });
  });

  it("a commit this clone pushed by hand, built on elsewhere and pulled back before a tick, still is", async () => {
    const state = await judgedState(); // then the daemon stops
    commit(a, "domains/mine.md");
    git(a, ["push", "--quiet", "origin", "HEAD:main"]);
    elsewhere("domains/r.md");
    pushElsewhere();
    git(a, ["pull", "--quiet", "--ff-only", "origin", "main"]);

    expect(await directCommits(ctx(), state)).toMatchObject({ commits: 1, paths: ["vault/domains/mine.md"] });
  });

  it("a commit the daemon's push took to the server before a tick looked at it still is", async () => {
    const state = await judgedState();
    commit(a, "domains/mine.md"); // made after the tick's look, pushed by the same tick
    git(a, ["push", "--quiet", "--porcelain", "origin", "refs/heads/main:refs/heads/main"]);

    expect(await directCommits(ctx(), state)).toMatchObject({ commits: 1, paths: ["vault/domains/mine.md"] });
  });
});

describe("while the tree cannot be judged (the enrich alarm)", () => {
  it("commits are still judged: the server's never enter, the clone's are queued once the resolver is back", async () => {
    let state = await judgedState();
    // the alarm: enrichTargets gives no resolver for a few ticks
    state.targetError = "the docs contract of this tree does not carry enrich";
    elsewhere("domains/r1.md");
    pushElsewhere();
    await noteDirectCommits(ctx(), state, null);
    await daemonSync(state); // the daemon merges r1
    commit(a, "domains/mine.md");
    await noteDirectCommits(ctx(), state, null);
    await daemonSync(state); // and pushes mine
    elsewhere("domains/r2.md"); // built on mine
    pushElsewhere();
    await noteDirectCommits(ctx(), state, null);
    await daemonSync(state);
    expect(state.pending.size).toBe(0);
    const heldDuringAlarm = state.held;

    state = createEnrichMemory({ enrichQueue: persistEnrichMemory(state) }); // a restart in between
    state.targetError = null; // the declaration is readable again
    await noteDirectCommits(ctx(), state, isTarget);

    expect([...state.pending.keys()]).toEqual(["domains/mine.md"]); // never r1 or r2
    expect(heldDuringAlarm).toEqual(["vault/domains/mine.md"]);
    expect(state.held).toEqual([]);
  });

  it("holds a path once, and never one under a secret directory", async () => {
    const state = await judgedState();
    commit(a, "domains/mine.md");
    commit(a, "domains/personal/_credentials/svc.md");
    await noteDirectCommits(ctx(), state, null);
    writeFileSync(join(a, "vault/domains/mine.md"), "# mine, again\n");
    git(a, ["commit", "--quiet", "-am", "mine again"]);
    await noteDirectCommits(ctx(), state, null);

    expect(state.held).toEqual(["vault/domains/mine.md"]);
  });

  it("turning enrich off forgets the held paths with the bounds", async () => {
    const state = await judgedState();
    commit(a, "domains/mine.md");
    await noteDirectCommits(ctx(), state, null);
    expect(state.held).toEqual(["vault/domains/mine.md"]);

    await noteDirectCommits({ ...ctx(), settings: { enrichOnAutosave: false } }, state, null);
    expect(state).toMatchObject({ held: [], seenHead: null, remoteSeen: null });
  });
});

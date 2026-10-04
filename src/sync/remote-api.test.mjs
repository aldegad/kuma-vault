// The daemon's own credential lookup fails fast when a helper waits for input (a keychain
// prompt under launchd), says why, and does not start another helper until the TTL passes.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRemoteApi } from "./remote-api.mjs";

let root;
const saved = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kv-remote-api-"));
  for (const key of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]) saved[key] = process.env[key];
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  execFileSync("git", ["init", "--quiet", root]);
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("remote api credential lookup", () => {
  it("fails within the timeout when a helper hangs, and keeps that failure instead of asking again", async () => {
    const calls = join(root, "calls");
    execFileSync("git", ["-C", root, "config", "credential.helper", `!f() { echo "$1" >> '${calls}'; sleep 5; }; f`]);
    const api = createRemoteApi({ repo: root, remoteUrl: "http://127.0.0.1:9/v1/stores/s.git" }, { credentialTimeoutMs: 300 });
    const started = Date.now();
    await expect(api.authHeader()).rejects.toThrow(/did not answer within 0\.3s/);
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(api.authHeader()).rejects.toThrow(/did not answer/);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["get"]);
  });
});

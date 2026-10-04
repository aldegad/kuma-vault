// The credential-mode walk on a plain directory (no git): which paths are credential roots, what
// is loose, what `fix` changes, and what it never touches (symlinks, the owner executable bit,
// anything outside a root).

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { credentialModes, credentialRoots, isLooseMode } from "./credential-modes.mjs";
import { credentialRootOf, crossesSecretDir, isCredentialDirName } from "./secret-dirs.mjs";
import { SEARCH_EXCLUDED_DIR_NAMES, crossesSecretDir as searchCrossesSecretDir } from "../engine/vault-search.mjs";

let root;

function write(rel, mode = 0o644) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "synthetic\n");
  chmodSync(abs, mode);
  return abs;
}

const modeOf = (rel) => statSync(join(root, rel)).mode & 0o777;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kv-credmodes-unit-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("secret-dirs resolver", () => {
  it("is the one the search surfaces use", () => {
    expect(SEARCH_EXCLUDED_DIR_NAMES).toEqual(["_credentials", "_sync-conflicts"]);
    expect(searchCrossesSecretDir).toBe(crossesSecretDir);
    expect(crossesSecretDir("x/_credentials")).toBe(true);
    expect(crossesSecretDir("a/_Sync-Conflicts/b.md")).toBe(true);
    expect(crossesSecretDir("a/credentials/b.md")).toBe(false);
  });

  it("finds the credential root at any depth and in any case, spelled as given", () => {
    expect(credentialRootOf("domains/personal/_credentials/a.json")).toBe("domains/personal/_credentials");
    expect(credentialRootOf("vault/domains/x/_Credentials/n/b.json")).toBe("vault/domains/x/_Credentials");
    expect(credentialRootOf("_credentials")).toBe("_credentials");
    expect(credentialRootOf("a/_credentials/b/_credentials/c")).toBe("a/_credentials");
    expect(credentialRootOf("_sync-conflicts/x/a.md")).toBeNull();
    expect(credentialRootOf("domains/credentials.md")).toBeNull();
    // a conflict copy of a credential is still under a credential directory
    expect(credentialRootOf("vault/_sync-conflicts/s/domains/p/_credentials/a.json")).toBe("vault/_sync-conflicts/s/domains/p/_credentials");
    expect(isCredentialDirName("_CREDENTIALS")).toBe(true);
  });

  it("credentialRoots lists each root once, sorted", () => {
    expect(credentialRoots(["b/_credentials/x", "a/_credentials/y", "b/_credentials/z/w", "c/note.md"])).toEqual(["a/_credentials", "b/_credentials"]);
  });
});

describe("credentialModes", () => {
  it("audits without changing: group/other bits are loose, stricter modes are not", () => {
    write("d/_credentials/a.json", 0o644);
    write("d/_credentials/b.json", 0o600);
    write("d/_credentials/c.json", 0o400);
    chmodSync(join(root, "d/_credentials"), 0o755);
    const report = credentialModes(root, ["d/_credentials"]);
    expect(report).toMatchObject({ roots: 1, checked: 4, looseCount: 2, fixedCount: 0, failedCount: 0 });
    expect(report.loose).toEqual([
      { path: "d/_credentials", mode: "0755", want: "0700" },
      { path: "d/_credentials/a.json", mode: "0644", want: "0600" },
    ]);
    expect(modeOf("d/_credentials/a.json")).toBe(0o644);
    expect(isLooseMode(0o640)).toBe(true);
    expect(isLooseMode(0o700)).toBe(false);
  });

  it("fix tightens files to 0600 and directories to 0700, nested ones and new ones included", () => {
    write("d/_credentials/a.json", 0o644);
    write("d/_credentials/n/b.json", 0o664);
    write("d/_credentials/n/m/c.json", 0o604);
    for (const dir of ["d/_credentials", "d/_credentials/n", "d/_credentials/n/m"]) chmodSync(join(root, dir), 0o755);
    write("d/other.md", 0o644);
    const report = credentialModes(root, ["d/_credentials"], { fix: true });
    expect(report).toMatchObject({ fixedCount: 6, looseCount: 0, failedCount: 0 });
    for (const rel of ["d/_credentials/a.json", "d/_credentials/n/b.json", "d/_credentials/n/m/c.json"]) expect(modeOf(rel)).toBe(0o600);
    for (const rel of ["d/_credentials", "d/_credentials/n", "d/_credentials/n/m"]) expect(modeOf(rel)).toBe(0o700);
    expect(modeOf("d/other.md")).toBe(0o644); // outside the root: untouched
    expect(modeOf("d")).not.toBe(0o700);
    expect(credentialModes(root, ["d/_credentials"])).toMatchObject({ looseCount: 0 }); // idempotent
  });

  it("keeps an owner executable bit (git records it) and never follows a symlink", () => {
    write("d/_credentials/run.sh", 0o755);
    const outside = write("elsewhere/target.txt", 0o644);
    symlinkSync(outside, join(root, "d/_credentials/link"));
    chmodSync(join(root, "d/_credentials"), 0o700);
    const report = credentialModes(root, ["d/_credentials"], { fix: true });
    expect(report.fixed).toEqual([{ path: "d/_credentials/run.sh", mode: "0755", want: "0700" }]);
    expect(modeOf("d/_credentials/run.sh")).toBe(0o700);
    expect(lstatSync(join(root, "d/_credentials/link")).isSymbolicLink()).toBe(true);
    expect(modeOf("elsewhere/target.txt")).toBe(0o644);
  });

  it("a missing root is skipped; a directory it cannot read is a failure, not a silent skip", () => {
    expect(credentialModes(root, ["gone/_credentials"], { fix: true })).toMatchObject({ checked: 0, looseCount: 0, failedCount: 0 });
    write("d/_credentials/locked/x.json", 0o644);
    chmodSync(join(root, "d/_credentials"), 0o700);
    chmodSync(join(root, "d/_credentials/locked"), 0o000);
    try {
      const report = credentialModes(root, ["d/_credentials"], { fix: true });
      expect(report.failedCount).toBe(1);
      expect(report.looseCount).toBe(1);
      expect(report.failed).toEqual([{ path: "d/_credentials/locked", mode: "0000", want: "0700", error: "EACCES" }]);
    } finally {
      chmodSync(join(root, "d/_credentials/locked"), 0o700);
    }
  });
});

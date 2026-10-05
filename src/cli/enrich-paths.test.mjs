// `--enrich-paths-from`: the paths a `vault sync --enrich` run is limited to, NUL-separated.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEnrichPaths } from "./vault-commands.mjs";

describe("readEnrichPaths", () => {
  let dir;
  const from = (text) => {
    const file = join(dir, "paths");
    writeFileSync(file, text);
    return readEnrichPaths({ enrich: true, "enrich-paths-from": file });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kv-enrich-paths-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads NUL-separated paths", () => {
    expect(from("domains/a.md\0domains/b c.md\0")).toEqual(["domains/a.md", "domains/b c.md"]);
    expect(readEnrichPaths({ enrich: true })).toBeUndefined();
  });

  it("refuses a newline-separated list instead of passing it on as one path", () => {
    expect(() => from("domains/a.md\ndomains/b.md\n")).toThrow(/NUL-separated paths; "domains\/a\.md\\ndomains\/b\.md\\n" has a line break/u);
    expect(() => from("domains/a.md\r\n")).toThrow(/has a line break/u);
    expect(() => from("domains/a.md\0domains/b\n.md\0")).toThrow(/has a line break/u);
  });

  it("needs --enrich and a source", () => {
    expect(() => readEnrichPaths({ "enrich-paths-from": "x" })).toThrow(/needs --enrich/u);
    expect(() => readEnrichPaths({ enrich: true, "enrich-paths-from": true })).toThrow(/needs a file/u);
  });
});

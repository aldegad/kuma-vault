import { describe, expect, it } from "vitest";

import { parseFlags } from "./cli-options.mjs";

describe("parseFlags", () => {
  it("keeps a positional source after boolean flags", () => {
    const options = parseFlags(["--bypass", "source.md", "--dry-run"]);

    expect(options.bypass).toBe(true);
    expect(options["dry-run"]).toBe(true);
    expect(options._).toEqual(["source.md"]);
  });
});

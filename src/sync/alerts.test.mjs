// The growth window (design 2.1): autosaved LFS bytes and binaries summed over 24 h, so a trickle
// spread over many ticks trips the alarm as surely as one burst does.

import { describe, expect, it } from "vitest";

import { computeGrowth, recordGrowth } from "./alerts.mjs";
import { TUNABLES } from "./context.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const ctx = {
  settings: { growthBytes: 1e9, growthFiles: 500, growthWindowMs: 24 * HOUR },
  treePath: (p) => p,
};

function commit(i, { bytes, files, dir = "media/frames" }) {
  return { commit: `c${i}`, lfsBytes: bytes, lfsFiles: files, dirs: [{ dir, bytes, files }] };
}

/** Feed one commit per `everyMs` and return the index of the first commit that trips growth. */
function firstTrip(n, everyMs, shape) {
  let window = [];
  let growth = null;
  for (let i = 0; i < n; i += 1) {
    const now = i * everyMs;
    window = recordGrowth(ctx, window, commit(i, shape), { now });
    growth = computeGrowth(ctx, window, growth, { now });
    if (growth) return { i, growth, window };
  }
  return { i: -1, growth, window };
}

describe("growth", () => {
  it("defaults: 1 GB or 500 binaries within 24 h", () => {
    const row = (name) => TUNABLES.find((t) => t[1] === name);
    expect(row("growthBytes").slice(2)).toEqual([1e9, 1]);
    expect(row("growthFiles").slice(2)).toEqual([500, 1]);
    expect(row("growthWindowMs").slice(2)).toEqual([24 * 60 * 60, 1000]);
  });

  it("a byte trickle under the burst size (30 MB every 30 min) trips within a day", () => {
    const { i, growth } = firstTrip(48, 30 * MIN, { bytes: 30e6, files: 1 });
    expect(i).toBe(33); // 34 x 30 MB = 1.02 GB
    expect(i * 30 * MIN).toBeLessThan(24 * HOUR);
    expect(growth).toMatchObject({ active: true, level: "yellow", bytes: 34 * 30e6, files: 34, topDir: "media/frames", commit: "c33" });
  });

  it("a file trickle (20 binaries a minute) trips within a day", () => {
    const { i, growth } = firstTrip(24 * 60, MIN, { bytes: 20 * 64, files: 20 });
    expect(i).toBe(24); // 25 x 20 = 500
    expect(growth.files).toBe(500);
  });

  it("a trickle slower than the window holds (400 binaries a day) never trips", () => {
    const { i } = firstTrip(24 * 30, 2 * HOUR, { bytes: 33 * 64, files: 33 }); // 12 a day x 33 = 396
    expect(i).toBe(-1);
  });

  it("the onset stays fixed while active, and the alarm clears once the window has passed", () => {
    let window = recordGrowth(ctx, [], commit(0, { bytes: 2e9, files: 3 }), { now: 0 });
    const first = computeGrowth(ctx, window, null, { now: 0 });
    window = recordGrowth(ctx, window, commit(1, { bytes: 1e6, files: 1 }), { now: 5 * HOUR });
    const second = computeGrowth(ctx, window, first, { now: 5 * HOUR });
    expect(second.atMs).toBe(0);
    expect(second.commit).toBe("c1");
    expect(computeGrowth(ctx, window, second, { now: 24 * HOUR + 11 * MIN })).toBeNull();
    expect(recordGrowth(ctx, window, null, { now: 30 * HOUR })).toEqual([]);
  });

  it("names the directory with the most bytes across the window", () => {
    let window = [];
    window = recordGrowth(ctx, window, commit(0, { bytes: 4e8, files: 300, dir: "a/many-small" }), { now: 0 });
    window = recordGrowth(ctx, window, commit(1, { bytes: 7e8, files: 2, dir: "b/few-big" }), { now: 3 * HOUR });
    expect(computeGrowth(ctx, window, null, { now: 3 * HOUR })).toMatchObject({ topDir: "b/few-big", bytes: 1.1e9, files: 302 });
  });
});

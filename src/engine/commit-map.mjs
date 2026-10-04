// Commit maps: `old new` per line (whitespace or TAB separated), the format git-filter-repo
// writes to `filter-repo/commit-map` (a leading `old new` header line, `#` comments allowed).
// A line whose new side is all zeros (a pruned commit) carries no mapping and is skipped.

import { readFileSync } from "node:fs";

const SHA = /^[0-9a-f]{40}$/;

export function parseCommitMap(text, label = "commit map") {
  const map = new Map();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const [left, right, extra] = line.split(/\s+/);
    if (index === 0 && left === "old" && right === "new") return;
    if (extra !== undefined || !SHA.test(left ?? "") || !SHA.test(right ?? "")) {
      throw new Error(`${label}:${index + 1}: expected "<40-hex> <40-hex>", got ${JSON.stringify(raw.slice(0, 100))}`);
    }
    if (/^0+$/.test(right)) return;
    if (map.has(left)) throw new Error(`${label}:${index + 1}: ${left} is mapped twice`);
    map.set(left, right);
  });
  return map;
}

export function readCommitMap(path) {
  return parseCommitMap(readFileSync(path, "utf8"), path);
}

export function reverseCommitMap(map, label = "commit map") {
  const reversed = new Map();
  for (const [left, right] of map) {
    if (reversed.has(right)) throw new Error(`${label}: ${right} is the image of two commits — cannot reverse`);
    reversed.set(right, left);
  }
  return reversed;
}

/** Lines of the map whose old or new sha starts with `prefix`. */
export function lookupCommitMap(map, prefix) {
  const p = String(prefix).toLowerCase();
  const out = [];
  for (const [left, right] of map) if (left.startsWith(p) || right.startsWith(p)) out.push({ old: left, new: right });
  return out;
}

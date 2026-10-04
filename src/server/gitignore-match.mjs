// gitignore-syntax path matcher (no dependencies).
//
// The server receive rules read the same pattern lists that the generated root `.gitignore`
// blocks carry (`binaries.reject`, the trash/derived block), so they must mean the same
// thing: a pattern without an inner slash matches a name at any depth, a pattern with one
// is anchored to the repo root, a trailing slash matches directories only, and a matched
// directory covers everything beneath it. Negation (`!`) is not supported and is refused
// loudly rather than silently ignored.

function escapeRegexChar(ch) {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegexSource(glob) {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0;
        const prevSlash = i > 0 && glob[i - 1] === "/";
        const nextSlash = glob[i + 2] === "/";
        const atEnd = i + 2 === glob.length;
        if ((atStart || prevSlash) && nextSlash) {
          out += "(?:.*/)?"; // `**/` — zero or more directories
          i += 3;
          continue;
        }
        if (prevSlash && atEnd) {
          out += ".*"; // `/**` — everything inside
          i += 2;
          continue;
        }
        out += "[^/]*"; // any other `**` acts like `*`
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close < 0) {
        out += "\\[";
        i += 1;
        continue;
      }
      let body = glob.slice(i + 1, close);
      let negate = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negate = true;
        body = body.slice(1);
      }
      body = body.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
      out += negate ? `[^/${body}]` : `[${body}]`;
      i = close + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < glob.length) {
      out += escapeRegexChar(glob[i + 1]);
      i += 2;
      continue;
    }
    out += escapeRegexChar(ch);
    i += 1;
  }
  return out;
}

function compilePattern(raw, { ignoreCase }) {
  let pattern = raw.replace(/(?<!\\)\s+$/, "");
  if (!pattern || pattern.startsWith("#")) return null;
  if (pattern.startsWith("!")) {
    throw new Error(`gitignore negation is not supported in server pattern lists: ${raw}`);
  }
  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.replace(/\/+$/, "");
  }
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  if (!pattern) return null;
  const regex = new RegExp(`^${globToRegexSource(pattern)}$`, ignoreCase ? "i" : "");
  return { raw, regex, anchored, dirOnly };
}

/**
 * Compile a gitignore-style pattern list. Returns `match(path)` which yields the first
 * pattern that covers `path` (a repo-relative file path with `/` separators) or null.
 */
export function compileGitignore(patterns, { ignoreCase = false } = {}) {
  const compiled = (patterns ?? []).map((p) => compilePattern(String(p), { ignoreCase })).filter(Boolean);
  return function match(path) {
    if (compiled.length === 0) return null;
    const parts = path.split("/").filter(Boolean);
    for (let k = 1; k <= parts.length; k += 1) {
      const isDir = k < parts.length;
      const prefix = parts.slice(0, k).join("/");
      const name = parts[k - 1];
      for (const p of compiled) {
        if (p.dirOnly && !isDir) continue;
        if (p.regex.test(p.anchored ? prefix : name)) return p.raw;
      }
    }
    return null;
  };
}

/**
 * Re-anchor a gitignore pattern written relative to a declared tree (the directory holding
 * `vault.config.json`, e.g. `vault/`) so it means the same paths relative to the repo root.
 * `vault.config.json` `binaries.reject` is tree-relative; the server's receive rules and the
 * repo-root `.gitignore` match repo-relative paths. Anchored patterns (an inner `/`) get the
 * prefix; unanchored ones (`*.tmp`, `canvas/`) get `<prefix>/` plus a `**` directory step, so they still
 * match at any depth — but only inside the tree.
 */
export function anchorPatternToTree(pattern, treePrefix) {
  const prefix = String(treePrefix ?? "").replace(/^\/+|\/+$/g, "");
  const raw = String(pattern).replace(/(?<!\\)\s+$/, "");
  if (!raw || raw.startsWith("#")) return null;
  if (raw.startsWith("!")) throw new Error(`gitignore negation is not supported in reject lists: ${pattern}`);
  if (!prefix) return raw;
  const dirOnly = raw.endsWith("/");
  const body = raw.replace(/\/+$/, "");
  const anchored = body.includes("/");
  const rel = body.replace(/^\/+/, "");
  return `${prefix}/${anchored ? "" : "**/"}${rel}${dirOnly ? "/" : ""}`;
}

export function anchorPatternsToTree(patterns, treePrefix) {
  return (patterns ?? []).map((p) => anchorPatternToTree(p, treePrefix)).filter(Boolean);
}

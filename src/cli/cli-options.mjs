// Minimal argv flag parser + typed option readers for the vault CLI.
//
// Vendored into the distribution so the CLI has no dependency on a host option
// library. `--key value`, `--key=value`, and boolean `--flag` are supported;
// non-`--` tokens accumulate in `_` (positionals).

const BOOLEAN_FLAGS = new Set([
  "all-stores",
  "bypass",
  "check",
  "dry-run",
  "enrich",
  "full-auto",
  "help",
  "json",
  "open",
  "star",
  "yes",
]);

export function parseFlags(argv) {
  const options = {
    _: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 2) {
      const key = token.slice(2, equalsIndex);
      options[key] = token.slice(equalsIndex + 1);
      continue;
    }

    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      options[key] = true;
      continue;
    }

    const nextToken = argv[index + 1];
    if (nextToken === undefined || nextToken.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = nextToken;
    index += 1;
  }

  return options;
}

export function requireString(options, key) {
  const value = options[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required option: --${key}`);
  }

  return value;
}

export function readNumber(options, key, fallback = undefined) {
  const raw = options[key];
  if (raw == null) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number for --${key}`);
  }

  return value;
}

export function readOptionalString(options, key) {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

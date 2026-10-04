// Storage-policy commands of a vault tree:
//
//   vault gate pre-push --root <tree> <remote> <url>
//       pre-push hook body: a tree declaring `visibility: "private"` pushes only to URLs in
//       `remotes.allowed`. Credentials in a URL are ignored for the comparison.
//   vault binaries apply --from <binaries-reject.json> --root <tree> [--gitignore-decisions <csv>] [--dry-run]
//       writes the reject list to vault.config.json `binaries.reject` (tree-relative) and the
//       generated blocks of the repo-root .gitignore (repo-relative), folds the sub-.gitignore
//       decisions in, and prints the server command that writes the same list to server.json.
//   vault commit-map <prefix> [--map <tsv>] [--root <tree>]
//       old <-> new sha lookup in the commit map a history rewrite left behind.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { lookupCommitMap, readCommitMap } from "../engine/commit-map.mjs";
import { locateTreeInRepo } from "../engine/commit-policy.mjs";
import { resolveVaultDir } from "../engine/path-resolver.mjs";
import { VAULT_CONFIG_FILENAME, loadVaultDeclaration } from "../engine/vault-config.mjs";
import { anchorPatternsToTree, compileGitignore } from "../server/gitignore-match.mjs";
import { DEFAULT_JUNK_PATTERNS } from "../server/lfs-paths.mjs";
import { readOptionalString } from "./cli-options.mjs";

// ── pre-push ────────────────────────────────────────────────────────────────

/** Comparable form of a remote URL: no credentials, no trailing slash. scp-style and paths stay as given. */
export function normalizeRemoteUrl(url) {
  const value = String(url ?? "").trim();
  try {
    const parsed = new URL(value);
    if (!/^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol) || !parsed.host) return value.replace(/\/+$/, "");
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

/** Returns null when the push may proceed, else the refusal message. */
export function judgePush(declaration, remoteName, url) {
  if (!declaration) return null;
  const isPrivate = declaration.visibility === "private";
  const allowed = declaration.remotes?.allowed;
  if (!isPrivate && !allowed) return null;
  const list = (allowed ?? []).map(normalizeRemoteUrl);
  const target = normalizeRemoteUrl(url);
  if (list.includes(target)) return null;
  const shown = list.length ? list.join(", ") : "(없음)";
  return `이 볼트(visibility ${declaration.visibility ?? "-"})는 허용 목록 밖 원격으로 push 하지 않습니다: ${remoteName} ${target}\n허용 목록(vault.config.json remotes.allowed): ${shown}`;
}

function commandPrePush(options) {
  const root = readOptionalString(options, "root");
  if (!root) throw new Error("vault gate pre-push --root <tree> <remote> <url>");
  const [remoteName, url] = options._;
  if (!url) throw new Error("vault gate pre-push: <remote> <url> required (git passes them to the hook)");
  const refusal = judgePush(loadVaultDeclaration(resolve(root)), remoteName, url);
  if (refusal) {
    process.stderr.write(`kuma-vault pre-push: ${refusal}\n`);
    process.exitCode = 1;
  }
}

export async function commandVaultGate(options) {
  const [verb, ...rest] = options._;
  if (verb === "pre-push") return commandPrePush({ ...options, _: rest });
  process.stdout.write("Usage: vault gate pre-push --root <tree> <remote> <url>\n");
  process.exitCode = 1;
}

// ── binaries apply ──────────────────────────────────────────────────────────

export const GITIGNORE_BLOCKS = Object.freeze({
  junk: ["# >>> kuma-vault generated: trash and derived files (vault binaries apply) >>>", "# <<< kuma-vault generated: trash and derived files <<<"],
  reject: ["# >>> kuma-vault generated: binaries.reject — intermediates live outside the vault (vault binaries apply) >>>", "# <<< kuma-vault generated: binaries.reject <<<"],
});

export function readRejectFile(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : Array.isArray(data?.reject) ? data.reject : data?.binaries?.reject;
  if (!Array.isArray(list) || list.some((p) => typeof p !== "string" || !p.trim())) {
    throw new Error('reject file must be ["glob", ...], {"reject": [...]} or {"binaries": {"reject": [...]}}');
  }
  compileGitignore(list);
  return list;
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(cell); cell = ""; } else cell += ch;
    }
    cells.push(cell);
    rows.push(cells);
  }
  const [header, ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((key, i) => [key.trim(), (cells[i] ?? "").trim()])));
}

const DECISION_REJECT = new Set(["reject로 올림", "reject"]);
const DECISION_DROP = new Set(["하위 줄 삭제 권고", "하위 줄 삭제", "drop"]);

/**
 * Fold sub-.gitignore decisions (a decision table with columns ignore_file, rule, decision) into the reject list.
 * A rule promoted to `reject` is re-anchored at its .gitignore's directory (tree-relative); every
 * decided rule line is removed from its sub-.gitignore. Returns { added, edits: Map<file, lines> }.
 */
export function foldGitignoreDecisions(rows, { repoTop, treePrefix }) {
  const added = [];
  const removals = new Map();
  for (const row of rows) {
    const file = row.ignore_file;
    const rule = row.rule;
    const decision = row.decision;
    if (!file || !rule) throw new Error(`decision row without ignore_file/rule: ${JSON.stringify(row)}`);
    if (!file.startsWith(treePrefix)) throw new Error(`${file} is outside the tree ${treePrefix || "(root)"}`);
    const dirRel = dirname(file.slice(treePrefix.length)).replace(/^\.$/, "");
    if (DECISION_REJECT.has(decision)) {
      const [anchored] = anchorPatternsToTree([rule], dirRel);
      added.push(anchored);
    } else if (!DECISION_DROP.has(decision)) {
      throw new Error(`unknown decision "${decision}" for ${file} ${rule} (expected: reject로 올림 | 하위 줄 삭제 권고)`);
    }
    if (!removals.has(file)) removals.set(file, new Set());
    removals.get(file).add(rule);
  }
  const edits = new Map();
  for (const [file, rules] of removals) {
    const full = join(repoTop, file);
    if (!existsSync(full)) throw new Error(`${file} not found`);
    const lines = readFileSync(full, "utf8").split("\n");
    const kept = lines.filter((line) => !rules.has(line.trim()));
    const missing = [...rules].filter((rule) => !lines.some((line) => line.trim() === rule));
    if (missing.length > 0) throw new Error(`${file} has no line(s) ${missing.join(", ")} — the decision table is stale`);
    edits.set(file, kept.some((line) => line.trim() && !line.trim().startsWith("#")) ? kept.join("\n") : null);
  }
  return { added, edits };
}

/** Replace (or append) the two generated blocks; every other line of the file stays. */
export function renderRootGitignore(existing, { junk, reject }) {
  let text = existing ?? "";
  for (const [key, lines] of [["junk", junk], ["reject", reject]]) {
    const [begin, end] = GITIGNORE_BLOCKS[key];
    const block = [begin, ...lines, end].join("\n");
    const start = text.indexOf(begin);
    if (start >= 0) {
      const stop = text.indexOf(end, start);
      if (stop < 0) throw new Error(`.gitignore has "${begin}" without its end marker`);
      text = text.slice(0, start) + block + text.slice(stop + end.length);
    } else {
      text = `${text.replace(/\n*$/, "")}${text.trim() ? "\n\n" : ""}${block}\n`;
    }
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

function writeAtomic(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function commandBinariesApply(options) {
  const root = readOptionalString(options, "root");
  const from = readOptionalString(options, "from");
  if (!root || !from) throw new Error("vault binaries apply --from <binaries-reject.json> --root <tree> [--gitignore-decisions <csv>] [--dry-run]");
  const treeDir = resolve(root);
  const declaration = loadVaultDeclaration(treeDir);
  if (!declaration) throw new Error(`no ${VAULT_CONFIG_FILENAME} at ${treeDir}`);
  const located = locateTreeInRepo(treeDir);
  if (!located) throw new Error(`${treeDir} is not in a git work tree`);
  const base = readRejectFile(readFileSync(resolve(from), "utf8"));
  const decisionsPath = readOptionalString(options, "gitignore-decisions");
  const folded = decisionsPath
    ? foldGitignoreDecisions(parseCsv(readFileSync(resolve(decisionsPath), "utf8")), { repoTop: located.top, treePrefix: located.prefix })
    : { added: [], edits: new Map() };
  const reject = [...new Set([...base, ...folded.added])];
  compileGitignore(reject);
  const treePrefix = located.prefix.replace(/\/$/, "");
  const gitignorePath = join(located.top, ".gitignore");
  const gitignore = renderRootGitignore(existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "", {
    junk: [...DEFAULT_JUNK_PATTERNS],
    reject: anchorPatternsToTree(reject, treePrefix),
  });
  const configPath = join(treeDir, VAULT_CONFIG_FILENAME);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.binaries = { ...(config.binaries ?? {}), reject };
  const summary = {
    reject: reject.length,
    fromFile: base.length,
    promotedFromSubGitignores: folded.added.length,
    subGitignoreEdits: [...folded.edits].map(([file, text]) => ({ file, action: text === null ? "delete" : "rewrite" })),
    files: [configPath, gitignorePath],
    // the server reads the same list (rule 7); vault.config.json is one of the formats set-reject takes
    server: `sudo vault server set-reject --store <server store id> --from <this ${VAULT_CONFIG_FILENAME}> --tree-prefix ${treePrefix || "''"}`,
  };
  if (options["dry-run"] !== true) {
    loadVaultDeclaration(treeDir); // the current file is valid before we touch it
    writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
    loadVaultDeclaration(treeDir);
    writeAtomic(gitignorePath, gitignore);
    for (const [file, text] of folded.edits) {
      const full = join(located.top, file);
      if (text === null) rmSync(full);
      else writeAtomic(full, text.endsWith("\n") ? text : `${text}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ dryRun: options["dry-run"] === true, ...summary }, null, 2)}\n`);
}

export async function commandVaultBinaries(options) {
  const [verb, ...rest] = options._;
  if (verb === "apply") return commandBinariesApply({ ...options, _: rest });
  process.stdout.write("Usage: vault binaries apply --from <binaries-reject.json> --root <tree> [--gitignore-decisions <csv>] [--dry-run]\n");
  process.exitCode = 1;
}

// ── commit-map ──────────────────────────────────────────────────────────────

export async function commandVaultCommitMap(options) {
  const [prefix] = options._;
  if (!prefix || !/^[0-9a-f]{4,40}$/i.test(prefix)) throw new Error("vault commit-map <sha prefix, 4-40 hex> [--map <tsv>] [--root <tree>]");
  let mapPath = readOptionalString(options, "map");
  if (!mapPath) {
    const root = resolve(readOptionalString(options, "root") ?? resolveVaultDir());
    const declaration = loadVaultDeclaration(root);
    if (!declaration?.commitMap) throw new Error(`no --map and ${root}/${VAULT_CONFIG_FILENAME} declares no commitMap`);
    mapPath = join(root, declaration.commitMap);
  }
  const hits = lookupCommitMap(readCommitMap(resolve(mapPath)), prefix);
  if (options.json === true) process.stdout.write(`${JSON.stringify({ map: mapPath, hits }, null, 2)}\n`);
  else for (const hit of hits) process.stdout.write(`${hit.old} ${hit.new}\n`);
  if (hits.length === 0) {
    process.stderr.write(`no commit in ${mapPath} starts with ${prefix}\n`);
    process.exitCode = 1;
  }
}

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFtsMatchExpression, resolveFtsDbPath } from "../src/engine/vault-fts.mjs";
import { extractSearchTerms, searchVault, walkVaultMarkdownFiles } from "../src/engine/vault-search.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vaultDir = resolve(process.env.KUMA_VAULT_DIR || join(homedir(), ".kuma", "vault"));
const dbPath = resolveFtsDbPath(vaultDir);
const queries = process.argv.slice(2);

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const db = new DatabaseSync(dbPath, { readOnly: true });
let meta;
let rowCount;
const queryResults = [];
try {
  meta = Object.fromEntries(
    db.prepare("SELECT key, value FROM fts_meta ORDER BY key").all().map(({ key, value }) => [key, value]),
  );
  rowCount = Number(db.prepare("SELECT count(*) AS count FROM vault_fts").get().count);
  for (const query of queries) {
    const terms = extractSearchTerms(query);
    const expression = buildFtsMatchExpression(terms);
    const rawCandidateCount = expression
      ? Number(db.prepare("SELECT count(*) AS count FROM vault_fts WHERE vault_fts MATCH ?").get(expression).count)
      : null;
    const fts = await searchVault({ vaultDir, query, engine: "fts" });
    const scan = await searchVault({ vaultDir, query, engine: "scan" });
    queryResults.push({
      query,
      terms,
      expression,
      rawCandidateCount,
      fts: {
        corpusFiles: fts.corpusFiles,
        candidateFiles: fts.candidateFiles,
        scannedFiles: fts.scannedFiles,
        hits: fts.hits.length,
      },
      scan: {
        corpusFiles: scan.corpusFiles,
        candidateFiles: scan.candidateFiles,
        scannedFiles: scan.scannedFiles,
        hits: scan.hits.length,
      },
    });
  }
} finally {
  db.close();
}

const dbStat = await stat(dbPath);
const files = await walkVaultMarkdownFiles(vaultDir);
process.stdout.write(`${JSON.stringify({
  runtime: {
    execPath: process.execPath,
    node: process.version,
    cwd: process.cwd(),
    home: process.env.HOME,
    kumaVaultDir: process.env.KUMA_VAULT_DIR ?? null,
  },
  package: {
    root: packageRoot,
    hashes: {
      bin: await sha256(join(packageRoot, "bin", "vault")),
      search: await sha256(join(packageRoot, "src", "engine", "vault-search.mjs")),
      fts: await sha256(join(packageRoot, "src", "engine", "vault-fts.mjs")),
    },
  },
  vault: {
    path: vaultDir,
    realpath: await realpath(vaultDir),
    walkedFiles: files.length,
  },
  fts: {
    dbPath,
    bytes: dbStat.size,
    mtime: dbStat.mtime.toISOString(),
    meta,
    rowCount,
  },
  queries: queryResults,
}, null, 2)}\n`);

#!/usr/bin/env node
// kuma-vault CLI entrypoint (node side).
//
// The `bin/vault` bash wrapper parses the human surface (search/get/sync/lint/hook/index/
// <domain>) and dispatches the engine-backed subcommands here as `vault-<verb>`. Hook and
// domain-shortcut handling stay in bash (pure fs/git, no engine); this router owns the
// commands that call the compiler engine.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { parseFlags } from "./cli-options.mjs";
import {
  commandVaultIngest,
  commandVaultSearch,
  commandVaultGet,
  commandVaultLint,
  commandVaultSync,
} from "./vault-commands.mjs";
import { commandVaultSetup } from "./setup.mjs";
import { commandVaultGraph } from "./graph.mjs";
import { commandVaultMigrate } from "./migrate-commands.mjs";
import { commandVaultBinaries, commandVaultCommitMap, commandVaultGate } from "./policy-commands.mjs";
import { commandVaultStore } from "./store-commands.mjs";

function printUsage() {
  process.stdout.write(
    [
      "Usage: cli.mjs <command> [options]",
      "",
      "Commands:",
      "  vault-search --query <q> [--mode search|timeline] [--engine auto|fts|scan] [--limit <n>] [--store <id>] [--vault-dir <path>] [--format text|json]",
      "                 (spans every registered store by default; --store or --vault-dir narrows)",
      "  vault-get <id|path ...> [--vault-dir <path>] [--format text|json]",
      "  vault-ingest [source] [--section <s>] [--page <p>] [--project <slug>] [--bypass] [--dry-run] [--vault-dir <path>]",
      "  vault-sync [--check] [--enrich] [--enrich-limit <n>] [--root <path>] [--profile <id>] [--json]",
      "  vault-lint [--mode fast|full] [--root <path>] [--profile <id>] [--json] [files...]",
      "  vault-setup [--storage local|oracle|remote [--server <url>] [--token-file <path>] [--store <id> | --add-store <id>] [--adopt] [--dry-run] [--no-daemon]]",
      "              [--provider claude|codex] [--model <id>] [--star] [--repo <owner/repo>] [--yes]",
      "  vault-graph [--all-stores] [--out <path>] [--open] [--vault-dir <path>]",
      "  vault-store list|show|add|set|rename|rm ...",
      "  vault-commit-map <sha-prefix> [--map <tsv>] [--root <tree>]",
      "  vault-migrate to-remote|refmap|other-repo-prefixes|rollback-export ...",
      "  vault-binaries apply --from <reject.json> --root <tree> [--gitignore-decisions <csv>] [--dry-run]",
      "  vault-gate pre-push --root <tree> <remote> <url>",
      "",
    ].join("\n"),
  );
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseFlags(rest);

  switch (command) {
    case "vault-ingest":
      await commandVaultIngest(options, options._);
      return;
    case "vault-lint":
      commandVaultLint(options);
      return;
    case "vault-sync":
      await commandVaultSync(options);
      return;
    case "vault-search":
      await commandVaultSearch(options);
      return;
    case "vault-get":
      await commandVaultGet(options);
      return;
    case "vault-setup":
      await commandVaultSetup(options);
      return;
    case "vault-graph":
      await commandVaultGraph(options);
      return;
    case "vault-store":
      await commandVaultStore(options);
      return;
    case "vault-commit-map":
      await commandVaultCommitMap(options);
      return;
    case "vault-migrate":
      await commandVaultMigrate(options, rest);
      return;
    case "vault-binaries":
      await commandVaultBinaries(options);
      return;
    case "vault-gate":
      await commandVaultGate(options);
      return;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  });
}

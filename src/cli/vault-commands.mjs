// Vault CLI commands (vault-ingest/search/get/lint/sync) — generic distribution build.
//
// This is the standalone CLI adapter for the kuma-vault distribution. It parses arguments
// and calls the extracted engine (imported from the package barrel). Host-specific concerns
// are NOT here: the enrich provider is resolved from ~/.kuma-vault/config.json (not a team
// config), the profile set is the engine's generic built-ins (`kuma-vault` | `docs`), and
// the known-project registry is empty (a generic tree has no dispatch/project attribution).

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { readNumber, readOptionalString } from "./cli-options.mjs";
import { resolveDefaultEnrichGenerator } from "./enrich-config.mjs";
// Compiler vault engine — this package's own public API.
import {
  ENRICH_FIELDS_ALL,
  formatVaultGetText,
  formatVaultLintReport,
  formatVaultSearchText,
  formatVaultSyncReport,
  getVaultDocuments,
  ingestGenericSource,
  ingestInbox,
  ingestResultFile,
  ingestResultFileWithGuards,
  lintVaultFiles,
  resolveResultPathForTaskId,
  resolveVaultContract,
  resolveVaultDir,
  runVaultSync,
  searchVault,
  vaultSyncExitCode,
} from "../index.mjs";

// Generic distribution: no host project registry. Dispatch-ingest project attribution
// (the C4 seam) takes an injected list; a generic tree threads an empty list so no
// slug-prefix inference fires. A consumer with a registry passes its own via the engine API.
function getKnownProjectIds() {
  return [];
}

// Vault subcommand usage. Printed on `--help` for every vault-* command. This is the
// module-local fallback for the direct `cli.mjs vault-* --help` path — the shell wrapper
// (`bin/vault`) prints its own richer usage before ever reaching node. A help request must
// never fall through to a write/default-root run — it prints usage (No Silent Fallback).
function printVaultUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  vault-search --query <q> [--mode search|timeline] [--engine auto|fts|scan] [--limit <n>] [--vault-dir <path>] [--format text|json]",
      "  vault-get <id|path> [more ids...] [--vault-dir <path>] [--format text|json]",
      "  vault-ingest [source] [--section <s>] [--page <p>] [--project <slug>] [--bypass] [--dry-run] [--vault-dir <path>]",
      "  vault-sync [--check] [--enrich] [--enrich-limit <n>] [--root <path>] [--profile <id>] [--json]",
      "  vault-lint [--mode fast|full] [--root <path>] [--profile <id>] [--json] [files...]",
      "",
      "Options:",
      "  --root <path>        Repo-agnostic alias for --vault-dir (the tree to sync/lint)",
      "  --vault-dir <path>   Override the vault root (default: ~/.kuma/vault or KUMA_VAULT_DIR;",
      "                       sync/lint have NO default — they resolve the tree's root",
      "                       vault.config.json declaration, walking up from the cwd)",
      "  --profile <id>       Contract override for an UNDECLARED tree only (kuma-vault | docs).",
      "                       A tree with a vault.config.json owns its contract; a disagreeing",
      "                       --profile is an error",
      "  --check              vault-sync: report drift/would-enrich without writing",
      "  --enrich             vault-sync: fill missing/stale leaf frontmatter description via the configured provider",
      "  --enrich-limit <n>   vault-sync: cap how many pages one enrich run may (re)generate",
      "  --mode <m>           vault-lint: fast | full (default: full)",
      "  --json               Print results as JSON",
      "  --help               Print this usage and exit (no writes)",
      "",
    ].join("\n"),
  );
}

// Fail-loud guard against unknown --options. parseFlags accepts any `--foo`, so without
// this a typo (or a stray `--help` that slipped past the shell wrapper) would be silently
// ignored and the command would run its default write/default-root path. Reject instead
// (No Silent Fallback). `_` positionals are not options and are always allowed.
function assertKnownVaultOptions(options, allowed, command) {
  const known = new Set([...allowed, "help", "_"]);
  const unknown = Object.keys(options).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${command}: unknown option(s) ${unknown.map((key) => `--${key}`).join(", ")}. Run \`${command} --help\` for usage.`,
    );
  }
}

function resolveVaultIngestMode(options) {
  const bypass = options.bypass === true;

  if (bypass && options["full-auto"] === true) {
    throw new Error("vault-ingest cannot use --bypass and --full-auto together.");
  }

  return bypass ? "bypass" : "full-auto";
}

function formatRoutingSummary(preview, sourceLabel = "") {
  const routing = preview?.routing ?? {};
  const candidates = Array.isArray(routing.candidates) ? routing.candidates.slice(0, 3) : [];
  const lines = [
    sourceLabel ? `Source: ${sourceLabel}` : null,
    `Suggested: ${routing.suggestedPath ?? preview?.relativePagePath ?? "(unknown)"}`,
    `Confidence: ${routing.confidence ?? "unknown"}${routing.reason ? ` (${routing.reason})` : ""}`,
  ].filter(Boolean);

  if (candidates.length > 0) {
    lines.push("Candidates:");
    for (const candidate of candidates) {
      lines.push(`- ${candidate.relativePath} (score ${candidate.score})`);
    }
  }

  return lines.join("\n");
}

function collectVaultIngestLintFiles(response, files = new Set()) {
  if (!response || typeof response !== "object") {
    return files;
  }

  if (Array.isArray(response.processed)) {
    for (const entry of response.processed) {
      collectVaultIngestLintFiles(entry, files);
    }
    return files;
  }

  if (typeof response.relativePagePath === "string" && response.relativePagePath.trim()) {
    const relativePagePath = response.relativePagePath.trim();
    files.add(relativePagePath);
    const parts = relativePagePath.replace(/\\/gu, "/").split("/");
    while (parts.length > 1) {
      parts.pop();
      files.add(`${parts.join("/")}/README.md`);
    }
    files.add("README.md");
  }

  if (
    typeof response.action === "string" &&
    ["CREATE", "INGEST", "UPDATE", "INGEST_BATCH", "ARCHIVE"].includes(response.action)
  ) {
    files.add("README.md");
    if (typeof response.relativeArchivePath === "string" && response.relativeArchivePath.trim()) {
      files.add("results/README.md");
    }
    files.add("log.md");
  }

  return files;
}

async function promptVaultIngestDecision(preview, sourceLabel = "") {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `vault-ingest routing is ambiguous for ${sourceLabel || preview?.sourcePath || "this source"}. ` +
      `Use --bypass to accept the best guess, or pass --section/--page/--project explicitly.`,
    );
  }

  const routing = preview?.routing ?? {};
  const candidates = Array.isArray(routing.candidates) ? routing.candidates.slice(0, 3) : [];
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(`${formatRoutingSummary(preview, sourceLabel)}\n`);
    process.stdout.write("Routing is ambiguous. Choose one:\n");
    process.stdout.write("  1) keep suggested\n");
    candidates.forEach((candidate, index) => {
      process.stdout.write(`  ${index + 2}) ${candidate.relativePath}\n`);
    });
    process.stdout.write(`  ${candidates.length + 2}) skip this source\n`);

    const answer = (await rl.question("Select [1]: ")).trim() || "1";
    const selected = Number(answer);
    if (!Number.isInteger(selected) || selected < 1 || selected > candidates.length + 2) {
      throw new Error("Invalid routing choice.");
    }

    if (selected === 1) {
      return { action: "keep" };
    }
    if (selected === candidates.length + 2) {
      return { action: "skip" };
    }

    const candidate = candidates[selected - 2];
    return {
      action: "override",
      page: candidate.relativePath,
    };
  } finally {
    rl.close();
  }
}

export async function commandVaultIngest(options, args = []) {
  if (options.help === true) {
    printVaultUsage();
    return;
  }

  const positionalArgs = Array.isArray(args) ? args.filter((value) => typeof value === "string" && value.trim()) : [];
  const primaryArg = positionalArgs[0] ?? readOptionalString(options, "result-file");
  const activeVaultDir =
    readOptionalString(options, "vault-dir") ??
    readOptionalString(options, "wiki-dir") ??
    undefined;
  const taskDir = readOptionalString(options, "task-dir") ?? undefined;
  const qaStatus = readOptionalString(options, "qa-status") ?? "passed";
  const section = readOptionalString(options, "section") ?? undefined;
  const slug = readOptionalString(options, "slug") ?? undefined;
  const page = readOptionalString(options, "page") ?? undefined;
  const title = readOptionalString(options, "title") ?? undefined;
  const project = readOptionalString(options, "project") ?? undefined;
  const dryRun = options["dry-run"] === true;
  const mode = resolveVaultIngestMode(options);
  const needsInteractivePreview = mode !== "bypass" && !dryRun;
  const signal = readOptionalString(options, "signal") ?? undefined;
  const stampDir = readOptionalString(options, "stamp-dir") ?? undefined;
  const useGuardedResultIngest = Boolean(signal || stampDir);
  // C4 seam: the engine takes the resolved known project ids as an injected parameter
  // (it no longer reads a projects registry itself). The generic CLI has none.
  const knownProjectIds = getKnownProjectIds();

  const maybeResolvePromptOverride = async (preview, sourceLabel) => {
    if (mode === "bypass" || dryRun || preview?.routing?.ambiguous !== true) {
      return { section, slug, page, title, project };
    }

    const decision = await promptVaultIngestDecision(preview, sourceLabel);
    if (decision.action === "skip") {
      return { skip: true };
    }
    if (decision.action === "override") {
      return {
        section,
        slug,
        page: decision.page,
        title,
        project,
      };
    }

    return { section, slug, page, title, project };
  };

  if (!primaryArg) {
    const response = await ingestInbox({
      knownProjectIds,
      vaultDir: activeVaultDir,
      taskDir,
      section,
      qaStatus,
      dryRun,
      routeResolver:
        !needsInteractivePreview
          ? null
          : async ({ entryName, preview }) => {
            if (preview?.routing?.ambiguous !== true) {
              return null;
            }
            const decision = await promptVaultIngestDecision(preview, entryName);
            if (decision.action === "skip") {
              return { skip: true };
            }
            if (decision.action === "override") {
              return { page: decision.page };
            }
            return null;
          },
    });
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  let response;
  if (primaryArg === "result") {
    const taskId = positionalArgs[1];
    if (!taskId) {
      throw new Error("vault-ingest result requires a task id.");
    }
    const resultPath = await resolveResultPathForTaskId(taskId, {
      taskDir,
      vaultDir: activeVaultDir,
    });
    if (useGuardedResultIngest) {
      response = await ingestResultFileWithGuards({
        knownProjectIds,
        resultPath,
        signal,
        stampDir,
        vaultDir: activeVaultDir,
        taskDir,
        section,
        slug,
        page,
        title,
        dryRun,
      });
    } else {
      response = await ingestResultFile({
        knownProjectIds,
        resultPath,
        vaultDir: activeVaultDir,
        taskDir,
        qaStatus,
        section,
        slug,
        page,
        title,
        dryRun,
      });
    }
  } else if (primaryArg.startsWith("raw/")) {
    const rawPath = primaryArg.slice("raw/".length);
    if (!rawPath) {
      throw new Error("vault-ingest raw/<name> requires a raw file path.");
    }
    const resolvedRawPath = resolve(activeVaultDir ?? resolveVaultDir(), "raw", rawPath);
    const resolved = needsInteractivePreview
      ? await (async () => {
        const preview = await ingestGenericSource({
          knownProjectIds,
          source: resolvedRawPath,
          sourceType: "file",
          vaultDir: activeVaultDir,
          taskDir,
          qaStatus,
          section,
          slug,
          page,
          title,
          project,
          dryRun: true,
        });
        const next = await maybeResolvePromptOverride(preview, primaryArg);
        if (next.skip === true) {
          process.stdout.write(`${JSON.stringify({ action: "SKIP", source: primaryArg, routing: preview.routing }, null, 2)}\n`);
          return null;
        }
        return next;
      })()
      : { section, slug, page, title, project };
    if (!resolved) {
      return;
    }
    response = await ingestGenericSource({
      knownProjectIds,
      source: resolvedRawPath,
      sourceType: "file",
      vaultDir: activeVaultDir,
      taskDir,
      qaStatus,
      section: resolved.section,
      slug: resolved.slug,
      page: resolved.page,
      title: resolved.title,
      project: resolved.project,
      dryRun,
    });
  } else {
    const looksLikeResultFile =
      primaryArg.endsWith(".result.md") ||
      Boolean(readOptionalString(options, "result-file"));
    if (looksLikeResultFile) {
      if (useGuardedResultIngest) {
        response = await ingestResultFileWithGuards({
          knownProjectIds,
          resultPath: primaryArg,
          signal,
          stampDir,
          vaultDir: activeVaultDir,
          taskDir,
          section,
          slug,
          page,
          title,
          dryRun,
        });
      } else {
        response = await ingestResultFile({
          knownProjectIds,
          resultPath: primaryArg,
          vaultDir: activeVaultDir,
          taskDir,
          qaStatus,
          section,
          slug,
          page,
          title,
          dryRun,
        });
      }
    } else {
      const resolved = needsInteractivePreview
        ? await (async () => {
          const preview = await ingestGenericSource({
            knownProjectIds,
            source: primaryArg,
            vaultDir: activeVaultDir,
            taskDir,
            qaStatus,
            section,
            slug,
            page,
            title,
            project,
            dryRun: true,
          });
          const next = await maybeResolvePromptOverride(preview, primaryArg);
          if (next.skip === true) {
            process.stdout.write(`${JSON.stringify({ action: "SKIP", source: primaryArg, routing: preview.routing }, null, 2)}\n`);
            return null;
          }
          return next;
        })()
        : { section, slug, page, title, project };
      if (!resolved) {
        return;
      }
      response = await ingestGenericSource({
        knownProjectIds,
        source: primaryArg,
        vaultDir: activeVaultDir,
        taskDir,
        qaStatus,
        section: resolved.section,
        slug: resolved.slug,
        page: resolved.page,
        title: resolved.title,
        project: resolved.project,
        dryRun,
      });
    }
  }

  const lintFiles = dryRun ? [] : [...collectVaultIngestLintFiles(response)];
  if (lintFiles.length > 0) {
    const lint = lintVaultFiles({
      vaultDir: response?.vaultDir ?? activeVaultDir,
      mode: "fast",
      files: lintFiles,
    });
    response = {
      ...response,
      lint,
    };
    if (!lint.ok) {
      process.exitCode = 1;
    }
  }

  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

export async function commandVaultSearch(options) {
  if (options.help === true) {
    printVaultUsage();
    return;
  }

  const query = readOptionalString(options, "query") ?? options._.join(" ").trim();
  if (!query) {
    throw new Error("vault-search requires a query.");
  }

  const mode = readOptionalString(options, "mode") ?? "search";
  const limit = readNumber(options, "limit", 20);
  const engine = readOptionalString(options, "engine") ?? "auto";
  const result = await searchVault({
    query,
    mode,
    limit,
    engine,
    vaultDir: readOptionalString(options, "vault-dir") ?? undefined,
  });

  const format = readOptionalString(options, "format") ?? "text";
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (format !== "text") {
    throw new Error(`Unsupported vault-search format: ${format}`);
  }

  process.stdout.write(formatVaultSearchText(result));
}

export async function commandVaultGet(options) {
  if (options.help === true) {
    printVaultUsage();
    return;
  }

  const ids = Array.isArray(options._)
    ? options._.filter((value) => typeof value === "string" && value.trim())
    : [];
  if (ids.length === 0) {
    throw new Error("vault-get requires at least one id or path.");
  }

  const result = await getVaultDocuments({
    ids,
    vaultDir: readOptionalString(options, "vault-dir") ?? undefined,
  });

  const format = readOptionalString(options, "format") ?? "text";
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (format !== "text") {
    throw new Error(`Unsupported vault-get format: ${format}`);
  }

  process.stdout.write(formatVaultGetText(result));
}

export async function commandVaultSync(options) {
  if (options.help === true) {
    printVaultUsage();
    return;
  }

  assertKnownVaultOptions(
    options,
    // `generateDescription` is an internal injectable seam (E2E driver), never a CLI arg,
    // but programmatic callers pass it, so it is a known key.
    ["check", "enrich", "enrich-limit", "root", "vault-dir", "wiki-dir", "profile", "json", "generateDescription"],
    "vault sync",
  );

  // Root + contract resolve TOGETHER from the tree's own `vault.config.json`
  // declaration (explicit --root/--vault-dir, or discovered walking up from the
  // cwd). There is no default-root/default-contract fallback for sync — an
  // undeclared target without an explicit --profile is a hard error
  // (No Silent Fallback; the 2026-07-07 flag-pair accident class).
  const { vaultDir, profile } = resolveVaultContract({
    root:
      readOptionalString(options, "root") ??
      readOptionalString(options, "vault-dir") ??
      readOptionalString(options, "wiki-dir"),
    profile: readOptionalString(options, "profile"),
  });

  // The composition, the report shape and the exit gate are the engine's (vault-sync-pipeline).
  // This adapter contributes only what is this distribution's own: its provider generator and
  // the field set that generator's response contract supports.
  const report = await runVaultSync({
    vaultDir,
    profile,
    check: options.check === true,
    enrich: options.enrich === true,
    enrichLimit: readNumber(options, "enrich-limit"),
    // This package's provider adapter returns { description, tags, aliases }, so the CLI opts
    // into the full leaf-metadata field set. Check mode uses the same set so it predicts
    // exactly what a write run would fill.
    enrichFields: ENRICH_FIELDS_ALL,
    generateDescription: options.generateDescription,
    createGenerateDescription: resolveDefaultEnrichGenerator,
  });

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatVaultSyncReport(report));
  }

  if (vaultSyncExitCode(report) === 1) {
    process.exitCode = 1;
  }
}

export function commandVaultLint(options) {
  if (options.help === true) {
    printVaultUsage();
    return;
  }

  assertKnownVaultOptions(
    options,
    ["mode", "files", "root", "vault-dir", "wiki-dir", "schema-path", "profile", "json"],
    "vault lint",
  );

  const mode = readOptionalString(options, "mode") ?? "full";
  if (mode !== "fast" && mode !== "full") {
    throw new Error("--mode must be either fast or full.");
  }

  const positionalFiles = Array.isArray(options._)
    ? options._.filter((value) => typeof value === "string" && value.trim())
    : [];
  const filesOption = readOptionalString(options, "files");
  const requestedFiles = positionalFiles.length > 0 ? positionalFiles : filesOption ?? undefined;

  // Same declaration-first resolution as sync (root + contract together, fail-loud).
  const { vaultDir, profile } = resolveVaultContract({
    root:
      readOptionalString(options, "root") ??
      readOptionalString(options, "vault-dir") ??
      readOptionalString(options, "wiki-dir"),
    profile: readOptionalString(options, "profile"),
  });

  const result = lintVaultFiles({
    vaultDir,
    schemaPath: readOptionalString(options, "schema-path") ?? undefined,
    mode,
    files: requestedFiles,
    profile,
  });

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatVaultLintReport(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

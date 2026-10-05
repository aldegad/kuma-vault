// `vault store add|set|rename|rm|list|show` — the one writer of `~/.kuma/vault-stores.json`.
//
// Every change goes through `updateStoreRegistry` (file-commit lock, validation, temp file +
// rename) and is written as registry v2. A store's id is owned by its tree's
// `vault.config.json`; add/set/rename refuse a root whose declaration names a different id, so
// the registry key and the tree id can never drift apart through this CLI.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { loadVaultDeclaration } from "../engine/vault-config.mjs";
import {
  STORE_ID_PATTERN,
  loadStoreRegistry,
  normalizeStoreEntry,
  resolveHomeRelative,
  updateStoreRegistry,
} from "../engine/vault-stores.mjs";
import { readOptionalString } from "./cli-options.mjs";

const USAGE = `Usage:
  vault store list [--json]
  vault store show <id> [--json]
  vault store add <id> --root <tree> [--mode local|remote] [--server <url>] [--remote-store <id>]
                  [--token-file <path>] [--lfs-cache-max-gb <n>] [--default]
  vault store set <id> [--root <tree>] [--mode …] [--server …] [--remote-store …]
                  [--token-file …] [--lfs-cache-max-gb …] [--default] [--clear-search]
  vault store rename <old-id> <new-id> [--root <tree>]
  vault store rm <id>
`;

const ENTRY_FLAGS = ["root", "mode", "server", "remote-store", "token-file", "lfs-cache-max-gb", "default"];

function assertOnly(options, allowed, verb) {
  const unknown = Object.keys(options).filter((key) => key !== "_" && !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`vault store ${verb}: unknown option(s) ${unknown.map((k) => `--${k}`).join(", ")}`);
}

function assertTreeDeclares(root, id) {
  const dir = resolve(resolveHomeRelative(root));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`store root not found: ${dir}`);
  const declaration = loadVaultDeclaration(dir);
  if (!declaration) throw new Error(`no vault.config.json at ${dir} — a store root is a declared tree`);
  if (declaration.id !== id) {
    throw new Error(`${dir}/vault.config.json declares id "${declaration.id ?? "(none)"}", not "${id}" — change the declaration first (the tree owns its id)`);
  }
  return dir;
}

/** Apply entry flags onto an existing (or empty) v2 entry. */
function applyEntryFlags(id, base, options) {
  const next = { ...base };
  const root = readOptionalString(options, "root");
  if (root) next.root = assertTreeDeclares(root, id);
  const mode = readOptionalString(options, "mode");
  if (mode) next.mode = mode;
  const server = readOptionalString(options, "server");
  const remoteStore = readOptionalString(options, "remote-store");
  const tokenFile = readOptionalString(options, "token-file");
  if (server || remoteStore || tokenFile) {
    next.remote = { ...(next.remote ?? {}) };
    if (server) next.remote.server = server;
    if (remoteStore) next.remote.store = remoteStore;
    if (tokenFile) next.remote.tokenFile = resolve(resolveHomeRelative(tokenFile));
  }
  if (next.mode === "remote" && next.remote && !next.remote.store) next.remote.store = id;
  if (next.mode === "local") delete next.remote;
  // The retired `search` key stays as written until it is cleared on purpose.
  if (options["clear-search"] === true) delete next.search;
  if (options["lfs-cache-max-gb"] !== undefined) next.lfsCacheMaxGB = Number(options["lfs-cache-max-gb"]);
  return normalizeStoreEntry(id, next);
}

function describe(id, entry, isDefault) {
  const parts = [`${id}${isDefault ? " (default)" : ""}`, entry.mode, entry.rootDir ?? entry.root];
  if (entry.remote) parts.push(`${entry.remote.server} store=${entry.remote.store}`);
  if (entry.status && entry.status !== "ok") parts.push(`[${entry.status}${entry.declaredId ? ` declares ${entry.declaredId}` : ""}]`);
  return parts.join("\t");
}

export async function commandVaultStore(options) {
  const [verb, ...args] = options._;
  const rest = { ...options, _: args };
  if (!verb || options.help === true) {
    process.stdout.write(USAGE);
    if (!verb && options.help !== true) process.exitCode = 1;
    return;
  }
  switch (verb) {
    case "list":
    case "show": {
      assertOnly(rest, ["json"], verb);
      const registry = loadStoreRegistry();
      if (registry.invalid) throw new Error(`store registry ${registry.path} is invalid: ${registry.invalid}`);
      let ids = [...registry.stores.keys()];
      if (verb === "show") {
        const id = args[0];
        if (!registry.stores.has(id)) throw new Error(`no store "${id}" in ${registry.path}`);
        ids = [id];
      }
      if (options.json === true) {
        const out = Object.fromEntries(ids.map((id) => [id, registry.stores.get(id)]));
        process.stdout.write(`${JSON.stringify({ path: registry.path, version: registry.version, default: registry.default, stores: out }, null, 2)}\n`);
        return;
      }
      if (!registry.present) process.stdout.write(`no store registry at ${registry.path}\n`);
      for (const id of ids) process.stdout.write(`${describe(id, registry.stores.get(id), registry.default === id)}\n`);
      for (const id of ids) {
        if (registry.stores.get(id).search !== undefined) {
          process.stdout.write(`${id}: legacy search field ignored (remove with \`vault store set ${id} --clear-search\`)\n`);
        }
      }
      return;
    }
    case "add": {
      assertOnly(rest, ENTRY_FLAGS, verb);
      const id = args[0];
      if (!id || !STORE_ID_PATTERN.test(id)) throw new Error("vault store add <id> — id is lowercase kebab");
      if (!readOptionalString(options, "root")) throw new Error("vault store add: --root <tree> required");
      const { path } = updateStoreRegistry((doc) => {
        if (doc.stores[id]) throw new Error(`store "${id}" exists — use vault store set`);
        doc.stores[id] = applyEntryFlags(id, { mode: "local" }, options);
        if (options.default === true) doc.default = id;
        return doc;
      });
      process.stdout.write(`added ${id} to ${path}\n`);
      return;
    }
    case "set": {
      assertOnly(rest, [...ENTRY_FLAGS, "clear-search"], verb);
      const id = args[0];
      const { path } = updateStoreRegistry((doc) => {
        if (!doc.stores[id]) throw new Error(`no store "${id}" — use vault store add`);
        doc.stores[id] = applyEntryFlags(id, doc.stores[id], options);
        if (options.default === true) doc.default = id;
        return doc;
      });
      process.stdout.write(`updated ${id} in ${path}\n`);
      return;
    }
    case "rename": {
      assertOnly(rest, ["root"], verb);
      const [from, to] = args;
      if (!from || !to || !STORE_ID_PATTERN.test(to)) throw new Error("vault store rename <old-id> <new-id> — new id is lowercase kebab");
      const { path } = updateStoreRegistry((doc) => {
        const entry = doc.stores[from];
        if (!entry) throw new Error(`no store "${from}"`);
        if (doc.stores[to]) throw new Error(`store "${to}" exists`);
        const root = readOptionalString(options, "root") ?? entry.root;
        const stores = {};
        for (const [key, value] of Object.entries(doc.stores)) {
          stores[key === from ? to : key] = key === from ? { ...value, root: assertTreeDeclares(root, to) } : value;
        }
        doc.stores = stores;
        if (doc.default === from) doc.default = to;
        return doc;
      });
      process.stdout.write(`renamed ${from} -> ${to} in ${path}\n`);
      return;
    }
    case "rm": {
      assertOnly(rest, [], verb);
      const id = args[0];
      const { path } = updateStoreRegistry((doc) => {
        if (!doc.stores[id]) throw new Error(`no store "${id}"`);
        delete doc.stores[id];
        if (doc.default === id) delete doc.default;
        return doc;
      });
      process.stdout.write(`removed ${id} from ${path}\n`);
      return;
    }
    default:
      process.stdout.write(USAGE);
      process.exitCode = 1;
  }
}

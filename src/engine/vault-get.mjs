// `vault get` — read pages by id or path, in this tree or in another registered store.
//
// No index: a target is a tree-relative path (`.md` optional, a folder means its README) or a
// cross-store pointer `<store-id>:<relative/path>` resolved through the machine's store registry.
// Finding the page is the caller's job (a scoped `rg` over the tree on disk).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";

import { resolveVaultDir } from "./path-resolver.mjs";
import { parseFrontmatterDocument } from "./vault-ingest.mjs";
import { STORE_ID_PATTERN, loadStoreRegistry } from "./vault-stores.mjs";

const MARKDOWN_EXTENSION = ".md";

function normalizeRelativePath(value) {
  return String(value ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function normalizeFrontmatterValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .join(", ");
  }

  return String(value ?? "").trim();
}

// `<store-id>:<relative/path>` — the cross-store pointer grammar (docs/cross-store-pointers.md).
function resolveCrossStorePointer(rawTarget, env) {
  const value = String(rawTarget ?? "").trim();
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const storeId = value.slice(0, separator);
  const relativePath = value.slice(separator + 1);
  if (!STORE_ID_PATTERN.test(storeId) || !relativePath) return null;

  const registry = loadStoreRegistry(env);
  if (!registry.present) {
    throw new Error(`Cross-store id "${storeId}" cannot be resolved: no store registry at ${registry.path}.`);
  }
  if (registry.invalid) {
    throw new Error(`Cross-store id "${storeId}" cannot be resolved: ${registry.invalid}`);
  }
  const entry = registry.stores.get(storeId);
  if (!entry) {
    throw new Error(`Unknown store id "${storeId}" — not in ${registry.path}.`);
  }
  if (entry.status !== "ok") {
    throw new Error(`Store "${storeId}" is not usable on this machine (${entry.status}: ${entry.rootDir}).`);
  }
  return { storeId, rootDir: entry.rootDir, target: relativePath };
}

function resolveVaultDocumentTarget(vaultDir, rawTarget) {
  const normalizedTarget = normalizeRelativePath(String(rawTarget ?? "").trim());
  if (!normalizedTarget) {
    throw new Error("vault-get requires at least one id or path.");
  }

  if (normalizedTarget.endsWith(MARKDOWN_EXTENSION) && !existsSync(resolve(vaultDir, normalizedTarget))) {
    throw new Error(`Vault document not found: ${normalizedTarget}`);
  }

  const directPath = resolve(vaultDir, normalizedTarget);
  if (existsSync(directPath)) {
    const readmePath = resolve(directPath, "README.md");
    if (existsSync(readmePath)) {
      const relativePath = normalizeRelativePath(relative(vaultDir, readmePath));
      return {
        id: relativePath,
        path: relativePath,
        fullPath: readmePath,
      };
    }
    return {
      id: normalizedTarget,
      path: normalizedTarget,
      fullPath: directPath,
    };
  }

  const withDefaultExtension = normalizedTarget.endsWith(MARKDOWN_EXTENSION)
    ? normalizedTarget
    : `${normalizedTarget}${MARKDOWN_EXTENSION}`;
  const fullPath = resolve(vaultDir, withDefaultExtension);
  if (existsSync(fullPath)) {
    return {
      id: withDefaultExtension,
      path: withDefaultExtension,
      fullPath,
    };
  }

  throw new Error(`Vault document not found: ${normalizedTarget}`);
}

export async function getVaultDocuments({ ids = [], vaultDir = resolveVaultDir(), env = process.env } = {}) {
  const resolvedVaultDir = resolve(vaultDir);
  if (!existsSync(resolvedVaultDir)) {
    throw new Error(`Vault directory not found: ${resolvedVaultDir}`);
  }

  const normalizedIds = Array.isArray(ids)
    ? ids.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  if (normalizedIds.length === 0) {
    throw new Error("vault-get requires at least one id or path.");
  }

  const hits = [];
  for (const rawId of normalizedIds) {
    const pointer = resolveCrossStorePointer(rawId, env);
    const rootDir = pointer ? pointer.rootDir : resolvedVaultDir;
    const target = resolveVaultDocumentTarget(rootDir, pointer ? pointer.target : rawId);
    const content = await readFile(target.fullPath, "utf8");
    // A large file in a remote store is an LFS pointer on this clone until it is fetched.
    const lfs = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/u.exec(content);
    const { frontmatter } = parseFrontmatterDocument(content);
    const fallbackTitle = basename(target.path) === "README.md"
      ? basename(dirname(target.path))
      : basename(target.path, extname(target.path));
    hits.push({
      id: pointer ? `${pointer.storeId}:${target.path}` : target.id,
      path: target.path,
      title: normalizeFrontmatterValue(frontmatter.title) || fallbackTitle,
      ...(pointer ? { storeId: pointer.storeId, storeRoot: pointer.rootDir } : {}),
      ...(lfs ? { lfsPointer: { oid: lfs[1], size: Number(lfs[2]) } } : {}),
      content,
    });
  }

  return {
    mode: "get",
    vaultDir: resolvedVaultDir,
    hits,
  };
}

export function formatVaultGetText(result) {
  const lines = ["# /vault get", ""];

  for (const [index, hit] of result.hits.entries()) {
    if (index > 0) {
      lines.push("", "---", "");
    }

    lines.push(`## ${hit.title}`);
    lines.push(`id: ${hit.id}`);
    lines.push(`path: ${hit.path}`);
    if (hit.lfsPointer) {
      lines.push(`lfs: pointer (${hit.lfsPointer.size}B, sha256 ${hit.lfsPointer.oid.slice(0, 12)}…) — 내용은 서버에 있다: vault blob get ${hit.path}`);
    }
    lines.push("");
    lines.push(hit.content.trimEnd());
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

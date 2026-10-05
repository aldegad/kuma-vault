// Retired search exports — kept one release so a host that still imports them by name loads.
//
// `vault search` and its FTS index were removed (see CHANGELOG). A host checkout links this
// package rather than copying it, so a host branch cut before the removal still names these
// three in its `import { … } from "kuma-vault"`; without the names its whole module graph would
// fail to load, not just its search path. Each stub loads and throws on call — no fallback, no
// empty result.
//
// Remove this file and its barrel line after the next app install, once no host branch imports
// these names.

export const SEARCH_REMOVED_CODE = "vault-search-removed";

function searchRemoved(name) {
  const error = new Error(
    `vault search was removed: ${name}() no longer exists. Find pages with a scoped rg over the ` +
      "tree (e.g. `rg -n <term> <tree>`) and read them with `vault get <path>` " +
      "(or `vault get <store>:<path>`).",
  );
  error.code = SEARCH_REMOVED_CODE;
  return error;
}

export function searchVault() {
  throw searchRemoved("searchVault");
}

export function formatVaultSearchText() {
  throw searchRemoved("formatVaultSearchText");
}

export function resolveFtsDbPath() {
  throw searchRemoved("resolveFtsDbPath");
}

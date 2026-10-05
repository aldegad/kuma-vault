// The vault's secret directories, by name (the one resolver every surface asks):
//
//   _credentials     the vault's secrets (custody SSoT): never indexed, served or searched, and
//                    kept 0600 files / 0700 directories in every checkout (credential-modes.mjs)
//   _sync-conflicts  the losing side of a sync conflict: never indexed, served or searched
//
// A directory of that name at any depth counts. Names compare after NFC and lower-casing: a
// macOS clone (core.ignorecase=true) treats `_Credentials/` as the same directory. This module
// imports nothing, so the compiler engine, the server and the sync client share it.

export const CREDENTIAL_DIR_NAME = "_credentials";
export const SECRET_DIR_NAMES = Object.freeze([CREDENTIAL_DIR_NAME, "_sync-conflicts"]);

const nameKey = (name) => String(name).normalize("NFC").toLowerCase();
const pathParts = (path) => String(path ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "").split("/");

/**
 * The secret directories as ignore-file patterns (the generated `.rgignore` block): no slash, so
 * a component of that name matches at any depth, and a bracket per letter, so `_Credentials/`
 * matches as well — the same set `isSecretDirName` names.
 */
export function secretDirIgnorePatterns() {
  return SECRET_DIR_NAMES.map((name) => [...name].map((ch) => (/[a-z]/u.test(ch) ? `[${ch}${ch.toUpperCase()}]` : ch)).join(""));
}

export function isSecretDirName(name) {
  return SECRET_DIR_NAMES.includes(nameKey(name));
}

/** Does a tree-relative path cross a secret directory (`_credentials/`, `_sync-conflicts/`)? */
export function crossesSecretDir(relativePath) {
  return pathParts(relativePath).some(isSecretDirName);
}

export function isCredentialDirName(name) {
  return nameKey(name) === CREDENTIAL_DIR_NAME;
}

/**
 * The credential directory a path lies in or is: the path up to and including its first
 * `_credentials` component, spelled as given; null when the path crosses none.
 */
export function credentialRootOf(path) {
  const parts = pathParts(path);
  const at = parts.findIndex(isCredentialDirName);
  return at < 0 ? null : parts.slice(0, at + 1).join("/");
}

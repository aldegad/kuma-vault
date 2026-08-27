// Vault directory resolver (engine-owned).
//
// Extracted from the host `memo-store.mjs` so the engine no longer depends on a
// host panel store (that import created a cycle: the host store imports the
// frontmatter parser from the engine, and the engine imported the resolver back
// from the store). The resolver is a pure, env-driven function with no host ties.

import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Resolve the vault directory.
 * Priority: KUMA_VAULT_DIR > ~/.kuma/vault
 */
export function resolveVaultDir() {
  if (process.env.KUMA_VAULT_DIR) {
    return resolve(process.env.KUMA_VAULT_DIR);
  }

  return resolve(homedir(), ".kuma", "vault");
}

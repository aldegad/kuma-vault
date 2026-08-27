// Default dispatch/ingest paths for the Kuma tool layout (engine-owned defaults).
//
// These are the *default parameter values* for the dispatch-ingest functions in
// vault-ingest.mjs (resolveResultPathForTaskId / ingestResultFile* ). The functions
// keep taking taskDir/resultDir/stampDir as injectable parameters — a consumer that
// runs on a non-Kuma tree either overrides them, sets the KUMA_* env vars, or simply
// never calls the dispatch-ingest slice. The engine no longer imports the host's
// larger kuma-paths module; only these three constants are vendored, with identical
// env-overridable semantics, so behavior is unchanged.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME_DIR = process.env.HOME ?? homedir() ?? ".";

const DEFAULT_KUMA_HOME_DIR = resolve(process.env.KUMA_HOME_DIR ?? join(HOME_DIR, ".kuma"));
const DEFAULT_KUMA_DISPATCH_DIR = resolve(process.env.KUMA_DISPATCH_DIR ?? join(DEFAULT_KUMA_HOME_DIR, "dispatch"));
const DEFAULT_KUMA_RUNTIME_DIR = resolve(process.env.KUMA_RUNTIME_DIR ?? join(DEFAULT_KUMA_HOME_DIR, "runtime"));

export const DEFAULT_DISPATCH_TASK_DIR = resolve(
  process.env.KUMA_TASK_DIR ?? join(DEFAULT_KUMA_DISPATCH_DIR, "tasks"),
);
export const DEFAULT_DISPATCH_RESULT_DIR = resolve(
  process.env.KUMA_RESULT_DIR ?? join(DEFAULT_KUMA_DISPATCH_DIR, "results"),
);
export const DEFAULT_VAULT_INGEST_STAMP_DIR = resolve(
  process.env.KUMA_VAULT_INGEST_STAMP_DIR ?? join(DEFAULT_KUMA_RUNTIME_DIR, "vault-ingest"),
);

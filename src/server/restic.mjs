// restic runner for the server backup job (docs/server.md "Backup").
//
// Secrets never go on a command line or into a log: the repository password is handed to restic
// as RESTIC_PASSWORD_FILE, the S3 keys as environment variables of the restic child only. They
// come from the systemd credential directory ($CREDENTIALS_DIRECTORY, LoadCredential=) when the
// unit runs, or from `backup.credentialsDir` for a root shell. A set but incomplete
// $CREDENTIALS_DIRECTORY is an error, never a reason to look elsewhere.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** File names inside the credential directory (values: vault `_credentials`, custody SSoT). */
export const CREDENTIAL_FILES = Object.freeze({
  password: "restic-password",
  accessKeyId: "s3-access-key-id",
  secretAccessKey: "s3-secret-access-key",
});

function readCredential(dir, name, source) {
  let value;
  try {
    value = readFileSync(join(dir, name), "utf8").trim();
  } catch (error) {
    throw new Error(`backup credential ${name} unreadable in ${dir} (${source}): ${error.code ?? error.message}`);
  }
  if (!value) throw new Error(`backup credential ${name} is empty in ${dir} (${source})`);
  return value;
}

/** Environment for a restic child: the caller's environment minus any RESTIC_/AWS_ variable, plus ours. */
export function resticEnv(backup, env = process.env) {
  const fromSystemd = Boolean(env.CREDENTIALS_DIRECTORY);
  const dir = fromSystemd ? env.CREDENTIALS_DIRECTORY : backup.credentialsDir;
  const source = fromSystemd ? "systemd LoadCredential" : "backup.credentialsDir";
  readCredential(dir, CREDENTIAL_FILES.password, source);
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("RESTIC_") && !key.startsWith("AWS_")) out[key] = value;
  }
  return {
    ...out,
    RESTIC_REPOSITORY: backup.repository,
    RESTIC_PASSWORD_FILE: join(dir, CREDENTIAL_FILES.password),
    AWS_ACCESS_KEY_ID: readCredential(dir, CREDENTIAL_FILES.accessKeyId, source),
    AWS_SECRET_ACCESS_KEY: readCredential(dir, CREDENTIAL_FILES.secretAccessKey, source),
    // systemd CacheDirectory= (the unit); otherwise restic's own default under $HOME
    ...(env.CACHE_DIRECTORY ? { RESTIC_CACHE_DIR: env.CACHE_DIRECTORY } : {}),
  };
}

/**
 * Run restic. With `json: true`, stdout is read as JSON lines (`messages`) or, when it is one
 * JSON document, as `doc`. Rejects on a non-zero exit unless `allowCodes` lists the code.
 * stderr is kept (capped) for the error message; it carries no secret (none is ever passed in).
 */
export function runRestic(args, { env, json = false, allowCodes = [], onLine } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("restic", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const lines = [];
    const err = [];
    let errBytes = 0;
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (onLine) onLine(line);
      else lines.push(line);
    });
    child.stderr.on("data", (chunk) => {
      if (errBytes < 64 * 1024) err.push(chunk);
      errBytes += chunk.length;
    });
    child.on("error", (error) => rejectPromise(new Error(`restic ${args[0]}: ${error.message}`)));
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code !== 0 && !allowCodes.includes(code)) {
        rejectPromise(Object.assign(new Error(`restic ${args[0]} failed (${code}): ${stderr.split("\n").slice(-5).join(" | ")}`), { code, stderr }));
        return;
      }
      const result = { code, stderr, stdout: lines.join("\n") };
      if (json && !onLine) {
        const text = result.stdout.trim();
        if (text.startsWith("[") || (text.startsWith("{") && !text.includes("\n"))) {
          try {
            result.doc = JSON.parse(text);
          } catch {
            result.doc = undefined;
          }
        }
        if (result.doc === undefined) {
          result.messages = [];
          for (const line of lines) {
            if (!line.trim().startsWith("{")) continue;
            try {
              result.messages.push(JSON.parse(line));
            } catch {
              // a progress line cut by a terminal width setting is not a message
            }
          }
        }
      }
      resolvePromise(result);
    });
  });
}

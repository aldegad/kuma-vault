// Shared child-process helpers for studio routes that shell out to CLIs
// (translation providers, kuma-spawn, kuma-plan marker commands).

import { spawn } from "node:child_process";

const DEFAULT_PROCESS_TIMEOUT_MS = 180_000;

export function normalizeCliOutput(stdout) {
  return String(stdout ?? "").trim();
}

/**
 * Spawn `command`, feed `input` to stdin, and resolve {stdout, stderr} on exit
 * code 0. Rejects on non-zero exit (stderr-first message), spawn error, or
 * timeout (SIGTERM). NO_COLOR is forced so CLI output stays parseable.
 */
export function runProcess(command, args, { cwd, input, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Runtime process timed out."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolveProcess({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

// Scope selection is explicit: uncertainty promotes to a reported full pass.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";

export function resolveSyncScope({ vaultDir, profile, incremental = false, changedPaths, full = false, scopeReason } = {}) {
  const whole = (reason) => ({ mode: "full", reason, paths: null });
  if (scopeReason) return whole(scopeReason);
  if (full) return whole("explicit-full");
  if (!incremental && changedPaths === undefined) return whole("default-full");
  let paths = changedPaths;
  let topologyPaths = [];
  if (paths === undefined || (Array.isArray(paths) && paths.length > 0)) {
    const git = (args) => execFileSync("git", ["--no-optional-locks", ...args], { cwd: vaultDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
    try {
      git(["rev-parse", "--verify", "HEAD"]);
    } catch {
      return whole("no-git-baseline");
    }
    try {
      // Separate staged and working deltas: their union also catches a staged change
      // undone in the worktree. Disable renames so both old and new paths are included.
      const observed = [
        git(["diff", "--cached", "--name-only", "--no-renames", "--relative", "-z", "--", "."]),
        git(["diff", "--name-only", "--no-renames", "--relative", "-z", "--", "."]),
        git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
      ].flatMap((s) => s.split("\0").filter(Boolean));
      const topology = [
        git(["diff", "--cached", "--name-only", "--diff-filter=AD", "--no-renames", "--relative", "-z", "--", "."]),
        git(["diff", "--name-only", "--diff-filter=AD", "--no-renames", "--relative", "-z", "--", "."]),
        git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
      ].flatMap((s) => s.split("\0").filter(Boolean));
      paths ??= observed;
      topologyPaths = [...new Set(topology.filter((path) => paths.includes(path)))];
    } catch {
      return whole("changed-paths-unavailable");
    }
  }
  if (!Array.isArray(paths)) return whole("invalid-changed-paths");
  for (const path of paths) {
    if (typeof path !== "string" || !path || isAbsolute(path) || path.split("/").some((p) => p === ".." || p === "." || !p)) return whole("invalid-changed-paths");
    if (["vault.config.json", ".gitattributes", ".gitignore", ".gitmodules"].includes(basename(path)) || path === profile.schema.path) return whole(`contract-changed:${path}`);
    try {
      const stat = lstatSync(join(vaultDir, path));
      if (stat.isDirectory() || stat.isSymbolicLink()) return whole(`non-file-change:${path}`);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return whole(`path-unreadable:${path}`);
    }
  }
  for (const path of paths) {
    if (profile.sidecar && profile.sidecarSourceExtensions.includes(extname(path).toLowerCase()) && !existsSync(join(vaultDir, `${path}.md`))) topologyPaths.push(`${path}.md`);
  }
  return { mode: "incremental", reason: "changed-paths", paths: [...new Set(paths)].sort(), topologyPaths };
}

// Run the vault server's receive rules (src/server/receive-check.mjs of the engine at
// ENGINE) over a whole rewritten history, as if it were one admin push of main plus
// every refs/replace/* into an empty store whose CAS is <cas-root>/lfs/objects.
//
//   node receive_check.mjs <engine> <quarantine.git> <src.git> <cas-root> <out.json>
// quarantine.git: an empty bare repo whose alternates point at src.git's objects,
// so `rev-list <tips> --not --all` sees every commit as new.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [engine, quarantine, src, casRoot, out] = process.argv.slice(2);
const { checkReceive } = await import(`${engine}/src/server/receive-check.mjs`);
const git = (...args) => execFileSync("git", ["--git-dir", src, ...args], { encoding: "utf8" });
const zero = "0".repeat(40);
const updates = [{ oldSha: zero, newSha: git("rev-parse", "refs/heads/main").trim(), ref: "refs/heads/main" }];
for (const line of git("for-each-ref", "--format=%(objectname) %(refname)", "refs/replace").split("\n")) {
  if (!line) continue;
  const [sha, ref] = line.split(" ");
  updates.push({ oldSha: zero, newSha: sha, ref });
}
const config = {
  diskReserveGB: 8,
  maxNonLfsBlobBytes: 32 * 1024 * 1024,
  warnNonLfsBlobBytes: 10 * 1024 * 1024,
  stores: { rehearsal: { path: casRoot, binaries: { reject: [] } } },
};
const t = Date.now();
const r = await checkReceive({ config, storeId: "rehearsal", role: "admin", gitDir: quarantine, updates });
const rep = {
  ms: Date.now() - t,
  updates: updates.length,
  commits: r.commits,
  violations: r.violations.length,
  violationSample: r.violations.slice(0, 30),
  warnings: r.warnings.length,
  warningSample: r.warnings.slice(0, 10),
};
writeFileSync(out, JSON.stringify(rep, null, 2) + "\n");
console.log(`receive rules: ${r.commits} commits, ${r.violations.length} violations, ${r.warnings.length} warnings`);
process.exit(r.violations.length === 0 ? 0 : 1);

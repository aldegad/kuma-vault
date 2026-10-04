import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function snapshot(root, prefix = '') {
  const result = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = join(prefix, name);
    const stat = await lstat(join(root, path));
    if (stat.isDirectory()) result.push([path, 'directory'], ...await snapshot(root, path));
    else if (stat.isFile()) result.push([path, stat.mode & 0o777, createHash('sha256').update(await readFile(join(root, path))).digest('hex')]);
    else throw new Error(`Unsupported artifact entry: ${path}`);
  }
  return result;
}

export async function packagePlugin(destination, { source = sourceRoot } = {}) {
  if (!destination) throw new Error('Usage: npm run package:plugin -- /existing/parent/new-plugin');
  source = await realpath(source);
  const requested = resolve(destination);
  const output = join(await realpath(dirname(requested)), basename(requested));
  if (inside(source, output) || inside(output, source)) throw new Error('Plugin output must be outside the source tree and cannot contain it');
  // Atomic mkdir serializes cooperating publishers for this canonical destination.
  // The first caller wins; contenders fail visibly and may explicitly rerun later.
  const lock = `${output}.lock`;
  await mkdir(lock);
  let stage;
  try {
    stage = await mkdtemp(join(dirname(output), `.${basename(output)}.stage-`));
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: source, encoding: 'utf8' }));
    for (const { path } of pack.files) {
      if (!inside(source, resolve(source, path))) throw new Error(`Invalid package path: ${path}`);
      const stat = await lstat(join(source, path));
      if (!stat.isFile()) throw new Error(`Package entry must be a regular file: ${path}`);
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await copyFile(join(source, path), join(stage, path));
      await chmod(join(stage, path), stat.mode & 0o777);
    }
    const pkg = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
    for (const engine of ['claude', 'codex']) {
      const manifest = JSON.parse(await readFile(join(stage, 'packaging', `${engine}.json`), 'utf8'));
      await mkdir(join(stage, `.${engine}-plugin`));
      await writeFile(join(stage, `.${engine}-plugin`, 'plugin.json'), JSON.stringify({ ...manifest, name: pkg.name, version: pkg.version }, null, 2) + '\n');
    }
    // npm tarballs made from this artifact retain the generated manifests too.
    pkg.files.push('.claude-plugin', '.codex-plugin');
    await writeFile(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    if (await exists(output)) {
      if (!(await lstat(output)).isDirectory() || JSON.stringify(await snapshot(output)) !== JSON.stringify(await snapshot(stage))) {
        throw new Error(`Destination exists with different contents: ${output}; choose a new destination`);
      }
      return { output, status: 'unchanged' };
    }
    await rename(stage, output);
    stage = undefined;
    return { output, status: 'created' };
  } finally {
    if (stage) await rm(stage, { recursive: true });
    await rm(lock, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: npm run package:plugin -- /existing/parent/new-plugin');
    console.log(JSON.stringify(await packagePlugin(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

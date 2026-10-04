import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { packagePlugin } from './package-plugin.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  for (const dir of ['packaging', 'skills/example/docs', 'bin', 'src']) await mkdir(join(source, dir), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'example', version: '1.2.3', files: ['packaging', 'skills', 'bin', 'src', '!src/**/*.test.mjs'], bin: { example: 'bin/example' } }));
  for (const engine of ['claude', 'codex']) await writeFile(join(source, 'packaging', `${engine}.json`), JSON.stringify({ description: 'Synthetic package', skills: './skills/' }));
  await writeFile(join(source, 'skills/example/SKILL.md'), '---\nname: example\ndescription: Synthetic skill\n---\n');
  await writeFile(join(source, 'skills/example/docs/use.md'), 'Example documentation');
  await writeFile(join(source, 'src/excluded.test.mjs'), 'not shipped');
  await writeFile(join(source, 'bin/example'), '#!/usr/bin/env node\nconsole.log("fixture works");\n');
  await chmod(join(source, 'bin/example'), 0o755);
  return { root, source, output: join(root, 'output') };
}

test('ships all catalog assets, executable CLI and manifests; repeat is unchanged', async t => {
  const { source, output } = await fixture(t);
  assert.equal((await packagePlugin(output, { source })).status, 'created');
  const before = (await stat(output)).mtimeMs;
  assert.equal((await packagePlugin(output, { source })).status, 'unchanged');
  assert.equal((await stat(output)).mtimeMs, before);
  assert.match(execFileSync(join(output, 'bin/example'), { encoding: 'utf8' }), /fixture works/);
  assert.equal(await readFile(join(output, 'skills/example/docs/use.md'), 'utf8'), 'Example documentation');
  for (const engine of ['claude', 'codex']) {
    const manifest = JSON.parse(await readFile(join(output, `.${engine}-plugin/plugin.json`)));
    assert.equal(manifest.name, 'example'); assert.equal(manifest.version, '1.2.3');
    await assert.rejects(stat(join(source, `.${engine}-plugin`)), { code: 'ENOENT' });
  }
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: output, encoding: 'utf8' }));
  assert.ok(pack.files.some(f => f.path === '.codex-plugin/plugin.json'));
  assert.ok(!pack.files.some(f => f.path === 'src/excluded.test.mjs'));
});

test('different destination is untouched and staging rolls back', async t => {
  const { source, output, root } = await fixture(t);
  await mkdir(output); await writeFile(join(output, 'owned'), 'keep');
  await assert.rejects(packagePlugin(output, { source }), /different contents/);
  assert.deepEqual(await readdir(output), ['owned']);
  assert.deepEqual((await readdir(root)).sort(), ['output', 'source']);
});

test('invalid template publishes nothing and releases reservation', async t => {
  const { source, output, root } = await fixture(t);
  await writeFile(join(source, 'packaging/codex.json'), '{');
  await assert.rejects(packagePlugin(output, { source }), SyntaxError);
  assert.deepEqual(await readdir(root), ['source']);
});

test('concurrent requests have one winner and a visible collision', async t => {
  const { source, output } = await fixture(t);
  const results = await Promise.allSettled([packagePlugin(output, { source }), packagePlugin(output, { source })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'EEXIST');
  assert.equal((await packagePlugin(output, { source })).status, 'unchanged');
});

test('source ancestry and symlink aliases cannot become plugin roots', async t => {
  const { source, root, output } = await fixture(t);
  await assert.rejects(packagePlugin(join(source, 'artifact'), { source }), /outside the source/);
  await assert.rejects(packagePlugin(root, { source }), /outside the source/);
  await symlink(source, output);
  await assert.rejects(packagePlugin(join(output, 'artifact'), { source }), /outside the source/);
  await assert.rejects(packagePlugin(output, { source }), /different contents/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const script = fileURLToPath(new URL('./package-preview.mjs', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../.tmp/package-tests/', import.meta.url));
await mkdir(fixtureDir, { recursive: true });
async function fixture() {
  const root = await mkdtemp(path.join(fixtureDir, 'llmhubpp-package-'));
  await mkdir(path.join(root, 'dist/llmhubpp-build'), { recursive: true });
  await writeFile(path.join(root, 'dist/llmhubpp-build/main.js'), 'module.exports = {};');
  await writeFile(path.join(root, 'main.js'), 'legacy bundle');
  await writeFile(path.join(root, 'styles.css'), '.llm-hub-chat {}');
  await writeFile(path.join(root, 'LICENSE'), 'MIT fixture');
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ id: 'llm-hub', name: 'LLM Hub', version: '0.36.7', minAppVersion: '1.13.0', isDesktopOnly: true, author: 'takeshy' }));
  await writeFile(path.join(root, 'data.json'), 'PRIVATE_FIXTURE_NOT_FOR_DISTRIBUTION');
  return root;
}
function run(root) {
  return spawnSync(process.execPath, [script, '--source', root], { encoding: 'utf8' });
}
test('preview ZIP includes only installation files and preserves the source identity and bundle', async () => {
  const root = await fixture();
  const before = await readFile(path.join(root, 'manifest.json'), 'utf8');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const { zip, vault } = JSON.parse(result.stdout);
  const entries = unzipSync(await readFile(zip));
  assert.deepEqual(Object.keys(entries).sort(), ['llmhubpp/LICENSE', 'llmhubpp/main.js', 'llmhubpp/manifest.json', 'llmhubpp/styles.css']);
  const manifest = JSON.parse(strFromU8(entries['llmhubpp/manifest.json']));
  assert.equal(manifest.id, 'llmhubpp');
  assert.equal(manifest.name, 'Llmhub++');
  assert.equal(manifest.version, '0.36.7');
  assert.equal(manifest.author, 'takeshy');
  assert.equal(manifest.isDesktopOnly, true);
  assert.equal(await readFile(path.join(root, 'manifest.json'), 'utf8'), before);
  assert.equal(await readFile(path.join(root, 'main.js'), 'utf8'), 'legacy bundle');
  assert.deepEqual(JSON.parse(await readFile(path.join(vault, '.obsidian/community-plugins.json'), 'utf8')), []);
  assert.deepEqual(await readFile(path.join(vault, '.obsidian/plugins/llmhubpp/main.js')), Buffer.from(entries['llmhubpp/main.js']));
  for (const bytes of Object.values(entries)) {
    assert.ok(!Buffer.from(bytes).includes(Buffer.from('PRIVATE_FIXTURE_NOT_FOR_DISTRIBUTION')));
  }
});
test('repackaging creates a new isolated vault and preserves previous test data', async () => {
  const root = await fixture();
  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  const firstVault = JSON.parse(first.stdout).vault;
  await writeFile(path.join(firstVault, 'user-note.md'), 'keep me');
  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(JSON.parse(second.stdout).vault, firstVault);
  assert.equal(await readFile(path.join(firstVault, 'user-note.md'), 'utf8'), 'keep me');
});
test('missing build fails before creating a release or vault', async () => {
  const root = await mkdtemp(path.join(fixtureDir, 'llmhubpp-missing-'));
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
  assert.deepEqual(await readdir(root), []);
});
test('an unexpected source identity is rejected without creating a preview', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ id: 'some-other-plugin', version: '0.36.7' }));
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected the legacy/);
  assert.deepEqual(await readdir(path.join(root, 'dist')), ['llmhubpp-build']);
});

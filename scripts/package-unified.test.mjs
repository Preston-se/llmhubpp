import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const core = ['main.js', 'manifest.json', 'styles.css'];
const buildMeta = 'dist/build-meta.json';
const read = (name, dir = root) => readFile(path.join(dir, name));
const json = async (name, dir = root) => JSON.parse(await read(name, dir));
const pack = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/package-unified.mjs'), ...args], {
  cwd: root, encoding: 'utf8',
});

async function fixture(files) {
  const base = path.join(root, 'dist', 'package-fixtures');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'case-'));
  for (const name of files) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await copyFile(path.join(root, name), path.join(dir, name));
  }
  return dir;
}

async function builtFixture() {
  const dir = await fixture([...core, 'package.json', 'package-lock.json', 'versions.json', 'LICENSE', 'NOTICE.md']);
  const manifest = { ...await json('manifest.json', dir), id: 'llmhubpp' };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const files = {};
  for (const name of core) files[name] = createHash('sha256').update(await read(name, dir)).digest('hex');
  const metadata = {
    version: manifest.version,
    lockSha256: createHash('sha256').update(await read('package-lock.json', dir)).digest('hex'),
    files,
    metafile: { outputs: { 'main.js': { entryPoint: 'src/main-unified.ts' } } },
  };
  await mkdir(path.join(dir, 'dist'));
  await writeFile(path.join(dir, buildMeta), JSON.stringify(metadata));
  return dir;
}

test('default production build describes a unified desktop plugin', async () => {
  const manifest = await json('manifest.json');
  assert.equal(manifest.id, 'llmhubpp');
  assert.equal(manifest.isDesktopOnly, true);
  assert.equal(manifest.version, (await json('package.json')).version);
  assert.equal((await json('versions.json'))[manifest.version], manifest.minAppVersion);

  const { metafile } = await json(buildMeta);
  assert.equal(metafile.outputs['main.js'].entryPoint, 'src/main-unified.ts');
  assert.ok(metafile.outputs['main.js'].inputs['src/safeguard/runtime.js'].bytesInOutput > 0);
  assert.ok(metafile.inputs['src/tracing/langfuse-noop.ts']);
  assert.ok(!Object.keys(metafile.inputs).some(name =>
    /(?:^|\/)node_modules\/langfuse(?:-core)?\//.test(name) || name === 'src/tracing/langfuse.ts'));
});

test('Windows ZIP contains the exact default build and the offline install assets', async () => {
  const manifest = await json('manifest.json');
  const run = pack('--tag', manifest.version);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  const archive = await readFile(result.zip);
  const entries = unzipSync(archive);
  const installed = name => Buffer.from(entries['llmhubpp/' + name]);

  for (const name of core) assert.deepEqual(installed(name), await read(name), name);
  const styles = await read('styles.css');
  const guardCss = await read('resources/safe-guard.css');
  assert.deepEqual(styles.subarray(-guardCss.length), guardCss);
  assert.equal(styles.indexOf(guardCss), styles.lastIndexOf(guardCss), 'Safe Guard CSS appears only once');
  assert.equal(result.version, manifest.version);
  assert.equal(await readFile(result.checksum, 'utf8'),
    createHash('sha256').update(archive).digest('hex') + '  ' + path.basename(result.zip) + '\n');

  for (const name of [
    'resources/settings/knowledge-banner.svg', 'resources/help/index.md',
    'resources/help/mcp-agent-guide.md', 'resources/help/configuration-schema.json',
    'resources/help/images/learning-flow.svg', 'resources/terminal/pty-host.cjs',
    'resources/inbox/Normalize-Xlsx.ps1', 'resources/inbox/Publish-Markdown.ps1',
    'resources/inbox/Ingest-Receipt.ps1', 'resources/inbox/source-auto-ingest.r6.ps1',
    'resources/inbox/Publish-Markdown.r6.ps1', 'resources/inbox/source-auto-ingest.v2.2-fixed.ps1',
    'resources/inbox/source-auto-ingest.ps1', 'resources/inbox/Source-Auto-Ingest.md',
    'node_modules/node-pty/lib/index.js', 'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    'node_modules/node-pty/LICENSE', 'LICENSE', 'NOTICE.md',
  ]) {
    assert.deepEqual(installed(name), await read(name), name);
  }
  for (const name of Object.keys(entries)) {
    assert.doesNotMatch(name, /(^|\/)(data\.json|safe-guard\.json|\.env|legacy-backup|secrets|TestResults|recovery|\.git)(\/|$)/i);
  }
});

test('Windows ZIP includes the upstream notices for bundled dependencies and runtime binaries', async () => {
  const run = pack();
  assert.equal(run.status, 0, run.stderr);
  const entries = unzipSync(await readFile(JSON.parse(run.stdout).zip));
  const installed = name => {
    assert.ok(entries['llmhubpp/' + name], name + ' missing from ZIP');
    return Buffer.from(entries['llmhubpp/' + name]);
  };
  const pty = 'node_modules/node-pty/';
  assert.deepEqual(installed(pty + 'deps/winpty/LICENSE'), await read(pty + 'deps/winpty/LICENSE'));
  assert.deepEqual(installed(pty + 'deps/node-addon-api/LICENSE.md'), await read('node_modules/node-addon-api/LICENSE.md'));
  assert.deepEqual(installed(pty + 'prebuilds/win32-x64/conpty/NOTICE.md'), await read('vendor/licenses/conpty-NOTICE.md'));
  assert.match(installed(pty + 'prebuilds/win32-x64/conpty/LICENSE').toString(), /MIT License/);
  assert.deepEqual(installed('licenses/adobe-core14/MustRead.html'), await read('vendor/licenses/adobe-core14-MustRead.html'));
  for (const name of ['conpty.dll', 'OpenConsole.exe']) {
    assert.deepEqual(installed(pty + 'prebuilds/win32-x64/conpty/' + name),
      await read(pty + 'third_party/conpty/1.23.251008001/win10-x64/' + name));
  }
  const notices = installed('THIRD_PARTY_NOTICES.txt').toString();
  for (const name of ['node_modules/lucide-react/LICENSE', 'node_modules/@xterm/xterm/LICENSE',
    'node_modules/obsidian-llm-hub-common/LICENSE', 'node_modules/openai/LICENSE']) {
    assert.ok(notices.includes((await read(name)).toString().trimEnd()), name);
  }
  assert.match(notices, /standardwebhooks@1\.0\.0/);
  assert.match(notices, /Steph Ango/);
  for (const credit of ['Mozilla Foundation', 'Glyph & Cog', 'Devon Govett', 'Niklas von Hertzen',
    'Christopher Brown', 'Jean-loup Gailly and Mark Adler']) {
    assert.ok(notices.includes(credit), credit);
  }
});

test('release tags must exactly match the manifest version', async () => {
  const manifest = await json('manifest.json');
  for (const tag of ['v' + manifest.version, '0.0.0']) {
    const run = pack('--tag', tag);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /release tag must equal manifest version/i);
  }
});

test('a legacy manifest is rejected before packaging', async () => {
  const dir = await fixture(['manifest.json', 'package.json', 'package-lock.json', 'versions.json']);
  const manifest = await json('manifest.json', dir);
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, id: 'llm-hub' }));
  const run = pack('--source', dir);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /manifest id must be llmhubpp/i);
  assert.ok(!(await readdir(dir)).includes('dist'));
});

test('a missing offline help asset cannot produce a partial ZIP', async () => {
  const dir = await builtFixture();
  const run = pack('--source', dir);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /ENOENT.*requests\.md/);
  assert.deepEqual(await readdir(path.join(dir, 'dist')), ['build-meta.json']);
});

test('packaging refuses a core file changed after the default build', async () => {
  const dir = await builtFixture();
  await writeFile(path.join(dir, 'main.js'), 'module.exports = {};');
  const run = pack('--source', dir);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /main\.js.*does not match the build/i);
  assert.deepEqual(await readdir(path.join(dir, 'dist')), ['build-meta.json']);
});

test('packaging refuses a different dependency lockfile for the same release version', async () => {
  const dir = await builtFixture();
  const lock = await json('package-lock.json', dir);
  lock.packages['node_modules/react'].version = '18.0.0';
  await writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  const run = pack('--source', dir);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /package-lock\.json does not match the build/i);
  assert.deepEqual(await readdir(path.join(dir, 'dist')), ['build-meta.json']);
});

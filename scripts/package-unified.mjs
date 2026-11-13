// Package the verified production build and an explicit set of runtime assets.
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { zipSync } from 'fflate';
import { bundleNotices } from './bundle-notices.mjs';
import { HELP_ASSETS } from './help-assets.mjs';
import { BUILD_META, CORE_ASSETS, readReleaseManifest, sha256 } from './release-manifest.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, tag: { type: 'string' } } });
const root = values.source ? path.resolve(values.source) : fileURLToPath(new URL('../', import.meta.url));
const read = name => readFile(path.join(root, name));
const { manifest, manifestBytes, lockedPackages, lockSha256 } = await readReleaseManifest(root);

if (values.tag !== undefined && values.tag !== manifest.version) {
  throw new Error(`Release tag must equal manifest version ${manifest.version}.`);
}

const build = JSON.parse(await read(BUILD_META));
if (build.version !== manifest.version || build.metafile?.outputs?.['main.js']?.entryPoint !== 'src/main-unified.ts') {
  throw new Error('Expected the current unified production build. Run npm run build.');
}
if (lockSha256 !== build.lockSha256) throw new Error('package-lock.json does not match the build. Run npm run build.');

const files = { 'manifest.json': manifestBytes };
for (const name of CORE_ASSETS) {
  const bytes = files[name] ?? await read(name);
  if (sha256(bytes) !== build.files?.[name]) throw new Error(`${name} does not match the build. Run npm run build.`);
  files[name] = bytes;
}

// Resolve every input before creating an output directory.
for (const name of [
  ...HELP_ASSETS,
  'resources/inbox/source-auto-ingest.ps1',
  'resources/inbox/source-auto-ingest.legacy.ps1',
  'resources/inbox/source-auto-ingest.v2.2-fixed.ps1',
  'resources/inbox/Normalize-Xlsx.ps1',
  'resources/inbox/Publish-Markdown.ps1',
  'resources/inbox/Ingest-Receipt.ps1',
  'resources/inbox/source-auto-ingest.r6.ps1',
  'resources/inbox/Publish-Markdown.r6.ps1',
  'resources/inbox/Source-Auto-Ingest.md',
  'resources/terminal/pty-host.cjs',
  'LICENSE',
  'NOTICE.md',
]) {
  files[name] = await read(name);
}
files['THIRD_PARTY_NOTICES.txt'] = await bundleNotices(root, build.metafile, lockedPackages);
files['licenses/adobe-core14/MustRead.html'] = await read('vendor/licenses/adobe-core14-MustRead.html');

const nativeRoot = 'node_modules/node-pty';
const ptyVersion = JSON.parse(await read(nativeRoot + '/package.json')).version;
if (ptyVersion !== '1.1.0') throw new Error('Expected the audited node-pty 1.1.0 Windows runtime.');

for (const name of ['package.json', 'LICENSE', 'deps/winpty/LICENSE']) {
  files[`${nativeRoot}/${name}`] = await read(`${nativeRoot}/${name}`);
}
files[`${nativeRoot}/deps/node-addon-api/LICENSE.md`] = await read('node_modules/node-addon-api/LICENSE.md');
async function addRuntimeJs(dir) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const name = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await addRuntimeJs(name);
    else if (entry.isFile() && name.endsWith('.js') && !name.includes('test')) files[name] = await read(name);
  }
}
await addRuntimeJs(nativeRoot + '/lib');

const prebuilds = nativeRoot + '/prebuilds/win32-x64';
for (const name of ['conpty_console_list.node', 'conpty.node', 'pty.node', 'winpty-agent.exe', 'winpty.dll']) {
  files[`${prebuilds}/${name}`] = await read(`${prebuilds}/${name}`);
}
// Read the pinned ConPTY files directly so npm lifecycle scripts are unnecessary.
for (const name of ['conpty.dll', 'OpenConsole.exe']) {
  files[`${prebuilds}/conpty/${name}`] = await read(`${nativeRoot}/third_party/conpty/1.23.251008001/win10-x64/${name}`);
}
files[`${prebuilds}/conpty/LICENSE`] = await read('vendor/licenses/conpty-1.23.251008001.txt');
files[`${prebuilds}/conpty/NOTICE.md`] = await read('vendor/licenses/conpty-NOTICE.md');

files['package.json'] = Buffer.from(JSON.stringify({
  name: 'llmhubpp-runtime',
  private: true,
  optionalDependencies: { 'node-pty': ptyVersion },
}));

const names = Object.keys(files).sort();
const archive = zipSync(Object.fromEntries(names.map(name => [`llmhubpp/${name}`, files[name]])), {
  mtime: new Date(2000, 0, 1),
});
const zipSha256 = sha256(archive);

await mkdir(path.join(root, 'dist'), { recursive: true });
const output = await mkdtemp(path.join(root, 'dist/llmhubpp-unified-'));
const vault = path.join(output, 'vault');
const pluginDir = path.join(vault, '.obsidian/plugins/llmhubpp');
for (const name of names) {
  const dest = path.join(pluginDir, name);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, files[name], { flag: 'wx' });
}
await writeFile(path.join(vault, '.obsidian/community-plugins.json'), '[]\n', { flag: 'wx' });
await writeFile(path.join(vault, 'START-HERE.md'),
  '# Llmhub++\n\nEnable Llmhub++ in this isolated vault. The Inbox preset is added to the workspace tools folder.\n',
  { flag: 'wx' });

const zipName = `llmhubpp-${manifest.version}-windows-x64.zip`;
const zip = path.join(output, zipName);
const checksum = path.join(output, 'SHA256SUMS.txt');
await writeFile(zip, archive, { flag: 'wx' });
await writeFile(checksum, `${zipSha256}  ${zipName}\n`, { flag: 'wx' });
const report = path.join(output, 'build-report.json');
await writeFile(report, JSON.stringify({
  schemaVersion: 1,
  platform: 'windows-x64',
  zipName,
  source: {
    commit: process.env.GITHUB_SHA || null,
    repository: process.env.GITHUB_REPOSITORY || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  },
  status: 'windows-x64-candidate',
  pluginId: manifest.id,
  version: manifest.version,
  lockSha256,
  zipSha256,
  files: Object.fromEntries(names.map(name => [name, sha256(files[name])])),
}, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ output, zip, checksum, report, vault, version: manifest.version, zipSha256 }) + '\n');

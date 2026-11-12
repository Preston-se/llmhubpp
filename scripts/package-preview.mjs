// Historical migration scaffold. Its inputs come from a pre-unified-build
// fixture or archive and its output is for an isolated vault.
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--source' || !args[1]) {
  throw new Error('Usage: node scripts/package-preview.mjs --source <historical-preview-root>');
}
const root = path.resolve(args[1]);
// Read every required input before creating any output. Do not enumerate the
// source tree: a package must never pick up data.json, recovery or credentials.
const [bundle, styles, license, manifestBytes] = await Promise.all([
  readFile(path.join(root, 'dist/llmhubpp-build/main.js')),
  readFile(path.join(root, 'styles.css')),
  readFile(path.join(root, 'LICENSE')),
  readFile(path.join(root, 'manifest.json')),
]);
const legacy = JSON.parse(manifestBytes.toString('utf8'));
if (legacy.id !== 'llm-hub' || !/^\d+\.\d+\.\d+$/.test(legacy.version)) {
  throw new Error('Expected the legacy llm-hub source manifest with a semantic version');
}
const manifest = {
  ...legacy,
  id: 'llmhubpp',
  name: 'Llmhub++',
  description: 'Migration preview: LLM Hub baseline. Safe Guard and Inbox integration pending.',
};
const files = {
  'main.js': bundle,
  'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
  'styles.css': styles,
  LICENSE: license,
};
await mkdir(path.join(root, 'dist'), { recursive: true });
// A fresh directory on every run preserves notes/settings from previous tests.
const output = await mkdtemp(path.join(root, 'dist/llmhubpp-preview-'));
const vault = path.join(output, 'vault');
const pluginDir = path.join(vault, '.obsidian/plugins/llmhubpp');
await mkdir(pluginDir, { recursive: true });
for (const [name, bytes] of Object.entries(files)) {
  await writeFile(path.join(pluginDir, name), bytes, { flag: 'wx' });
}
await writeFile(path.join(vault, '.obsidian/community-plugins.json'), '[]\n', { flag: 'wx' });
await writeFile(path.join(vault, 'START-HERE.md'),
  '# Llmhub++ migration preview\n\nThis is an isolated test vault. Enable Llmhub++ manually in Community plugins.\n' +
  'Safe Guard, Inbox presets and legacy data import are not integrated yet.\n' +
  'Legacy workspace, view and storage namespaces remain. Do not enable alongside the old plugin or use in an existing vault.\n',
  { flag: 'wx' });
const zip = path.join(output, `llmhubpp-${legacy.version}-migration-preview.zip`);
const archive = zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`llmhubpp/${name}`, bytes])));
await writeFile(zip, archive, { flag: 'wx' });
await writeFile(path.join(output, 'build-report.json'), JSON.stringify({
  status: 'migration-scaffold-not-accepted',
  legacyPluginId: legacy.id,
  pluginId: manifest.id,
  version: manifest.version,
  zipSha256: createHash('sha256').update(archive).digest('hex'),
  files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])),
  pending: ['legacy-data-mapping', 'runtime-namespace-audit', 'safe-guard', 'inbox-preset', 'obsidian-load-test', 'user-acceptance'],
}, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ output, zip, vault }) + '\n');

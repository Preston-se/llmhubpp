// Read-only checks. Never installs, migrates, rebuilds, or publishes a plugin.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';
import { isReleaseVersion, sha256 } from './release-manifest.mjs';

const requiredChecks = ['install', 'taskCenter', 'indexing', 'searchAuthorization', 'configuration', 'localModels', 'customizations', 'upgrade', 'rollback'];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function verifyCandidate({ zip, checksum, report, version, commit, repository }) {
  assert.ok(isReleaseVersion(version), 'Invalid version');
  assert.match(commit ?? '', /^[a-f0-9]{40}$/, 'Expected full source commit');
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/, 'Expected repository');
  assert.equal(report.schemaVersion, 1, 'Unsupported report schema');
  assert.equal(report.pluginId, 'llmhubpp');
  assert.equal(report.platform, 'windows-x64');
  assert.equal(report.version, version, 'Report version differs');
  assert.equal(report.source?.commit, commit, 'Report commit differs');
  assert.equal(report.source?.repository, repository, 'Report repository differs');
  assert.match(report.source?.runId ?? '', /^[1-9]\d*$/, 'Missing build run');
  assert.match(report.source?.runAttempt ?? '', /^[1-9]\d*$/, 'Missing build attempt');
  const zipName = `llmhubpp-${version}-windows-x64.zip`;
  const zipSha256 = sha256(zip);
  assert.equal(report.zipName, zipName);
  assert.equal(report.zipSha256, zipSha256, 'ZIP differs from report');
  assert.equal(checksum.trim(), `${zipSha256}  ${zipName}`, 'ZIP differs from checksum file');
  const entries = unzipSync(zip);
  assert.deepEqual(Object.keys(entries).sort(), Object.keys(report.files).map(n => `llmhubpp/${n}`).sort(), 'ZIP file list differs');
  for (const [name, digest] of Object.entries(report.files)) {
    assert.ok(!name.includes('\\') && !name.split('/').some(p => p === '..' || p === '.' || p === ''), 'Invalid archive path');
    assert.equal(sha256(entries[`llmhubpp/${name}`]), digest, `File differs: ${name}`);
  }
  for (const name of ['manifest.json', 'main.js', 'styles.css']) assert.ok(entries[`llmhubpp/${name}`], `Missing ${name}`);
  const manifest = JSON.parse(Buffer.from(entries['llmhubpp/manifest.json']).toString());
  assert.equal(manifest.id, 'llmhubpp');
  assert.equal(manifest.version, version);
  assert.equal(manifest.isDesktopOnly, true);
  assert.ok(isReleaseVersion(manifest.minAppVersion));
  return { version, commit, repository, zipSha256, zipName, minAppVersion: manifest.minAppVersion, source: report.source };
}

export function verifyAcceptance(acceptance, candidate) {
  assert.equal(acceptance.schemaVersion, 1, 'Unsupported acceptance schema');
  for (const key of ['version', 'commit', 'zipSha256']) assert.equal(acceptance[key], candidate[key], `Acceptance ${key} differs`);
  assert.equal(acceptance.isolatedVault, true, 'An isolated vault is required');
  assert.ok(nonempty(acceptance.reviewer), 'Missing reviewer');
  assert.match(acceptance.testedAt ?? '', /^\d{4}-\d{2}-\d{2}$/, 'Missing test date');
  assert.ok(nonempty(acceptance.evidence), 'Missing evidence reference');
  assert.deepEqual(acceptance.blockers, [], 'Unresolved blockers');
  assert.equal(acceptance.anonymousDownloadSha256, candidate.zipSha256, 'Public download not verified');
  assert.ok(isReleaseVersion(acceptance.rollbackVersion) && acceptance.rollbackVersion !== candidate.version, 'Invalid rollback version');
  assert.ok(Array.isArray(acceptance.environments) && acceptance.environments.length > 0, 'Missing tested environments');
  for (const env of acceptance.environments) {
    assert.ok(nonempty(env.os) && /^Windows (10|11)(?:\s|$)/.test(env.os), 'Expected tested Windows version');
    assert.equal(env.arch, 'x64');
    assert.ok(isReleaseVersion(env.obsidian), 'Missing Obsidian version');
    for (const check of requiredChecks) assert.equal(env.checks?.[check], 'pass', `Acceptance pending or failed: ${env.os}/${env.obsidian}/${check}`);
  }
  return acceptance.environments.map(({ os, arch, obsidian }) => ({ os, arch, obsidian }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['assets', 'version', 'commit', 'repository', 'acceptance'].map(k => [k, { type: 'string' }])) });
  assert.ok(isReleaseVersion(values.version), 'Invalid version');
  const dir = path.resolve(values.assets);
  const candidate = verifyCandidate({
    version: values.version, commit: values.commit, repository: values.repository,
    zip: await readFile(path.join(dir, `llmhubpp-${values.version}-windows-x64.zip`)),
    checksum: await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8'),
    report: JSON.parse(await readFile(path.join(dir, 'build-report.json'), 'utf8')),
  });
  const environments = values.acceptance ? verifyAcceptance(JSON.parse(await readFile(values.acceptance, 'utf8')), candidate) : undefined;
  process.stdout.write(JSON.stringify({ ...candidate, environments, status: environments ? 'ready-for-promotion' : 'candidate-verified' }, null, 2) + '\n');
}

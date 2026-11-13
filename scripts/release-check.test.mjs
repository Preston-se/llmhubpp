import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { verifyCandidate, verifyAcceptance } from './release-check.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const commit = 'a'.repeat(40);
function fixture() {
  const files = {
    'manifest.json': Buffer.from(JSON.stringify({ id: 'llmhubpp', version: '1.261113.1', minAppVersion: '1.13.0', isDesktopOnly: true })),
    'main.js': Buffer.from('plugin'), 'styles.css': Buffer.from('css'),
  };
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k,v]) => ['llmhubpp/'+k,v])));
  const zipName = 'llmhubpp-1.261113.1-windows-x64.zip';
  return { zip, checksum: `${hash(zip)}  ${zipName}\n`, version: '1.261113.1', commit, repository: 'Preston-se/llmhubpp', report: {
    schemaVersion: 1, pluginId: 'llmhubpp', version: '1.261113.1', platform: 'windows-x64', zipName,
    zipSha256: hash(zip), source: { commit, repository: 'Preston-se/llmhubpp', runId: '123', runAttempt: '1' },
    files: Object.fromEntries(Object.entries(files).map(([k,v]) => [k,hash(v)])),
  }};
}
function acceptance(c) {
  return { schemaVersion: 1, version: c.version, commit: c.commit, zipSha256: c.zipSha256,
    reviewer: 'release maintainer', testedAt: '2026-11-12', evidence: 'https://github.com/Preston-se/llmhubpp/issues/1',
    isolatedVault: true, blockers: [], anonymousDownloadSha256: c.zipSha256,
    rollbackVersion: '1.261112.2', environments: [{ os: 'Windows 10', arch: 'x64', obsidian: '1.15.0',
      checks: { install: 'pass', taskCenter: 'pass', indexing: 'pass', searchAuthorization: 'pass', configuration: 'pass', localModels: 'pass', customizations: 'pass', upgrade: 'pass', rollback: 'pass' } }],
  };
}
test('accepts exact ZIP and completed isolated acceptance without changing bytes', () => {
  const f = fixture(); const before = Buffer.from(f.zip);
  const c = verifyCandidate(f);
  assert.equal(c.commit, commit); assert.equal(c.version, '1.261113.1');
  assert.equal(verifyAcceptance(acceptance(c), c).length, 1);
  assert.deepEqual(Buffer.from(f.zip), before);
});
for (const [name, mutate] of [
  ['changed ZIP', f => { f.zip = Buffer.from('corrupt'); }],
  ['wrong checksum', f => { f.checksum = '0'.repeat(64); }],
  ['wrong commit', f => { f.commit = 'b'.repeat(40); }],
  ['wrong repository', f => { f.repository = 'other/repo'; }],
  ['missing provenance', f => { delete f.report.source; }],
  ['wrong version', f => { f.version = '1.2.3'; }],
  ['changed file manifest', f => { f.report.files['main.js'] = '0'.repeat(64); }],
  ['extra file manifest', f => { f.report.files['data.json'] = '0'.repeat(64); }],
]) test(`rejects ${name}`, () => { const f=fixture(); mutate(f); assert.throws(() => verifyCandidate(f)); });
for (const [name, mutate] of [
  ['different ZIP', a => { a.zipSha256 = '0'.repeat(64); }],
  ['different commit', a => { a.commit = 'b'.repeat(40); }],
  ['pending check', a => { a.environments[0].checks.rollback = 'pending'; }],
  ['missing check', a => { delete a.environments[0].checks.localModels; }],
  ['second failed environment', a => { a.environments.push({...a.environments[0], checks: {}}); }],
  ['no environment', a => { a.environments = []; }],
  ['live vault', a => { a.isolatedVault = false; }],
  ['blocker', a => { a.blockers = ['index lost']; }],
  ['missing public download', a => { delete a.anonymousDownloadSha256; }],
  ['missing reviewer', a => { a.reviewer = ''; }],
  ['same rollback version', a => { a.rollbackVersion = a.version; }],
]) test(`blocks promotion: ${name}`, () => { const c=verifyCandidate(fixture()); const a=acceptance(c); mutate(a); assert.throws(() => verifyAcceptance(a,c)); });

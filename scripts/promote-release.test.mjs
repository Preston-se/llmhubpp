import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { downloadAssets, runPromotion } from './promote-release.mjs';
import { verifyAcceptance } from './release-check.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = 'c'.repeat(40);
const version = '1.261113.1';
const repository = 'Preston-se/llmhubpp';
const zipName = `llmhubpp-${version}-windows-x64.zip`;
const checks = {
  install: 'pass', taskCenter: 'pass', indexing: 'pass', searchAuthorization: 'pass',
  configuration: 'pass', localModels: 'pass', customizations: 'pass', upgrade: 'pass', rollback: 'pass',
};

const fixtureParent = path.join(repoRoot, 'dist', 'promote-fixtures');

async function workspace() {
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(path.join(fixtureParent, 'case-'));
  const assetsDir = path.join(root, 'assets');
  await mkdir(assetsDir, { recursive: true });
  const files = {
    'manifest.json': Buffer.from(JSON.stringify({ id: 'llmhubpp', version, minAppVersion: '1.13.0', isDesktopOnly: true })),
    'main.js': Buffer.from('plugin'),
    'styles.css': Buffer.from('css'),
  };
  const zip = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`llmhubpp/${name}`, bytes]))));
  await writeFile(path.join(assetsDir, zipName), zip);
  await writeFile(path.join(assetsDir, 'SHA256SUMS.txt'), `${hash(zip)}  ${zipName}\n`);
  await writeFile(path.join(assetsDir, 'build-report.json'), JSON.stringify({
    schemaVersion: 1, pluginId: 'llmhubpp', platform: 'windows-x64', version, zipName, zipSha256: hash(zip),
    status: 'windows-x64-candidate',
    source: { commit, repository, runId: '4242', runAttempt: '1' },
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])),
  }, null, 2));
  const acceptance = {
    schemaVersion: 1, version, commit, zipSha256: hash(zip), reviewer: 'release maintainer',
    testedAt: '2026-11-13', evidence: 'https://github.com/Preston-se/llmhubpp/issues/1',
    isolatedVault: true, blockers: [], anonymousDownloadSha256: hash(zip), rollbackVersion: '1.261112.2',
    environments: [{ os: 'Windows 10', arch: 'x64', obsidian: '1.15.0', checks }],
  };
  await mkdir(path.join(root, 'docs', 'releases'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'releases', `${version}.json`), JSON.stringify(acceptance, null, 2));
  return { root, assetsDir, acceptance, zipSha256: hash(zip) };
}

function fakeGh({ overrides = {}, log = [] } = {}) {
  const defaults = {
    [`api repos/${repository}/git/ref/tags/${version} --jq .object.sha`]: commit,
    [`release view ${version} --json isDraft,isPrerelease,tagName`]: JSON.stringify({ isDraft: false, isPrerelease: true, tagName: version }),
    [`api repos/${repository}/actions/runs/4242 --jq .conclusion + " " + .head_sha`]: `success ${commit}`,
  };
  const table = { ...defaults, ...overrides };
  const gh = async args => {
    const key = args.join(' ');
    log.push(args);
    const answer = table[key];
    if (answer === undefined) throw new Error(`unexpected gh call: ${key}`);
    return typeof answer === 'function' ? answer(args) : answer;
  };
  return { gh, log };
}

const cleanup = async root => { await rm(root, { recursive: true, force: true }); };

test('downloads the published beta assets with an explicit file set', async () => {
  await mkdir(fixtureParent, { recursive: true });
  const dir = await mkdtemp(path.join(fixtureParent, 'download-'));
  const log = [];
  const gh = async args => {
    log.push(args);
    for (const name of [zipName, 'SHA256SUMS.txt', 'build-report.json']) {
      await writeFile(path.join(dir, name), 'x');
    }
    return '';
  };
  try {
    await downloadAssets({ version, dir, gh });
    assert.deepEqual(log[0], ['release', 'download', version, '--dir', dir,
      '--pattern', `llmhubpp-${version}-windows-x64.zip`, '--pattern', 'SHA256SUMS.txt', '--pattern', 'build-report.json']);
    for (const name of [zipName, 'SHA256SUMS.txt', 'build-report.json']) {
      assert.equal(await readFile(path.join(dir, name), 'utf8'), 'x', name);
    }
  } finally {
    await cleanup(dir);
  }
});

test('a read-only check reports readiness and never edits the release', async () => {
  const ws = await workspace();
  const { gh, log } = fakeGh();
  try {
    const result = await runPromotion({ root: ws.root, assetsDir: ws.assetsDir, version, repository, gh });
    assert.equal(result.status, 'ready-for-promotion');
    assert.equal(result.promoted, false);
    assert.equal(result.zipSha256, ws.zipSha256);
    assert.deepEqual(result.environments, [{ os: 'Windows 10', arch: 'x64', obsidian: '1.15.0' }]);
    assert.equal(log.some(args => args[0] === 'release' && args[1] === 'edit'), false);
    const written = JSON.parse(await readFile(path.join(ws.root, 'dist', 'promotion', 'verification.json'), 'utf8'));
    assert.equal(written.status, 'ready-for-promotion');
    assert.equal(written.zipSha256, ws.zipSha256);
  } finally {
    await cleanup(ws.root);
  }
});

test('an explicit promotion edits only the existing release', async () => {
  const ws = await workspace();
  const view = () => JSON.stringify({ isDraft: false, isPrerelease: false, tagName: version });
  const { gh, log } = fakeGh({ overrides: {
    [`release view ${version} --json isDraft,isPrerelease,tagName`]: view,
    [`release edit ${version} --prerelease=false --latest`]: '',
  } });
  try {
    const result = await runPromotion({ root: ws.root, assetsDir: ws.assetsDir, version, repository, gh, promote: true });
    assert.equal(result.promoted, true);
    assert.deepEqual(log.filter(args => args[1] === 'edit'), [['release', 'edit', version, '--prerelease=false', '--latest']]);
    assert.equal(log.some(args => args[0] === 'release' && args[1] === 'upload'), false);
    assert.equal(log.some(args => args[0] === 'release' && args[1] === 'create'), false);
  } finally {
    await cleanup(ws.root);
  }
});

test('the command line checks already-downloaded assets without touching the release', async () => {
  const ws = await workspace();
  const shim = path.join(ws.root, 'gh-shim.mjs');
  await writeFile(shim, `const args = process.argv.slice(2);
const out = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
if (args[0] === 'release' && args[1] === 'view') out({ isDraft: false, isPrerelease: true, tagName: args[2] });
else if (args[0] === 'release' && args[1] === 'edit') out('');
else if (args[0] === 'api' && args[1].includes('/git/ref/tags/')) out('${commit}');
else if (args[0] === 'api' && args[1].includes('/actions/runs/')) out('success ${commit}');
else process.exitCode = 2;
`);
  try {
    const run = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'promote-release.mjs'),
      '--version', version, '--repository', repository, '--root', ws.root, '--assets', ws.assetsDir,
    ], { encoding: 'utf8', env: { ...process.env, GH_CLI: shim, PROMOTE_RELEASE: '' } });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'ready-for-promotion');
    assert.equal(result.promoted, false);
    const written = JSON.parse(await readFile(path.join(ws.root, 'dist', 'promotion', 'verification.json'), 'utf8'));
    assert.equal(written.version, version);
    assert.equal(written.zipSha256, ws.zipSha256);
  } finally {
    await cleanup(ws.root);
  }
});

test('the command line refuses a draft before downloading anything', async () => {
  const ws = await workspace();
  const shim = path.join(ws.root, 'gh-draft-shim.mjs');
  await writeFile(shim, `const args = process.argv.slice(2);
if (args[0] === 'release' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ isDraft: true, isPrerelease: true, tagName: args[2] }));
} else {
  process.stderr.write('unexpected gh call: ' + args.join(' '));
  process.exitCode = 2;
}
`);
  try {
    const run = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'promote-release.mjs'),
      '--version', version, '--repository', repository, '--root', ws.root,
    ], { encoding: 'utf8', env: { ...process.env, GH_CLI: shim, PROMOTE_RELEASE: '' } });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /still a draft release/);
    assert.doesNotMatch(run.stderr, /unexpected gh call/);
  } finally {
    await cleanup(ws.root);
  }
});

test('reports a draft release before looking up its missing tag', async () => {
  const ws = await workspace();
  const { gh, log } = fakeGh({ overrides: {
    [`release view ${version} --json isDraft,isPrerelease,tagName`]:
      JSON.stringify({ isDraft: true, isPrerelease: true, tagName: version }),
  } });
  try {
    await assert.rejects(
      runPromotion({ root: ws.root, assetsDir: ws.assetsDir, version, repository, gh, promote: true }),
      /still a draft release/,
    );
    assert.equal(log.some(args => args[0] === 'api' && args[1].includes('/git/ref/tags/')), false,
      'a draft has no tag yet, so the tag lookup must not run first');
  } finally {
    await cleanup(ws.root);
  }
});

test('the shipped example record can never be promoted as-is', async () => {
  const example = JSON.parse(await readFile(path.join(repoRoot, 'docs', 'releases', 'example.json'), 'utf8'));
  const matching = { version: example.version, commit: example.commit, zipSha256: example.zipSha256 };
  assert.ok(example.blockers.length > 0, 'the example must ship blockers');
  assert.equal(Object.values(example.environments[0].checks).every(v => v !== 'pass'), true, 'the example must ship pending checks');
  assert.throws(() => verifyAcceptance(example, matching), /Missing reviewer|Unresolved blockers/);
});

test('a release that stays a prerelease after the edit fails loudly', async () => {
  const ws = await workspace();
  const { gh } = fakeGh({ overrides: {
    [`release edit ${version} --prerelease=false --latest`]: '',
  } });
  try {
    await assert.rejects(
      runPromotion({ root: ws.root, assetsDir: ws.assetsDir, version, repository, gh, promote: true }),
      /still a prerelease/i,
    );
  } finally {
    await cleanup(ws.root);
  }
});

for (const [name, mutate, pattern] of [
  ['a missing acceptance record', async ws => { await rm(path.join(ws.root, 'docs', 'releases', `${version}.json`)); }, /missing acceptance/i],
  ['an acceptance record for another ZIP', async ws => {
    const file = path.join(ws.root, 'docs', 'releases', `${version}.json`);
    const record = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...record, zipSha256: '0'.repeat(64) }));
  }, /Acceptance zipSha256 differs/],
  ['a pending acceptance check', async ws => {
    const file = path.join(ws.root, 'docs', 'releases', `${version}.json`);
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.environments[0].checks.rollback = 'pending';
    await writeFile(file, JSON.stringify(record));
  }, /Acceptance pending or failed/],
  ['an acceptance record for a live vault', async ws => {
    const file = path.join(ws.root, 'docs', 'releases', `${version}.json`);
    const record = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...record, isolatedVault: false }));
  }, /isolated vault is required/i],
  ['a tag that points at another commit', async ws => null, /Report commit differs/],
  ['a ZIP that differs from the published one', async ws => {
    await writeFile(path.join(ws.assetsDir, zipName), Buffer.from('other zip'));
  }, /differs from report/],
  ['a package published before build reports existed', async ws => {
    await rm(path.join(ws.assetsDir, 'build-report.json'));
  }, /Missing build-report\.json/],
  ['a build run that did not succeed', async ws => null, /successful build run/i],
  ['a release that is still a draft', async ws => null, /draft/i],
]) {
  test(`refuses ${name} before promoting`, async () => {
    const ws = await workspace();
    const overrides = {};
    if (name === 'a tag that points at another commit') {
      overrides[`api repos/${repository}/git/ref/tags/${version} --jq .object.sha`] = 'd'.repeat(40);
    }
    if (name === 'a build run that did not succeed') {
      overrides[`api repos/${repository}/actions/runs/4242 --jq .conclusion + " " + .head_sha`] = `failure ${commit}`;
    }
    if (name === 'a release that is still a draft') {
      overrides[`release view ${version} --json isDraft,isPrerelease,tagName`] = JSON.stringify({ isDraft: true, isPrerelease: true, tagName: version });
    }
    const { gh, log } = fakeGh({ overrides });
    try {
      await mutate(ws);
      await assert.rejects(runPromotion({ root: ws.root, assetsDir: ws.assetsDir, version, repository, gh, promote: true }), pattern);
      assert.equal(log.some(args => args[1] === 'edit'), false, 'no edit may run before the checks pass');
    } finally {
      await cleanup(ws.root);
    }
  });
}

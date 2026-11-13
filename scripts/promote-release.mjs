// Read-only by default. Downloads the published beta assets, verifies them against the
// committed acceptance record, and edits the existing release only when explicitly asked.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { verifyAcceptance, verifyCandidate } from './release-check.mjs';

const execFileAsync = promisify(execFile);

export function createGh({ repository, cli }) {
  const command = cli ?? process.env.GH_CLI ?? 'gh';
  const options = { env: { ...process.env, GH_REPO: repository }, maxBuffer: 16 * 1024 * 1024 };
  const isScript = command.endsWith('.mjs') || command.endsWith('.js');
  return async args => {
    const { stdout } = isScript
      ? await execFileAsync(process.execPath, [command, ...args], options)
      : await execFileAsync(command, args, options);
    return stdout;
  };
}

export async function downloadAssets({ version, dir, gh }) {
  await mkdir(dir, { recursive: true });
  await gh([
    'release', 'download', version, '--dir', dir,
    '--pattern', `llmhubpp-${version}-windows-x64.zip`,
    '--pattern', 'SHA256SUMS.txt',
    '--pattern', 'build-report.json',
  ]);
}

export async function readRelease({ version, repository, gh }) {
  // `gh release view` cannot resolve a draft by tag, so list releases and look for the version.
  const releases = JSON.parse(await gh(['release', 'list', '--json', 'tagName,isDraft,isPrerelease', '--limit', '100']));
  const release = releases.find(entry => entry.tagName === version);
  if (!release) {
    throw new Error(`No published release uses ${version}; publish the draft before checking promotion `
      + '(a draft is invisible to a read-only token)');
  }
  return release;
}

export async function runPromotion({ root, assetsDir, version, repository, promote = false, gh }) {
  const acceptancePath = path.join(root, 'docs', 'releases', `${version}.json`);
  let acceptance;
  try {
    acceptance = JSON.parse(await readFile(acceptancePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing acceptance record for ${version}: ${acceptancePath}`);
    throw error;
  }

  // A draft has no published tag, so read the release state before resolving the tag.
  const release = await readRelease({ version, repository, gh });
  assert.equal(release.isDraft, false, `${version} is still a draft release`);

  const tagCommit = (await gh(['api', `repos/${repository}/git/ref/tags/${version}`, '--jq', '.object.sha'])).trim();
  const zipName = `llmhubpp-${version}-windows-x64.zip`;
  const readAsset = async name => {
    try {
      return await readFile(path.join(assetsDir, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`Missing ${name} for ${version}; packages published before the build report cannot be promoted`);
    }
  };
  const candidate = verifyCandidate({
    version, commit: tagCommit, repository,
    zip: await readAsset(zipName),
    checksum: (await readAsset('SHA256SUMS.txt')).toString('utf8'),
    report: JSON.parse((await readAsset('build-report.json')).toString('utf8')),
  });

  const build = (await gh(['api', `repos/${repository}/actions/runs/${candidate.source.runId}`,
    '--jq', '.conclusion + " " + .head_sha'])).trim();
  assert.equal(build, `success ${candidate.commit}`, `${version} has no successful build run for ${candidate.commit}`);

  const environments = verifyAcceptance(acceptance, candidate);

  let promoted = false;
  if (promote) {
    await gh(['release', 'edit', version, '--prerelease=false', '--latest']);
    const after = await readRelease({ version, repository, gh });
    if (after.isPrerelease) throw new Error(`${version} is still a prerelease after promotion`);
    promoted = true;
  }

  const result = {
    schemaVersion: 1,
    status: promoted ? 'stable' : 'ready-for-promotion',
    promoted,
    version,
    commit: candidate.commit,
    repository,
    zipName: candidate.zipName,
    zipSha256: candidate.zipSha256,
    minAppVersion: candidate.minAppVersion,
    testedAt: acceptance.testedAt,
    environments,
  };
  const output = path.join(root, 'dist', 'promotion', 'verification.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    version: { type: 'string' }, repository: { type: 'string' }, assets: { type: 'string' }, root: { type: 'string' },
  } });
  const version = values.version ?? process.env.RELEASE_VERSION;
  const repository = values.repository ?? process.env.GH_REPO;
  const root = values.root ?? fileURLToPath(new URL('../', import.meta.url));
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/, 'Expected owner/repo repository');
  const assetsDir = values.assets
    ? path.resolve(values.assets)
    : path.join(root, 'dist', 'promotion', version, 'assets');
  const gh = createGh({ repository });
  // A draft has nothing published to download, and gh cannot fetch it by tag.
  const release = await readRelease({ version, repository, gh });
  assert.equal(release.isDraft, false, `${version} is still a draft release; publish it before checking promotion`);
  // Published assets are the default source. --assets only replays files already fetched.
  if (!values.assets) await downloadAssets({ version, dir: assetsDir, gh });
  const result = await runPromotion({
    root, assetsDir, version, repository, gh,
    promote: process.env.PROMOTE_RELEASE === 'true',
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

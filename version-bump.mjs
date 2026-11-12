import { readFile, writeFile } from 'node:fs/promises';
import { isReleaseVersion } from './scripts/release-manifest.mjs';

if (process.argv[2] === '--check-next') {
  if (!isReleaseVersion(process.env.npm_new_version)) throw new Error('Use an x.y.z release version.');
} else {
  const readJson = async name => JSON.parse(await readFile(name, 'utf8'));
  const [{ version }, manifest, versions] = await Promise.all(
    ['package.json', 'manifest.json', 'versions.json'].map(readJson),
  );
  if (manifest.id !== 'llmhubpp' || !isReleaseVersion(version) || !isReleaseVersion(manifest.minAppVersion)) {
    throw new Error('Expected the llmhubpp manifest and x.y.z versions.');
  }
  versions[version] = manifest.minAppVersion;
  await writeFile('versions.json', JSON.stringify(versions, null, '\t') + '\n');
  await writeFile('manifest.json', JSON.stringify({ ...manifest, version }, null, '\t') + '\n');
}

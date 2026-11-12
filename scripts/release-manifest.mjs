import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const CORE_ASSETS = ['main.js', 'manifest.json', 'styles.css'];
export const BUILD_META = 'dist/build-meta.json';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function isReleaseVersion(version) {
  return typeof version === 'string' && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/.test(version);
}

export async function readReleaseManifest(root) {
  const [manifestBytes, pkgBytes, lockBytes, versionsBytes] = await Promise.all(
    ['manifest.json', 'package.json', 'package-lock.json', 'versions.json'].map(name => readFile(path.join(root, name))),
  );
  const manifest = JSON.parse(manifestBytes);
  const pkg = JSON.parse(pkgBytes);
  const lock = JSON.parse(lockBytes);
  const versions = JSON.parse(versionsBytes);
  if (manifest.id !== 'llmhubpp') throw new Error('Manifest ID must be llmhubpp.');
  if (manifest.isDesktopOnly !== true) throw new Error('Manifest must declare a desktop-only plugin.');
  if (pkg.name !== manifest.id || lock.name !== manifest.id || lock.packages?.['']?.name !== manifest.id) {
    throw new Error('The npm manifest and lockfile must use the llmhubpp package name.');
  }
  if (!isReleaseVersion(manifest.version) || manifest.version !== pkg.version ||
      manifest.version !== lock.version || manifest.version !== lock.packages?.['']?.version) {
    throw new Error('Expected matching x.y.z versions in manifest.json, package.json, and package-lock.json.');
  }
  if (!isReleaseVersion(manifest.minAppVersion) || versions[manifest.version] !== manifest.minAppVersion) {
    throw new Error('versions.json must map the manifest version to its minAppVersion.');
  }
  return { manifest, manifestBytes, lockedPackages: lock.packages, lockSha256: sha256(lockBytes) };
}

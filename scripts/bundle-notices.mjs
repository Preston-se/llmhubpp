import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const noticeFile = /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*|$)/i;

export async function bundleNotices(root, metafile, lockedPackages) {
  const packageDirs = new Set();
  for (const [name, { bytesInOutput }] of Object.entries(metafile.outputs['main.js'].inputs)) {
    if (bytesInOutput <= 0) continue;
    const match = /^(node_modules\/(?:.*\/node_modules\/)?(?:@[^/]+\/)?[^/]+)\//.exec(name);
    if (match) packageDirs.add(match[1]);
  }

  const sections = ['Third-party notices for the Llmhub++ JavaScript bundle.\n\n'];
  for (const dir of [...packageDirs].sort()) {
    const pkg = JSON.parse(await readFile(path.join(root, dir, 'package.json'), 'utf8'));
    const id = `${pkg.name}@${pkg.version}`;
    if (pkg.version !== lockedPackages[dir]?.version) {
      throw new Error(`Installed ${id} does not match package-lock.json. Run npm ci and rebuild.`);
    }
    const source = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    sections.push(`=== ${id} (${pkg.license ?? 'see license text'}) ===\n`);
    if (source) sections.push(`Source: ${source}\n`);
    const names = (await readdir(path.join(root, dir), { withFileTypes: true }))
      .filter(entry => entry.isFile() && noticeFile.test(entry.name))
      .map(entry => entry.name).sort();

    if (id === 'standardwebhooks@1.0.0') {
      sections.push('The npm package declares MIT. The source repository provides Apache-2.0 terms.\n',
        'Source license: https://github.com/standard-webhooks/standard-webhooks/blob/8ad8586bf2cbea0b2b08fb49ce4b56d42cb870b2/LICENSE\n\n',
        await readFile(path.join(root, 'vendor/licenses/standardwebhooks-1.0.0.txt')), '\n\n');
    } else if (names.length === 0) {
      throw new Error(`Missing upstream license text for bundled dependency ${id}.`);
    }
    for (const name of names) {
      sections.push(`\n${name}\n`, await readFile(path.join(root, dir, name)), '\n\n');
    }
  }

  sections.push('=== Obsidian Skills (MIT) ===\n',
    'Attribution for the shared library’s built-in skills.\n',
    'Source: https://github.com/kepano/obsidian-skills\n\n',
    await readFile(path.join(root, 'vendor/licenses/obsidian-skills.txt')), '\n');
  sections.push('\n', await readFile(path.join(root, 'vendor/licenses/pdf-and-zlib.txt')), '\n');
  return Buffer.concat(sections.map(section => typeof section === 'string' ? Buffer.from(section) : section));
}

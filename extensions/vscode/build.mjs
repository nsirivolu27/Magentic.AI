import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = dirname(fileURLToPath(import.meta.url));
const repo = resolve(source, '../..');
const output = join(repo, 'dist', 'vscode', 'extension');
await mkdir(join(output, 'dist'), { recursive: true });
await mkdir(join(output, 'media'), { recursive: true });
const result = await build({ entryPoints: [join(source, 'extension.mjs')], outfile: join(output, 'dist', 'extension.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], metafile: true, logLevel: 'info' });
for (const file of ['package.json', 'README.md']) await copyFile(join(source, file), join(output, file));
await copyFile(join(source, 'LICENSE'), join(output, 'LICENSE'));
for (const file of await readdir(join(source, 'media'))) await copyFile(join(source, 'media', file), join(output, 'media', file));
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules')) continue;
  let folder = dirname(resolve(input));
  while (folder !== dirname(folder)) {
    try {
      const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) { packages.set(pkg.name, { ...pkg, folder }); break; }
    } catch { /* Bundled source can be nested below its package manifest. */ }
    folder = dirname(folder);
  }
}
let notices = '';
for (const pkg of packages.values()) {
  const license = (await readdir(pkg.folder)).find(name => /^licen[sc]e(?:\.|$)/i.test(name));
  notices += `${pkg.name} ${pkg.version}\n${pkg.license ?? 'See package license'}\n`;
  if (license) notices += await readFile(join(pkg.folder, license), 'utf8');
  notices += '\n\n';
}
await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), notices);
console.log(`VS Code extension built: ${output}`);

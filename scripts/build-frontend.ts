import { copyFile, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const parent = resolve(root, 'dist');
const output = resolve(parent, 'frontend');
// Only this fixed generated directory may be cleared, including on Windows.
if (dirname(output) !== parent || parent !== join(root, 'dist')) throw new Error('Invalid output path');
for (const directory of [parent, output]) {
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Build output must not use symlinks');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'vendor'), { recursive: true });
// Explicit assets only: no server source, environment files, tokens or test reports.
const assets = [
  'index.html',
  'app.js',
  'styles.css',
  'scanner.js',
  'preview.js',
  'demo-barcodes.html',
  'demo-barcodes.css',
  'favicon.svg',
];
for (const asset of assets) await copyFile(join(root, 'public', asset), join(output, asset));
await writeFile(
  join(output, 'runtime-config.js'),
  "export const deployment = Object.freeze({ mode: 'preview' });\n",
);
await copyFile(
  join(root, 'node_modules/@zxing/browser/umd/zxing-browser.min.js'),
  join(output, 'vendor/zxing.js'),
);
await copyFile(
  join(root, 'node_modules/@zxing/browser/LICENSE'),
  join(output, 'vendor/zxing-browser-LICENSE.txt'),
);
await copyFile(
  join(root, 'node_modules/@zxing/library/LICENSE'),
  join(output, 'vendor/zxing-library-LICENSE.txt'),
);
await copyFile(
  join(root, 'node_modules/ts-custom-error/LICENSE'),
  join(output, 'vendor/ts-custom-error-LICENSE.txt'),
);
await copyFile(
  join(root, 'node_modules/@zxing/text-encoding/LICENSE.md'),
  join(output, 'vendor/zxing-text-encoding-LICENSE.txt'),
);
console.log('Static frontend ready: dist/frontend (read-only demonstration; no AWS connection).');

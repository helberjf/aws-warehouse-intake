import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

test('static build contains only public browser assets, a real decoder and preview configuration', async () => {
  const root = resolve(import.meta.dirname, '..');
  const sourceConfig = await readFile(resolve(root, 'public/runtime-config.js'), 'utf8');
  const marker = 'BUILD_ENV_MUST_NOT_REACH_THE_BROWSER_739153';
  await promisify(execFile)(process.execPath, ['scripts/build-frontend.ts'], {
    cwd: root,
    env: { ...process.env, AWS_SECRET_ACCESS_KEY: marker, LOCAL_ADMIN_PASSWORD: marker },
  });
  const output = resolve(root, 'dist/frontend');
  async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((entry) =>
          entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)],
        ),
      )
    ).flat();
  }
  const built = await files(output);
  assert.deepEqual(
    built.map((path) => relative(output, path).replaceAll('\\', '/')).sort(),
    [
      'app.js',
      'demo-barcodes.css',
      'demo-barcodes.html',
      'favicon.svg',
      'index.html',
      'preview.js',
      'runtime-config.js',
      'scanner.js',
      'styles.css',
      'vendor/ts-custom-error-LICENSE.txt',
      'vendor/zxing-browser-LICENSE.txt',
      'vendor/zxing-library-LICENSE.txt',
      'vendor/zxing-text-encoding-LICENSE.txt',
      'vendor/zxing.js',
    ].sort(),
  );
  for (const file of built) assert.equal((await readFile(file, 'utf8')).includes(marker), false);
  assert.match(await readFile(resolve(output, 'runtime-config.js'), 'utf8'), /mode: 'preview'/);
  assert.equal(await readFile(resolve(root, 'public/runtime-config.js'), 'utf8'), sourceConfig);
  assert.match(sourceConfig, /mode: 'connected'/);
  assert.deepEqual(
    await readFile(resolve(output, 'vendor/zxing.js')),
    await readFile(resolve(root, 'node_modules/@zxing/browser/umd/zxing-browser.min.js')),
  );
});

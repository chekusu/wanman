import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { build } from 'esbuild';

const webOutDir = path.resolve('dist/web');

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  external: [],
});

console.log('Build complete: dist/index.js');

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/cli.js',
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: [],
});

console.log('Build complete: dist/cli.js');
await fs.chmod('dist/cli.js', 0o755);

await fs.rm(webOutDir, { recursive: true, force: true });
await fs.mkdir(webOutDir, { recursive: true });

await build({
  entryPoints: ['src/web/app.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  outfile: 'dist/web/app.js',
  sourcemap: true,
});

await fs.copyFile('src/web/index.html', 'dist/web/index.html');
await fs.copyFile('src/web/styles.css', 'dist/web/styles.css');
if (process.env.WANMAN_FINOPS_RUNTIME_DATA) {
  await fs.copyFile(process.env.WANMAN_FINOPS_RUNTIME_DATA, 'dist/web/runtime-data.json');
}

console.log('Build complete: dist/web');

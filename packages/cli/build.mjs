import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: [],
});

console.log('Build complete: dist/index.js');

await build({
  entryPoints: ['src/sdk.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/sdk.js',
  external: [],
});

console.log('Build complete: dist/sdk.js');

await build({
  entryPoints: ['src/standalone-build.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/standalone-build.js',
  external: ['esbuild'],
});

console.log('Build complete: dist/standalone-build.js');

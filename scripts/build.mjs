import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const options = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: true,
  },
  {
    entryPoints: ['webview/main.tsx'],
    outfile: 'dist/webview.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    sourcemap: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
  },
];
if (process.argv.includes('--watch')) {
  await Promise.all(
    options.map(async (o) => {
      const c = await esbuild.context(o);
      await c.watch();
    }),
  );
} else await Promise.all(options.map((o) => esbuild.build(o)));

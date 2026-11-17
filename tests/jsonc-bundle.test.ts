import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
// The build plugin stays ESM so scripts/build.mjs can load it without a TS loader.
// @ts-expect-error esbuild-jsonc.mjs is outside the TypeScript program.
import { jsoncParserEsm } from '../scripts/esbuild-jsonc.mjs';

describe('jsonc-parser bundle', () => {
  it('uses the ESM entry so the extension host does not require ./impl/format', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flutter-pilot-jsonc-'));
    const outfile = join(dir, 'bundle.cjs');
    try {
      await esbuild.build({
        stdin: {
          contents: `import { parse } from 'jsonc-parser';
export const parsed = parse('{ /* comment */ "ok": true, }');
`,
          resolveDir: process.cwd(),
          sourcefile: 'entry.ts',
          loader: 'ts',
        },
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        plugins: [jsoncParserEsm],
      });
      const source = await readFile(outfile, 'utf8');
      expect(source).not.toMatch(/require\((['"])\.\/impl\/format\1\)/);
      const bundled = createRequire(__filename)(outfile) as { parsed: { ok: boolean } };
      expect(bundled.parsed).toEqual({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the production extension bundle enables the same plugin', async () => {
    const source = await readFile(join(process.cwd(), 'scripts/build.mjs'), 'utf8');
    expect(source).toContain('jsoncParserEsm');
    expect(source).toContain('plugins: [jsoncParserEsm]');
  });
});

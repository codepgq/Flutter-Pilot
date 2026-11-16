import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const args = process.argv.slice(2);
if (!args[0] || args.some((arg, i) => i > 0 && !['--check', '--apply'].includes(arg))) {
  console.error('Usage: npm run scenes:migrate -- /path/to/.flutter-pilot [--check|--apply]');
  process.exitCode = 1;
} else {
  const temporary = await mkdtemp(join(tmpdir(), 'pilot-migrate-'));
  try {
    const outfile = join(temporary, 'migration.cjs');
    await build({
      entryPoints: ['src/scene-migration.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    const { migrateScenes } = createRequire(import.meta.url)(outfile);
    console.log(JSON.stringify(await migrateScenes(resolve(args[0]), args.includes('--apply')), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

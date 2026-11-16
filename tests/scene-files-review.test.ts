import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { SceneFiles, hash, json, readText } from '../src/scene-files';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pilot-scene-files-review-'));
  await mkdir(join(directory, 'scenes'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const journalPath = () => join(directory, '.scene-transaction.json');
async function journal(entries: unknown[]) {
  await writeFile(journalPath(), json({ version: 1, entries }));
}
const change = (path = 'scenes/a.json') => ({
  path,
  before: null,
  after: hash('new'),
  temporary: `${path}.${randomUUID()}.tmp`,
});

describe('Scene file recovery review regressions', () => {
  it('preserves a target and temporary file edited after the batch recovery preflight', async () => {
    const first = change('scenes/a.json'),
      second = { ...change('scenes/b.json'), before: hash('old') };
    await writeFile(join(directory, first.temporary), 'new');
    await writeFile(join(directory, second.path), 'old');
    await writeFile(join(directory, second.temporary), 'new');
    await journal([first, second]);
    const files = new SceneFiles(directory, (phase, index) => {
      if (phase === 'replace' && index === 0)
        execFileSync(process.execPath, [
          '-e',
          "require('fs').writeFileSync(process.argv[1], 'human')",
          join(directory, second.temporary),
        ]);
    });
    await expect(files.locked(async () => {})).rejects.toThrow('冲突');
    expect(await readFile(join(directory, first.path), 'utf8')).toBe('new');
    expect(await readFile(join(directory, second.path), 'utf8')).toBe('old');
    expect(await readFile(join(directory, second.temporary), 'utf8')).toBe('human');
    expect(await readFile(journalPath(), 'utf8')).toContain(second.temporary);
  });

  it.each([
    { temporary: 'scenes/../project.json' },
    { path: 'scenes/../project.json' },
    { path: 'scenes//a.json' },
    { path: 'scenes/./a.json' },
    { path: 'scenes/\\outside.json' },
    { before: 'wrong' },
    { after: undefined },
    { temporary: 42 },
    { unexpected: true },
  ])('rejects malformed journal before writing or cleaning anything: %j', async (override) => {
    const first = change();
    await writeFile(join(directory, first.temporary), 'new');
    await writeFile(join(directory, 'project.json'), 'human');
    await journal([first, { ...change('scenes/b.json'), ...override }]);
    const previous = await readFile(journalPath());
    await expect(new SceneFiles(directory).locked(async () => {})).rejects.toThrow('事务');
    expect(await readFile(join(directory, 'project.json'), 'utf8')).toBe('human');
    expect(await readFile(join(directory, first.temporary), 'utf8')).toBe('new');
    expect(await readFile(journalPath())).toEqual(previous);
    await expect(readFile(join(directory, first.path))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects duplicate destinations and temporary/destination aliases', async () => {
    const first = change();
    for (const entries of [
      [first, first],
      [first, change(first.temporary)],
    ]) {
      await journal(entries);
      await expect(new SceneFiles(directory).recover()).rejects.toThrow('事务');
    }
  });
  it('preserves manually modified temporary files even when destination was already applied', async () => {
    const entry = change();
    await writeFile(join(directory, entry.path), 'new');
    await writeFile(join(directory, entry.temporary), 'human');
    await journal([entry]);
    await expect(new SceneFiles(directory).recover()).rejects.toThrow('冲突');
    expect(await readFile(join(directory, entry.temporary), 'utf8')).toBe('human');
    expect(await readFile(journalPath(), 'utf8')).toContain(entry.temporary);
  });
  it('rejects oversized or invalid UTF-8 content before publishing a journal and remains usable', async () => {
    const files = new SceneFiles(directory);
    for (const text of ['中'.repeat(Math.ceil((16 * 1024 * 1024) / 3)), '\uD800']) {
      await expect(
        files.locked(() => files.commit([{ path: 'scenes/a.json', expected: null, text }])),
      ).rejects.toThrow('资源');
      expect(await readdir(join(directory, 'scenes'))).toEqual([]);
      await expect(readFile(journalPath())).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await files.locked(() => files.commit([{ path: 'scenes/a.json', expected: null, text: 'valid' }]));
    expect(await readFile(join(directory, 'scenes/a.json'), 'utf8')).toBe('valid');
  });
  it('accepts the exact resource byte boundary', async () => {
    const text = 'a'.repeat(16 * 1024 * 1024);
    const files = new SceneFiles(directory);
    await files.locked(() => files.commit([{ path: 'scenes/body.txt', expected: null, text }]));
    expect((await readText(directory, 'scenes/body.txt'))?.length).toBe(text.length);
  });
  it('rejects FIFOs without blocking the worker pool', async () => {
    execFileSync('mkfifo', [join(directory, 'scenes', 'fifo')]);
    await expect(readText(directory, 'scenes/fifo')).rejects.toThrow('资源');
  });
  it('relinquishes a reclaim guard after a recoverable exception in the same IDE process', async () => {
    await writeFile(join(directory, '.scene-write.lock'), json({ pid: 2147483647, token: randomUUID() }));
    const broken = new SceneFiles(directory, (phase) => {
      if (phase === 'reclaim') throw new Error('interrupted');
    });
    await expect(broken.locked(async () => {})).rejects.toThrow('interrupted');
    await expect(new SceneFiles(directory).locked(async () => 'recovered')).resolves.toBe('recovered');
  });
  it('recovers after a reclaimer process dies and serializes competing successors', async () => {
    const original = json({ pid: 2147483647, token: randomUUID() });
    await writeFile(join(directory, '.scene-write.lock'), original);
    // Legacy interrupted reclamation directories no longer gate new reclamation.
    await mkdir(join(directory, '.scene-lock-reclaim'));
    const worker = join(directory, 'worker.cjs');
    await build({
      stdin: {
        contents: `import { SceneFiles } from ${JSON.stringify(resolve('src/scene-files.ts'))};\nconst files = new SceneFiles(process.argv[2], phase => { if (phase === 'reclaim' && process.argv[3] === 'crash') process.exit(42); });\nfiles.locked(async () => { process.send?.('entered'); await new Promise(done => setTimeout(done, 80)); process.send?.('left'); }).then(() => process.exit(0), error => { console.error(error); process.exit(1); });`,
        resolveDir: process.cwd(),
        sourcefile: 'worker.ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: worker,
    });
    const run = (mode: string, onEvent?: (message: unknown) => void) =>
      new Promise<number | null>((done, reject) => {
        const child = fork(worker, [directory, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        child.on('error', reject);
        child.on('message', (message) => onEvent?.(message));
        child.on('exit', done);
      });
    expect(await run('crash')).toBe(42);
    let active = 0,
      max = 0;
    const track = (message: unknown) => {
      if (message === 'entered') max = Math.max(max, ++active);
      if (message === 'left') --active;
    };
    const outputs = await Promise.all([run('recover', track), run('recover', track)]);
    expect(outputs).toEqual([0, 0]);
    expect(max).toBe(1);
    await expect(readFile(join(directory, '.scene-write.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 10000);
});

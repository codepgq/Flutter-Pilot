import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareProjectStorage } from '../src/projectStorage';

const execute = promisify(execFile);
const firstId = '0527d142-f9da-4ca8-8610-3c8f7925481a';
const secondId = 'b6c9e4ce-b567-4254-8423-42c0d7102e1e';
const hash = (uri: string) => createHash('sha256').update(uri).digest('hex').slice(0, 24);
async function sql(file: string, query: string) {
  return (await execute('/usr/bin/sqlite3', [file, query])).stdout.trim();
}
async function seed(file: string, value = 'original') {
  await sql(file, `CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('${value}');`);
}

describe('project-private storage migration', () => {
  let temporary: string;
  let root: string;
  let uri: string;
  let legacy: string;
  let clients: ChildProcessWithoutNullStreams[];
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'api-mocks-project-storage-'));
    root = join(temporary, 'private');
    uri = pathToFileURL(join(temporary, 'project')).toString();
    legacy = join(root, 'workspaces', hash(uri));
    await mkdir(legacy, { recursive: true });
    clients = [];
  });
  afterEach(async () => {
    for (const child of clients) {
      child.stdin.end();
      if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
    await rm(temporary, { recursive: true, force: true });
  });

  it('migrates a consistent snapshot including live WAL, preserves source and excludes rules', async () => {
    const database = join(legacy, 'vm-history.sqlite3');
    const child = spawn('/usr/bin/sqlite3', [database]);
    clients.push(child);
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('READY')) resolve();
      });
      child.once('error', reject);
    });
    child.stdin.write(
      "PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('in-wal'); SELECT 'READY';\n",
    );
    await ready;
    await stat(database + '-wal');
    await writeFile(join(legacy, 'rules.json'), '{"privateRule":"not copied"}');
    await writeFile(join(legacy, 'connection.json'), '{"androidDevices":["synthetic-device"]}');
    await mkdir(join(legacy, 'ca'));
    await writeFile(join(legacy, 'ca', 'private-test.pem'), 'synthetic CA');
    const destination = await prepareProjectStorage(root, uri, firstId);
    expect(destination).toBe(join(root, 'projects', firstId, hash(uri)));
    expect(await sql(join(destination, 'vm-history.sqlite3'), 'SELECT value FROM sample')).toBe('in-wal');
    expect(await sql(database, 'SELECT value FROM sample')).toBe('in-wal');
    expect(await readFile(join(destination, 'connection.json'), 'utf8')).toContain('synthetic-device');
    expect(await readFile(join(destination, 'ca', 'private-test.pem'), 'utf8')).toBe('synthetic CA');
    await expect(stat(join(destination, 'rules.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    expect((await stat(join(destination, 'vm-history.sqlite3'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(destination, 'ca', 'private-test.pem'))).mode & 0o777).toBe(0o600);
  });

  it('does not resurrect removed destination history or overwrite later local edits on restart', async () => {
    await seed(join(legacy, 'history.sqlite3'));
    await writeFile(join(legacy, 'connection.json'), '{"mode":"proxy"}');
    const destination = await prepareProjectStorage(root, uri, firstId);
    await rm(join(destination, 'history.sqlite3'));
    await writeFile(join(destination, 'connection.json'), '{"mode":"vm"}');
    await prepareProjectStorage(root, uri, firstId);
    await expect(stat(join(destination, 'history.sqlite3'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(destination, 'connection.json'), 'utf8')).toBe('{"mode":"vm"}');
    await stat(join(legacy, 'history.sqlite3'));
  });

  it('does not import an old path history again for a replacement project UUID', async () => {
    await seed(join(legacy, 'history.sqlite3'));
    const first = await prepareProjectStorage(root, uri, firstId);
    const replacement = await prepareProjectStorage(root, uri, secondId);
    expect(first).not.toBe(replacement);
    await expect(stat(join(replacement, 'history.sqlite3'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(legacy, 'project-binding.json'), 'utf8')).projectId).toBe(firstId);
  });

  it('isolates two checkout directories with the same UUID and serializes concurrent initialization', async () => {
    const secondUri = pathToFileURL(join(temporary, 'copy')).toString();
    const [one, again, two] = await Promise.all([
      prepareProjectStorage(root, uri, firstId),
      prepareProjectStorage(root, uri, firstId),
      prepareProjectStorage(root, secondUri, firstId),
    ]);
    expect(one).toBe(again);
    expect(one).not.toBe(two);
    await seed(join(one, 'history.sqlite3'), 'first-checkout');
    await expect(stat(join(two, 'history.sqlite3'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps existing destination databases instead of replacing them with legacy data', async () => {
    await seed(join(legacy, 'history.sqlite3'), 'legacy');
    const destination = join(root, 'projects', firstId, hash(uri));
    await mkdir(destination, { recursive: true });
    await seed(join(destination, 'history.sqlite3'), 'current');
    await prepareProjectStorage(root, uri, firstId);
    expect(await sql(join(destination, 'history.sqlite3'), 'SELECT value FROM sample')).toBe('current');
  });

  it('leaves a failed migration retryable and never publishes corrupt databases or raw errors', async () => {
    await writeFile(join(legacy, 'history.sqlite3'), 'synthetic-secret-not-a-database');
    const destination = join(root, 'projects', firstId, hash(uri));
    await expect(prepareProjectStorage(root, uri, firstId)).rejects.toThrow('无法准备项目私有存储');
    await expect(stat(join(destination, 'migration.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(destination)).toEqual([]);
    await rm(join(legacy, 'history.sqlite3'));
    await seed(join(legacy, 'history.sqlite3'));
    await prepareProjectStorage(root, uri, firstId);
    expect(await sql(join(destination, 'history.sqlite3'), 'SELECT value FROM sample')).toBe('original');
  });

  it('rejects path traversal UUIDs, nonlocal workspaces and symlinked destination directories', async () => {
    await expect(prepareProjectStorage(root, uri, '../escape')).rejects.toThrow('UUID');
    await expect(prepareProjectStorage(root, 'https://example.test/project', firstId)).rejects.toThrow(
      '本地',
    );
    const outside = join(temporary, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'projects'));
    await expect(prepareProjectStorage(root, uri, firstId)).rejects.toThrow('无法准备');
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses symlinked CA files and allows retry after the link is removed', async () => {
    await mkdir(join(legacy, 'ca'));
    const outside = join(temporary, 'outside-key.pem');
    await writeFile(outside, 'synthetic external content');
    await symlink(outside, join(legacy, 'ca', 'key.pem'));
    await expect(prepareProjectStorage(root, uri, firstId)).rejects.toThrow('无法准备');
    await rm(join(legacy, 'ca', 'key.pem'));
    const destination = await prepareProjectStorage(root, uri, firstId);
    expect(await readdir(join(destination, 'ca'))).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('synthetic external content');
  });

  it('validates existing targets even after migration has completed', async () => {
    const destination = await prepareProjectStorage(root, uri, firstId);
    await mkdir(join(destination, 'history.sqlite3'));
    await expect(prepareProjectStorage(root, uri, firstId)).rejects.toThrow('无法准备');
    await rm(join(destination, 'history.sqlite3'), { recursive: true });
    const outside = join(temporary, 'external-ca');
    await mkdir(outside);
    await writeFile(join(outside, 'key.pem'), 'synthetic external CA');
    await symlink(outside, join(destination, 'ca'));
    await expect(prepareProjectStorage(root, uri, firstId)).rejects.toThrow('无法准备');
    expect(await readFile(join(outside, 'key.pem'), 'utf8')).toBe('synthetic external CA');
  });
});

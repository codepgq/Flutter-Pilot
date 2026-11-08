import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as https from 'node:https';
import { assertSupportedVersion, RuntimeManager, sha256File, validateArchiveEntries } from '../src/runtime';

vi.mock('node:https', () => ({ get: vi.fn() }));
const execute = promisify(execFile);
const temporary: string[] = [];
async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-mocks-runtime-test-'));
  temporary.push(dir);
  return dir;
}
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function mockDownload(bytes: Buffer) {
  vi.mocked(https.get).mockImplementation((...args: unknown[]) => {
    const callback = args[2] as (response: unknown) => void;
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();
    queueMicrotask(() => {
      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
        setTimeout: ReturnType<typeof vi.fn>;
      };
      response.statusCode = 200;
      response.headers = { 'content-length': String(bytes.length) };
      response.setTimeout = vi.fn();
      callback(response);
      response.end(bytes);
    });
    return req as unknown as ReturnType<typeof https.get>;
  });
}
async function writeManifest(root: string, sha256: string, executable = 'mitmdump') {
  const file = path.join(root, 'manifest.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      version: '12.3.1',
      platforms: {
        'darwin-arm64': { url: 'https://downloads.mitmproxy.org/test.tar.gz', sha256, executable },
      },
    }),
  );
  return file;
}

describe('引擎安装和校验', () => {
  it('只接受兼容主版本，不执行不兼容引擎', () => {
    expect(assertSupportedVersion('Mitmproxy: 12.3.1\nPython: 3.15', '12.3.1')).toBe('12.3.1');
    expect(() => assertSupportedVersion('Mitmproxy: 11.0.2', '12.3.1')).toThrow('版本不兼容');
    expect(() => assertSupportedVersion('not mitmproxy', '12.3.1')).toThrow('版本不兼容');
  });
  it('拒绝路径穿越、越界链接和特殊文件，允许 app bundle 内部链接', () => {
    expect(() => validateArchiveEntries(['../private/key'], ['-rw-r--r-- x'])).toThrow('不安全路径');
    expect(() => validateArchiveEntries(['/tmp/x'], ['-rw-r--r-- x'])).toThrow('不安全路径');
    expect(() => validateArchiveEntries(['bundle/link'], ['lrwx x bundle/link -> ../../outside'])).toThrow(
      '越界',
    );
    expect(() => validateArchiveEntries(['bundle/link'], ['hrwx x bundle/link link to other'])).toThrow(
      '不支持',
    );
    expect(() =>
      validateArchiveEntries(
        ['mitmproxy.app/Contents/Frameworks/certifi'],
        ['lrwx x certifi -> ../Resources/certifi'],
      ),
    ).not.toThrow();
  });
  it('缓存查询不会触发下载，不支持平台有明确错误', async () => {
    const root = await temp();
    const manifest = await writeManifest(root, 'a'.repeat(64));
    const manager = new RuntimeManager(root, manifest, 'linux', 'x64');
    expect(await manager.findExecutable()).toBeUndefined();
    expect(https.get).not.toHaveBeenCalled();
    await expect(manager.ensureExecutable()).rejects.toThrow('仅支持 macOS');
  });
  it('下载损坏时丢弃临时文件，支持再次重试', async () => {
    const root = await temp();
    const manifest = await writeManifest(root, 'a'.repeat(64));
    mockDownload(Buffer.from('corrupted archive'));
    const manager = new RuntimeManager(root, manifest, 'darwin', 'arm64');
    await expect(manager.ensureExecutable()).rejects.toThrow('SHA-256 校验失败');
    expect(await fs.readdir(path.join(root, 'engines'))).toEqual([]);
    await expect(manager.ensureExecutable()).rejects.toThrow('SHA-256 校验失败');
    expect(https.get).toHaveBeenCalledTimes(2);
  });
  it('校验、解压、验证版本并缓存真实可执行文件', async () => {
    const root = await temp();
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(source, 'mitmdump'),
      `#!${process.execPath}\nconsole.log('Mitmproxy: 12.3.1');\n`,
      { mode: 0o700 },
    );
    const archive = path.join(root, 'fixture.tar.gz');
    await execute('/usr/bin/tar', ['-czf', archive, '-C', source, 'mitmdump']);
    const bytes = await fs.readFile(archive);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    expect(await sha256File(archive)).toBe(checksum);
    const manifest = await writeManifest(root, checksum);
    mockDownload(bytes);
    const manager = new RuntimeManager(root, manifest, 'darwin', 'arm64');
    const executable = await manager.ensureExecutable();
    expect(executable).toBe(path.join(root, 'engines', '12.3.1-arm64', 'mitmdump'));
    expect(await manager.findExecutable()).toBe(executable);
    expect(await manager.ensureExecutable()).toBe(executable);
    expect(https.get).toHaveBeenCalledTimes(1);
    expect((await fs.stat(executable)).mode & 0o777).toBe(0o700);
  });
});

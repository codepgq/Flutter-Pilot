import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

export interface EngineArtifact {
  url: string;
  sha256: string;
  executable: string;
}
export interface EngineManifest {
  schemaVersion: 1;
  version: string;
  platforms: Record<string, EngineArtifact>;
}

/** Reject traversal and links escaping the archive; macOS app bundles use internal links. */
export function validateArchiveEntries(names: string[], verboseEntries: string[]): void {
  if (!names.length || names.length > 20000) throw new Error('引擎压缩包内容为空或文件过多。');
  for (const name of names) {
    const normalized = name.replace(/\\/g, '/');
    if (
      !normalized ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').some((part) => part === '..') ||
      normalized.includes('\0')
    ) {
      throw new Error(`引擎压缩包包含不安全路径：${name}`);
    }
  }
  if (verboseEntries.length !== names.length) throw new Error('引擎压缩包目录清单不一致。');
  for (let index = 0; index < verboseEntries.length; index++) {
    const line = verboseEntries[index];
    if (line[0] === 'l') {
      const target = line.split(' -> ').slice(1).join(' -> ');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(names[index]), target));
      if (
        !target ||
        target.startsWith('/') ||
        target.includes('\\') ||
        resolved === '..' ||
        resolved.startsWith('../')
      ) {
        throw new Error('引擎压缩包包含越界符号链接。');
      }
    } else if (line[0] !== '-' && line[0] !== 'd') {
      throw new Error('引擎压缩包包含不支持的文件类型。');
    }
  }
}

export function assertSupportedVersion(output: string, requiredVersion: string): string {
  const version = output.match(/Mitmproxy:\s*(\d+\.\d+\.\d+)/i)?.[1];
  if (!version || version.split('.')[0] !== requiredVersion.split('.')[0]) {
    throw new Error(`需要 mitmproxy ${requiredVersion.split('.')[0]}.x，本地引擎版本不兼容。`);
  }
  return version;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function requestDownload(url: string, redirects = 0): Promise<import('node:http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') return reject(new Error('引擎下载必须使用 HTTPS。'));
    const req = https.get(target, { headers: { 'User-Agent': 'flutter-api-mocks' } }, (res) => {
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 5 || !res.headers.location) return reject(new Error('引擎下载重定向次数过多。'));
        requestDownload(new URL(res.headers.location, target).href, redirects + 1).then(resolve, reject);
      } else if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`引擎下载失败：HTTP ${res.statusCode}`));
      } else {
        res.setTimeout(30000, () => res.destroy(new Error('引擎下载超时，请重试。')));
        resolve(res);
      }
    });
    req.setTimeout(30000, () => req.destroy(new Error('引擎下载连接超时，请重试。')));
    req.on('error', reject);
  });
}

export class RuntimeManager extends EventEmitter {
  private installation?: Promise<string>;
  constructor(
    private readonly storageRoot: string,
    private readonly manifestPath: string,
    private readonly platform: string = process.platform,
    private readonly arch: string = process.arch,
  ) {
    super();
  }

  private async manifest(): Promise<EngineManifest> {
    const value = JSON.parse(await fs.readFile(this.manifestPath, 'utf8')) as EngineManifest;
    if (value.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(value.version))
      throw new Error('引擎清单格式无效。');
    return value;
  }

  /** A read-only cache lookup: opening the workbench never triggers a download. */
  async findExecutable(localPath?: string): Promise<string | undefined> {
    const manifest = await this.manifest();
    if (localPath) {
      await this.validateExecutable(localPath, manifest.version);
      return path.resolve(localPath);
    }
    const artifact = manifest.platforms[`${this.platform}-${this.arch}`];
    if (!artifact) return undefined;
    const root = path.join(this.storageRoot, 'engines', `${manifest.version}-${this.arch}`);
    try {
      const receipt = JSON.parse(await fs.readFile(path.join(root, 'installation.json'), 'utf8'));
      if (receipt.sha256 !== artifact.sha256 || receipt.version !== manifest.version) return undefined;
      const executable = path.join(root, artifact.executable);
      await fs.access(executable, fs.constants.X_OK);
      return executable;
    } catch {
      return undefined;
    }
  }

  async ensureExecutable(localPath?: string): Promise<string> {
    if (localPath) {
      const manifest = await this.manifest();
      await this.validateExecutable(localPath, manifest.version);
      return path.resolve(localPath);
    }
    if (this.installation) return this.installation;
    this.installation = this.install();
    try {
      return await this.installation;
    } finally {
      this.installation = undefined;
    }
  }

  private async validateExecutable(file: string, requiredVersion: string): Promise<void> {
    if (!path.isAbsolute(file)) throw new Error('请选择 mitmdump 的绝对路径。');
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('引擎路径必须指向可执行文件。');
    const result = await execute(file, ['--version'], { timeout: 30000, maxBuffer: 64 * 1024 });
    assertSupportedVersion(`${result.stdout}\n${result.stderr}`, requiredVersion);
  }

  private async install(): Promise<string> {
    const cached = await this.findExecutable();
    if (cached) return cached;
    const manifest = await this.manifest();
    const artifact = manifest.platforms[`${this.platform}-${this.arch}`];
    if (!artifact) throw new Error('首版仅支持 macOS Apple Silicon 和 Intel；可在设置中选择本地兼容引擎。');
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('引擎清单缺少有效的 SHA-256。');
    const engines = path.join(this.storageRoot, 'engines');
    await fs.mkdir(engines, { recursive: true, mode: 0o700 });
    const temp = path.join(engines, `.install-${randomUUID()}`);
    await fs.mkdir(temp, { mode: 0o700 });
    const archive = path.join(temp, 'engine.tar.gz');
    try {
      this.emit('progress', `正在下载 mitmproxy ${manifest.version}（${this.arch}）…`);
      const response = await requestDownload(artifact.url);
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > MAX_DOWNLOAD_BYTES) {
        response.destroy();
        throw new Error('引擎下载体积超出限制。');
      }
      let received = 0;
      let lastPercent = -1;
      const meter = new Transform({
        transform: (chunk, _encoding, callback) => {
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) return callback(new Error('引擎下载体积超出限制。'));
          const percent = declared ? Math.floor((received / declared) * 100) : Math.floor(received / 1048576);
          if (percent !== lastPercent) {
            lastPercent = percent;
            this.emit('progress', declared ? `正在下载引擎：${percent}%` : `正在下载引擎：${percent} MiB`);
          }
          callback(null, chunk);
        },
      });
      await pipeline(response, meter, createWriteStream(archive, { mode: 0o600, flags: 'wx' }));
      if ((await sha256File(archive)) !== artifact.sha256)
        throw new Error('引擎 SHA-256 校验失败，下载已丢弃，请重试。');
      this.emit('progress', '下载校验成功，正在解压引擎…');
      const listing = await execute('/usr/bin/tar', ['-tzf', archive], { maxBuffer: 4 * 1024 * 1024 });
      const verbose = await execute('/usr/bin/tar', ['-tvzf', archive], { maxBuffer: 4 * 1024 * 1024 });
      validateArchiveEntries(listing.stdout.trim().split('\n'), verbose.stdout.trim().split('\n'));
      const extracted = path.join(temp, 'content');
      await fs.mkdir(extracted, { mode: 0o700 });
      await execute('/usr/bin/tar', ['-xzf', archive, '-C', extracted, '--no-same-owner'], {
        timeout: 120000,
      });
      const executable = path.join(extracted, artifact.executable);
      await fs.chmod(executable, 0o700);
      await this.validateExecutable(executable, manifest.version);
      await fs.writeFile(
        path.join(extracted, 'installation.json'),
        JSON.stringify({
          version: manifest.version,
          sha256: artifact.sha256,
          installedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      const destination = path.join(engines, `${manifest.version}-${this.arch}`);
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rename(extracted, destination);
      this.emit('progress', '代理引擎安装完成。');
      return path.join(destination, artifact.executable);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}

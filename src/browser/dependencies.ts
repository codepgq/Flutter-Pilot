import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, delimiter, resolve } from 'node:path';
import { BrowserError } from './protocol';
import { sha256File } from '../runtime';
import { detectNodeRuntime } from '../mcp/adapters';

const systemBrowserCandidates = () => [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

interface DependencyOptions {
  systemBrowsers?: string[];
  timeoutMs?: number;
}

function throwCancelled(): never {
  throw new BrowserError('CANCELLED', '浏览器依赖准备已取消。');
}

export class BrowserDependencies extends EventEmitter {
  private task?: Promise<void>;
  private cancellation?: AbortController;
  private nodePath?: string;
  private readonly systemBrowsers: string[];
  private readonly timeoutMs: number;
  constructor(
    readonly root: string,
    readonly resources: string,
    options: DependencyOptions = {},
  ) {
    super();
    this.systemBrowsers = options.systemBrowsers ?? systemBrowserCandidates();
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }
  private async manifestHash() {
    return createHash('sha256')
      .update(await readFile(join(this.resources, 'package-lock.json')))
      .digest('hex');
  }
  async status() {
    try {
      const receipt = JSON.parse(await readFile(join(this.root, 'receipt.json'), 'utf8'));
      if (receipt.lockHash !== (await this.manifestHash()) || receipt.version !== '1.65.0')
        throw new Error('manifest mismatch');
      const pkg = JSON.parse(await readFile(join(this.root, 'node_modules/playwright/package.json'), 'utf8'));
      if (pkg.version !== receipt.version) throw new Error('package mismatch');
      const stat = await lstat(receipt.executable);
      if (!stat.isFile()) throw new Error('browser missing');
      const managed = receipt.executable.startsWith(this.root + '/');
      const approvedSystem =
        receipt.source === 'system' &&
        this.systemBrowsers.some((candidate) => resolve(candidate) === resolve(receipt.executable));
      if (!managed && !approvedSystem) throw new Error('browser executable outside managed directory');
      const executableHash = await sha256File(receipt.executable);
      if (executableHash !== receipt.executableHash) throw new Error('browser checksum mismatch');
      return {
        prepared: true,
        version: receipt.version,
        lockHash: receipt.lockHash,
        executableHash,
        executable: receipt.executable,
        source: receipt.source === 'system' ? ('system' as const) : ('managed' as const),
      };
    } catch (error) {
      const candidate = await this.findSystemBrowser();
      return {
        prepared: false,
        reason: (error as Error).message,
        ...(candidate ? { systemBrowserAvailable: true } : {}),
      };
    }
  }
  async prepare(signal?: AbortSignal) {
    if (this.task)
      throw new BrowserError('BROWSER_PREPARING', 'Browser dependencies are already being prepared.');
    this.cancellation = new AbortController();
    this.task = this.install(
      signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal,
    );
    try {
      await this.task;
    } finally {
      this.task = undefined;
      this.cancellation = undefined;
    }
    return this.status();
  }
  private async install(signal?: AbortSignal) {
    if (signal?.aborted) throwCancelled();
    if ((await this.status()).prepared) return;
    this.nodePath = await detectNodeRuntime();
    if (!this.nodePath)
      throw new BrowserError(
        'NODE_REQUIRED',
        'Browser preparation requires a compatible Node.js installation.',
      );
    const staging = this.root + '-' + randomUUID();
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      for (const file of ['package.json', 'package-lock.json'])
        await copyFile(join(this.resources, file), join(staging, file));
      this.emit('progress', '准备 Playwright 运行时依赖…');
      if (signal?.aborted) throwCancelled();
      await this.run(
        'npm',
        ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        staging,
        signal,
        '安装 Playwright',
      );
      let executable: string;
      let source: 'managed' | 'system' = 'managed';
      const systemBrowser = await this.findSystemBrowser();
      if (systemBrowser) {
        executable = systemBrowser;
        source = 'system';
        this.emit('progress', '检测到本机浏览器，使用隔离临时 Profile 启动，跳过 Chromium 下载。');
      } else {
        this.emit('progress', '未检测到可用系统浏览器，开始下载私有 Chromium…');
        try {
          await this.run(
            this.nodePath,
            [join(staging, 'node_modules/playwright/cli.js'), 'install', 'chromium'],
            staging,
            signal,
            '下载 Chromium',
          );
        } catch (error) {
          if (error instanceof BrowserError && error.code === 'CANCELLED') throw error;
          if (error instanceof BrowserError && error.code === 'BROWSER_PREPARE_TIMEOUT') throw error;
          throw new BrowserError(
            'BROWSER_DOWNLOAD_FAILED',
            `Chromium 下载失败：${(error as Error).message}。请安装 Google Chrome 后重试，或检查网络代理。`,
          );
        }
        executable = (
          await this.run(
            this.nodePath,
            ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"],
            staging,
            signal,
            '校验 Chromium',
          )
        ).trim();
      }
      if (signal?.aborted) throwCancelled();
      const relativePath = executable.slice(staging.length);
      if (source === 'managed' && !executable.startsWith(staging + '/'))
        throw new BrowserError(
          'BROWSER_INSTALL_INVALID',
          'Browser executable is outside its managed directory.',
        );
      const executableHash = await sha256File(executable);
      await writeFile(
        join(staging, 'receipt.json'),
        JSON.stringify({
          version: '1.65.0',
          lockHash: await this.manifestHash(),
          executable: source === 'managed' ? this.root + relativePath : executable,
          executableHash,
          source,
        }),
        { mode: 0o600 },
      );
      await rm(this.root, { recursive: true, force: true });
      await rename(staging, this.root);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  private async findSystemBrowser(): Promise<string | undefined> {
    for (const candidate of this.systemBrowsers) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* Try the next explicitly supported browser path. */
      }
    }
  }

  private run(
    file: string,
    args: string[],
    cwd: string,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<string> {
    if (signal?.aborted) throwCancelled();
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        env: {
          ...process.env,
          PATH: `${dirname(this.nodePath ?? process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
          PLAYWRIGHT_BROWSERS_PATH: join(cwd, 'browsers'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let output = '',
        stopped = false,
        timedOut = false,
        settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (timeout = false) => {
        if (stopped) return;
        stopped = true;
        timedOut = timeout;
        try {
          if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM');
        } catch {}
        killTimer = setTimeout(() => {
          try {
            if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
          } catch {}
        }, 3000);
      };
      const timer = setTimeout(() => stop(true), this.timeoutMs);
      const onAbort = () => stop(false);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (data) => {
        output = (output + data).slice(-32768);
        this.emit('progress', data.toString().slice(-2048));
      });
      child.stderr.on('data', (data) => {
        output = (output + data).slice(-32768);
        this.emit('progress', data.toString().slice(-2048));
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        reject(new BrowserError('BROWSER_PREPARE_FAILED', `${label}无法启动：${error.message}`));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        code === 0 && !stopped
          ? resolve(output)
          : reject(
              new BrowserError(
                timedOut ? 'BROWSER_PREPARE_TIMEOUT' : stopped ? 'CANCELLED' : 'BROWSER_PREPARE_FAILED',
                timedOut
                  ? `${label}超过 ${Math.round(this.timeoutMs / 60000)} 分钟，已停止。请检查网络后重试。`
                  : stopped
                    ? `${label}已取消。`
                    : `${label}失败（退出码 ${code ?? '未知'}）。${
                        /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.exec(output)?.[0]
                          ? `网络错误：${/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.exec(output)?.[0]}。`
                          : '请查看日志后重试。'
                      }`,
              ),
            );
      });
    });
  }
  async dispose() {
    this.cancellation?.abort();
    await this.task?.catch(() => {});
  }
}

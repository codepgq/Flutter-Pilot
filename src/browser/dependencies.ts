import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, delimiter } from 'node:path';
import { BrowserError } from './protocol';
import { sha256File } from '../runtime';
import { detectNodeRuntime } from '../mcp/adapters';
export class BrowserDependencies extends EventEmitter {
  private task?: Promise<void>;
  private cancellation?: AbortController;
  private nodePath?: string;
  constructor(
    readonly root: string,
    readonly resources: string,
  ) {
    super();
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
      if (!receipt.executable.startsWith(this.root + '/'))
        throw new Error('browser executable outside managed directory');
      const executableHash = await sha256File(receipt.executable);
      if (executableHash !== receipt.executableHash) throw new Error('browser checksum mismatch');
      return {
        prepared: true,
        version: receipt.version,
        lockHash: receipt.lockHash,
        executableHash,
        executable: receipt.executable,
      };
    } catch (error) {
      return { prepared: false, reason: (error as Error).message };
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
    signal?.throwIfAborted();
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
      await this.run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], staging, signal);
      await this.run(
        this.nodePath,
        [join(staging, 'node_modules/playwright/cli.js'), 'install', 'chromium'],
        staging,
        signal,
      );
      const executable = (
        await this.run(
          this.nodePath,
          ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"],
          staging,
          signal,
        )
      ).trim();
      signal?.throwIfAborted();
      const relative = executable.slice(staging.length);
      if (!executable.startsWith(staging + '/'))
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
          executable: this.root + relative,
          executableHash,
        }),
        { mode: 0o600 },
      );
      await rm(this.root, { recursive: true, force: true });
      await rename(staging, this.root);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  private run(file: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
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
        stopped = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        try {
          if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM');
        } catch {}
        killTimer = setTimeout(() => {
          try {
            if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
          } catch {}
        }, 3000);
      };
      const timer = setTimeout(stop, 300000);
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (data) => {
        output = (output + data).slice(-32768);
        this.emit('progress', data.toString().slice(-2048));
      });
      child.stderr.on('data', (data) => {
        output = (output + data).slice(-32768);
        this.emit('progress', data.toString().slice(-2048));
      });
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', stop);
        code === 0 && !stopped
          ? resolve(output)
          : reject(
              new BrowserError(
                stopped ? 'CANCELLED' : 'BROWSER_PREPARE_FAILED',
                stopped
                  ? 'Browser preparation cancelled or timed out.'
                  : 'Browser preparation failed; inspect progress and retry explicitly.',
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

import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserError } from './protocol';
import { detectNodeRuntime } from '../mcp/adapters';
export class BrowserWorkerClient extends EventEmitter {
  private child?: ChildProcess;
  private token = '';
  private epoch = 0;
  private starting?: Promise<void>;
  private cleaning: Promise<void> = Promise.resolve();
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void }
  >();
  constructor(readonly workerPath: string) {
    super();
  }
  get generation() {
    return this.epoch;
  }
  get running() {
    return !!this.child?.connected;
  }
  async start(dependencies: string, executable: string) {
    if (this.starting) return this.starting;
    this.starting = this.startOnce(dependencies, executable);
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async startOnce(dependencies: string, executable: string) {
    await this.cleaning;
    if (this.running) return;
    const nodePath = await detectNodeRuntime();
    if (!nodePath) throw new BrowserError('NODE_REQUIRED', 'Browser Worker requires Node.js.');
    this.token = randomBytes(32).toString('hex');
    const generation = ++this.epoch;
    const scratch = await mkdtemp(join(tmpdir(), 'pilot-browser-owned-'));
    const owned = new Set<number>();
    const child = fork(this.workerPath, [], {
      execPath: nodePath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        FLUTTER_PILOT_BROWSER_TOKEN: this.token,
        FLUTTER_PILOT_BROWSER_GENERATION: String(generation),
        FLUTTER_PILOT_BROWSER_DEPENDENCIES: dependencies,
        FLUTTER_PILOT_BROWSER_EXECUTABLE: executable,
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        XDG_CONFIG_HOME: join(scratch, 'config'),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child = child;
    child.stderr?.on('data', (data) => this.emit('log', data.toString().slice(-2048)));
    child.on('message', (value: any) => {
      if (this.child !== child || value?.token !== this.token || value.generation !== generation) return;
      if (value.event === 'ownedProcess' && Number.isSafeInteger(value.pid) && value.pid > 0)
        owned.add(value.pid);
      if (value.event) this.emit(value.event, value);
      else if (value.id) {
        const pending = this.pending.get(value.id);
        if (!pending) return;
        this.pending.delete(value.id);
        pending.cleanup();
        value.error
          ? pending.reject(new BrowserError(value.error.code, value.error.message, value.error.uncertain))
          : pending.resolve(value.result);
      }
    });
    const exit = async () => {
      if (this.child !== child) return;
      this.child = undefined;
      // Chromium creates its own process group. Only kill PIDs reported by this authenticated Worker.
      for (const pid of owned) {
        try {
          process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
        } catch {}
      }
      this.cleaning = rm(scratch, { recursive: true, force: true }).catch(() => {});
      for (const pending of this.pending.values()) {
        pending.cleanup();
        pending.reject(
          new BrowserError(
            'WORKER_DISCONNECTED',
            'Browser Worker exited; results are unconfirmed. No automatic replay.',
            true,
          ),
        );
      }
      this.pending.clear();
      await this.cleaning;
      this.emit('disconnected', { generation });
    };
    child.once('exit', exit);
    child.once('error', exit);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        void this.stop();
        reject(new BrowserError('WORKER_TIMEOUT', 'Browser Worker startup timed out.'));
      }, 10000);
      const ready = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new BrowserError('WORKER_DISCONNECTED', 'Browser Worker did not start.'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('ready', ready);
        child.off('exit', failed);
        child.off('error', failed);
      };
      this.once('ready', ready);
      child.once('exit', failed);
      child.once('error', failed);
    });
  }
  request<T = any>(
    method: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
    timeout = 40000,
  ): Promise<T> {
    if (!this.child?.connected)
      return Promise.reject(new BrowserError('WORKER_DISCONNECTED', 'Browser Worker is not running.'));
    signal?.throwIfAborted();
    const child = this.child,
      id = randomUUID(),
      generation = this.epoch;
    return new Promise((resolve, reject) => {
      const cancel = (code: string) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        if (child.connected) child.send({ token: this.token, generation, cancel: id }, () => {});
        reject(
          new BrowserError(
            code,
            'Browser operation stopped; verify actual results before another action.',
            true,
          ),
        );
      };
      const aborted = () => cancel('CANCELLED');
      const timer = setTimeout(() => cancel('TIMEOUT'), timeout);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', aborted, { once: true });
      child.send({ token: this.token, generation, id, method, args }, (error) => {
        if (error) {
          this.pending.delete(id);
          cleanup();
          reject(new BrowserError('WORKER_DISCONNECTED', 'Browser IPC delivery failed.', true));
        }
      });
    });
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    await this.cleaning;
  }
}

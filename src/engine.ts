import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface EngineSettings {
  retentionDays: number;
  maxRecords: number;
  maxBodyBytes: number;
  breakpointTimeout: number;
}
export interface EngineStartOptions {
  executable: string;
  addonPath: string;
  storagePath: string;
  listenHost: string;
  preferredPort: number;
  settings: EngineSettings;
  startPaused?: boolean;
}
export interface EngineState {
  status: 'stopped' | 'starting' | 'running' | 'error';
  proxyPort?: number;
  listenHost?: string;
  caCertPath?: string;
  proxyActive: boolean;
  error?: string;
}
export interface EngineEvent {
  event: string;
  data?: unknown;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}
const MIN_FRAME_BYTES = 64 * 1024 * 1024;
export function controlFrameLimit(maxBodyBytes: number): number {
  const boundedBody = Math.max(1024, Math.min(10 * 1024 * 1024, Math.trunc(maxBodyBytes) || 1024 * 1024));
  return Math.max(MIN_FRAME_BYTES, boundedBody * 10 + 1024 * 1024);
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function findAvailablePort(host: string, preferredPort: number): Promise<number> {
  const attempt = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(port, host, () => {
        const address = server.address() as net.AddressInfo;
        server.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
  try {
    return await attempt(preferredPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    return attempt(0);
  }
}

/** Owns one private engine process and an authenticated local control connection. */
export class EngineManager extends EventEmitter {
  private current: EngineState = { status: 'stopped', proxyActive: false };
  private child?: ChildProcessWithoutNullStreams;
  private server?: net.Server;
  private socket?: net.Socket;
  private sockets = new Set<net.Socket>();
  private token = '';
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private startTask?: Promise<EngineState>;
  private stopTask?: Promise<void>;
  private stopping = false;
  private maxFrameBytes = MIN_FRAME_BYTES;

  get state(): EngineState {
    return { ...this.current };
  }
  private setState(state: EngineState): void {
    this.current = state;
    this.emit('status', this.state);
  }

  async start(options: EngineStartOptions): Promise<EngineState> {
    if (this.startTask) return this.startTask;
    if (this.stopTask) await this.stopTask;
    if (this.current.status === 'running') return this.state;
    this.stopping = false;
    this.startTask = this.launch(options);
    try {
      return await this.startTask;
    } finally {
      this.startTask = undefined;
    }
  }

  private async launch(options: EngineStartOptions): Promise<EngineState> {
    await this.cleanup();
    this.maxFrameBytes = controlFrameLimit(options.settings.maxBodyBytes);
    this.setState({ status: 'starting', proxyActive: false, listenHost: options.listenHost });
    try {
      if (!['127.0.0.1', '0.0.0.0'].includes(options.listenHost))
        throw new Error('代理监听地址只允许本机或显式局域网模式。');
      if (
        !Number.isInteger(options.preferredPort) ||
        options.preferredPort < 0 ||
        options.preferredPort > 65535
      )
        throw new Error('代理端口必须在 0–65535 之间。');
      await fs.mkdir(options.storagePath, { recursive: true, mode: 0o700 });
      await fs.chmod(options.storagePath, 0o700);
      const confdir = path.join(options.storagePath, 'ca');
      await fs.mkdir(confdir, { recursive: true, mode: 0o700 });
      await fs.chmod(confdir, 0o700);
      const proxyPort = await findAvailablePort(options.listenHost, options.preferredPort);
      this.current.proxyPort = proxyPort;
      this.token = randomBytes(32).toString('hex');
      this.server = net.createServer((socket) => this.accept(socket));
      this.server.on('error', (error) => this.emit('log', `控制服务错误：${error.message}`));
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(0, '127.0.0.1', () => {
          this.server!.removeListener('error', reject);
          resolve();
        });
      });
      const controlPort = (this.server.address() as net.AddressInfo).port;
      const args = [
        '-q',
        '-s',
        options.addonPath,
        '--set',
        `confdir=${confdir}`,
        '--set',
        'connection_strategy=lazy',
        '--set',
        'flow_detail=0',
        '--listen-host',
        options.listenHost,
        '--listen-port',
        String(proxyPort),
      ];
      if (options.startPaused) args.push('--set', 'server=false');
      const child = spawn(options.executable, args, {
        env: {
          ...process.env,
          FLUTTER_PILOT_CONTROL_PORT: String(controlPort),
          FLUTTER_PILOT_CONTROL_TOKEN: this.token,
          FLUTTER_PILOT_STORAGE: options.storagePath,
          FLUTTER_PILOT_SETTINGS: JSON.stringify(options.settings),
          FLUTTER_PILOT_START_PAUSED: options.startPaused ? '1' : '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let recentOutput = '';
      const output = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        recentOutput = `${recentOutput}${text}`.slice(-8192);
        this.emit('log', text.slice(0, 8192));
      };
      child.stdout.on('data', output);
      child.stderr.on('data', output);
      child.once('error', (error) => {
        this.rejectPending(new Error(`代理引擎启动失败：${error.message}`));
        if (!this.stopping)
          this.setState({ ...this.current, status: 'error', proxyActive: false, error: error.message });
      });
      child.once('close', (code, signal) => {
        this.rejectPending(new Error('代理引擎已退出。'));
        if (this.child === child) this.child = undefined;
        if (!this.stopping) {
          const message = `代理引擎退出（${signal || code}）${recentOutput ? `：${recentOutput.trim().slice(-2000)}` : ''}`;
          this.setState({ ...this.current, status: 'error', proxyActive: false, error: message });
          void this.closeControl();
        }
      });
      const expires = Date.now() + 45000;
      while (Date.now() < expires) {
        if (this.stopping) throw new Error('代理引擎启动已取消。');
        if (this.current.status === 'error') throw new Error(this.current.error || '代理引擎启动失败。');
        if (this.socket) {
          try {
            const health = await this.rpc<Record<string, unknown>>('health', {}, 3000);
            if (health.ready === true) {
              this.applyHealth(health);
              this.setState({ ...this.current, status: 'running', error: undefined });
              return this.state;
            }
          } catch (error) {
            this.emit('log', `等待引擎就绪：${(error as Error).message}`);
          }
        }
        await delay(150);
      }
      throw new Error(`等待代理引擎启动超时。${recentOutput.trim().slice(-2000)}`);
    } catch (error) {
      await this.cleanup();
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ ...this.current, status: 'error', proxyActive: false, error: message });
      throw new Error(message);
    }
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    let authenticated = false;
    let fragments: Buffer[] = [];
    let bufferedBytes = 0;
    const handshakeTimeout = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', (error) => this.emit('log', `控制连接错误：${error.message}`));
    socket.on('close', () => {
      clearTimeout(handshakeTimeout);
      this.sockets.delete(socket);
      if (this.socket === socket) {
        this.socket = undefined;
        this.rejectPending(new Error('代理控制连接已断开，请重试。'));
        if (!this.stopping && this.current.status === 'running')
          this.setState({
            ...this.current,
            status: 'error',
            error: '代理控制连接已断开；等待重连或重新启动。',
          });
        this.emit('event', { event: 'control.disconnected' } satisfies EngineEvent);
      }
    });
    socket.on('data', (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const fragment = chunk.subarray(offset, end);
        bufferedBytes += fragment.length;
        const limit = authenticated ? this.maxFrameBytes : 16 * 1024;
        if (bufferedBytes > limit) {
          socket.destroy(new Error('控制帧超出大小限制。'));
          return;
        }
        fragments.push(fragment);
        if (newline === -1) break;
        const line = (
          fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, bufferedBytes)
        ).toString('utf8');
        fragments = [];
        bufferedBytes = 0;
        offset = newline + 1;
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy(new Error('控制消息格式错误。'));
          return;
        }
        if (!message || typeof message !== 'object') {
          socket.destroy();
          return;
        }
        if (!authenticated) {
          if (
            message.event !== 'hello' ||
            message.protocolVersion !== 1 ||
            typeof message.token !== 'string'
          ) {
            socket.destroy();
            return;
          }
          const actual = Buffer.from(message.token);
          const expected = Buffer.from(this.token);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || this.socket) {
            socket.destroy();
            return;
          }
          authenticated = true;
          clearTimeout(handshakeTimeout);
          this.socket = socket;
          this.emit('event', { event: 'control.connected' } satisfies EngineEvent);
          continue;
        }
        if (typeof message.id === 'string') {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            const failure = message.error as { message?: unknown };
            pending.reject(
              new Error(typeof failure.message === 'string' ? failure.message : '代理引擎操作失败。'),
            );
          } else pending.resolve(message.result);
        } else if (typeof message.event === 'string') {
          const data = message.data;
          if (message.event === 'ready' && data && typeof data === 'object')
            this.applyHealth(data as Record<string, unknown>);
          this.emit('event', { event: message.event, data } satisfies EngineEvent);
        }
      }
    });
  }

  private applyHealth(health: Record<string, unknown>): void {
    const next = { ...this.current };
    if (typeof health.proxyPort === 'number') next.proxyPort = health.proxyPort;
    if (typeof health.proxyActive === 'boolean') next.proxyActive = health.proxyActive;
    if (typeof health.caCertPath === 'string') next.caCertPath = health.caCertPath;
    if (health.ready === true && next.status === 'error' && this.child) {
      next.status = 'running';
      next.error = undefined;
    }
    this.setState(next);
  }

  async rpc<T = unknown>(method: string, params: unknown = {}, timeoutMs = 20000): Promise<T> {
    if (!this.socket || this.socket.destroyed) throw new Error('代理引擎尚未连接，请先启动。');
    const id = String(++this.sequence);
    const frame = `${JSON.stringify({ id, method, params })}\n`;
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw new Error('操作数据超出控制通道限制。');
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`代理操作超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
    if (['health', 'proxy.start', 'proxy.stop'].includes(method) && result && typeof result === 'object')
      this.applyHealth(result as Record<string, unknown>);
    return result as T;
  }

  private rejectPending(error: Error): void {
    for (const value of this.pending.values()) {
      clearTimeout(value.timer);
      value.reject(error);
    }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = (async () => {
      this.stopping = true;
      if (this.startTask) {
        try {
          await this.startTask;
        } catch {
          /* a cancelled start is expected */
        }
      }
      try {
        if (this.socket) await this.rpc('breakpoint.releaseAll', {}, 1500);
      } catch {
        /* still terminate safely */
      }
      await this.cleanup();
      this.setState({ status: 'stopped', proxyActive: false });
    })();
    try {
      await this.stopTask;
    } finally {
      this.stopTask = undefined;
    }
  }

  private async closeControl(): Promise<void> {
    this.rejectPending(new Error('代理控制连接已关闭。'));
    this.socket = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async cleanup(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => child.kill('SIGKILL'), 3000);
        const fallback = setTimeout(() => {
          clearTimeout(killer);
          resolve();
        }, 5000);
        child.once('close', () => {
          clearTimeout(killer);
          clearTimeout(fallback);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    await this.closeControl();
  }
}

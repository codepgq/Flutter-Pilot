import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';

export interface VmRpc {
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export class VmRpcError extends Error {
  constructor(
    readonly code: number,
    readonly method: string,
  ) {
    super(`VM RPC ${method} 失败（${code}）`);
    this.name = 'VmRpcError';
  }
}

export class VmConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VmConnectionError';
  }
}

const loopback = (url: URL) => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname.toLowerCase());
const redirectFailure = () =>
  new VmConnectionError(
    'redirect',
    'VM 调试服务要求跳转；请复制当前 DDS 的完整 WebSocket 地址重新连接。仅支持本机到本机的安全跳转。',
  );
function redirectTarget(location: string | undefined, current: URL, initial: URL): URL {
  if (!location) throw redirectFailure();
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    throw redirectFailure();
  }
  if (target.protocol === 'http:') target.protocol = 'ws:';
  else if (target.protocol === 'https:') target.protocol = 'wss:';
  if (
    !['ws:', 'wss:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.hash ||
    !loopback(initial) ||
    !loopback(current) ||
    !loopback(target) ||
    (current.protocol === 'wss:' && target.protocol !== 'wss:')
  )
    throw redirectFailure();
  if (!target.pathname.endsWith('/ws')) target.pathname = target.pathname.replace(/\/?$/, '/ws');
  return target;
}
function transportError(error?: NodeJS.ErrnoException): VmConnectionError {
  if (error?.code === 'ECONNREFUSED')
    return new VmConnectionError(
      'refused',
      'VM 端口拒绝连接，调试地址可能已过期。请确认 App 正在 Debug 运行，并复制本次完整 WS 地址。',
    );
  if (error?.code === 'ETIMEDOUT')
    return new VmConnectionError('timeout', '连接 VM 超时，请检查调试应用、设备端口转发和本次 WS 地址。');
  return new VmConnectionError('transport', '无法连接 Dart VM Service，请检查调试应用、地址和端口转发。');
}

export interface VmClientOptions {
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxPayloadBytes?: number;
}

/** The VM URL may contain authentication tokens. Never include it in errors or events. */
export function validateVmUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入有效的 Dart VM Service WebSocket 地址');
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('VM 地址必须使用 ws:// 或 wss://，且不能包含用户信息或片段');
  }
  if (!url.hostname) throw new Error('VM 地址缺少主机');
  return url.toString();
}

export class VmServiceClient extends EventEmitter implements VmRpc {
  private socket?: WebSocket;
  private sequence = 0;
  private generation = 0;
  private cancelConnection?: () => void;
  private pending = new Map<
    string,
    {
      method: string;
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly options: Required<VmClientOptions>;

  constructor(options: VmClientOptions = {}) {
    super();
    this.options = {
      timeoutMs: 10000,
      connectTimeoutMs: 10000,
      maxPayloadBytes: 32 * 1024 * 1024,
      ...options,
    };
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  get endpoint(): string | undefined {
    return this.socket ? new URL(this.socket.url).host : undefined;
  }

  async connect(address: string): Promise<void> {
    const initial = new URL(validateVmUrl(address));
    this.disconnect();
    const generation = ++this.generation;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(
        () =>
          fail(
            new VmConnectionError('timeout', '连接 VM 超时，请检查调试应用、设备端口转发和本次 WS 地址。'),
          ),
        this.options.connectTimeoutMs,
      );
      const fail = (error: VmConnectionError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.cancelConnection === cancel) this.cancelConnection = undefined;
        if (generation === this.generation) {
          const socket = this.socket;
          this.socket = undefined;
          socket?.terminate();
        }
        reject(error);
      };
      const cancel = () => fail(new VmConnectionError('cancelled', 'VM 连接已取消。'));
      this.cancelConnection = cancel;
      const open = (url: URL, redirects: number) => {
        if (generation !== this.generation || settled) return cancel();
        let socket: WebSocket;
        try {
          socket = new WebSocket(url, {
            maxPayload: this.options.maxPayloadBytes,
            followRedirects: false,
            handshakeTimeout: this.options.connectTimeoutMs,
          });
        } catch {
          fail(transportError());
          return;
        }
        this.socket = socket;
        socket.once('unexpected-response', (_, response) => {
          if (settled || generation !== this.generation || this.socket !== socket) {
            response.destroy();
            socket.terminate();
            return;
          }
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            let target: URL;
            try {
              if (redirects >= 2) throw redirectFailure();
              target = redirectTarget(response.headers.location, url, initial);
            } catch {
              response.destroy();
              fail(redirectFailure());
              return;
            }
            this.socket = undefined;
            response.destroy();
            socket.terminate();
            open(target, redirects + 1);
            return;
          }
          response.destroy();
          if (status === 401 || status === 403)
            fail(
              new VmConnectionError(
                'authentication',
                'VM 调试服务拒绝认证，请复制本次完整 WS 地址，保留认证路径；不要使用 DevTools 网页地址。',
              ),
            );
          else if (status === 404)
            fail(
              new VmConnectionError(
                'path',
                'VM WebSocket 路径不存在，请使用本次完整 WS 地址（包含认证路径及末尾 /ws）。',
              ),
            );
          else
            fail(
              new VmConnectionError(
                'handshake',
                `VM WebSocket 握手失败（HTTP ${status}），请检查当前调试地址。`,
              ),
            );
        });
        socket.once('open', () => {
          if (generation !== this.generation || settled || this.socket !== socket) {
            socket.terminate();
            return;
          }
          settled = true;
          clearTimeout(timeout);
          if (this.cancelConnection === cancel) this.cancelConnection = undefined;
          resolve();
          this.emit('connected');
        });
        socket.on('message', (data) => {
          if (generation === this.generation && this.socket === socket) this.receive(data);
        });
        socket.on('error', (error: NodeJS.ErrnoException) => {
          if (generation === this.generation && this.socket === socket) fail(transportError(error));
        });
        socket.once('close', () => {
          if (generation !== this.generation || this.socket !== socket) return;
          if (!settled) fail(transportError());
          else {
            this.socket = undefined;
            this.rejectPending(new Error('Dart VM Service 连接已断开'));
            this.emit('disconnected');
          }
        });
      };
      open(initial, 0);
    });
  }

  call<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.options.timeoutMs,
  ): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('尚未连接 Dart VM Service'));
    const id = String(++this.sequence);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`VM RPC ${method} 等待超时`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`VM RPC ${method} 发送失败`));
      });
    });
  }

  private receive(data: RawData): void {
    let value: any;
    try {
      value = JSON.parse(data.toString());
    } catch {
      this.disconnect();
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (value.id !== undefined) {
      const pending = this.pending.get(String(value.id));
      if (!pending) return;
      this.pending.delete(String(value.id));
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new VmRpcError(Number(value.error.code) || -1, pending.method));
      else pending.resolve(value.result);
    } else if (typeof value.method === 'string') this.emit('notification', value);
  }

  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }

  disconnect(): void {
    this.cancelConnection?.();
    this.generation++;
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending(new Error('Dart VM Service 连接已断开'));
    if (socket) {
      // Termination avoids waiting for the close handshake with an exited VM.
      socket.terminate();
      this.emit('disconnected');
    }
  }

  dispose(): void {
    this.disconnect();
    this.removeAllListeners();
  }
}

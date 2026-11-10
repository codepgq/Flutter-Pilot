import { EventEmitter } from 'node:events';
import { VmServiceClient } from './client';

/** A small bounded JSON-RPC client. Authenticated DTD URIs never leave this transport. */
export class DtdClient extends EventEmitter {
  private readonly client: VmServiceClient;

  constructor(timeoutMs = 3000) {
    super();
    this.client = new VmServiceClient({
      timeoutMs,
      connectTimeoutMs: timeoutMs,
      maxPayloadBytes: 1024 * 1024,
    });
    this.client.on('notification', (value) => {
      if (value.method === 'streamNotify') this.emit('notification', value.params);
    });
    this.client.on('disconnected', () => this.emit('disconnected'));
  }

  async connect(uri: string): Promise<void> {
    try {
      await this.client.connect(uri);
    } catch {
      throw new Error('无法连接 Dart Tooling Daemon，仍可接收新调试会话。');
    }
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    try {
      return await this.client.call<T>(method, params, timeoutMs);
    } catch {
      // Never relay a daemon error body, which may contain an authenticated URI.
      throw new Error('Dart Tooling Daemon 查询暂不可用。');
    }
  }

  dispose(): void {
    this.removeAllListeners();
    this.client.dispose();
  }
}

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { matchWsHandshake, WsHandshakeOwnership, WsVmInjector } from '../src/vm/websocket';
import type { WsHandshake } from '../src/ws/model';

const handshake: WsHandshake = {
  isolateId: 'isolates/main',
  url: 'wss://example.test/business',
  localPort: 1122,
  remotePort: 443,
  remoteAddress: '127.0.0.1',
  timestamp: 100,
};
const socket = { serviceId: 1, localPort: 1122, remotePort: 443, remoteAddress: '::ffff:127.0.0.1' };
class Rpc extends EventEmitter {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  async call<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'getIsolate') return { libraries: [] } as T;
    throw new Error('synthetic-secret-should-not-leak');
  }
}

describe('WebSocket VM runtime boundaries', () => {
  it('requires a unique handshake with all socket coordinates and the same isolate', () => {
    expect(matchWsHandshake('isolates/main', socket, [handshake])).toBe(handshake);
    expect(matchWsHandshake('isolates/other', socket, [handshake])).toBeUndefined();
    expect(matchWsHandshake('isolates/main', { ...socket, localPort: 1123 }, [handshake])).toBeUndefined();
    expect(
      matchWsHandshake('isolates/main', socket, [handshake, { ...handshake, url: 'ws://other/path' }]),
    ).toBeUndefined();
  });
  it('does not assign an old handshake to a new service object after TCP port reuse', () => {
    const ownership = new WsHandshakeOwnership();
    expect(ownership.claim('isolates/main', socket, [handshake])).toBe(handshake);
    expect(ownership.claim('isolates/main', { ...socket, serviceId: 2 }, [handshake])).toBeUndefined();
    const later = { ...handshake, timestamp: 200, url: 'wss://example.test/new' };
    expect(ownership.claim('isolates/main', { ...socket, serviceId: 2 }, [later])).toBe(later);
    expect(ownership.claim('isolates/main', socket, [later])).toBe(handshake);
    ownership.clear();
    expect(ownership.claim('isolates/main', { ...socket, serviceId: 2 }, [handshake])).toBe(handshake);
  });
  it('reports unsupported VM structure without exposing raw RPC details', async () => {
    const rpc = new Rpc();
    const injector = new WsVmInjector(rpc);
    await expect(injector.scan(['isolates/main'], [], false)).rejects.toThrow('未提供兼容');
    await injector.dispose();
    expect(rpc.listenerCount('notification')).toBe(0);
  });
  it('accepts no isolates without pretending there is an attached connection', async () => {
    const injector = new WsVmInjector(new Rpc());
    expect(await injector.scan([], [], false)).toEqual([]);
    await expect(injector.push('missing', 'hello')).rejects.toThrow('未接入');
    await expect(injector.send('missing', 'hello')).rejects.toThrow('未接入');
    await injector.dispose();
  });
  it('checks cancellation again when a queued message reaches the injector', async () => {
    const rpc = new Rpc();
    const injector = new WsVmInjector(rpc);
    const cancel = new AbortController();
    const pending = injector.send('missing', 'hello', cancel.signal);
    cancel.abort();
    await expect(pending).rejects.toThrow('已取消');
    expect(rpc.calls).toEqual([]);
    await injector.dispose();
  });
  it('bounds replacement and synthetic payloads by the selected capture limit', async () => {
    const injector = new WsVmInjector(new Rpc(), { maxBodyBytes: 4 });
    await expect(injector.push('missing', '中文')).rejects.toThrow('4 字节');
    await expect(injector.send('missing', '中文')).rejects.toThrow('4 字节');
    await expect(
      injector.scan(
        [],
        [
          {
            id: 'r',
            name: 'r',
            enabled: true,
            priority: 0,
            match: { url: '*' },
            action: { type: 'replace', text: '中文' },
          },
        ],
        true,
      ),
    ).rejects.toThrow('4 字节');
    await injector.dispose();
  });
  it('ignores unknown event sessions and malformed VM events', async () => {
    const rpc = new Rpc();
    const injector = new WsVmInjector(rpc);
    const events: unknown[] = [];
    injector.on('message', (message) => events.push(message));
    rpc.emit('notification', {
      params: {
        event: {
          extensionKind: 'flutter_pilot.vm.ws',
          extensionData: { session: 'other', messages: [{ original: 'secret' }] },
        },
      },
    });
    expect(events).toEqual([]);
    await injector.dispose();
  });
  it('validates runtime events, preserves original and effective data, and counts rejected events', async () => {
    const rpc = new Rpc();
    const injector = new WsVmInjector(rpc, { maxBodyBytes: 4 });
    const session = (injector as unknown as { session: string }).session;
    const events: unknown[] = [];
    let omitted = 0;
    injector.on('message', (message) => events.push(message));
    injector.on('omitted', (count) => (omitted += count));
    const message = {
      id: 'm',
      connectionId: `${session}:isolates/main:1`,
      timestamp: 100,
      direction: 'inbound',
      kind: 'text',
      original: 'old',
      effective: 'new',
      encoding: 'text',
      bytes: 3,
      truncated: false,
      outcome: 'replaced',
    };
    rpc.emit('notification', {
      params: {
        event: {
          extensionKind: 'flutter_pilot.vm.ws',
          extensionData: {
            session,
            omitted: 2,
            messages: [
              message,
              { ...message, bytes: -1 },
              { ...message, effective: 'oversized' },
              { ...message, connectionId: 'unrelated' },
            ],
          },
        },
      },
    });
    expect(events).toEqual([message]);
    expect(omitted).toBe(5);
    await injector.dispose();
  });
});

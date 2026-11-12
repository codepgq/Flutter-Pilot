import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsConnection, WsMessage, WsRule } from '../src/ws/model';
import type { VmRpc } from '../src/vm/client';

const fixture = vi.hoisted(() => ({ injectors: [] as any[], stores: [] as any[], order: [] as string[] }));
vi.mock('../src/vm/websocket', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    WsVmInjector: class extends EventEmitter {
      scan = vi.fn(async (..._args: unknown[]) => [] as WsConnection[]);
      detach = vi.fn(async () => {
        fixture.order.push('detach');
      });
      abandon = vi.fn(() => {
        fixture.order.push('abandon');
      });
      push = vi.fn(async () => undefined);
      send = vi.fn(async () => undefined);
      dispose = vi.fn(async () => undefined);
      constructor() {
        super();
        fixture.injectors.push(this);
      }
    },
  };
});
vi.mock('../src/ws/storage', () => ({
  WsHistoryStore: class {
    records = new Map<string, WsConnection>();
    init = vi.fn(async () => undefined);
    disconnectAll = vi.fn(async () => {
      for (const [id, record] of this.records)
        if (record.status === 'open') this.records.set(id, { ...record, status: 'disconnected' });
    });
    connections = vi.fn(async () => [...this.records.values()]);
    list = vi.fn(async () => ({ items: [], total: 0 }));
    putConnection = vi.fn(async (record: WsConnection) => {
      this.records.set(record.id, { ...record });
    });
    deleteConnection = vi.fn(async (id: string) => {
      this.records.delete(id);
    });
    putMessage = vi.fn(async (_record: WsMessage) => undefined);
    close = vi.fn(async () => undefined);
    constructor() {
      fixture.stores.push(this);
    }
  },
}));
import { WsSession } from '../src/ws/session';
const settings = { retentionDays: 7, maxRecords: 10000, maxBodyBytes: 1048576 };
const connection: WsConnection = {
  id: 'session:one',
  isolateId: 'main',
  endpoint: '127.0.0.1:8080',
  status: 'open',
  capture: 'attached',
  openedAt: 1,
  sent: 0,
  received: 0,
};
const rule: WsRule = {
  id: 'rule',
  name: 'test',
  enabled: true,
  priority: 0,
  match: { url: 'wss://example.test/*' },
  action: { type: 'drop' },
};
const message: WsMessage = {
  id: 'msg',
  connectionId: connection.id,
  timestamp: 1,
  direction: 'inbound',
  kind: 'text',
  original: 'hello',
  bytes: 5,
  truncated: false,
  encoding: 'text',
  outcome: 'original',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

describe('independent WS session lifecycle', () => {
  let session: WsSession;
  let injector: any;
  let store: any;
  let profiling: ReturnType<typeof vi.fn<(enabled: boolean) => Promise<void>>>;
  let rpc: VmRpc;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T04:00:00Z'));
    fixture.injectors.length = 0;
    fixture.stores.length = 0;
    fixture.order.length = 0;
    rpc = {
      call: async <T>() => ({ isolates: [{ id: 'main' }, { id: 'system', isSystemIsolate: true }] }) as T,
    };
    profiling = vi.fn(async (enabled: boolean) => {
      fixture.order.push('profiling.' + enabled);
    });
    session = new WsSession(rpc, '/unused', settings, undefined, profiling);
    injector = fixture.injectors[0];
    store = fixture.stores[0];
    injector.scan.mockResolvedValue([connection]);
  });
  afterEach(async () => {
    await session.dispose();
    vi.useRealTimers();
  });
  it('requires an online VM and starts capture separately from Mock', async () => {
    await expect(session.setCaptureEnabled(true)).rejects.toThrow('连接');
    session.connected();
    await session.setCaptureEnabled(true);
    expect(session.state.captureEnabled).toBe(true);
    expect(session.state.mockEnabled).toBe(false);
    expect(profiling).toHaveBeenCalledWith(true);
    expect(injector.scan).toHaveBeenCalledWith(['main'], [], false, []);
    await session.setMockEnabled(true);
    expect(injector.scan).toHaveBeenLastCalledWith(['main'], [], true, []);
    expect(session.state.mockEnabled).toBe(true);
  });
  it('serializes scans and a requested stop, avoiding overlapping runtime updates', async () => {
    session.connected();
    const gate = deferred<WsConnection[]>();
    injector.scan.mockReturnValueOnce(gate.promise);
    const enable = session.setCaptureEnabled(true);
    await settle();
    const disable = session.setCaptureEnabled(false);
    await settle();
    expect(injector.detach).not.toHaveBeenCalled();
    gate.resolve([connection]);
    await Promise.all([enable, disable]);
    expect(injector.detach).toHaveBeenCalledOnce();
    expect(session.state.captureEnabled).toBe(false);
    expect(session.state.mockEnabled).toBe(false);
    expect(session.state.connections[0].status).toBe('disconnected');
  });
  it('does not repeat installation when capture is enabled twice', async () => {
    session.connected();
    await Promise.all([session.setCaptureEnabled(true), session.setCaptureEnabled(true)]);
    expect(injector.scan).toHaveBeenCalledTimes(1);
  });
  it('closes capture and Mock together and restores profiling ownership', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    await session.setMockEnabled(true);
    await session.setCaptureEnabled(false);
    expect(session.state).toMatchObject({ captureEnabled: false, mockEnabled: false, status: 'off' });
    expect(fixture.order.slice(-2)).toEqual(['detach', 'profiling.false']);
    injector.emit('message', message);
    await settle();
    expect(store.putMessage).not.toHaveBeenCalled();
  });
  it('retains saved rules but stops old runtime rules on synchronization failure', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    await session.setMockEnabled(true);
    injector.scan.mockRejectedValueOnce(new Error('RPC failure containing private content'));
    await expect(session.updateRules([rule])).rejects.toThrow('规则已保存');
    expect(session.state.rules).toEqual([rule]);
    expect(session.state.mockEnabled).toBe(false);
    expect(session.state.captureEnabled).toBe(false);
    expect(session.state.ruleSyncError).toContain('同步失败');
    expect(injector.detach).toHaveBeenCalledOnce();
  });
  it('blocks reinstallation until lease cooldown after an unconfirmed detach', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    injector.detach.mockRejectedValueOnce(new Error('closed'));
    await session.setCaptureEnabled(false);
    await expect(session.setCaptureEnabled(true)).rejects.toThrow('16 秒');
    await vi.advanceTimersByTimeAsync(16001);
    await session.setCaptureEnabled(true);
    expect(session.state.captureEnabled).toBe(true);
  });
  it('invalidates pending scans synchronously, drops late events, and discards temporary rules', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    await session.updateRules([rule, { ...rule, id: 'temp', match: { connectionId: connection.id } }]);
    const gate = deferred<WsConnection[]>();
    injector.scan.mockReturnValueOnce(gate.promise);
    const scan = session.rescan();
    await settle();
    const disconnect = session.disconnect(false);
    expect(session.state.captureEnabled).toBe(false);
    expect(session.state.mockEnabled).toBe(false);
    expect(session.state.rules.map((r) => r.id)).toEqual(['rule']);
    injector.emit('message', message);
    gate.resolve([connection]);
    await Promise.all([scan, disconnect]);
    expect(store.putMessage).not.toHaveBeenCalled();
    expect(injector.abandon).toHaveBeenCalledOnce();
    expect(session.state.connections.every((c) => c.status !== 'open')).toBe(true);
    session.connected();
    await expect(session.setCaptureEnabled(true)).rejects.toThrow('租约');
  });
  it.each(['push', 'send'] as const)(
    'rejects stale and unknown connections for %s without reconnecting',
    async (action) => {
      session.connected();
      await expect(session[action](connection.id, 'one')).rejects.toThrow('开启 WS 采集');
      await session.setCaptureEnabled(true);
      expect(session.state.mockEnabled).toBe(false);
      await session[action](connection.id, 'one');
      expect(injector[action]).toHaveBeenCalledWith(connection.id, 'one', undefined);
      await expect(session[action]('another', 'two')).rejects.toThrow('失效');
      await session.disconnect(false);
      await expect(session[action](connection.id, 'three')).rejects.toThrow('连接 VM');
      expect(injector[action]).toHaveBeenCalledTimes(1);
    },
  );
  it('does not confirm a send invalidated while the VM call is pending or retry it', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    await session.setMockEnabled(true);
    const gate = deferred<void>();
    injector.send.mockReturnValue(gate.promise);
    const pending = session.send(connection.id, 'once');
    await settle();
    session.invalidate();
    gate.resolve();
    await expect(pending).rejects.toThrow('结果未确认');
    expect(injector.send).toHaveBeenCalledTimes(1);
  });
  it('rejects a send cancelled while waiting in the session queue without dispatching it', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    await session.setMockEnabled(true);
    const gate = deferred<void>();
    injector.send.mockReturnValueOnce(gate.promise);
    const first = session.send(connection.id, 'first');
    const cancel = new AbortController();
    const second = session.send(connection.id, 'cancelled', cancel.signal);
    await settle();
    cancel.abort();
    gate.resolve();
    await first;
    await expect(second).rejects.toThrow('已取消');
    expect(injector.send).toHaveBeenCalledTimes(1);
  });
  it('displays unsupported capability without enabling Mock', async () => {
    injector.scan.mockResolvedValue([{ ...connection, capture: 'unsupported', warning: 'unsupported SDK' }]);
    session.connected();
    await session.setCaptureEnabled(true);
    expect(session.state.status).toBe('unsupported');
    await expect(session.setMockEnabled(true)).rejects.toThrow('受支持');
  });
  it('bounds pending storage work and records omissions while capture remains active', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    const gate = deferred<void>();
    store.putMessage.mockReturnValue(gate.promise);
    for (let index = 0; index < 105; index++) injector.emit('message', { ...message, id: String(index) });
    expect(store.putMessage).toHaveBeenCalledTimes(100);
    expect(session.state.omitted).toBe(5);
    injector.emit('omitted', 3);
    expect(session.state.omitted).toBe(8);
    gate.resolve();
    await settle();
    expect(session.state.captureEnabled).toBe(true);
  });
  it('renews capture in background and stops renewal after a polling error', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    await session.setMockEnabled(true);
    injector.scan.mockRejectedValueOnce(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(session.state.captureEnabled).toBe(false);
    expect(session.state.mockEnabled).toBe(false);
    expect(session.state.status).toBe('error');
    expect(session.state.error).toContain('续约');
    const count = injector.scan.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);
    expect(injector.scan).toHaveBeenCalledTimes(count);
  });
  it('does not let an older history refresh reopen a disconnected connection', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    const gate = deferred<WsConnection[]>();
    store.connections.mockReturnValueOnce(gate.promise);
    const oldRefresh = session.refresh();
    await settle();
    await session.disconnect(false);
    expect(session.state.connections[0].status).toBe('disconnected');
    gate.resolve([connection]);
    await oldRefresh;
    expect(session.state.connections[0].status).toBe('disconnected');
  });
  it('keeps the newest filter result when a previous refresh completes later', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    const gate = deferred<{ items: unknown[]; total: number }>();
    store.list.mockReturnValueOnce(gate.promise);
    const oldRefresh = session.refresh({ connectionId: 'old' });
    await settle();
    store.list.mockResolvedValueOnce({ items: [], total: 7 });
    await session.refresh({ connectionId: 'new' });
    gate.resolve({ items: [], total: 999 });
    await oldRefresh;
    expect(session.state.messages.total).toBe(7);
  });
  it('does not restore active status when disconnect occurs during a connection write', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    const gate = deferred<void>();
    injector.scan.mockResolvedValueOnce([{ ...connection, sent: 1 }]);
    store.putConnection.mockReturnValueOnce(gate.promise);
    const scan = session.rescan();
    await settle();
    session.invalidate();
    gate.resolve();
    await scan;
    expect(session.state.captureEnabled).toBe(false);
    expect(session.state.status).toBe('off');
    expect(session.state.connections.every((value) => value.status !== 'open')).toBe(true);
  });
  it('persists connection counters only when the runtime snapshot changes', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    await session.rescan();
    expect(store.putConnection).toHaveBeenCalledTimes(1);
    injector.scan.mockResolvedValueOnce([{ ...connection, sent: 3 }]);
    await session.rescan();
    expect(store.putConnection).toHaveBeenCalledTimes(2);
    expect(session.state.connections[0].sent).toBe(3);
  });
  it('expires a connection-only rule after that exact socket closes', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    await session.updateRules([rule, { ...rule, id: 'temporary', match: { connectionId: connection.id } }]);
    injector.scan.mockResolvedValue([{ ...connection, status: 'closed' }]);
    await session.rescan();
    expect(session.state.rules.map((value) => value.id)).toEqual(['rule']);
  });
  it('stops capture when a manual rescan cannot confirm runtime state', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    await session.setMockEnabled(true);
    injector.scan.mockRejectedValueOnce(new Error('transport closed'));
    await expect(session.rescan()).rejects.toThrow('扫描或同步失败');
    expect(session.state.captureEnabled).toBe(false);
    expect(session.state.mockEnabled).toBe(false);
    expect(session.state.status).toBe('error');
    expect(injector.detach).toHaveBeenCalledOnce();
  });
  it('reports storage failures without interrupting the business connection', async () => {
    session.connected();
    await session.setCaptureEnabled(true);
    store.putMessage.mockRejectedValueOnce(new Error('disk full'));
    injector.emit('message', message);
    await settle();
    expect(session.state.omitted).toBe(1);
    expect(session.state.warnings.some((w) => w.includes('未保存'))).toBe(true);
    expect(session.state.captureEnabled).toBe(true);
    expect(injector.detach).not.toHaveBeenCalled();
  });
});

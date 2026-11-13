import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry, Rule } from '../src/model';

const fixtures = vi.hoisted(() => ({
  clients: [] as any[],
  profilers: [] as any[],
  injectors: [] as any[],
  stores: [] as any[],
  order: [] as string[],
}));
vi.mock('../src/vm/client', async () => {
  const { EventEmitter } = await import('node:events');
  const { validateVmUrl, VmConnectionError, VmRpcError } =
    await vi.importActual<typeof import('../src/vm/client')>('../src/vm/client');
  return {
    validateVmUrl,
    VmConnectionError,
    VmRpcError,
    VmServiceClient: class extends EventEmitter {
      connected = false;
      connectHook?: (url: string) => Promise<void>;
      connect = vi.fn(async (url: string) => {
        await this.connectHook?.(url);
        this.connected = true;
        fixtures.order.push('client.connect');
      });
      disconnect = vi.fn(() => {
        fixtures.order.push('client.disconnect');
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) this.emit('disconnected');
      });
      dispose = vi.fn(() => this.disconnect());
      constructor() {
        super();
        fixtures.clients.push(this);
      }
    },
  };
});
vi.mock('../src/vm/profiler', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    VmNetworkProfiler: class extends EventEmitter {
      isolateIds = ['isolates/1'];
      start = vi.fn(async () => {
        fixtures.order.push('profiler.start');
        this.emit('isolates', this.isolateIds);
      });
      rediscover = vi.fn(async () => {
        this.emit('isolates', this.isolateIds);
      });
      stop = vi.fn(async () => {
        fixtures.order.push('profiler.stop');
      });
      setCaptureEnabled = vi.fn(async (enabled: boolean) => {
        fixtures.order.push(`capture.${enabled}`);
      });
      constructor() {
        super();
        fixtures.profilers.push(this);
      }
    },
  };
});
vi.mock('../src/vm/injection', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    DioVmInjector: class extends EventEmitter {
      syncHook?: (id: string, rules: Rule[]) => Promise<{ instances: number; warnings: string[] }>;
      sync = vi.fn(async (id: string, rules: Rule[]) => {
        fixtures.order.push('injector.sync');
        return (await this.syncHook?.(id, rules)) ?? { instances: 1, warnings: [] };
      });
      heartbeat = vi.fn(async () => undefined);
      detach = vi.fn(async () => {
        fixtures.order.push('injector.detach');
      });
      dispose = vi.fn(async () => {
        fixtures.order.push('injector.dispose');
      });
      constructor() {
        super();
        fixtures.injectors.push(this);
      }
    },
  };
});
vi.mock('../src/vm/storage', () => ({
  VmHistoryStore: class {
    init = vi.fn(async () => undefined);
    put = vi.fn(async (_entry: HistoryEntry) => undefined);
    close = vi.fn(async () => undefined);
    constructor() {
      fixtures.stores.push(this);
    }
  },
}));
import { VmSession } from '../src/vm/session';
import { VmConnectionError, VmRpcError } from '../src/vm/client';

const settings = { retentionDays: 7, maxRecords: 10000, maxBodyBytes: 1048576 };
const sessions: VmSession[] = [];
const originalRule: Rule = {
  id: 'mock-rule',
  name: 'sample',
  enabled: true,
  priority: 0,
  match: { method: 'GET', path: '/sample' },
  mock: { status: 200, headers: {}, body: '{"ok":true}' },
};
const snapshot = {
  headers: [] as [string, string][],
  body: '',
  bodyEncoding: 'text' as const,
  bodyBytes: 0,
  truncated: false,
  editable: true,
  method: 'GET',
  url: 'https://api.example.test/sample',
};
const entry: HistoryEntry = {
  id: 'one',
  startedAt: Date.now(),
  duration: 1,
  method: 'GET',
  host: 'api.example.test',
  path: '/sample',
  url: snapshot.url,
  targetUrl: snapshot.url,
  originalRequest: snapshot,
  request: snapshot,
  mocked: false,
  note: '',
  tags: [],
};
function fixture() {
  const session = new VmSession('/private/workspace', settings);
  sessions.push(session);
  return {
    session,
    client: fixtures.clients.at(-1),
    profiler: fixtures.profilers.at(-1),
    injector: fixtures.injectors.at(-1),
    store: fixtures.stores.at(-1),
  };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}
beforeEach(() => {
  fixtures.order.length = 0;
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

describe('VM session without a proxy engine', () => {
  it('observes in-flight Dio requests without storing them, then updates their stable identity on completion', async () => {
    const { session, injector, store } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', []);
    await session.setMockEnabled(true);
    const observed: HistoryEntry[] = [];
    session.on('observation.http', (value) => observed.push(value));
    injector.emit('observation.http', entry);
    expect(store.put).not.toHaveBeenCalled();
    expect(observed).toEqual([{ ...entry, id: 'vm-dio:one', source: 'vm-dio' }]);
    const completed = { ...entry, response: { ...snapshot, status: 200 } };
    injector.emit('history', completed);
    expect(observed.map((value) => value.id)).toEqual(['vm-dio:one', 'vm-dio:one']);
    expect(observed.at(-1)?.response?.status).toBe(200);
    expect(store.put).toHaveBeenCalledExactlyOnceWith({ ...completed, id: 'vm-dio:one', source: 'vm-dio' });
    await session.setCaptureEnabled(false);
    injector.emit('observation.http', { ...entry, id: 'capture-off' });
    expect(observed).toHaveLength(2);
  });
  it('publishes complete passive test observations before retention or disk failure', async () => {
    const { session, profiler, store } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', []);
    const observed: HistoryEntry[] = [];
    const losses = vi.fn();
    session.on('observation.http', (value) => observed.push(value));
    session.on('observation.loss', losses);
    store.put.mockRejectedValueOnce(new Error('disk full'));
    profiler.emit('history', entry);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ id: 'vm:one', source: 'vm', originalRequest: snapshot });
    profiler.emit('history', { ...entry, id: 'two' });
    expect(observed.map((value) => value.id)).toEqual(['vm:one', 'vm:two']);
    profiler.emit('observation.loss');
    expect(losses).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
  it('rebinds enabled Mock after lifecycle without enabling disabled controls', async () => {
    const { session, profiler, injector } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    const rescan = vi.spyOn(session.websocket, 'rescan').mockResolvedValue();
    await session.refreshAfterLifecycle(new AbortController().signal);
    expect(profiler.rediscover).toHaveBeenCalledOnce();
    expect(injector.sync).not.toHaveBeenCalled();
    expect(rescan).not.toHaveBeenCalled();
    await session.setMockEnabled(true);
    await session.setCaptureEnabled(false);
    session.websocket.state.captureEnabled = true;
    profiler.isolateIds = ['isolates/restarted'];
    await session.refreshAfterLifecycle(new AbortController().signal);
    expect(injector.heartbeat).toHaveBeenCalled();
    expect(injector.sync).toHaveBeenLastCalledWith('isolates/restarted', [originalRule]);
    expect(session.state).toMatchObject({ mockEnabled: true, captureEnabled: false, instances: 1 });
    expect(profiler.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(rescan).toHaveBeenCalledOnce();
    session.websocket.state.captureEnabled = false;
  });
  it('does not rescan or restore controls after cancellation or disconnection', async () => {
    const { session, profiler, injector } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    const abort = new AbortController();
    abort.abort();
    await expect(session.refreshAfterLifecycle(abort.signal)).rejects.toThrow();
    await session.disconnect();
    await expect(session.refreshAfterLifecycle(new AbortController().signal)).rejects.toThrow('失效');
    expect(profiler.rediscover).not.toHaveBeenCalled();
    expect(injector.sync).not.toHaveBeenCalled();
    expect(session.state.mockEnabled).toBe(false);
  });
  it('HTTP capture can stop independently of Mock and stays stopped after rule resync', async () => {
    const { session, profiler, injector, store } = fixture();
    await session.connect('ws://127.0.0.1:1234/auth/ws', []);
    expect(session.state.captureEnabled).toBe(true);
    await session.setCaptureEnabled(false);
    injector.emit('history', entry);
    profiler.emit('history', entry);
    await Promise.resolve();
    expect(store.put).not.toHaveBeenCalled();
    await session.setMockEnabled(true);
    await session.setMockEnabled(false);
    expect(session.state.captureEnabled).toBe(false);
    expect(profiler.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    await session.setCaptureEnabled(true);
    profiler.emit('history', entry);
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledOnce());
  });
  it('connects using only VM modules, exposes only the endpoint host and defaults to observing', async () => {
    const { session, client, profiler, injector, store } = fixture();
    await session.connect('ws://127.0.0.1:1234/private-auth-token=/ws', [originalRule]);
    expect(store.init).toHaveBeenCalled();
    expect(client.connect).toHaveBeenCalled();
    expect(profiler.start).toHaveBeenCalled();
    expect(injector.sync).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({
      status: 'connected',
      endpoint: '127.0.0.1:1234',
      mockEnabled: false,
      isolates: 1,
    });
    expect(JSON.stringify(session.state)).not.toContain('private-auth-token');
  });

  it('selects one history source, counts updates once and can disable and re-enable Mock', async () => {
    const { session, profiler, injector, store } = fixture();
    await session.connect('ws://127.0.0.1:1234/token=/ws', [originalRule]);
    profiler.emit('history', entry);
    profiler.emit('history', entry);
    injector.emit('history', { ...entry, id: 'ignored' });
    await vi.waitFor(() => expect(session.state.recorded).toBe(1));
    expect(store.put).toHaveBeenCalledTimes(2);
    await session.setMockEnabled(true);
    expect(profiler.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(session.state).toMatchObject({ mockEnabled: true, instances: 1 });
    profiler.emit('history', { ...entry, id: 'ignored-profile' });
    injector.emit('history', { ...entry, id: 'mock', mocked: true });
    await vi.waitFor(() => expect(session.state.recorded).toBe(2));
    expect(store.put.mock.calls.at(-1)[0]).toMatchObject({ source: 'vm-dio', mocked: true });
    await session.setMockEnabled(false);
    expect(profiler.setCaptureEnabled).toHaveBeenLastCalledWith(true);
    expect(session.state).toMatchObject({ mockEnabled: false, instances: 0 });
    await session.setMockEnabled(true);
    expect(injector.sync).toHaveBeenCalledTimes(2);
    expect(session.state.mockEnabled).toBe(true);
  });

  it('synchronizes updated rules and discovers replacement isolates', async () => {
    const { session, profiler, injector } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    const updated = { ...originalRule, enabled: false };
    await session.updateRules([updated]);
    expect(injector.sync).toHaveBeenLastCalledWith('isolates/1', [updated]);
    profiler.emit('isolates', ['isolates/2', 'isolates/3']);
    await session.rescan();
    expect(injector.sync).toHaveBeenLastCalledWith('isolates/3', [updated]);
    expect(session.state.instances).toBe(2);
    expect(session.state.isolates).toBe(2);
  });

  it('keeps observation active when no compatible Dio instance is found', async () => {
    const { session, profiler, injector, store } = fixture();
    injector.syncHook = async () => ({ instances: 0, warnings: ['No compatible Dio'] });
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    expect(profiler.setCaptureEnabled).toHaveBeenLastCalledWith(true);
    expect(session.state.instances).toBe(0);
    profiler.emit('history', entry);
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledTimes(1));
    expect(session.state.warnings).toContain('No compatible Dio');
  });

  it('invalidates old attachment counts and automatically reattaches after an external restart', async () => {
    const { session, profiler, injector } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    const blocked = gate<{ instances: number; warnings: string[] }>();
    injector.syncHook = async () => blocked.promise;
    profiler.emit('isolates', ['isolates/restarted']);
    expect(session.state.instances).toBe(0);
    expect(session.state.mockEnabled).toBe(true);
    await vi.waitFor(() =>
      expect(injector.sync).toHaveBeenLastCalledWith('isolates/restarted', [originalRule]),
    );
    blocked.resolve({ instances: 1, warnings: [] });
    await vi.waitFor(() => expect(session.state.instances).toBe(1));
  });

  it('does not keep claiming runtime attachment when rule synchronization fails', async () => {
    const { session, profiler, injector } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    injector.syncHook = async () => {
      throw new Error('sync unavailable');
    };
    await expect(session.updateRules([originalRule])).rejects.toThrow('sync unavailable');
    expect(session.state.instances).toBe(0);
    expect(profiler.setCaptureEnabled).toHaveBeenLastCalledWith(true);
  });

  it('stops profiling and clears runtime state on unexpected socket closure', async () => {
    const { session, client, profiler } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    const stops = profiler.stop.mock.calls.length;
    client.connected = false;
    client.emit('disconnected');
    await vi.waitFor(() => expect(profiler.stop.mock.calls.length).toBeGreaterThan(stops));
    await vi.waitFor(() =>
      expect(session.state).toMatchObject({
        status: 'disconnected',
        mockEnabled: false,
        instances: 0,
        isolates: 0,
      }),
    );
    expect(session.state.warnings.join(' ')).toContain('租约');
  });

  it('queues a newer rules snapshot while another synchronization is in flight', async () => {
    const { session, injector } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    const blocked = gate<{ instances: number; warnings: string[] }>();
    let firstUpdate = true;
    injector.syncHook = async () => {
      if (firstUpdate) {
        firstUpdate = false;
        return blocked.promise;
      }
      return { instances: 1, warnings: [] };
    };
    const updateOne = session.updateRules([{ ...originalRule, name: 'first' }]);
    await vi.waitFor(() => expect(injector.sync).toHaveBeenCalledTimes(2));
    const latest = { ...originalRule, name: 'latest' };
    const updateTwo = session.updateRules([latest]);
    blocked.resolve({ instances: 1, warnings: [] });
    await Promise.all([updateOne, updateTwo]);
    expect(injector.sync).toHaveBeenLastCalledWith('isolates/1', [latest]);
  });

  it('waits for the old lease after unexpected closure before injecting on a new connection', async () => {
    const { session, client, profiler, injector } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    client.connected = false;
    client.emit('disconnected');
    await vi.waitFor(() => expect(session.state.mockEnabled).toBe(false));
    await session.connect('ws://127.0.0.1:1234/new-ws', [originalRule]);
    expect(session.state.status).toBe('connected');
    expect(profiler.start).toHaveBeenCalledTimes(2);
    await expect(session.setMockEnabled(true)).rejects.toThrow('旧租约');
    expect(injector.sync).toHaveBeenCalledTimes(1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 17000);
    try {
      await session.setMockEnabled(true);
      expect(session.state.mockEnabled).toBe(true);
      expect(injector.sync).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('disconnects by removing interception before stopping profiling and closing the socket', async () => {
    const { session } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    fixtures.order.length = 0;
    await session.disconnect();
    const order = fixtures.order;
    expect(order.indexOf('injector.detach')).toBeLessThan(order.indexOf('profiler.stop'));
    expect(order.indexOf('profiler.stop')).toBeLessThan(order.indexOf('client.disconnect'));
    expect(session.state).toMatchObject({
      status: 'disconnected',
      mockEnabled: false,
      instances: 0,
      isolates: 0,
    });
  });

  it('restores observation but waits for the lease when removing a Mock cannot be confirmed', async () => {
    const { session, injector, profiler } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    injector.detach.mockRejectedValueOnce(new Error('synthetic RPC failure'));
    await expect(session.setMockEnabled(false)).rejects.toThrow('旧租约');
    expect(session.state).toMatchObject({ mockEnabled: false, instances: 0, status: 'connected' });
    expect(profiler.setCaptureEnabled).toHaveBeenLastCalledWith(true);
    await expect(session.setMockEnabled(true)).rejects.toThrow('旧租约');
    expect(injector.sync).toHaveBeenCalledTimes(1);
  });

  it('sanitizes connection errors including authentication URLs', async () => {
    const { session, client } = fixture();
    client.connectHook = async (url: string) => {
      throw new Error(`network failure at ${url}`);
    };
    const failure = await session
      .connect('ws://127.0.0.1:1234/private-auth-token=/ws', [])
      .catch((error: Error) => error);
    expect(String(failure)).not.toContain('private-auth-token');
    expect(JSON.stringify(session.state)).not.toContain('private-auth-token');
    expect(session.state.status).toBe('disconnected');
  });

  it('keeps a connected session and active Mock intact when another address is submitted', async () => {
    const { session, client, injector } = fixture();
    await session.connect('ws://127.0.0.1:1234/first-token=/ws', [originalRule]);
    await session.setMockEnabled(true);
    const detachCalls = injector.detach.mock.calls.length;
    await expect(session.connect('ws://127.0.0.1:4321/second-token=/ws', [])).rejects.toThrow('请先断开');
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(injector.detach).toHaveBeenCalledTimes(detachCalls);
    expect(session.state).toMatchObject({
      status: 'connected',
      endpoint: '127.0.0.1:1234',
      mockEnabled: true,
      instances: 1,
    });
  });

  it('rejects a duplicate queued before the first connection starts without restarting it', async () => {
    const { session, client } = fixture();
    const first = session.connect('ws://127.0.0.1:1234/token=/ws', []);
    const duplicate = expect(session.connect('ws://127.0.0.1:4321/other-token=/ws', [])).rejects.toThrow(
      '请先断开',
    );
    await Promise.all([first, duplicate]);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(session.state).toMatchObject({ status: 'connected', endpoint: '127.0.0.1:1234' });
  });

  it('never reports connected if the socket closes during profiler initialization', async () => {
    const { session, client, profiler } = fixture();
    const statuses: string[] = [];
    session.on('change', () => statuses.push(session.state.status));
    profiler.start.mockImplementationOnce(async () => {
      profiler.emit('isolates', ['isolates/transient']);
      client.connected = false;
      client.emit('disconnected');
      // A final polling error can be handled as a warning by the profiler.
      await Promise.resolve();
    });
    await expect(session.connect('ws://127.0.0.1:1234/private-token=/ws', [])).rejects.toThrow(
      '初始化完成前已断开',
    );
    expect(statuses).not.toContain('connected');
    expect(session.state).toMatchObject({
      status: 'disconnected',
      isolates: 0,
      instances: 0,
      mockEnabled: false,
    });
    expect(session.state.endpoint).toBeUndefined();
    expect((session as any).isolateIds).toEqual([]);
    expect((session as any).timer).toBeUndefined();
    expect(JSON.stringify(session.state)).not.toContain('private-token');
  });

  it('checks the live socket before committing a successful initialized connection', async () => {
    const { session, client, profiler } = fixture();
    profiler.start.mockImplementationOnce(async () => {
      client.connected = false;
    });
    await expect(session.connect('ws://127.0.0.1:1234/ws', [])).rejects.toThrow('初始化完成前已断开');
    expect(session.state.status).toBe('disconnected');
    expect(session.state.endpoint).toBeUndefined();
  });

  it('clears endpoint and stale errors after explicit disconnect and leaves failure runtime counts empty', async () => {
    const { session, profiler } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', []);
    session.state.error = 'older failure';
    await session.disconnect();
    expect(session.state.endpoint).toBeUndefined();
    expect(session.state.error).toBeUndefined();
    profiler.start.mockImplementationOnce(async () => {
      profiler.emit('isolates', ['isolates/transient']);
      throw new Error('private diagnostic data');
    });
    await expect(session.connect('ws://127.0.0.1:4321/private-token=/ws', [])).rejects.toThrow(
      '无法连接或初始化',
    );
    expect(session.state).toMatchObject({
      status: 'disconnected',
      isolates: 0,
      instances: 0,
      mockEnabled: false,
    });
    expect(session.state.endpoint).toBeUndefined();
    expect((session as any).isolateIds).toEqual([]);
    expect(JSON.stringify(session.state)).not.toContain('private diagnostic data');
  });

  it('propagates controlled connection and RPC diagnostics without exposing unknown errors', async () => {
    const { session, client, profiler } = fixture();
    client.connectHook = async () => {
      throw new VmConnectionError('refused', 'VM 端口拒绝连接，请复制本次调试地址。');
    };
    await expect(session.connect('ws://127.0.0.1:1234/private-token=/ws', [])).rejects.toThrow(
      'VM 端口拒绝连接',
    );
    expect(session.state.error).toBe('VM 端口拒绝连接，请复制本次调试地址。');
    client.connectHook = undefined;
    profiler.start.mockRejectedValueOnce(new VmRpcError(-32601, 'getVM'));
    await expect(session.connect('ws://127.0.0.1:1234/private-token=/ws', [])).rejects.toThrow(
      'VM RPC getVM 失败（-32601）',
    );
    expect(JSON.stringify(session.state)).not.toContain('private-token');
  });

  it('shows the final sanitized DDS endpoint and clears it immediately on unexpected disconnect', async () => {
    const { session, client, profiler } = fixture();
    client.endpoint = '127.0.0.1:4321';
    await session.connect('ws://127.0.0.1:1234/private-token=/ws', []);
    expect(session.state.endpoint).toBe('127.0.0.1:4321');
    client.connected = false;
    client.emit('disconnected');
    expect(session.state).toMatchObject({
      status: 'disconnected',
      isolates: 0,
      instances: 0,
      mockEnabled: false,
    });
    expect(session.state.endpoint).toBeUndefined();
    await vi.waitFor(() => expect(session.state.error).toContain('VM 连接已断开'));
    profiler.emit('isolates', ['isolates/stale']);
    expect(session.state.isolates).toBe(0);
  });

  it('serializes detach after an in-flight rule sync and finishes disconnected', async () => {
    const { session, injector } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    const blocked = gate<{ instances: number; warnings: string[] }>();
    injector.syncHook = async () => blocked.promise;
    const updating = session.updateRules([{ ...originalRule, name: 'updated' }]);
    await vi.waitFor(() => expect(injector.sync).toHaveBeenCalledTimes(2));
    const detachedBefore = injector.detach.mock.calls.length;
    const disconnecting = session.disconnect();
    await new Promise((resolve) => setImmediate(resolve));
    const detachedDuringSync = injector.detach.mock.calls.length;
    blocked.resolve({ instances: 1, warnings: [] });
    await Promise.all([updating, disconnecting]);
    expect(detachedDuringSync).toBe(detachedBefore);
    expect(session.state).toMatchObject({ status: 'disconnected', instances: 0, mockEnabled: false });
  });

  it('does not queue repeated heartbeats ahead of disconnect when a heartbeat stalls', async () => {
    const { session, injector } = fixture();
    await session.connect('ws://127.0.0.1:1234/ws', [originalRule]);
    await session.setMockEnabled(true);
    const blocked = gate<void>();
    injector.heartbeat.mockImplementationOnce(() => blocked.promise);
    const tick = (session as any).tick.bind(session) as () => Promise<void>;
    const first = tick();
    await vi.waitFor(() => expect(injector.heartbeat).toHaveBeenCalledTimes(1));
    await Promise.all([tick(), tick(), tick()]);
    const stopping = session.disconnect();
    blocked.resolve();
    await Promise.all([first, stopping]);
    expect(injector.heartbeat).toHaveBeenCalledTimes(1);
    expect(session.state.status).toBe('disconnected');
  });

  it('rejects a second connection while the first is pending and permits retry after failure', async () => {
    const { session, client } = fixture();
    const blocked = gate<void>();
    client.connectHook = async (url: string) => {
      if (url.includes('old-token')) await blocked.promise;
    };
    const first = session.connect('ws://127.0.0.1:1111/old-token=/ws', []).catch(() => undefined);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));
    await expect(session.connect('ws://127.0.0.1:2222/new-token=/ws', [])).rejects.toThrow('请先断开');
    blocked.reject(new Error('old attempt failed'));
    await first;
    await session.connect('ws://127.0.0.1:2222/new-token=/ws', []);
    expect(session.state).toMatchObject({ status: 'connected', endpoint: '127.0.0.1:2222' });
    expect(client.connected).toBe(true);
  });
});

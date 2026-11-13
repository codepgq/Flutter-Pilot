import { describe, expect, it, vi } from 'vitest';
import { TestNetworkObserver, type NetworkObserverCallbacks } from '../src/testing/network';
import { readVmClock } from '../src/testing/vm-clock';
import type { HistoryEntry } from '../src/model';
import type { WsMessage } from '../src/ws/model';

function fixture(options: { maximum?: number; bytes?: number; sourceAt?: number } = {}) {
  let callbacks: NetworkObserverCallbacks | undefined;
  let sourceAt = options.sourceAt ?? 1000.25;
  const unsubscribe = vi.fn(() => {
    callbacks = undefined;
  });
  const host = {
    clock: vi.fn(async () => {
      const now = sourceAt;
      sourceAt += 1;
      return now;
    }),
    subscribe: vi.fn((next: NetworkObserverCallbacks) => {
      callbacks = next;
      return unsubscribe;
    }),
    connections: async () => [{ id: 'socket', url: 'wss://example.test/orders' }] as any,
  };
  return {
    observer: new TestNetworkObserver(host, options.maximum, options.bytes),
    host,
    unsubscribe,
    http: (entry: HistoryEntry) => callbacks?.http(entry),
    ws: (entry: WsMessage) => callbacks?.ws(entry),
    loss: () => callbacks?.loss(),
  };
}
const request = (id: string, startedAt: number) =>
  ({ id, startedAt, originalRequest: { body: id } }) as HistoryEntry;
const event = (id: string, timestamp: number) =>
  ({ id, timestamp, connectionId: 'socket', original: id }) as WsMessage;

describe('test network observation', () => {
  it.each([-30000, 30000])('uses source time despite device/host clock skew of %s ms', async (offset) => {
    const sourceAt = Date.now() + offset;
    const f = fixture({ sourceAt });
    const baseline = await f.observer.baseline();
    expect(baseline.at).toBe(sourceAt + 1);
    f.http(request('new', baseline.at));
    f.ws(event('new', baseline.at + 0.5));
    expect((await f.observer.http(baseline)).map((item) => item.id)).toEqual(['new']);
    expect((await f.observer.ws(baseline)).map((item) => item.id)).toEqual(['new']);
    f.observer.close();
  });
  it('rejects same-millisecond pre-existing in-flight HTTP and fractional old WS', async () => {
    const f = fixture({ sourceAt: 1000.5 });
    f.host.clock.mockImplementationOnce(async () => {
      f.ws(event('already-delivered', 1000.75));
      return 1000.5;
    });
    const baseline = await f.observer.baseline();
    expect(baseline.at).toBe(1002);
    // These records finish after arming, but started before the source fence.
    f.http(request('old-in-flight', 1000));
    f.ws(event('old-delayed', 1000.75));
    f.http(request('new', baseline.at));
    f.ws(event('new', baseline.at + 0.5));
    expect(await f.observer.http(baseline)).toEqual([request('new', baseline.at)]);
    expect(await f.observer.ws(baseline)).toEqual([
      { ...event('new', baseline.at + 0.5), url: 'wss://example.test/orders' },
    ]);
    f.observer.close();
  });
  it('excludes all records delivered during arming, even with fractional timestamps', async () => {
    const f = fixture({ sourceAt: 1000.25 });
    f.host.clock.mockImplementationOnce(async () => {
      f.http(request('arming-http', 1002));
      f.ws(event('arming-ws', 1002.5));
      return 1000.25;
    });
    const baseline = await f.observer.baseline();
    expect(baseline.httpIds).toContain('arming-http');
    expect(baseline.wsIds).toContain('arming-ws');
    // Redelivery of a baseline ID cannot satisfy the current run either.
    f.http(request('arming-http', 1002));
    f.ws(event('arming-ws', 1002.5));
    expect(await f.observer.http(baseline)).toEqual([]);
    expect(await f.observer.ws(baseline)).toEqual([]);
    f.observer.close();
  });
  it('retains both submissions independently from a maxRecords=1 history store', async () => {
    const f = fixture();
    const baseline = await f.observer.baseline();
    const retained: HistoryEntry[] = [];
    for (const id of ['first', 'duplicate']) {
      const item = request(id, baseline.at);
      f.http(item);
      retained.push(item);
      retained.splice(0, Math.max(0, retained.length - 1));
    }
    expect(retained).toHaveLength(1);
    expect((await f.observer.http(baseline)).map((item) => item.id)).toEqual(['first', 'duplicate']);
    f.observer.close();
  });
  it('keeps full immutable records beyond history page sizes', async () => {
    const f = fixture(),
      baseline = await f.observer.baseline();
    for (let i = 0; i < 451; i++) {
      f.http(request(String(i), baseline.at));
      f.ws(event(String(i), baseline.at));
    }
    const item = request('immutable', baseline.at);
    f.http(item);
    item.originalRequest.body = 'changed';
    expect(await f.observer.http(baseline)).toHaveLength(452);
    expect((await f.observer.http(baseline)).at(-1)?.originalRequest.body).toBe('immutable');
    expect(await f.observer.ws(baseline)).toHaveLength(451);
    f.observer.close();
  });
  it('fails instead of exposing partial observations when count, bytes, or source loss overflows', async () => {
    const count = fixture({ maximum: 1 }),
      baseline = await count.observer.baseline();
    count.http(request('one', baseline.at));
    count.http(request('two', baseline.at));
    await expect(count.observer.http(baseline)).rejects.toThrow('上限');
    count.observer.close();
    const bytes = fixture({ bytes: 1 }),
      b = await bytes.observer.baseline();
    bytes.ws(event('one', b.at));
    await expect(bytes.observer.ws(b)).rejects.toThrow('上限');
    bytes.observer.close();
    const loss = fixture(),
      c = await loss.observer.baseline();
    loss.loss();
    await expect(loss.observer.http(c)).rejects.toThrow('遗漏');
    loss.observer.close();
  });
  it('releases listeners/bodies between runs and rejects a released baseline', async () => {
    const f = fixture(),
      first = await f.observer.baseline();
    f.http(request('old', first.at));
    const second = await f.observer.baseline();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    await expect(f.observer.http(first)).rejects.toThrow('不属于本轮');
    expect(await f.observer.http(second)).toEqual([]);
    f.observer.close();
    expect(f.unsubscribe).toHaveBeenCalledTimes(2);
    await expect(f.observer.http(second)).rejects.toThrow('释放');
  });
  it('fails source clock errors and unwinds the passive listener', async () => {
    const f = fixture();
    f.host.clock.mockRejectedValueOnce(new Error('VM disconnected'));
    await expect(f.observer.baseline()).rejects.toThrow('VM disconnected');
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('VM source clock', () => {
  it('reads Dart time through a non-system isolate and refuses invalid VM values', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'getVM'
        ? { isolates: [{ id: 'system', isSystemIsolate: true }, { id: 'app' }] }
        : method === 'getIsolate'
          ? { libraries: [{ id: 'core', uri: 'dart:core' }] }
          : { type: '@Instance', valueAsString: '1700000000000.125' },
    );
    expect(await readVmClock({ call } as any)).toBe(1700000000000.125);
    expect(call).toHaveBeenCalledWith('evaluate', {
      isolateId: 'app',
      targetId: 'core',
      expression: 'DateTime.now().microsecondsSinceEpoch / 1000',
      disableBreakpoints: true,
    });
    call.mockImplementation(async () => ({ isolates: [] }));
    await expect(readVmClock({ call } as any)).rejects.toThrow('isolate');
  });
});

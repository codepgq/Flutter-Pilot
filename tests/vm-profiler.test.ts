import { describe, expect, it } from 'vitest';
import {
  VmNetworkProfiler,
  normalizeHttpProfile,
  websocketHandshake,
  isWebSocketHandshake,
} from '../src/vm/profiler';
import type { VmRpc } from '../src/vm/client';

const now = Date.now() * 1000;
function profile(id = 'request1', overrides = {}) {
  return {
    id,
    method: 'POST',
    uri: 'https://api.example.test/orders?q=1',
    startTime: now,
    endTime: now + 3000,
    request: { headers: { 'content-type': ['application/json'], 'x-value': ['a', 'b'] } },
    response: {
      statusCode: 201,
      headers: { 'content-type': ['application/json'] },
      startTime: now + 4000,
      endTime: now + 18000,
    },
    requestBody: [...Buffer.from('{"input":"中文"}')],
    responseBody: [...Buffer.from('{"ok":true}')],
    ...overrides,
  };
}
class FakeVm implements VmRpc {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  ids = ['isolates/1'];
  initiallyEnabled = false;
  supported = true;
  pid: number | undefined = 42;
  startTime: number | undefined = 1000;
  restoreFails = false;
  requests = [profile()];
  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    let result: unknown = {};
    if (method === 'getVM')
      result = { pid: this.pid, startTime: this.startTime, isolates: this.ids.map((id) => ({ id })) };
    if (method === 'getIsolate')
      result = { extensionRPCs: this.supported ? ['ext.dart.io.getHttpProfile'] : [] };
    if (method === 'ext.dart.io.httpEnableTimelineLogging') {
      if (params.enabled === false && this.restoreFails) throw new Error('synthetic disconnected socket');
      result = { enabled: this.initiallyEnabled };
    }
    if (method === 'ext.dart.io.getHttpProfile')
      result = { timestamp: now + 100000, requests: this.requests };
    if (method === 'ext.dart.io.getHttpProfileRequest')
      result = this.requests.find((request) => request.id === params.id);
    return result as T;
  }
}

describe('VM network profile normalization', () => {
  it('preserves headers, bodies, status, URLs and microsecond timing as immutable snapshots', () => {
    const entry = normalizeHttpProfile(profile(), 'session', 'isolates/1')!;
    expect(entry).toMatchObject({
      id: 'vm:session:isolates/1:request1',
      method: 'POST',
      host: 'api.example.test',
      path: '/orders',
      duration: 18,
      mocked: false,
      startedAt: now / 1000,
    });
    expect(entry.request.body).toBe('{"input":"中文"}');
    expect(entry.request.headers).toContainEqual(['x-value', 'b']);
    expect(entry.response?.status).toBe(201);
    expect(entry.response?.body).toBe('{"ok":true}');
    expect(entry.originalRequest).toEqual(entry.request);
    expect(entry.originalResponse).toEqual(entry.response);
    expect(entry.request.editable).toBe(true);
  });
  it('marks bounded and binary bodies, preserves transport errors and rejects non-HTTP URLs', () => {
    const binary = normalizeHttpProfile(
      profile('binary', {
        responseBody: [0, 255, 3],
        response: { statusCode: 200, headers: { 'content-type': ['image/png'] }, endTime: now + 20000 },
      }),
      's',
      'i',
    )!;
    expect(binary.response).toMatchObject({ bodyEncoding: 'base64', body: 'AP8D' });
    const truncated = normalizeHttpProfile(
      profile('large', { responseBody: [...Buffer.from('abcdef')] }),
      's',
      'i',
      3,
    )!;
    expect(truncated.response).toMatchObject({ body: 'abc', truncated: true, bodyBytes: 6 });
    const failed = normalizeHttpProfile(
      profile('failed', { response: undefined, request: { error: 'Connection failed' } }),
      's',
      'i',
    )!;
    expect(failed.error).toBe('Connection failed');
    expect(failed.response).toBeUndefined();
    expect(normalizeHttpProfile(profile('invalid', { uri: 'file:///etc/passwd' }), 's', 'i')).toBeUndefined();
  });
});

describe('VM profiling lifecycle', () => {
  it('routes upgrade handshakes to WS and keeps collecting them while Dio owns HTTP capture', async () => {
    const vm = new FakeVm();
    const upgraded = profile('ws', {
      uri: 'https://example.test/socket?channel=prices',
      response: {
        statusCode: 101,
        headers: { upgrade: ['websocket'] },
        endTime: now + 20000,
        connectionInfo: { localPort: 40001, remotePort: 443, remoteAddress: '127.0.0.1' },
      },
    });
    vm.requests = [upgraded];
    const profiler = new VmNetworkProfiler(vm, { intervalMs: 60000 });
    const http: unknown[] = [];
    const ws: unknown[][] = [];
    profiler.on('history', (entry) => http.push(entry));
    profiler.on('websocket', (...args) => ws.push(args));
    await profiler.start();
    expect(http).toHaveLength(0);
    expect(ws[0][1]).toMatchObject({
      url: 'wss://example.test/socket?channel=prices',
      localPort: 40001,
      remotePort: 443,
    });
    await profiler.setHandshakeCaptureEnabled(true);
    await profiler.setCaptureEnabled(false);
    vm.requests.push(profile('ws2', { ...upgraded, id: 'ws2' }));
    await profiler.pollNow();
    expect(ws).toHaveLength(2);
    await profiler.stop();
  });
  it('requires actual upgrade evidence and a complete socket tuple before URL association', () => {
    const ordinary = normalizeHttpProfile(profile(), 's', 'i')!;
    expect(isWebSocketHandshake(ordinary)).toBe(false);
    expect(websocketHandshake({}, ordinary, 'i')).toBeUndefined();
    const upgraded = {
      ...ordinary,
      response: {
        ...ordinary.response!,
        status: 101,
        headers: [['Upgrade', 'websocket']] as [string, string][],
      },
    };
    expect(isWebSocketHandshake(upgraded)).toBe(true);
    expect(websocketHandshake({}, upgraded, 'i')).toBeUndefined();
  });
  it('retains failed ownership across an immediate reconnect to the same VM and warns about App-side collection', async () => {
    const vm = new FakeVm();
    const profiler = new VmNetworkProfiler(vm, { intervalMs: 60000 });
    const warnings: string[] = [];
    profiler.on('warning', (warning) => warnings.push(warning));
    await profiler.start();
    vm.initiallyEnabled = true; // The flag enabled by this profiler remains in the App.
    vm.restoreFails = true;
    await profiler.stop();
    expect(warnings.join(' ')).toContain('应用可能继续采集');
    expect(warnings.join(' ')).toContain('Hot Restart');
    vm.restoreFails = false;
    vm.calls = [];
    await profiler.start();
    expect(profiler.isolateIds).toEqual(['isolates/1']);
    await profiler.stop();
    expect(vm.calls.filter((call) => call.params.enabled === false)).toHaveLength(1);
    expect(vm.calls.some((call) => call.method === 'ext.dart.io.clearHttpProfile')).toBe(false);

    // Successful restoration consumes ownership, so an external consumer that
    // enables profiling later is never disabled by the next connection.
    vm.calls = [];
    await profiler.start();
    await profiler.stop();
    expect(vm.calls.some((call) => call.params.enabled === false)).toBe(false);
  });

  it.each(['pid', 'startTime', 'isolate', 'missing-identity'] as const)(
    'does not reclaim external profiling when a reconnect changes %s',
    async (change) => {
      const vm = new FakeVm();
      const profiler = new VmNetworkProfiler(vm, { intervalMs: 60000 });
      await profiler.start();
      vm.restoreFails = true;
      vm.initiallyEnabled = true;
      await profiler.stop();
      vm.restoreFails = false;
      if (change === 'pid') vm.pid = 43;
      if (change === 'startTime') vm.startTime = 2000;
      if (change === 'isolate') vm.ids = ['isolates/2'];
      if (change === 'missing-identity') vm.startTime = undefined;
      vm.calls = [];
      await profiler.start();
      await profiler.stop();
      expect(vm.calls.some((call) => call.params.enabled === false)).toBe(false);
      expect(vm.calls.some((call) => call.method === 'ext.dart.io.clearHttpProfile')).toBe(false);
    },
  );

  it('pauses owned SDK body profiling for injection mode but preserves DevTools-owned profiling', async () => {
    const vm = new FakeVm();
    const profiler = new VmNetworkProfiler(vm, { intervalMs: 60000 });
    await profiler.start();
    await profiler.setCaptureEnabled(false);
    expect(vm.calls.at(-1)).toEqual({
      method: 'ext.dart.io.httpEnableTimelineLogging',
      params: { isolateId: 'isolates/1', enabled: false },
    });
    vm.calls = [];
    await profiler.pollNow();
    expect(vm.calls.some((call) => call.method === 'ext.dart.io.getHttpProfile')).toBe(false);
    await profiler.setCaptureEnabled(true);
    expect(vm.calls.some((call) => call.params.enabled === true)).toBe(true);
    await profiler.stop();
    vm.initiallyEnabled = true;
    vm.calls = [];
    await profiler.start();
    await profiler.setCaptureEnabled(false);
    await profiler.pollNow();
    await profiler.stop();
    expect(vm.calls.some((call) => call.params.enabled === false)).toBe(false);
  });
  it('enables profiling, deduplicates completed requests and restores only the flag it enabled', async () => {
    const vm = new FakeVm();
    const profiler = new VmNetworkProfiler(vm, { sessionId: 'test', intervalMs: 60000 });
    const entries: unknown[] = [];
    profiler.on('history', (entry) => entries.push(entry));
    await profiler.start();
    expect(profiler.isolateIds).toEqual(['isolates/1']);
    await Promise.all([profiler.pollNow(), profiler.pollNow()]);
    expect(entries).toHaveLength(1);
    expect(vm.calls.filter((call) => call.method === 'ext.dart.io.getHttpProfileRequest')).toHaveLength(1);
    expect(vm.calls.some((call) => call.params.enabled === true)).toBe(true);
    expect(
      vm.calls.some(
        (call) =>
          call.method === 'ext.dart.io.getHttpProfile' && typeof call.params.updatedSince === 'number',
      ),
    ).toBe(true);
    await profiler.stop();
    expect(vm.calls.some((call) => call.params.enabled === false)).toBe(true);
    expect(vm.calls.some((call) => call.method === 'ext.dart.io.clearHttpProfile')).toBe(false);
    vm.calls = [];
    vm.initiallyEnabled = true;
    await profiler.start();
    await profiler.stop();
    expect(vm.calls.some((call) => call.params.enabled !== undefined)).toBe(false);
  });
  it('does not lose a batch when the detail budget is exhausted', async () => {
    const vm = new FakeVm();
    vm.requests = [profile('one'), profile('two'), profile('in-flight', { response: undefined })];
    const profiler = new VmNetworkProfiler(vm, { maxDetailsPerPoll: 1, intervalMs: 60000 });
    const entries: unknown[] = [];
    profiler.on('history', (entry) => entries.push(entry));
    await profiler.start();
    expect(entries).toHaveLength(1);
    await profiler.pollNow();
    expect(entries).toHaveLength(2);
    await profiler.stop();
    expect(
      vm.calls
        .filter((call) => call.method === 'ext.dart.io.getHttpProfileRequest')
        .map((call) => call.params.id),
    ).toEqual(['one', 'two']);
  });
  it('re-discovers restarted isolates and waits for late service-extension registration', async () => {
    const vm = new FakeVm();
    vm.supported = false;
    const profiler = new VmNetworkProfiler(vm, { intervalMs: 60000 });
    const warnings: string[] = [];
    profiler.on('warning', (warning) => warnings.push(warning));
    await profiler.start();
    expect(profiler.isolateIds).toEqual([]);
    expect(warnings).toHaveLength(1);
    vm.supported = true;
    (profiler as unknown as { lastDiscovery: number }).lastDiscovery = 0;
    await profiler.pollNow();
    expect(profiler.isolateIds).toEqual(['isolates/1']);
    vm.ids = ['isolates/2'];
    (profiler as unknown as { lastDiscovery: number }).lastDiscovery = 0;
    await profiler.pollNow();
    expect(profiler.isolateIds).toEqual(['isolates/2']);
    await profiler.stop();
  });
});

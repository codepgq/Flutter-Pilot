import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpLifecycleController, type LifecycleHost } from '../src/mcp/lifecycle';
import { parseTool } from '../src/mcp/tools';

function fixture() {
  let ids = ['old'];
  let connected = true;
  let target: { debugSessionId: string } | undefined = { debugSessionId: 'target-debug' };
  const rpc = Object.assign(new EventEmitter(), {
    call: vi.fn(async (method: string) =>
      method === 'getVM'
        ? { isolates: ids.map((id) => ({ id })) }
        : { extensionRPCs: ['ext.flutter.reassemble'], isolateGroupId: 'flutter-group' },
    ),
  });
  const emit = (status = 'success', isolateId = 'old') =>
    rpc.emit('notification', {
      params: { event: { kind: 'IsolateReload', isolate: { id: isolateId }, status } },
    });
  const host: LifecycleHost = {
    rpc: rpc as any,
    connected: () => connected,
    target: () => target,
    control: vi.fn(async (_, action) => {
      if (action === 'hot_reload') emit();
      else ids = ['new'];
    }),
    invalidateUi: vi.fn(),
    refresh: vi.fn(async () => {}),
    networkStatus: () => ({ vmConnected: connected, http: { mockEnabled: false } }),
  };
  const controller = new McpLifecycleController(host);
  return {
    controller,
    host,
    rpc,
    emit,
    setIds: (value: string[]) => {
      ids = value;
    },
    disconnect: () => {
      connected = false;
    },
    unbind: () => {
      target = undefined;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('MCP Flutter lifecycle', () => {
  it('accepts group-level IsolateReload events from Dart runtimes', async () => {
    const f = fixture();
    vi.mocked(f.host.control).mockImplementation(async () => {
      f.rpc.emit('notification', {
        params: {
          event: { kind: 'IsolateReload', isolateGroup: { id: 'flutter-group' }, status: 'success' },
        },
      });
    });
    expect(await f.controller.execute('hot_reload')).toMatchObject({ ok: true, completed: true });
  });
  it('does not send restart if MCP was disabled during the asynchronous preflight', async () => {
    const f = fixture();
    let enabled = true;
    const original = f.rpc.call.getMockImplementation()!;
    f.rpc.call.mockImplementation(async (method) => {
      if (method === 'getIsolate') enabled = false;
      return original(method);
    });
    expect(await f.controller.execute('hot_restart', 1000, undefined, () => enabled)).toMatchObject({
      ok: false,
      submitted: false,
      code: 'SESSION_INVALIDATED',
    });
    expect(f.host.control).not.toHaveBeenCalled();
  });
  it.each(['hot_reload', 'hot_restart'] as const)(
    'requires an explicit session for %s and rejects arbitrary commands',
    (action) => {
      expect(parseTool(action, { sessionId: 'project', timeoutMs: 30000 })).toMatchObject({
        sessionId: 'project',
      });
      for (const args of [
        {},
        { sessionId: 'project', command: 'stop' },
        { sessionId: 'project', timeoutMs: 30001 },
      ])
        expect(() => parseTool(action, args)).toThrow();
    },
  );
  it.each(['hot_reload', 'hot_restart'] as const)(
    'confirms %s evidence, invalidates UI and reports network state',
    async (action) => {
      const f = fixture();
      const result = await f.controller.execute(action);
      expect(result).toMatchObject({
        ok: true,
        submitted: true,
        completed: true,
        action,
        statePreserved: action === 'hot_reload',
        debugSessionId: 'target-debug',
        network: { http: { mockEnabled: false } },
      });
      expect(f.host.control).toHaveBeenCalledExactlyOnceWith({ debugSessionId: 'target-debug' }, action);
      expect(f.host.invalidateUi).toHaveBeenCalledOnce();
      expect(f.host.refresh).toHaveBeenCalledOnce();
      expect(f.rpc.listenerCount('notification')).toBe(0);
      expect(f.controller.status().busy).toBe(false);
    },
  );
  it('rejects disconnected, manual-only and cancelled requests before sending anything', async () => {
    for (const state of ['disconnected', 'manual', 'cancelled']) {
      const f = fixture();
      const abort = new AbortController();
      if (state === 'disconnected') f.disconnect();
      if (state === 'manual') f.unbind();
      if (state === 'cancelled') abort.abort();
      await expect(f.controller.execute('hot_restart', 1000, abort.signal)).rejects.toMatchObject({
        code:
          state === 'disconnected'
            ? 'VM_DISCONNECTED'
            : state === 'manual'
              ? 'DEBUG_SESSION_UNAVAILABLE'
              : 'CANCELLED',
      });
      expect(f.host.control).not.toHaveBeenCalled();
    }
  });
  it('does not interpret adapter acknowledgement or another isolate reload as completion', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.host.control).mockImplementation(async () => {
      f.emit('success', 'unrelated');
    });
    const work = f.controller.execute('hot_reload', 100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await work).toMatchObject({ ok: false, code: 'TIMEOUT', completed: false, submitted: true });
    expect(f.host.refresh).not.toHaveBeenCalled();
  });
  it('requires a replacement Flutter isolate after restart', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.host.control).mockImplementation(async () => {
      f.setIds(['old', 'new']);
    });
    const work = f.controller.execute('hot_restart', 100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await work).toMatchObject({ ok: false, code: 'TIMEOUT' });
  });
  it('reports failed reloads without leaking runtime diagnostic text', async () => {
    const f = fixture();
    vi.mocked(f.host.control).mockImplementation(async () => {
      f.rpc.emit('notification', {
        params: {
          event: { kind: 'IsolateReload', isolate: { id: 'old' }, reloadFailureReason: 'private-token' },
        },
      });
    });
    const result = await f.controller.execute('hot_reload');
    expect(result).toMatchObject({ ok: false, code: 'HOT_RELOAD_FAILED' });
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(f.host.refresh).not.toHaveBeenCalled();
  });
  it('keeps the in-flight guard after timeout until the debug request actually settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    vi.mocked(f.host.control).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const work = f.controller.execute('hot_restart', 100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await work).toMatchObject({ ok: false, code: 'TIMEOUT' });
    await expect(f.controller.execute('hot_restart')).rejects.toMatchObject({ code: 'BUSY' });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.status().busy).toBe(false);
    expect(f.host.refresh).not.toHaveBeenCalled();
    expect(f.host.control).toHaveBeenCalledOnce();
  });
  it('stops on in-flight cancellation or a lost target without restoring old controls', async () => {
    for (const state of ['cancelled', 'disconnected', 'unbound']) {
      const f = fixture();
      const abort = new AbortController();
      vi.mocked(f.host.control).mockImplementation(async () => {
        if (state === 'cancelled') abort.abort();
        if (state === 'disconnected') f.disconnect();
        if (state === 'unbound') f.unbind();
      });
      expect(await f.controller.execute('hot_restart', 1000, abort.signal)).toMatchObject({
        ok: false,
        code: state === 'cancelled' ? 'CANCELLED' : 'SESSION_INVALIDATED',
      });
      expect(f.host.refresh).not.toHaveBeenCalled();
    }
  });
  it('separates completed restart from a failed Mock rescan', async () => {
    const f = fixture();
    vi.mocked(f.host.refresh).mockRejectedValue(new Error('private-vm-uri'));
    const result = await f.controller.execute('hot_restart');
    expect(result).toMatchObject({ ok: true, completed: true, warning: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('private-vm-uri');
  });
});

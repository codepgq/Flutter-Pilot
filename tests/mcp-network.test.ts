import { describe, it, expect, vi } from 'vitest';
import { McpNetworkController, type NetworkHost } from '../src/mcp/network';
import { parseTool } from '../src/mcp/tools';

function fixture() {
  const host: NetworkHost = {
    scenesPath: '/project/.flutter-pilot/scenes.json',
    listScenes: vi.fn(() => ({ version: 1, activeSceneId: null, scenes: [] })),
    activateScene: vi.fn(async () => {}),
    reloadScenes: vi.fn(async () => {}),
    status: () => ({ http: { mockEnabled: false }, ws: { mockEnabled: false } }),
    listHttp: vi.fn(async () => ({ items: [], total: 0 })),
    getHttp: vi.fn(),
    connections: vi.fn(async () => []),
    messages: vi.fn(async () => ({ items: [], total: 0 })),
    setCapture: vi.fn(async () => {}),
    injectWs: vi.fn(async () => {}),
    sendWs: vi.fn(async () => {}),
  };
  return { host, controller: new McpNetworkController(host) };
}

describe('MCP file-backed network workflow', () => {
  it('sends topic/data and injects raw protocol text without changing switches', async () => {
    const { host, controller } = fixture();
    const args = { sessionId: 'project', connectionId: 'exact', topic: 'assets', data: { balance: 42 } };
    expect(await controller.execute('send_ws_message', parseTool('send_ws_message', args))).toMatchObject({
      submitted: true,
      direction: 'outbound',
      connectionId: 'exact',
    });
    expect(host.sendWs).toHaveBeenCalledWith(
      'exact',
      JSON.stringify({ topic: 'assets', data: { balance: 42 } }),
      undefined,
    );
    await controller.execute(
      'inject_ws_message',
      parseTool('inject_ws_message', {
        sessionId: 'project',
        connectionId: 'exact',
        text: '{"event":"custom","payload":null}',
      }),
    );
    expect(host.injectWs).toHaveBeenCalledWith('exact', '{"event":"custom","payload":null}', undefined);
    expect(host.setCapture).not.toHaveBeenCalled();
    expect(host.activateScene).not.toHaveBeenCalled();
  });

  it('rejects ambiguous, incomplete, non-JSON or oversized messages before dispatch', async () => {
    const base = { sessionId: 'project', connectionId: 'exact' };
    for (const tool of ['send_ws_message', 'inject_ws_message']) {
      for (const payload of [
        {},
        { topic: 'x' },
        { data: null },
        { text: 'x', topic: 'x', data: null },
        { topic: 'x', data: undefined },
        { topic: 'x', data: Infinity },
        { text: '中'.repeat(90000) },
        { topic: 'x', data: '\\'.repeat(140000) },
        { text: 'x', expression: 'evil()' },
      ])
        expect(() => parseTool(tool, { ...base, ...payload })).toThrow();
      for (const data of [null, false, 0, '', [], { items: [1, '中'] }])
        expect(parseTool(tool, { ...base, topic: 'x', data })).toMatchObject({ data });
      expect(parseTool(tool, { ...base, text: '' })).toMatchObject({ text: '' });
    }
    const { host, controller } = fixture();
    vi.mocked(host.sendWs).mockRejectedValue(new Error('连接已失效'));
    await expect(controller.execute('send_ws_message', { ...base, text: 'one' })).rejects.toThrow('失效');
    expect(host.sendWs).toHaveBeenCalledTimes(1);
  });

  it('cancels before dispatch and forwards cancellation to the runtime queues', async () => {
    const { host, controller } = fixture();
    const abort = new AbortController();
    const args = { connectionId: 'exact', text: 'one' };
    await controller.execute('send_ws_message', args, abort.signal);
    expect(host.sendWs).toHaveBeenCalledWith('exact', 'one', abort.signal);
    abort.abort();
    await expect(controller.execute('inject_ws_message', args, abort.signal)).rejects.toThrow();
    expect(host.injectWs).not.toHaveBeenCalled();
  });

  it('invalid scene file preserves the previous document and does not activate anything', async () => {
    const { host, controller } = fixture();
    vi.mocked(host.reloadScenes).mockRejectedValue(new Error('场景 JSON 无效'));
    expect(await controller.reload()).toMatchObject({ ok: false, loaded: false, error: '场景 JSON 无效' });
    expect(host.activateScene).not.toHaveBeenCalled();
  });
  it('reloads the complete document and exposes scene runtime state', async () => {
    const { host, controller } = fixture();
    expect(await controller.reload()).toMatchObject({ ok: true, loaded: true });
    expect(host.reloadScenes).toHaveBeenCalledOnce();
    expect(controller.status()).toMatchObject({ files: { scenes: host.scenesPath } });
    expect(() => parseTool('reload_rules', { sessionId: 's', domain: 'http' })).toThrow();
    expect(() => parseTool('set_mock_enabled', { sessionId: 's', domain: 'ws', enabled: true })).toThrow();
  });
  it('routes scene activation and capture, and strips session identity from queries', async () => {
    const { host, controller } = fixture();
    await controller.execute(
      'activate_scene',
      parseTool('activate_scene', { sessionId: 's', sceneId: 'mixed' }),
    );
    expect(host.activateScene).toHaveBeenLastCalledWith('mixed');
    await controller.execute('deactivate_scene', { sessionId: 's' });
    expect(host.activateScene).toHaveBeenLastCalledWith(null);
    await controller.execute('list_scenes', { sessionId: 's' });
    expect(host.listScenes).toHaveBeenCalledTimes(3);
    await controller.execute('set_capture_enabled', { domain: 'ws', enabled: false });
    expect(host.setCapture).toHaveBeenCalledWith('ws', false);
    await controller.execute('get_requests', { sessionId: 'private', limit: 20, search: 'orders' });
    expect(host.listHttp).toHaveBeenCalledWith({ limit: 20, search: 'orders' });
  });
});

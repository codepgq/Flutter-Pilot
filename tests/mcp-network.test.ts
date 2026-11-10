import { describe, it, expect, vi } from 'vitest';
import { McpNetworkController, type NetworkHost } from '../src/mcp/network';
import { parseTool } from '../src/mcp/tools';

function fixture() {
  const host: NetworkHost = {
    httpRulesPath: '/project/.api-mocks/rules.json',
    wsRulesPath: '/project/.api-mocks/ws-rules.json',
    readHttpRules: vi.fn(async () => []),
    readWsRules: vi.fn(async () => []),
    applyHttpRules: vi.fn(async () => {}),
    applyWsRules: vi.fn(async () => {}),
    status: () => ({ http: { mockEnabled: false }, ws: { mockEnabled: false } }),
    listHttp: vi.fn(async () => ({ items: [], total: 0 })),
    getHttp: vi.fn(),
    connections: vi.fn(async () => []),
    messages: vi.fn(async () => ({ items: [], total: 0 })),
    setCapture: vi.fn(async () => {}),
    setMock: vi.fn(async () => {}),
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
    expect(host.setMock).not.toHaveBeenCalled();
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

  it('invalid HTTP file preserves previous rules while WS can load independently', async () => {
    const { host, controller } = fixture();
    vi.mocked(host.readHttpRules).mockRejectedValue(new Error('规则 JSON 无效'));
    const result = await controller.reload();
    expect(result.ok).toBe(false);
    expect(result.results.http).toMatchObject({ loaded: false, synchronized: false });
    expect(result.results.ws).toMatchObject({ loaded: true, synchronized: true });
    expect(host.applyHttpRules).not.toHaveBeenCalled();
    expect(host.applyWsRules).toHaveBeenCalledOnce();
    expect(host.setMock).not.toHaveBeenCalled();
    expect(host.setCapture).not.toHaveBeenCalled();
  });
  it('separates accepted configuration from failed runtime synchronization', async () => {
    const { host, controller } = fixture();
    vi.mocked(host.applyHttpRules).mockRejectedValue(new Error('VM 同步失败'));
    expect((await controller.reload('http')).results.http).toMatchObject({
      loaded: true,
      synchronized: false,
    });
    expect(host.readWsRules).not.toHaveBeenCalled();
  });
  it('reports pending application when rules load while VM or Mock is off', async () => {
    const { host, controller } = fixture();
    expect((await controller.reload('http')).results.http).toMatchObject({
      loaded: true,
      runtimeApplied: false,
      pending: true,
    });
    host.status = () => ({ vmConnected: true, http: { mockEnabled: true } });
    expect((await controller.reload('http')).results.http).toMatchObject({
      loaded: true,
      runtimeApplied: true,
      pending: false,
    });
  });
  it('routes explicit switches independently and strips session identity from queries', async () => {
    const { host, controller } = fixture();
    await controller.execute('set_mock_enabled', { domain: 'ws', enabled: true });
    expect(host.setMock).toHaveBeenCalledWith('ws', true);
    expect(host.setCapture).not.toHaveBeenCalled();
    await controller.execute('get_requests', { sessionId: 'private', limit: 20, search: 'orders' });
    expect(host.listHttp).toHaveBeenCalledWith({ limit: 20, search: 'orders' });
    expect(controller.status()).toMatchObject({ files: { http: host.httpRulesPath, ws: host.wsRulesPath } });
  });
});

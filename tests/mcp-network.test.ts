import { describe, it, expect, vi } from 'vitest';
import { McpNetworkController, type NetworkHost } from '../src/mcp/network';

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
  };
  return { host, controller: new McpNetworkController(host) };
}

describe('MCP file-backed network workflow', () => {
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

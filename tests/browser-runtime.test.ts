import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserDependencies } from '../src/browser/dependencies';
import { BrowserController } from '../src/browser/controller';
import { BrowserError, browserMcpTools, browserUrl } from '../src/browser/protocol';
import { matchesHttp, patchRequest, selectHttp, bodySnapshot } from '../src/browser/http';
import { BrowserSockets } from '../src/browser/websocket';
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it('clears browser WS message bodies without closing live sockets and prunes closed connection history', async () => {
  const sockets = new BrowserSockets(() => {});
  sockets.capture = true;
  let route!: (socket: any) => void;
  let outbound!: (message: string | Buffer) => void;
  let inbound!: (message: string | Buffer) => void;
  let close!: (code?: number, reason?: string) => void;
  const server = {
    onMessage: (callback: typeof inbound) => {
      inbound = callback;
    },
    onClose: () => {},
    send: vi.fn(),
    close: vi.fn(),
  };
  const page = {
    routeWebSocket: (_pattern: string, callback: typeof route) => {
      route = callback;
    },
    once: vi.fn(),
  };
  await sockets.install(page as any, 'page', 'runtime', 1);
  const client = {
    url: () => 'wss://example.test/events',
    protocols: () => [],
    connectToServer: () => server,
    onMessage: (callback: typeof outbound) => {
      outbound = callback;
    },
    onClose: (callback: typeof close) => {
      close = callback;
    },
    send: vi.fn(),
    close: vi.fn(),
  };
  route(client);
  inbound('push-1');
  expect(sockets.history({ includeBodies: true } as any)).toMatchObject({
    total: 1,
    items: [{ original: 'push-1', direction: 'inbound' }],
  });
  expect(sockets.clearHistory()).toMatchObject({ ok: true, cleared: 1 });
  expect(sockets.list()).toHaveLength(1);
  expect(sockets.history({} as any).total).toBe(0);
  close(1000, 'done');
  expect(sockets.clearHistory()).toMatchObject({ ok: true, cleared: 0 });
  expect(sockets.list()).toHaveLength(0);
});
it('status and construction never create dependency state or start a Worker', async () => {
  root = await mkdtemp(join(tmpdir(), 'pilot-browser-unit-'));
  const controller = new BrowserController({
    project: { projectId: 'project', workspacePath: root },
    rulesDirectory: join(root, 'scenes'),
    storage: join(root, 'private'),
    resources: join(process.cwd(), 'resources/browser'),
    workerPath: 'missing',
  });
  expect((await controller.status()).running).toBe(false);
  expect(controller.targets()).toEqual([]);
  expect((await controller.status()).dependencies.prepared).toBe(false);
  await expect(controller.execute('create_browser_context', {})).rejects.toMatchObject({
    code: 'BROWSER_NOT_PREPARED',
  });
  await controller.dispose();
});
it('dependency preparation respects already cancelled signals and permits explicit retry', async () => {
  root = await mkdtemp(join(tmpdir(), 'pilot-browser-deps-'));
  const deps = new BrowserDependencies(join(root, 'private'), join(process.cwd(), 'resources/browser'));
  const signal = AbortSignal.abort();
  await expect(deps.prepare(signal)).rejects.toBeDefined();
  await expect(deps.prepare(signal)).rejects.toBeDefined();
  expect((await deps.status()).prepared).toBe(false);
});
it('reports an installed system browser before preparing the private runtime', async () => {
  root = await mkdtemp(join(tmpdir(), 'pilot-browser-system-'));
  const browser = join(root, 'Chrome');
  await writeFile(browser, 'fixture');
  await chmod(browser, 0o755);
  const deps = new BrowserDependencies(join(root, 'private'), join(process.cwd(), 'resources/browser'), {
    systemBrowsers: [browser],
  });
  expect(await deps.status()).toMatchObject({
    prepared: false,
    systemBrowserAvailable: true,
  });
  await deps.dispose();
});
it('distinguishes dependency timeout from a generic browser preparation failure', async () => {
  root = await mkdtemp(join(tmpdir(), 'pilot-browser-timeout-'));
  const deps = new BrowserDependencies(join(root, 'private'), join(process.cwd(), 'resources/browser'), {
    systemBrowsers: [],
    timeoutMs: 20,
  });
  await expect(
    (deps as any).run(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)'],
      root,
      undefined,
      '下载 Chromium',
    ),
  ).rejects.toMatchObject({
    code: 'BROWSER_PREPARE_TIMEOUT',
    message: expect.stringContaining('下载 Chromium超过'),
  });
  await deps.dispose();
});
it('browser schema requires exact Context/Page identity and rejects credentials or executable URLs', () => {
  expect(
    browserMcpTools.navigate_browser_page.schema.safeParse({
      sessionId: 's',
      target: { runtimeId: 'c', generation: 1 },
      url: 'http://localhost',
    }).success,
  ).toBe(false);
  expect(() => browserUrl('javascript:alert(1)')).toThrow();
  expect(() => browserUrl('https://user:password@localhost')).toThrow();
  expect(browserUrl('http://localhost:4173')).toBe('http://localhost:4173/');
});
it('HTTP matching, priority, query duplicates, case-insensitive headers, and original path share rule contracts', () => {
  const req = {
    ...bodySnapshot([['X-Test', 'yes']], Buffer.from('data')),
    url: 'https://example.test/a?q=no&q=yes',
    method: 'POST',
  };
  const rule = {
    id: 'r',
    name: 'r',
    enabled: true,
    priority: 1,
    match: {
      method: 'post',
      host: 'EXAMPLE.test',
      path: '/a',
      query: { q: 'yes' },
      headers: { 'x-test': 'yes' },
    },
    mock: { status: 200, headers: {}, body: 'ok' },
  };
  expect(matchesHttp(rule, req, new Map())).toBe(true);
  expect(selectHttp([rule, { ...rule, id: 'higher', priority: 2 }], req, 'request', new Map())?.id).toBe(
    'higher',
  );
  expect(
    matchesHttp({ ...rule, scenario: { id: 'run', initial: 'empty', when: 'pending' } }, req, new Map()),
  ).toBe(false);
  const changed = patchRequest(
    {
      ...req,
      headers: [
        ['cookie', 'private'],
        ['authorization', 'private'],
      ],
    },
    { ...rule, request: { url: 'https://other.test/next', query: { q: null } } },
  );
  expect(changed.headers).toEqual([]);
  expect(changed.url).toBe('https://other.test/next');
  expect(req.url).toContain('/a?');
});

it.each(['wait_for_widget', 'get_ui_snapshot', 'find_widget', 'take_screenshot', 'tap'])(
  'keeps cancellation ownership appropriate for direct %s calls',
  async (tool) => {
    root = await mkdtemp(join(tmpdir(), 'pilot-browser-cancel-'));
    const controller = new BrowserController({
      project: { projectId: 'project', workspacePath: root },
      rulesDirectory: join(root, 'scenes'),
      storage: join(root, 'private'),
      resources: join(process.cwd(), 'resources/browser'),
      workerPath: 'missing',
    });
    const target = { runtimeId: 'context', generation: 1, pageId: 'page' };
    const context = { state: { ...target, pages: [{ pageId: 'page' }] }, busy: undefined };
    (controller as any).contexts.set(target.runtimeId, context);
    vi.spyOn(controller.worker, 'running', 'get').mockReturnValue(true);
    const request = vi
      .spyOn(controller.worker, 'request')
      .mockRejectedValueOnce(new BrowserError('CANCELLED', 'cancelled before response', true))
      .mockResolvedValue({ ok: true });
    const args = {
      sessionId: 's',
      target,
      ...(['get_ui_snapshot', 'take_screenshot'].includes(tool)
        ? { source: 'web', ...(tool === 'take_screenshot' ? { mode: 'screen' } : {}) }
        : { selector: { source: 'web', testId: 'button' } }),
    };
    try {
      await expect(controller.execute(tool, args)).rejects.toMatchObject({ code: 'CANCELLED' });
      const next = controller.execute('tap', {
        sessionId: 's',
        target,
        selector: { source: 'web', testId: 'button' },
      });
      if (tool === 'tap') {
        await expect(next).rejects.toMatchObject({ code: 'WORKFLOW_BUSY' });
        expect(request).toHaveBeenCalledTimes(1);
      } else {
        await expect(next).resolves.toEqual({ ok: true });
        expect(request).toHaveBeenCalledTimes(2);
      }
    } finally {
      (controller as any).contexts.clear();
      vi.restoreAllMocks();
      await controller.dispose();
    }
  },
);

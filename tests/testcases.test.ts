import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestController, type TestHost, type TestRun } from '../src/testing/controller';
import { validateTestDocument, bindJsonTemplate, bindTestMock, type TestCase } from '../src/testing/model';
import { TestStore } from '../src/testing/store';
import { validateSceneDocument } from '../src/scene-model';
import type { HistoryEntry } from '../src/model';
import type { WsMessage } from '../src/ws/model';
import type { TestMock } from '../src/testing/mock-model';

const controllers: TestController[] = [],
  roots: string[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const scenes = () =>
  validateSceneDocument({
    version: 1,
    activeSceneId: null,
    scenes: [
      {
        id: 'common',
        name: '公共操作',
        httpRules: [],
        wsRules: [],
        targets: {
          price: { key: 'price' },
          quantity: { key: 'quantity' },
          confirm: { key: 'confirm' },
          pending: { key: 'pending' },
          account: { key: 'account' },
          password: { key: 'password' },
        },
        actions: [
          {
            id: 'order',
            name: '提交订单',
            inputs: { price: { required: true }, quantity: { default: '2' }, password: { secret: true } },
            steps: [
              { id: 'price', type: 'enter_text', target: 'price', text: '${inputs.price}' },
              { id: 'quantity', type: 'enter_text', target: 'quantity', text: '${inputs.quantity}' },
              { id: 'confirm', type: 'tap', target: 'confirm' },
            ],
          },
          {
            id: 'login',
            name: '登录',
            inputs: { account: { required: true }, password: { secret: true, default: 'setup-secret' } },
            steps: [
              { id: 'password', type: 'enter_text', target: 'password', text: '${inputs.password}' },
              {
                id: 'account',
                type: 'wait_for_widget',
                target: 'account',
                state: 'text_equals',
                text: '${inputs.account}',
              },
            ],
          },
        ],
      },
    ],
  });
const definition = (): TestCase => ({
  id: 'pending',
  name: '关联本轮订单',
  action: { sceneId: 'common', actionId: 'order' },
  inputs: { price: '100.00', quantity: '2' },
  timeoutMs: 3000,
  expect: {
    http: [
      {
        id: 'submitted',
        match: { method: 'POST', host: 'api.test', path: '/orders' },
        requestJson: { '/price': '${inputs.price}', '/quantity': '${inputs.quantity}' },
        status: 200,
        mocked: true,
        responseJson: { '/code': 'OK' },
        extract: { orderId: '/response/body/data/orderId' },
        timeoutMs: 250,
      },
    ],
    ws: [
      {
        id: 'event',
        url: 'wss://api.test/orders',
        direction: 'inbound',
        outcome: 'synthetic',
        json: { '/orderId': '${vars.orderId}', '/price': '${inputs.price}' },
        timeoutMs: 250,
      },
    ],
    ui: [
      {
        id: 'row',
        selector: { key: 'status', ancestor: { key: 'order-${vars.orderId}' } },
        state: 'text_equals',
        text: 'pending',
        timeoutMs: 250,
      },
    ],
  },
  events: [
    {
      id: 'push',
      after: 'submitted',
      url: 'wss://api.test/orders',
      text: '{"orderId":"${vars.orderId}","price":"${inputs.price}","status":"pending"}',
    },
  ],
});
const snapshot = (value: unknown) => ({
  headers: [] as [string, string][],
  body: JSON.stringify(value),
  bodyEncoding: 'text' as const,
  bodyBytes: 0,
  truncated: false,
  editable: true,
});
function request(id: string, orderId: string, price = '100.00', quantity = '2'): HistoryEntry {
  const originalRequest = {
    ...snapshot({ price, quantity }),
    method: 'POST',
    url: 'https://api.test/orders',
  };
  return {
    id,
    startedAt: Date.now(),
    duration: 1,
    method: 'POST',
    host: 'api.test',
    path: '/orders',
    url: originalRequest.url,
    targetUrl: originalRequest.url,
    originalRequest,
    request: structuredClone(originalRequest),
    response: { ...snapshot({ code: 'OK', data: { orderId } }), status: 200 },
    mocked: true,
    note: '',
    tags: [],
  };
}
function wsMessage(id: string, orderId: string, price = '100.00'): WsMessage & { url: string } {
  return {
    id,
    connectionId: 'socket',
    timestamp: Date.now(),
    url: 'wss://api.test/orders',
    direction: 'inbound',
    kind: 'text',
    original: JSON.stringify({ orderId, price, status: 'pending' }),
    encoding: 'text',
    bytes: 0,
    truncated: false,
    outcome: 'synthetic',
  };
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function fixture(
  test: unknown = definition(),
  options: { noRequest?: boolean; noWs?: boolean; delayWs?: number; waitPending?: boolean } = {},
) {
  let value = test;
  const requests: HistoryEntry[] = [],
    messages: Array<WsMessage & { url?: string }> = [],
    log: string[] = [];
  const form: Record<string, string> = {};
  let account = '';
  let owner = '';
  const flows = scenes();
  if (options.waitPending)
    flows.scenes[0].actions![0].steps.push({
      id: 'pending',
      type: 'wait_for_widget',
      target: 'pending',
      state: 'present',
      timeoutMs: 1000,
    });
  const host: TestHost = {
    acquire: vi.fn(async (id) => {
      owner = id;
      log.push('acquire');
    }),
    release: vi.fn(async () => {
      log.push('release');
    }),
    changed: vi.fn(),
    loadScenes: vi.fn(async () => flows),
    prepare: vi.fn(async () => {
      log.push('prepare');
    }),
    cleanup: vi.fn(async () => {
      log.push('cleanup');
    }),
    baseline: vi.fn(async () => {
      log.push('baseline');
      return {
        at: Date.now(),
        httpIds: requests.map((item) => item.id),
        wsIds: messages.map((item) => item.id),
      };
    }),
    http: vi.fn(async () => [...requests]),
    ws: vi.fn(async () => [...messages]),
    injectWs: vi.fn(async (_url, text) => {
      log.push('inject');
      const data = JSON.parse(text);
      const publish = () =>
        messages.push({ ...wsMessage(`ws-${owner}`, data.orderId, data.price), original: text });
      if (!options.noWs) {
        if (options.delayWs) setTimeout(publish, options.delayWs);
        else publish();
      }
      return { connectionId: 'socket' };
    }),
    execute: vi.fn(async (id, tool, args, signal) => {
      const selector = args.selector as { key?: string; ancestor?: { key: string } };
      log.push(`${tool}:${selector.key}`);
      if (tool === 'enter_text') {
        form[selector.key!] = args.text as string;
        return { ok: true };
      }
      if (tool === 'tap' && selector.key === 'confirm') {
        if (!options.noRequest) requests.push(request(`req-${id}`, id, form.price, form.quantity));
        return { ok: true };
      }
      if (selector.key === 'account') return { ok: args.text === account, code: 'WAIT_TIMEOUT' };
      if (selector.key === 'pending') {
        for (let index = 0; index < 50; index++) {
          if (messages.some((item) => JSON.parse(item.original).orderId === id)) return { ok: true };
          if (signal.aborted) return { ok: false, code: 'CANCELLED' };
          await pause(10);
        }
        return { ok: false, code: 'WAIT_TIMEOUT' };
      }
      if (selector.key === 'status')
        return {
          ok:
            selector.ancestor?.key === `order-${id}` &&
            messages.some((item) => JSON.parse(item.original).orderId === id),
          code: 'WAIT_TIMEOUT',
        };
      return { ok: true };
    }),
  };
  const controller = new TestController(
    {
      directory: '',
      file: 'tests.json',
      read: async () => validateTestDocument({ version: 2, tests: [value] }),
    } as TestStore,
    host,
  );
  controllers.push(controller);
  return {
    controller,
    host,
    flows,
    requests,
    messages,
    log,
    form,
    setTest: (test: unknown) => {
      value = test;
    },
    setAccount: (value: string) => {
      account = value;
    },
  };
}
async function terminal(controller: TestController, runId: string): Promise<TestRun> {
  await controller.waitForIdle();
  return controller.get(runId).run;
}

describe('test case execution and network correlation', () => {
  it('keeps the Mock environment independent from the Scene that defines the operation', async () => {
    const test = definition();
    test.sceneId = 'insufficient_balance';
    const { controller, host, flows } = await fixture(test);
    flows.scenes.push({
      id: 'insufficient_balance',
      name: '余额不足',
      httpRules: [],
      wsRules: [],
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('passed');
    expect(run.action).toEqual({ sceneId: 'common', actionId: 'order' });
    expect(run.sceneId).toBe('insufficient_balance');
    expect(run.mockSceneId).toBe('insufficient_balance');
    expect(host.prepare).toHaveBeenCalledWith(run.runId, 'insufficient_balance', undefined, {
      http: true,
      ws: true,
    });
    expect(run.steps.every((step) => step.sceneId === 'common')).toBe(true);
  });
  it('leaves the current Mock selection to the host when no environment is specified', async () => {
    const { controller, host } = await fixture();
    host.mockSceneId = () => 'currently-active';
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('passed');
    expect(run.mockSceneId).toBe('currently-active');
    expect(host.prepare).toHaveBeenCalledWith(run.runId, undefined, undefined, { http: true, ws: true });
    expect(run.sceneId).toBeUndefined();
  });
  it('observes before confirm, extracts the actual order and validates its exact row', async () => {
    const { controller, host, log } = await fixture(definition(), { waitPending: true });
    const result = await controller.start('pending');
    const run = await terminal(controller, result.runId);
    expect(run.status).toBe('passed');
    expect(run.vars.orderId).toBe(result.runId);
    expect(run.assertions.map((v) => v.status)).toEqual(['passed', 'passed', 'passed']);
    expect(run.steps).toHaveLength(4);
    expect(run.steps.every((step) => step.status === 'completed')).toBe(true);
    expect(run.assertions[0].evidence).toEqual({ httpId: `req-${result.runId}` });
    expect(log.indexOf('baseline')).toBeLessThan(log.indexOf('tap:confirm'));
    expect(log.indexOf('inject')).toBeGreaterThan(log.indexOf('tap:confirm'));
    expect(host.injectWs).toHaveBeenCalledTimes(1);
    expect(log.slice(-2)).toEqual(['cleanup', 'release']);
  });
  it('asserts original App parameters rather than patched request parameters and never injects on mismatch', async () => {
    const { controller, host, requests } = await fixture();
    vi.mocked(host.http).mockImplementation(async () =>
      requests.map((entry) => ({
        ...entry,
        originalRequest: { ...entry.originalRequest, body: '{"price":"WRONG","quantity":"2"}' },
      })),
    );
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('failed');
    expect(run.failure?.code).toBe('ASSERTION_FAILED');
    expect(run.assertions[0].status).toBe('failed');
    expect(host.injectWs).not.toHaveBeenCalled();
  });
  it('can assert the original request even when an automatic rule rewrites it', async () => {
    const { controller, host, requests } = await fixture();
    vi.mocked(host.http).mockImplementation(async () =>
      requests.map((entry) => ({
        ...entry,
        request: { ...entry.request, body: '{"price":"999","quantity":"9"}' },
      })),
    );
    expect((await terminal(controller, (await controller.start('pending')).runId)).status).toBe('passed');
  });
  it('rejects old HTTP and WS records even if the host returns them', async () => {
    const { controller, host, requests, messages } = await fixture(definition(), { noRequest: true });
    requests.push(request('old-request', 'old-order'));
    messages.push(wsMessage('old-ws', 'old-order'));
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('failed');
    expect(run.failure?.code).toBe('ASSERTION_TIMEOUT');
    expect(host.injectWs).not.toHaveBeenCalled();
  });
  it('runs twice with fresh baselines and never reuses the prior order or events', async () => {
    const { controller, host } = await fixture();
    const first = await terminal(controller, (await controller.start('pending')).runId);
    const second = await terminal(controller, (await controller.start('pending')).runId);
    expect([first.status, second.status]).toEqual(['passed', 'passed']);
    expect(first.vars.orderId).not.toBe(second.vars.orderId);
    expect(second.assertions[0].evidence?.httpId).toBe(`req-${second.runId}`);
    expect(host.injectWs).toHaveBeenCalledTimes(2);
  });
  it('fails ambiguous matching requests rather than selecting an arbitrary one', async () => {
    const { controller, host, requests } = await fixture();
    vi.mocked(host.http).mockImplementation(async () =>
      requests.flatMap((entry) => [entry, { ...entry, id: 'duplicate' }]),
    );
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.failure?.code).toBe('AMBIGUOUS_HTTP');
    expect(host.injectWs).not.toHaveBeenCalled();
  });
  it('keeps watching for duplicate submission while UI assertions are still running', async () => {
    const test = definition();
    test.expect.ui![0].stableForMs = 180;
    const { controller, host, requests } = await fixture(test);
    const base = vi.mocked(host.injectWs).getMockImplementation()!;
    vi.mocked(host.injectWs).mockImplementation(async (url, text, signal) => {
      const result = await base(url, text, signal);
      setTimeout(() => requests.push({ ...requests[0], id: 'late-duplicate' }), 80);
      return result;
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('failed');
    expect(run.failure?.code).toBe('AMBIGUOUS_HTTP');
    expect(host.injectWs).toHaveBeenCalledTimes(1);
  });
  it('rejects a duplicate submission even when its response is still pending', async () => {
    const { controller, host, requests } = await fixture();
    vi.mocked(host.http).mockImplementation(async () =>
      requests.flatMap((entry) => [entry, { ...entry, id: 'pending-duplicate', response: undefined }]),
    );
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('failed');
    expect(run.failure?.code).toBe('AMBIGUOUS_HTTP');
    expect(host.injectWs).not.toHaveBeenCalled();
  });
  it('accepts a specified business rejection carried in HTTP 200', async () => {
    const test = definition();
    test.events = [];
    test.expect.ws = [];
    test.expect.ui = [];
    test.expect.http![0].responseJson = { '/code': 'INSUFFICIENT_BALANCE' };
    delete test.expect.http![0].extract;
    const { controller, host, requests } = await fixture(test);
    vi.mocked(host.http).mockImplementation(async () =>
      requests.map((entry) => ({
        ...entry,
        response: { ...snapshot({ code: 'INSUFFICIENT_BALANCE' }), status: 200 },
      })),
    );
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('passed');
    expect(host.injectWs).not.toHaveBeenCalled();
  });
  it('waits for delayed associated WS delivery while the main workflow waits for UI', async () => {
    const { controller } = await fixture(definition(), { delayWs: 70, waitPending: true });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('passed');
    expect(run.events[0].status).toBe('sent');
  });
  it('fails a missing push and does not infer delivery from an accepted injection call', async () => {
    const { controller, host } = await fixture(definition(), { noWs: true });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('failed');
    expect(run.assertions.find((v) => v.kind === 'ws')?.status).toBe('failed');
    expect(host.injectWs).toHaveBeenCalledTimes(1);
  });
  it('runs setup through the same kernel and verifies the target account before submitting', async () => {
    const test = definition();
    test.setup = [{ action: { sceneId: 'common', actionId: 'login' }, inputs: { account: 'expected-user' } }];
    const { controller, host, log, setAccount } = await fixture(test);
    setAccount('other-user');
    const failed = await terminal(controller, (await controller.start('pending')).runId);
    expect(failed.status).toBe('error');
    expect(log).not.toContain('baseline');
    expect(log).not.toContain('tap:confirm');
    setAccount('expected-user');
    const passed = await terminal(controller, (await controller.start('pending')).runId);
    expect(passed.status).toBe('passed');
    expect(host.execute).toHaveBeenCalledWith(
      expect.any(String),
      'enter_text',
      expect.objectContaining({ text: 'setup-secret' }),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(passed)).not.toContain('setup-secret');
  });
  it('uses explicit setup input mappings across Scenes and one configuration snapshot', async () => {
    const test = definition();
    test.setup = [
      {
        action: { sceneId: 'authentication', actionId: 'login' },
        inputs: { account: '${inputs.price}' },
      },
    ];
    const { controller, host, flows, setAccount, log } = await fixture(test);
    const shared = flows.scenes[0];
    const login = shared.actions!.splice(1, 1)[0];
    flows.scenes.push({
      id: 'authentication',
      name: '登录操作',
      httpRules: [],
      wsRules: [],
      targets: { account: shared.targets!.account, password: shared.targets!.password },
      actions: [login],
    });
    setAccount('100.00');
    vi.mocked(host.prepare).mockImplementation(async () => {
      log.push('prepare');
      shared.actions![0].steps = [{ id: 'unexpected', type: 'tap', target: 'account' }];
      login.steps = [{ id: 'unexpected', type: 'tap', target: 'account' }];
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('passed');
    expect(host.loadScenes).toHaveBeenCalledTimes(1);
    expect(run.steps.map((step) => step.sceneId)).toEqual([
      'authentication',
      'authentication',
      'common',
      'common',
      'common',
    ]);
    expect(log).toContain('wait_for_widget:account');
    expect(log).toContain('tap:confirm');
    expect(log).not.toContain('tap:account');
  });
  it('waits for setup-created connections before establishing the main baseline', async () => {
    const test = definition();
    test.setup = [{ action: { sceneId: 'common', actionId: 'login' }, inputs: { account: 'expected-user' } }];
    const { controller, host, log, setAccount } = await fixture(test);
    setAccount('expected-user');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.ready = vi.fn(async (_id, signal) => {
      log.push('ready');
      expect(signal.aborted).toBe(false);
      await gate;
      log.push('ready-complete');
    });
    const { runId } = await controller.start('pending');
    await vi.waitFor(() => expect(log).toContain('ready'));
    expect(log).toContain('wait_for_widget:account');
    expect(log).not.toContain('baseline');
    expect(log).not.toContain('enter_text:price');
    release();
    expect((await terminal(controller, runId)).status).toBe('passed');
    expect(log.indexOf('wait_for_widget:account')).toBeLessThan(log.indexOf('ready'));
    expect(log.indexOf('ready-complete')).toBeLessThan(log.indexOf('baseline'));
    expect(log.indexOf('baseline')).toBeLessThan(log.indexOf('enter_text:price'));
  });
  it('cleans up when post-setup readiness fails without executing the main workflow', async () => {
    const test = definition();
    test.setup = [{ action: { sceneId: 'common', actionId: 'login' }, inputs: { account: 'expected-user' } }];
    const { controller, host, log, setAccount } = await fixture(test);
    setAccount('expected-user');
    host.ready = vi.fn(async () => {
      throw new Error('WS connection not attached');
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('error');
    expect(host.baseline).not.toHaveBeenCalled();
    expect(log).not.toContain('enter_text:price');
    expect(log).not.toContain('tap:confirm');
    expect(log.slice(-2)).toEqual(['cleanup', 'release']);
  });
  it('cancels a pending readiness wait and never proceeds to the main baseline', async () => {
    const { controller, host, log } = await fixture();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    host.ready = vi.fn(async (_id, signal) => {
      entered();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const { runId } = await controller.start('pending');
    await waiting;
    controller.cancel(runId);
    const run = await terminal(controller, runId);
    expect(run.status).toBe('cancelled');
    expect(host.baseline).not.toHaveBeenCalled();
    expect(log).not.toContain('enter_text:price');
    expect(log).not.toContain('tap:confirm');
    expect(log.slice(-2)).toEqual(['cleanup', 'release']);
  });
  it('requires an absence observation window so a brief missing row cannot pass', async () => {
    const test = definition();
    test.events = [];
    test.expect.http = [];
    test.expect.ws = [];
    test.expect.ui = [
      { id: 'gone', selector: { key: 'missing' }, state: 'absent', timeoutMs: 180, stableForMs: 100 },
    ];
    const { controller, host } = await fixture(test);
    let calls = 0;
    vi.mocked(host.execute).mockImplementation(async (_id, tool) =>
      tool === 'wait_for_widget' ? { ok: ++calls === 1, code: 'WAIT_TIMEOUT' } : { ok: true },
    );
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('failed');
    expect(calls).toBeGreaterThan(1);
  });
});

describe('test cancellation, failures and cleanup', () => {
  it('cancels an in-flight confirm once, reports uncertainty and releases after the action settles', async () => {
    const { controller, host, log } = await fixture();
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(host.execute).mockImplementation(async (_owner, tool, _args, signal) => {
      if (tool !== 'tap') return { ok: true };
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () =>
            setTimeout(() => {
              log.push('confirm-settled');
              resolve();
            }, 20),
          { once: true },
        ),
      );
      return { ok: true };
    });
    const result = await controller.start('pending');
    await entering;
    expect(controller.cancel(result.runId).cancelRequested).toBe(true);
    expect(controller.get(result.runId).run.status).toBe('running');
    const run = await terminal(controller, result.runId);
    expect(run.status).toBe('uncertain');
    expect(vi.mocked(host.execute).mock.calls.filter((call) => call[1] === 'tap')).toHaveLength(1);
    expect(log.indexOf('confirm-settled')).toBeLessThan(log.indexOf('cleanup'));
    expect(log.slice(-2)).toEqual(['cleanup', 'release']);
    expect(host.injectWs).not.toHaveBeenCalled();
  });
  it('times out in-flight confirmation without a replay', async () => {
    const test = definition();
    test.timeoutMs = 100;
    const { controller, host } = await fixture(test);
    vi.mocked(host.execute).mockImplementation(async (_owner, tool, _args, signal) => {
      if (tool === 'tap')
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      return { ok: true };
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('uncertain');
    expect(run.failure?.code).toBe('TEST_TIMEOUT');
    expect(vi.mocked(host.execute).mock.calls.filter((call) => call[1] === 'tap')).toHaveLength(1);
  });
  it('retains uncertainty when a failed assertion cancels an already dispatched confirmation', async () => {
    const { controller, host, requests } = await fixture();
    const base = vi.mocked(host.execute).getMockImplementation()!;
    vi.mocked(host.execute).mockImplementation(async (owner, tool, args, signal) => {
      if (tool !== 'tap') return base(owner, tool, args, signal);
      requests.push(request('wrong', owner, 'wrong-price'));
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { ok: true };
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('uncertain');
    expect(run.failure).toMatchObject({ code: 'ASSERTION_FAILED', uncertain: true });
    expect(run.steps.find((step) => step.tool === 'tap')?.status).toBe('uncertain');
    expect(host.injectWs).not.toHaveBeenCalled();
  });
  it('attempts cleanup after partial prepare failure and performs no workflow action', async () => {
    const { controller, host, log } = await fixture();
    vi.mocked(host.prepare).mockImplementation(async () => {
      log.push('prepare');
      throw new Error('connection lost');
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('error');
    expect(host.execute).not.toHaveBeenCalled();
    expect(log).toEqual(['acquire', 'prepare', 'cleanup', 'release']);
  });
  it('cannot pass when cleanup fails, and still releases ownership', async () => {
    const { controller, host, log } = await fixture();
    vi.mocked(host.cleanup).mockImplementation(async () => {
      log.push('cleanup');
      throw new Error('cleanup failed');
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('error');
    expect(run.failure?.code).toBe('TEST_CLEANUP_FAILED');
    expect(log.slice(-2)).toEqual(['cleanup', 'release']);
  });
  it('marks an unconfirmed WS injection uncertain and never attempts it again', async () => {
    const { controller, host } = await fixture();
    vi.mocked(host.injectWs).mockRejectedValue(new Error('socket lost after dispatch'));
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('uncertain');
    expect(run.events[0].status).toBe('uncertain');
    expect(host.injectWs).toHaveBeenCalledTimes(1);
  });
  it('captures bounded redacted failure evidence without replacing the failed request', async () => {
    const test = definition();
    test.inputs!.password = 'private-value';
    const { controller, host, requests } = await fixture(test);
    const base = vi.mocked(host.execute).getMockImplementation()!;
    vi.mocked(host.http).mockImplementation(async () =>
      requests.map((entry) => ({
        ...entry,
        originalRequest: { ...entry.originalRequest, body: '{"price":"wrong"}' },
      })),
    );
    vi.mocked(host.execute).mockImplementation(async (owner, tool, args, signal) => {
      if (tool === 'get_ui_snapshot')
        return {
          ok: true,
          widgets: Array.from({ length: 50 }, () => ({
            ref: 'r',
            text: `private-value${'x'.repeat(1000)}`,
            enabled: true,
            screenshot: 'binary',
            headers: { Authorization: 'unrelated-secret' },
          })),
        };
      return base(owner, tool, args, signal);
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.failure?.code).toBe('ASSERTION_FAILED');
    expect(run.assertions[0].evidence?.httpId).toBe(`req-${run.runId}`);
    expect(run.evidence?.ui).toHaveLength(20);
    expect((run.evidence!.ui[0].text as string).length).toBe(512);
    expect(JSON.stringify(run)).not.toContain('private-value');
    expect(run.evidence!.ui[0]).not.toHaveProperty('screenshot');
    expect(run.cleanup.status).toBe('completed');
  });
  it('can cancel before preparation dispatches any workflow operation', async () => {
    const { controller, host } = await fixture();
    let entered!: () => void, resume!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(host.prepare).mockImplementation(async () => {
      entered();
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
    });
    const result = await controller.start('pending');
    await entering;
    controller.cancel(result.runId);
    resume();
    const run = await terminal(controller, result.runId);
    expect(run.status).toBe('cancelled');
    expect(run.failure?.uncertain).toBe(false);
    expect(host.execute).not.toHaveBeenCalled();
    expect(host.cleanup).toHaveBeenCalledTimes(1);
  });
  it('reserves ownership through cleanup and rejects overlapping starts', async () => {
    const { controller, host } = await fixture();
    let cleanup!: () => void;
    const inCleanup = new Promise<void>((resolve) => {
      cleanup = resolve;
    });
    let resume!: () => void;
    vi.mocked(host.cleanup).mockImplementation(async () => {
      cleanup();
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
    });
    const result = await controller.start('pending');
    await inCleanup;
    expect(controller.get(result.runId).run.status).toBe('running');
    await expect(controller.start('pending')).rejects.toMatchObject({ code: 'TEST_BUSY' });
    expect(host.release).not.toHaveBeenCalled();
    resume();
    expect((await terminal(controller, result.runId)).status).toBe('passed');
  });
});

describe('test preflight and safe definitions', () => {
  it.each([
    { version: 1, tests: [{ ...definition(), workflowId: 'order' }] },
    { version: 2, tests: [{ ...definition(), workflowId: 'order' }] },
    { version: 2, tests: [{ ...definition(), setup: [{ workflowId: 'login' }] }] },
  ])('rejects old Workflow references with a specific format error', (document) => {
    expect(() => validateTestDocument(document)).toThrow(/version: 2.*action.*sceneId.*actionId/);
  });
  it.each([
    (test: TestCase) => {
      test.expect = {};
    },
    (test: TestCase) => {
      test.expect.http![0].match = { host: '' };
    },
    (test: TestCase) => {
      test.expect.http![0].match = { path: '' };
    },
    (test: TestCase) => {
      test.events![0].after = 'missing';
    },
    (test: TestCase) => {
      test.expect.ui![0].selector = { ref: 'stale' };
    },
    (test: TestCase) => {
      test.expect.ui![0].text = '${vars.unknown}';
    },
    (test: TestCase) => {
      test.events![0].text = '{"orderId":${vars.orderId}}';
    },
    (test: TestCase) => {
      test.inputs!.price = '${vars.orderId}';
    },
    (test: TestCase) => {
      test.expect.http![0].requestJson = { '/price': '${process.exit()}' };
    },
    (test: TestCase) => {
      test.action.actionId = 'missing';
    },
    (test: TestCase) => {
      test.action.sceneId = 'missing';
    },
    (test: TestCase) => {
      test.setup = [{ action: { sceneId: 'common', actionId: 'missing' } }];
    },
    (test: TestCase) => {
      test.setup = [{ action: { sceneId: 'common', actionId: 'login' } }];
    },
    (test: TestCase) => {
      test.events![0].url = 'wss://';
    },
    (test: TestCase) => {
      test.expect.http![0].requestJson = { '/price': '${inputs.password}' };
    },
    (test: TestCase) => {
      test.events![0].text = '{"${vars.orderId}":"value"}';
    },
    (test: TestCase) => {
      test.inputs = { price: '${inputs.quantity}', quantity: '${inputs.price}' };
    },
  ])('rejects invalid configuration before acquiring or preparing', async (change) => {
    const test = definition();
    change(test);
    const { controller, host } = await fixture(test);
    await expect(controller.start('pending')).rejects.toThrow();
    expect(host.acquire).not.toHaveBeenCalled();
    expect(host.prepare).not.toHaveBeenCalled();
  });
  it('substitutes JSON string values safely without interpreting replacement templates', async () => {
    const input = 'quoted"\\line\n${vars.unknown}';
    expect(JSON.parse(bindJsonTemplate('{"value":"${inputs.value}"}', { value: input }, 'run')).value).toBe(
      input,
    );
    const mock: TestMock = {
      initialState: 'empty',
      states: [
        {
          id: 'empty',
          httpRules: [
            {
              id: 'blank',
              name: 'blank',
              enabled: true,
              priority: 0,
              match: { path: '/blank' },
              mock: { status: 200, headers: {}, body: '' },
            },
            {
              id: 'json',
              name: 'json',
              enabled: true,
              priority: 0,
              match: { path: '/json' },
              mock: { status: 200, headers: {}, body: '{"value":"${inputs.value}"}' },
            },
          ],
        },
      ],
    };
    const bound = bindTestMock(mock, { value: input }, 'run')!;
    expect(bound.states[0].httpRules[0].mock!.body).toBe('');
    expect(JSON.parse(bound.states[0].httpRules[1].mock!.body).value).toBe(input);
  });
  it('preserves decimal strings and quote escaping through the entire observed event', async () => {
    const test = definition();
    test.inputs!.price = '0.000000000123456789"\\';
    const { controller, host } = await fixture(test);
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('passed');
    const event = JSON.parse(vi.mocked(host.injectWs).mock.calls[0][1]);
    expect(event.price).toBe(test.inputs!.price);
  });
  it('resolves test input dependencies once while treating supplied strings as literal data', async () => {
    const test = definition();
    test.inputs!.price = '${inputs.quantity}';
    test.inputs!.quantity = '${run.id}';
    const { controller } = await fixture(test);
    const first = await terminal(controller, (await controller.start('pending')).runId);
    expect(first.status).toBe('passed');
    expect(first.inputs.price).toBe(first.runId);
    const literal = '${vars.notAnExpression}"\\';
    const second = await terminal(controller, (await controller.start('pending', { price: literal })).runId);
    expect(second.status).toBe('passed');
    expect(second.inputs.price).toBe(literal);
  });
  it('redacts declared secrets in run inputs, extracted variables and failure messages', async () => {
    const test = definition();
    test.inputs!.password = 'very-secret"\\';
    test.expect.http![0].extract!.copy = '/response/body/copied';
    const { controller, host, requests } = await fixture(test);
    vi.mocked(host.http).mockImplementation(async () =>
      requests.map((entry) => ({
        ...entry,
        response: {
          ...snapshot({ code: 'OK', data: { orderId: entry.id.slice(4) }, copied: 'very-secret"\\' }),
          status: 200,
        },
      })),
    );
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('passed');
    expect(run.inputs.password).toBe('[REDACTED]');
    expect(run.vars.copy).toBe('[REDACTED]');
    expect(JSON.stringify(run)).not.toContain('very-secret');
  });
  it('redacts test-level secrets throughout nested Scene failure diagnostics', async () => {
    const test = definition();
    test.inputs!.password = 'outer-private-value';
    const { controller, host, flows } = await fixture(test);
    flows.scenes[0].actions![0].inputs!.password.secret = false;
    flows.scenes[0].actions![0].steps = [
      { id: 'ready', type: 'wait_for_widget', target: 'pending', state: 'visible' },
    ];
    vi.mocked(host.execute).mockResolvedValue({
      ok: false,
      code: 'WAIT_TIMEOUT',
      message: 'outer-private-value was not found',
      diagnostics: {
        selector: { key: 'outer-private-value' },
        condition: 'visible',
        timeoutMs: 100,
        attempts: 2,
        lastObservation: { code: 'NOT_FOUND', message: 'missing outer-private-value', present: false },
      },
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.steps[0].failure?.diagnostics).toMatchObject({
      selector: { key: '[REDACTED]' },
      lastObservation: { message: 'missing [REDACTED]' },
    });
    expect(JSON.stringify(run)).not.toContain('outer-private-value');
  });
  it('redacts secrets nested in extracted response objects from failure evidence', async () => {
    const test = definition();
    test.expect.http![0].extract!.payload = '/response/body/payload';
    const { controller, host, requests } = await fixture(test);
    const base = vi.mocked(host.execute).getMockImplementation()!;
    vi.mocked(host.http).mockImplementation(async () =>
      requests.map((entry) => ({
        ...entry,
        response: {
          ...snapshot({
            code: 'OK',
            data: { orderId: entry.id.slice(4) },
            payload: {
              credentials: { token: 'nested-access-value' },
              headers: [['Authorization', 'Bearer nested-header-value']],
            },
          }),
          status: 200,
        },
      })),
    );
    vi.mocked(host.execute).mockImplementation(async (owner, tool, args, signal) => {
      if (tool === 'get_ui_snapshot')
        return {
          ok: true,
          widgets: [{ text: 'nested-access-value Bearer nested-header-value' }],
        };
      if (tool === 'wait_for_widget' && (args.selector as { key?: string }).key === 'status')
        return { ok: false, code: 'NOT_FOUND' };
      return base(owner, tool, args, signal);
    });
    const run = await terminal(controller, (await controller.start('pending')).runId);
    expect(run.status).toBe('failed');
    expect(run.vars.payload).toEqual({
      credentials: { token: '[REDACTED]' },
      headers: [['Authorization', '[REDACTED]']],
    });
    expect(run.evidence?.ui[0].text).toBe('[REDACTED] [REDACTED]');
    expect(JSON.stringify(run)).not.toContain('nested-access-value');
    expect(JSON.stringify(run)).not.toContain('nested-header-value');
  });
  it('keeps definition reads side-effect free and rejects symlink files/directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-tests-'));
    roots.push(root);
    const missing = new TestStore(join(root, 'missing'));
    expect(await missing.read()).toEqual({ version: 2, tests: [] });
    const directory = join(root, 'project');
    await mkdir(directory);
    const store = new TestStore(directory);
    await writeFile(store.file, JSON.stringify({ version: 2, tests: [definition()] }));
    expect((await store.read()).tests).toHaveLength(1);
    await symlink(store.file, join(directory, 'link.json'));
    await rm(store.file);
    await symlink(join(directory, 'link.json'), store.file);
    await expect(store.read()).rejects.toMatchObject({ code: 'INVALID_TEST_FILE' });
    await symlink(directory, join(root, 'linked'));
    await expect(new TestStore(join(root, 'linked')).read()).rejects.toMatchObject({
      code: 'INVALID_TEST_FILE',
    });
  });
});

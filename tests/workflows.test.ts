import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowController, type WorkflowHost } from '../src/workflows/controller';
import { compileSceneAction } from '../src/workflows/model';
import { validateSceneDocument, type SceneDocument } from '../src/scene-model';
import type { UiResult } from '../src/vm/ui';

const controllers: WorkflowController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
});
const order = () => ({
  id: 'submit_order',
  name: '提交订单',
  inputs: { price: { required: true }, quantity: { default: '2' } },
  targets: {
    price: { key: 'price' },
    quantity: { key: 42 },
    submit: { key: 'submit' },
    confirm: { key: 'confirm', ancestor: { key: 'dialog' } },
  },
  steps: [
    { id: 'price', type: 'enter_text', target: 'price', text: '${inputs.price}' },
    { id: 'quantity', type: 'enter_text', target: 'quantity', text: '${inputs.quantity}' },
    { id: 'submit', type: 'tap', target: 'submit' },
    { id: 'wait', type: 'wait_for_widget', target: 'confirm', state: 'actionable', timeoutMs: 5000 },
    { id: 'confirm', type: 'tap', target: 'confirm' },
  ],
});
const doc = (...values: unknown[]) => {
  const targets = Object.assign({}, ...values.map((value: any) => value.targets ?? {}));
  const actions = values.map((value: any) => {
    const { targets: _targets, ...action } = value;
    return action;
  });
  return {
    version: 1,
    activeSceneId: null,
    scenes: [{ id: 'orders', name: '订单', httpRules: [], wsRules: [], targets, actions }],
  };
};
const scene = (id: string, values: Partial<SceneDocument['scenes'][number]> = {}) => ({
  id,
  name: id,
  httpRules: [],
  wsRules: [],
  ...values,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(value: unknown = doc(order()), execute?: WorkflowHost['execute']) {
  let loaded = validateSceneDocument(value);
  const store = { read: async () => loaded };
  const host: WorkflowHost = {
    acquire: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    changed: vi.fn(),
    mockSceneId: vi.fn(() => null),
    execute: vi.fn(
      execute ?? (async () => ({ ok: true, backend: 'flutter', timings: { resolveMs: 2, inputMs: 3 } })),
    ),
  };
  const controller = new WorkflowController(store, host);
  controllers.push(controller);
  return {
    store,
    host,
    controller,
    reload: (next: unknown) => {
      loaded = validateSceneDocument(next);
    },
    loaded: () => loaded,
  };
}
async function terminal(controller: WorkflowController, runId: string) {
  for (let i = 0; i < 100; i++) {
    const result = controller.get(runId).run;
    if (result.status !== 'running') return result;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Run did not settle');
}

describe('Scene action compilation', () => {
  it.each(['auto', 'flutter', 'device'] as const)(
    'compiles target-free keyboard dismissal with the %s execution backend',
    (backend) => {
      const flow = {
        id: 'dismiss',
        name: '收起键盘',
        targets: { unused: { key: '${inputs.unrelated}' } },
        steps: [{ id: 'hide', type: 'hide_keyboard', timeoutMs: 4000 }],
      };
      const result = compileSceneAction(validateSceneDocument(doc(flow)), 'orders', 'dismiss', {}, backend);
      expect(result.steps).toEqual([
        {
          id: 'hide',
          path: 'orders/dismiss/hide',
          sceneId: 'orders',
          actionId: 'dismiss',
          tool: 'hide_keyboard',
          args: { backend, timeoutMs: 4000 },
        },
      ]);
      expect(() =>
        validateSceneDocument(
          doc({ ...flow, steps: [{ id: 'hide', type: 'hide_keyboard', target: 'unused' }] }),
        ),
      ).toThrow(/配置格式无效/);
    },
  );
  it('uses normalized action names without modifying the source definitions', () => {
    const original = doc({ ...order(), name: `${' '.repeat(300)}提交订单${' '.repeat(300)}` });
    const rawName = original.scenes[0].actions[0].name;
    const loaded = validateSceneDocument(original);
    expect(loaded.scenes[0].actions![0].name).toBe('提交订单');
    expect(
      compileSceneAction(original as SceneDocument, 'orders', 'submit_order', { price: '1' }).action.name,
    ).toBe('提交订单');
    expect(original.scenes[0].actions[0].name).toBe(rawName);
    expect(() => validateSceneDocument(doc({ ...order(), name: ` ${'名'.repeat(257)} ` }))).toThrow(
      /配置格式无效/,
    );
  });
  it('accepts existing pure Mock Scenes and targets-only Scenes with unused input templates', () => {
    const value = validateSceneDocument({
      version: 1,
      activeSceneId: null,
      scenes: [scene('mock'), scene('targets', { targets: { row: { key: 'row-${inputs.id}' } } })],
    });
    expect(value.scenes[0]).not.toHaveProperty('actions');
    expect(value.scenes[1].targets?.row).toEqual({ key: 'row-${inputs.id}' });
    expect(() => compileSceneAction(value, 'mock', 'missing')).toThrow(/操作不存在/);
  });
  it('binds only the targets used by each action in a Scene', () => {
    const value = validateSceneDocument({
      version: 1,
      activeSceneId: null,
      scenes: [
        scene('shared', {
          targets: {
            price: { key: 'price-${inputs.price}' },
            account: { key: 'account-${inputs.account}' },
            saved: { key: '${inputs.future}' },
            submit: { key: 'submit' },
          },
          actions: [
            {
              id: 'order',
              name: '订单',
              inputs: { price: { required: true } },
              steps: [
                { id: 'price', type: 'enter_text', target: 'price', text: '${inputs.price}' },
                { id: 'submit', type: 'tap', target: 'submit' },
              ],
            },
            {
              id: 'account',
              name: '账号',
              inputs: { account: { required: true } },
              steps: [{ id: 'account', type: 'tap', target: 'account' }],
            },
          ],
        }),
      ],
    });
    expect(compileSceneAction(value, 'shared', 'order', { price: '1' }).steps[0].args).toMatchObject({
      selector: { key: 'price-1' },
      text: '1',
    });
    expect(compileSceneAction(value, 'shared', 'account', { account: 'alice' }).steps[0].args).toMatchObject({
      selector: { key: 'account-alice' },
    });
  });
  it('compiles typed stable selectors, exact decimal strings and bounded waits', () => {
    const result = compileSceneAction(
      validateSceneDocument(doc(order())),
      'orders',
      'submit_order',
      { price: '0.000000000123456789' },
      'flutter',
    );
    expect(result.steps).toHaveLength(5);
    expect(result.steps[0]).toMatchObject({
      path: 'orders/submit_order/price',
      tool: 'enter_text',
      args: { text: '0.000000000123456789', selector: { key: 'price' }, backend: 'flutter' },
    });
    expect(result.steps[1].args).toMatchObject({ text: '2', selector: { key: 42 } });
    expect(result.steps[3].args).toMatchObject({ state: 'actionable', timeoutMs: 5000 });
    expect(result.steps[4].args).toMatchObject({ selector: { key: 'confirm', ancestor: { key: 'dialog' } } });
  });
  it('expands child actions with their own defaults and selector inputs', () => {
    const child = {
      id: 'login',
      name: '登录',
      inputs: { account: { required: true }, password: { default: 'pass', secret: true } },
      targets: { account: { key: 'account-${inputs.account}' }, password: { semantics: '密码' } },
      steps: [
        { id: 'password', type: 'enter_text', target: 'password', text: '${inputs.password}' },
        { id: 'account', type: 'wait_for_widget', target: 'account' },
      ],
    };
    const parent = {
      id: 'prepare',
      name: '准备',
      inputs: { user: { required: true } },
      targets: {},
      steps: [{ id: 'login', type: 'call', actionId: 'login', inputs: { account: '${inputs.user}' } }],
    };
    const result = compileSceneAction(validateSceneDocument(doc(parent, child)), 'orders', 'prepare', {
      user: 'test-user',
    });
    expect(result.steps[0]).toMatchObject({
      path: 'orders/prepare/login/orders/login/password',
      args: { text: 'pass' },
    });
    expect(result.steps[1].args).toMatchObject({ selector: { key: 'account-test-user' } });
    expect(result.secrets).toEqual(['pass']);
  });
  it('compiles scrolling to another stable named target', () => {
    const flow = {
      id: 'list',
      name: '列表',
      targets: { list: { key: 'list' }, row: { key: 'row' } },
      steps: [
        { id: 'scroll', type: 'scroll', target: 'list', untilTarget: 'row', direction: 'down', maxSteps: 4 },
      ],
    };
    const result = compileSceneAction(validateSceneDocument(doc(flow)), 'orders', 'list');
    expect(result.steps[0].args).toMatchObject({
      selector: { key: 'list' },
      targetSelector: { key: 'row' },
      maxSteps: 4,
    });
    expect(result.steps[0].args).not.toHaveProperty('untilTarget');
  });
  it.each([
    { ...order(), unknown: true },
    { ...order(), targets: { price: { ref: 'flutter:old' } } },
    { ...order(), targets: { price: { key: 'x', ancestor: { ref: 'old' } } } },
    { ...order(), targets: { price: { point: { x: 1, y: 2 } } } },
    { ...order(), steps: [{ id: 'x', type: 'script', text: 'run()' }] },
    { ...order(), steps: [{ id: 'x', type: 'tap', target: 'missing' }] },
    { ...order(), steps: [{ id: 'x', type: 'wait_for_widget', target: 'confirm', state: 'text_equals' }] },
    { ...order(), steps: [{ id: 'x', type: 'enter_text', target: 'price', text: '${inputs.missing}' }] },
    { ...order(), steps: [{ id: 'x', type: 'enter_text', target: 'price', text: '${inputs.price' }] },
    { ...order(), steps: [{ id: 'x', type: 'call', actionId: 'missing' }] },
    {
      ...order(),
      steps: [
        { id: 'x', type: 'tap', target: 'submit' },
        { id: 'x', type: 'tap', target: 'submit' },
      ],
    },
  ])('rejects invalid definitions before dispatch', (flow) => {
    expect(() => validateSceneDocument(doc(flow))).toThrow();
  });
  it('rejects duplicate actions, recursion and excessive expanded steps', () => {
    expect(() => validateSceneDocument(doc(order(), order()))).toThrow(/重复/);
    const recursive = {
      id: 'recursive',
      name: '递归',
      targets: {},
      steps: [{ id: 'self', type: 'call', actionId: 'recursive' }],
    };
    expect(() => validateSceneDocument(doc(recursive))).toThrow(/循环/);
    const leaf = {
      id: 'leaf',
      name: '叶子',
      targets: { button: { key: 'button' } },
      steps: Array.from({ length: 500 }, (_, i) => ({ id: `tap${i}`, type: 'tap', target: 'button' })),
    };
    const many = {
      id: 'many',
      name: '展开过多',
      targets: {},
      steps: Array.from({ length: 3 }, (_, i) => ({ id: `call${i}`, type: 'call', actionId: 'leaf' })),
    };
    expect(() => compileSceneAction(validateSceneDocument(doc(many, leaf)), 'orders', 'many')).toThrow(
      /1000/,
    );
  });
  it('checks child parameters and cross Scene references before compilation', () => {
    const child = {
      id: 'child',
      name: '子操作',
      inputs: { price: { required: true } },
      targets: { price: { key: 'price' } },
      steps: [{ id: 'price', type: 'enter_text', target: 'price', text: '${inputs.price}' }],
    };
    const parent = (call: unknown) => ({ id: 'parent', name: '父操作', steps: [call] });
    for (const call of [
      { id: 'call', type: 'call', actionId: 'child' },
      { id: 'call', type: 'call', actionId: 'child', inputs: { price: '1', extra: '2' } },
      { id: 'call', type: 'call', sceneId: 'missing', actionId: 'child', inputs: { price: '1' } },
      { id: 'call', type: 'call', workflowId: 'child', inputs: { price: '1' } },
    ]) {
      expect(() => validateSceneDocument(doc(parent(call), child))).toThrow();
    }
    expect(() =>
      validateSceneDocument({
        version: 1,
        activeSceneId: null,
        scenes: [
          scene('first', {
            actions: [
              {
                id: 'call',
                name: '调用',
                steps: [{ id: 'next', type: 'call', sceneId: 'second', actionId: 'call' }],
              },
            ],
          }),
          scene('second', {
            actions: [
              {
                id: 'call',
                name: '调用',
                steps: [{ id: 'next', type: 'call', sceneId: 'first', actionId: 'call' }],
              },
            ],
          }),
        ],
      }),
    ).toThrow(/循环/);
  });
  it('checks the longest call depth even when children are already cached', () => {
    const leaf = {
      id: 'action0',
      name: '叶子',
      targets: { ready: { key: 'ready' } },
      steps: [{ id: 'ready', type: 'wait_for_widget', target: 'ready' }],
    };
    const chain = Array.from({ length: 16 }, (_, index) => ({
      id: `action${index + 1}`,
      name: '调用',
      steps: [{ id: 'child', type: 'call', actionId: `action${index}` }],
    }));
    const allowed = validateSceneDocument(doc(leaf, ...chain.slice(0, 15)));
    expect(compileSceneAction(allowed, 'orders', 'action15').steps).toHaveLength(1);
    expect(() => validateSceneDocument(doc(leaf, ...chain))).toThrow(/16/);
  });
  it('rejects missing, unknown and numeric inputs, including invalid substituted selectors', () => {
    const value = validateSceneDocument(doc(order()));
    expect(() => compileSceneAction(value, 'orders', 'submit_order')).toThrow(/必填/);
    expect(() => compileSceneAction(value, 'orders', 'submit_order', { price: '2', extra: '3' })).toThrow(
      /未声明/,
    );
    expect(() => compileSceneAction(value, 'orders', 'submit_order', { price: 1 as any })).toThrow(/字符串/);
    const flow = {
      id: 'dynamic',
      name: '动态',
      inputs: { key: { required: true } },
      targets: { button: { key: '${inputs.key}' } },
      steps: [{ id: 'tap', type: 'tap', target: 'button' }],
    };
    expect(() =>
      compileSceneAction(validateSceneDocument(doc(flow)), 'orders', 'dynamic', { key: '' }),
    ).toThrow(/选择器/);
  });
});

describe('Scene action discovery and execution', () => {
  it('runs explicit keyboard dismissal before submission and stops when dismissal fails', async () => {
    const flow = {
      id: 'email',
      name: '邮箱登录',
      targets: { email: { key: 'email.input' }, submit: { key: 'email.submit' } },
      steps: [
        { id: 'fill', type: 'enter_text', target: 'email', text: 'fixture@example.test' },
        { id: 'hide', type: 'hide_keyboard' },
        { id: 'submit', type: 'tap', target: 'submit' },
      ],
    };
    const f = await fixture(doc(flow));
    const run = await f.controller.start('orders', 'email', {}, 'flutter');
    const result = await terminal(f.controller, run.runId);
    expect(result.status).toBe('completed');
    expect(result.steps[1]).toMatchObject({ tool: 'hide_keyboard', status: 'completed' });
    expect(result.steps[1]).not.toHaveProperty('target');
    expect(vi.mocked(f.host.execute).mock.calls.map(([, tool, args]) => ({ tool, args }))).toEqual([
      {
        tool: 'enter_text',
        args: { selector: { key: 'email.input' }, text: 'fixture@example.test', backend: 'flutter' },
      },
      { tool: 'hide_keyboard', args: { backend: 'flutter' } },
      { tool: 'tap', args: { selector: { key: 'email.submit' }, backend: 'flutter' } },
    ]);
    const failed = await fixture(doc(flow), async (_owner, tool) =>
      tool === 'hide_keyboard'
        ? { ok: false, code: 'KEYBOARD_UNAVAILABLE', message: '无法收起键盘。' }
        : { ok: true },
    );
    const failedRun = await failed.controller.start('orders', 'email', {}, 'flutter');
    expect((await terminal(failed.controller, failedRun.runId)).status).toBe('failed');
    expect(vi.mocked(failed.host.execute).mock.calls.map(([, tool]) => tool)).toEqual([
      'enter_text',
      'hide_keyboard',
    ]);
    expect(failed.host.release).toHaveBeenCalledExactlyOnceWith(failedRun.runId);
  });
  it('runs public cross Scene operations against the current Mock without switching it', async () => {
    const value = {
      version: 1,
      activeSceneId: 'insufficient_balance',
      scenes: [
        scene('insufficient_balance'),
        scene('order_operations', {
          actions: [
            {
              id: 'submit',
              name: '提交',
              inputs: { price: { required: true } },
              steps: [
                {
                  id: 'submit',
                  type: 'call',
                  sceneId: 'common_operations',
                  actionId: 'fill',
                  inputs: { price: '${inputs.price}' },
                },
              ],
            },
          ],
        }),
        scene('common_operations', {
          targets: { price: { key: 'price' } },
          actions: [
            {
              id: 'fill',
              name: '填价',
              inputs: { price: { required: true } },
              steps: [{ id: 'fill', type: 'enter_text', target: 'price', text: '${inputs.price}' }],
            },
          ],
        }),
      ],
    };
    const f = await fixture(value);
    f.host.mockSceneId = vi.fn(() => f.loaded().activeSceneId);
    const first = await f.controller.start('order_operations', 'submit', { price: '10' });
    const run = await terminal(f.controller, first.runId);
    expect(run).toMatchObject({
      sceneId: 'order_operations',
      actionId: 'submit',
      mockSceneId: 'insufficient_balance',
      status: 'completed',
      steps: [{ sceneId: 'common_operations', actionId: 'fill' }],
    });
    expect((f.host.execute as any).mock.calls[0][2]).toMatchObject({ text: '10' });
    expect(f.loaded().activeSceneId).toBe('insufficient_balance');
    f.reload({ ...value, activeSceneId: null });
    const second = await f.controller.start('common_operations', 'fill', { price: '20' });
    expect((await terminal(f.controller, second.runId)).mockSceneId).toBeNull();
    expect(f.loaded().activeSceneId).toBeNull();
  });
  it('does not run operations when constructed, listed, or supplied a refreshed snapshot', async () => {
    const f = await fixture();
    await f.controller.list('orders');
    f.reload(doc(order()));
    await f.controller.list('orders');
    expect(f.host.acquire).not.toHaveBeenCalled();
    expect(f.host.execute).not.toHaveBeenCalled();
    expect(f.controller.snapshot.recentRuns).toEqual([]);
  });
  it('returns a run ID while acquisition is pending and can cancel before any action', async () => {
    const acquisition = deferred<void>();
    const f = await fixture();
    f.host.acquire = vi.fn(() => acquisition.promise);
    const run = await f.controller.start('orders', 'submit_order', { price: '1' });
    expect(f.controller.get(run.runId).run.status).toBe('running');
    expect(f.host.execute).not.toHaveBeenCalled();
    f.controller.cancel(run.runId);
    expect(f.host.release).not.toHaveBeenCalled();
    acquisition.resolve();
    expect((await terminal(f.controller, run.runId)).status).toBe('cancelled');
    expect(f.host.execute).not.toHaveBeenCalled();
    expect(f.host.release).toHaveBeenCalledExactlyOnceWith(run.runId);
  });
  it('does not publish a terminal state until ownership is released', async () => {
    const release = deferred<void>(),
      releasing = deferred<void>();
    const f = await fixture();
    f.host.release = vi.fn(() => {
      releasing.resolve();
      return release.promise;
    });
    const run = await f.controller.start('orders', 'submit_order', { price: '1' });
    await releasing.promise;
    expect(f.controller.get(run.runId).run.status).toBe('running');
    const idle = f.controller.waitForIdle();
    release.resolve();
    await idle;
    expect(f.controller.get(run.runId).run.status).toBe('completed');
  });
  it('reports acquisition failure without dispatching actions or releasing another owner', async () => {
    const f = await fixture();
    f.host.acquire = vi.fn(async () => {
      throw Object.assign(new Error('设备已被占用'), { code: 'DEVICE_BUSY' });
    });
    const run = await f.controller.start('orders', 'submit_order', { price: '1' });
    expect((await terminal(f.controller, run.runId)).failure).toMatchObject({
      code: 'DEVICE_BUSY',
      uncertain: false,
    });
    expect(f.host.execute).not.toHaveBeenCalled();
    expect(f.host.release).not.toHaveBeenCalled();
  });
  it('lists only action metadata and shared targets from the loaded Scene snapshot', async () => {
    const f = await fixture();
    const result = await f.controller.list('orders');
    expect(result).toMatchObject({
      sceneId: 'orders',
      mockSceneId: null,
      targets: { price: { key: 'price' } },
      actions: [{ id: 'submit_order', name: '提交订单', stepCount: 5 }],
    });
    expect(result).not.toHaveProperty('files');
    expect(result.actions[0]).not.toHaveProperty('steps');
    expect(result).not.toHaveProperty('httpRules');
    await expect(f.controller.list('missing')).rejects.toMatchObject({ code: 'SCENE_NOT_FOUND' });
  });
  it('validates every compiled step before acquiring automation or executing anything', async () => {
    const flow = order();
    flow.steps.push({ id: 'invalid', type: 'enter_text', target: 'price', text: '${inputs.quantity}' });
    (flow.inputs.quantity as any).default = undefined;
    const f = await fixture(doc(flow));
    await expect(f.controller.start('orders', 'submit_order', { price: '1' })).rejects.toMatchObject({
      code: 'INVALID_SCENE_ACTION',
    });
    expect(f.host.acquire).not.toHaveBeenCalled();
    expect(f.host.execute).not.toHaveBeenCalled();
  });
  it('runs once in order, reports completion separately from test passing and supports another run', async () => {
    const f = await fixture();
    const first = await f.controller.start('orders', 'submit_order', { price: '100.50' });
    expect(first.status).toBe('running');
    const result = await terminal(f.controller, first.runId);
    expect(result.status).toBe('completed');
    expect(result.message).toContain('不代表测试通过');
    expect(result.steps.map((step) => step.status)).toEqual(Array(5).fill('completed'));
    expect(result.metrics).toMatchObject({ stepsCompleted: 5, resolveMs: 10, inputMs: 15 });
    expect(f.host.execute).toHaveBeenCalledTimes(5);
    expect(f.host.release).toHaveBeenCalledExactlyOnceWith(first.runId);
    const second = await f.controller.start('orders', 'submit_order', { price: '200' });
    expect(second.runId).not.toBe(first.runId);
    await terminal(f.controller, second.runId);
    expect(f.controller.get(first.runId).run.inputs.price).toBe('100.50');
    expect(f.controller.get(second.runId).run.inputs.price).toBe('200');
  });
  it('returns detached run data and does not expose secret defaults, text, widget data or errors', async () => {
    const flow = {
      id: 'login',
      name: '登录',
      inputs: { password: { required: true, secret: true, default: 'secret123' } },
      targets: { field: { key: 'password' } },
      steps: [{ id: 'fill', type: 'enter_text', target: 'field', text: '${inputs.password}' }],
    };
    const f = await fixture(doc(flow), async () => ({
      ok: false,
      code: 'NOT_FOUND',
      message: 'secret123 is missing',
      widget: { text: 'secret123' },
    }));
    expect(JSON.stringify(await f.controller.list('orders'))).not.toContain('secret123');
    const start = await f.controller.start('orders', 'login');
    const result = await terminal(f.controller, start.runId);
    expect(JSON.stringify(result)).not.toContain('secret123');
    expect(result.inputs.password).toBe('[REDACTED]');
    expect(result.steps[0]).not.toHaveProperty('args');
    expect(result.steps[0]).not.toHaveProperty('widget');
    const read = f.controller.get(start.runId);
    read.run.steps[0].status = 'completed';
    expect(f.controller.get(start.runId).run.steps[0].status).toBe('failed');
  });
  it('preserves allowlisted wait diagnostics and redacts nested secret values', async () => {
    const flow = {
      id: 'wait',
      name: '等待',
      inputs: { password: { required: true, secret: true, default: 'secret123' } },
      targets: { shell: { key: 'app.shell.root' } },
      steps: [{ id: 'ready', type: 'wait_for_widget', target: 'shell', state: 'visible' }],
    };
    const f = await fixture(doc(flow), async () => ({
      ok: false,
      code: 'WAIT_TIMEOUT',
      message: 'secret123 was not found',
      diagnostics: {
        selector: { source: 'flutter', key: 'app.shell.root', ancestor: { text: 'secret123' } },
        condition: 'visible',
        timeoutMs: 30000,
        attempts: 42,
        widget: { text: 'unrelated private text' },
        lastObservation: {
          code: 'NOT_FOUND',
          message: 'secret123 is missing',
          present: false,
          text: 'unrelated private text',
          bounds: { x: 0, y: 0 },
        },
      },
    }));
    const start = await f.controller.start('orders', 'wait');
    const result = await terminal(f.controller, start.runId);
    expect(result.failure?.diagnostics).toEqual({
      selector: { source: 'flutter', key: 'app.shell.root', ancestor: { text: '[REDACTED]' } },
      condition: 'visible',
      timeoutMs: 30000,
      attempts: 42,
      lastObservation: { code: 'NOT_FOUND', message: '[REDACTED] is missing', present: false },
    });
    expect(result.steps[0].failure).toEqual(result.failure);
    expect(JSON.stringify(result)).not.toContain('secret123');
    expect(JSON.stringify(result)).not.toContain('unrelated private text');
  });
  it('preserves unknown presence for a failed wait locator', async () => {
    const flow = {
      id: 'wait',
      name: '等待',
      targets: { shell: { key: 'app.shell.root' } },
      steps: [{ id: 'ready', type: 'wait_for_widget', target: 'shell', state: 'visible' }],
    };
    const f = await fixture(doc(flow), async () => ({
      ok: false,
      code: 'AMBIGUOUS_SELECTOR',
      message: '范围内存在多个匹配目标。',
      diagnostics: {
        selector: { source: 'flutter', key: 'app.shell.root' },
        condition: 'visible',
        timeoutMs: 5000,
        attempts: 1,
        lastObservation: { code: 'AMBIGUOUS_SELECTOR', message: '范围内存在多个匹配目标。' },
      },
    }));
    const start = await f.controller.start('orders', 'wait');
    const result = await terminal(f.controller, start.runId);
    expect(result.failure?.diagnostics).toMatchObject({
      attempts: 1,
      lastObservation: { code: 'AMBIGUOUS_SELECTOR' },
    });
    expect(result.failure?.diagnostics?.lastObservation).not.toHaveProperty('present');
  });
  it('stops at an ambiguous locator without retries or later confirmation', async () => {
    let count = 0;
    const f = await fixture(undefined, async () =>
      ++count === 3 ? { ok: false, code: 'AMBIGUOUS_TARGET', message: '目标不唯一' } : { ok: true },
    );
    const start = await f.controller.start('orders', 'submit_order', { price: '1' });
    const result = await terminal(f.controller, start.runId);
    expect(result.status).toBe('failed');
    expect(result.currentStep).toBe('orders/submit_order/submit');
    expect(result.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
      'failed',
      'skipped',
      'skipped',
    ]);
    expect(f.host.execute).toHaveBeenCalledTimes(3);
  });
  it('preserves uncertain timeouts and never replays confirm', async () => {
    const f = await fixture(undefined, async (_owner, tool, args) =>
      tool === 'tap' && (args.selector as any).key === 'confirm'
        ? { ok: false, code: 'TIMEOUT', message: '确认未收到结果', uncertain: true }
        : { ok: true },
    );
    const start = await f.controller.start('orders', 'submit_order', { price: '1' });
    const result = await terminal(f.controller, start.runId);
    expect(result.status).toBe('uncertain');
    expect(result.failure).toMatchObject({ code: 'TIMEOUT', uncertain: true });
    expect(f.host.execute).toHaveBeenCalledTimes(5);
  });
  it('rejects overlapping starts while reading a definition or while running', async () => {
    const gate = deferred<UiResult>();
    const f = await fixture(undefined, async () => gate.promise);
    const starting = f.controller.start('orders', 'submit_order', { price: '1' });
    await expect(f.controller.start('orders', 'submit_order', { price: '2' })).rejects.toMatchObject({
      code: 'WORKFLOW_BUSY',
    });
    const run = await starting;
    await expect(f.controller.start('orders', 'submit_order', { price: '2' })).rejects.toMatchObject({
      code: 'WORKFLOW_BUSY',
    });
    f.controller.cancel(run.runId);
    gate.resolve({ ok: true });
    await terminal(f.controller, run.runId);
  });
  it('waits for the in-flight action to settle before release and reports uncertain cancellation', async () => {
    const gate = deferred<UiResult>(),
      entered = deferred<void>();
    const flow = {
      id: 'confirm',
      name: '确认',
      targets: { confirm: { key: 'confirm' } },
      steps: [{ id: 'confirm', type: 'tap', target: 'confirm' }],
    };
    const f = await fixture(doc(flow), async () => {
      entered.resolve();
      return gate.promise;
    });
    const run = await f.controller.start('orders', 'confirm');
    await entered.promise;
    expect(f.controller.cancel(run.runId)).toMatchObject({ status: 'running', cancelRequested: true });
    expect(f.host.release).not.toHaveBeenCalled();
    expect(f.controller.get(run.runId).run.status).toBe('running');
    gate.resolve({ ok: true });
    expect((await terminal(f.controller, run.runId)).status).toBe('uncertain');
    expect(f.host.release).toHaveBeenCalledExactlyOnceWith(run.runId);
  });
  it('cancels a wait without dispatching subsequent actions', async () => {
    const flow = {
      id: 'wait',
      name: '等待',
      targets: { ready: { key: 'ready' } },
      steps: [
        { id: 'ready', type: 'wait_for_widget', target: 'ready' },
        { id: 'tap', type: 'tap', target: 'ready' },
      ],
    };
    const entered = deferred<void>();
    const f = await fixture(doc(flow), async (_owner, _tool, _args, signal) => {
      entered.resolve();
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ ok: false, code: 'CANCELLED' }), { once: true }),
      );
    });
    const run = await f.controller.start('orders', 'wait');
    await entered.promise;
    f.controller.cancel(run.runId);
    expect((await terminal(f.controller, run.runId)).status).toBe('cancelled');
    expect(f.host.execute).toHaveBeenCalledTimes(1);
  });
  it('snapshots definitions and inputs for a run, but reads edits before the next start', async () => {
    const gate = deferred<UiResult>(),
      entered = deferred<void>();
    let first = true;
    const f = await fixture(undefined, async () => {
      if (first) {
        first = false;
        entered.resolve();
        return gate.promise;
      }
      return { ok: true };
    });
    const run = await f.controller.start('orders', 'submit_order', { price: '1' });
    await entered.promise;
    const changed = order();
    changed.steps[4].target = 'submit';
    f.reload(doc(changed));
    gate.resolve({ ok: true });
    const before = await terminal(f.controller, run.runId);
    expect((f.host.execute as any).mock.calls[4][2].selector.key).toBe('confirm');
    const second = await f.controller.start('orders', 'submit_order', { price: '2' });
    const after = await terminal(f.controller, second.runId);
    expect((f.host.execute as any).mock.calls[9][2].selector.key).toBe('submit');
    expect(after.definitionHash).not.toBe(before.definitionHash);
  });
  it('bounds recent run retention and rejects expired IDs', async () => {
    const flow = {
      id: 'once',
      name: '一次',
      targets: { button: { key: 'button' } },
      steps: [{ id: 'tap', type: 'tap', target: 'button' }],
    };
    const f = await fixture(doc(flow));
    let first = '';
    for (let i = 0; i < 51; i++) {
      const run = await f.controller.start('orders', 'once');
      first ||= run.runId;
      await terminal(f.controller, run.runId);
    }
    expect(f.controller.snapshot.recentRuns).toHaveLength(50);
    expect(() => f.controller.get(first)).toThrow(/过期/);
  });
  it('cancels and releases ownership on disposal and rejects future runs', async () => {
    const entered = deferred<void>();
    const f = await fixture(undefined, async (_owner, _tool, _args, signal) => {
      entered.resolve();
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ ok: false, code: 'CANCELLED', uncertain: true }), {
          once: true,
        }),
      );
    });
    const run = await f.controller.start('orders', 'submit_order', { price: '1' });
    await entered.promise;
    await f.controller.dispose();
    expect(f.host.release).toHaveBeenCalledExactlyOnceWith(run.runId);
    expect(f.controller.get(run.runId).run.status).toBe('uncertain');
    await expect(f.controller.start('orders', 'submit_order', { price: '1' })).rejects.toMatchObject({
      code: 'SESSION_INVALIDATED',
    });
  });
});

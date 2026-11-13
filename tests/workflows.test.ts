import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowStore } from '../src/workflows/store';
import { WorkflowController, type WorkflowHost } from '../src/workflows/controller';
import { compileWorkflow, validateWorkflowDocument } from '../src/workflows/model';
import type { UiResult } from '../src/vm/ui';

const roots: string[] = [],
  controllers: WorkflowController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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
const doc = (...flows: unknown[]) => ({ version: 1, workflows: flows });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(value: unknown = doc(order()), execute?: WorkflowHost['execute']) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-workflows-'));
  roots.push(root);
  const directory = join(root, '.flutter-pilot');
  await mkdir(directory);
  const store = new WorkflowStore(directory);
  await writeFile(store.file, JSON.stringify(value));
  const host: WorkflowHost = {
    acquire: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    changed: vi.fn(),
    execute: vi.fn(
      execute ?? (async () => ({ ok: true, backend: 'flutter', timings: { resolveMs: 2, inputMs: 3 } })),
    ),
  };
  const controller = new WorkflowController(store, host);
  controllers.push(controller);
  return { root, store, host, controller };
}
async function terminal(controller: WorkflowController, runId: string) {
  for (let i = 0; i < 100; i++) {
    const result = controller.get(runId).run;
    if (result.status !== 'running') return result;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Run did not settle');
}

describe('workflow document compilation', () => {
  it('compiles typed stable selectors, exact decimal strings and bounded waits', () => {
    const result = compileWorkflow(
      validateWorkflowDocument(doc(order())),
      'submit_order',
      { price: '0.000000000123456789' },
      'flutter',
    );
    expect(result.steps).toHaveLength(5);
    expect(result.steps[0]).toMatchObject({
      path: 'submit_order/price',
      tool: 'enter_text',
      args: { text: '0.000000000123456789', selector: { key: 'price' }, backend: 'flutter' },
    });
    expect(result.steps[1].args).toMatchObject({ text: '2', selector: { key: 42 } });
    expect(result.steps[3].args).toMatchObject({ state: 'actionable', timeoutMs: 5000 });
    expect(result.steps[4].args).toMatchObject({ selector: { key: 'confirm', ancestor: { key: 'dialog' } } });
  });
  it('expands child workflows with their own defaults and selector inputs', () => {
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
      steps: [{ id: 'login', type: 'call', workflowId: 'login', inputs: { account: '${inputs.user}' } }],
    };
    const result = compileWorkflow(validateWorkflowDocument(doc(parent, child)), 'prepare', {
      user: 'test-user',
    });
    expect(result.steps[0]).toMatchObject({ path: 'prepare/login/password', args: { text: 'pass' } });
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
    const result = compileWorkflow(validateWorkflowDocument(doc(flow)), 'list');
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
    { ...order(), steps: [{ id: 'x', type: 'call', workflowId: 'missing' }] },
    {
      ...order(),
      steps: [
        { id: 'x', type: 'tap', target: 'submit' },
        { id: 'x', type: 'tap', target: 'submit' },
      ],
    },
  ])('rejects invalid definitions before dispatch', (flow) => {
    expect(() => validateWorkflowDocument(doc(flow))).toThrow();
  });
  it('rejects duplicate workflows, recursion and excessive expanded steps', () => {
    expect(() => validateWorkflowDocument(doc(order(), order()))).toThrow(/重复/);
    const recursive = {
      id: 'recursive',
      name: '递归',
      targets: {},
      steps: [{ id: 'self', type: 'call', workflowId: 'recursive' }],
    };
    expect(() => validateWorkflowDocument(doc(recursive))).toThrow(/循环/);
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
      steps: Array.from({ length: 3 }, (_, i) => ({ id: `call${i}`, type: 'call', workflowId: 'leaf' })),
    };
    expect(() => compileWorkflow(validateWorkflowDocument(doc(many, leaf)), 'many')).toThrow(/1000/);
  });
  it('rejects missing, unknown and numeric inputs, including invalid substituted selectors', () => {
    const value = validateWorkflowDocument(doc(order()));
    expect(() => compileWorkflow(value, 'submit_order')).toThrow(/必填/);
    expect(() => compileWorkflow(value, 'submit_order', { price: '2', extra: '3' })).toThrow(/未声明/);
    expect(() => compileWorkflow(value, 'submit_order', { price: 1 as any })).toThrow(/字符串/);
    const flow = {
      id: 'dynamic',
      name: '动态',
      inputs: { key: { required: true } },
      targets: { button: { key: '${inputs.key}' } },
      steps: [{ id: 'tap', type: 'tap', target: 'button' }],
    };
    expect(() => compileWorkflow(validateWorkflowDocument(doc(flow)), 'dynamic', { key: '' })).toThrow(
      /选择器/,
    );
  });
});

describe('workflow files and execution', () => {
  it('returns a run ID while acquisition is pending and can cancel before any action', async () => {
    const acquisition = deferred<void>();
    const f = await fixture();
    f.host.acquire = vi.fn(() => acquisition.promise);
    const run = await f.controller.start('submit_order', { price: '1' });
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
    const run = await f.controller.start('submit_order', { price: '1' });
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
    const run = await f.controller.start('submit_order', { price: '1' });
    expect((await terminal(f.controller, run.runId)).failure).toMatchObject({
      code: 'DEVICE_BUSY',
      uncertain: false,
    });
    expect(f.host.execute).not.toHaveBeenCalled();
    expect(f.host.release).not.toHaveBeenCalled();
  });
  it('lists an absent file without creating it and rejects invalid/symlink files', async () => {
    const f = await fixture();
    await rm(f.store.file);
    expect(await f.controller.list()).toMatchObject({ workflows: [], files: { workflows: f.store.file } });
    await expect(readFile(f.store.file)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(f.store.file, '{invalid');
    await expect(f.controller.list()).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_FILE' });
    await rm(f.store.file);
    await writeFile(join(f.root, 'outside.json'), JSON.stringify(doc()));
    await symlink(join(f.root, 'outside.json'), f.store.file);
    await expect(f.controller.list()).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_FILE' });
  });
  it('validates every compiled step before acquiring automation or executing anything', async () => {
    const flow = order();
    flow.steps.push({ id: 'invalid', type: 'enter_text', target: 'price', text: '${inputs.quantity}' });
    (flow.inputs.quantity as any).default = undefined;
    const f = await fixture(doc(flow));
    await expect(f.controller.start('submit_order', { price: '1' })).rejects.toMatchObject({
      code: 'INVALID_WORKFLOW',
    });
    expect(f.host.acquire).not.toHaveBeenCalled();
    expect(f.host.execute).not.toHaveBeenCalled();
  });
  it('runs once in order, reports completion separately from test passing and supports another run', async () => {
    const f = await fixture();
    const first = await f.controller.start('submit_order', { price: '100.50' });
    expect(first.status).toBe('running');
    const result = await terminal(f.controller, first.runId);
    expect(result.status).toBe('completed');
    expect(result.message).toContain('不代表测试通过');
    expect(result.steps.map((step) => step.status)).toEqual(Array(5).fill('completed'));
    expect(result.metrics).toMatchObject({ stepsCompleted: 5, resolveMs: 10, inputMs: 15 });
    expect(f.host.execute).toHaveBeenCalledTimes(5);
    expect(f.host.release).toHaveBeenCalledExactlyOnceWith(first.runId);
    const second = await f.controller.start('submit_order', { price: '200' });
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
    expect(JSON.stringify(await f.controller.list())).not.toContain('secret123');
    const start = await f.controller.start('login');
    const result = await terminal(f.controller, start.runId);
    expect(JSON.stringify(result)).not.toContain('secret123');
    expect(result.inputs.password).toBe('[REDACTED]');
    expect(result.steps[0]).not.toHaveProperty('args');
    expect(result.steps[0]).not.toHaveProperty('widget');
    const read = f.controller.get(start.runId);
    read.run.steps[0].status = 'completed';
    expect(f.controller.get(start.runId).run.steps[0].status).toBe('failed');
  });
  it('stops at an ambiguous locator without retries or later confirmation', async () => {
    let count = 0;
    const f = await fixture(undefined, async () =>
      ++count === 3 ? { ok: false, code: 'AMBIGUOUS_TARGET', message: '目标不唯一' } : { ok: true },
    );
    const start = await f.controller.start('submit_order', { price: '1' });
    const result = await terminal(f.controller, start.runId);
    expect(result.status).toBe('failed');
    expect(result.currentStep).toBe('submit_order/submit');
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
    const start = await f.controller.start('submit_order', { price: '1' });
    const result = await terminal(f.controller, start.runId);
    expect(result.status).toBe('uncertain');
    expect(result.failure).toMatchObject({ code: 'TIMEOUT', uncertain: true });
    expect(f.host.execute).toHaveBeenCalledTimes(5);
  });
  it('rejects overlapping starts while reading a definition or while running', async () => {
    const gate = deferred<UiResult>();
    const f = await fixture(undefined, async () => gate.promise);
    const starting = f.controller.start('submit_order', { price: '1' });
    await expect(f.controller.start('submit_order', { price: '2' })).rejects.toMatchObject({
      code: 'WORKFLOW_BUSY',
    });
    const run = await starting;
    await expect(f.controller.start('submit_order', { price: '2' })).rejects.toMatchObject({
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
    const run = await f.controller.start('confirm');
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
    const run = await f.controller.start('wait');
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
    const run = await f.controller.start('submit_order', { price: '1' });
    await entered.promise;
    const changed = order();
    changed.steps[4].target = 'submit';
    await writeFile(f.store.file, JSON.stringify(doc(changed)));
    gate.resolve({ ok: true });
    const before = await terminal(f.controller, run.runId);
    expect((f.host.execute as any).mock.calls[4][2].selector.key).toBe('confirm');
    const second = await f.controller.start('submit_order', { price: '2' });
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
      const run = await f.controller.start('once');
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
    const run = await f.controller.start('submit_order', { price: '1' });
    await entered.promise;
    await f.controller.dispose();
    expect(f.host.release).toHaveBeenCalledExactlyOnceWith(run.runId);
    expect(f.controller.get(run.runId).run.status).toBe('uncertain');
    await expect(f.controller.start('submit_order', { price: '1' })).rejects.toMatchObject({
      code: 'SESSION_INVALIDATED',
    });
  });
});

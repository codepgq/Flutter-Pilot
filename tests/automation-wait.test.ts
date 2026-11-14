import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationController } from '../src/automation/controller';
import { AutomationError, type DeviceBinding } from '../src/automation/model';
import type { UiResult } from '../src/vm/ui';

const controllers: AutomationController[] = [];
const roots: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function fixture(results: UiResult[]) {
  const runtime = new EventEmitter() as any;
  runtime.dispose = vi.fn();
  runtime.stop = vi.fn();
  let index = 0;
  const vmExecute = vi.fn(async () => results[Math.min(index++, results.length - 1)]);
  const controller = new AutomationController(runtime, {
    vmConnected: () => true,
    vmExecute,
    vmInvalidate: vi.fn(),
    changed: vi.fn(),
  });
  controllers.push(controller);
  return { controller, vmExecute };
}

async function nativeFixture(error: Error) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-automation-wait-test-'));
  roots.push(root);
  const binding: DeviceBinding = {
    platform: 'ios',
    kind: 'simulator',
    deviceId: 'wait-test-device',
    appId: 'test.app',
  };
  const runtime = new EventEmitter() as any;
  runtime.snapshot = {
    status: 'ready',
    installed: true,
    devices: [{ id: binding.deviceId, platform: binding.platform, kind: binding.kind, state: 'Booted' }],
    versions: {},
    diagnostics: [],
  };
  runtime.inspect = async () => runtime.snapshot;
  runtime.start = async () => 'http://127.0.0.1:4723';
  runtime.checkPlatform = vi.fn();
  runtime.stop = vi.fn();
  runtime.dispose = vi.fn();
  const native = {
    binding,
    connect: vi.fn(),
    disconnect: vi.fn(),
    release: vi.fn(),
    capabilities: () => ({}),
    find: vi.fn(async () => {
      throw error;
    }),
  };
  const vmExecute = vi.fn();
  const controller = new AutomationController(
    runtime,
    {
      vmConnected: () => false,
      vmExecute,
      vmInvalidate: vi.fn(),
      changed: vi.fn(),
      createNative: () => native as any,
    },
    root,
  );
  controllers.push(controller);
  expect(
    await controller.execute('connect_device', { deviceId: binding.deviceId, appId: binding.appId }),
  ).toMatchObject({ ok: true });
  return { controller, native, vmExecute };
}

describe('wait target diagnostics', () => {
  it('identifies the actual Key and missing mounted target after repeated observations', async () => {
    const { controller, vmExecute } = fixture([
      { ok: false, code: 'NOT_FOUND', message: '当前已挂载界面没有匹配的 Key。' },
    ]);
    const pending = controller.execute('wait_for_widget', {
      selector: { source: 'flutter', key: 'app.shell.root' },
      state: 'visible',
      timeoutMs: 250,
    });
    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      code: 'WAIT_TIMEOUT',
      diagnostics: {
        selector: { source: 'flutter', key: 'app.shell.root' },
        condition: 'visible',
        timeoutMs: 250,
        lastObservation: {
          code: 'NOT_FOUND',
          message: '当前已挂载界面没有匹配的 Key。',
          present: false,
        },
      },
    });
    expect(result.message).toContain('app.shell.root');
    expect(result.message).toContain('起始页面');
    expect(vmExecute.mock.calls.length).toBeGreaterThan(1);
    expect((result.diagnostics as any).attempts).toBe(vmExecute.mock.calls.length);
  });

  it('distinguishes a mounted hidden target from a missing one without exposing widget text', async () => {
    const { controller } = fixture([
      {
        ok: true,
        widget: { visible: false, enabled: true, actionable: false, text: 'private widget text' },
      },
    ]);
    const pending = controller.execute('wait_for_widget', {
      key: 'home.page.root',
      state: 'visible',
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(150);
    const result = await pending;
    expect(result).toMatchObject({
      code: 'WAIT_TIMEOUT',
      diagnostics: {
        lastObservation: { code: 'FOUND', present: true, visible: false, enabled: true, actionable: false },
      },
    });
    expect(result.message).toContain('目标已找到');
    expect(JSON.stringify(result)).not.toContain('private widget text');
    expect(result).not.toHaveProperty('widget');
  });

  it('reports a text mismatch as a boolean without retaining actual or expected text', async () => {
    const { controller } = fixture([{ ok: true, widget: { text: 'private actual text' } }]);
    const pending = controller.execute('wait_for_widget', {
      key: 'status',
      state: 'text_equals',
      text: 'private expected text',
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(150);
    const result = await pending;
    expect(result).toMatchObject({
      code: 'WAIT_TIMEOUT',
      diagnostics: { lastObservation: { present: true, textMatches: false } },
    });
    expect(result.message).toContain('文字条件');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('continues waiting for transient missing targets and succeeds when the requested state appears', async () => {
    const { controller } = fixture([
      { ok: false, code: 'NOT_FOUND' },
      { ok: true, widget: { visible: true } },
    ]);
    const pending = controller.execute('wait_for_widget', { key: 'home', state: 'visible', timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(150);
    expect(await pending).toMatchObject({ ok: true, condition: 'visible', widget: { visible: true } });
  });

  it('preserves non-retryable locator errors instead of turning them into timeouts', async () => {
    const { controller, vmExecute } = fixture([
      { ok: false, code: 'AMBIGUOUS_SELECTOR', message: '范围内存在多个匹配目标。' },
    ]);
    const result = await controller.execute('wait_for_widget', {
      key: 'duplicate',
      state: 'visible',
      timeoutMs: 500,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'AMBIGUOUS_SELECTOR',
      diagnostics: { attempts: 1, lastObservation: { code: 'AMBIGUOUS_SELECTOR' } },
    });
    expect((result.diagnostics as any).lastObservation).not.toHaveProperty('present');
    expect(vmExecute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: 'AMBIGUOUS_SELECTOR', uncertain: false },
    { code: 'STALE_REFERENCE', uncertain: true },
  ])('preserves thrown native $code with diagnostics without retrying', async ({ code, uncertain }) => {
    const error = Object.assign(new AutomationError(code, '原生定位未确认。', uncertain), {
      candidates: [{ text: 'private candidate text' }],
    });
    const { controller, native, vmExecute } = await nativeFixture(error);
    const selector = { source: 'device', accessibilityId: 'native-target' };
    const result = await controller.execute('wait_for_widget', {
      selector,
      state: 'visible',
      timeoutMs: 500,
    });
    expect(result).toMatchObject({
      ok: false,
      code,
      message: error.message,
      uncertain,
      diagnostics: {
        selector,
        condition: 'visible',
        timeoutMs: 500,
        attempts: 1,
        lastObservation: { code, message: error.message },
      },
    });
    expect((result.diagnostics as any).lastObservation).not.toHaveProperty('present');
    expect(result).not.toHaveProperty('candidates');
    expect(result).not.toHaveProperty('widget');
    expect(JSON.stringify(result)).not.toContain('private candidate text');
    expect(native.find).toHaveBeenCalledExactlyOnceWith(selector, expect.any(AbortSignal), undefined);
    expect(vmExecute).not.toHaveBeenCalled();
  });

  it.each([
    { error: new AutomationError('CANCELLED', '操作已取消。'), code: 'CANCELLED' },
    { error: new Error('private unexpected error'), code: 'AUTOMATION_FAILED' },
  ])('keeps native $code on the existing cancellation or unexpected-error path', async ({ error, code }) => {
    const { controller, native, vmExecute } = await nativeFixture(error);
    const result = await controller.execute('wait_for_widget', {
      selector: { source: 'device', accessibilityId: 'native-target' },
      state: 'visible',
      timeoutMs: 500,
    });
    expect(result).toMatchObject({ ok: false, code });
    expect(result).not.toHaveProperty('diagnostics');
    expect(JSON.stringify(result)).not.toContain('private unexpected error');
    expect(native.find).toHaveBeenCalledTimes(1);
    expect(vmExecute).not.toHaveBeenCalled();
  });
});

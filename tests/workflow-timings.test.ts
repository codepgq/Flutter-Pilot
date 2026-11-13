import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationController } from '../src/automation/controller';
import type { UiResult } from '../src/vm/ui';

const controllers: AutomationController[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture() {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const runtime = new EventEmitter() as any;
  runtime.snapshot = { status: 'ready', installed: true, diagnostics: [], devices: [] };
  runtime.dispose = async () => {};
  runtime.stop = async () => {};
  const vm = vi.fn(async (tool: string): Promise<UiResult> => {
    if (tool === 'get_ui_geometry') {
      clock += 2;
      return { ok: true, width: 100, height: 100 };
    }
    if (tool === 'find_widget') {
      clock += 3;
      return {
        ok: true,
        widget: { enabled: true, visible: true, bounds: { x: 10, y: 10, width: 20, height: 20 } },
      };
    }
    if (tool === 'perform_gesture') {
      clock += 7;
      return { ok: true };
    }
    if (tool === 'enter_text') {
      clock += 12;
      return { ok: true, timings: { resolveMs: 2, inputMs: 5, totalMs: 8 } };
    }
    return { ok: true };
  });
  const controller = new AutomationController(runtime, {
    vmExecute: vm,
    vmConnected: () => true,
    vmInvalidate: vi.fn(),
    changed: vi.fn(),
  });
  controllers.push(controller);
  return {
    controller,
    vm,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('workflow action timings', () => {
  it.each(['stable', 'width', 'devicePixelRatio', 'viewId'])(
    'checks %s Flutter geometry independently of changing runtime timings before native input',
    async (change) => {
      const root = await mkdtemp(join(tmpdir(), 'pilot-workflow-geometry-'));
      roots.push(root);
      const binding = { deviceId: 'phone', appId: 'test.app', platform: 'ios', kind: 'simulator' };
      const screen = { x: 0, y: 0, width: 400, height: 800 };
      const runtime = new EventEmitter() as any;
      runtime.snapshot = {
        installed: true,
        status: 'ready',
        diagnostics: [],
        devices: [{ ...binding, id: binding.deviceId, state: 'Booted' }],
      };
      runtime.inspect = async () => runtime.snapshot;
      runtime.checkPlatform = vi.fn();
      runtime.start = async () => 'http://127.0.0.1:4723';
      runtime.stop = vi.fn();
      runtime.dispose = vi.fn();
      const native = {
        binding,
        connect: vi.fn(),
        disconnect: vi.fn(),
        release: vi.fn(),
        capabilities: () => ({}),
        geometry: async () => ({ rect: screen, orientation: 'PORTRAIT' }),
        flutterViewport: async () => screen,
        foreground: async () => true,
        assertNoOverlay: vi.fn(),
        perform: vi.fn(),
      };
      let geometryCalls = 0;
      const vm = vi.fn(async (tool: string): Promise<UiResult> => {
        if (tool === 'get_ui_geometry') {
          const geometry = { width: 400, height: 800, devicePixelRatio: 2, viewId: 0 };
          geometryCalls++;
          if (geometryCalls === 2 && change !== 'stable') geometry[change as keyof typeof geometry]++;
          return { ok: true, ...geometry, timings: { totalMs: geometryCalls / 10 } };
        }
        return {
          ok: true,
          widget: {
            type: 'Button',
            enabled: true,
            visible: true,
            bounds: { x: 10, y: 10, width: 20, height: 20 },
          },
        };
      });
      const controller = new AutomationController(
        runtime,
        {
          vmExecute: vm,
          vmConnected: () => true,
          vmIdentity: () => ({ generation: 'one', deviceId: binding.deviceId }),
          vmProcessId: async () => 123,
          vmInvalidate: vi.fn(),
          changed: vi.fn(),
          createNative: () => native as any,
        },
        root,
      );
      controllers.push(controller);
      expect(await controller.execute('connect_device', binding)).toMatchObject({ ok: true });
      await controller.acquireWorkflow('run');
      const result = await controller.executeWorkflow('run', 'tap', { key: 'confirm' });
      expect(result).toMatchObject(
        change === 'stable' ? { ok: true, backend: 'device' } : { ok: false, code: 'LAYOUT_CHANGED' },
      );
      expect(native.perform).toHaveBeenCalledTimes(change === 'stable' ? 1 : 0);
      await controller.releaseWorkflow('run');
    },
  );
  it('separates the existing gesture resolution and input without adding lookups', async () => {
    const { controller, vm } = fixture();
    await controller.acquireWorkflow('owner');
    const result = await controller.executeWorkflow('owner', 'tap', {
      selector: { key: 'confirm' },
      backend: 'flutter',
    });
    expect(result).toMatchObject({ ok: true, timings: { resolveMs: 5, inputMs: 7, totalMs: 12 } });
    expect(vm.mock.calls.map(([tool]) => tool)).toEqual([
      'get_ui_geometry',
      'find_widget',
      'perform_gesture',
    ]);
    await controller.releaseWorkflow('owner');
  });
  it('preserves runtime editor phase measurements and measures transport-inclusive total separately', async () => {
    const { controller, vm } = fixture();
    const result = await controller.execute('enter_text', {
      selector: { key: 'price' },
      text: '1.2300',
      backend: 'flutter',
    });
    expect(result).toMatchObject({ ok: true, timings: { resolveMs: 2, inputMs: 5, totalMs: 12 } });
    expect(vm.mock.calls.map(([tool]) => tool)).toEqual(['enter_text']);
  });
  it('records the whole condition observation as wait time and its lookup cost independently', async () => {
    const { controller, vm } = fixture();
    const result = await controller.execute('wait_for_widget', {
      selector: { key: 'pending' },
      state: 'visible',
    });
    expect(result).toMatchObject({ ok: true, timings: { resolveMs: 3, waitMs: 3, totalMs: 3 } });
    expect(vm).toHaveBeenCalledTimes(1);
  });
  it('keeps completed stage timings when resolution fails and does not reuse them in a later action', async () => {
    const f = fixture();
    f.vm.mockImplementationOnce(async () => {
      f.advance(11);
      return { ok: false, code: 'NOT_FOUND' };
    });
    const first = await f.controller.execute('tap', { selector: { key: 'missing' }, backend: 'flutter' });
    expect(first).toMatchObject({ ok: false, code: 'NOT_FOUND', timings: { resolveMs: 11, totalMs: 11 } });
    expect((first.timings as any).inputMs).toBeUndefined();
    const next = await f.controller.execute('enter_text', {
      selector: { key: 'price' },
      text: '2',
      backend: 'flutter',
    });
    expect(next).toMatchObject({ ok: true, timings: { resolveMs: 2, inputMs: 5, totalMs: 12 } });
  });
  it('preserves intrinsic measurements when an input result is uncertain after cancellation', async () => {
    const f = fixture(),
      abort = new AbortController();
    f.vm.mockImplementationOnce(async () => {
      f.advance(9);
      abort.abort();
      return { ok: true, timings: { resolveMs: 1, inputMs: 4 } };
    });
    const result = await f.controller.execute(
      'enter_text',
      { selector: { key: 'price' }, text: '2', backend: 'flutter' },
      abort.signal,
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'CANCELLED',
      uncertain: true,
      timings: { resolveMs: 1, inputMs: 4, totalMs: 9 },
    });
    expect(f.vm).toHaveBeenCalledTimes(1);
  });
});

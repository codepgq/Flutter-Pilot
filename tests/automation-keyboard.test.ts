import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AutomationController } from '../src/automation/controller';
import type { UiResult } from '../src/vm/ui';

const controllers: AutomationController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
});

function fixture(states: unknown[], hideResult: UiResult = { ok: true }) {
  const runtime = new EventEmitter() as any;
  runtime.dispose = vi.fn();
  runtime.stop = vi.fn();
  let index = 0;
  const vmExecute = vi.fn(async (tool: string): Promise<UiResult> => {
    if (tool === 'get_keyboard_state')
      return { ok: true, shown: states[Math.min(index++, states.length - 1)] };
    if (tool === 'hide_keyboard') return hideResult;
    return { ok: true };
  });
  const controller = new AutomationController(runtime, {
    vmConnected: () => true,
    vmExecute,
    vmInvalidate: vi.fn(),
    changed: vi.fn(),
  });
  controllers.push(controller);
  return { controller, vmExecute };
}

describe('keyboard dismissal before keyed actions', () => {
  it('still sends Flutter hide input when the keyboard initially appears hidden', async () => {
    const { controller, vmExecute } = fixture([false]);
    expect(await controller.execute('hide_keyboard', { backend: 'flutter' })).toMatchObject({
      ok: true,
      shown: false,
      dispatched: true,
    });
    expect(vmExecute.mock.calls.map(([tool]) => tool)).toEqual([
      'get_keyboard_state',
      'hide_keyboard',
      'get_keyboard_state',
      'get_keyboard_state',
    ]);
  });

  it('waits when an initially hidden Flutter keyboard becomes visible asynchronously', async () => {
    const { controller, vmExecute } = fixture([false, true, false, false]);
    expect(await controller.execute('hide_keyboard', { backend: 'flutter' })).toMatchObject({
      ok: true,
      shown: false,
      dispatched: true,
    });
    expect(vmExecute.mock.calls.filter(([tool]) => tool === 'hide_keyboard')).toHaveLength(1);
    expect(vmExecute.mock.calls.filter(([tool]) => tool === 'get_keyboard_state')).toHaveLength(4);
  });

  it('waits for stable hidden observations after an asynchronous keyboard animation', async () => {
    const { controller, vmExecute } = fixture([true, true, false, true, false, false]);
    expect(await controller.execute('hide_keyboard', { backend: 'flutter' })).toMatchObject({
      ok: true,
      shown: false,
      dispatched: true,
    });
    expect(vmExecute.mock.calls.filter(([tool]) => tool === 'hide_keyboard')).toHaveLength(1);
    expect(vmExecute.mock.calls.filter(([tool]) => tool === 'get_keyboard_state')).toHaveLength(6);
  });

  it('fails within its deadline when the keyboard remains visible', async () => {
    const { controller } = fixture([true]);
    expect(await controller.execute('hide_keyboard', { backend: 'flutter', timeoutMs: 100 })).toMatchObject({
      ok: false,
      code: 'KEYBOARD_NOT_HIDDEN',
      dispatched: true,
    });
  });

  it('preserves a hide failure without reporting a hidden keyboard', async () => {
    const { controller, vmExecute } = fixture([true], { ok: false, code: 'UI_UNAVAILABLE' });
    expect(await controller.execute('hide_keyboard', { backend: 'flutter' })).toMatchObject({
      ok: false,
      code: 'UI_UNAVAILABLE',
    });
    expect(vmExecute).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown keyboard state before dispatch', async () => {
    const { controller, vmExecute } = fixture([undefined]);
    expect(await controller.execute('hide_keyboard', { backend: 'flutter' })).toMatchObject({
      ok: false,
      code: 'KEYBOARD_STATE_UNCONFIRMED',
    });
    expect(vmExecute).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-progress wait without sending another hide command', async () => {
    const { controller, vmExecute } = fixture([true]);
    const abort = new AbortController();
    const result = controller.execute('hide_keyboard', { backend: 'flutter' }, abort.signal);
    await vi.waitFor(() => expect(vmExecute).toHaveBeenCalledWith('hide_keyboard', expect.any(Object)));
    abort.abort();
    expect(await result).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(vmExecute.mock.calls.filter(([tool]) => tool === 'hide_keyboard')).toHaveLength(1);
  });

  it('does not hide the keyboard after cancellation during the initial state query', async () => {
    const { controller, vmExecute } = fixture([false]);
    let resolveState!: (value: UiResult) => void;
    vmExecute.mockImplementationOnce(() => new Promise<UiResult>((resolve) => (resolveState = resolve)));
    const abort = new AbortController();
    const result = controller.execute('hide_keyboard', { backend: 'flutter' }, abort.signal);
    await vi.waitFor(() => expect(vmExecute).toHaveBeenCalledWith('get_keyboard_state', expect.any(Object)));
    abort.abort();
    resolveState({ ok: true, shown: false });
    expect(await result).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(vmExecute.mock.calls.filter(([tool]) => tool === 'hide_keyboard')).toHaveLength(0);
  });
});

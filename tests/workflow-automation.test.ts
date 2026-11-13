import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationController } from '../src/automation/controller';
import type { UiResult } from '../src/vm/ui';

const roots: string[] = [];
const controllers: AutomationController[] = [];
const unblock: (() => void)[] = [];

afterEach(async () => {
  for (const resolve of unblock.splice(0)) resolve();
  for (const controller of controllers.splice(0)) await controller.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  unblock.push(resolve);
  return { promise, resolve };
}

async function fixture(options: { root?: string; deviceId?: string; native?: boolean } = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'pilot-workflow-automation-')));
  if (!options.root) roots.push(root);
  const runtime = new EventEmitter() as any;
  runtime.snapshot = {
    installed: true,
    status: 'ready',
    versions: {},
    diagnostics: [],
    devices: options.native
      ? [{ id: options.deviceId, platform: 'ios', kind: 'simulator', state: 'Booted' }]
      : [],
  };
  runtime.inspect = vi.fn(async () => runtime.snapshot);
  runtime.checkPlatform = vi.fn();
  runtime.start = vi.fn(async () => 'http://127.0.0.1:4723');
  runtime.stop = vi.fn();
  runtime.dispose = vi.fn();
  const identity = { generation: 'first', deviceId: options.deviceId };
  const dispatch: string[] = [];
  let onInput: ((key: string) => Promise<void>) | undefined;
  const vmExecute = vi.fn(async (tool: string, args: Record<string, any>): Promise<UiResult> => {
    if (tool === 'press_key') {
      const key = args.keys[0];
      dispatch.push(key);
      await onInput?.(key);
    }
    return { ok: true };
  });
  const vmInvalidate = vi.fn();
  const controller = new AutomationController(
    runtime,
    {
      changed: vi.fn(),
      vmConnected: () => true,
      vmIdentity: () => ({ ...identity }),
      vmExecute,
      vmInvalidate,
      ...(options.native
        ? {
            createNative: (binding: any) =>
              ({
                binding,
                connect: vi.fn(),
                disconnect: vi.fn(),
                capabilities: () => ({}),
                release: vi.fn(),
              }) as any,
          }
        : {}),
    },
    root,
  );
  controllers.push(controller);
  return {
    controller,
    root,
    runtime,
    identity,
    dispatch,
    vmExecute,
    vmInvalidate,
    onInput: (handler: typeof onInput) => (onInput = handler),
  };
}

const key = (keyName: string) => ({ keyName, backend: 'flutter' });

describe('workflow admission and serial execution', () => {
  it('reserves immediately and drains previously accepted work before accepting owner steps', async () => {
    const f = await fixture();
    const gate = deferred();
    f.onInput(async (name) => {
      if (name === 'before-first') await gate.promise;
    });
    const first = f.controller.execute('press_key', key('before-first'));
    const second = f.controller.execute('press_key', key('before-second'));
    let acquired = false;
    const acquisition = f.controller.acquireWorkflow('run').then(() => (acquired = true));
    expect(await f.controller.execute('press_key', key('external'))).toMatchObject({
      ok: false,
      code: 'WORKFLOW_BUSY',
    });
    expect(await f.controller.executeWorkflow('run', 'press_key', key('too-early'))).toMatchObject({
      ok: false,
      code: 'WORKFLOW_BUSY',
    });
    await vi.waitFor(() => expect(f.dispatch).toEqual(['before-first']));
    expect(acquired).toBe(false);
    expect(await f.controller.execute('get_automation_status', {})).toMatchObject({ ok: true });
    expect(f.runtime.inspect).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([first, second, acquisition]);
    expect(await f.controller.executeWorkflow('run', 'press_key', key('workflow'))).toMatchObject({
      ok: true,
    });
    expect(f.dispatch).toEqual(['before-first', 'before-second', 'workflow']);
    await f.controller.releaseWorkflow('run');
    await f.controller.execute('press_key', key('after'));
    expect(f.dispatch).toEqual(['before-first', 'before-second', 'workflow', 'after']);
  });

  it('rejects foreign owners without dispatching work or releasing the owner', async () => {
    const f = await fixture();
    await expect(f.controller.acquireWorkflow('')).rejects.toMatchObject({
      code: 'INVALID_WORKFLOW_OWNER',
    });
    await f.controller.acquireWorkflow('owner');
    await expect(f.controller.acquireWorkflow('other')).rejects.toMatchObject({ code: 'WORKFLOW_BUSY' });
    expect(await f.controller.executeWorkflow('other', 'press_key', key('other'))).toMatchObject({
      ok: false,
      code: 'WORKFLOW_OWNER_MISMATCH',
    });
    await expect(f.controller.releaseWorkflow('other')).rejects.toMatchObject({
      code: 'WORKFLOW_OWNER_MISMATCH',
    });
    expect(await f.controller.execute('find_widget', { key: 'outside' })).toMatchObject({
      code: 'WORKFLOW_BUSY',
    });
    expect(f.dispatch).toEqual([]);
    const firstRelease = f.controller.releaseWorkflow('owner');
    expect(f.controller.releaseWorkflow('owner')).toBe(firstRelease);
    await firstRelease;
    expect(await f.controller.executeWorkflow('owner', 'press_key', key('stale'))).toMatchObject({
      code: 'WORKFLOW_OWNER_MISMATCH',
    });
  });

  it('keeps the reservation while cancellation and an in-flight action settle without replay', async () => {
    const f = await fixture();
    const gate = deferred();
    f.onInput(async () => gate.promise);
    await f.controller.acquireWorkflow('run');
    const action = f.controller.executeWorkflow('run', 'press_key', key('confirm'));
    await vi.waitFor(() => expect(f.dispatch).toEqual(['confirm']));
    f.controller.cancel();
    let released = false;
    const release = f.controller.releaseWorkflow('run').then(() => (released = true));
    expect(await f.controller.execute('press_key', key('external'))).toMatchObject({
      code: 'WORKFLOW_BUSY',
    });
    expect(await f.controller.executeWorkflow('run', 'press_key', key('next'))).toMatchObject({
      code: 'WORKFLOW_BUSY',
    });
    await expect(f.controller.acquireWorkflow('second')).rejects.toMatchObject({ code: 'WORKFLOW_BUSY' });
    expect(released).toBe(false);
    gate.resolve();
    expect(await action).toMatchObject({ ok: false, code: 'CANCELLED', uncertain: true });
    await release;
    expect(f.vmInvalidate).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toEqual(['confirm']);
    await f.controller.acquireWorkflow('second');
    await f.controller.releaseWorkflow('second');
  });

  it('remembers cancellation between steps until that workflow releases its reservation', async () => {
    const f = await fixture();
    await f.controller.acquireWorkflow('run');
    await f.controller.executeWorkflow('run', 'press_key', key('first'));
    f.controller.cancel();
    expect(await f.controller.executeWorkflow('run', 'press_key', key('second'))).toMatchObject({
      ok: false,
      code: 'CANCELLED',
    });
    expect(f.dispatch).toEqual(['first']);
    await f.controller.releaseWorkflow('run');
    await f.controller.acquireWorkflow('next-run');
    await f.controller.executeWorkflow('next-run', 'press_key', key('new-run'));
    await f.controller.releaseWorkflow('next-run');
    expect(f.dispatch).toEqual(['first', 'new-run']);
  });

  it('does not resume a workflow against a new VM generation', async () => {
    const f = await fixture();
    await f.controller.acquireWorkflow('run');
    await f.controller.executeWorkflow('run', 'press_key', key('first'));
    f.identity.generation = 'reconnected';
    expect(await f.controller.executeWorkflow('run', 'press_key', key('second'))).toMatchObject({
      ok: false,
      code: 'SESSION_INVALIDATED',
    });
    expect(f.dispatch).toEqual(['first']);
    await f.controller.releaseWorkflow('run');
  });

  it('does not release a cancelled acquisition until prior accepted work settles', async () => {
    const f = await fixture();
    const gate = deferred();
    f.onInput(async () => gate.promise);
    const previous = f.controller.execute('press_key', key('previous'));
    const acquisition = f.controller.acquireWorkflow('cancelled').catch((error) => error);
    await vi.waitFor(() => expect(f.dispatch).toEqual(['previous']));
    f.controller.cancel();
    expect(await f.controller.execute('press_key', key('external'))).toMatchObject({
      code: 'WORKFLOW_BUSY',
    });
    gate.resolve();
    await previous;
    expect(await acquisition).toMatchObject({ code: 'CANCELLED' });
    await f.controller.acquireWorkflow('new');
    await f.controller.releaseWorkflow('new');
    expect(f.dispatch).toEqual(['previous']);
  });
});

describe('workflow device ownership and disposal', () => {
  it('holds a VM device lease between steps and reuses it for owned inputs', async () => {
    const first = await fixture({ deviceId: 'shared-device' });
    const second = await fixture({ root: first.root, deviceId: 'shared-device' });
    await first.controller.acquireWorkflow('first');
    expect(await first.controller.executeWorkflow('first', 'press_key', key('first-input'))).toMatchObject({
      ok: true,
    });
    expect(await second.controller.execute('press_key', key('outside'))).toMatchObject({
      ok: false,
      code: 'DEVICE_BUSY',
    });
    await expect(second.controller.acquireWorkflow('second')).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    expect(await second.controller.execute('get_automation_status', {})).toMatchObject({ ok: true });
    expect(second.dispatch).toEqual([]);
    await first.controller.releaseWorkflow('first');
    await second.controller.acquireWorkflow('second');
    expect(await second.controller.executeWorkflow('second', 'press_key', key('second-input'))).toMatchObject(
      {
        ok: true,
      },
    );
    await second.controller.releaseWorkflow('second');
    expect(second.dispatch).toEqual(['second-input']);
  });

  it('reuses an existing native connection lease for that same VM device', async () => {
    const f = await fixture({ deviceId: 'native-device', native: true });
    expect(
      await f.controller.execute('connect_device', { deviceId: 'native-device', appId: 'test.app' }),
    ).toMatchObject({ ok: true });
    await f.controller.acquireWorkflow('run');
    expect(await f.controller.executeWorkflow('run', 'press_key', key('input'))).toMatchObject({ ok: true });
    await f.controller.releaseWorkflow('run');
    expect(f.dispatch).toEqual(['input']);
  });

  it('keeps a device leased until an uncertain in-flight action settles during disposal', async () => {
    const first = await fixture({ deviceId: 'shared-device' });
    const second = await fixture({ root: first.root, deviceId: 'shared-device' });
    const gate = deferred();
    first.onInput(async () => gate.promise);
    await first.controller.acquireWorkflow('run');
    const action = first.controller.executeWorkflow('run', 'press_key', key('confirm'));
    await vi.waitFor(() => expect(first.dispatch).toEqual(['confirm']));
    const disposal = first.controller.dispose();
    controllers.splice(controllers.indexOf(first.controller), 1);
    expect(await first.controller.execute('press_key', key('new'))).toMatchObject({
      code: 'SESSION_INVALIDATED',
    });
    await expect(second.controller.acquireWorkflow('second')).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    gate.resolve();
    expect(await action).toMatchObject({ code: 'CANCELLED', uncertain: true });
    await disposal;
    await expect(first.controller.acquireWorkflow('new')).rejects.toMatchObject({
      code: 'SESSION_INVALIDATED',
    });
    await second.controller.acquireWorkflow('second');
    await second.controller.releaseWorkflow('second');
    expect(first.dispatch).toEqual(['confirm']);
  });
});

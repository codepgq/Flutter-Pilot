import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationController } from '../src/automation/controller';
import { DeviceLease } from '../src/automation/lease';
import type { DeviceBinding, Rect } from '../src/automation/model';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const screen = { x: 0, y: 0, width: 400, height: 800 };
const inputBounds = { x: 100, y: 150, width: 200, height: 60 };
const menuBounds = { x: 0, y: 0, width: 80, height: 40 };
const controllers: AutomationController[] = [];
const leases: DeviceLease[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
  for (const lease of leases.splice(0)) await lease.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(
  options: {
    platform?: 'android' | 'ios';
    deviceId?: string;
    vmDeviceId?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-automation-input-test-'));
  roots.push(root);
  const platform = options.platform ?? 'ios';
  const binding: DeviceBinding = {
    platform,
    kind: platform === 'ios' ? 'simulator' : 'emulator',
    deviceId: options.deviceId ?? 'test-device',
    appId: 'test.app',
  };
  const runtime = new EventEmitter() as any;
  runtime.snapshot = {
    status: 'ready',
    installed: true,
    devices: [{ id: binding.deviceId, platform, kind: binding.kind, state: 'Booted' }],
    versions: {},
    diagnostics: [],
  };
  runtime.inspect = async () => runtime.snapshot;
  runtime.start = async () => 'http://127.0.0.1:4723';
  runtime.checkPlatform = vi.fn();
  runtime.stop = vi.fn();
  runtime.dispose = vi.fn();
  const state = {
    activeId: 'editor-b',
    activeIds: [] as string[],
    activeRect: { ...inputBounds } as Rect,
    menuOpen: true,
    menuLabel: 'Cut',
    menuActions: [] as { action: string; editor: string }[],
    values: { 'editor-a': 'alpha', 'editor-b': 'beta' } as Record<string, string>,
    onOpenMenu: undefined as (() => void) | undefined,
    widget: {
      type: 'TextField',
      enabled: true,
      visible: true,
      focused: true,
      bounds: { ...inputBounds },
      inputBounds: { ...inputBounds },
      inputFieldBounds: { ...inputBounds },
      textLength: 4,
      selection: { start: 0, end: 4 },
    },
  };
  const field = {
    type: platform === 'ios' ? 'XCUIElementTypeTextField' : 'android.widget.EditText',
    accessibilityId: 'b',
    enabled: true,
    visible: true,
    bounds: inputBounds,
    xpath: '/field-b',
  };
  const native = {
    binding,
    connect: vi.fn(),
    disconnect: vi.fn(),
    release: vi.fn(),
    capabilities: () => ({}),
    geometry: vi.fn(async () => ({ rect: screen, orientation: 'PORTRAIT' })),
    flutterViewport: async () => screen,
    foreground: async () => true,
    assertNoOverlay: vi.fn(),
    find: vi.fn(async () => field),
    element: vi.fn(async () => 'editor-b'),
    call: vi.fn(async (method: string, path: string, body?: any): Promise<any> => {
      if (path === '/element/active') {
        state.activeId = state.activeIds.shift() ?? state.activeId;
        return { [ELEMENT]: state.activeId };
      }
      if (path.endsWith('/rect')) return state.activeRect;
      if (method === 'POST' && path.endsWith('/clear')) state.values[state.activeId] = '';
      if (method === 'POST' && path.endsWith('/value')) state.values[state.activeId] += body.text;
    }),
    perform: vi.fn(async (tracks: any[]) => {
      const move = tracks[0].actions.find((action: any) => action.type === 'pointerMove');
      if (move.x === menuBounds.width / 2 && move.y === menuBounds.height / 2) {
        state.menuActions.push({ action: state.menuLabel, editor: state.activeId });
        if (state.menuLabel === 'Cut') state.values[state.activeId] = '';
        if (state.menuLabel === 'Paste') state.values[state.activeId] += 'clipboard';
      } else {
        state.activeId = 'editor-b';
        state.menuOpen = true;
        state.onOpenMenu?.();
      }
    }),
    snapshot: vi.fn(async () => ({
      widgets: state.menuOpen
        ? [
            {
              type: 'XCUIElementTypeMenuItem',
              text: state.menuLabel,
              enabled: true,
              visible: true,
              bounds: menuBounds,
            },
          ]
        : [],
    })),
    screenshot: vi.fn(async () => ({ ok: true, backend: 'device' })),
  };
  const vmExecute = vi.fn(async (tool: string, args: Record<string, unknown>): Promise<any> => {
    if (tool === 'get_ui_geometry') return { ok: true, width: screen.width, height: screen.height };
    if (tool === 'find_widget') return { ok: true, widget: structuredClone(state.widget) };
    if (tool === 'enter_text') {
      state.values['editor-b'] =
        args.mode === 'append' ? state.values['editor-b'] + args.text : String(args.text);
    }
    return { ok: true };
  });
  const controller = new AutomationController(
    runtime,
    {
      vmConnected: () => true,
      vmIdentity: () => ({ generation: 'one', deviceId: options.vmDeviceId ?? binding.deviceId }),
      vmProcessId: async () => 123,
      vmExecute,
      vmInvalidate: vi.fn(),
      changed: vi.fn(),
      createNative: () => native as any,
    },
    root,
  );
  controllers.push(controller);
  expect(
    await controller.execute('connect_device', {
      deviceId: binding.deviceId,
      appId: binding.appId,
    }),
  ).toMatchObject({ ok: true });
  return { controller, native, state, vmExecute, root };
}

const nativeTarget = { selector: { source: 'device', accessibilityId: 'b' } };

describe('iOS edit menu ownership', () => {
  it.each(['cut', 'paste'])('rejects %s from another native editor without sending input', async (action) => {
    const { controller, native, state } = await fixture();
    state.activeId = 'editor-a';
    state.menuLabel = action === 'cut' ? 'Cut' : 'Paste';
    // Identical rectangles do not make two native editor identities equivalent.
    expect(await controller.execute('edit_text', { ...nativeTarget, action })).toMatchObject({
      ok: false,
      code: 'EDIT_TARGET_UNCONFIRMED',
    });
    expect(native.perform).not.toHaveBeenCalled();
    expect(state.values).toEqual({ 'editor-a': 'alpha', 'editor-b': 'beta' });
  });

  it('uses an existing menu only when its native editor matches the requested field', async () => {
    const { controller, native, state } = await fixture();
    expect(await controller.execute('edit_text', { ...nativeTarget, action: 'cut' })).toMatchObject({
      ok: true,
      inputMethod: 'native_edit_menu',
    });
    expect(native.perform).toHaveBeenCalledTimes(1);
    expect(state.menuActions).toEqual([{ action: 'Cut', editor: 'editor-b' }]);
    expect(state.values).toEqual({ 'editor-a': 'alpha', 'editor-b': '' });
  });

  it('rechecks the editor immediately before clicking an existing menu', async () => {
    const { controller, native, state } = await fixture();
    state.activeIds = ['editor-b', 'editor-a'];
    expect(await controller.execute('edit_text', { ...nativeTarget, action: 'cut' })).toMatchObject({
      ok: false,
      code: 'EDIT_TARGET_UNCONFIRMED',
    });
    expect(native.perform).not.toHaveBeenCalled();
    expect(state.menuActions).toEqual([]);
  });

  it('does not click a newly opened menu when focus moved to another native editor', async () => {
    const { controller, native, state } = await fixture();
    state.menuOpen = false;
    state.onOpenMenu = () => {
      state.activeId = 'editor-a';
    };
    expect(await controller.execute('edit_text', { ...nativeTarget, action: 'cut' })).toMatchObject({
      ok: false,
      code: 'EDIT_TARGET_UNCONFIRMED',
    });
    expect(native.perform).toHaveBeenCalledTimes(1);
    expect(state.menuActions).toEqual([]);
    expect(state.values).toEqual({ 'editor-a': 'alpha', 'editor-b': 'beta' });
  });

  it('rejects a global menu when the requested Flutter input is not focused', async () => {
    const { controller, native, state } = await fixture();
    state.widget.focused = false;
    expect(await controller.execute('edit_text', { key: 'input-b', action: 'cut' })).toMatchObject({
      ok: false,
      code: 'EDIT_TARGET_UNCONFIRMED',
    });
    expect(native.perform).not.toHaveBeenCalled();
  });

  it('requires the active native editor bounds to match the requested Flutter input', async () => {
    const { controller, native, state } = await fixture();
    state.activeRect = { x: 100, y: 300, width: 200, height: 60 };
    expect(await controller.execute('edit_text', { key: 'input-b', action: 'cut' })).toMatchObject({
      ok: false,
      code: 'EDIT_TARGET_UNCONFIRMED',
    });
    expect(native.perform).not.toHaveBeenCalled();
  });

  it('matches EditableText bounds when a Flutter key is on a larger decorated input', async () => {
    const { controller, native, state } = await fixture();
    state.widget.bounds = { x: 80, y: 130, width: 240, height: 100 };
    expect(await controller.execute('edit_text', { key: 'input-b', action: 'cut' })).toMatchObject({
      ok: true,
      inputMethod: 'native_edit_menu',
    });
    expect(native.perform).toHaveBeenCalledTimes(1);
    expect(state.menuActions).toEqual([{ action: 'Cut', editor: 'editor-b' }]);
  });

  it('maps Flutter editor bounds into the native viewport before matching focus', async () => {
    const { controller, native, state } = await fixture();
    native.flutterViewport = async () => ({ x: 10, y: 20, width: 380, height: 760 });
    state.widget.bounds = { x: 80, y: 130, width: 240, height: 100 };
    state.activeRect = { x: 105, y: 162.5, width: 190, height: 57 };
    expect(await controller.execute('edit_text', { key: 'input-b', action: 'cut' })).toMatchObject({
      ok: true,
      inputMethod: 'native_edit_menu',
    });
    expect(state.menuActions).toEqual([{ action: 'Cut', editor: 'editor-b' }]);
  });

  it('accepts the actual enclosing field frame exposed by iOS accessibility', async () => {
    const { controller, state } = await fixture();
    state.widget.bounds = { x: 80, y: 130, width: 240, height: 100 };
    state.widget.inputFieldBounds = { x: 100, y: 140, width: 200, height: 80 };
    state.activeRect = { ...state.widget.inputFieldBounds };
    expect(await controller.execute('edit_text', { key: 'input-b', action: 'cut' })).toMatchObject({
      ok: true,
      inputMethod: 'native_edit_menu',
    });
    expect(state.menuActions).toEqual([{ action: 'Cut', editor: 'editor-b' }]);
  });

  it('detects a Flutter active editor identity change even when bounds are identical', async () => {
    const { controller, native, state } = await fixture();
    state.activeIds = ['editor-b', 'editor-a'];
    expect(await controller.execute('edit_text', { key: 'input-b', action: 'cut' })).toMatchObject({
      ok: false,
      code: 'EDIT_TARGET_UNCONFIRMED',
    });
    expect(native.perform).not.toHaveBeenCalled();
  });
});

describe('text append capability', () => {
  it.each(['ios', 'android'] as const)(
    'rejects native %s append before positioning or input',
    async (platform) => {
      const { controller, native, state } = await fixture({ platform });
      expect(
        await controller.execute('enter_text', {
          ...nativeTarget,
          mode: 'append',
          text: 'suffix',
        }),
      ).toMatchObject({ ok: false, code: 'UNSUPPORTED_OPERATION' });
      expect(native.find).not.toHaveBeenCalled();
      expect(native.geometry).not.toHaveBeenCalled();
      expect(native.perform).not.toHaveBeenCalled();
      expect(native.call).not.toHaveBeenCalled();
      expect(state.values['editor-b']).toBe('beta');
    },
  );

  it('preserves explicit Flutter append through the editing protocol', async () => {
    const { controller, native, state, vmExecute } = await fixture();
    expect(
      await controller.execute('enter_text', {
        key: 'input-b',
        backend: 'flutter',
        mode: 'append',
        text: 'suffix',
      }),
    ).toMatchObject({ ok: true, backend: 'flutter', inputMethod: 'flutter_editing_protocol' });
    expect(vmExecute).toHaveBeenCalledWith('enter_text', {
      key: { type: 'string', value: 'input-b' },
      backend: 'flutter',
      mode: 'append',
      text: 'suffix',
    });
    expect(state.values['editor-b']).toBe('betasuffix');
    expect(native.perform).not.toHaveBeenCalled();
  });

  it('still clears and types for native replacement', async () => {
    const { controller, native, state } = await fixture();
    expect(
      await controller.execute('enter_text', {
        ...nativeTarget,
        mode: 'replace',
        text: 'new text',
      }),
    ).toMatchObject({ ok: true, inputMethod: 'native_text_editing' });
    expect(native.call.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ['GET', '/element/active'],
      ['POST', '/element/editor-b/clear'],
      ['POST', '/element/editor-b/value'],
    ]);
    expect(state.values).toEqual({ 'editor-a': 'alpha', 'editor-b': 'new text' });
  });
});

describe('long screenshot VM device lease', () => {
  it('locks the VM device independently of a connected native device', async () => {
    const { controller, vmExecute, root } = await fixture({ deviceId: 'native-b', vmDeviceId: 'vm-a' });
    const otherOwner = new DeviceLease(root);
    leases.push(otherOwner);
    await otherOwner.acquire('vm-a');
    const args = { mode: 'long', rawParts: true, key: 'list' };
    expect(await controller.execute('take_screenshot', args)).toMatchObject({
      ok: false,
      code: 'DEVICE_BUSY',
    });
    expect(vmExecute).not.toHaveBeenCalled();
    await otherOwner.release();
    expect(await controller.execute('take_screenshot', args)).toMatchObject({ ok: true });
    expect(vmExecute).toHaveBeenCalledWith('take_screenshot', {
      ...args,
      key: { type: 'string', value: 'list' },
    });
    // A completed screenshot releases only its temporary VM lease.
    await otherOwner.acquire('vm-a');
    const nativeOwner = new DeviceLease(root);
    await expect(nativeOwner.acquire('native-b')).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
  });

  it('reuses the lease when the native connection owns the VM device', async () => {
    const { controller, vmExecute } = await fixture();
    expect(
      await controller.execute('take_screenshot', {
        mode: 'long',
        rawParts: true,
        key: 'list',
      }),
    ).toMatchObject({ ok: true });
    expect(vmExecute).toHaveBeenCalledTimes(1);
  });

  it('does not lock an unrelated VM for native screen screenshots', async () => {
    const { controller, native, vmExecute, root } = await fixture({
      deviceId: 'native-b',
      vmDeviceId: 'vm-a',
    });
    const otherOwner = new DeviceLease(root);
    leases.push(otherOwner);
    await otherOwner.acquire('vm-a');
    expect(
      await controller.execute('take_screenshot', {
        source: 'device',
        mode: 'screen',
      }),
    ).toMatchObject({ ok: true, backend: 'device' });
    expect(native.screenshot).toHaveBeenCalledTimes(1);
    expect(vmExecute).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { buildGesture } from '../src/automation/gestures';
import { mapFlutterPoint, AutomationError, type DeviceBinding } from '../src/automation/model';
import { DeviceLease } from '../src/automation/lease';
import { NativeSession, parseNativeSource, matchNative, WebDriverClient } from '../src/automation/native';
import { AutomationController } from '../src/automation/controller';
import { AutomationRuntime, compatibleNode, patchManagedSimulatorAttach } from '../src/automation/runtime';
import { parseTool } from '../src/mcp/tools';
import type { UiResult } from '../src/vm/ui';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-automation-test-'));
  roots.push(root);
  return root;
};
const screen = { x: 0, y: 0, width: 400, height: 800 },
  center = { x: 200, y: 400 };
const xml = `<hierarchy><node class="android.widget.FrameLayout" resource-id="root" bounds="[0,0][400,800]"><node class="android.widget.Button" text="确认 &amp; 继续" content-desc="confirm" enabled="true" bounds="[10,20][100,60]"/><node class="android.widget.Button" text="确认 &amp; 继续" enabled="false" bounds="[10,70][100,110]"/><node class="android.widget.EditText" text="secret" password="true" bounds="[0,120][300,180]"/></node></hierarchy>`;
const binding: DeviceBinding = {
  deviceId: 'test-device',
  appId: 'test.app',
  platform: 'android',
  kind: 'emulator',
};

describe('mobile selectors and protocol', () => {
  it('preserves typed legacy keys and rejects conflicting/empty targets', () => {
    expect(parseTool('tap', { sessionId: 's', key: 42, ancestorKey: 'list' })).toMatchObject({ key: 42 });
    for (const args of [
      {},
      { key: 'x', selector: { text: 'x' } },
      { selector: {} },
      { selector: { source: 'device', key: 'x' } },
      { point: { x: -1, y: 2 } },
    ])
      expect(() => parseTool('tap', { sessionId: 's', ...args })).toThrow();
    expect(
      parseTool('tap', {
        sessionId: 's',
        selector: { source: 'device', text: '允许', ancestor: { type: 'Alert' } },
      }),
    ).toHaveProperty('selector');
    expect(() =>
      parseTool('edit_text', { sessionId: 's', key: 'input', action: 'select_range', start: 0 }),
    ).toThrow();
    expect(() =>
      parseTool('wait_for_widget', { sessionId: 's', key: 'status', state: 'text_changed' }),
    ).toThrow();
  });
  it('parses ordered Android/iOS source, hierarchy and secure inputs', () => {
    const nodes = parseNativeSource(xml, 'snapshot');
    expect(matchNative(nodes, { text: '确认 & 继续' })).toHaveLength(2);
    expect(matchNative(nodes, { accessibilityId: 'confirm', ancestor: { resourceId: 'root' } })).toHaveLength(
      1,
    );
    const scoped = parseNativeSource(
      '<root><section name="inside"><button text="same"/></section><button text="same"/></root>',
      'scoped',
    );
    expect(
      matchNative(scoped, { text: 'same', ancestor: { type: 'root' } }, { accessibilityId: 'inside' }),
    ).toHaveLength(1);
    expect(nodes.find((n) => n.obscured)).not.toHaveProperty('text');
    expect(nodes[2].xpath).toBe('/hierarchy[1]/node[1]/node[1]');
    const ios = parseNativeSource(
      '<AppiumAUT><XCUIElementTypeApplication x="0" y="0" width="400" height="800"><XCUIElementTypeButton name="ok" label="确定" x="5" y="10" width="90" height="50" visible="true" enabled="true"/></XCUIElementTypeApplication></AppiumAUT>',
      'ios',
    );
    expect(matchNative(ios, { accessibilityId: 'ok', type: 'XCUIElementTypeButton' })[0]).toMatchObject({
      visible: true,
      bounds: { x: 5, y: 10 },
    });
    expect(() => parseNativeSource('<!DOCTYPE foo><foo/>', 'bad')).toThrow();
    expect(() => parseNativeSource('<foo>', 'bad')).toThrow();
  });
  it('restricts Appium to loopback', () => {
    expect(() => new WebDriverClient('http://192.168.1.2:4723')).toThrow();
    expect(() => new WebDriverClient('http://127.0.0.1:4723')).not.toThrow();
  });
  it.each(['ios', 'android'] as const)(
    'resolves a %s snapshot node against the driver XPath document',
    async (platform) => {
      const source =
        platform === 'ios'
          ? '<AppiumAUT><XCUIElementTypeApplication><XCUIElementTypeTextField name="editor" x="1" y="2" width="100" height="40"/></XCUIElementTypeApplication></AppiumAUT>'
          : xml;
      const node = parseNativeSource(source, 'xpath').find((item) => /TextField|EditText/.test(item.type))!;
      const lookup = vi.fn();
      const session = new NativeSession(
        { ...binding, platform, kind: platform === 'ios' ? 'simulator' : 'emulator' },
        async (_method, path, body) => {
          if (path === '/session') return { sessionId: 'xpath-session' };
          if (path.endsWith('/orientation')) return 'PORTRAIT';
          if (path.endsWith('/elements')) {
            lookup(body);
            return [{ 'element-6066-11e4-a52e-4f735466cecf': 'editor/id' }];
          }
        },
      );
      await session.connect();
      try {
        expect(await session.element(node)).toBe('editor%2Fid');
        expect(lookup).toHaveBeenCalledWith({
          using: 'xpath',
          value:
            platform === 'ios' ? '/XCUIElementTypeApplication[1]/XCUIElementTypeTextField[1]' : node.xpath,
        });
      } finally {
        await session.disconnect();
      }
    },
  );
  it('attaches without relaunch/reset/permission changes and releases a late-created cancelled session', async () => {
    const calls: any[] = [];
    const abort = new AbortController();
    const session = new NativeSession(binding, async (method, path, body) => {
      calls.push({ method, path, body });
      if (path === '/session') {
        abort.abort();
        return { sessionId: 'new-session' };
      }
      return 'PORTRAIT';
    });
    await expect(session.connect(abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    const caps = calls[0].body.capabilities.alwaysMatch;
    expect(caps).toMatchObject({
      'appium:noReset': true,
      'appium:autoLaunch': false,
      'appium:autoGrantPermissions': false,
      'appium:shouldTerminateApp': false,
    });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/session/new-session')).toBe(true);
  });
  it('invalidates native refs after a source change and reports ambiguous candidates', async () => {
    let source = xml;
    const session = new NativeSession(binding, async (_method, path) => {
      if (path === '/session') return { sessionId: 's' };
      if (path.endsWith('/source')) return source;
      if (path.endsWith('/window/rect')) return screen;
      return 'PORTRAIT';
    });
    await session.connect();
    const snapshot = await session.snapshot();
    const ref = snapshot.widgets.find((n) => n.accessibilityId === 'confirm')!.ref;
    expect((await session.find({ ref })).ref).toBe(ref);
    await expect(session.find({ text: '确认 & 继续' })).rejects.toMatchObject({
      code: 'AMBIGUOUS_SELECTOR',
      candidates: expect.any(Array),
    });
    source = xml.replace('[10,20][100,60]', '[20,20][110,60]');
    await expect(session.find({ ref })).rejects.toMatchObject({ code: 'STALE_REFERENCE' });
    await session.disconnect();
  });
  it('releases every pointer/key source after a failed action', async () => {
    const paths: string[] = [];
    const session = new NativeSession(binding, async (method, path) => {
      paths.push(`${method} ${path}`);
      if (path === '/session') return { sessionId: 's' };
      if (method === 'POST' && path.endsWith('/actions'))
        throw new AutomationError('TIMEOUT', 'unknown', true);
      return 'PORTRAIT';
    });
    await session.connect();
    await expect(session.perform(buildGesture('tap', {}, center, screen))).rejects.toMatchObject({
      uncertain: true,
    });
    expect(paths.at(-1)).toBe('DELETE /session/s/actions');
    await session.disconnect();
  });
  it('uses native iOS hardware key names and reports unavailable modifier operations per device', async () => {
    const ios = { ...binding, platform: 'ios', kind: 'simulator' } as DeviceBinding;
    const runtime = new EventEmitter() as any;
    runtime.snapshot = {
      status: 'ready',
      installed: true,
      devices: [{ id: ios.deviceId, platform: 'ios', kind: 'simulator', state: 'Booted' }],
      versions: {},
      diagnostics: [],
    };
    runtime.inspect = async () => runtime.snapshot;
    runtime.start = async () => 'http://127.0.0.1:4723';
    runtime.checkPlatform = vi.fn();
    runtime.stop = vi.fn();
    runtime.dispose = vi.fn();
    const commands: any[] = [];
    let unavailable = false;
    const native = new NativeSession(ios, async (_method, path, body: any) => {
      if (path === '/session') return { sessionId: 'ios' };
      if (path.endsWith('/execute/sync')) {
        commands.push(body);
        if (unavailable) throw new AutomationError('UNSUPPORTED_OPERATION', 'typeKey unavailable');
      }
      return 'PORTRAIT';
    });
    const controller = new AutomationController(
      runtime,
      {
        vmConnected: () => false,
        vmExecute: vi.fn(),
        vmInvalidate: vi.fn(),
        changed: vi.fn(),
        createNative: () => native,
      },
      await temp(),
    );
    expect(
      (await controller.execute('connect_device', { deviceId: ios.deviceId, appId: ios.appId })).ok,
    ).toBe(true);
    expect((await controller.execute('press_key', { keyName: 'ArrowLeft', modifiers: ['Shift'] })).ok).toBe(
      true,
    );
    expect(commands[0]).toEqual({
      script: 'mobile: keys',
      args: [{ keys: [{ key: 'XCUIKeyboardKeyLeftArrow', modifierFlags: 2 }] }],
    });
    unavailable = true;
    expect((await controller.execute('press_key', { keyName: 'a', modifiers: ['Meta'] })).code).toBe(
      'UNSUPPORTED_OPERATION',
    );
    expect(native.capabilities()['press_key.navigation']).toMatchObject({
      supported: false,
      reason: expect.any(String),
    });
    expect(commands).toHaveLength(2);
    await controller.dispose();
  });
});

describe('gesture timelines and coordinates', () => {
  it('stops native editing when opening a menu changes the Flutter selection', async () => {
    const ios = { ...binding, platform: 'ios', kind: 'simulator' } as DeviceBinding;
    const runtime = new EventEmitter() as any;
    runtime.snapshot = {
      status: 'ready',
      installed: true,
      devices: [{ id: ios.deviceId, platform: 'ios', kind: 'simulator', state: 'Booted' }],
      versions: {},
      diagnostics: [],
    };
    runtime.inspect = async () => runtime.snapshot;
    runtime.start = async () => 'http://127.0.0.1:4723';
    runtime.checkPlatform = vi.fn();
    runtime.stop = vi.fn();
    runtime.dispose = vi.fn();
    let menuOpen = false,
      selectionChanged = false;
    const input = vi.fn(async () => {
      menuOpen = true;
      selectionChanged = true;
    });
    const native = {
      binding: ios,
      connect: vi.fn(),
      disconnect: vi.fn(),
      release: vi.fn(),
      capabilities: () => ({}),
      geometry: async () => ({ rect: screen, orientation: 'PORTRAIT' }),
      flutterViewport: async () => screen,
      foreground: async () => true,
      assertNoOverlay: vi.fn(),
      call: async (_method: string, path: string) =>
        path === '/element/active'
          ? { 'element-6066-11e4-a52e-4f735466cecf': 'fixture-input' }
          : { x: 100, y: 100, width: 100, height: 50 },
      perform: input,
      snapshot: async () => ({
        widgets: menuOpen
          ? [
              {
                type: 'XCUIElementTypeMenuItem',
                text: 'Copy',
                visible: true,
                enabled: true,
                bounds: { x: 100, y: 80, width: 60, height: 40 },
              },
            ]
          : [],
      }),
    } as any;
    const controller = new AutomationController(
      runtime,
      {
        vmConnected: () => true,
        vmIdentity: () => ({ generation: 'one', deviceId: ios.deviceId }),
        vmProcessId: async () => 123,
        vmInvalidate: vi.fn(),
        changed: vi.fn(),
        createNative: () => native,
        vmExecute: async (tool) =>
          tool === 'get_ui_geometry'
            ? { ok: true, width: 400, height: 800 }
            : {
                ok: true,
                widget: {
                  type: 'TextField',
                  enabled: true,
                  visible: true,
                  focused: true,
                  textLength: 4,
                  selection: selectionChanged ? { start: 2, end: 2 } : { start: 0, end: 4 },
                  selectionPoint: { x: 120, y: 120 },
                  bounds: { x: 100, y: 100, width: 100, height: 50 },
                },
              },
      },
      await temp(),
    );
    expect(
      (await controller.execute('connect_device', { deviceId: ios.deviceId, appId: ios.appId })).ok,
    ).toBe(true);
    expect((await controller.execute('edit_text', { key: 'input', action: 'copy' })).code).toBe(
      'EDIT_SELECTION_CHANGED',
    );
    expect(input).toHaveBeenCalledTimes(1);
    selectionChanged = false;
    expect(await controller.execute('edit_text', { key: 'input', action: 'copy' })).toMatchObject({
      ok: true,
      backend: 'device',
      inputMethod: 'native_edit_menu',
    });
    expect(input).toHaveBeenCalledTimes(2);
    await controller.dispose();
  });
  it('builds double taps, holds, drags and curved synchronized two-finger gestures', () => {
    const double = buildGesture('double_tap', {}, center, screen)[0].actions;
    expect(double.filter((a) => a.type === 'pointerDown')).toHaveLength(2);
    expect(buildGesture('long_press', { durationMs: 700 }, center, screen)[0].actions).toContainEqual({
      type: 'pause',
      duration: 700,
    });
    const drag = buildGesture('drag', { holdMs: 600 }, center, screen, { x: 250, y: 450 });
    expect(drag[0].actions).toContainEqual({
      type: 'pointerMove',
      x: 250,
      y: 450,
      origin: 'viewport',
      duration: 30,
    });
    const rotate = buildGesture('rotate_gesture', { angleDegrees: 180 }, center, screen);
    expect(rotate).toHaveLength(2);
    expect(rotate[0].actions.length).toBe(rotate[1].actions.length);
    expect(rotate[0].actions.length).toBeGreaterThan(10);
  });
  it('interpolates custom tracks on a shared clock and rejects bounds/duration errors', () => {
    const fingers = [
      {
        points: [
          { x: 10, y: 10, timeMs: 0 },
          { x: 20, y: 20, timeMs: 100 },
          { x: 30, y: 30, timeMs: 200 },
        ],
      },
      {
        points: [
          { x: 30, y: 30, timeMs: 0 },
          { x: 10, y: 10, timeMs: 200 },
        ],
      },
    ];
    const tracks = buildGesture('perform_gesture', { fingers }, center, screen);
    expect(tracks[1].actions).toContainEqual({
      type: 'pointerMove',
      x: 20,
      y: 20,
      duration: 100,
      origin: 'viewport',
    });
    expect(() => buildGesture('drag', { durationMs: 10001 }, center, screen, center)).toThrow();
    expect(() => buildGesture('pinch', { scale: 5 }, { x: 3, y: 3 }, screen)).toThrow();
    expect(() =>
      buildGesture(
        'perform_gesture',
        {
          fingers: [
            {
              points: [
                { x: 1, y: 1, timeMs: 0 },
                { x: 2, y: 2, timeMs: 0 },
              ],
            },
          ],
        },
        center,
        screen,
      ),
    ).toThrow();
  });
  it('maps window origin and uniform scale and rejects stale orientation/aspect assumptions', () => {
    expect(
      mapFlutterPoint(
        { x: 10, y: 20, width: 40, height: 20 },
        { width: 200, height: 400 },
        { x: 5, y: 10, width: 400, height: 800 },
      ),
    ).toEqual({ x: 65, y: 70 });
    expect(() =>
      mapFlutterPoint(screen, { width: 400, height: 800 }, { x: 0, y: 0, width: 800, height: 400 }),
    ).toThrow();
    expect(() => mapFlutterPoint({ ...screen, x: -20 }, screen, screen)).toThrow();
  });
});

describe('ownership, runtime and routing', () => {
  it('blocks VM-only input when another workspace holds the device lease', async () => {
    const root = await temp(),
      owner = new DeviceLease(root);
    await owner.acquire('phone');
    const runtime = new EventEmitter() as any;
    runtime.snapshot = { status: 'idle', diagnostics: [], devices: [] };
    runtime.stop = vi.fn();
    runtime.dispose = vi.fn();
    const vmExecute = vi.fn();
    const controller = new AutomationController(
      runtime,
      {
        vmConnected: () => true,
        vmIdentity: () => ({ generation: 'one', deviceId: 'phone' }),
        vmExecute,
        vmInvalidate: vi.fn(),
        changed: vi.fn(),
      },
      root,
    );
    expect((await controller.execute('tap', { key: 'button' })).code).toBe('DEVICE_BUSY');
    expect(vmExecute).not.toHaveBeenCalled();
    await controller.dispose();
    await owner.release();
  });
  it('reports cancellation without replay and releases input after the in-flight command settles', async () => {
    const runtime = new EventEmitter() as any;
    runtime.snapshot = {
      status: 'ready',
      installed: true,
      devices: [{ ...binding, id: binding.deviceId, state: 'device' }],
      diagnostics: [],
    };
    runtime.inspect = async () => runtime.snapshot;
    runtime.checkPlatform = vi.fn();
    runtime.start = async () => 'http://127.0.0.1:4723';
    runtime.stop = vi.fn();
    runtime.dispose = vi.fn();
    let settle: (() => void) | undefined;
    const native = {
      binding,
      capabilities: () => ({}),
      connect: vi.fn(),
      disconnect: vi.fn(),
      geometry: async () => ({ rect: screen, orientation: 'PORTRAIT' }),
      release: vi.fn(),
      perform: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      ),
    } as any;
    const controller = new AutomationController(
      runtime,
      {
        vmConnected: () => true,
        vmExecute: vi.fn(),
        vmInvalidate: vi.fn(),
        changed: vi.fn(),
        createNative: () => native,
      },
      await temp(),
    );
    await controller.execute('connect_device', { deviceId: binding.deviceId, appId: binding.appId });
    const operation = controller.execute('tap', { point: center });
    await vi.waitFor(() => expect(settle).toBeDefined());
    controller.cancel();
    expect(native.release).toHaveBeenCalledTimes(1);
    settle!();
    expect(await operation).toMatchObject({ ok: false, code: 'CANCELLED', uncertain: true });
    expect(native.perform).toHaveBeenCalledTimes(1);
    await controller.dispose();
  });
  it('fails closed when the pinned attach adapter source changes and makes its patches idempotent', async () => {
    const root = await temp();
    const fixtures = [
      [
        'node_modules/appium-xcuitest-driver/build/lib/commands/simulator.js',
        'export async function startSim() { return await this.device.run(); }',
      ],
      [
        'node_modules/appium-xcuitest-driver/build/lib/commands/wda/stop.js',
        'if ((!this.wda.webDriverAgentUrl && this.opts.useNewWDA) || this.wda.canSkipXcodebuild) { await this.wda.quit(); }',
      ],
      [
        'node_modules/appium-xcuitest-driver/build/lib/commands/wda/startup.js',
        'async function cleanupApps(driver, keepBundleIds = []) { await driver.device.removeApp("other.wda"); }',
      ],
      [
        'node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/build/lib/utils/processes.js',
        'export async function resetTestProcesses(udid, isSimulator) { throw new Error("do not kill unrelated processes"); }',
      ],
    ];
    for (const [file, source] of fixtures) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), source);
    }
    await patchManagedSimulatorAttach(root);
    const patched = await readFile(join(root, fixtures[0][0]), 'utf8');
    expect(patched).toContain('requires an already booted simulator');
    await patchManagedSimulatorAttach(root);
    expect(await readFile(join(root, fixtures[0][0]), 'utf8')).toBe(patched);
    await writeFile(join(root, fixtures[0][0]), 'export const incompatible = true;');
    await expect(patchManagedSimulatorAttach(root)).rejects.toMatchObject({
      code: 'DRIVER_ADAPTER_MISMATCH',
    });
  });
  it('preserves the previous install pointer after failure, removes staging, and can retry', async () => {
    const root = await temp(),
      resources = join(root, 'resources'),
      managed = join(root, 'managed');
    await mkdir(resources);
    await mkdir(managed);
    await writeFile(join(resources, 'package.json'), '{}');
    await writeFile(join(resources, 'package-lock.json'), '{}');
    const old = JSON.stringify({ directory: 'old-valid-runtime', lockHash: 'previous' });
    await writeFile(join(managed, 'current.json'), old);
    const runtime = new AutomationRuntime({ root: managed, resources, nodePath: process.execPath });
    vi.spyOn(runtime, 'inspect').mockImplementation(async () => {
      Object.assign(runtime, { nodePath: process.execPath, npmPath: 'npm' });
      return runtime.snapshot;
    });
    const command = vi
      .spyOn(runtime as any, 'run')
      .mockRejectedValue(new AutomationError('AUTOMATION_SETUP_FAILED', 'fixture install failure'));
    await expect(runtime.setup()).rejects.toMatchObject({ code: 'AUTOMATION_SETUP_FAILED' });
    expect(await readFile(join(managed, 'current.json'), 'utf8')).toBe(old);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(managed, 'runtimes'))).toEqual([]);
    const abort = new AbortController();
    abort.abort();
    command.mockRejectedValue(new AutomationError('CANCELLED', 'fixture cancelled retry'));
    await expect(runtime.setup(abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(command).toHaveBeenCalledTimes(2);
    expect(await readFile(join(managed, 'current.json'), 'utf8')).toBe(old);
    await runtime.dispose();
  });
  it('waits for a cancelled installer child to exit before reporting cancellation', async () => {
    const root = await temp(),
      runtime = new AutomationRuntime({ root, resources: root });
    const abort = new AbortController();
    const operation = (runtime as any).run(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      root,
      abort.signal,
    );
    setTimeout(() => abort.abort(), 40);
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' });
    await runtime.dispose();
  });
  it('uses native input when connected, refuses changed layouts, and never replays failed device actions', async () => {
    const runtime = new EventEmitter() as any;
    runtime.snapshot = {
      status: 'ready',
      installed: true,
      devices: [{ id: binding.deviceId, platform: 'android', kind: 'emulator', state: 'device' }],
      diagnostics: [],
      versions: {},
    };
    runtime.inspect = async () => runtime.snapshot;
    runtime.start = async () => 'http://127.0.0.1:4723';
    runtime.checkPlatform = vi.fn();
    runtime.androidAppProcess = async () => [123];
    runtime.stop = vi.fn();
    runtime.dispose = vi.fn();
    let generation = 'one',
      calls = 0,
      layoutChanged = false;
    const input = vi.fn(async () => {});
    const native = {
      binding,
      connect: vi.fn(),
      disconnect: vi.fn(),
      capabilities: () => ({}),
      geometry: async () => ({ rect: screen, orientation: 'PORTRAIT' }),
      flutterViewport: async () => screen,
      assertNoOverlay: vi.fn(),
      foreground: async () => true,
      perform: input,
      release: vi.fn(),
    } as any;
    const vmExecute = vi.fn(async (tool: string, _args?: any): Promise<UiResult> => {
      if (tool === 'get_ui_geometry') return { ok: true, width: 400, height: 800 };
      calls++;
      return {
        ok: true,
        widget: {
          type: 'Button',
          enabled: true,
          visible: true,
          bounds: { x: layoutChanged && calls % 2 === 0 ? 150 : 100, y: 100, width: 100, height: 50 },
        },
      };
    });
    const controller = new AutomationController(
      runtime,
      {
        vmConnected: () => true,
        vmIdentity: () => ({ generation, deviceId: binding.deviceId }),
        vmProcessId: async () => 123,
        vmExecute,
        vmInvalidate: vi.fn(),
        changed: vi.fn(),
        createNative: () => native,
      },
      await temp(),
    );
    expect(
      (await controller.execute('connect_device', { deviceId: binding.deviceId, appId: binding.appId })).ok,
    ).toBe(true);
    expect((await controller.execute('tap', { key: 'button' })).backend).toBe('device');
    expect(input).toHaveBeenCalledTimes(1);
    layoutChanged = true;
    expect((await controller.execute('tap', { key: 'button' })).code).toBe('LAYOUT_CHANGED');
    expect(input).toHaveBeenCalledTimes(1);
    layoutChanged = false;
    input.mockRejectedValueOnce(new AutomationError('DEVICE_CONNECTION_FAILED', 'fixture', true));
    expect(await controller.execute('tap', { key: 'button' })).toMatchObject({ ok: false, uncertain: true });
    expect(vmExecute.mock.calls.some(([tool]) => tool === 'perform_gesture')).toBe(false);
    generation = 'two';
    expect((await controller.execute('tap', { key: 'button' })).code).toBe('VM_DEVICE_UNCONFIRMED');
    generation = 'one';
    let settlesAt = 0,
      settlingChecks = 0;
    input.mockImplementation(async () => {
      settlesAt = Date.now() + 220;
    });
    vmExecute.mockImplementation(async (tool: string, args?: any) => {
      if (tool === 'get_ui_geometry') return { ok: true, width: 400, height: 800 };
      const visible = Date.now() >= settlesAt;
      if (!visible) settlingChecks++;
      if (tool === 'get_scroll_state') return { ok: true, scrolling: !visible };
      return {
        ok: true,
        widget: {
          type: 'Button',
          enabled: true,
          visible: args?.selector?.text === 'target' ? settlesAt > 0 && visible : visible,
          bounds: { x: 100, y: 100, width: 100, height: 50 },
        },
      };
    });
    const before = input.mock.calls.length;
    expect(
      await controller.execute('scroll', {
        key: 'region',
        direction: 'down',
        targetSelector: { text: 'target' },
        maxSteps: 3,
      }),
    ).toMatchObject({ ok: true, steps: 1 });
    expect(settlingChecks).toBeGreaterThan(0);
    expect(input.mock.calls.length - before).toBe(1);
    await controller.dispose();
  });
  it('leases the same device exclusively across independent controllers and releases only its own lease', async () => {
    const root = await temp(),
      first = new DeviceLease(root),
      second = new DeviceLease(root);
    await first.acquire('phone');
    await expect(second.acquire('phone')).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    await second.release();
    await expect(second.acquire('phone')).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    await first.release();
    await second.acquire('phone');
    await second.release();
  });
  it('recognizes supported Node ranges and inspects without preparing/downloading', async () => {
    expect(['v20.19.0', 'v22.12.0', 'v24.0.0', 'v26.8.1'].every(compatibleNode)).toBe(true);
    expect(['v20.18.9', 'v22.11.9', 'v21.10.0', 'v23.1.0'].some(compatibleNode)).toBe(false);
    const root = await temp();
    const runtime = new AutomationRuntime({
      root: join(root, 'runtime'),
      resources: join(process.cwd(), 'resources/automation'),
      nodePath: process.execPath,
    });
    expect((await runtime.inspect(false)).installed).toBe(false);
    await expect(readFile(join(root, 'runtime/current.json'))).rejects.toHaveProperty('code', 'ENOENT');
    await runtime.dispose();
  });
  it('keeps native failures on their selected backend and serializes VM gestures', async () => {
    const runtime = new EventEmitter() as any;
    runtime.snapshot = { status: 'idle', installed: false, devices: [], diagnostics: [], versions: {} };
    runtime.dispose = vi.fn();
    runtime.stop = vi.fn();
    const calls: string[] = [];
    const controller = new AutomationController(
      runtime,
      {
        vmConnected: () => true,
        vmInvalidate: vi.fn(),
        changed: vi.fn(),
        vmExecute: async (tool) => {
          calls.push(tool);
          if (tool === 'get_ui_geometry') return { ok: true, width: 400, height: 800 };
          if (tool === 'find_widget')
            return {
              ok: true,
              widget: { enabled: true, visible: true, bounds: { x: 100, y: 100, width: 100, height: 50 } },
            };
          await new Promise((resolve) => setTimeout(resolve, 2));
          return { ok: true };
        },
      },
      await temp(),
    );
    expect((await controller.execute('tap', { point: center, backend: 'device' })).code).toBe(
      'DEVICE_DISCONNECTED',
    );
    expect(calls).toEqual([]);
    await Promise.all([
      controller.execute('tap', { key: 'submit' }),
      controller.execute('tap', { key: 'submit' }),
    ]);
    expect(calls).toEqual([
      'get_ui_geometry',
      'find_widget',
      'perform_gesture',
      'get_ui_geometry',
      'find_widget',
      'perform_gesture',
    ]);
    await controller.dispose();
  });
});

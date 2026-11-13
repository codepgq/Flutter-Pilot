import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { UiResult } from '../vm/ui';
import { executeMcpScreenshot } from '../screenshot';
import { AutomationRuntime } from './runtime';
import { NativeSession, WebDriverClient, validRect, type NativeNode } from './native';
import { DeviceLease } from './lease';
import { buildGesture, type PointerTrack } from './gestures';
import {
  AutomationError,
  checkCancelled,
  fail,
  flutterArgs,
  mapFlutterPoint,
  pause,
  selectorFor,
  success,
  type AutomationState,
  type DeviceBinding,
  type Point,
  type Rect,
  type Selector,
} from './model';

export interface AutomationHost {
  vmExecute(tool: string, args: Record<string, unknown>): Promise<UiResult>;
  vmInvalidate(): void;
  vmConnected(): boolean;
  vmIdentity?(): { generation: string; deviceId?: string };
  vmProcessId?(): Promise<number | undefined>;
  projectSessionId?(): string;
  changed(): void;
  createNative?(binding: DeviceBinding, endpoint: string): NativeSession;
}
interface Resolved {
  point: Point;
  bounds: Rect;
  screen: Rect;
  nativeNode?: NativeNode;
  flutter?: Record<string, any>;
  geometry?: any;
}
const gestureNames = new Set([
  'tap',
  'double_tap',
  'long_press',
  'drag',
  'swipe',
  'pinch',
  'rotate_gesture',
  'perform_gesture',
]);
const keyCodes: Record<string, string> = {
  Enter: '\uE007',
  Backspace: '\uE003',
  Delete: '\uE017',
  Tab: '\uE004',
  Escape: '\uE00C',
  ArrowLeft: '\uE012',
  ArrowUp: '\uE013',
  ArrowRight: '\uE014',
  ArrowDown: '\uE015',
  Home: '\uE011',
  End: '\uE010',
  PageUp: '\uE00E',
  PageDown: '\uE00F',
  Space: ' ',
  Control: '\uE009',
  Shift: '\uE008',
  Alt: '\uE00A',
  Meta: '\uE03D',
};
const iosKeys: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Delete',
  Delete: 'ForwardDelete',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowLeft: 'LeftArrow',
  ArrowUp: 'UpArrow',
  ArrowRight: 'RightArrow',
  ArrowDown: 'DownArrow',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Space: 'Space',
  Control: 'Control',
  Shift: 'Shift',
  Alt: 'Option',
  Meta: 'Command',
};

/** One serial route for both workbench and MCP, including VM and device input. */
export class AutomationController {
  private native?: NativeSession;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private connectionState?: AutomationState['status'];
  private diagnostics: string[] = [];
  private active?: AbortController;
  private boundVm?: { generation: string; deviceId: string };
  private readonly lease: DeviceLease;
  private readonly leaseRoot: string;
  constructor(
    readonly runtime: AutomationRuntime,
    private readonly host: AutomationHost,
    leaseRoot = join(homedir(), '.flutter-pilot', 'automation', 'leases'),
  ) {
    this.leaseRoot = leaseRoot;
    this.lease = new DeviceLease(leaseRoot);
    runtime.on('status', () => host.changed());
    runtime.on('exit', () => {
      if (this.native) {
        this.connectionState = 'error';
        this.diagnostics = ['设备自动化进程已退出，请先检查界面再重新连接。'];
        this.active?.abort();
        host.changed();
      }
    });
  }
  get snapshot(): AutomationState {
    return {
      ...this.runtime.snapshot,
      ...(this.connectionState ? { status: this.connectionState } : {}),
      diagnostics: [...this.runtime.snapshot.diagnostics, ...this.diagnostics],
      ...(this.native ? { binding: this.native.binding, capabilities: this.native.capabilities() } : {}),
    };
  }
  execute(tool: string, args: Record<string, any>, signal?: AbortSignal): Promise<UiResult> {
    if (tool === 'get_automation_status' && this.active)
      return Promise.resolve(success({ automation: this.snapshot }));
    const operation = this.queue.then(async () => {
      if (this.disposed) return fail('SESSION_INVALIDATED', '设备自动化已关闭。');
      const controller = new AbortController();
      this.active = controller;
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const deadline = ![
        'setup_automation',
        'connect_device',
        'get_automation_status',
        'disconnect_device',
      ].includes(tool)
        ? setTimeout(
            () => controller.abort(),
            tool === 'wait_for_widget'
              ? (args.timeoutMs ?? 5000) + 2000
              : (args.timeoutMs ?? (tool === 'take_screenshot' ? 65000 : 30000)),
          )
        : undefined;
      const cancel = () => {
        this.host.vmInvalidate();
        void this.native?.release();
      };
      let vmLease: DeviceLease | undefined;
      const nativeSequence = this.native?.dispatchSequence ?? 0;
      combined.addEventListener('abort', cancel, { once: true });
      try {
        checkCancelled(combined);
        const vmDevice = this.host.vmIdentity?.().deviceId;
        if (
          vmDevice &&
          (!this.native || this.native.binding.deviceId !== vmDevice) &&
          ((tool === 'take_screenshot' && args.source !== 'device' && args.mode === 'long') ||
            (this.backend(args) === 'flutter' &&
              (gestureNames.has(tool) ||
                ['scroll', 'enter_text', 'edit_text', 'press_key', 'editor_action', 'hide_keyboard'].includes(
                  tool,
                ))))
        ) {
          vmLease = new DeviceLease(this.leaseRoot);
          await vmLease.acquire(vmDevice);
        }
        const result = await this.perform(tool, args, combined);
        if (combined.aborted)
          return fail('CANCELLED', '操作已取消，结果未确认；请先检查界面。', {
            uncertain: true,
            backend: result.backend,
          });
        return result;
      } catch (error) {
        return error instanceof AutomationError
          ? fail(error.code, error.message, {
              uncertain:
                error.uncertain ||
                ((this.native?.dispatchSequence ?? 0) > nativeSequence &&
                  ['CANCELLED', 'DEVICE_CONNECTION_FAILED', 'DEVICE_DISCONNECTED'].includes(error.code)),
              ...((error as any).candidates ? { candidates: (error as any).candidates } : {}),
            })
          : fail('AUTOMATION_FAILED', '操作失败，请检查设备连接和自动化诊断。');
      } finally {
        await vmLease?.release();
        if (deadline) clearTimeout(deadline);
        combined.removeEventListener('abort', cancel);
        if (this.active === controller) this.active = undefined;
        this.host.changed();
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  cancel() {
    this.active?.abort();
  }
  private device() {
    if (!this.native || this.connectionState !== 'connected')
      throw new AutomationError('DEVICE_DISCONNECTED', '请先连接设备自动化。');
    return this.native;
  }
  private async vm(tool: string, args: Record<string, any>) {
    if (!this.host.vmConnected())
      throw new AutomationError('VM_DISCONNECTED', 'Flutter 定位和操作需要已连接的 Debug VM。');
    return this.host.vmExecute(tool, flutterArgs(args));
  }
  private require(result: UiResult): Record<string, any> {
    if (!result.ok)
      throw new AutomationError(
        result.code ?? 'UI_OPERATION_FAILED',
        result.message ?? 'Flutter 操作失败。',
        result.code === 'TIMEOUT',
      );
    return result;
  }
  private async screenshotVm(tool: string, args: Record<string, any>, signal: AbortSignal) {
    if (tool === 'take_screenshot' && args.rawParts === true) return this.vm(tool, args);
    return executeMcpScreenshot(
      tool === 'screenshot_targets'
        ? 'list_screenshot_targets'
        : (tool as 'take_screenshot' | 'list_screenshot_targets'),
      args,
      (name, input) => this.vm(name, input ?? {}),
      signal,
    );
  }
  private backend(args: Record<string, any>) {
    return args.backend === 'device' ||
      (args.backend !== 'flutter' && this.native && this.connectionState === 'connected')
      ? 'device'
      : 'flutter';
  }
  private isNativeSelector(args: Record<string, any>) {
    const s = args.selector as Selector | undefined;
    return (
      s?.source === 'device' ||
      s?.ref?.startsWith('device:') ||
      s?.ancestor?.ref?.startsWith('device:') ||
      s?.ancestor?.accessibilityId !== undefined ||
      s?.ancestor?.resourceId !== undefined ||
      s?.accessibilityId !== undefined ||
      s?.resourceId !== undefined
    );
  }
  private async connect(args: Record<string, any>, signal: AbortSignal): Promise<UiResult> {
    if (this.native) throw new AutomationError('DEVICE_ALREADY_CONNECTED', '请先断开当前设备再更换连接。');
    const status = await this.runtime.inspect();
    const device = status.devices.find((item) => item.id === args.deviceId);
    if (!device) throw new AutomationError('DEVICE_NOT_FOUND', '未发现指定设备，请刷新设备列表。');
    if (!['device', 'Booted', 'connected'].includes(device.state))
      throw new AutomationError('DEVICE_NOT_READY', '设备离线、未授权或模拟器尚未启动。');
    const binding: DeviceBinding = {
      projectSessionId: this.host.projectSessionId?.(),
      deviceId: device.id,
      platform: device.platform,
      kind: device.kind,
      appId: args.appId,
      ...(args.wdaPath ? { wdaPath: args.wdaPath, wdaBundleId: args.wdaBundleId } : {}),
      ...(args.viewport ? { viewport: args.viewport } : {}),
    };
    if (device.platform === 'ios' && device.kind === 'physical') {
      if (!args.wdaPath || !args.wdaBundleId || !args.wdaPath.endsWith('.app'))
        throw new AutomationError(
          'SIGNED_WDA_REQUIRED',
          'iOS 真机需要有效签名的 WDA .app 路径和 Bundle ID；请先完成配对、信任和开发者模式。',
        );
      try {
        await access(join(args.wdaPath, 'Info.plist'));
      } catch {
        throw new AutomationError('SIGNED_WDA_REQUIRED', '无法读取指定 WDA .app。');
      }
    }
    await this.runtime.checkPlatform(device.platform);
    await this.lease.acquire(device.id);
    this.connectionState = 'connecting';
    this.diagnostics = [];
    this.host.changed();
    let session: NativeSession | undefined;
    try {
      const endpoint = await this.runtime.start(signal);
      session =
        this.host.createNative?.(binding, endpoint) ??
        new NativeSession(binding, new WebDriverClient(endpoint).request);
      await session.connect(signal);
      checkCancelled(signal);
      this.native = session;
      const vm = this.host.vmIdentity?.();
      if (vm && (vm.deviceId === device.id || (!vm.deviceId && args.vmDeviceId === device.id)))
        this.boundVm = { generation: vm.generation, deviceId: device.id };
      this.connectionState = 'connected';
      return success({ backend: 'device', binding, capabilities: session.capabilities() });
    } catch (error) {
      await session?.disconnect();
      await this.runtime.stop();
      await this.lease.release();
      this.connectionState = 'error';
      this.diagnostics = [
        '设备连接失败；检查 SDK、设备授权及 WDA 签名。',
        ...(error instanceof AutomationError ? [error.message] : []),
        ...(this.runtime.diagnosticLog ? [this.runtime.diagnosticLog] : []),
      ];
      throw error;
    }
  }
  private async disconnect() {
    const native = this.native;
    this.native = undefined;
    this.boundVm = undefined;
    await native?.disconnect();
    await this.runtime.stop();
    await this.lease.release();
    this.connectionState = undefined;
    this.diagnostics = [];
    return success({ disconnected: true });
  }
  private async find(args: Record<string, any>, signal: AbortSignal): Promise<UiResult> {
    if (this.isNativeSelector(args)) {
      const { xpath: _, ...widget } = await this.device().find(selectorFor(args), signal, args.scopeSelector);
      return success({ source: 'device', count: 1, widget });
    }
    return this.vm('find_widget', args);
  }
  private async resolve(
    args: Record<string, any>,
    backend: 'flutter' | 'device',
    signal: AbortSignal,
  ): Promise<Resolved> {
    const screenGeometry: any =
      backend === 'device'
        ? await this.device().geometry(signal)
        : this.require(await this.vm('get_ui_geometry', {}));
    const screen: Rect =
      backend === 'device'
        ? screenGeometry.rect
        : { x: 0, y: 0, width: screenGeometry.width, height: screenGeometry.height };
    if (!validRect(screen)) throw new AutomationError('INVALID_DEVICE_GEOMETRY', '窗口边界无效。');
    if (args.point) {
      const p = args.point as Point;
      if (
        p.x < screen.x ||
        p.y < screen.y ||
        p.x >= screen.x + screen.width ||
        p.y >= screen.y + screen.height
      )
        throw new AutomationError('POINT_OUT_OF_BOUNDS', '坐标超出当前窗口。');
      return { point: p, bounds: screen, screen };
    }
    if (this.isNativeSelector(args)) {
      if (backend !== 'device') throw new AutomationError('INVALID_BACKEND', '原生界面需要设备操作通道。');
      const node = await this.device().find(selectorFor(args), signal);
      if (!node.enabled) throw new AutomationError('NOT_ENABLED', '目标已禁用。');
      if (!node.visible || !node.bounds || !validRect(node.bounds))
        throw new AutomationError('NOT_VISIBLE', '目标不可见。');
      return {
        point: { x: node.bounds.x + node.bounds.width / 2, y: node.bounds.y + node.bounds.height / 2 },
        bounds: node.bounds,
        screen,
        nativeNode: node,
      };
    }
    const found = this.require(await this.vm('find_widget', args));
    const widget = found.widget;
    if (!widget.enabled) throw new AutomationError('NOT_ENABLED', '目标已禁用。');
    if (!widget.visible || !validRect(widget.bounds))
      throw new AutomationError('NOT_VISIBLE', '目标不可见或被遮挡。');
    if (backend === 'flutter')
      return {
        point: {
          x: widget.bounds.x + widget.bounds.width / 2,
          y: widget.bounds.y + widget.bounds.height / 2,
        },
        bounds: widget.bounds,
        screen,
        flutter: widget,
      };
    const device = this.device();
    const vm = this.host.vmIdentity?.();
    if (
      !this.boundVm ||
      !vm ||
      vm.generation !== this.boundVm.generation ||
      this.boundVm.deviceId !== device.binding.deviceId ||
      (vm.deviceId && vm.deviceId !== device.binding.deviceId)
    )
      throw new AutomationError(
        'VM_DEVICE_UNCONFIRMED',
        '当前 VM 与设备身份无法确认；从 IDE 调试会话连接，或在 connect_device 显式确认 vmDeviceId 后重新连接。',
      );
    const pid = await this.host.vmProcessId?.();
    if (!Number.isSafeInteger(pid) || pid! <= 0)
      throw new AutomationError('VM_APP_UNCONFIRMED', '无法确认 Flutter VM 进程与目标 App，拒绝坐标转换。');
    if (!(await device.foreground(signal, device.binding.platform === 'ios' ? pid : undefined)))
      throw new AutomationError(
        'APP_NOT_FOREGROUND',
        '目标 Flutter App 不在前台；系统界面请使用 device 选择器。',
      );
    if (
      device.binding.platform === 'android' &&
      !(await this.runtime.androidAppProcess(device.binding.deviceId, device.binding.appId, signal)).includes(
        pid!,
      )
    )
      throw new AutomationError('VM_APP_UNCONFIRMED', '当前 VM 不属于绑定的 App 进程。');
    await device.assertNoOverlay(signal);
    const geometry = this.require(await this.vm('get_ui_geometry', {}));
    const viewport = await device.flutterViewport(signal);
    if (
      viewport.x < screen.x ||
      viewport.y < screen.y ||
      viewport.x + viewport.width > screen.x + screen.width ||
      viewport.y + viewport.height > screen.y + screen.height
    )
      throw new AutomationError('COORDINATE_MAPPING_UNCONFIRMED', '校准窗口超出设备屏幕。');
    const point = mapFlutterPoint(widget.bounds, geometry as any, viewport);
    const bounds = {
      x: viewport.x + (widget.bounds.x * viewport.width) / geometry.width,
      y: viewport.y + (widget.bounds.y * viewport.height) / geometry.height,
      width: (widget.bounds.width * viewport.width) / geometry.width,
      height: (widget.bounds.height * viewport.height) / geometry.height,
    };
    const after = this.require(await this.vm('find_widget', args));
    const afterGeometry = this.require(await this.vm('get_ui_geometry', {}));
    const currentGeometry = await device.geometry(signal);
    if (
      JSON.stringify(widget.bounds) !== JSON.stringify(after.widget.bounds) ||
      widget.type !== after.widget.type ||
      JSON.stringify(geometry) !== JSON.stringify(afterGeometry) ||
      JSON.stringify(screenGeometry) !== JSON.stringify(currentGeometry)
    )
      throw new AutomationError('LAYOUT_CHANGED', '定位期间布局或屏幕方向发生变化，请重新定位。');
    return { point, bounds, screen, flutter: widget, geometry };
  }
  private async gesture(tool: string, args: Record<string, any>, signal: AbortSignal): Promise<UiResult> {
    const backend = this.backend(args);
    const target =
      tool === 'perform_gesture'
        ? await this.resolve({ point: { x: 1, y: 1 } }, backend, signal)
        : await this.resolve(args, backend, signal);
    const destination = tool === 'drag' && args.to ? await this.resolve(args.to, backend, signal) : undefined;
    const tracks = buildGesture(
      tool,
      {
        ...args,
        ...(args.radius === undefined && (tool === 'pinch' || tool === 'rotate_gesture')
          ? { radius: Math.min(target.bounds.width, target.bounds.height) * 0.2 }
          : {}),
      },
      target.point,
      target.screen,
      destination?.point,
    );
    if (backend === 'device') {
      await this.device().perform(tracks, signal);
      return success({ backend, inputMethod: 'system_pointer', dispatched: true, verified: false });
    }
    const result = await this.vm('perform_gesture', { tracks });
    if (!result.ok && ['TIMEOUT', 'UI_UNAVAILABLE', 'SESSION_INVALIDATED'].includes(result.code ?? ''))
      result.uncertain = true;
    return { ...result, backend, inputMethod: 'flutter_pointer', dispatched: result.ok, verified: false };
  }
  private async scroll(args: Record<string, any>, signal: AbortSignal): Promise<UiResult> {
    const backend = this.backend(args);
    // Preserve the existing VM scroll target semantics and bounded lazy-list search.
    if (backend === 'flutter') return { ...(await this.vm('scroll', args)), backend };
    const opposite: Record<string, string> = { up: 'down', down: 'up', left: 'right', right: 'left' };
    const target = args.targetSelector
      ? { selector: args.targetSelector }
      : args.targetKey !== undefined
        ? { key: args.targetKey, ...(args.key !== undefined ? { ancestorKey: args.key } : {}) }
        : undefined;
    const max = target ? (args.maxSteps ?? 10) : 1;
    if (target && !!this.isNativeSelector(target) !== !!this.isNativeSelector(args))
      throw new AutomationError(
        'INVALID_SELECTOR',
        '滚动区域与查找目标须属于同一界面树；原生目标请显式指定 source=device。',
      );
    for (let step = 0; step <= max; step++) {
      checkCancelled(signal);
      if (target) {
        try {
          const result = await this.find(
            { selector: selectorFor(target), scopeSelector: selectorFor(args) },
            signal,
          );
          if (result.ok && (result.widget as any)?.visible)
            return success({ backend, steps: step, widget: result.widget });
          if (!result.ok && result.code !== 'NOT_FOUND') return result;
        } catch (error) {
          if (!(error instanceof AutomationError) || error.code !== 'NOT_FOUND') throw error;
        }
      }
      if (step === max)
        return target
          ? fail('SCROLL_LIMIT', '达到滚动步数上限，目标尚未可见。')
          : success({ backend, steps: step, dispatched: true, verified: false });
      const region = await this.resolve(args, 'device', signal);
      const vertical = ['up', 'down'].includes(args.direction ?? 'down');
      const distance = Math.min(
        args.distance ?? 300,
        (vertical ? region.bounds.height : region.bounds.width) * 0.65,
      );
      const tracks = buildGesture(
        'swipe',
        { direction: opposite[args.direction ?? 'down'], distance, durationMs: args.durationMs ?? 350 },
        region.point,
        region.screen,
      );
      await this.device().perform(tracks, signal);
      // Flutter ignores hit tests during ballistic scrolling. Wait for the region
      // to accept input again before checking a target or sending the next swipe.
      await pause(100, signal);
      if (!args.point && !this.isNativeSelector(args)) {
        const until = Date.now() + 1500;
        while (true) {
          checkCancelled(signal);
          const state = this.require(await this.vm('get_scroll_state', args));
          if (state.scrolling === false) break;
          if (Date.now() >= until)
            return fail('SCROLL_NOT_SETTLED', '滚动尚未停止，请检查界面后重新定位。', {
              dispatched: true,
              uncertain: true,
            });
          await pause(50, signal);
        }
      }
    }
    return fail('SCROLL_LIMIT', '达到滚动上限。');
  }
  private async waitFor(args: Record<string, any>, signal: AbortSignal): Promise<UiResult> {
    const until = Date.now() + (args.timeoutMs ?? 5000),
      condition = args.state ?? 'present';
    while (true) {
      checkCancelled(signal);
      let result: UiResult;
      try {
        result = await this.find(args, signal);
      } catch (error) {
        if (error instanceof AutomationError && error.code === 'NOT_FOUND')
          result = fail('NOT_FOUND', '未找到目标。');
        else throw error;
      }
      if (!result.ok && result.code !== 'NOT_FOUND') return result;
      const widget: any = result.widget;
      const matches =
        condition === 'absent'
          ? result.code === 'NOT_FOUND'
          : result.ok &&
            (condition === 'present' ||
              (['visible', 'enabled', 'actionable'].includes(condition) && widget[condition] === true) ||
              (condition === 'text_equals' && widget.text === args.text) ||
              (condition === 'text_contains' &&
                typeof widget.text === 'string' &&
                widget.text.includes(args.text)) ||
              (condition === 'text_changed' && typeof widget.text === 'string' && widget.text !== args.text));
      if (matches) return success({ condition, ...(widget ? { widget } : {}) });
      if (Date.now() >= until) return fail('WAIT_TIMEOUT', '等待目标状态超时。');
      await pause(Math.min(100, Math.max(1, until - Date.now())), signal);
    }
  }
  private async key(args: Record<string, any>, signal: AbortSignal): Promise<UiResult> {
    const keys = [...(args.modifiers ?? []), args.keyName];
    if (this.backend(args) === 'flutter')
      return { ...(await this.vm('press_key', { keys })), backend: 'flutter', inputMethod: 'flutter_key' };
    const device = this.device();
    if (
      device.binding.platform === 'ios' &&
      (args.modifiers?.length ||
        (keyCodes[args.keyName] && !['Enter', 'Backspace', 'Space'].includes(args.keyName)))
    ) {
      const flags: Record<string, number> = { Shift: 2, Control: 4, Alt: 8, Meta: 16 };
      if (!keyCodes[args.keyName] && [...args.keyName].length !== 1)
        throw new AutomationError('UNSUPPORTED_KEY', '不支持此按键名称。');
      try {
        const elementId =
          args.elementId ??
          (await device.call('GET', '/element/active', undefined, signal))?.[
            'element-6066-11e4-a52e-4f735466cecf'
          ];
        await device.execute(
          'mobile: keys',
          {
            ...(typeof elementId === 'string' ? { elementId } : {}),
            keys: [
              {
                key: iosKeys[args.keyName] ? `XCUIKeyboardKey${iosKeys[args.keyName]}` : args.keyName,
                modifierFlags: (args.modifiers ?? []).reduce(
                  (value: number, key: string) => value | flags[key],
                  0,
                ),
              },
            ],
          },
          signal,
        );
      } catch (error) {
        if (error instanceof AutomationError && error.code === 'UNSUPPORTED_OPERATION')
          device.markUnsupported(
            'press_key.combinations',
            '当前 iOS 设备不支持 XCTest 硬件按键；请操作可见编辑菜单，Flutter 输入框可显式使用 backend=flutter。',
          );
        throw error;
      }
      return success({
        backend: 'device',
        inputMethod: 'native_modifier_key',
        dispatched: true,
        verified: false,
      });
    }
    const actions: unknown[] = [];
    for (const key of keys) {
      const value = keyCodes[key] ?? (typeof key === 'string' && [...key].length === 1 ? key : undefined);
      if (!value) throw new AutomationError('UNSUPPORTED_KEY', '不支持此按键名称。');
      actions.push({ type: 'keyDown', value });
    }
    for (const key of [...keys].reverse()) actions.push({ type: 'keyUp', value: keyCodes[key] ?? key });
    await this.device().perform([{ type: 'key', id: 'keyboard', actions }], signal);
    return success({ backend: 'device', inputMethod: 'system_key', dispatched: true, verified: false });
  }
  private async enterText(args: Record<string, any>, signal: AbortSignal): Promise<UiResult> {
    const backend = this.backend(args);
    if (backend === 'flutter')
      return { ...(await this.vm('enter_text', args)), backend, inputMethod: 'flutter_editing_protocol' };
    if (args.mode === 'append')
      throw new AutomationError(
        'UNSUPPORTED_OPERATION',
        '原生通道无法确认光标已在文本末尾，不执行追加；Flutter 输入框可显式使用 backend=flutter。',
      );
    const device = this.device(),
      target = await this.resolve(args, backend, signal);
    await device.perform(buildGesture('tap', {}, target.point, target.screen), signal);
    const active = await device.call('GET', '/element/active', undefined, signal);
    const id = active?.['element-6066-11e4-a52e-4f735466cecf'];
    if (typeof id !== 'string') throw new AutomationError('NO_FOCUS', '未找到获得焦点的输入框。');
    const path = `/element/${encodeURIComponent(id)}`;
    await device.call('POST', `${path}/clear`, {}, signal);
    await device.call('POST', `${path}/value`, { text: args.text, value: Array.from(args.text) }, signal);
    return success({
      backend,
      inputMethod: 'native_text_editing',
      dispatched: true,
      verified: false,
      length: args.text.length,
    });
  }
  private async editText(args: Record<string, any>, signal: AbortSignal): Promise<UiResult> {
    // Exact Flutter selection uses the editor protocol rather than mutating a controller.
    if (
      !this.isNativeSelector(args) &&
      !args.point &&
      (this.backend(args) === 'flutter' ||
        (args.backend !== 'device' && ['move_cursor', 'select_range'].includes(args.action)))
    )
      return {
        ...(await this.vm('edit_text', args)),
        backend: 'flutter',
        inputMethod: 'flutter_editing_protocol',
      };
    if (args.action === 'clear')
      return this.enterText({ ...args, text: '', mode: 'replace', backend: 'device' }, signal);
    if (['move_cursor', 'select_range'].includes(args.action))
      throw new AutomationError(
        'UNSUPPORTED_OPERATION',
        '原生输入框的精确光标/选区暂不支持；Flutter 输入框可使用编辑协议。',
      );
    const target = await this.resolve(args, 'device', signal);
    const device = this.device();
    if (device.binding.platform === 'ios' && ['select_all', 'copy', 'cut', 'paste'].includes(args.action))
      return this.iosEditMenu(args, target, signal);
    const active = await device.call('GET', '/element/active', undefined, signal);
    let activeId = active?.['element-6066-11e4-a52e-4f735466cecf'];
    const activeRect =
      typeof activeId === 'string'
        ? await device.call('GET', `/element/${encodeURIComponent(activeId)}/rect`, undefined, signal)
        : undefined;
    if (
      target.flutter?.focused !== true &&
      (!validRect(activeRect) ||
        target.point.x < activeRect.x ||
        target.point.x > activeRect.x + activeRect.width ||
        target.point.y < activeRect.y ||
        target.point.y > activeRect.y + activeRect.height)
    ) {
      await device.perform(buildGesture('tap', {}, target.point, target.screen), signal);
      activeId = (await device.call('GET', '/element/active', undefined, signal))?.[
        'element-6066-11e4-a52e-4f735466cecf'
      ];
    }
    const shortcut: Record<string, string> = { select_all: 'a', copy: 'c', cut: 'x', paste: 'v' };
    if (args.action === 'delete') return this.key({ keyName: 'Backspace', backend: 'device' }, signal);
    if (shortcut[args.action])
      return this.key(
        {
          keyName: shortcut[args.action],
          modifiers: [this.device().binding.platform === 'ios' ? 'Meta' : 'Control'],
          backend: 'device',
          elementId: activeId,
        },
        signal,
      );
    throw new AutomationError('UNSUPPORTED_OPERATION', '不支持此原生文本编辑操作。');
  }
  private async editMenuEditor(
    args: Record<string, any>,
    target: Resolved,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const device = this.device();
    let expectedId: string | undefined;
    let expectedBounds: Rect[] = [];
    if (target.nativeNode) {
      const current = await device.find(selectorFor(args), signal);
      if (
        current.type !== target.nativeNode.type ||
        JSON.stringify(current.bounds) !== JSON.stringify(target.bounds)
      )
        return undefined;
      expectedId = await device.element(current, signal);
    } else if (target.flutter) {
      const current = this.require(await this.vm('find_widget', args)).widget;
      if (
        current.focused !== true ||
        JSON.stringify(current.bounds) !== JSON.stringify(target.flutter.bounds)
      )
        return undefined;
      const inputBounds = [current.inputBounds ?? current.bounds, current.inputFieldBounds].filter(validRect);
      if (!inputBounds.length || !validRect(current.bounds)) return undefined;
      const sx = target.bounds.width / current.bounds.width;
      const sy = target.bounds.height / current.bounds.height;
      expectedBounds = inputBounds.map((bounds) => ({
        x: target.bounds.x + (bounds.x - current.bounds.x) * sx,
        y: target.bounds.y + (bounds.y - current.bounds.y) * sy,
        width: bounds.width * sx,
        height: bounds.height * sy,
      }));
    } else return undefined;
    const active = await device.call('GET', '/element/active', undefined, signal);
    const id = active?.['element-6066-11e4-a52e-4f735466cecf'];
    if (typeof id !== 'string') return undefined;
    const encodedId = encodeURIComponent(id);
    if (expectedId) return expectedId === encodedId ? encodedId : undefined;
    const bounds = await device.call('GET', `/element/${encodedId}/rect`, undefined, signal);
    if (
      !validRect(bounds) ||
      !expectedBounds.some((expected) =>
        (['x', 'y', 'width', 'height'] as const).every(
          (field) => Math.abs(bounds[field] - expected[field]) <= 2,
        ),
      )
    )
      return undefined;
    return encodedId;
  }
  private async iosEditMenu(
    args: Record<string, any>,
    target: Resolved,
    signal: AbortSignal,
  ): Promise<UiResult> {
    const device = this.device();
    const labels: Record<string, string[]> = {
      select_all: ['Select All', '全选', '全選'],
      copy: ['Copy', '复制', '拷贝', '拷貝'],
      cut: ['Cut', '剪切', '剪下'],
      paste: ['Paste', '粘贴', '贴上', '貼上'],
    };
    const selection = target.flutter?.selection;
    if (
      args.action === 'select_all' &&
      target.flutter?.focused &&
      selection?.start === 0 &&
      selection.end === target.flutter.textLength
    )
      return success({
        backend: 'device',
        inputMethod: 'native_selection_state',
        dispatched: false,
        verified: true,
      });
    const menu = async () => {
      const snapshot = await device.snapshot(signal, true);
      return snapshot.widgets.filter(
        (node) =>
          node.visible &&
          node.enabled &&
          /MenuItem|Button/.test(node.type) &&
          labels[args.action].some((label) => node.text === label || node.semantics === label),
      );
    };
    let candidates = await menu();
    const existingEditor = candidates.length ? await this.editMenuEditor(args, target, signal) : undefined;
    if (candidates.length && !existingEditor)
      return fail(
        'EDIT_TARGET_UNCONFIRMED',
        '当前编辑菜单无法确认属于指定输入框；请关闭菜单并聚焦目标后重新操作。',
      );
    if (candidates.length === 0) {
      const selectedPoint = target.flutter?.selectionPoint;
      const box = target.flutter?.bounds;
      const point =
        selectedPoint && box
          ? {
              x: target.bounds.x + ((selectedPoint.x - box.x) * target.bounds.width) / box.width,
              y: target.bounds.y + ((selectedPoint.y - box.y) * target.bounds.height) / box.height,
            }
          : target.point;
      await device.perform(
        buildGesture(selectedPoint ? 'tap' : 'long_press', { durationMs: 650 }, point, target.screen),
        signal,
      );
      const until = Date.now() + 1200;
      do {
        candidates = await menu();
        if (candidates.length) break;
        await pause(100, signal);
      } while (Date.now() < until);
    }
    if (candidates.length !== 1)
      return fail(
        candidates.length ? 'AMBIGUOUS_EDIT_MENU' : 'EDIT_MENU_UNAVAILABLE',
        '未找到唯一可见的编辑菜单项。支持中英文系统菜单；请读取设备快照显式操作。',
        { uncertain: true },
      );
    if (selection && selection.start !== selection.end && ['copy', 'cut'].includes(args.action)) {
      const current = this.require(await this.vm('find_widget', args)).widget;
      if (JSON.stringify(current.selection) !== JSON.stringify(selection))
        return fail('EDIT_SELECTION_CHANGED', '打开编辑菜单时选区发生变化，请重新选择后操作。', {
          uncertain: true,
        });
    }
    const editor = await this.editMenuEditor(args, target, signal);
    if (!editor || (existingEditor && existingEditor !== editor))
      return fail('EDIT_TARGET_UNCONFIRMED', '当前活动编辑器与指定输入框不一致，未点击编辑菜单。', {
        uncertain: true,
      });
    const node = candidates[0];
    if (!node.bounds) throw new AutomationError('NOT_VISIBLE', '编辑菜单没有有效边界。');
    await device.perform(
      buildGesture(
        'tap',
        {},
        { x: node.bounds.x + node.bounds.width / 2, y: node.bounds.y + node.bounds.height / 2 },
        target.screen,
      ),
      signal,
    );
    return success({ backend: 'device', inputMethod: 'native_edit_menu', dispatched: true, verified: false });
  }
  private async deviceAction(args: Record<string, any>, signal: AbortSignal): Promise<UiResult> {
    const device = this.device(),
      android = device.binding.platform === 'android';
    const action = args.action;
    if (action === 'back') {
      if (android) await device.call('POST', '/back', {}, signal);
      else if (args.selector)
        return this.gesture('tap', { selector: args.selector, backend: 'device' }, signal);
      else
        throw new AutomationError(
          'UNSUPPORTED_OPERATION',
          'iOS 返回请提供可见返回按钮选择器，或使用边缘返回手势。',
        );
    } else if (action === 'home') {
      if (android) await device.call('POST', '/appium/device/press_keycode', { keycode: 3 }, signal);
      else await device.execute('mobile: pressButton', { name: 'home' }, signal);
    } else if (action === 'foreground') {
      await device.execute(
        'mobile: activateApp',
        { ...(android ? { appId: device.binding.appId } : { bundleId: device.binding.appId }) },
        signal,
      );
    } else if (action === 'background') {
      await device.call('POST', '/appium/app/background', { seconds: -1 }, signal);
    } else if (action === 'rotate' || action === 'restore_orientation') {
      const orientation = action === 'restore_orientation' ? device.orientationToRestore : args.orientation;
      if (!['PORTRAIT', 'LANDSCAPE'].includes(orientation))
        throw new AutomationError('INVALID_ARGUMENT', '请选择 PORTRAIT 或 LANDSCAPE。');
      await device.call('POST', '/orientation', { orientation }, signal);
      const geometry = await device.geometry(signal);
      if (geometry.orientation !== orientation)
        return fail('ORIENTATION_UNCONFIRMED', '设备未切换到预期方向，检查 App 方向限制。', {
          backend: 'device',
          dispatched: true,
          verified: false,
        });
      return success({ backend: 'device', dispatched: true, verified: true, geometry });
    } else if (action === 'notifications' && android) {
      await device.call('POST', '/appium/device/open_notifications', {}, signal);
    } else if (action === 'close_panels' && android) {
      await device.call('POST', '/back', {}, signal);
    } else if (['notifications', 'control_center', 'close_panels'].includes(action)) {
      if (android) throw new AutomationError('UNSUPPORTED_OPERATION', 'Android 请使用通知栏操作。');
      const { rect } = await device.geometry(signal);
      const close = action === 'close_panels';
      const x = rect.x + rect.width * (action === 'control_center' ? 0.95 : close ? 0.5 : 0.05);
      const from = { x, y: rect.y + (close ? rect.height - 2 : 2) },
        to = { x, y: rect.y + rect.height * (close ? 0.2 : 0.8) };
      await device.perform(buildGesture('drag', { durationMs: 600 }, from, rect, to), signal);
    } else throw new AutomationError('UNSUPPORTED_OPERATION', '不支持此设备操作。');
    return success({ backend: 'device', inputMethod: 'system_action', dispatched: true, verified: false });
  }
  private async perform(tool: string, args: Record<string, any>, signal: AbortSignal): Promise<UiResult> {
    if (tool === 'get_automation_status') {
      await this.runtime.inspect();
      return success({ automation: this.snapshot });
    }
    if (tool === 'setup_automation') {
      await this.runtime.setup(signal);
      return success({ automation: this.snapshot });
    }
    if (tool === 'connect_device') return this.connect(args, signal);
    if (tool === 'disconnect_device') return this.disconnect();
    if (tool === 'get_ui_snapshot') {
      if (args.source !== 'device') return this.vm(tool, args);
      const snapshot = await this.device().snapshot(signal);
      return success({
        ...snapshot,
        widgets: snapshot.widgets.slice(0, args.maxNodes ?? 200).map(({ xpath: _, ...node }) => node),
        truncated: snapshot.widgets.length > (args.maxNodes ?? 200),
      });
    }
    if (tool === 'find_widget') return this.find(args, signal);
    if (tool === 'wait_for_widget') return this.waitFor(args, signal);
    if (gestureNames.has(tool)) return this.gesture(tool, args, signal);
    if (tool === 'scroll') return this.scroll(args, signal);
    if (tool === 'enter_text') return this.enterText(args, signal);
    if (tool === 'edit_text') return this.editText(args, signal);
    if (tool === 'press_key') return this.key(args, signal);
    if (tool === 'get_keyboard_state') {
      return this.backend(args) === 'device'
        ? success({
            backend: 'device',
            shown: await this.device().call('GET', '/appium/device/is_keyboard_shown', undefined, signal),
          })
        : this.vm(tool, args);
    }
    if (tool === 'hide_keyboard') {
      if (this.backend(args) === 'flutter') return { ...(await this.vm(tool, args)), backend: 'flutter' };
      await this.device().call('POST', '/appium/device/hide_keyboard', {}, signal);
      return success({ backend: 'device', dispatched: true, verified: false });
    }
    if (tool === 'editor_action') {
      if (this.backend(args) === 'flutter')
        return {
          ...(await this.vm(tool, args)),
          backend: 'flutter',
          inputMethod: 'flutter_editing_protocol',
        };
      if (this.device().binding.platform === 'android')
        await this.device().execute('mobile: performEditorAction', { action: args.action }, signal);
      else {
        if (args.action === 'next' || args.action === 'previous')
          return this.key(
            { keyName: 'Tab', modifiers: args.action === 'previous' ? ['Shift'] : [], backend: 'device' },
            signal,
          );
        return this.key({ keyName: 'Enter', backend: 'device' }, signal);
      }
      return success({ backend: 'device', dispatched: true, verified: false });
    }
    if (tool === 'device_action') return this.deviceAction(args, signal);
    if (tool === 'take_screenshot' && args.source === 'device') {
      if (args.mode !== 'screen')
        throw new AutomationError('UNSUPPORTED_OPERATION', '设备整屏截图不支持长图。');
      return this.device().screenshot(signal);
    }
    if (tool === 'take_screenshot' || tool === 'list_screenshot_targets' || tool === 'screenshot_targets')
      return this.screenshotVm(tool, args, signal);
    if (tool === 'inspect_key_issues') return this.vm(tool, args);
    throw new AutomationError('UNKNOWN_TOOL', '不支持此自动化工具。');
  }
  async dispose() {
    this.disposed = true;
    this.active?.abort();
    await this.queue;
    await this.disconnect();
    await this.runtime.dispose();
  }
}

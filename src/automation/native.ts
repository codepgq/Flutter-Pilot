import { createHash, randomUUID } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  AutomationError,
  checkCancelled,
  type DeviceBinding,
  type Rect,
  type Selector,
  type UiNode,
} from './model';
import type { PointerTrack } from './gestures';
import { findAvailablePort } from '../engine';

export type WebDriverRequest = (
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<any>;
export interface NativeNode extends UiNode {
  xpath: string;
}
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
export function validRect(value: any): value is Rect {
  return (
    value &&
    [value.x, value.y, value.width, value.height].every(finite) &&
    value.width > 0 &&
    value.height > 0
  );
}
function decode(value: unknown): string {
  return String(value ?? '').replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (match, entity: string) => {
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (entity[0] !== '#') return named[entity] ?? match;
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : match;
    },
  );
}

/** Parse source locally; selectors are never interpolated into XPath or executable scripts. */
export function parseNativeSource(xml: string, snapshotId: string): NativeNode[] {
  if (xml.length > 4 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new AutomationError('INVALID_DEVICE_SOURCE', '设备返回的界面 XML 无效或超过限制。');
  const parsed = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: false,
    parseAttributeValue: false,
  }).parse(xml);
  const nodes: NativeNode[] = [];
  function visit(entries: any[], path: string, parentRef?: string, depth = 0) {
    if (depth > 128) throw new AutomationError('TREE_LIMIT', '设备界面层级超过限制。');
    const indexes = new Map<string, number>();
    for (const item of entries) {
      const tag = Object.keys(item).find((k) => k !== ':@' && !k.startsWith('?') && !k.startsWith('#'));
      if (!tag) continue;
      if (!/^[A-Za-z_][\w.:-]*$/.test(tag))
        throw new AutomationError('INVALID_DEVICE_SOURCE', '设备节点类型无效。');
      if (nodes.length >= 10000) throw new AutomationError('TREE_LIMIT', '设备界面节点超过限制。');
      const index = (indexes.get(tag) ?? 0) + 1;
      indexes.set(tag, index);
      const xpath = `${path}/${tag}[${index}]`,
        a = item[':@'] ?? {};
      const ref = `${snapshotId}:${nodes.length}`;
      let bounds: Rect | undefined;
      const b = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(a.bounds ?? '');
      if (b) bounds = { x: +b[1], y: +b[2], width: +b[3] - +b[1], height: +b[4] - +b[2] };
      else if (a.x !== undefined && a.y !== undefined && a.width !== undefined && a.height !== undefined)
        bounds = { x: +a.x, y: +a.y, width: +a.width, height: +a.height };
      const type = decode(a.class ?? a.type ?? tag),
        enabled = a.enabled !== 'false';
      const visible = a.visible !== 'false' && a.displayed !== 'false' && !!bounds && validRect(bounds);
      const secure = /SecureTextField|password/i.test(type) || a.password === 'true';
      const editable = /EditText|TextField|TextView|SearchField/i.test(type);
      const text = secure ? undefined : decode(a.text ?? a.value ?? a.label);
      const label = decode(a['content-desc'] ?? a.label ?? a.name);
      const actions = [
        'tap',
        'long_press',
        ...(editable ? ['enter_text', 'edit_text'] : []),
        ...(a.scrollable === 'true' || /ScrollView|Table|CollectionView/.test(type) ? ['scroll'] : []),
      ];
      nodes.push({
        ref,
        parentRef,
        xpath,
        type,
        ...(text ? { text: text.slice(0, 1024) } : {}),
        ...(label && !secure ? { semantics: label.slice(0, 1024) } : {}),
        accessibilityId: decode(a['content-desc'] ?? a.name),
        resourceId: decode(a['resource-id']),
        enabled,
        visible,
        actionable: enabled && visible,
        ...(bounds ? { bounds } : {}),
        actions,
        ...(secure ? { obscured: true } : {}),
      });
      visit(item[tag] ?? [], xpath, ref, depth + 1);
    }
  }
  visit(parsed, '');
  return nodes;
}
export function matchNative(nodes: NativeNode[], selector: Selector, scope?: Selector): NativeNode[] {
  const fields = ['ref', 'type', 'text', 'semantics', 'accessibilityId', 'resourceId'] as const;
  const direct = (node: NativeNode, s: Selector) =>
    fields.every((field) => s[field] === undefined || node[field] === s[field]);
  const byRef = new Map(nodes.map((node) => [node.ref, node]));
  const scoped = scope ? new Set(matchNative(nodes, scope).map((node) => node.ref)) : undefined;
  return nodes.filter((node) => {
    if (!direct(node, selector)) return false;
    if (scoped) {
      let parent = node.parentRef ? byRef.get(node.parentRef) : undefined;
      while (parent && !scoped.has(parent.ref))
        parent = parent.parentRef ? byRef.get(parent.parentRef) : undefined;
      if (!parent) return false;
    }
    if (!selector.ancestor) return true;
    let parent = node.parentRef ? byRef.get(node.parentRef) : undefined;
    while (parent) {
      if (direct(parent, selector.ancestor)) return true;
      parent = parent.parentRef ? byRef.get(parent.parentRef) : undefined;
    }
    return false;
  });
}

export class WebDriverClient {
  constructor(private readonly endpoint: string) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname))
      throw new AutomationError('INVALID_ENDPOINT', '设备自动化服务必须使用本机 HTTP。');
  }
  request: WebDriverRequest = async (method, path, body, signal) => {
    checkCancelled(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, path === '/session' ? 180000 : 30000);
    let dispatched = false;
    try {
      dispatched = true;
      // Keep in-flight input serialized until the server releases its sources. iOS releaseActions is a no-op.
      if (method !== 'GET') signal?.removeEventListener('abort', abort);
      const response = await fetch(`${this.endpoint}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: 'error',
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 32 * 1024 * 1024) {
              await reader.cancel();
              throw new AutomationError('DEVICE_RESPONSE_LIMIT', '设备响应超过限制。', method !== 'GET');
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new AutomationError('INVALID_DEVICE_RESPONSE', '设备返回无效响应。', method !== 'GET');
      }
      if (!response.ok || data.value?.error) {
        const known: Record<string, string> = {
          'stale element reference': 'STALE_REFERENCE',
          'no such element': 'NOT_FOUND',
          'unsupported operation': 'UNSUPPORTED_OPERATION',
          'unknown command': 'UNSUPPORTED_OPERATION',
          'invalid session id': 'DEVICE_DISCONNECTED',
          'invalid argument': 'INVALID_ARGUMENT',
        };
        throw new AutomationError(
          known[data.value?.error] ?? 'DEVICE_OPERATION_FAILED',
          `设备操作未能完成：${String(data.value?.message ?? data.value?.error ?? response.status)
            .replace(/\u001b\[[0-9;]*m/g, '')
            .slice(0, 1400)}`,
          method !== 'GET',
        );
      }
      return data.value;
    } catch (error) {
      if (error instanceof AutomationError) throw error;
      throw new AutomationError(
        signal?.aborted ? 'CANCELLED' : 'DEVICE_CONNECTION_FAILED',
        '设备连接中断或超时；请检查界面，不自动重试。',
        dispatched && method !== 'GET',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

export class NativeSession {
  private sessionId?: string;
  private nodes: NativeNode[] = [];
  private signature = '';
  private snapshotId = '';
  private initialOrientation?: string;
  private sent = 0;
  private readonly unavailable = new Map<string, string>();
  markUnsupported(action: string, reason: string) {
    this.unavailable.set(action, reason);
    if (action === 'press_key.combinations') this.unavailable.set('press_key.navigation', reason);
  }
  get dispatchSequence() {
    return this.sent;
  }
  constructor(
    readonly binding: DeviceBinding,
    private readonly request: WebDriverRequest,
  ) {}
  async connect(signal?: AbortSignal) {
    const b = this.binding;
    const localPort = await findAvailablePort('127.0.0.1', 0);
    const capabilities: Record<string, unknown> = {
      platformName: b.platform === 'android' ? 'Android' : 'iOS',
      'appium:automationName': b.platform === 'android' ? 'UiAutomator2' : 'XCUITest',
      'appium:udid': b.deviceId,
      'appium:noReset': true,
      'appium:autoLaunch': false,
      'appium:forceAppLaunch': false,
      'appium:shouldTerminateApp': false,
      'appium:autoGrantPermissions': false,
      'appium:autoAcceptAlerts': false,
      'appium:autoDismissAlerts': false,
      'appium:newCommandTimeout': 0,
      ...(b.platform === 'android'
        ? { 'appium:systemPort': localPort }
        : {
            'appium:wdaLocalPort': localPort,
            'appium:wdaRemotePort': b.kind === 'simulator' ? localPort : 8100,
            'appium:mjpegServerPort': await findAvailablePort('127.0.0.1', 0),
          }),
    };
    if (b.platform === 'android')
      Object.assign(capabilities, {
        'appium:appPackage': b.appId,
        'appium:dontStopAppOnReset': true,
        'appium:skipUnlock': true,
        'appium:disableWindowAnimation': false,
        'appium:hideKeyboard': false,
      });
    else
      Object.assign(capabilities, {
        'appium:bundleId': b.appId,
        'appium:shouldUseSingletonTestManager': true,
        'appium:resetOnSessionStartOnly': false,
        'appium:useNewWDA': false,
        'appium:skipLogCapture': true,
        ...(b.kind === 'physical'
          ? {
              'appium:usePreinstalledWDA': true,
              'appium:prebuiltWDAPath': b.wdaPath,
              'appium:updatedWDABundleId': b.wdaBundleId,
            }
          : {}),
      });
    // Creation must finish even after cancellation so any late-created session can be deleted.
    const value = await this.request('POST', '/session', {
      capabilities: { alwaysMatch: capabilities, firstMatch: [{}] },
    });
    if (typeof value?.sessionId !== 'string')
      throw new AutomationError('INVALID_DEVICE_RESPONSE', '未取得设备自动化会话。');
    this.sessionId = value.sessionId;
    try {
      checkCancelled(signal);
      this.initialOrientation = await this.call('GET', '/orientation', undefined, signal);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }
  async call(method: string, path: string, body?: unknown, signal?: AbortSignal) {
    if (!this.sessionId) throw new AutomationError('DEVICE_DISCONNECTED', '请先连接设备自动化。');
    if (method === 'POST') this.sent++;
    return this.request(method, `/session/${encodeURIComponent(this.sessionId)}${path}`, body, signal);
  }
  async execute(script: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
    return this.call('POST', '/execute/sync', { script, args: [args] }, signal);
  }
  async geometry(signal?: AbortSignal): Promise<{ rect: Rect; orientation: string }> {
    const rect = await this.call('GET', '/window/rect', undefined, signal);
    const orientation = await this.call('GET', '/orientation', undefined, signal);
    if (!validRect(rect) || typeof orientation !== 'string')
      throw new AutomationError('INVALID_DEVICE_GEOMETRY', '无法确认设备窗口和屏幕方向。');
    return { rect, orientation };
  }
  async snapshot(signal?: AbortSignal, keepRefs = false) {
    const xml = await this.call('GET', '/source', undefined, signal);
    if (typeof xml !== 'string') throw new AutomationError('INVALID_DEVICE_SOURCE', '设备界面结构无效。');
    const geometry = await this.geometry(signal);
    const signature = createHash('sha256').update(xml).update(JSON.stringify(geometry)).digest('hex');
    if (!keepRefs || signature !== this.signature) {
      this.snapshotId = `device:${randomUUID()}`;
      this.nodes = parseNativeSource(xml, this.snapshotId);
      this.signature = signature;
    }
    return { snapshotId: this.snapshotId, widgets: this.nodes, geometry, source: 'device' as const };
  }
  async find(selector: Selector, signal?: AbortSignal, scope?: Selector): Promise<NativeNode> {
    if (selector.key !== undefined || selector.ancestor?.key !== undefined)
      throw new AutomationError(
        'INVALID_SELECTOR',
        '设备原生选择器不支持 Flutter Key；请使用 Flutter 定位。',
      );
    const oldId = this.snapshotId;
    const result = await this.snapshot(signal, true);
    if (
      (selector.ref || selector.ancestor?.ref || scope?.ref || scope?.ancestor?.ref) &&
      (!oldId || oldId !== result.snapshotId)
    )
      throw new AutomationError('STALE_REFERENCE', '界面已变化，请重新读取设备快照。');
    const found = matchNative(this.nodes, selector, scope);
    if (found.length === 0)
      throw new AutomationError(selector.ref ? 'STALE_REFERENCE' : 'NOT_FOUND', '当前设备界面未找到目标。');
    if (found.length > 1) {
      const error = new AutomationError(
        'AMBIGUOUS_SELECTOR',
        '存在多个匹配目标，请限定祖先范围或使用快照引用。',
      );
      Object.assign(error, { candidates: found.slice(0, 10).map(({ xpath: _, ...node }) => node) });
      throw error;
    }
    return found[0];
  }
  async element(node: NativeNode, signal?: AbortSignal): Promise<string> {
    // WDA page source adds AppiumAUT as a document scope; XPath lookups start at the application.
    const xpath =
      this.binding.platform === 'ios' ? node.xpath.replace(/^\/AppiumAUT\[1\](?=\/)/, '') : node.xpath;
    const found = await this.call('POST', '/elements', { using: 'xpath', value: xpath }, signal);
    if (!Array.isArray(found) || found.length !== 1 || typeof found[0]?.[ELEMENT] !== 'string')
      throw new AutomationError('STALE_REFERENCE', '设备节点已变化，请重新定位。');
    return encodeURIComponent(found[0][ELEMENT]);
  }
  async perform(actions: PointerTrack[] | unknown[], signal?: AbortSignal) {
    try {
      const normalized = actions.map((source: any) =>
        source.type === 'pointer'
          ? {
              ...source,
              actions: source.actions.map((action: any) =>
                action.type === 'pointerMove'
                  ? { ...action, x: Math.trunc(action.x), y: Math.trunc(action.y) }
                  : action,
              ),
            }
          : source,
      );
      await this.call('POST', '/actions', { actions: normalized }, signal);
    } finally {
      await this.release();
    }
  }
  async release() {
    if (this.sessionId) await this.call('DELETE', '/actions').catch(() => undefined);
  }
  async assertNoOverlay(signal?: AbortSignal) {
    const snapshot = await this.snapshot(signal, true);
    if (
      snapshot.widgets.some(
        (node) =>
          node.visible && /Alert|Dialog|permissioncontroller/i.test(`${node.type} ${node.resourceId}`),
      )
    )
      throw new AutomationError(
        'NATIVE_OVERLAY_PRESENT',
        '原生或系统弹窗覆盖 App，请先使用设备快照明确操作弹窗。',
      );
  }
  async flutterViewport(signal?: AbortSignal): Promise<Rect> {
    if (this.binding.viewport) return this.binding.viewport;
    const snapshot = await this.snapshot(signal, true);
    const candidates = snapshot.widgets.filter(
      (node) =>
        node.visible &&
        node.bounds &&
        (this.binding.platform === 'ios'
          ? node.type === 'XCUIElementTypeApplication'
          : node.resourceId === 'android:id/content'),
    );
    if (candidates.length !== 1)
      throw new AutomationError(
        'COORDINATE_MAPPING_UNCONFIRMED',
        '无法从原生窗口确认 Flutter 窗口原点和系统栏；请校准 viewport 或使用设备选择器。',
      );
    return candidates[0].bounds!;
  }
  async foreground(signal?: AbortSignal, processId?: number): Promise<boolean> {
    if (this.binding.platform === 'ios') {
      const info = await this.execute('mobile: activeAppInfo', {}, signal);
      return info?.bundleId === this.binding.appId && (processId === undefined || info.pid === processId);
    }
    const active = await this.call('GET', '/appium/device/current_package', undefined, signal);
    return active === this.binding.appId;
  }
  async screenshot(signal?: AbortSignal) {
    const data = await this.call('GET', '/screenshot', undefined, signal);
    if (typeof data !== 'string' || data.length > 28_000_000)
      throw new AutomationError('INVALID_DEVICE_IMAGE', '设备截图无效或超过限制。');
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      throw new AutomationError('INVALID_DEVICE_IMAGE', '设备截图不是 PNG。');
    const geometry = await this.geometry(signal);
    return {
      ok: true,
      source: 'device',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      geometry,
      image: { mimeType: 'image/png', data },
    };
  }
  capabilities() {
    const names = [
      'tap',
      'double_tap',
      'long_press',
      'drag',
      'swipe',
      'pinch',
      'rotate_gesture',
      'perform_gesture',
      'scroll',
      'enter_text',
      'edit_text',
      'press_key',
      'get_keyboard_state',
      'hide_keyboard',
      'editor_action',
      'snapshot',
      'screenshot',
      'home',
      'foreground',
      'background',
      'rotate',
      'restore_orientation',
    ];
    return Object.fromEntries([
      ...names.map((name) => [name, { supported: true }]),
      [
        'enter_text.append',
        {
          supported: false,
          reason: '原生通道无法确认末尾光标；Flutter 输入框可显式使用 backend=flutter 追加。',
        },
      ],
      [
        'edit_text.precise_selection',
        { supported: false, reason: '原生精确光标和选区不可用；Flutter 目标可显式使用编辑协议。' },
      ],
      [
        'press_key.combinations',
        {
          supported: true,
          reason:
            this.binding.platform === 'ios'
              ? '使用 XCTest typeKey；系统未提供该 API 时返回不支持并更新能力。'
              : '需系统键盘事件支持；驱动或系统拒绝时明确报错。',
        },
      ],
      [
        'press_key.navigation',
        { supported: true, reason: '依赖设备硬件按键 API；不将特殊键当普通文本输入。' },
      ],
      ...['select_all', 'copy', 'cut', 'paste'].map((action) => [
        `edit_text.${action}`,
        {
          supported: true,
          reason:
            this.binding.platform === 'ios'
              ? '通过可见中英文编辑菜单执行；其他语言请用设备快照显式操作。'
              : '使用系统编辑快捷键，需设备支持。',
        },
      ]),
      [
        'back',
        {
          supported: this.binding.platform === 'android',
          ...(this.binding.platform === 'ios'
            ? { reason: 'iOS 请指定可见返回按钮，或执行边缘返回手势。' }
            : {}),
        },
      ],
      ['notifications', { supported: true }],
      [
        'control_center',
        {
          supported: this.binding.platform === 'ios',
          ...(this.binding.platform === 'android' ? { reason: 'Android 使用通知栏和快捷设置。' } : {}),
        },
      ],
      ...[...this.unavailable].map(([action, reason]) => [action, { supported: false, reason }]),
    ]);
  }
  get orientationToRestore() {
    return this.initialOrientation;
  }
  async disconnect() {
    await this.release();
    const id = this.sessionId;
    this.sessionId = undefined;
    this.nodes = [];
    this.snapshotId = '';
    if (id) await this.request('DELETE', `/session/${encodeURIComponent(id)}`).catch(() => undefined);
  }
}

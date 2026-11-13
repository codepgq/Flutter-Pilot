import type { Device } from '../devices';
import type { UiResult } from '../vm/ui';

export type Backend = 'auto' | 'flutter' | 'device';
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}
export interface Selector {
  source?: 'flutter' | 'device';
  key?: string | number;
  text?: string;
  semantics?: string;
  type?: string;
  accessibilityId?: string;
  resourceId?: string;
  ref?: string;
  ancestor?: Omit<Selector, 'ancestor'>;
}
export interface Target {
  key?: string | number;
  ancestorKey?: string | number;
  selector?: Selector;
  point?: Point;
}
export interface UiNode {
  ref: string;
  parentRef?: string;
  type: string;
  text?: string;
  semantics?: string;
  accessibilityId?: string;
  resourceId?: string;
  enabled: boolean;
  visible: boolean;
  actionable: boolean;
  bounds?: Rect;
  actions: string[];
  [key: string]: unknown;
}
export interface DeviceBinding {
  projectSessionId?: string;
  deviceId: string;
  platform: 'android' | 'ios';
  appId: string;
  kind: Device['kind'];
  wdaPath?: string;
  wdaBundleId?: string;
  viewport?: Rect;
}
export interface AutomationState {
  status: 'idle' | 'checking' | 'installing' | 'ready' | 'connecting' | 'connected' | 'error';
  installed: boolean;
  versions: { appium: string; uiautomator2: string; xcuitest: string };
  devices: Device[];
  diagnostics: string[];
  progress?: string;
  binding?: DeviceBinding;
  capabilities?: Record<string, { supported: boolean; reason?: string }>;
}
export class AutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
export const fail = (code: string, message: string, extra: Record<string, unknown> = {}): UiResult => ({
  ok: false,
  code,
  message,
  ...extra,
});
export const success = (extra: Record<string, unknown> = {}): UiResult => ({ ok: true, ...extra });
export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new AutomationError('CANCELLED', '操作已取消；请先检查界面，不自动重试。');
}
export async function pause(ms: number, signal?: AbortSignal) {
  checkCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new AutomationError('CANCELLED', '操作已取消。'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export const automationTools = new Set([
  'get_automation_status',
  'setup_automation',
  'connect_device',
  'disconnect_device',
  'get_ui_snapshot',
  'find_widget',
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
  'device_action',
  'wait_for_widget',
  'inspect_key_issues',
  'list_screenshot_targets',
  'take_screenshot',
]);

export function selectorFor(args: Target): Selector {
  if (args.selector) return args.selector;
  return {
    key: args.key,
    ...(args.ancestorKey !== undefined ? { ancestor: { key: args.ancestorKey } } : {}),
  };
}
export function flutterArgs(args: Record<string, any>): Record<string, unknown> {
  const typed = (value: string | number) => ({ type: typeof value === 'number' ? 'int' : 'string', value });
  return {
    ...args,
    ...(args.key !== undefined ? { key: typed(args.key) } : {}),
    ...(args.ancestorKey !== undefined ? { ancestor: typed(args.ancestorKey) } : {}),
    ...(args.targetKey !== undefined ? { targetKey: typed(args.targetKey) } : {}),
  };
}
export function mapFlutterPoint(
  bounds: Rect,
  flutter: { width: number; height: number },
  viewport: Rect,
): Point {
  const sx = viewport.width / flutter.width,
    sy = viewport.height / flutter.height;
  if (
    ![sx, sy, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    sx <= 0 ||
    sy <= 0 ||
    Math.abs(sx - sy) > Math.max(sx, sy) * 0.005
  )
    throw new AutomationError(
      'COORDINATE_MAPPING_UNCONFIRMED',
      'Flutter 与设备窗口比例不一致，请重新定位或校准 viewport。',
    );
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x < -1 ||
    bounds.y < -1 ||
    bounds.x + bounds.width > flutter.width + 1 ||
    bounds.y + bounds.height > flutter.height + 1
  )
    throw new AutomationError('NOT_VISIBLE', '目标超出 Flutter 窗口边界。');
  return {
    x: viewport.x + (bounds.x + bounds.width / 2) * sx,
    y: viewport.y + (bounds.y + bounds.height / 2) * sy,
  };
}

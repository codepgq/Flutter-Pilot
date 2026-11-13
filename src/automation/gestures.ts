import { AutomationError, type Point, type Rect } from './model';

export type PointerAction =
  | { type: 'pointerMove'; x: number; y: number; duration: number; origin: 'viewport' }
  | { type: 'pointerDown' | 'pointerUp'; button: 0 }
  | { type: 'pause'; duration: number };
export interface PointerTrack {
  type: 'pointer';
  id: string;
  parameters: { pointerType: 'touch' };
  actions: PointerAction[];
}
export interface GestureFinger {
  points: Array<Point & { timeMs: number }>;
}
const move = (p: Point, duration = 0): PointerAction => ({
  type: 'pointerMove',
  x: p.x,
  y: p.y,
  duration,
  origin: 'viewport',
});
const down: PointerAction = { type: 'pointerDown', button: 0 };
const up: PointerAction = { type: 'pointerUp', button: 0 };
const wait = (duration: number): PointerAction => ({ type: 'pause', duration });
const track = (id: number, actions: PointerAction[]): PointerTrack => ({
  type: 'pointer',
  id: `finger-${id}`,
  parameters: { pointerType: 'touch' },
  actions,
});

/** One bounded timeline shared by native W3C actions and Flutter pointer injection. */
export function buildGesture(
  tool: string,
  args: Record<string, any>,
  point: Point,
  rect: Rect,
  to?: Point,
): PointerTrack[] {
  const duration = args.durationMs ?? (tool === 'long_press' ? 650 : 350);
  let result: PointerTrack[];
  if (tool === 'perform_gesture') {
    const fingers = args.fingers as GestureFinger[];
    if (!Array.isArray(fingers) || fingers.length < 1 || fingers.length > 5)
      throw new AutomationError('INVALID_ARGUMENT', '手势需要 1–5 个触点。');
    const times = [...new Set(fingers.flatMap((f) => f.points.map((p) => p.timeMs)))].sort((a, b) => a - b);
    if (times[0] !== 0 || times.length > 120 || times.at(-1)! > 10000)
      throw new AutomationError('INVALID_ARGUMENT', '手势需从 0 开始，最多 120 个时间点、10 秒。');
    result = fingers.map((finger, index) => {
      if (
        finger.points.length < 2 ||
        finger.points.length > 120 ||
        finger.points[0].timeMs !== 0 ||
        finger.points.at(-1)!.timeMs !== times.at(-1) ||
        finger.points.some((p, i) => i > 0 && p.timeMs <= finger.points[i - 1].timeMs)
      )
        throw new AutomationError('INVALID_ARGUMENT', '各触点时间必须严格递增，且具有相同起止时间。');
      const at = (time: number): Point => {
        const next = finger.points.findIndex((p) => p.timeMs >= time);
        if (next === 0) return finger.points[0];
        const a = finger.points[next - 1],
          b = finger.points[next],
          ratio = (time - a.timeMs) / (b.timeMs - a.timeMs);
        return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
      };
      return track(index, [
        move(at(0)),
        down,
        ...times.slice(1).map((time, i) => move(at(time), time - times[i])),
        up,
      ]);
    });
  } else if (tool === 'tap' || tool === 'double_tap' || tool === 'long_press') {
    const actions: PointerAction[] = [move(point), down, wait(tool === 'long_press' ? duration : 45), up];
    if (tool === 'double_tap') actions.push(wait(args.intervalMs ?? 100), move(point), down, wait(45), up);
    result = [track(0, actions)];
  } else if (tool === 'pinch' || tool === 'rotate_gesture') {
    const radius = args.radius ?? Math.min(rect.width, rect.height) * 0.2;
    const scale = tool === 'pinch' ? args.scale : 1;
    const angle = tool === 'rotate_gesture' ? (args.angleDegrees * Math.PI) / 180 : 0;
    result = [0, 1].map((index) => {
      const sign = index === 0 ? -1 : 1;
      const start = { x: point.x + sign * radius, y: point.y };
      const actions: PointerAction[] = [move(start), down];
      const steps = Math.max(12, Math.ceil(Math.abs(angle) / (Math.PI / 12)));
      for (let step = 1; step <= steps; step++) {
        const fraction = step / steps,
          r = radius * (1 + (scale - 1) * fraction),
          theta = angle * fraction;
        actions.push(
          move(
            { x: point.x + sign * r * Math.cos(theta), y: point.y + sign * r * Math.sin(theta) },
            Math.round(duration / steps),
          ),
        );
      }
      return track(index, [...actions, up]);
    });
  } else {
    const distance = args.distance ?? Math.min(rect.width, rect.height) * 0.5;
    const vector: Record<string, Point> = {
      up: { x: 0, y: -distance },
      down: { x: 0, y: distance },
      left: { x: -distance, y: 0 },
      right: { x: distance, y: 0 },
    };
    const delta = vector[args.direction ?? 'up'];
    const start = to ? point : { x: point.x - delta.x / 2, y: point.y - delta.y / 2 };
    const end = to ?? { x: point.x + delta.x / 2, y: point.y + delta.y / 2 };
    result = [
      track(0, [
        move(start),
        down,
        wait(tool === 'drag' ? (args.holdMs ?? 100) : 40),
        ...Array.from({ length: 12 }, (_, i) =>
          move(
            {
              x: start.x + (end.x - start.x) * ((i + 1) / 12),
              y: start.y + (end.y - start.y) * ((i + 1) / 12),
            },
            Math.floor((duration * (i + 1)) / 12) - Math.floor((duration * i) / 12),
          ),
        ),
        ...(tool === 'drag' ? [wait(100)] : []),
        up,
      ]),
    ];
  }
  validateTracks(result, rect);
  return result;
}

export function validateTracks(tracks: PointerTrack[], screen: Rect) {
  if (
    !Array.isArray(tracks) ||
    !tracks.length ||
    tracks.length > 5 ||
    new Set(tracks.map((t) => t.id)).size !== tracks.length
  )
    throw new AutomationError('INVALID_ARGUMENT', '触点数量超出限制。');
  for (const finger of tracks) {
    if (
      finger.type !== 'pointer' ||
      finger.parameters?.pointerType !== 'touch' ||
      !Array.isArray(finger.actions) ||
      finger.actions.length > 125
    )
      throw new AutomationError('INVALID_ARGUMENT', '触点轨迹无效。');
    let total = 0,
      pressed = false,
      positioned = false;
    for (const action of finger.actions) {
      if (!['pointerMove', 'pointerDown', 'pointerUp', 'pause'].includes(action.type))
        throw new AutomationError('INVALID_ARGUMENT', '触点动作无效。');
      if (action.type === 'pointerDown') {
        if (pressed || !positioned || action.button !== 0)
          throw new AutomationError('INVALID_ARGUMENT', '触点按下顺序无效。');
        pressed = true;
      } else if (action.type === 'pointerUp') {
        if (!pressed || action.button !== 0)
          throw new AutomationError('INVALID_ARGUMENT', '触点释放顺序无效。');
        pressed = false;
      }
      if (action.type === 'pointerMove') positioned = true;
      if ('duration' in action) {
        if (!Number.isFinite(action.duration) || action.duration < 0)
          throw new AutomationError('INVALID_ARGUMENT', '手势时长无效。');
        total += action.duration;
      }
      if (
        action.type === 'pointerMove' &&
        (!Number.isFinite(action.x) ||
          !Number.isFinite(action.y) ||
          action.x < screen.x ||
          action.y < screen.y ||
          action.x >= screen.x + screen.width ||
          action.y >= screen.y + screen.height)
      )
        throw new AutomationError('POINT_OUT_OF_BOUNDS', '手势坐标超出窗口。');
    }
    if (pressed) throw new AutomationError('INVALID_ARGUMENT', '轨迹结束必须释放触点。');
    if (total > 10000) throw new AutomationError('INVALID_ARGUMENT', '单次手势最长 10 秒。');
  }
}

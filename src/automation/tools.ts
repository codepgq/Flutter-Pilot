import { z } from 'zod';

const key = z.union([z.string().min(1).max(512), z.number().int().safe()]);
const match = {
  key: key.optional(),
  text: z.string().max(1024).optional(),
  semantics: z.string().max(1024).optional(),
  type: z.string().min(1).max(256).optional(),
  accessibilityId: z.string().max(1024).optional(),
  resourceId: z.string().max(1024).optional(),
  ref: z.string().min(1).max(256).optional(),
};
const nonempty = (s: Record<string, unknown>) => Object.values(s).some((value) => value !== undefined);
const ancestor = z.object(match).strict().refine(nonempty, '祖先条件不能为空。');
export const uiSelectorSchema = z
  .object({ source: z.enum(['flutter', 'device']).optional(), ...match, ancestor: ancestor.optional() })
  .strict()
  .refine(
    (s) =>
      nonempty(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'source' && k !== 'ancestor'))),
    '选择器不能为空。',
  );
const point = z
  .object({ x: z.number().finite().min(0).max(100000), y: z.number().finite().min(0).max(100000) })
  .strict();
const rect = z
  .object({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();
const session = { sessionId: z.string().min(1).max(256) };
const backend = { backend: z.enum(['auto', 'flutter', 'device']).optional() };
const timeout = { timeoutMs: z.number().int().min(100).max(30000).optional() };
const target = { key: key.optional(), ancestorKey: key.optional(), selector: uiSelectorSchema.optional() };
const duration = { durationMs: z.number().int().min(40).max(10000).optional() };
function validateTarget(args: Record<string, any>, ctx: z.RefinementCtx, allowPoint = false) {
  const count =
    Number(args.key !== undefined) + Number(args.selector !== undefined) + Number(args.point !== undefined);
  if (
    count !== 1 ||
    (args.ancestorKey !== undefined && args.key === undefined) ||
    (!allowPoint && args.point !== undefined)
  )
    ctx.addIssue({ code: 'custom', message: '须指定唯一目标：key、selector，或显式 point。' });
  if (
    args.selector &&
    (args.selector.source === 'device' ||
      args.selector.accessibilityId !== undefined ||
      args.selector.resourceId !== undefined ||
      args.selector.ref?.startsWith('device:')) &&
    (args.selector.key !== undefined || args.selector.ancestor?.key !== undefined)
  )
    ctx.addIssue({ code: 'custom', message: '原生选择器不能使用 Flutter Key。' });
  if (
    args.selector?.source === 'flutter' &&
    [args.selector, args.selector.ancestor].some(
      (s) =>
        s && (s.accessibilityId !== undefined || s.resourceId !== undefined || s.ref?.startsWith('device:')),
    )
  )
    ctx.addIssue({ code: 'custom', message: 'Flutter 选择器不能包含设备条件。' });
  if (
    args.backend === 'flutter' &&
    args.selector &&
    (args.selector.source === 'device' ||
      [args.selector, args.selector.ancestor].some(
        (s) =>
          s &&
          (s.accessibilityId !== undefined || s.resourceId !== undefined || s.ref?.startsWith('device:')),
      ))
  )
    ctx.addIssue({ code: 'custom', message: '原生目标需要设备通道。' });
}
const nestedTarget = z
  .object({ ...target, point: point.optional() })
  .strict()
  .superRefine((a: any, c) => validateTarget(a, c, true));
const targeted = (extra: z.ZodRawShape = {}, allowPoint = false) =>
  z
    .object({
      ...session,
      ...target,
      ...backend,
      ...timeout,
      ...(allowPoint ? { point: point.optional() } : {}),
      ...extra,
    })
    .strict()
    .superRefine((a: any, c) => validateTarget(a, c, allowPoint));
const simple = (extra: z.ZodRawShape = {}) =>
  z.object({ ...session, ...backend, ...timeout, ...extra }).strict();

export const automationMcpTools = {
  get_automation_status: {
    description: '只读检查私有 Appium 环境、设备及分项能力；不会下载或连接设备。',
    schema: z.object(session).strict(),
  },
  setup_automation: {
    description: '准备插件私有 Appium 和固定版本驱动；仅此入口安装依赖，可取消和重试，不修改全局 Appium。',
    schema: z.object(session).strict(),
  },
  connect_device: {
    description:
      '将项目绑定到明确的设备 ID 和 App 包名/Bundle ID，附着已有 App，不清数据、不重启。iOS 真机需预签名 WDA。',
    schema: z
      .object({
        ...session,
        deviceId: z.string().min(1).max(512),
        vmDeviceId: z
          .string()
          .min(1)
          .max(512)
          .optional()
          .describe('手动 VM 连接时，显式确认该 VM 所属的设备 ID；须与 deviceId 一致。'),
        appId: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9_.-]+$/),
        wdaPath: z.string().min(1).max(4096).optional(),
        wdaBundleId: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9_.-]+$/)
          .optional(),
        viewport: rect.optional(),
      })
      .strict()
      .refine(
        (a) => a.vmDeviceId === undefined || a.vmDeviceId === a.deviceId,
        'vmDeviceId 必须与 deviceId 一致。',
      ),
  },
  disconnect_device: {
    description: '释放本插件持有的设备自动化会话、触点、按键和设备租约；不终止目标 App。',
    schema: z.object(session).strict(),
  },
  get_ui_snapshot: {
    description: '读取 Flutter 或设备原生界面结构。source=device 包含键盘、系统弹窗；引用随界面变化失效。',
    schema: z
      .object({
        ...session,
        source: z.enum(['flutter', 'device']).optional(),
        maxNodes: z.number().int().min(1).max(1000).optional(),
      })
      .strict(),
  },
  find_widget: {
    description:
      '按 Key 或显式组合选择器查找；支持文字、语义、类型、祖先和快照引用。歧义报候选，不静默更换定位策略。',
    schema: targeted(),
  },
  tap: {
    description: '点击唯一目标或显式坐标；auto 在设备连接后使用系统触摸。超时不自动重试。',
    schema: targeted({}, true),
  },
  double_tap: {
    description: '对唯一目标或坐标执行双击，intervalMs 为两次点击间隔。',
    schema: targeted({ intervalMs: z.number().int().min(40).max(250).optional() }, true),
  },
  long_press: {
    description: '按住目标或坐标，durationMs 控制时长；不直接调用业务回调。',
    schema: targeted(duration, true),
  },
  drag: {
    description: '从目标或坐标拖到 to 指定的目标或坐标；支持先按住再移动。',
    schema: targeted(
      { ...duration, holdMs: z.number().int().min(0).max(5000).optional(), to: nestedTarget },
      true,
    ),
  },
  swipe: {
    description: '以目标或坐标为中心按方向滑动；direction 表示手指移动方向，区别于 scroll 的内容方向。',
    schema: targeted(
      {
        ...duration,
        direction: z.enum(['up', 'down', 'left', 'right']),
        distance: z.number().finite().min(1).max(4000).optional(),
      },
      true,
    ),
  },
  pinch: {
    description: '双指以目标中心缩放，scale>1 放大、scale<1 缩小；radius 为起始半径。',
    schema: targeted(
      {
        ...duration,
        scale: z.number().finite().min(0.1).max(5),
        radius: z.number().finite().min(5).max(2000).optional(),
      },
      true,
    ),
  },
  rotate_gesture: {
    description: '双指围绕目标旋转，angleDegrees 为角度，正值在屏幕上顺时针。',
    schema: targeted(
      {
        ...duration,
        angleDegrees: z.number().finite().min(-360).max(360),
        radius: z.number().finite().min(5).max(2000).optional(),
      },
      true,
    ),
  },
  perform_gesture: {
    description: '执行显式同步多指轨迹，1–5 指、最长10秒；各指从 timeMs=0 开始且结束时间相同。',
    schema: simple({
      fingers: z
        .array(
          z
            .object({
              points: z
                .array(
                  z
                    .object({
                      x: z.number().finite().min(0).max(100000),
                      y: z.number().finite().min(0).max(100000),
                      timeMs: z.number().int().min(0).max(10000),
                    })
                    .strict(),
                )
                .min(2)
                .max(120),
            })
            .strict(),
        )
        .min(1)
        .max(5),
    }),
  },
  scroll: {
    description:
      '滚动唯一指定区域，可选择嵌套子区域、横向和速度；targetKey/targetSelector 用于有界查找，不自动选择其他列表。',
    schema: targeted({
      ...duration,
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      distance: z.number().finite().min(1).max(2000).optional(),
      targetKey: key.optional(),
      targetSelector: uiSelectorSchema.optional(),
      maxSteps: z.number().int().min(1).max(30).optional(),
    }).superRefine((a: any, c) => {
      if (a.targetKey !== undefined && a.targetSelector !== undefined)
        c.addIssue({ code: 'custom', message: '只使用一种滚动目标。' });
    }),
  },
  enter_text: {
    description:
      '聚焦唯一输入框并替换文本；mode=append 需显式 backend=flutter，设备通道无法确认末尾光标时明确拒绝。支持业务中文输入，不代表输入法候选测试。',
    schema: targeted({ text: z.string().max(16384), mode: z.enum(['replace', 'append']).optional() }),
  },
  edit_text: {
    description:
      '文本清空、删除、选区、光标、全选及复制剪切粘贴。iOS 使用可见中英文编辑菜单；Flutter 精确编辑走编辑协议并保持 formatter/onChanged。',
    schema: targeted({
      action: z.enum([
        'clear',
        'delete',
        'move_cursor',
        'select_range',
        'select_all',
        'copy',
        'cut',
        'paste',
      ]),
      offset: z.number().int().min(0).max(16384).optional(),
      start: z.number().int().min(0).max(16384).optional(),
      end: z.number().int().min(0).max(16384).optional(),
    }).superRefine((a: any, c) => {
      if (
        (a.action === 'move_cursor' && a.offset === undefined) ||
        (a.action === 'select_range' && (a.start === undefined || a.end === undefined))
      )
        c.addIssue({ code: 'custom', message: '精确编辑需要 offset 或 start/end。' });
    }),
  },
  press_key: {
    description: '向当前焦点发送命名按键或单个字符，可带 Control/Shift/Alt/Meta；不同平台按能力返回结果。',
    schema: simple({
      keyName: z.string().min(1).max(32),
      modifiers: z
        .array(z.enum(['Control', 'Shift', 'Alt', 'Meta']))
        .max(4)
        .refine((a) => new Set(a).size === a.length)
        .optional(),
    }),
  },
  get_keyboard_state: {
    description: '查询当前键盘可见状态；Flutter 通道同时返回输入焦点信息。',
    schema: simple(),
  },
  hide_keyboard: {
    description: '通过输入链路收起键盘并有界等待隐藏状态确认，再继续后续操作；不能据此认定业务提交完成。',
    schema: simple(),
  },
  editor_action: {
    description: '向当前编辑器发送 done/search/send/go/next/previous/newline；需核对提交或焦点变化。',
    schema: simple({ action: z.enum(['done', 'search', 'send', 'go', 'next', 'previous', 'newline']) }),
  },
  device_action: {
    description: '设备返回、Home、前后台、通知栏/控制中心开关及旋转；iOS 返回需显式按钮或边缘手势。',
    schema: z
      .object({
        ...session,
        ...timeout,
        action: z.enum([
          'back',
          'home',
          'foreground',
          'background',
          'notifications',
          'control_center',
          'close_panels',
          'rotate',
          'restore_orientation',
        ]),
        orientation: z.enum(['PORTRAIT', 'LANDSCAPE']).optional(),
        selector: uiSelectorSchema.optional(),
      })
      .strict()
      .superRefine((a: any, c) => {
        if (a.action === 'rotate' && !a.orientation)
          c.addIssue({ code: 'custom', message: '旋转需要 orientation。' });
      }),
  },
  wait_for_widget: {
    description:
      '有界等待出现、消失、可见、启用、可操作或文字变化。文字条件需 text；失败 diagnostics 包含实际选择器、条件、期限和最后观测状态，区分未找到与状态不满足。超时不重放触发动作。',
    schema: targeted({
      state: z
        .enum([
          'present',
          'absent',
          'visible',
          'enabled',
          'actionable',
          'text_equals',
          'text_contains',
          'text_changed',
        ])
        .optional(),
      text: z.string().max(1024).optional(),
    }).superRefine((a: any, c) => {
      if (String(a.state).startsWith('text_') && a.text === undefined)
        c.addIssue({ code: 'custom', message: '文字条件需要 text。' });
    }),
  },
  inspect_key_issues: {
    description: '诊断当前挂载 Flutter 交互目标的 Key；不阻止用户显式使用其他定位方式。',
    schema: z.object({ ...session, maxNodes: z.number().int().min(1).max(1000).optional() }).strict(),
  },
  list_screenshot_targets: {
    description:
      '长截图前列出 Flutter 可见滚动区域；多区域须明确 targetId，普通截屏无需调用。只读取、不滚动，无需 Key、Scene、Mock 或 Appium。',
    schema: z.object(session).strict(),
  },
  take_screenshot: {
    description:
      '用户要求当前 Flutter App 截图/截屏/screenshot/布局对比时优先调用。source=flutter、mode=screen 获取 App PNG，无需 Key、Scene、Mock 或 Appium；长图 mode=long 前 list_screenshot_targets。source=device、mode=screen 包含键盘/系统 UI，需绑定设备；不截桌面或浏览器网页。',
    schema: z
      .object({
        ...session,
        mode: z.enum(['screen', 'long']),
        source: z.enum(['flutter', 'device']).optional(),
        targetId: z.string().min(1).max(512).optional(),
      })
      .strict()
      .superRefine((a: any, c) => {
        if ((a.mode === 'screen' && a.targetId !== undefined) || (a.source === 'device' && a.mode === 'long'))
          c.addIssue({ code: 'custom', message: '设备只支持整屏截图，targetId 只用于 Flutter 长图。' });
      }),
  },
} as const;

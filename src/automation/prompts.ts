import { automationMcpTools } from './tools';

const common = [
  '已有 Flutter Debug VM 且使用 backend=flutter 时直接操作，无需安装 Appium 或连接设备。需要原生/系统界面、设备输入或确认 auto 路由时，先 get_automation_status 检查绑定和分项能力，再按需 setup_automation / connect_device；连接需明确 deviceId 和 appId。',
  '优先使用实际 Key；无 Key 时可显式使用文字、语义、类型、祖先范围或快照引用。source=device 用于原生与系统界面。组合条件必须唯一，歧义时进一步限定，不静默更换选择器。',
  '根据工具 JSON Schema 传参。backend=auto 连接设备后使用系统输入，device 动作失败不自动换通道重放；坐标显式提供，布局/方向变化后重新定位。',
  '操作后通过 wait_for_widget、重新快照和需要时的新网络记录验证。dispatched 不代表业务成功；超时或取消先检查结果，不自动重试。',
] as const;
export const automationPromptPlans = Object.fromEntries(
  Object.entries(automationMcpTools).map(([name, tool]) => [
    name,
    {
      topics: ['ui'] as const,
      steps: [
        tool.description,
        ...common,
        ...(name === 'take_screenshot'
          ? [
              'Flutter 长图先调用 list_screenshot_targets；最多32屏、30000像素高、2400万像素。MCP 传输上限32 MiB，客户端调用超时建议至少90 秒。设备截图只支持 screen，包含系统 UI。',
            ]
          : []),
        ...(name === 'connect_device'
          ? [
              'iOS 真机须提供已签名 WDA 路径和 Bundle ID，并完成开发者模式、配对与信任。不得自动签名或操作钥匙串。',
            ]
          : []),
        ...(name === 'hide_keyboard'
          ? [
              '输入后可能有键盘显示动画或遮挡时，调用 hide_keyboard({sessionId,backend?,timeoutMs?})；Flutter VM 可显式 backend=flutter，设备键盘使用已连接设备通道，auto 在设备连接后选设备。此工具不需要 key、selector 或 target。',
              '成功需确认 shown:false：已显示键盘会收起并等待连续隐藏观测，后续才 wait_for_widget(state=actionable) 和点击；设备键盘原本未显示时可返回 dispatched:false。Scene 中保存 {"id":"hide_email_keyboard","type":"hide_keyboard","timeoutMs":10000}，该步骤无 target，后端由运行参数决定。',
              'KEYBOARD_NOT_HIDDEN、KEYBOARD_STATE_UNCONFIRMED、超时或 uncertain 时停止后续点击，先 get_keyboard_state 和必要的界面查询确认实际状态，不自动重放输入、提交或切换后端；收起键盘不代表表单已提交或业务成功。',
            ]
          : []),
        ...(name === 'wait_for_widget'
          ? [
              '失败时读取 diagnostics.selector、condition、timeoutMs、attempts 与 lastObservation；NOT_FOUND 表示本次定位未找到目标，FOUND 表示目标存在但等待条件未满足。文字匹配只记录布尔结果，不保存控件文字或期望文字。先核对当前页面、操作前提和新网络记录，再决定下一步。',
            ]
          : []),
      ],
    },
  ]),
) as unknown as {
  [K in keyof typeof automationMcpTools]: { topics: readonly ['ui']; steps: readonly string[] };
};

export const automationInstructions = Object.keys(automationMcpTools).join('、');
export function automationGuide() {
  const sessionId = '<从 list_sessions 选择的会话ID>';
  return {
    purpose: 'Flutter VM 定位 + 插件托管 Appium 设备输入，覆盖移动应用与系统常用交互。',
    setup: [
      '以下准备仅在需要设备输入、原生或系统 UI 时执行；已有 Flutter VM 的 backend=flutter 操作无需 Appium。',
      { tool: 'get_automation_status', arguments: { sessionId } },
      { tool: 'setup_automation', arguments: { sessionId } },
      { tool: 'connect_device', arguments: { sessionId, deviceId: '<设备ID>', appId: 'com.example.app' } },
      '首次准备才下载；私有 Appium 与驱动固定版本，状态查询不安装。iOS 真机需已签名 WDA。',
    ],
    discovery: [
      { tool: 'get_ui_snapshot', arguments: { sessionId, source: 'flutter', maxNodes: 200 } },
      { tool: 'get_ui_snapshot', arguments: { sessionId, source: 'device', maxNodes: 200 } },
      {
        tool: 'find_widget',
        arguments: { sessionId, selector: { text: '登录', type: 'Text', ancestor: { key: 'login.page' } } },
      },
      '选择器按组合条件精确匹配。设备端可用 accessibilityId/resourceId/text/type/ref 与 ancestor。ref 只对当前快照和会话有效，界面变化后重新读取。',
    ],
    examples: [
      { tool: 'tap', arguments: { sessionId, key: 'login.submit', backend: 'auto' } },
      {
        tool: 'long_press',
        arguments: { sessionId, selector: { text: '消息', type: 'Text' }, durationMs: 700 },
      },
      { tool: 'double_tap', arguments: { sessionId, key: 'photo', intervalMs: 100 } },
      { tool: 'drag', arguments: { sessionId, key: 'item.1', to: { key: 'item.3' }, holdMs: 600 } },
      { tool: 'pinch', arguments: { sessionId, key: 'map', scale: 1.5 } },
      { tool: 'rotate_gesture', arguments: { sessionId, key: 'map', angleDegrees: 45 } },
      {
        tool: 'enter_text',
        arguments: { sessionId, key: 'search', text: '中文', mode: 'append', backend: 'flutter' },
      },
      { tool: 'hide_keyboard', arguments: { sessionId, backend: 'flutter', timeoutMs: 10000 } },
      {
        tool: 'edit_text',
        arguments: { sessionId, key: 'search', action: 'select_range', start: 0, end: 2 },
      },
      { tool: 'editor_action', arguments: { sessionId, action: 'search' } },
      {
        tool: 'scroll',
        arguments: {
          sessionId,
          key: 'orders.list',
          direction: 'down',
          targetSelector: { key: 'order.42' },
          maxSteps: 10,
        },
      },
      {
        tool: 'wait_for_widget',
        arguments: { sessionId, key: 'status', state: 'text_equals', text: '完成', timeoutMs: 5000 },
      },
      { tool: 'device_action', arguments: { sessionId, action: 'home' } },
      { tool: 'take_screenshot', arguments: { sessionId, mode: 'screen', source: 'device' } },
    ],
    routing:
      'auto 在设备连接后优先设备输入；未连接时使用 VM。Flutter Key、文字、语义和 Widget 类型由 VM 定位；device 选择器定位原生/系统 UI。Flutter 转设备坐标需目标 App 在前台、窗口比例一致、布局及方向稳定；无法确认返回明确错误，可在 connect_device 提供经过验证的 viewport。',
    text: 'enter_text 默认替换；追加显式使用 backend=flutter，设备通道在输入前返回不支持。Flutter 精确选区/光标走编辑协议，UTF-16 offset 必须位于完整字符簇边界，保留 formatter/onChanged 并返回 inputMethod；中文输入不等于验证真实 IME 候选。原生精确选区不支持时明确报错。iOS 剪贴板使用可见中英文编辑菜单，点击前核验目标编辑器与选区；无法确认时要求重新快照。硬件组合键依赖设备设置。',
    waitDiagnostics:
      'wait_for_widget 失败返回 diagnostics：selector、condition、timeoutMs、attempts 和 lastObservation（code、present 及可用的 visible/enabled/actionable/textMatches）。NOT_FOUND 与 FOUND 区分未找到和状态未满足；文字匹配只保存布尔结果。超时不自动重放触发动作。',
    boundaries:
      '仅用户任务范围内操作。不直接调用业务回调，不静默换定位或后端。设备租约独占；动作已发送但未确认时 uncertain=true，先检查结果，不自动重试。平台不支持则报告，不虚构通过。系统权限弹窗需读取 device 快照后显式点击。',
  };
}

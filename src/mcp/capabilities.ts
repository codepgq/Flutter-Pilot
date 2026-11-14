import type { GuideTopic } from './guide';
import type { McpToolName } from './tools';

interface CapabilityRoute {
  id: string;
  title: string;
  requests: readonly string[];
  tools: readonly McpToolName[];
  prompt: string;
  topics: readonly GuideTopic[];
  workflow: string;
}

/** Task vocabulary shared by initialization, offline discovery and capability prompts. */
export const capabilityRoutes = [
  {
    id: 'screenshot',
    title: 'App 截图与长截图',
    requests: ['截图', '截屏', '看当前页面', '长截图', '布局对比', 'screenshot'],
    tools: ['take_screenshot', 'list_screenshot_targets'],
    prompt: 'app_screenshot',
    topics: ['screenshot'],
    workflow:
      '目标是当前 Flutter App 时，优先使用 Flutter Pilot 的 take_screenshot。普通截图 mode=screen、source=flutter；长图 mode=long，先 list_screenshot_targets 明确滚动区域。无需 Key、Scene、Mock 或 Appium。包含键盘/系统 UI 的设备整屏使用 source=device、mode=screen，需已绑定设备。',
  },
  {
    id: 'app',
    title: 'App 会话、启动与热更新',
    requests: ['启动 App', '运行应用', '热重载', '热重启', '应用源码修改', 'hot reload', 'hot restart'],
    tools: ['list_sessions', 'start_app', 'hot_reload', 'hot_restart'],
    prompt: 'start_app',
    topics: ['workflow'],
    workflow:
      '先确认项目与已有 Debug 会话并复用；App 未运行且任务需要时才按保存的命名配置 start_app。源码变更保留状态用 hot_reload，重跑入口用 hot_restart；TIMEOUT 先查已有会话，不重复启动。只启动任务到此完成，无需激活 Mock 或运行 Scene。',
  },
  {
    id: 'http',
    title: 'HTTP 请求排查与 API Mock',
    requests: ['接口报错', '查请求响应', '空数据', '接口失败', '余额不足', '资产数据', 'API Mock'],
    tools: [
      'get_network_status',
      'get_requests',
      'get_request',
      'reload_rules',
      'set_capture_enabled',
      'list_scenes',
      'activate_scene',
      'deactivate_scene',
    ],
    prompt: 'http_mock',
    topics: ['http'],
    workflow:
      '只查请求无需开启 Mock。需要模拟时按实际接口契约增量编辑 files.scenes，reload_rules 后激活所需场景；检查相关 Dio 接入，以本轮新请求、规则命中与页面验证，不能从 applied 推断命中。',
  },
  {
    id: 'ws',
    title: 'WebSocket 消息与业务事件',
    requests: ['查 WS 消息', '模拟推送', '订单状态变化', '注入消息', '向服务端发送', 'WebSocket Mock'],
    tools: ['get_ws_connections', 'get_ws_messages', 'inject_ws_message', 'send_ws_message'],
    prompt: 'websocket_mock',
    topics: ['ws'],
    workflow:
      '确认准确业务连接及 WS 采集。inject_ws_message 向 App 注入模拟服务端消息，send_ws_message 经 App 当前真实连接向服务端发送；text 与 topic/data 二选一，仅收发无需激活场景。规则替换/丢弃按场景配置，以本轮消息和业务结果验证。',
  },
  {
    id: 'ui',
    title: 'Widget 定位、交互与 Key 诊断',
    requests: ['找控件', '点击按钮', '滚动列表', '拖拽', '缩放', '等待页面', '检查 Key'],
    tools: [
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
      'wait_for_widget',
      'inspect_key_issues',
    ],
    prompt: 'flutter_ui',
    topics: ['ui'],
    workflow:
      '重复流程先复用已有 Scene action；缺少操作或定位失效时才读取结构、确认真实稳定 Key。backend=flutter 可独立使用 VM；按实际指针交互，禁用或遮挡不绕过。等待失败先读 diagnostics 的实际选择器与最后状态。',
  },
  {
    id: 'text',
    title: '文本编辑与键盘',
    requests: ['输入文字', '清空输入框', '复制粘贴', '选中文字', '收起键盘', '提交搜索'],
    tools: ['enter_text', 'edit_text', 'press_key', 'get_keyboard_state', 'hide_keyboard', 'editor_action'],
    prompt: 'enter_text',
    topics: ['ui'],
    workflow:
      '输入需唯一真实目标；追加显式 backend=flutter，设备通道不能确认末尾光标时拒绝。输入影响布局时 hide_keyboard 确认隐藏，再等待按钮可操作；中文输入不等于真实 IME 候选验收。',
  },
  {
    id: 'device',
    title: '设备、原生与系统界面',
    requests: ['权限弹窗', '系统键盘', '通知栏', '设备返回', '切换前后台', '旋转设备'],
    tools: [
      'get_automation_status',
      'setup_automation',
      'connect_device',
      'disconnect_device',
      'device_action',
    ],
    prompt: 'connect_device',
    topics: ['ui'],
    workflow:
      '原生或系统 UI 才按需检查并准备私有 Appium，明确 deviceId/appId 后连接；设备快照和截图显式 source=device。只查询状态不安装、不连接；不把设备准备作为 Flutter VM 操作的前提。',
  },
  {
    id: 'scene',
    title: '复用与归档 Scene 操作',
    requests: ['登录到主页', '自动填表', '执行已有操作', '保存可复用流程', '运行 Scene action'],
    tools: ['list_scene_actions', 'run_scene_action', 'get_scene_action_run', 'cancel_scene_action_run'],
    prompt: 'scene_action_quick_run',
    topics: ['workflow', 'ui'],
    workflow:
      'list_scenes → list_scene_actions 查前提和输入，run_scene_action 显式启动并查询 runId；target 自动解析真实 Key，无需每步截图/find_widget。新增归档查 scene_action_authoring；公共 call 不切换 Mock，completed 后独立核验 UI 与本轮网络。',
  },
  {
    id: 'test',
    title: '业务测试与关联断言',
    requests: ['运行测试用例', '验证下单结果', '回归测试', '关联 HTTP WS UI', '取消测试'],
    tools: ['list_tests', 'run_test', 'get_test_run', 'cancel_test_run'],
    prompt: 'run_test',
    topics: ['workflow'],
    workflow:
      'list_tests 读取 tests.json v2，复用 Scene action 和本轮 HTTP/WS/UI 断言；run_test 显式运行，get_test_run 查询证据与清理，仅 passed 表示通过。运行使用已有 Debug App，临时环境结束恢复，真实业务不回滚。',
  },
  {
    id: 'help',
    title: '离线能力与参数查阅',
    requests: ['支持什么功能', '怎么使用', '查看参数', '能力介绍'],
    tools: ['get_usage_guide'],
    prompt: 'capabilities',
    topics: ['overview'],
    workflow:
      'get_usage_guide、resources/read 与 prompts/get 可离线查阅，无需任务、sessionId 或 IDE；每个工具有同名 Prompt 与生产 schema，读取说明不执行运行时操作。',
  },
] as const satisfies readonly CapabilityRoute[];

export function describeCapabilityRoutes(): string {
  return capabilityRoutes
    .map(
      (route) =>
        `- ${route.title}：用户说“${route.requests.join(' / ')}” → ${route.tools.join('、')}。${route.workflow} 详见 Prompt ${route.prompt} / 指南 ${route.topics.join('、')}。`,
    )
    .join('\n');
}

import type { GuideTopic } from './guide';

export interface PromptTemplate {
  description: string;
  topics: readonly GuideTopic[];
  steps: readonly string[];
  referenceOnly?: boolean;
}

/** Shared by prompt discovery and the offline guide so entry points stay discoverable. */
export const capabilityPromptTemplates = {
  capabilities: {
    description:
      '只读能力总览：查阅全部 MCP 工具及同名 Prompts，导航 App 启动、HTTP/WS Mock、Widget Key、键盘、等待诊断、Scene 操作、归档和业务测试；无需 IDE 或会话。',
    topics: ['overview'],
    referenceOnly: true,
    steps: [
      '本 Prompt 用于查阅能力，不执行 UI、不启动 App、不修改 Mock，无需 list_sessions、sessionId 或在线 IDE。下方工具清单由实际注册表生成，每个工具均可通过同名 prompts/get 查阅步骤与生产参数 schema。',
      '已有登录、填表或导航操作：读取 scene_action_quick_run。它覆盖复用或 start_app 启动已有 Debug 配置、发现 actions、准备 Mock、后台执行、查询/取消及最终 UI 和本轮网络验证。工作台 Scene 详情的「UI 操作（Workflow）」也支持参数、通道、步骤 Key 预览、手动运行和取消。',
      '新增或整理操作：读取 scene_action_authoring。它覆盖 scenes.json v1、targets 别名到真实 Widget Key、hide_keyboard、跨 Scene call、秘密参数、公共操作归档和 Test Case v2 引用。操作来源与当前 Mock 独立，激活、重载、重连和重开 IDE 不自动执行 UI。',
      'HTTP 与 WS 分别查阅 http_mock / websocket_mock；界面探索和 Key 修复查阅 flutter_ui；需要组合 Mock、UI 和断言的完整任务查阅 mock_workflow。hot_reload 保留页面状态，hot_restart 重跑入口；原生或系统 UI 按需准备设备通道。',
      '等待或流程失败时查阅 wait_for_widget / get_scene_action_run / get_test_run：诊断包含实际 selector、condition、timeoutMs、attempts 和 lastObservation，区分当前未找到目标与目标已找到但状态不满足。先按失败证据排查，不盲目加长等待或重放提交。',
      '需要详细示例时读取 get_usage_guide 的 overview/http/ws/ui/workflow 主题，或 resources/read 对应 flutter-pilot://guides/<topic>。仅查阅指南不需要运行时会话；具体能力是否可用在执行时检查，不把能力目录当作设备验收结果。',
    ],
  },
  scene_action_quick_run: {
    description:
      '快速运行已有 Scene 操作：复用或启动 App、选择 Mock 与命名 action、传参、查询进度/取消，按真实 Widget Key 自动完成登录或导航并验证结果。',
    topics: ['workflow', 'ui'],
    steps: [
      '调用 list_sessions 选择任务对应项目、设备和已有 Debug 会话，再 list_scenes → list_scene_actions(sceneId) 查找名称、说明、起点、参数与 targets。优先复用保存的操作，不读取整份 Mock 正文或逐步探索；首次登录、最近账号页和已有登录会话应选各自入口。',
      'App 未运行才从 capabilities.appLaunch.configurations 选择 configurationName 调用 start_app，可传已确认的原生 deviceId。已有正确会话直接复用；TIMEOUT 先查 list_sessions 和 IDE，不重复启动、不清数据。启动不执行 Scene 操作，也不保证启动首请求被 Mock。',
      '配置有修改时 reload_rules，按任务 activate_scene 选择所需 Mock，再 get_network_status 检查相关 HTTP/Dio 或 WS 接入；无需等待无关域。纯操作无需激活 Mock，公共操作可以来自另一 Scene，run_scene_action 不隐式切换当前 Mock。环境已就绪且文件未变时无需重复重载或激活。',
      '记录请求/消息的时间或 ID 基线，调用 run_scene_action({sessionId,sceneId,actionId,inputs?,backend?})，inputs 的值为字符串，Flutter Key 操作可显式 backend=flutter。预检全部引用、参数和限额后返回 runId，由插件在后台自动执行，每步将 target 别名绑定到真实 Key 并重新定位，无需 Agent 每步 find_widget、截图或模型判断。',
      'get_scene_action_run({sessionId,runId}) 查询进度直至终态，需要停止则 cancel_scene_action_run 后继续查终态。运行期间动作和测试共用设备锁，禁止环境修改和插入 UI 操作；WORKFLOW_BUSY 查询已有运行。失败即停，取消不回滚已发生业务，uncertain、断线或超时先查结果，不自动重跑。',
      '等待失败先查 failure.diagnostics 或步骤的 failure.diagnostics，读取真实 selector、condition、timeoutMs、attempts 和 lastObservation；根据 present 及 visible/enabled/actionable/textMatches 判断当前页面未挂载目标还是状态未满足，再按需查 Key/起点/键盘，不盲目增大超时或重跑整个操作。',
      'completed 仅代表操作完成：独立用 wait_for_widget 或 find_widget 确认最终页面，再核对基线后的 get_requests/get_request 或 WS 记录的 mocked、规则 ID、状态和正文。检查后台初始化漏 Mock 与 401/刷新循环，区分有意 Mock 503；applied 不等于实际命中。需要持久断言时使用 Test Case v2，只有 passed 代表测试通过。',
      '手动执行使用工作台 Scene 详情的「UI 操作（Workflow）」：选择操作、输入参数与通道，查看真实 Key 步骤预览后运行、查询进度或取消；同时核对操作来源和当前 Mock。操作结束保留当前 Mock；激活、reload、重连和 IDE 恢复都不重放操作。',
    ],
  },
  scene_action_authoring: {
    description:
      '编写与归档 Scene actions：真实 Widget Key targets、输入/点击/等待/滚动/收键盘、参数脱敏、公共操作 call 复用、预检及 Test Case v2。',
    topics: ['workflow', 'ui', 'http'],
    steps: [
      '先 list_scenes / list_scene_actions 检查已有操作与公共核心，只有没有合适操作、Key 失效或起点不符才 get_ui_snapshot / find_widget 探索。结合业务项目规范与源码确认真实稳定 ValueKey<String/int>；缺 Key 且任务允许改源码时补 Key，经 hot_reload 后复验唯一、可见、启用和实际交互区域，不直接调用业务回调。',
      '用 get_network_status 的 files.scenes 找到唯一运行配置 .flutter-pilot/scenes.json，保持 version:1，增量编辑并保留其他场景与规则。Scene 可只含 Mock、操作、targets，或同时包含这些能力；不创建/读取 workflows.json。每个 action 包含 id、name、可选 description/inputs 和 steps，说明起点、账号要求、所需 Mock 及终点。',
      'Scene 的 targets 保存稳定选择器，例如 "emailInput":{"source":"flutter","key":"emailEntry.input"}；steps[].target="emailInput" 是别名。执行器自动按真实 Widget Key 匹配当前挂载控件，每步重新定位，不缓存页面对象，不保存临时 ref/坐标，也不在 Key 失败时静默换文字定位。',
      '步骤支持 tap、enter_text、wait_for_widget、scroll、hide_keyboard 和 call。先等页面 visible 或按钮 actionable 再操作；enter_text 使用 text:"${inputs.email}"。输入影响布局时加入 {"id":"hide_email_keyboard","type":"hide_keyboard","timeoutMs":10000}，该步骤没有 target；确认键盘稳定隐藏后再等待并点击，不用固定 sleep 掩盖时序。',
      'inputs 声明 required/default/secret，运行输入为字符串。密码/验证码标记 secret:true；公共操作和所有入口保持秘密属性，通过 call 显式映射，例如 {"id":"login","type":"call","sceneId":"common_operations","actionId":"email_login","inputs":{"email":"${inputs.email}","code":"${inputs.code}"}}。省略 sceneId 引用同一 Scene；跨 Scene 只复用操作、不切换 Mock。',
      '把复用步骤放在同一 scenes.json 的纯操作 Scene，按不同起始页保留稳定业务入口 ID，各入口 call 公共核心。目录只索引 sceneId/actionId、前提、参数、终点和验证状态，不复制步骤或另建运行 catalogue；可复用模板按项目约定归档。配置不写真实凭据、临时 sessionId 或认证 VM 地址。',
      '保存后 reload_rules 加载快照，再 list_scene_actions 复核。无效 target、缺参数、坏引用、调用循环和展开限额必须在 UI 动作前预检拒绝；整理旧动作要比较展开后的原子工具、选择器、输入及 secret 传播。按 scene_action_quick_run 实际验证最终 UI 和本轮网络，分别记录 schema 校验、设备实测与未验证范围。',
      '环境和断言继续独立保存在 tests.json version:2：外层 sceneId 选择 Mock，action:{sceneId,actionId} 指定操作来源，setup 用同样 action 引用及显式输入映射。list_tests / run_test / get_test_run / cancel_test_run 负责执行、证据及临时环境清理；旧 workflowId 格式不再支持。',
    ],
  },
} as const satisfies Record<string, PromptTemplate>;

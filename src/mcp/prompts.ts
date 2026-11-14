import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { capabilityPromptTemplates, type PromptTemplate } from './capability-prompts';
import { mcpTools, type McpToolName } from './tools';
import { z } from 'zod';
import { automationPromptPlans } from '../automation/prompts';
import { sceneActionPromptPlans } from '../workflows/prompts';
import { testPromptPlans } from '../testing/prompts';

const templates = {
  ...capabilityPromptTemplates,
  http_mock: {
    description: '构造下单成功/失败、资产数据等 API 业务状态，按场景验证规则命中与页面表现。',
    topics: ['http'],
    steps: [
      '根据任务确定请求 method、host、path、预期响应和触发方式；先用 get_network_status 查看 files.scenes、采集与 Dio Mock 状态，必要时查询已有请求确认接口，不能猜测业务字段。',
      '任务包含多种状态时，按实际业务协议列出本次需要的场景，例如下单成功、业务失败、余额不足或不同资产信息；区分 HTTP 错误与 HTTP 200 中的业务失败码，逐个切换场景并验证，不同时启用互相冲突的规则。',
      '使用 Agent 文件工具读取 files.scenes，在目标场景的 httpRules 中按 ID 增量修改或追加规则，保留其他场景和规则。核对匹配范围、priority 与 enabled；JSON 正文序列化为字符串，避免空 match 意外匹配全部请求。',
      '保存后调用 reload_rules，检查 loaded 和 status.scene.runtime.http。校验失败时修正规则；pending 表示仍待应用，不能据此宣称 Mock 已生效。',
      '调用 list_scenes 取得目标 sceneId，再 activate_scene；它统一开启场景所需采集和 Mock。检查 runtime.http、attachedDioInstances 及 coverageMessage，确认本流程所需客户端接入，不要求无关 WS 就绪；以新记录验证实际覆盖。',
      '需要修改API后从应用入口展示新状态时，读取workflow指南并调用hot_restart；它重置内存并重跑入口，不会代替reload_rules。检查返回的network和新请求，启动首请求可能早于重新注入，必要时待Mock已接入再按Key触发。仅源码变更且需保留页面状态时使用hot_reload。',
      '记录触发前的请求 ID 或时间作为基线；需要界面操作时先读取 ui 指南，再按真实 Key 触发一次任务要求的请求，不重放未知业务请求。',
      '通过 get_requests 筛选本次新记录，再用 get_request 检查 mocked、requestRuleId/responseRuleId、实际请求和响应；按任务核对状态码、正文及页面表现。未命中时检查匹配范围、优先级、开关和 Dio 接入，不把旧记录当作本次证据。',
      '登录后继续检查目录、资产和后台初始化请求，漏 Mock 的测试 token 可能导致真实 401、刷新循环或 429；补齐已确认的接口契约。若某能力有意 Mock 503 退避，明确范围，不能把它当作业务成功。',
    ],
  },
  websocket_mock: {
    description: '模拟 WS 业务事件：替换/丢弃消息、向 App 注入推送或通过真实连接发送 topic/data。',
    topics: ['ws'],
    steps: [
      '先用 get_network_status 获取 files.scenes 和 WS 状态，再调用 get_ws_connections 确认业务连接、URL 和方向。业务 WebSocket 与 Dart VM 调试连接不同；没有连接时先完成任务需要的正常业务导航。',
      '确定本次是规则 Mock、向 App 注入模拟服务端事件，还是通过 App 的真实连接发送给服务端；按已知业务协议确定 topic 和 data，例如订单状态变化或资产更新，不凭示例猜测字段。',
      '需要规则 Mock 时，使用 Agent 文件工具增量编辑 files.scenes 中目标场景的 wsRules，保留其他场景和规则；按明确 URL、inbound/outbound 和 contains 缩小匹配范围。replace 为整条文本替换，JSON 必须序列化；drop 为丢弃，二进制消息只读。仅注入或发送消息时无需创建规则或激活场景，只需 WS 采集接入。',
      '修改规则后调用 reload_rules，检查 loaded 和 status.scene.runtime.ws；显式调用 set_capture_enabled(domain=ws, enabled=true)，再次检查目标连接的 capture、status 与 URL。URL 无法关联时不能使用 URL 匹配规则，但可选择已准确识别的连接发送或注入；不猜 URL，不把 connectionId 临时规则写入持久文件。',
      '需要场景规则 Mock 时调用 activate_scene(sessionId, sceneId) 统一启用该场景涉及的 HTTP/WS Mock；只查询消息或仅注入、发送消息时无需激活场景。',
      '记录消息 ID 或时间基线；使用 inject_ws_message 向 App 注入模拟服务端消息，或用 send_ws_message 经当前准确连接发往服务端。两者需要 WS 采集已接入，不新建连接；传 text 或 topic/data 二选一，topic/data 会序列化为 {topic,data}，自定义信封或 Socket.IO 等协议应按实际格式传 text。',
      'send_ws_message 走当前 outbound 规则，可能被替换或丢弃；发送工具返回成功不代表服务端业务处理成功，需要查询消息结果和任务要求的响应。规则 Mock 则通过正常业务操作触发或有界等待事件；采集前消息无法补抓。',
      '调用 get_ws_messages，按 connectionId、方向和 includeBodies=true 检查新消息的 original/effective、outcome 与 ruleId，并核对页面变化。连接重建后重新查询连接 ID；未收到事件或未命中时明确说明，不能把规则加载成功当作消息验证成功。',
    ],
  },
  flutter_ui: {
    description:
      '优先复用 Scene 操作；缺少操作时探索真实 Widget Key、修复定位、输入后稳定收键盘，支持精确交互和截图验证。',
    topics: ['ui'],
    steps: [
      '先按任务分流：仅截图直接读取 app_screenshot / screenshot 指南并使用 take_screenshot；需要重复交互时先 list_scenes / list_scene_actions 检查已有操作，满足需求时直接按说明运行。首次探索、选择器失效或结果异常时才 get_ui_snapshot，读取 key、ancestorKeys、type、bounds、enabled/actionable 与 source，保留 Key 类型且不猜测。',
      '开发联调与多状态测试优先使用结构化快照和 Key 操作；用户要求当前 App 截图、截屏或视觉样式/布局验收时优先 take_screenshot 获取 PNG。普通截图无需 Key/Scene/Mock/Appium，只有长图先 list_screenshot_targets；系统 UI 截图显式 source=device。',
      '手动探索时用 find_widget 确认唯一，重复 Key 用祖先范围限定。已保存操作的 target 自动解析为 targets 中的真实 Key 并逐步匹配，无需每步额外查找。Key 优先，也可显式用文字、语义或类型；失败不静默回退，不直接执行按钮回调。',
      '按任务使用 tap、enter_text、scroll 和 wait_for_widget；滚动与等待设置限额。enter_text 替换输入内容，按实际需要在点击按钮前 hide_keyboard，确认键盘稳定收起；不将输入描述为真实系统键盘 IME 测试。',
      'NOT_FOUND 先检查是否进入目标页面、是否懒加载，再有界等待或滚动，不能直接判为缺 Key。遇到 MISSING_KEY、UNSTABLE_KEY 或交互目标歧义时，调用 inspect_key_issues，结合 source 和业务源码定位原因。',
      '任务涉及源码修复时补稳定 ValueKey，列表优先使用业务 ID；没有源码修改授权时报告诊断。保存后通过MCP hot_reload保留状态应用变更；需重置内存并重跑入口时显式选择hot_restart。仅控制当前VM准确对应的IDE Flutter Debug会话；之后重新读取快照并定位，确认修复，不复用旧对象；不把当前挂载树诊断宣称为全仓审计。',
      '手动探索时验证关键状态，已保存操作由内部等待推进；终态后用 wait_for_widget 或 find_widget 独立验证最终页面，按任务检查新网络记录。首次验证的步骤仅归档到 scenes.json，公共操作用 call 复用。遮挡或禁用时按正常业务流程处理，不绕过命中测试。',
    ],
  },
  mock_workflow: {
    description:
      '完整业务联调：复用或启动 App、准备 API/WS Mock、执行 Scene 操作、验证 HTTP/WS/UI 或 Test Case，并归档公共 actions。',
    topics: ['workflow'],
    steps: [
      '重复的登录、填表、下单确认操作优先复用 Scene 操作：先 list_scenes，再按 sceneId 调用 list_scene_actions。首次探索和验证后在 scenes.json 保存 targets 与 actions，reload_rules 更新快照，后续 run_scene_action 一次启动，由插件执行，不逐步重新寻找控件或调用模型；get_scene_action_run 查看进度，cancel_scene_action_run 停止。',
      '需要可重复业务测试时，先 list_tests，按 files.tests 引用同一 Scene 操作，配置本轮 HTTP 参数/响应提取、关联 WS 和精确订单行 UI 断言；run_test 启动、get_test_run 查询，只有 passed 表示通过，cancel_test_run 取消。临时 Scene/有状态 Mock 随本轮恢复；先验证本轮请求，再注入同一订单事件。',
      '把任务拆成接口或消息条件、Mock 预期、界面操作和可观察的通过标准；按实际涉及的域读取 http、ws、ui 指南。不要求不存在的网络事件，不凭空增加测试场景。',
      '任务要求多状态验证时，按本次指定场景逐个执行，例如下单成功、失败和资产变化；每个场景先构造 API 响应或 WS 事件，再操作目标 Key 并核对结果，避免前一场景的规则、消息或页面状态干扰下一场景。',
      '用 list_sessions 确认项目、设备和已有 App；未启动时按现有命名配置 start_app，TIMEOUT 先查状态不重复启动。get_network_status 记录路径与开关；已有操作按说明确认前提，仅缺少操作或定位失效时 get_ui_snapshot 探索真实 Key。记录请求/消息基线。',
      '使用 Agent 文件工具增量编辑目标规则，保留其他规则；调用 reload_rules 整份重载场景，检查 loaded 和 status.scene.runtime。',
      '激活目标场景并确认本次所需 HTTP/Dio 或 WS 接入；不强制等待所有域。公共操作 Scene 只复用步骤，当前 Mock 保持；纯操作或只读排查无需开启 Mock。',
      '场景需要重新启动时，使用MCP hot_restart重置内存并重跑入口；仅应用源码且需保留状态时用hot_reload。仅支持当前VM准确对应的IDE Flutter Debug会话，无法绑定时报告诊断，不选择其他会话。热重启不代替reload_rules；连接未断时已有开关维持并重新发现运行时对象，但启动首请求可能未拦截，检查返回的network及新记录，不能仅凭工具完成断言Mock有效。实际VM断线后需重新连接，已保存的激活场景会自动恢复；检查分域应用状态。',
      '需要主动 WS 事件时，选择 inject_ws_message 向 App 注入，或 send_ws_message 经真实连接发往服务端；使用实际业务协议的 topic/data 或原始 text，检查 outbound 规则影响，并验证事件处理结果。',
      '已有操作用 run_scene_action / get_scene_action_run 执行并查询终态；target 自动绑定真实 Key，不逐步截图或 find_widget。仅手动探索时按真实 Key 或显式选择器确认唯一，再操作和有界等待；输入后的键盘遮挡用 hide_keyboard 处理。',
      '终态后独立核对最终 UI、本轮新 HTTP/WS 的规则 ID 与实际内容，检查登录后初始化漏 Mock 和 401/刷新循环；completed/applied 不能单独证明业务通过。有意模拟 503、启动首请求窗口和未验证能力均须说明，不能清数据或换环境掩盖失败。',
    ],
  },
} as const satisfies Record<string, PromptTemplate>;

/** Every runtime capability must have an explicit prompt; new tools fail type checking until mapped. */
export const toolPromptPlans = {
  get_usage_guide: {
    topics: ['overview'],
    steps: [
      '按任务选择 overview/screenshot/http/ws/ui/workflow 主题调用 get_usage_guide；无需 sessionId 或在线 IDE。读取指南后再决定是否执行运行时操作。',
    ],
  },
  list_sessions: {
    topics: ['overview'],
    steps: [
      '调用 list_sessions，按 workspace 与用户任务选择唯一项目，检查 vmConnected、capabilities.appLaunch 的设备/已有会话和保存配置，优先复用已运行 App；不要把调试会话 ID 当作工具 sessionId。没有候选或无法确定时报告阻碍。',
    ],
  },
  start_app: {
    topics: ['workflow'],
    steps: [
      '先 list_sessions 选择项目，检查 capabilities.appLaunch.configurations。App 尚未运行时，从列出的名称选择 configurationName 调用 start_app；多设备时可传原生 deviceId，避免 IDE 选择框。不传命令、路径、启动参数或其他项目的名称。已有同名会话会复用；传 deviceId 时必须确认同一设备，不重启或清数据。',
      '检查 completed、debugSessionId 与 network。TIMEOUT 可能仍在编译或运行，先查询 list_sessions 和 IDE，不自动重试启动。启动失败或调试会话结束会释放等待；pendingConfiguration 表示启动结果尚未确认，只拦截重复启动。只启动任务确认启动结果即可；后续需要截图时直接 take_screenshot，需要 Mock 时才 reload_rules/activate_scene，需要业务操作时才按 list_scene_actions 的参数显式 run_scene_action。激活 Scene 不会自动启动 App 或操作 UI。',
    ],
  },
  hot_reload: {
    topics: ['ui', 'workflow'],
    steps: [
      '确认任务是保留页面状态应用源码变更；先保存获准修改的源码，检查 list_sessions 的 capabilities.lifecycle，再调用 hot_reload。它不重跑 main/initState，不替代 reload_rules。',
      '检查 completed、code、statePreserved 和 network；无源码变化可能缺少重载事件并返回未确认，编译失败应检查 IDE 诊断，不自动改用 hot_restart。重新读取 UI 并验证变更。',
    ],
  },
  hot_restart: {
    topics: ['http', 'workflow'],
    steps: [
      '确认任务需要重置内存并重跑入口；检查 capabilities.lifecycle，Mock 文件改动先 reload_rules，激活需要的场景并记录网络基线，再调用 hot_restart。',
      '检查 completed 和 network；启动首请求可能早于 Mock 注入，必要时待接入后按 Key 触发请求。重新获取 UI 与 WS 连接 ID，用新记录核验不同业务状态；磁盘数据不会自动清除。',
    ],
  },
  get_network_status: {
    topics: ['http', 'ws'],
    steps: [
      '调用 get_network_status 获取 files.scenes、采集/Mock 开关及分域接入状态；HTTP 关注 attachedDioInstances、coverageMessage 与本流程所需客户端，纯操作不要求所有网络域就绪。文件已加载不等于运行时应用，更不等于请求已命中；只查询无需开启 Mock。',
    ],
  },
  get_requests: {
    topics: ['http'],
    steps: [
      '调用 get_requests 按 method/host/path/search 过滤并使用 limit/offset 分页，触发前保存时间或 ID 基线。按基线筛选新记录，get_request 查看正文和命中；汇总唯一接口/状态，避免反复输出整段重试日志，不能改写记录事实。',
    ],
  },
  get_request: {
    topics: ['http'],
    steps: [
      '先通过 get_requests 取得真实请求 id，再调用 get_request；检查实际请求、response.status/body、mocked、requestRuleId/responseRuleId，区分 HTTP 状态与业务错误码。记录证据与 UI 对应。',
    ],
  },
  get_ws_connections: {
    topics: ['ws'],
    steps: [
      '调用 get_ws_connections 选择当前业务连接，检查 URL、status=open 和 capture=attached。不是 VM 调试连接；未知 URL 不能猜，重启或连接重建后重新取 connectionId。',
    ],
  },
  get_ws_messages: {
    topics: ['ws'],
    steps: [
      '先选准确 connectionId，调用 get_ws_messages 并按方向、search、limit/offset 筛选；需要正文时 includeBodies=true。核对新消息的 original/effective、outcome 和 ruleId，再验证业务响应；采集前消息不可补抓。',
    ],
  },
  inject_ws_message: {
    topics: ['ws'],
    steps: [
      '开启 WS 采集，从 get_ws_connections 选在线且已接入的连接；按实际协议传 text 或 topic/data 二选一，调用 inject_ws_message 向 App 注入模拟服务端消息，不向服务端发送。',
      '正文最多256 KiB并受运行时限制；记录消息基线，查询新消息及 UI 验证处理结果，不凭提交成功断言业务成功。',
    ],
  },
  send_ws_message: {
    topics: ['ws'],
    steps: [
      '确认任务授权向真实服务端发送业务消息；开启 WS 采集并确认连接已接入，选择现有准确连接，按真实协议传 text 或 topic/data 二选一调用 send_ws_message，不新建连接。',
      '正文最多256 KiB并受运行时限制；outbound 规则可能替换或丢弃，查询新消息 effective/outcome 及服务端业务响应，提交成功不代表服务端收到或处理成功。',
    ],
  },
  reload_rules: {
    topics: ['http', 'ws'],
    steps: [
      '如需修改规则，先通过 get_network_status 获取路径，再使用 Agent 文件工具增量编辑并保存，保留其他规则；也可直接重载现有场景文件。调用 reload_rules 整份重载场景文件。',
      '检查 loaded 和 status.scene.runtime 的分域状态；失败时修复文件，不能把旧有效规则当作新规则已生效。重载按持久激活场景同步，不代替 hot_reload/hot_restart，也不重放业务请求。',
    ],
  },
  set_capture_enabled: {
    topics: ['http', 'ws'],
    steps: [
      '调用 get_network_status 确认域及当前开关，再显式调用 set_capture_enabled(domain=http/ws, enabled=true/false)。HTTP/WS 独立，有激活场景时重新开启采集会恢复该域 Mock；关闭采集暂停该域 Mock，采集前记录不可补抓。',
    ],
  },
  list_scenes: {
    topics: ['http', 'ws'],
    steps: [
      '调用 list_scenes 查看场景 ID、规则数量、操作概要及激活状态；按 sceneId 调用 list_scene_actions 查询 targets 和操作参数；规则正文读取 files.scenes；VM 离线也可查询，不把待应用当作已生效。',
    ],
  },
  activate_scene: {
    topics: ['http', 'ws'],
    steps: [
      '先 list_scenes 确认目标 sceneId，再 activate_scene 整体替换 HTTP/WS Mock。激活状态持久保存，重连及重开 IDE 自动恢复；检查分域 runtime，并触发业务查询新记录验证实际命中。',
    ],
  },
  deactivate_scene: {
    topics: ['http', 'ws'],
    steps: [
      '调用 deactivate_scene 清除持久激活状态并停止两域 Mock；采集保留。检查状态和卸载失败提示，旧租约未到期时不要宣称已经完全停止。',
    ],
  },
  ...automationPromptPlans,
  ...sceneActionPromptPlans,
  ...testPromptPlans,
} as const satisfies Record<McpToolName, Pick<PromptTemplate, 'topics' | 'steps'>>;

const toolTemplates: Record<string, PromptTemplate> = Object.fromEntries(
  Object.keys(mcpTools).map((name) => {
    const plan = toolPromptPlans[name as McpToolName];
    return [
      name,
      {
        description: `${name}：${mcpTools[name as McpToolName].description}`,
        topics: plan.topics,
        steps: plan.steps,
      },
    ];
  }),
);
const allTemplates: Record<string, PromptTemplate> = { ...templates, ...toolTemplates };

export const mcpPrompts = Object.entries(allTemplates).map(([name, { description, referenceOnly }]) => ({
  name,
  description,
  arguments: [
    {
      name: 'task',
      description: referenceOnly ? '可选：需要查阅的能力或使用问题' : '需要完成的具体任务和验证目标',
      required: false,
    },
  ],
}));

export function getMcpPrompt(name: string, args: Record<string, string> = {}) {
  if (!Object.hasOwn(allTemplates, name)) throw new McpError(ErrorCode.InvalidParams, '未知提示模板。');
  if (
    Object.keys(args).some((key) => key !== 'task') ||
    (args.task !== undefined && args.task.length > 4000)
  ) {
    throw new McpError(ErrorCode.InvalidParams, '提示模板参数无效。');
  }
  const { description, topics, steps, referenceOnly } = allTemplates[name];
  return {
    description,
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            args.task?.trim()
              ? `任务：${args.task.trim()}`
              : referenceOnly
                ? '只读查阅 Flutter Pilot 的能力与使用入口，无需指定运行任务。'
                : '尚未指定具体任务：先询问操作目标和预期结果，再执行以下流程。',
            `使用 flutter-pilot MCP 完成任务；先调用 get_usage_guide，按需读取主题：${topics.join('、')}。详细参数和限制以指南及工具 schema 为准。`,
            referenceOnly || name === 'get_usage_guide'
              ? '这是离线只读指南入口，不要求先调用 list_sessions、连接 VM 或开启 Mock。'
              : name === 'list_sessions'
                ? '这是会话发现入口，不需要 sessionId 或已连接 VM；空列表应报告需在目标 IDE 项目开启 MCP，不猜测会话。'
                : '调用 list_sessions，按项目路径和任务上下文选择对应会话；多个候选无法确定时询问，所有运行时调用明确传入该 sessionId。无可用会话时说明需在 IDE 开启 MCP；仅对需要 VM 的操作检查连接与能力，VM 离线时场景查询等可用操作仍可执行，并区分待应用与已生效。',
            steps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
            ...(name === 'capabilities'
              ? [
                  `场景 Prompts：\n${mcpPrompts
                    .filter((prompt) => !Object.hasOwn(mcpTools, prompt.name))
                    .map((prompt) => `- ${prompt.name}：${prompt.description}`)
                    .join('\n')}`,
                  `全部 ${Object.keys(mcpTools).length} 个工具及同名 Prompt（由当前注册表生成）：\n${Object.entries(
                    mcpTools,
                  )
                    .map(([toolName, tool]) => `- ${toolName}：${tool.description}`)
                    .join('\n')}`,
                ]
              : []),
            ...(Object.hasOwn(mcpTools, name)
              ? [
                  `目标工具：${name}。以下 JSON Schema 是调用参数约束，按实际任务填写，不将模板的 task 字段传给工具：\n${JSON.stringify(z.toJSONSchema(mcpTools[name as McpToolName].schema), null, 2)}`,
                ]
              : []),
            ...(referenceOnly
              ? [
                  '按问题说明相关能力、对应 Prompt 和使用前提；查阅结束即可，只有收到具体执行任务后才选择项目和操作。',
                ]
              : [
                  '仅执行用户任务和授权范围内的操作。超时、取消或断线可能发生在动作执行之后，先检查界面和新网络记录，不自动重试有副作用的动作；重连后重新获取会话和状态；插件会自动恢复持久激活场景。',
                  '完成后按本次任务报告实际调用、结果与证据；截图展示返回的图片，查阅任务只回答问题。涉及规则/源码修改、业务操作或测试时再报告相应改动、规则命中、页面证据、开关与未验证项，按用户要求恢复临时环境。不得仅凭配置成功或规则已加载声称业务验证通过。',
                ]),
          ].join('\n\n'),
        },
      },
    ],
  };
}

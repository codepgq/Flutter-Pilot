import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { GuideTopic } from './guide';
import { mcpTools, type McpToolName } from './tools';
import { z } from 'zod';

interface PromptTemplate {
  description: string;
  topics: readonly GuideTopic[];
  steps: readonly string[];
}

const templates = {
  http_mock: {
    description: '构造下单成功/失败、资产数据等 API 业务状态，按场景验证规则命中与页面表现。',
    topics: ['http'],
    steps: [
      '根据任务确定请求 method、host、path、预期响应和触发方式；先用 get_network_status 查看 files.scenes、采集与 Dio Mock 状态，必要时查询已有请求确认接口，不能猜测业务字段。',
      '任务包含多种状态时，按实际业务协议列出本次需要的场景，例如下单成功、业务失败、余额不足或不同资产信息；区分 HTTP 错误与 HTTP 200 中的业务失败码，逐个切换场景并验证，不同时启用互相冲突的规则。',
      '使用 Agent 文件工具读取 files.scenes，在目标场景的 httpRules 中按 ID 增量修改或追加规则，保留其他场景和规则。核对匹配范围、priority 与 enabled；JSON 正文序列化为字符串，避免空 match 意外匹配全部请求。',
      '保存后调用 reload_rules，检查 loaded 和 status.scene.runtime.http。校验失败时修正规则；pending 表示仍待应用，不能据此宣称 Mock 已生效。',
      '调用 list_scenes 取得目标 sceneId，再 activate_scene；它统一开启场景所需的采集和 Mock。检查 runtime.http 并以新记录验证。',
      '需要修改API后从应用入口展示新状态时，读取workflow指南并调用hot_restart；它重置内存并重跑入口，不会代替reload_rules。检查返回的network和新请求，启动首请求可能早于重新注入，必要时待Mock已接入再按Key触发。仅源码变更且需保留页面状态时使用hot_reload。',
      '记录触发前的请求 ID 或时间作为基线；需要界面操作时先读取 ui 指南，再按真实 Key 触发一次任务要求的请求，不重放未知业务请求。',
      '通过 get_requests 筛选本次新记录，再用 get_request 检查 mocked、requestRuleId/responseRuleId、实际请求和响应；按任务核对状态码、正文及页面表现。未命中时检查匹配范围、优先级、开关和 Dio 接入，不把旧记录当作本次证据。',
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
    description: '按稳定 Key 精确定位并操作 Flutter 组件，减少截图识别耗时与 token，验证业务状态。',
    topics: ['ui'],
    steps: [
      '先调用 get_ui_snapshot，读取当前 widgets 的 key、ancestorKeys、type、bounds、enabled/actionable 与 source，确定当前页面和目标。保留 Key 的字符串或整数类型，不猜测 Key。',
      '开发联调与多状态测试优先使用结构化快照和 Key 操作；视觉样式或布局验收时使用 take_screenshot 获取 PNG 图片。长图先用 list_screenshot_targets 查询滚动区域。',
      '调用 find_widget 确认目标唯一；重复 Key 用 ancestorKey 限定范围。正式选择器只支持 ValueKey<String/int>，不回退文本、裸坐标或直接执行按钮回调。',
      '按任务使用 tap、enter_text、scroll 和 wait_for_widget；滚动与等待设置有限次数和超时。enter_text 替换输入内容，操作前核对目标与预期文本，不将其描述为真实系统键盘 IME 测试。',
      'NOT_FOUND 先检查是否进入目标页面、是否懒加载，再有界等待或滚动，不能直接判为缺 Key。遇到 MISSING_KEY、UNSTABLE_KEY 或交互目标歧义时，调用 inspect_key_issues，结合 source 和业务源码定位原因。',
      '任务涉及源码修复时补稳定 ValueKey，列表优先使用业务 ID；没有源码修改授权时报告诊断。保存后通过MCP hot_reload保留状态应用变更；需重置内存并重跑入口时显式选择hot_restart。仅控制当前VM准确对应的IDE Flutter Debug会话；之后重新读取快照并定位，确认修复，不复用旧对象；不把当前挂载树诊断宣称为全仓审计。',
      '每次关键操作后，用 wait_for_widget、find_widget 或新快照验证预期页面和状态；任务包含网络效果时读取相应指南并核对本次新记录。遮挡或禁用时按正常业务流程处理，不绕过命中测试。',
    ],
  },
  mock_workflow: {
    description: '通过 API 状态和 WS 事件构造业务场景，按 Key 操作界面并逐项验证，辅助开发联调。',
    topics: ['workflow'],
    steps: [
      '把任务拆成接口或消息条件、Mock 预期、界面操作和可观察的通过标准；按实际涉及的域读取 http、ws、ui 指南。不要求不存在的网络事件，不凭空增加测试场景。',
      '任务要求多状态验证时，按本次指定场景逐个执行，例如下单成功、失败和资产变化；每个场景先构造 API 响应或 WS 事件，再操作目标 Key 并核对结果，避免前一场景的规则、消息或页面状态干扰下一场景。',
      '用 get_network_status 记录规则文件路径和当前开关；查询已有请求或连接确认目标，再用 get_ui_snapshot 确认起始页面和真实 Key，记录请求/消息 ID 或时间基线。',
      '使用 Agent 文件工具增量编辑目标规则，保留其他规则；调用 reload_rules 整份重载场景，检查 loaded 和 status.scene.runtime。',
      '激活目标场景统一开启所需采集与 Mock；确认 HTTP/Dio 或 WS 运行时接入有效。仅界面或只读排查任务无需修改规则或开启 Mock。',
      '场景需要重新启动时，使用MCP hot_restart重置内存并重跑入口；仅应用源码且需保留状态时用hot_reload。仅支持当前VM准确对应的IDE Flutter Debug会话，无法绑定时报告诊断，不选择其他会话。热重启不代替reload_rules；连接未断时已有开关维持并重新发现运行时对象，但启动首请求可能未拦截，检查返回的network及新记录，不能仅凭工具完成断言Mock有效。实际VM断线后需重新连接，已保存的激活场景会自动恢复；检查分域应用状态。',
      '需要主动 WS 事件时，选择 inject_ws_message 向 App 注入，或 send_ws_message 经真实连接发往服务端；使用实际业务协议的 topic/data 或原始 text，检查 outbound 规则影响，并验证事件处理结果。',
      '按真实 Key 和 ancestorKey 确认唯一目标，再执行点击、输入、滚动和有界等待；出现 Key 问题先诊断。每个关键步骤检查状态，避免连续操作后无法判断哪一步失败。',
      '将本次新 HTTP 记录或 WS 消息与规则 ID、实际内容及界面变化对应起来，分别判断规则加载、命中和业务结果。某一环节无法验证时保留已取得的证据，明确剩余阻碍和未验证项。',
    ],
  },
} as const satisfies Record<string, PromptTemplate>;

/** Every runtime capability must have an explicit prompt; new tools fail type checking until mapped. */
export const toolPromptPlans = {
  get_usage_guide: {
    topics: ['overview'],
    steps: [
      '按任务选择 overview/http/ws/ui/workflow 主题调用 get_usage_guide；无需 sessionId 或在线 IDE。读取指南后再决定是否执行运行时操作。',
    ],
  },
  list_sessions: {
    topics: ['overview'],
    steps: [
      '调用 list_sessions，按 workspace 与用户任务选择唯一项目，检查 vmConnected 和 capabilities；不要把调试会话 ID 当作工具 sessionId。没有候选或无法确定时报告阻碍。',
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
  get_ui_snapshot: {
    topics: ['ui'],
    steps: [
      '调用 get_ui_snapshot，按 maxNodes 有界读取当前挂载界面；从 widgets 的 typed key、ancestorKeys、状态与 source 发现目标，再用 find_widget 确认唯一。截图验收可使用 take_screenshot。',
    ],
  },
  list_screenshot_targets: {
    topics: ['ui'],
    steps: [
      '选择已连接 Flutter Debug VM 的 sessionId，调用 list_screenshot_targets 查询当前可见的向下滚动区域；根据返回信息选择目标，不猜测区域 ID。页面变化后重新查询。',
    ],
  },
  take_screenshot: {
    topics: ['ui'],
    steps: [
      '选择已连接 Flutter Debug VM 的 sessionId，调用 take_screenshot 并指定 mode=screen 获取当前屏幕，结果为 MCP PNG 图片。',
      '需要滚动长图时先调用 list_screenshot_targets，使用准确的 targetId 调用 take_screenshot 并指定 mode=long；采集期间保持页面与窗口稳定，完成或失败后尝试恢复原滚动位置。',
      '长图仅适用于普通向下滚动列表，最多 32 屏、30000 像素高、2400 万像素或 45 秒；MCP 图片传输最多 32 MiB（含 Base64 和 JSON），客户端工具调用超时建议至少 90 秒。超限或采集失败不返回不完整图片。截图不包含系统状态栏、原生键盘、系统弹窗和原生平台视图。',
    ],
  },
  find_widget: {
    topics: ['ui'],
    steps: [
      '先从快照获得真实 ValueKey，保留字符串/整数类型，使用 find_widget；有重复 Key 时传 ancestorKey。NOT_FOUND 可能是页面未进入或懒加载，不能直接认定缺 Key；不回退文本或坐标。',
    ],
  },
  tap: {
    topics: ['ui'],
    steps: [
      '通过快照和 find_widget 确认可操作且唯一的 Key，记录业务基线后调用 tap。操作使用真实命中测试；遮挡或禁用应按业务导航处理，随后用页面及新网络记录确认结果。',
    ],
  },
  enter_text: {
    topics: ['ui'],
    steps: [
      '确认唯一且可编辑的 Key 和用户期望的完整文本，再调用 enter_text 替换内容；核对 formatter、onChanged 和界面效果。不能据此宣称已验证真实系统键盘 IME。',
    ],
  },
  scroll: {
    topics: ['ui'],
    steps: [
      '确认唯一滚动区域 Key；调用 scroll 并明确 direction，可传 targetKey、maxSteps 和 timeoutMs 作有界查找。滚动后重新定位目标；目标懒加载或未出现不等于缺 Key。',
    ],
  },
  wait_for_widget: {
    topics: ['ui'],
    steps: [
      '使用真实 Key 调用 wait_for_widget，按目标选 present/absent/actionable 并设置有界 timeoutMs。等待超时先检查当前快照、页面路径与网络，不自动重放触发业务的点击。',
    ],
  },
  inspect_key_issues: {
    topics: ['ui'],
    steps: [
      '调用 inspect_key_issues 诊断当前挂载交互组件，结合 source 区分 MISSING_KEY、UNSTABLE_KEY 和歧义；有授权时修复源码的稳定 ValueKey，再 hot_reload 并重新验证。它不是全仓静态审计。',
    ],
  },
  get_network_status: {
    topics: ['http', 'ws'],
    steps: [
      '调用 get_network_status 获取准确 files.scenes、采集/Mock 开关及运行时接入状态。只查询无需开启 Mock；文件已加载不等于运行时应用，更不等于请求已命中。',
    ],
  },
  get_requests: {
    topics: ['http'],
    steps: [
      '调用 get_requests 按 method/host/path/search 过滤并使用 limit/offset 分页。按时间或 ID 基线选择本次新记录，使用 get_request 查看正文与规则命中；记录事实不能通过此工具改写。',
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
      '调用 list_scenes 查看场景 ID、规则数量及激活状态；规则正文读取 files.scenes；VM 离线也可查询，不把待应用当作已生效。',
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
} as const satisfies Record<McpToolName, Pick<PromptTemplate, 'topics' | 'steps'>>;

const toolTemplates: Record<string, PromptTemplate> = Object.fromEntries(
  Object.entries(toolPromptPlans).map(([name, plan]) => [
    name,
    {
      description: `${name}：${mcpTools[name as McpToolName].description}`,
      topics: plan.topics,
      steps: plan.steps,
    },
  ]),
);
const allTemplates: Record<string, PromptTemplate> = { ...templates, ...toolTemplates };

export const mcpPrompts = Object.entries(allTemplates).map(([name, { description }]) => ({
  name,
  description,
  arguments: [{ name: 'task', description: '需要完成的具体任务和验证目标', required: false }],
}));

export function getMcpPrompt(name: string, args: Record<string, string> = {}) {
  if (!Object.hasOwn(allTemplates, name)) throw new McpError(ErrorCode.InvalidParams, '未知提示模板。');
  if (
    Object.keys(args).some((key) => key !== 'task') ||
    (args.task !== undefined && args.task.length > 4000)
  ) {
    throw new McpError(ErrorCode.InvalidParams, '提示模板参数无效。');
  }
  const { description, topics, steps } = allTemplates[name];
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
              : '尚未指定具体任务：先询问操作目标和预期结果，再执行以下流程。',
            `使用 flutter-pilot MCP 完成任务；先调用 get_usage_guide，按需读取主题：${topics.join('、')}。详细参数和限制以指南及工具 schema 为准。`,
            name === 'get_usage_guide'
              ? '这是离线只读指南入口，不要求先调用 list_sessions、连接 VM 或开启 Mock。'
              : name === 'list_sessions'
                ? '这是会话发现入口，不需要 sessionId 或已连接 VM；空列表应报告需在目标 IDE 项目开启 MCP，不猜测会话。'
                : '调用 list_sessions，按项目路径和任务上下文选择对应会话；多个候选无法确定时询问，所有运行时调用明确传入该 sessionId。无可用会话时说明需在 IDE 开启 MCP；仅对需要 VM 的操作检查连接与能力，VM 离线时场景查询等可用操作仍可执行，并区分待应用与已生效。',
            steps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
            ...(Object.hasOwn(mcpTools, name)
              ? [
                  `目标工具：${name}。以下 JSON Schema 是调用参数约束，按实际任务填写，不将模板的 task 字段传给工具：\n${JSON.stringify(z.toJSONSchema(mcpTools[name as McpToolName].schema), null, 2)}`,
                ]
              : []),
            '仅执行用户任务和授权范围内的操作。超时、取消或断线可能发生在动作执行之后，先检查界面和新网络记录，不自动重试有副作用的动作；重连后重新获取会话和状态；插件会自动恢复持久激活场景。',
            '完成后报告修改的规则/源码、关键操作、规则命中与页面证据、当前采集/Mock 开关及未验证项；按用户要求恢复临时规则和开关，保留其他改动。不得仅凭配置成功、工具返回成功或规则已加载就声称业务验证通过。',
          ].join('\n\n'),
        },
      },
    ],
  };
}

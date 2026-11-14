import { automationGuide, automationInstructions } from '../automation/prompts';
import savedScenesExample from '../../resources/example.scenes.json';
import testExample from '../../resources/example.tests.json';
/** Agent-facing reference, bundled into MCP so it is available even without an IDE session. */
export const guideTopics = ['overview', 'http', 'ws', 'ui', 'workflow'] as const;
export type GuideTopic = (typeof guideTopics)[number];

export const agentInstructions = `Flutter Pilot 配合 Flutter Debug 开发联调：用 API Mock 构造下单成功/失败、资产数据等业务状态，用 WS Mock、向App注入或向服务端发送消息驱动业务事件，再按 Key 精确操作 UI 并验证结果，减少逐步截图识别的耗时与token。
当用户任务需要这些能力时，主动使用本 MCP：先调用 get_usage_guide 按需读取 overview/http/ws/ui/workflow，再 list_sessions 选择用户任务对应的项目；不要只给用户手工操作建议。
get_usage_guide 无需 sessionId，插件未运行也能读取；也可通过 resources/list 发现对应指南资源。
能力入口：get_network_status 查询规则路径与开关；get_requests/get_request 查询 HTTP 列表与详情；get_ws_connections/get_ws_messages 查询业务 WS 连接与消息；reload_rules 加载规则；list_scenes/activate_scene/deactivate_scene 统一管理场景；set_capture_enabled 控制采集。UI 使用 get_ui_snapshot、find_widget、tap、enter_text、scroll、wait_for_widget、inspect_key_issues；使用 take_screenshot 截取当前屏幕或滚动长图，长图区域用 list_screenshot_targets 查询；应用热更新使用 hot_reload/hot_restart，主动 WS 消息使用 inject_ws_message/send_ws_message。
每个 tools/list 工具都有同名 MCP Prompt，可通过 prompts/list 与 prompts/get 按需读取操作步骤和参数；另保留 http_mock/websocket_mock/flutter_ui/mock_workflow 场景模板。客户端未加载 Prompts 时仍以本初始化说明、tools/list 描述和 get_usage_guide 发现能力。
规则使用 Agent 自身的文件编辑能力维护，通过 get_network_status 获取准确路径，保留已有规则；保存后 reload_rules，再 activate_scene 统一开启所需采集/Mock，再操作 UI、查询记录验证。MCP 本身不提供文件编辑或规则 CRUD。
需要应用源码变更或重新进入启动状态时，通过 hot_reload 保留状态热重载，或 hot_restart 重置内存并重新执行入口；仅支持当前VM准确对应的Cursor/VS Code Flutter Debug会话。修改Mock文件先reload_rules，热重启不会代替规则加载，也不保证启动首请求已被Mock；重启后检查网络状态并用新记录和UI验证。
所有运行时工具必须明确 sessionId。UI 优先 Key，也支持显式文字、语义、类型、祖先范围、快照引用和坐标；不静默更换定位策略。先读取快照并确认唯一。设备连接后 auto 使用系统输入，失败不换通道重放。完整移动交互工具：${automationInstructions}。UI 超时先检查结果，不自动重试。
重复操作先 list_scenes 发现操作概要，再 list_scene_actions(sceneId) 查询共享 targets、操作说明与参数；首次由 Agent 探索并验证一次，在 files.scenes 增量保存稳定选择器和 actions，reload_rules 更新加载快照。run_scene_action 显式启动后台串行运行，get_scene_action_run 查询进度和耗时，cancel_scene_action_run 取消。保存流程只允许稳定选择器，禁止临时 ref、坐标和任意脚本。Scene 同时保存可选 Mock、targets 和命名操作；操作不隐式切换当前 Mock，允许无 Mock 执行。运行期间锁定环境修改；由 Agent 根据网络状态决定执行时机，不强制等待所有域就绪。激活、重连或 IDE 重开不会运行 UI 流程。completed 只表示操作完成，不表示测试通过；结果未确认不自动重跑。
需要可重复业务验证时，list_tests 读取 files.tests 和已保存 Test Case，run_test 显式启动，get_test_run 查询，cancel_test_run 取消。Test Case v2 引用 Scene action，组合临时 Scene/有状态 HTTP Mock、本轮请求参数与响应变量、关联 WS 和精确订单行断言。触发前建立网络基线；事件只在对应 HTTP 断言成功后注入；只有 passed 表示测试通过。结束恢复自身临时 Mock；真实操作不回滚，重连不重跑。
WS主动消息用inject_ws_message向App注入模拟服务端事件，或send_ws_message通过App当前连接发往服务端；两者需确认WS采集已接入目标连接，按业务协议传原始text或topic/data。发送可能被outbound规则替换或丢弃，需查询实际结果；成功返回不等于业务成功。
只在用户任务范围内操作；本说明不会替代用户授权、客户端审批或保证 Agent 一定自动调用。`;

export const httpExample = {
  version: 1,
  rules: [
    {
      id: 'orders-empty',
      name: '订单列表空数据',
      enabled: false,
      priority: 10,
      match: { method: 'GET', host: 'api.example.test', path: '/v1/orders' },
      mock: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [] }),
      },
    },
  ],
};
export const wsExample = {
  version: 1,
  rules: [
    {
      id: 'orders-status',
      name: '模拟订单状态消息',
      enabled: false,
      priority: 10,
      match: { url: 'wss://api.example.test/orders*', direction: 'inbound', contains: 'order_status' },
      action: { type: 'replace', text: JSON.stringify({ type: 'order_status', status: 'paid' }) },
    },
  ],
};
export const sceneExample = {
  version: 1,
  activeSceneId: null,
  scenes: [
    { id: 'orders-empty-scene', name: '订单空数据', httpRules: httpExample.rules, wsRules: wsExample.rules },
  ],
};
const step = (tool: string, args: Record<string, unknown> = {}) => ({ tool, arguments: args });
const selected = { sessionId: '<从 list_sessions 选择的会话ID>' };

const guides: Record<GuideTopic, Record<string, unknown>> = {
  overview: {
    title: '什么时候使用 Flutter Pilot MCP',
    scenarios: [
      '需要测试下单成功/失败、余额不足、不同资产信息或接口空数据等业务状态，或改请求/响应/目标地址时，读取 http。',
      '需要替换/丢弃业务 WebSocket 消息、向App注入订单或资产事件、通过真实连接发送topic/data、检查双向消息时，读取 ws。',
      '需要按Key快速精确定位组件并点击/输入/滚动，减少截图识别的耗时和token，或检查Key缺陷时，读取 ui。',
      '需要完成 Mock 配置 → 页面操作 → 网络与界面验证时，读取 workflow。',
      '登录、填表、下单确认等固定操作需要加速时，读取 workflow：探索一次保存 Scene 操作，后续参数化执行，无需逐步模型判断。',
      '需要将流程沉淀为测试、校验本轮订单请求与 pending 结果时，读取 workflow 的 testing：Test Case 复用 Scene 操作，并关联 HTTP、WS 和 UI 证据。',
      '需要通过MCP热重载源码、热重启应用以展示不同状态和UI时，读取 workflow 的 lifecycle；无需额外终端操作入口。',
    ],
    start: [
      step('get_usage_guide', { topic: 'workflow' }),
      step('list_sessions'),
      step('get_network_status', selected),
      step('list_scenes', selected),
    ],
    files: {
      scenes: '.flutter-pilot/scenes.json',
      tests: '.flutter-pilot/tests.json',
    },
    boundaries: [
      '指南只读且不需要运行中的插件；实际运行需本机 IDE 对应项目已开启 MCP。Flutter 结构和 VM 操作需 Debug VM，原生与系统操作需设备通道。',
      '文件由编码 Agent 编辑，MCP 负责加载、开关、UI 操作与验证；不修改无关规则，不猜测会话ID或VM地址。',
      '没有可用会话时报告需在插件开启MCP；VM未连接时报告需要连接Debug App。不要声称已完成运行时验证。',
    ],
  },
  http: {
    title: '编辑 .flutter-pilot/scenes.json：HTTP/Dio 规则',
    preparation:
      '先 get_network_status 取得 files.scenes 绝对路径，再读取文件并保留已有 scenes。JSON 顶层为 version:1、activeSceneId 和 scenes；每个场景含 id、name、httpRules 和 wsRules。修改目标场景的 httpRules，保留其他场景。exampleDocument 是完整场景示例，另附的规则片段用于编辑对应规则数组。',
    exampleDocument: sceneExample,
    httpRuleFragment: httpExample,
    businessScenarios: [
      '依据真实接口契约构造下单成功、下单失败、余额不足或资产信息等状态，HTTP状态与业务code分别核对，不能假设业务失败一定返回HTTP 4xx/5xx。',
      '任务需要多种状态时逐个激活目标场景、触发请求并验证，避免同一接口的多个场景规则同时命中；使用新记录和当前页面判断结果。',
    ],
    fields: {
      id: '非空且唯一，更新原规则时保留ID。',
      name: '可读规则名。',
      enabled: '规则开关。示例默认false；需要执行此场景时将目标规则设true，再保存和重载。',
      priority: '安全整数，较大者优先，每阶段首条匹配规则执行；避免依赖相同优先级的顺序。',
      match:
        'method/host/path/query/headers均可选，组合条件同时满足；按原始请求匹配。method建议大写，host不带协议，path不带query，支持路径glob；不要用空match无意拦截所有请求。',
      mock: '直接返回响应，status为200..599，headers为字符串字典，body必须是字符串；JSON正文先序列化，不可直接放对象。',
      request: '可修改method/url/headers/query/body；headers和query以null删除项，正文为字符串。',
      response: '可修改status/headers/body；正文为字符串。',
      redirect:
        '格式为 {url:"/path"} 或 {url:"https://..."}。/path保留原站点和查询参数，带?时替换查询参数；完整URL替换整个地址。真实发送并保留方法、正文及Authorization/Cookie等请求头，Host随目标更新；不是HTTP301/302，不能与mock同时存在。',
      breakpoint: 'VM模式不支持人工断点；不要用它构建MCP的VM操作流程。',
    },
    variants: {
      request: {
        request: { headers: { 'x-test-scenario': 'empty', 'x-obsolete': null }, query: { page: '1' } },
      },
      response: {
        response: {
          status: 503,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'test-unavailable' }),
        },
      },
      redirect: { redirect: { url: 'https://staging.example.test/v1/orders' } },
    },
    workflow: [
      '先list_scenes确认目标场景，读取现有文件，在该场景按ID增量修改或追加规则；核对匹配范围、priority和enabled后保存。',
      step('reload_rules', selected),
      '确认loaded和status.scene.runtime.http；pending时尚未实际应用。校验失败时修文件，插件保留上一份有效规则。',
      step('set_capture_enabled', { ...selected, domain: 'http', enabled: true }),
      step('activate_scene', { ...selected, sceneId: '<从 list_scenes 选择的场景ID>' }),
      'get_network_status确认Dio已接入；按UI Key触发请求，不重放未知业务请求。',
      '需要从应用入口重新构造场景时，按workflow.lifecycle调用hot_restart；它不会读取规则文件。检查返回的network和本次新请求，启动首请求可能早于重新注入，必要时待接入后按Key再次触发请求。',
      step('get_requests', { ...selected, path: '/v1/orders', limit: 10 }),
      step('get_request', { ...selected, id: '<新产生记录ID>' }),
      '核对新记录的mocked、requestRuleId/responseRuleId、response.status/body和页面结果。避免把历史旧记录当本次结果。',
    ],
    limitations:
      'Debug/JIT、兼容Dio实例；新实例扫描前首请求可能未拦截，上传/流/二进制正文有编辑限制。规则需启用且所属场景激活；实际应用仍需运行时接入。',
  },
  ws: {
    title: '业务 WebSocket 规则、模拟推送与真实连接发送',
    preparation:
      '先 get_network_status 取得 files.scenes 绝对路径，读取并保留现有规则。此文件针对App业务WebSocket，不是Dart VM调试连接。顶层为version:1、activeSceneId和scenes；编辑目标场景的wsRules，保留其他场景。exampleDocument 是完整场景示例，另附的规则片段用于编辑对应规则数组。',
    exampleDocument: sceneExample,
    wsRuleFragment: wsExample,
    fields: {
      common:
        'id唯一、name非空、enabled布尔值、priority安全整数且较大优先；需要执行示例时把enabled从false改true。',
      'match.url':
        '持久规则使用ws://或wss://的URL，支持*和?通配；单独的*会匹配所有已知URL，建议使用明确业务URL缩小范围。只对可明确关联URL的连接命中，未知URL不能猜测或强制匹配。',
      'match.direction': 'inbound表示服务端到App，outbound表示App到服务端，可省略表示两向。',
      'match.contains': '文本子串匹配，不是正则表达式；可省略。',
      action:
        '整条替换使用 {type:"replace",text:"..."}，text必须是字符串，JSON需序列化；丢弃使用 {type:"drop"}。',
      temporary:
        'connectionId规则是当前激活场景内的内存临时规则，切换场景或连接失效时清除，不写入scenes.json；本MCP不提供临时规则CRUD。',
    },
    variants: { drop: { action: { type: 'drop' } } },
    workflow: [
      '增量编辑并保存规则文件，不覆盖已有无关规则。',
      step('reload_rules', selected),
      step('set_capture_enabled', { ...selected, domain: 'ws', enabled: true }),
      step('get_ws_connections', selected),
      '检查目标连接的URL、capture和status；URL未知或未接入时说明限制。',
      step('activate_scene', { ...selected, sceneId: '<从 list_scenes 选择的场景ID>' }),
      '按Key操作App或等待任务要求的业务事件；需要主动消息时按manualMessages选择注入App或真实发送。Test Case 可在本轮指定 HTTP 断言成功后注入关联事件，见 workflow.testing；不提供通用定时消息或自动应答。',
      step('get_ws_messages', {
        ...selected,
        connectionId: '<目标连接ID>',
        direction: 'inbound',
        includeBodies: true,
        limit: 10,
      }),
      '核对新消息的original/effective、outcome（original/replaced/dropped/synthetic）、ruleId和UI变化。二进制只读；采集开始前的消息无法补抓。',
    ],
    switches:
      '激活场景统一开启必要采集和Mock；关闭采集暂停该域Mock，重新开启恢复。持久激活场景在VM重连和IDE重开后自动恢复。',
    manualMessages: {
      preparation:
        '先开启WS采集，通过get_ws_connections选择在线、capture=attached的准确连接；不新建连接。先记录消息ID或时间基线，连接重建后重新选择。',
      payload:
        'text与topic/data二选一；topic/data序列化为JSON对象{topic,data}，data可为任意JSON值。实际协议有其他信封字段、数组或Socket.IO帧时，用text传入完整文本，不能猜测业务协议。正文受运行时UTF-8字节上限限制。',
      inject: step('inject_ws_message', {
        ...selected,
        connectionId: '<目标连接ID>',
        topic: 'assets.updated',
        data: { balance: '100.00' },
      }),
      injectMeaning:
        '向App当前连接的接收链路注入模拟服务端消息，便于测试资产更新、订单状态变化等业务状态；不会把该消息发送给服务端。',
      send: step('send_ws_message', {
        ...selected,
        connectionId: '<目标连接ID>',
        text: '{"topic":"orders.subscribe","data":{"orderId":"example"}}',
      }),
      sendMeaning:
        '通过App已有真实WS连接发往服务端，经过当前outbound规则，可能被替换或丢弃。工具成功不等于服务端收到或业务成功；检查消息outcome、effective、ruleId和业务响应。',
      verification:
        '调用get_ws_messages并includeBodies=true核对本次消息与页面变化；超时、取消或断线后先查询结果，不自动重试发送或注入，避免重复业务事件。',
    },
  },
  ui: {
    ...automationGuide(),
    reusableActions:
      '首次探索定位目标后，使用稳定选择器编写 Scene 操作；后续 run_scene_action 由插件完成每步定位、动作和等待，不需要 Agent 额外 find_widget 或整页快照。保存临时 ref、坐标或跨界面缓存控件对象均不支持。格式与执行见 workflow 指南。',
  },
  workflow: {
    title: '按需主动调用：规则文件 → UI 操作 → 网络与页面验证',
    reusable: {
      title: 'Agent 探索一次，保存 Scene 操作，插件确定性执行',
      files: { scenes: '.flutter-pilot/scenes.json' },
      exampleDocument: savedScenesExample,
      fields: {
        document:
          '严格 JSON：{version:1,activeSceneId:null,scenes:[{id,name,httpRules:[],wsRules:[],targets?,actions?}]}；action 含 id/name/description?/inputs?/steps。支持纯 Mock、纯操作及 targets-only，没有自动执行字段。',
        inputs:
          '输入定义为 {参数名:{required?:boolean,default?:string,secret?:boolean}}；运行 inputs 为字符串字典。模板仅支持 ${inputs.name}，可用于 text、选择器字符串及子流程参数，不执行表达式。',
        targets:
          '目标名称到稳定组合 Selector 的字典，如 {priceInput:{key:"order.price"},confirm:{key:"confirm",ancestor:{key:"dialog"}}}；每个操作只绑定其使用的 targets，互不要求对方的输入。原生目标可显式 source=device。禁用 ref 与 point。示例 Key 必须替换成实际验证过的选择器。',
        steps:
          '每步必须有唯一 id 和 type。type 仅允许 tap、enter_text、wait_for_widget、scroll、call；目标字段 target 引用 targets 中的名称。',
        tap: '{id,type:"tap",target,timeoutMs?}；点击一次，不自动重试。',
        enter_text:
          '{id,type:"enter_text",target,text,timeoutMs?}；text 可为 ${inputs.price}，替换输入内容。',
        wait_for_widget:
          '{id,type:"wait_for_widget",target,state?,text?,timeoutMs?}；state 为 present/absent/visible/enabled/actionable/text_equals/text_contains/text_changed，文字条件必须有 text。',
        scroll:
          '{id,type:"scroll",target,untilTarget?,direction?,distance?,durationMs?,maxSteps?,timeoutMs?}；target 为容器，untilTarget 为同一 targets 中的滚动查找目标。',
        call: '{id,type:"call",sceneId?,actionId,inputs?}；省略 sceneId 引用同 Scene。跨 Scene 仅复用操作，不切换 Mock；inputs 显式映射参数，如 {price:"${inputs.price}"}，预检引用、参数、循环和展开限额。',
        limits:
          'Scene 文件最多64 MiB；每 Scene 最多200操作，每操作最多500步、整个文件最多5000定义步骤；嵌套最多16层，一次展开最多1000动作。timeoutMs 为100..30000，maxSteps 为1..30。',
      },
      concepts: {
        scene: '统一保存可选 HTTP/WS Mock、共享 targets 和多个命名 actions。激活只应用 Mock，绝不执行操作。',
        action:
          '参数化的输入、点击、等待、滚动和子操作。显式启动，失败停止；来源 Scene 与当前 Mock 可以不同，运行记录保存实际 mockSceneId。',
        testCase:
          '独立组合 Mock Scene、Scene action、网络关联和业务断言；操作的 completed 只说明操作完成，不是测试 passed。使用 run_test 与本轮关联断言判断业务结果。',
      },
      authoring: [
        '先 get_network_status 获取 files.scenes；list_scenes 读取概要，list_scene_actions(sceneId) 查询操作和参数。用 Agent 文件工具增量维护 scenes.json。停止读取或创建 workflows.json，不迁移或删除用户旧文件。',
        '首次在目标 App 按实际页面探索并验证操作，提取稳定 Key 或明确文字/语义及祖先范围，命名 targets；不要直接使用示例中未验证的 Key。',
        '按 fields 和 exampleDocument 保存 version:1、scenes 数组；共享 targets 在 Scene 上，actions 含 id/name、可选 description/inputs 和 steps。输入值均为字符串，price/quantity 不转换为浮点数；可复用子流程。示例名称和 Key 仅为格式演示，需先确认实际控件。',
        '保存后 reload_rules 校验并更新已加载 Scene 快照。run_scene_action 使用该快照完整预检引用、输入及展开步骤；文件中途编辑不会改变本轮。激活、reload、重连和 IDE 恢复都不执行操作。',
      ],
      execution: [
        step('list_scene_actions', { ...selected, sceneId: 'common_operations' }),
        '选择流程并核对起始页面与登录账号；需要 Mock 时先独立准备 Scene 并确认运行时接入。运行器不会自动登录或切换场景。',
        step('run_scene_action', {
          ...selected,
          sceneId: 'common_operations',
          actionId: 'submit_order',
          inputs: { price: '100.00', quantity: '2' },
        }),
        '保存返回的 runId；后台执行不会因该 MCP 调用结束而取消。运行中独占 UI 操作并锁定环境修改，使用查询和取消工具管理，不能插入点击或重启。',
        step('get_scene_action_run', { ...selected, runId: '<run_scene_action返回的runId>' }),
        '查询到终态后报告实际步骤与耗时。completed 不替代订单参数、HTTP/WS 命中及当前订单行的业务断言。',
      ],
      cancellation: {
        call: step('cancel_scene_action_run', { ...selected, runId: '<run_scene_action返回的runId>' }),
        meaning:
          '取消后等待当前动作结束并释放资源；已经发生的订单或登录不回滚。结果 uncertain 时先检查界面与新网络记录，不自动重试 confirm、下单或整个流程。',
      },
      boundaries: [
        '只允许已保存的线性步骤和子流程，不接收任意脚本、坐标或临时 ref；持久化稳定选择器，执行时重新定位。',
        '首版单设备串行；每步沿用原子动作的命中、窗口和设备防护。运行有界记录保留在当前插件会话，IDE 重开不恢复运行或自动重跑。',
        'Scene 操作自身不执行网络断言或注入事件；需要这些能力时引用同一流程建立 Test Case，见 testing。手动录制器、复杂分支语言与 CI 启动/数据隔离仍不提供。',
      ],
    },
    testing: {
      title: '复用 Scene 操作的 Test Case 与本轮关联断言',
      files: { tests: '.flutter-pilot/tests.json', scenes: '.flutter-pilot/scenes.json' },
      exampleDocument: testExample,
      authoring: [
        '先 list_tests 获取 files.tests 准确路径，list_scene_actions(sceneId) 确认 actionId。Agent 增量保存严格 JSON {version:2,tests:[...]}；缺文件返回空列表，读取不创建文件，保存后无需 reload_rules。',
        '用例包含 id/name/action:{sceneId,actionId}、字符串 inputs、可选 setup 子流程、sceneId 或 mock、timeoutMs、expect 和 events。每次运行校验文件并冻结定义；示例协议、URL 和 Key 为占位，必须替换为实际已验证内容。',
        'setup 显式准备登录和页面，每项 {action:{sceneId,actionId},inputs?}，登录流程必须核对账号。主流程应只提交操作，不绑定成功结果；成功、拒绝和确认取消使用各自断言。',
      ],
      fields: {
        action:
          'action:{sceneId,actionId} 指定操作来源；外层 sceneId 选择测试 Mock，省略沿用当前激活场景。setup 使用相同引用和显式 inputs 映射。旧 version:1/workflowId 明确报错，不迁移。',
        inputs:
          '测试 inputs 为主流程字符串参数，run_test.inputs 可覆盖；金额和数量不转浮点数。模板仅支持 ${inputs.name}、${run.id} 和已提取的 ${vars.name}，不执行表达式。Mock 和 JSON 事件模板先解析 JSON、按字符串值绑定再序列化，避免参数引号破坏协议。',
        http: 'expect.http:[{id,match:{method?,host?,path?},requestJson?,responseJson?,status?,mocked?,extract?,timeoutMs?}]。match 至少有一个条件；JSON 断言字典以 JSON Pointer 为键，指向请求/响应正文。requestJson 检查 App 原始提交；extract 例如 {orderId:"/response/body/data/orderId"}。',
        ws: 'expect.ws:[{id,url?,direction?,json?,contains?,outcome?,timeoutMs?}]。至少设置 URL、JSON 或文字条件；json 使用有效消息 JSON Pointer，outcome 为 original/replaced/dropped/synthetic。以 ${vars.orderId} 关联当前订单，真实事件不能用 synthetic 注入替代。',
        ui: 'expect.ui:[{id,selector,state,text?,timeoutMs?,stableForMs?}]。使用稳定选择器，state 为 present/absent/visible/enabled/actionable/text_equals/text_contains；文字条件需要 text。订单行用 orderId 祖先范围，分别核对价格、数量和 pending。',
        events:
          'events:[{id,after,url,text}]。after 引用本例 HTTP 断言 id；该断言验证成功并提取变量后，才向唯一准确的在线 WS 连接注入 JSON text 一次。它证明 App 处理模拟事件，不能证明真实服务端会推送。',
        mock: 'mock:{initialState,states:[{id,httpRules:[...]}]}；只支持直接 HTTP Mock，规则可有 nextState 指向其他状态。运行生成唯一场景标识，初始状态独立；命中下单规则后在返回响应前转换状态，避免立即 GET 读到旧列表。',
      },
      execution: [
        step('list_tests', selected),
        step('run_test', {
          ...selected,
          testId: '<已确认的测试ID>',
          inputs: { price: '100.00', quantity: '2' },
        }),
        '保存 runId，运行器独占 UI 并建立主流程触发前的网络基线；仅本轮新请求/消息参与断言，响应 orderId 继续关联 WS 和同一订单行，避免旧 pending 假通过。',
        step('get_test_run', { ...selected, runId: '<run_test返回的runId>' }),
        '只有 passed 表示全部操作和断言通过。失败需报告 HTTP/WS/UI 证据、失败断言或环境错误及清理状态；流程 completed 或事件已提交均不能单独作为通过证据。',
      ],
      cancellation: {
        call: step('cancel_test_run', { ...selected, runId: '<run_test返回的runId>' }),
        meaning:
          '取消、断线或确认超时停止后续动作，保留结果未确认的证据，不自动重试提交或事件；等待终态和资源释放。自身临时 Scene/Mock 结束恢复，已经发生的登录、真实订单或事件不能回滚，页面默认保留供调试。',
      },
      boundaries: [
        '默认使用当前已运行的 Debug App，单设备串行；不启动 App、不清用户数据、不自动登录或创建真实测试账号。Scene 激活和重连不会自动运行测试。',
        '全 Mock 测试证明客户端集成行为；使用真实后端与真实推送才覆盖相应前后端链路。需要真实推送时省略 events，等待真实 WS 并断言对应 outcome。',
        '失败时不临场改选择器继续沿用结论。运行记录有界保留在当前会话，IDE 重开不恢复；手动录制、复杂分支与 CI 环境隔离留待后续。',
      ],
    },
    steps: [
      '当用户请求涉及API/WS Mock、Flutter UI查找与交互或Key诊断时，主动读取对应get_usage_guide主题并执行任务范围内操作。',
      '多场景任务按指定状态逐个执行：API构造成功/失败/资产数据，或WS注入/发送业务事件，再按Key操作并验证，防止上个场景的规则和页面状态污染当前结果。',
      step('list_sessions'),
      '按用户项目选择会话；多个候选无法确定时询问用户，不选择无关项目。',
      step('get_network_status', selected),
      step('list_scenes', selected),
      '用Agent文件工具读取返回的rules文件，增量编辑目标规则；按http/ws指南核对格式，每条规则enabled控制其参与，场景统一控制运行时Mock。',
      step('reload_rules', selected),
      '检查loaded和status.scene.runtime，修复错误；使用activate_scene激活目标场景。',
      '场景需要重新执行应用入口时，按lifecycle调用hot_restart；仅修改源码且需保留页面状态时选择hot_reload。两者都通过MCP调用，无需另开终端。',
      step('get_ui_snapshot', { ...selected, maxNodes: 200 }),
      '从快照选择真实 Key 或明确的文字、语义、类型和祖先条件，find_widget 确认唯一后操作及等待。',
      '查询新产生的HTTP记录或WS消息详情，并重新取UI快照/查找目标验证结果；单纯loaded或runtimeApplied不等于已命中规则。',
      '需要稳定业务 Key 时可修改源码并复验；无 Key 页面可使用显式选择器。完成后报告改动、命中证据、当前开关和未验证项；按用户要求恢复临时开关或规则。',
    ],
    lifecycle: {
      scope:
        'hot_reload/hot_restart只控制当前项目已连接VM准确对应的Cursor/VS Code Flutter Debug会话；无法绑定、会话结束或能力不支持时报告诊断，不操作其他会话。仅手动VM地址且无法关联IDE会话时不可用。',
      parameters:
        '均传sessionId，可选timeoutMs为100..30000毫秒，默认30000毫秒。需要应用源码变更时先保存文件。工具不编辑源码、不提供任意求值，也不会自动读取Mock规则文件。',
      reload: step('hot_reload', { ...selected, timeoutMs: 30000 }),
      reloadMeaning:
        '保留现有内存与页面状态并应用可热重载的源码变更；不重新执行main或initState，也不保证重新请求API。无法热重载的变更需由Agent判断是否按任务改用hot_restart。',
      restart: step('hot_restart', { ...selected, timeoutMs: 30000 }),
      restartMeaning:
        '重置应用内存状态并重新执行入口，页面会回到应用定义的初始状态；磁盘持久化数据不会因此自动清除。修改API Mock后，先reload_rules检查加载/同步，再activate_scene激活所需场景，记录请求/消息基线后调用hot_restart。',
      runtime:
        '连接未断时，已有采集/Mock开关维持并重新发现运行时对象；启动首请求可能早于Mock重新注入，不能保证拦截。检查返回的network及get_network_status；实际VM断线后暂时停止Mock，持久激活场景在重连后自动恢复。',
      confirmation:
        'hot_reload以当前Flutter Isolate/Group的成功重载事件确认；hot_restart确认旧Flutter Isolate消失且新Isolate就绪。无源码变化时部分运行时不发送重载事件，可能返回TIMEOUT及completed=false；先检查UI/IDE诊断，不自动重试。',
      verification:
        '工具完成只说明热重载/重启流程完成，不表示业务状态已验证。重新获取UI快照和WS连接，不复用旧UI对象或connectionId；检查本次新HTTP/WS记录的规则命中和有效正文，再按Key验证页面。超时、取消或断线后先查询当前状态，不自动重试重启。',
    },
    relatedTopics: ['http', 'ws', 'ui'],
  },
};

export function getUsageGuide(
  topic: GuideTopic = 'overview',
): Record<string, unknown> & { topic: GuideTopic; topics: typeof guideTopics } {
  return { topic, topics: guideTopics, ...guides[topic] };
}
export const guideResources = guideTopics.map((topic) => ({
  uri: `flutter-pilot://guides/${topic}`,
  name: `flutter-pilot-${topic}-guide`,
  description: String(guides[topic].title),
  mimeType: 'application/json',
}));

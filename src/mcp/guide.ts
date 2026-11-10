/** Agent-facing reference, bundled into MCP so it is available even without an IDE session. */
export const guideTopics = ['overview', 'http', 'ws', 'ui', 'workflow'] as const;
export type GuideTopic = (typeof guideTopics)[number];

export const agentInstructions = `Flutter API Mocks 配合 Flutter Debug 开发联调：用 API Mock 构造下单成功/失败、资产数据等业务状态，用 WS Mock、向App注入或向服务端发送消息驱动业务事件，再按 Key 精确操作 UI 并验证结果，减少逐步截图识别的耗时与token。
当用户任务需要这些能力时，主动使用本 MCP：先调用 get_usage_guide 按需读取 overview/http/ws/ui/workflow，再 list_sessions 选择用户任务对应的项目；不要只给用户手工操作建议。
get_usage_guide 无需 sessionId，插件未运行也能读取；也可通过 resources/list 发现对应指南资源。
规则使用 Agent 自身的文件编辑能力维护，通过 get_network_status 获取准确路径，保留已有规则；保存后 reload_rules，按任务显式开启采集/Mock，再操作 UI、查询记录验证。MCP 本身不提供文件编辑或规则 CRUD。
所有运行时工具必须明确 sessionId。正式 UI 定位只用 ValueKey<String/int>；先 get_ui_snapshot 发现 Key，再 find_widget/ancestorKey 确认唯一，缺 Key 用 inspect_key_issues 定位后由编码 Agent 修复，不回退文本或坐标。UI 超时先检查结果，不自动重试。
WS主动消息用inject_ws_message向App注入模拟服务端事件，或send_ws_message通过App当前连接发往服务端；两者需显式开启WS采集和WS Mock，按业务协议传原始text或topic/data。发送可能被outbound规则替换或丢弃，需查询实际结果；成功返回不等于业务成功。
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
const step = (tool: string, args: Record<string, unknown> = {}) => ({ tool, arguments: args });
const selected = { sessionId: '<从 list_sessions 选择的会话ID>' };

const guides: Record<GuideTopic, Record<string, unknown>> = {
  overview: {
    title: '什么时候使用 Flutter API Mocks MCP',
    scenarios: [
      '需要测试下单成功/失败、余额不足、不同资产信息或接口空数据等业务状态，或改请求/响应/目标地址时，读取 http。',
      '需要替换/丢弃业务 WebSocket 消息、向App注入订单或资产事件、通过真实连接发送topic/data、检查双向消息时，读取 ws。',
      '需要按Key快速精确定位组件并点击/输入/滚动，减少截图识别的耗时和token，或检查Key缺陷时，读取 ui。',
      '需要完成 Mock 配置 → 页面操作 → 网络与界面验证时，读取 workflow。',
    ],
    start: [
      step('get_usage_guide', { topic: 'workflow' }),
      step('list_sessions'),
      step('get_network_status', selected),
    ],
    files: { http: '.api-mocks/rules.json', ws: '.api-mocks/ws-rules.json' },
    boundaries: [
      '指南只读且不需要运行中的插件；实际运行需要本机 IDE 中对应项目已开启 MCP 和 Flutter Debug VM。',
      '文件由编码 Agent 编辑，MCP 负责加载、开关、UI 操作与验证；不修改无关规则，不猜测会话ID或VM地址。',
      '没有可用会话时报告需在插件开启MCP；VM未连接时报告需要连接Debug App。不要声称已完成运行时验证。',
    ],
  },
  http: {
    title: '编辑 .api-mocks/rules.json：HTTP/Dio 规则',
    preparation:
      '先 get_network_status 取得 files.http 绝对路径，再读取文件并保留已有 rules。JSON 顶层只含 version:1 和 rules 数组，不能写注释；示例是新增单条规则的参考，不是覆盖整个现有文件。',
    exampleDocument: httpExample,
    businessScenarios: [
      '依据真实接口契约构造下单成功、下单失败、余额不足或资产信息等状态，HTTP状态与业务code分别核对，不能假设业务失败一定返回HTTP 4xx/5xx。',
      '任务需要多种状态时逐个切换目标规则、触发请求并验证，避免同一接口的多个场景规则同时命中；使用新记录和当前页面判断结果。',
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
      redirect: '格式为 {url:"https://..."}，改写目标地址，不是HTTP301/302；不能与mock同时存在。',
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
      '读取现有文件，按ID增量修改或追加唯一ID的规则；核对匹配范围、priority和enabled后保存。',
      step('reload_rules', { ...selected, domain: 'http' }),
      '确认results.http.loaded/synchronized；runtimeApplied=false且pending=true时尚未实际应用。校验失败时修文件，插件保留上一份有效规则。',
      step('set_capture_enabled', { ...selected, domain: 'http', enabled: true }),
      step('set_mock_enabled', { ...selected, domain: 'http', enabled: true }),
      'get_network_status确认Dio已接入；按UI Key触发请求，不重放未知业务请求。',
      step('get_requests', { ...selected, path: '/v1/orders', limit: 10 }),
      step('get_request', { ...selected, id: '<新产生记录ID>' }),
      '核对新记录的mocked、requestRuleId/responseRuleId、response.status/body和页面结果。避免把历史旧记录当本次结果。',
    ],
    limitations:
      'Debug/JIT、兼容Dio实例；新实例扫描前首请求可能未拦截，上传/流/二进制正文有编辑限制。规则启用与运行时Mock总开关是两层状态。',
  },
  ws: {
    title: '业务 WebSocket 规则、模拟推送与真实连接发送',
    preparation:
      '先 get_network_status 取得 files.ws 绝对路径，读取并保留现有规则。此文件针对App业务WebSocket，不是Dart VM调试连接。顶层为version:1和rules数组。',
    exampleDocument: wsExample,
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
        'connectionId规则是当前准确连接的内存临时规则，不写入ws-rules.json；本MCP不提供临时规则CRUD。',
    },
    variants: { drop: { action: { type: 'drop' } } },
    workflow: [
      '增量编辑并保存规则文件，不覆盖已有无关规则。',
      step('reload_rules', { ...selected, domain: 'ws' }),
      step('set_capture_enabled', { ...selected, domain: 'ws', enabled: true }),
      step('get_ws_connections', selected),
      '检查目标连接的URL、capture和status；URL未知或未接入时说明限制。',
      step('set_mock_enabled', { ...selected, domain: 'ws', enabled: true }),
      '按Key操作App或等待任务要求的业务事件；需要主动消息时按manualMessages选择注入App或真实发送。当前不提供定时消息或自动应答。',
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
      'WS采集与WS Mock独立，启用WS Mock前需要受支持的WS采集。不会联动Dio Mock；关闭采集或VM断开会关闭WS Mock。',
    manualMessages: {
      preparation:
        '显式开启WS采集和WS Mock，通过get_ws_connections选择在线、capture=attached的准确连接；不新建连接。先记录消息ID或时间基线，连接重建后重新选择。',
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
    title: '发现 UI、按 Key 定位与操作 Widget',
    purpose:
      '开发联调优先用结构化快照和稳定Key精确定位组件、驱动多种业务状态验证，减少每步截图识别的耗时与token；视觉样式或布局验收仍需截图证据。',
    discovery: [
      step('list_sessions'),
      step('get_ui_snapshot', { ...selected, maxNodes: 200 }),
      '从widgets读取真实的key、ancestorKeys、type、bounds、enabled/actionable及source；key对象中的value转为工具参数，字符串和整数不能互换。不要猜Key。',
      step('find_widget', { ...selected, key: 'login.submit', ancestorKey: 'login.page' }),
      '确认范围内唯一且可操作。多个相同Key用ancestorKey缩小范围；UniqueKey、自定义Key子类或对象身份Key不能作稳定选择器。',
    ],
    examples: [
      step('enter_text', { ...selected, key: 'login.username', ancestorKey: 'login.page', text: 'demo' }),
      step('wait_for_widget', { ...selected, key: 'login.submit', state: 'actionable', timeoutMs: 5000 }),
      step('tap', { ...selected, key: 'login.submit', ancestorKey: 'login.page' }),
      step('wait_for_widget', { ...selected, key: 'home.page', state: 'present', timeoutMs: 5000 }),
      step('scroll', {
        ...selected,
        key: 'orders.list',
        direction: 'down',
        targetKey: 'order.42',
        maxSteps: 10,
        timeoutMs: 10000,
      }),
      step('find_widget', { ...selected, key: 42, ancestorKey: 'orders.list' }),
    ],
    diagnosis: [
      'NOT_FOUND只说明当前挂载树未找到，可能页面未进入或懒加载尚未创建；先确认页面，再有界滚动或等待。',
      step('inspect_key_issues', { ...selected, maxNodes: 200 }),
      'MISSING_KEY/UNSTABLE_KEY由编码Agent结合source修复业务源码，加入稳定ValueKey（列表用业务ID，不用位置索引），热重载后重新验证。不能用文本点击绕过问题，也不必给每个布局节点加Key。',
      'AMBIGUOUS_KEY需缩小父范围；AMBIGUOUS_ACTION_TARGET/AMBIGUOUS_SCROLL_TARGET需给具体交互/滚动目标加稳定Key。',
      '遮挡/禁用应按正常业务导航解除，不能绕过命中测试。超时或连接失效先检查界面和网络结果，不自动重放点击；HotRestart后重新读取界面。',
    ],
    boundaries:
      '仅当前挂载界面，不是全仓静态审计。文本输入模拟Flutter编辑协议，支持formatter/onChanged，但不覆盖真实IME组合输入；点击/滚动使用pointer事件，不直接调用回调。',
  },
  workflow: {
    title: '按需主动调用：规则文件 → UI 操作 → 网络与页面验证',
    steps: [
      '当用户请求涉及API/WS Mock、Flutter UI查找与交互或Key诊断时，主动读取对应get_usage_guide主题并执行任务范围内操作。',
      '多场景任务按指定状态逐个执行：API构造成功/失败/资产数据，或WS注入/发送业务事件，再按Key操作并验证，防止上个场景的规则和页面状态污染当前结果。',
      step('list_sessions'),
      '按用户项目选择会话；多个候选无法确定时询问用户，不选择无关项目。',
      step('get_network_status', selected),
      '用Agent文件工具读取返回的rules文件，增量编辑目标规则；按http/ws指南核对格式，enabled与运行时Mock独立。',
      step('reload_rules', { ...selected, domain: 'all' }),
      '检查每个域结果，修复错误；根据本任务显式开启相应采集/Mock，WS先采集再Mock。',
      step('get_ui_snapshot', { ...selected, maxNodes: 200 }),
      '读取真实Key后find_widget确认范围与状态，再tap/enter_text/scroll/wait_for_widget。',
      '查询新产生的HTTP记录或WS消息详情，并重新取UI快照/查找目标验证结果；单纯loaded或runtimeApplied不等于已命中规则。',
      '出现Key缺陷由编码Agent修改业务源码并复验；完成后报告改动、命中证据、当前开关和未验证项；按用户要求恢复临时开关或规则。',
    ],
    relatedTopics: ['http', 'ws', 'ui'],
  },
};

export function getUsageGuide(
  topic: GuideTopic = 'overview',
): Record<string, unknown> & { topic: GuideTopic; topics: typeof guideTopics } {
  return { topic, topics: guideTopics, ...guides[topic] };
}
export const guideResources = guideTopics.map((topic) => ({
  uri: `flutter-api-mocks://guides/${topic}`,
  name: `flutter-api-mocks-${topic}-guide`,
  description: String(guides[topic].title),
  mimeType: 'application/json',
}));

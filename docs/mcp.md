# 通过 MCP 接入编码 Agent

Flutter Pilot 的 MCP 服务名和客户端配置键均为 `flutter-pilot`，指南资源 URI 使用 `flutter-pilot://`。本次更名直接切换，已有旧服务配置不会自动转换；请在工作台重新适配，并在客户端移除旧条目后重连。

MCP 让 Claude Code CLI、Codex CLI 和 Codex App 复用插件已经连接的 Dart VM，在 Flutter Debug 应用中按 Key 定位、点击、输入和滚动，并读取 HTTP／WebSocket 记录验证结果。接入无需在应用中添加 Driver、测试入口或 helper。插件仍需在受信任的 macOS 本地 Cursor／VS Code 工作区中运行。

主要用于开发联调和多业务状态验证：API Mock 构造下单成功、失败、余额不足或不同资产数据，WS Mock 与主动消息驱动订单/资产事件，再通过 Key 精确操作目标组件。结构化快照和 Key 避免日常交互反复截图识别，减少耗时与 token；视觉样式与布局验收仍应补充截图。多状态任务按场景逐个切换并分别验证，防止规则和页面状态互相干扰。

## 开启与适配

1. 用项目原来的入口启动 Flutter Debug 应用，在 **连接与诊断** 确认 VM 已连接。
2. 打开工作台 **MCP** Tab，开启 MCP。服务默认关闭，开关按当前工作区保存在 IDE 私有存储中。
3. 在目标 Agent 卡片中选择 **当前项目** 或 **全局**，默认当前项目，点击 **一键适配**。未开启服务时适配会同时开启当前工作区 MCP。
4. 按卡片提示在客户端加载配置。Claude Code 可能需要批准项目 MCP；Codex 可能需要信任项目、重新加载 MCP 或新建会话。插件不会跳过这些客户端步骤。
5. 让 Agent 调用 `list_sessions`，确认项目与会话，然后执行后续工具。

适配需要本机可用的 Node.js 20+；插件检测并保存其绝对路径，不自动安装运行时。桥接脚本存放在用户私有的稳定路径，升级插件后无需因为扩展安装目录变化重新配置 Agent。

**已配置，待客户端连接** 表示配置文件已就绪，不能证明 Agent 已加载。一键适配还会进行桥接自检，但自检不会使客户端被标记为已连接。只有实际 MCP 客户端握手后才显示连接信息。客户端信任、批准及组织策略无法仅从配置文件确认；状态未知时明确提示，不会静默改成全局配置。

## 项目与全局范围

| 客户端          | 当前项目                    | 全局                                                  |
| --------------- | --------------------------- | ----------------------------------------------------- |
| Claude Code CLI | 项目 `.mcp.json`            | 用户级 Claude MCP 配置                                |
| Codex CLI       | 项目 `.codex/config.toml`   | `CODEX_HOME/config.toml`，默认 `~/.codex/config.toml` |
| Codex App       | 其实际加载的项目 Codex 配置 | 其实际加载的用户 Codex 配置                           |

Codex CLI 与 App 可能共用配置；卡片会显示共享来源，配置不会重复写入。是否支持项目配置以目标客户端实测为准。项目适配仅能访问绑定工作区，全局适配可以发现本机已开启 MCP 的工作区；全局适配不会为其他项目自动开启服务。所有有目标的操作均需传入明确的 `sessionId`。

已有其他 MCP 配置会保留。同名配置不匹配时显示冲突，点击 **修复本插件配置** 才替换该条目；**移除适配** 只移除确认属于本插件的配置。关闭 MCP 保留客户端配置，重新开启即可恢复。关闭工作台不停止后台服务；退出 IDE 或关闭工作区后会话不可用。

VM 认证地址不写入 Agent 配置。桥接进程通过私有 Unix socket 访问插件，每次请求校验本地会话凭证与工作区；注册文件、凭证和 socket 不进入项目仓库。

## Agent 能力发现与使用指南

MCP 在连接初始化时向 Agent 提供能力说明与适用场景。任务涉及 HTTP／WS Mock、网络排查、Flutter Widget 查找与交互、Key 缺陷时，说明会引导 Agent 主动读取指南并使用工具。`tools/list` 中也有简短说明，无需把整份手册始终塞进上下文。

新增只读工具 `get_usage_guide`，无需 `sessionId`，插件未运行时也能读取：

```json
{ "topic": "http" }
```

| topic              | 内容                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `overview`（默认） | 能力场景、首次调用、规则文件和运行前提                               |
| `http`             | `rules.json` 的字段、完整合法示例、请求／响应修改、转发及验证流程    |
| `ws`               | `ws-rules.json` 的 URL、方向、文本匹配、替换／丢弃及双向消息验证     |
| `ui`               | 快照发现真实 Key、父范围查找、点击／输入／滚动／等待、Key 诊断与修复 |
| `workflow`         | 编辑规则 → 重载 → 显式开启采集／Mock → 操作 UI → 查询网络及页面结果  |

同一份指南还可通过 `resources/list` 发现，URI 为 `flutter-pilot://guides/<topic>`，使用 `resources/read` 读取。工具入口兼容只使用 MCP tools 的 Agent，资源入口方便支持参考资料的客户端；两者返回相同内容。

支持 MCP Prompts 的客户端可通过 `prompts/list` 发现、通过 `prompts/get` 读取 25 个模板：原有 `http_mock`、`websocket_mock`、`flutter_ui`、`mock_workflow` 四个场景模板，以及下文工具列表中全部 21 个工具的同名独立模板。`hot_reload` 和 `hot_restart` 可以直接按同名 Prompt 查找，无需先打开其他场景模板。

例如读取热重启提示词：

```json
{ "name": "hot_restart", "arguments": { "task": "修改订单 Mock 后重启并验证空状态页面" } }
```

每个模板可传可选 `task`，描述具体目标；工具模板包含准备、操作及验证步骤，并直接引用生产工具 schema，`task` 本身不是工具调用参数。模板可在 IDE 离线时读取，不会自行执行工具。`get_usage_guide` 模板不要求在线会话；运行时工具则引导 Agent 选择准确项目，并检查对应能力与前提。

Agent 的可调用能力由 `tools/list` 提供，Prompts 是可选的使用指导；未读取 Prompts 不等于工具不存在。初始化说明已明确列出所有工具及同名 Prompt 入口。不支持 Prompts 的客户端仍可通过工具描述和 `get_usage_guide` 发现用法。新增工具必须补齐同名提示词，类型检查及真实 MCP stdio 测试会校验完整覆盖和可读性。

指南明确由 Agent 文件工具增量编辑规则，先通过 `get_network_status` 获取准确路径并保留已有规则。HTTP JSON 正文必须序列化为字符串；WS 规则针对业务连接，连接临时规则不能写入持久文件。保存后调用 `reload_rules`，检查各域加载与同步结果，再显式控制开关并验证本次新记录。UI 先用快照发现 Key，再确认唯一目标；没有 Key 时诊断并补业务源码，不回退文本定位。

例如用户要求“模拟订单列表空数据并验证页面”，Agent 应先读取 `http`／`workflow` 指南，选择对应项目会话，读取并编辑规则，再完成重载、Mock、Key 操作和结果验证。具体是否主动调用仍由客户端 Agent 根据任务和上下文决定；MCP 说明提供发现与操作指引，不替代用户授权和客户端审批。

## 通过 MCP 热重载与热重启

Agent 可以直接调用两个 MCP 工具控制当前应用：

- `hot_reload`：应用已保存的源码变更，保留当前内存和页面状态，不重新执行 `main` 或 `initState`，也不保证重新请求 API。
- `hot_restart`：重置应用内存状态并重新执行入口，页面回到应用定义的初始状态；磁盘持久化数据不会因此自动清除。

`list_sessions` 的 `capabilities.lifecycle` 返回当前会话是否支持热更新及繁忙状态。两者都需要 `sessionId`，可选 `timeoutMs` 为 100～30000 毫秒，默认 30000 毫秒。例如：

```json
{ "sessionId": "从 list_sessions 获取", "timeoutMs": 30000 }
```

首版仅控制当前已连接 VM 准确对应的 Cursor／VS Code Flutter Debug 会话。应用可由 IDE 启动或附加；无法绑定调试会话、会话已结束或不支持操作时返回明确诊断，不会操作其他项目或当前碰巧处于焦点的会话。仅手动输入 VM 地址且无法关联 IDE 会话时不可用。Agent 使用 MCP 入口即可，无需额外终端操作。

“修改 API → restart → 展示不同状态和 UI”的流程是：增量修改目标 Mock 文件，调用 `reload_rules` 检查加载和同步，显式开启所需采集与 Mock，记录请求／消息基线，再调用 `hot_restart`。热重启不会代替规则文件重载；仅修改源码且需要保留页面状态时选择 `hot_reload`。编译失败时先修复源码，不自动改成热重启。

VM 连接未断时，已有采集／Mock 开关维持，并重新发现运行时对象。启动首请求可能早于 Mock 重新注入，因此不能保证拦截；检查工具返回的 `network` 及 `get_network_status`，必要时待接入后按 Key 再次触发请求。实际 VM 断线后仍按既有规则关闭 Mock，重新连接后须按任务显式开启。

热重载用当前 Flutter Isolate／Group 的成功事件确认，热重启用旧 Flutter Isolate 消失且新 Isolate 就绪确认。部分运行时在源码无变化时不发送重载事件，此时可能超时并返回 `completed=false`，需要检查当前 UI 和 IDE 诊断；不将调试协议响应本身当成更新成功。

工具完成表示热重载／重启流程完成，业务结果需要另行验证。重新读取 UI 快照和 WS 连接，不复用旧 UI 对象或 `connectionId`；检查本次新 HTTP／WS 记录的规则命中、有效正文及页面状态。超时、取消或断线后先查询当前状态和新记录，不自动重试重启。

## Widget 定位与 Key 诊断

正式定位支持精确的 `ValueKey<String>` 与 `ValueKey<int>`，工具参数 `key` 使用字符串或整数。可用 `ancestorKey` 限定父节点范围；Key 在局部树中可重复，范围内多个匹配会报告 `AMBIGUOUS_KEY`。

```json
{ "sessionId": "从 list_sessions 获取", "key": "login.submit", "ancestorKey": "login.page" }
```

工具不会把 Key 的显示文本作为标识，不回退到页面文字或裸坐标。`UniqueKey`、对象身份 Key 及自定义 Key 子类不作为首版稳定选择器。每次操作重新查找，Hot Restart 后不复用旧对象。

`find_widget` 返回 `NOT_FOUND` 只说明当前未找到：页面可能尚未进入，或者列表项尚未创建。`inspect_key_issues` 检查当前已挂载交互目标的缺失／不稳定 Key，不是全项目静态审计。稳定的外层 Key 能唯一定位内部交互节点时，不会要求给框架内部所有节点补 Key。诊断尽可能包含源码位置，无法可靠映射时会说明。编码 Agent 应结合业务源码补 Key，再热重载或重启并重新验证。

点击与滚动通过 Flutter pointer 事件和命中测试执行，不直接调用按钮回调；遮挡、禁用、屏幕外目标可能无法操作。输入先取得焦点，再走 Flutter 文本编辑更新链路，支持 formatter 和 `onChanged`；它模拟文本编辑协议，**不覆盖真实系统键盘 IME 组合输入**。

同一会话的 UI 操作串行执行，多个 Agent 的一次手势不会穿插。多个工具调用组成的业务流程不持有跨调用锁。等待和滚动均有上限；操作超时可能已经触发业务，Agent 应先查询界面或网络结果，不能自动重试点击。

## WebSocket 主动消息

先显式开启 WS 采集和 WS Mock，再调用 `get_ws_connections` 选择在线且 `capture=attached` 的准确连接。两个工具均复用 App 现有连接，不新建 WebSocket：

- `inject_ws_message`：向 App 接收链路注入模拟服务端事件，用于构造订单状态、资产更新等页面状态，不发给服务端。
- `send_ws_message`：经 App 当前真实连接发往服务端，适合发送指定订阅或测试消息；当前 outbound 规则仍会生效，消息可能被替换或丢弃。

公共参数是 `sessionId`、`connectionId`；正文选择 `text` 或 `topic` + `data`，两种方式互斥。`topic` + `data` 会序列化为 JSON 对象 `{"topic":"...","data":...}`，`data` 可以是任意 JSON 值；项目采用其他字段、数组信封或 Socket.IO 帧时，使用 `text` 提供符合真实协议的完整文本。正文受运行时 UTF-8 字节上限限制。

例如，调用 `inject_ws_message` 的参数如下，业务 topic 与字段应根据目标项目调整：

```json
{
  "sessionId": "从 list_sessions 获取",
  "connectionId": "从 get_ws_connections 获取",
  "topic": "assets.updated",
  "data": { "balance": "100.00" }
}
```

通过 `send_ws_message` 发送原始文本的参数示例：

```json
{
  "sessionId": "从 list_sessions 获取",
  "connectionId": "从 get_ws_connections 获取",
  "text": "{\"topic\":\"orders.subscribe\",\"data\":{\"orderId\":\"example\"}}"
}
```

调用前记录消息 ID 或时间基线，调用后使用 `get_ws_messages` 并传 `includeBodies=true` 核对新消息的方向、`original`、`effective`、`outcome` 和 `ruleId`，再验证页面或服务端业务响应。工具成功不等于服务端已收到或业务处理成功。连接重建后重新选择连接；超时、取消或断线后先查结果，避免自动重试造成重复业务事件。当前不提供定时消息或自动应答。

## 工具列表

| 工具                                       | 用途                                                  |
| ------------------------------------------ | ----------------------------------------------------- |
| `get_usage_guide`                          | 按主题读取规则编辑、UI 定位和验证指南，无需在线 IDE   |
| `list_sessions`                            | 获取已开启 MCP 的项目和能力                           |
| `hot_reload` / `hot_restart`               | 控制当前 VM 对应 IDE 调试会话的热重载／热重启         |
| `get_ui_snapshot`                          | 获取有界的已挂载 UI 结构                              |
| `find_widget`                              | 按 Key 查询目标                                       |
| `tap` / `enter_text` / `scroll`            | 点击、替换输入内容、滚动                              |
| `wait_for_widget`                          | 等待出现、消失或可操作                                |
| `inspect_key_issues`                       | 诊断当前界面交互目标的 Key                            |
| `get_network_status`                       | 查询采集／Mock／规则加载状态和文件位置                |
| `get_requests` / `get_request`             | 分页查询 HTTP 记录与详情                              |
| `get_ws_connections` / `get_ws_messages`   | 查询 WS 连接和消息；`includeBodies` 请求正文          |
| `inject_ws_message`                        | 向 App 注入模拟服务端消息，支持原始文本或 topic/data  |
| `send_ws_message`                          | 经 App 真实 WS 连接发送消息，受当前 outbound 规则影响 |
| `reload_rules`                             | 重新读取、校验并同步 `http`、`ws` 或 `all` 规则       |
| `set_capture_enabled` / `set_mock_enabled` | 显式控制指定 `http`／`ws` 域的开关                    |

除 `get_usage_guide`、`list_sessions` 外，工具均需 `sessionId`。正式参数及边界以客户端发现的工具 schema 为准。MCP 不提供任意 Dart 求值或规则增删改工具。

## Agent 操作示例

可以向编码 Agent 下达以下任务：

> 读取 Flutter Pilot 的 `get_usage_guide`（http／ui／workflow），调用 `list_sessions` 选择当前项目。查看 `get_network_status` 返回的规则路径，保留已有规则，只修改产品详情 Mock 正文。保存 `.flutter-pilot/rules.json` 后调用 `reload_rules`，确认加载和同步成功，显式开启 HTTP Mock。通过 `get_ui_snapshot` 找到实际产品及详情 Key，确认目标唯一后点击产品，等待详情出现，查询对应 HTTP 请求并验证响应字段。出现 Key 诊断问题时修改业务源码补稳定 Key，重新验证；不要用文本点击绕过问题。

> 分别构造接口成功、失败和空数据三个场景。每次只启用对应 Mock，保存后 `reload_rules`，确认采集和 Mock 状态，再用 `hot_restart` 重置页面状态。检查重启返回的网络状态及本次新请求；如果启动请求早于 Mock 接入，待接入后按 Key 再次触发。最后核对接口命中和对应 UI，不把热重启完成当作场景通过。

HTTP 规则保存在 `.flutter-pilot/rules.json`，WS 持久规则保存在 `.flutter-pilot/ws-rules.json`。Agent 直接维护文件；配置非法时保留文件及上一份有效规则。重载并不自动开启 Mock，WS 重载保留仍有效的连接临时规则。HTTP 与 WS 开关彼此独立，VM 断线后按原有规则关闭，重新连接后须显式开启。

## 可用性与验证边界

MCP 能连接不代表全部运行时能力均可用。请在 Tab 中查看 VM 状态和能力探测结果；不支持的 Flutter 运行时返回明确诊断。首次真实验证以 iOS 模拟器为基线，Android、真机及具体客户端版本通过范围以 [验收记录](validation.md) 为准，不能用传输层单测替代设备验收。

未打开 IDE、当前工作区未开启 MCP 或 VM 尚未连接时，Agent 会获得可用性提示。配置已写入但工具尚未出现时，先按客户端卡片提示检查信任、加载及策略状态，再重新检测。

规则重载结果中 `loaded` 表示读取及校验通过，`synchronized` 表示插件接受规则并完成当前可执行的同步，`runtimeApplied` 表示运行中的 Mock 已实际接入；`pending` 表示仍需连接 VM、开启 Mock 或发现实例。不能仅凭文件加载成功断言请求已被 Mock。

适配卡片提示项目、全局及 Claude local 配置的同名覆盖关系。未知 Codex 握手名只显示实际名称，不推断来自 CLI 还是 App。

MCP 配置和 stdio 连接不需要 macOS 钥匙串。隔离 IDE 验收可能触发宿主自身的钥匙串提示，因此 `test:ide:mcp` 默认跳过 GUI，不能作为日常自动回归运行。

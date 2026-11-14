# 通过 MCP 接入编码 Agent

Flutter Pilot 的 MCP 服务名和客户端配置键均为 `flutter-pilot`，指南资源 URI 使用 `flutter-pilot://`。本次更名直接切换，已有旧服务配置不会自动转换；请在工作台重新适配，并在客户端移除旧条目后重连。

MCP 初始化会随服务信息返回专用的连接图标，PNG 以内嵌 data URI 提供，桥接离线时也可读取，无需访问网络或查找安装目录。客户端决定是否展示该图标；图标源文件位于 `resources/icons/mcp.svg`，发布图片位于 `resources/icons/mcp.png`。

MCP 让 Claude Code CLI、Codex CLI、Codex App 和 Cursor 复用插件已经连接的 Dart VM，在 Flutter Debug 应用中按 Key 定位、点击、输入和滚动，并读取 HTTP／WebSocket 记录验证结果。接入无需在应用中添加 Driver、测试入口或 helper。插件仍需在受信任的 macOS 本地 Cursor／VS Code 工作区中运行。

主要用于开发联调和多业务状态验证：API Mock 构造下单成功、失败、余额不足或不同资产数据，WS Mock 与主动消息驱动订单/资产事件，再通过 Key 精确操作目标组件。结构化快照和 Key 避免日常交互反复截图识别，减少耗时与 token；视觉样式与布局验收仍应补充截图。多状态任务按场景逐个切换并分别验证，防止规则和页面状态互相干扰。

## 开启与适配

1. 需要 Flutter 运行时操作时，用项目原来的入口启动 Debug 应用，在 **连接与诊断** 确认 VM 已连接；能力和指南可离线查阅。
2. 打开工作台 **MCP** Tab，开启 MCP。服务默认关闭，开关按当前工作区保存在 IDE 私有存储中。
3. 在目标 Agent 卡片中选择 **当前项目** 或 **全局**，默认当前项目，点击 **一键适配**。未开启服务时适配会同时开启当前工作区 MCP。
4. 按卡片提示在客户端加载配置。Claude Code 可能需要批准项目 MCP；Codex 可能需要信任项目、重新加载 MCP 或新建会话；Cursor 在 MCP 设置中确认 `flutter-pilot` 已启用，必要时重新连接。插件不会跳过这些客户端步骤。
5. 让 Agent 调用 `list_sessions`，确认项目与会话，然后执行后续工具。

适配需要本机可用的 Node.js 20+；插件检测并保存其绝对路径，不自动安装运行时。桥接脚本存放在用户私有的稳定路径，升级插件后无需因为扩展安装目录变化重新配置 Agent。

**已配置，待客户端连接** 表示配置文件已就绪，不能证明 Agent 已加载。一键适配还会进行桥接自检，但自检不会使客户端被标记为已连接。只有实际 MCP 客户端握手后才显示连接信息。客户端信任、批准及组织策略无法仅从配置文件确认；状态未知时明确提示，不会静默改成全局配置。

## 项目与全局范围

| 客户端          | 当前项目                    | 全局                                                  |
| --------------- | --------------------------- | ----------------------------------------------------- |
| Claude Code CLI | 项目 `.mcp.json`            | 用户级 Claude MCP 配置                                |
| Codex CLI       | 项目 `.codex/config.toml`   | `CODEX_HOME/config.toml`，默认 `~/.codex/config.toml` |
| Codex App       | 其实际加载的项目 Codex 配置 | 其实际加载的用户 Codex 配置                           |
| Cursor          | 项目 `.cursor/mcp.json`     | `~/.cursor/mcp.json`                                  |

Codex CLI 与 App 可能共用配置；卡片会显示共享来源，配置不会重复写入。是否支持项目配置以目标客户端实测为准。项目适配仅能访问绑定工作区，全局适配可以发现本机已开启 MCP 的工作区；全局适配不会为其他项目自动开启服务。所有有目标的操作均需传入明确的 `sessionId`。

Cursor 使用独立的 JSON 配置（兼容注释与尾逗号），在 `mcpServers.flutter-pilot` 下保存 `type:"stdio"`、Node 绝对路径和稳定桥接参数，保留其他服务及设置。项目与全局都有同名条目时，提示它们可能分别加载，不将任一范围标记为已覆盖；可在对应范围查看或移除本插件配置。客户端检测只检查 `cursor` 命令或 macOS 应用位置，不启动 IDE。当前已核对的 Cursor MCP 客户端名为 `cursor-vscode`，仅对应范围的实际握手会使卡片显示已连接；其他未知名称仍在客户端列表中展示。

路径及 stdio 字段依据 [Cursor 官方 MCP 文档](https://cursor.com/docs/mcp)。本机 Cursor 3.29.15 安装实现另确认客户端名及项目 / 用户配置独立标识；不将源码检查或合成 SDK 握手作为真实 Cursor Agent 业务验收。离线 `overview.agentAdapters`、`capabilities` 和 `get_usage_guide` 同名 Prompt 也可查阅接入入口。

已有其他 MCP 配置会保留。同名配置不匹配时显示冲突，点击 **修复本插件配置** 才替换该条目；**移除适配** 只移除确认属于本插件的配置。关闭 MCP 保留客户端配置，重新开启即可恢复。关闭工作台不停止后台服务；退出 IDE 或关闭工作区后会话不可用。

VM 认证地址不写入 Agent 配置。桥接进程通过私有 Unix socket 访问插件，每次请求校验本地会话凭证与工作区；注册文件、凭证和 socket 不进入项目仓库。

## Agent 能力发现与使用指南

MCP 在连接初始化的 `instructions` 中发送功能介绍和“用户任务 → 工具 → 使用前提”指引，引导 Agent 收到适用任务时优先主动使用 Flutter Pilot。初始化说明、`overview.capabilityRoutes` 和 `capabilities` Prompt 共用 [功能映射](../src/mcp/capabilities.ts)，覆盖当前全部 51 个工具；`tools/list` 提供工具描述及实际参数 schema。

| 用户任务示例                               | 功能与主要入口                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| “截图”“截屏”“screenshot”“长截图”“对比布局” | 当前 Flutter App 优先 `take_screenshot`；长图先 `list_screenshot_targets`         |
| “启动 App”“热重载”“热重启”                 | `list_sessions` 确认已有会话，按需 `start_app`／`hot_reload`／`hot_restart`       |
| “查接口报错”“模拟空数据、失败或资产数据”   | `get_network_status`、`get_requests`／`get_request`，需要 Mock 时重载并激活 Scene |
| “查 WS 消息”“模拟推送”“发送消息”           | `get_ws_connections`／`get_ws_messages`、`inject_ws_message`／`send_ws_message`   |
| “找控件”“点击”“滚动”“拖拽”“检查 Key”       | `get_ui_snapshot`／`find_widget`、交互工具及 `inspect_key_issues`                 |
| “输入”“清空”“复制粘贴”“收起键盘”           | `enter_text`／`edit_text`、`get_keyboard_state`／`hide_keyboard` 等键盘工具       |
| “权限弹窗”“通知栏”“返回”“旋转设备”         | 按需检查设备通道，使用原生快照、交互或 `device_action`                            |
| “登录到主页”“执行已有操作”“保存复用流程”   | `list_scenes` → `list_scene_actions` → `run_scene_action`，查询或取消运行         |
| “回归测试”“验证 HTTP/WS/UI 关联结果”       | `list_tests` → `run_test` → `get_test_run`，需要时 `cancel_test_run`              |
| “支持什么功能”“查看参数”                   | 离线 `get_usage_guide`、`capabilities` 及工具同名 Prompt                          |

例如用户在当前 Flutter App 上说“截图”，Agent 应选择对应项目并直接调用 `take_screenshot({sessionId,source:"flutter",mode:"screen"})`。普通截图无需先找 Key、读 Scene、激活 Mock 或安装 Appium。桌面、浏览器网页和其他目标使用对应工具；缺少目标上下文时先确认对象。仅截图不重启 App、不导航或切换 Mock；仅启动任务确认启动结果即可，后续按任务继续。

完整 Prompt 正文仍需 `prompts/get` 按需读取；`prompts/list` 只返回目录，启动时不会全量加载模板或执行运行时工具。客户端决定如何将初始化说明和工具提供给模型，服务端的指引不能保证 Agent 必然遵循，也不替代用户任务范围和客户端审批。

新增只读工具 `get_usage_guide`，无需 `sessionId`，插件未运行时也能读取：

```json
{ "topic": "http" }
```

| topic              | 内容                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| `overview`（默认） | 能力场景、Prompt 导航、首次调用、规则文件和运行前提                             |
| `screenshot`       | App 普通截图、长图目标选择、设备整屏、图片返回与范围限制                        |
| `http`             | `scenes.json` 中 HTTP 规则的字段、完整合法示例、请求／响应修改、转发及验证流程  |
| `ws`               | `scenes.json` 中 WS 规则的 URL、方向、文本匹配、替换／丢弃及双向消息验证        |
| `ui`               | 快照发现真实 Key、父范围查找、点击／输入／滚动／等待、Key 诊断与修复            |
| `workflow`         | 保存并复用 Scene 操作、Test Case 关联 HTTP/WS/UI 断言、临时有状态 Mock 与热更新 |

同一份指南还可通过 `resources/list` 发现，URI 为 `flutter-pilot://guides/<topic>`，使用 `resources/read` 读取。工具入口兼容只使用 MCP tools 的 Agent，资源入口方便支持参考资料的客户端；两者返回相同内容。

支持 MCP Prompts 的客户端可通过 `prompts/list` 发现、通过 `prompts/get` 读取 59 个模板：四个能力入口、原有 `http_mock`、`websocket_mock`、`flutter_ui`、`mock_workflow` 四个场景模板，以及全部 51 个工具的同名独立模板。`take_screenshot`、`start_app`、`hide_keyboard`、`hot_reload`、`hot_restart`、Scene 操作和测试工具可以直接按同名 Prompt 查找，无需先打开其他场景模板。

| Prompt                   | 查阅内容                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `capabilities`           | 用户任务到工具的功能映射，以及由当前注册表生成的全部工具和同名 Prompt 目录；只读查阅，无需任务或会话                    |
| `app_screenshot`         | 当前 Flutter App 优先截图的最短路径；普通截图、滚动长图与包含键盘／系统 UI 的设备整屏及各自前提                         |
| `scene_action_quick_run` | 复用或启动 App、发现已有 actions、选择所需 Mock、传参运行、查询／取消、最终 UI 与本轮网络验证；包含工作台手动入口       |
| `scene_action_authoring` | `scenes.json` 唯一来源、真实 Widget Key、无 target 的 `hide_keyboard`、公共 `call`、秘密参数、预检、归档及 Test Case v2 |

先只查阅能力：

```json
{ "name": "capabilities" }
```

再按任务读取快速运行流程：

```json
{
  "name": "scene_action_quick_run",
  "arguments": { "task": "复用当前项目的邮箱登录操作并验证主页与本轮 Mock 命中" }
}
```

例如读取热重启提示词：

```json
{ "name": "hot_restart", "arguments": { "task": "修改订单 Mock 后重启并验证空状态页面" } }
```

每个模板可传可选 `task`，描述具体目标；工具模板包含准备、操作及验证步骤，并直接引用生产工具 schema，`task` 本身不是工具调用参数。全部模板都可在 IDE 离线时读取，读取不会自行启动 App、修改 Mock 或执行 UI。`capabilities` 与 `get_usage_guide` 用于只读查阅；真正执行运行时任务时，再选择准确项目并检查对应能力与前提。

等待失败可分别查阅 `wait_for_widget`、`get_scene_action_run` 和 `get_test_run` 的同名 Prompt。直接等待的 `diagnostics`、Scene 运行的 `failure.diagnostics` 及测试步骤的 `steps[].failure.diagnostics` 包含 `selector`、`condition`、`timeoutMs`、`attempts` 和 `lastObservation`；先区分当前未找到目标与已找到但状态不满足，再检查页面、Key、键盘或网络，不盲目增加超时或重放操作。

工具和 Prompt 以客户端实际加载的 MCP 桥接版本为准。更新插件后，需让 IDE 加载新版插件，再按客户端要求刷新、重连或新建 MCP 会话，以重新获取初始化说明、工具与 `prompts/list`；安装文件更新不代表已经运行的桥接进程或客户端缓存同步更新。加载与重连本身不启动 App 或执行 UI。

Agent 的可调用能力由 `tools/list` 提供，Prompts 是可选的使用指导；未读取 Prompts 不等于工具不存在。初始化说明已明确列出所有工具及同名 Prompt 入口。不支持 Prompts 的客户端仍可通过工具描述和 `get_usage_guide` 发现用法。新增工具必须补齐同名提示词；重要使用流程也需进入场景 Prompt 与 `overview` 导航，类型检查及真实 MCP stdio 测试校验完整覆盖、离线发现和可读性。

指南明确由 Agent 文件工具增量编辑规则，先通过 `get_network_status` 获取准确路径并保留已有规则。HTTP JSON 正文必须序列化为字符串；WS 规则针对业务连接，连接临时规则不能写入持久文件。保存后调用 `reload_rules`，检查所需域加载及客户端接入，再用 `activate_scene` 激活目标场景并验证本次新记录。先通过 `list_scenes` / `list_scene_actions` 复用已有操作；只有首次编写、Key 失效或起始页不匹配时才探索快照。无 Key 时可显式使用文字、语义、类型、祖先范围或快照引用；不静默更换定位方式。完整步骤与失败处理见 [Scene 联调流程](scene-authoring.md)。

例如用户要求“模拟订单列表空数据并验证页面”，Agent 应先读取 `http`／`workflow` 指南，选择对应项目会话，读取并编辑规则，再完成重载、Mock、Key 操作和结果验证。具体是否主动调用仍由客户端 Agent 根据任务和上下文决定；MCP 说明提供发现与操作指引，不替代用户授权和客户端审批。

## 保存 Scene 操作并运行 Test Case

固定登录、填表、下单确认操作可由 Agent 首次探索并验证，再保存到 `files.scenes` 的 Scene targets/actions 中，`reload_rules` 更新快照。`list_scenes` 发现概要，`list_scene_actions({sessionId,sceneId})` 查询 targets、操作说明与参数。`run_scene_action({sessionId,sceneId,actionId,inputs?,backend?})` 显式启动后台运行；公共操作不会切换当前 Mock，也允许无 Mock 执行。`get_scene_action_run` 查询进度，`cancel_scene_action_run` 请求取消。等待失败的 `failure.diagnostics` 保留实际选择器、条件、期限、次数和最后观测，区分未找到目标与状态未满足；先核对起始页面、登录前提及本轮 Mock 命中。流程只在显式启动时执行；Scene 激活、重连或重开 IDE 不会触发 UI。完整格式见 [操作指南](workflows.md)。

步骤的 `target` 是共享选择器名称。例如 `targets.emailInput = {"source":"flutter","key":"emailEntry.input"}`，`target:"emailInput"` 会编译为按该 Widget Key 精确定位。Agent 无需逐步截图或重新探索；运行时核对当前挂载控件的唯一性与可操作状态，避免沿用页面切换前的对象。工作台步骤预览展示对应 Widget Key 和来源。

[动作目录](scene-actions-catalogue.md) 已归档不同登录起点和公共表单操作，步骤定义统一来自 [随包 Scene 示例](../resources/example.scenes.json)。业务项目采用同样的入口 → `call` → 公共操作结构，显式传递参数并保持秘密属性；修改后重载快照，不额外创建动作文件。输入改变布局时显式 `hide_keyboard` 确认收起再继续。

执行前记录本轮请求基线，结束时分别检查操作终态、最终 UI 和新请求 Mock 命中。HTTP `applied` 不保证每个客户端或启动首请求被覆盖，`completed` 不保证后台初始化都成功；发现真实 401 / refresh 循环应停止触发、补齐实际漏接口再验证。有意模拟的 503 等失败应单独说明，不能当作完整业务通过，也不能与漏 Mock 混为一谈。

需要业务通过标准时，在 `list_tests` 返回的 `files.tests` 保存 Test Case，使用 version:2 引用同一 Scene action。测试可组合临时 Scene、有状态 HTTP Mock、原始请求参数断言、响应变量提取、关联 WS 和精确订单行 UI 断言。`run_test` 返回 `runId` 后后台执行，`get_test_run` 查询，`cancel_test_run` 取消；只有 `passed` 表示测试通过，操作的 `completed` 不代替业务断言。完整定义与示例见 [测试指南](testing.md)。

| 工具                                          | 行为                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_scene_actions` / `list_tests`           | 查询已加载 Scene 操作 / 测试定义和路径，不要求 VM 在线                                                        |
| `run_scene_action` / `run_test`               | 接受 `sessionId`、`sceneId` + `actionId` / `testId`、可选字符串 `inputs` 和 `backend`，显式启动并返回 `runId` |
| `get_scene_action_run` / `get_test_run`       | 接受 `sessionId`、`runId`，只读查询进度、步骤与证据                                                           |
| `cancel_scene_action_run` / `cancel_test_run` | 接受 `sessionId`、`runId`，停止后续动作，等待当前动作结束和资源释放                                           |

测试观察以主流程触发前的本轮基线为准；事件在指定 HTTP 断言成功后注入，用响应 `orderId` 关联 WS 与订单行，不能以任意旧 pending 通过。测试结束恢复自身临时 Mock，已经发生的登录和订单不能回滚。超时、断线或取消后不自动再次点击 confirm 或注入事件；检查结果和证据后再决定下一步。模拟注入验证 App 处理事件，真实后端链路应等待真实事件。

## 从 Agent 启动 App 并执行场景

App 尚未运行时，`list_sessions` 的 `capabilities.appLaunch.configurations` 提供当前工作区可用的命名 Dart Debug launch 配置，仅读取名称，环境变量和启动参数不对 Agent 输出。调用 `start_app({sessionId,configurationName,deviceId?,timeoutMs?})` 让 IDE 启动该配置；多设备时可用原生 `deviceId` 明确选择模拟器或实体设备，只覆盖该次启动的设备字段，不修改 `launch.json`。同名已运行会话会复用，显式指定设备时要求能确认设备一致；其他项目、手动 VM、设备不同或无法确认、多个调试会话不会被替换。配置必须来自工作区已有配置，不接受任意命令或临时启动参数。首次编译超过等待时间时可能返回 `TIMEOUT`，应先查询 `list_sessions` 和 IDE 调试控制台，不能重复启动。

IDE 明确拒绝或抛出启动错误、目标调试会话结束时会释放启动状态，包括在两次轮询之间快速结束的会话。等待超时后的 `pendingConfiguration` 表示结果尚未确认，继续拦截重复启动；等待已结束后不因此锁住场景重载等其他工作台功能。后续启动或结束事件会解除待确认状态；若 IDE 没有产生调试会话，检查控制台后可重新加载当前 IDE 窗口恢复。IDE 启动请求本身仍在等待时，应先完成或取消 IDE 的设备／配置提示。

`capabilities.appLaunch.sessions` 返回当前项目会话的 ID、显示名称、已确认的 `configurationName` 和设备 ID，不包含环境变量或启动参数。匹配使用准确的配置名称，允许 IDE 为显示名称添加工作区后缀。重开窗口后从 IDE 当前会话恢复配置身份；仅经 DTD 发现、无法确认配置的会话返回 `APP_SESSION_UNCONFIRMED`，在 IDE 选中该会话后重新打开工作台再检查，不能按显示名称猜测或重复启动。

完整执行顺序：选择项目 → `reload_rules` → `activate_scene` → `start_app`（App 未运行时）→ 检查 VM 与 HTTP Mock 接入 → `list_scene_actions` → `run_scene_action` → `get_scene_action_run`，最后验证主页与本轮请求。App 启动完成只表示连接到对应 VM，启动首请求可能早于 Mock 注入；登录及进入主页由已保存操作执行。Scene 激活、文件重载和 IDE 恢复不会自行启动 App 或重放 UI。

VM HTTP 状态包含 `attachedDioInstances`、`coverageMessage` 和 `warnings`。已应用只证明现有 Dio 已接入。若客户端在提交回调中才创建，首次请求可能早于扫描；需要稳定的无人介入流程时，在 App 的 Debug 启动入口提前创建流程所需客户端，页面就绪后再 `reload_rules` 同步。固定等待不能解决回调内部才创建客户端的问题，也不能用重跑提交来代替确认结果。

## 通过 MCP 热重载与热重启

Agent 可以直接调用两个 MCP 工具控制当前应用：

- `hot_reload`：应用已保存的源码变更，保留当前内存和页面状态，不重新执行 `main` 或 `initState`，也不保证重新请求 API。
- `hot_restart`：重置应用内存状态并重新执行入口，页面回到应用定义的初始状态；磁盘持久化数据不会因此自动清除。

`list_sessions` 的 `capabilities.lifecycle` 返回当前会话是否支持热更新及繁忙状态。两者都需要 `sessionId`，可选 `timeoutMs` 为 100～30000 毫秒，默认 30000 毫秒。例如：

```json
{ "sessionId": "从 list_sessions 获取", "timeoutMs": 30000 }
```

首版仅控制当前已连接 VM 准确对应的 Cursor／VS Code Flutter Debug 会话。应用可由 IDE 启动或附加；无法绑定调试会话、会话已结束或不支持操作时返回明确诊断，不会操作其他项目或当前碰巧处于焦点的会话。仅手动输入 VM 地址且无法关联 IDE 会话时不可用。Agent 使用 MCP 入口即可，无需额外终端操作。

“修改 API → restart → 展示不同状态和 UI”的流程是：增量修改目标 Mock 文件，调用 `reload_rules` 检查加载和同步，激活所需场景，记录请求／消息基线，再调用 `hot_restart`。热重启不会代替规则文件重载；仅修改源码且需要保留页面状态时选择 `hot_reload`。编译失败时先修复源码，不自动改成热重启。

VM 连接未断时，已有采集／Mock 开关维持，并重新发现运行时对象。启动首请求可能早于 Mock 重新注入，因此不能保证拦截；检查工具返回的 `network` 及 `get_network_status`，必要时待接入后按 Key 再次触发请求。实际 VM 断线后停止运行时 Mock；重新连接后自动恢复已保存的激活场景，等待旧租约到期并检查分域状态。

热重载用当前 Flutter Isolate／Group 的成功事件确认，热重启用旧 Flutter Isolate 消失且新 Isolate 就绪确认。部分运行时在源码无变化时不发送重载事件，此时可能超时并返回 `completed=false`，需要检查当前 UI 和 IDE 诊断；不将调试协议响应本身当成更新成功。

工具完成表示热重载／重启流程完成，业务结果需要另行验证。重新读取 UI 快照和 WS 连接，不复用旧 UI 对象或 `connectionId`；检查本次新 HTTP／WS 记录的规则命中、有效正文及页面状态。超时、取消或断线后先查询当前状态和新记录，不自动重试重启。

## 移动交互与设备自动化

工作台 MCP Tab 提供设备自动化准备、设备选择、连接／断开、取消和诊断。VM 可独立使用，设备通道操作原生页面、权限弹窗、系统键盘和系统导航。Appium 3.9.0、UiAutomator2 8.7.3、XCUITest 12.22.8 由插件私有管理；首次准备才下载。iOS 真机使用用户预签名 WDA。完整接口、示例、坐标与取消约束见 [移动交互指南](mobile-automation.md)，设备验收范围见 [验收表](mobile-automation-validation.md)。

| 类别       | MCP 工具（均提供同名 Prompt）                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| 环境与设备 | `get_automation_status`、`setup_automation`、`connect_device`、`disconnect_device`                   |
| 手势       | `tap`、`double_tap`、`long_press`、`drag`、`swipe`、`pinch`、`rotate_gesture`、`perform_gesture`     |
| 编辑与键盘 | `enter_text`、`edit_text`、`press_key`、`get_keyboard_state`、`hide_keyboard`、`editor_action`       |
| 定位与系统 | `get_ui_snapshot`、`find_widget`、`wait_for_widget`、`scroll`、`device_action`、`inspect_key_issues` |
| 截图       | `list_screenshot_targets`、`take_screenshot`                                                         |

auto 在设备连接后使用设备输入；失败不会换通道重放。device 快照和整屏截图包含系统 UI。Flutter 转设备坐标要求 VM／设备／App 进程身份与窗口布局均可确认。动作已发送但未确认时先检查状态，不自动重试。

## Widget 定位与 Key 诊断

正式定位支持精确的 `ValueKey<String>` 与 `ValueKey<int>`，工具参数 `key` 使用字符串或整数。可用 `ancestorKey` 限定父节点范围；Key 在局部树中可重复，范围内多个匹配会报告 `AMBIGUOUS_KEY`。

```json
{ "sessionId": "从 list_sessions 获取", "key": "login.submit", "ancestorKey": "login.page" }
```

工具不会把 Key 的显示文本作为标识，也不会在失败后静默切换目标；可以显式选择文字、语义、类型、快照引用或坐标。`UniqueKey`、对象身份 Key 及自定义 Key 子类不作为稳定 Key 选择器。每次操作重新查找，Hot Restart 后不复用旧对象。

`find_widget` 返回 `NOT_FOUND` 只说明当前未找到：页面可能尚未进入，或者列表项尚未创建。`inspect_key_issues` 检查当前已挂载交互目标的缺失／不稳定 Key，不是全项目静态审计。稳定的外层 Key 能唯一定位内部交互节点时，不会要求给框架内部所有节点补 Key。诊断尽可能包含源码位置，无法可靠映射时会说明。编码 Agent 应结合业务源码补 Key，再热重载或重启并重新验证。

未连接设备时，点击与滚动通过 Flutter pointer 事件和命中测试执行，不直接调用按钮回调；遮挡、禁用、屏幕外目标可能无法操作。输入先取得焦点，再走 Flutter 文本编辑更新链路，支持 formatter 和 `onChanged`；它模拟文本编辑协议，**不覆盖真实系统键盘 IME 组合输入**。

同一会话的 UI 操作串行执行，多个 Agent 的一次手势不会穿插。多个工具调用组成的业务流程不持有跨调用锁。等待和滚动均有上限；操作超时可能已经触发业务，Agent 应先查询界面或网络结果，不能自动重试点击。

## App 截图

当前 Flutter App 的“截图／截屏／screenshot／长截图／布局对比”任务优先使用本 MCP。读取 `app_screenshot` Prompt 或 `get_usage_guide({topic:"screenshot"})` 可查看最短流程，无需先运行 Scene、配置 Mock 或探索 Key。

选择已连接 Flutter Debug VM 的项目会话，通过 `take_screenshot` 获取当前 Flutter App 的 PNG；无需 Appium，图片以 MCP 图片内容返回，需客户端支持显示图片。当前屏幕的参数示例：

```json
{ "sessionId": "从 list_sessions 获取", "source": "flutter", "mode": "screen" }
```

滚动长图先调用 `list_screenshot_targets` 查询当前可见的向下滚动区域，再将所选区域 ID 作为 `targetId` 传入：

```json
{
  "sessionId": "从 list_sessions 获取",
  "source": "flutter",
  "mode": "long",
  "targetId": "从 list_screenshot_targets 获取"
}
```

只有一个候选区域时，可以省略 `targetId`；存在多个区域时须指定。区域 ID 仅对当前页面有效，页面变化后应重新查询。长图从所选区域顶部采集到末尾，完成或失败后尝试恢复原滚动位置。它适用于普通向下滚动的 Flutter 列表和懒加载项；采集时保持页面与窗口稳定，动画或异步加载可能改变内容。嵌套、反向和横向滚动，以及原生平台视图暂不支持。`source=flutter` 图像仅包含 Flutter 渲染内容。设备连接后使用 `source=device, mode=screen` 获得包含系统栏、原生键盘和弹窗的整屏 PNG，并返回图片尺寸、方向与窗口坐标信息。

截图最高为 2 倍逻辑像素；长图最多 32 屏、30,000 像素高、2,400 万像素或 45 秒。MCP 图片传输上限为 32 MiB（含 Base64 和 JSON），客户端单次工具调用超时建议设置为至少 90 秒。超限或失败时不会返回不完整图片。

## WebSocket 主动消息

先开启 WS 采集并确认目标连接已接入，再调用 `get_ws_connections` 选择在线且 `capture=attached` 的准确连接。两个工具均复用 App 现有连接，不新建 WebSocket：

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

| 工具                                               | 用途                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `get_usage_guide`                                  | 按主题读取规则编辑、UI 定位和验证指南，无需在线 IDE                               |
| `list_sessions`                                    | 获取已开启 MCP 的项目和能力                                                       |
| `start_app`                                        | 复用或启动当前项目已保存的命名 Debug 配置，可指定已确认的设备                     |
| `hot_reload` / `hot_restart`                       | 控制当前 VM 对应 IDE 调试会话的热重载／热重启                                     |
| `list_scene_actions` / `run_scene_action`          | 读取或显式运行保存的参数化操作流程                                                |
| `get_scene_action_run` / `cancel_scene_action_run` | 查询或取消流程；completed 仅代表操作完成                                          |
| `list_tests` / `run_test`                          | 读取或显式运行含本轮 HTTP/WS/UI 断言的 Test Case                                  |
| `get_test_run` / `cancel_test_run`                 | 查询或取消测试；只有 passed 表示测试通过                                          |
| `get_ui_snapshot`                                  | 获取有界的已挂载 UI 结构                                                          |
| `find_widget`                                      | 按 Key 查询目标                                                                   |
| `tap` / `enter_text` / `scroll`                    | 点击、替换输入内容、滚动                                                          |
| `get_keyboard_state` / `hide_keyboard`             | 查询键盘状态或收起并确认稳定隐藏；之后再等待和点击目标                            |
| `wait_for_widget`                                  | 等待出现、消失或可操作                                                            |
| `inspect_key_issues`                               | 诊断当前界面交互目标的 Key                                                        |
| `list_screenshot_targets`                          | 查询当前可见的长图滚动区域                                                        |
| `take_screenshot`                                  | 截取当前 Flutter 屏幕或指定区域滚动长图，返回 MCP PNG 图片                        |
| `get_network_status`                               | 查询采集／Mock／规则加载状态和文件位置                                            |
| `get_requests` / `get_request`                     | 分页查询 HTTP 记录与详情                                                          |
| `get_ws_connections` / `get_ws_messages`           | 查询 WS 连接和消息；`includeBodies` 请求正文                                      |
| `inject_ws_message`                                | 向 App 注入模拟服务端消息，支持原始文本或 topic/data                              |
| `send_ws_message`                                  | 经 App 真实 WS 连接发送消息，受当前 outbound 规则影响                             |
| `reload_rules`                                     | 整份读取、校验并按激活状态同步 `scenes.json`，无 `domain` 参数                    |
| `list_scenes`                                      | 列出场景摘要（ID、名称、规则数量）、激活场景和 HTTP/WS 应用状态，支持 VM 离线查询 |
| `activate_scene` / `deactivate_scene`              | 持久选择或停用场景；离线待应用，重连自动恢复                                      |
| `set_capture_enabled`                              | 控制指定 `http`／`ws` 域采集；关闭暂停该域 Mock，重新开启恢复                     |

除 `get_usage_guide`、`list_sessions` 外，工具均需 `sessionId`。正式参数及边界以客户端发现的工具 schema 为准。MCP 不提供任意 Dart 求值或规则增删改工具。

## Agent 操作示例

可以向编码 Agent 下达以下任务：

> 读取 Flutter Pilot 的 `get_usage_guide`（http／ui／workflow），调用 `list_sessions` 选择当前项目。查看 `get_network_status` 返回的规则路径，保留已有规则，只修改产品详情 Mock 正文。保存 `.flutter-pilot/scenes.json` 后调用 `reload_rules`，确认加载成功，再用 `activate_scene` 激活目标场景并检查 HTTP 应用状态。通过 `get_ui_snapshot` 找到实际产品及详情 Key，确认目标唯一后点击产品，等待详情出现，查询对应 HTTP 请求并验证响应字段。无 Key 时可明确使用唯一的文字／语义选择器；歧义时限定范围后重新验证。

> 分别构造接口成功、失败和空数据三个场景。每次只激活对应场景，保存后 `reload_rules`，确认采集和 Mock 状态，再用 `hot_restart` 重置页面状态。检查重启返回的网络状态及本次新请求；如果启动请求早于 Mock 接入，待接入后按 Key 再次触发。最后核对接口命中和对应 UI，不把热重启完成当作场景通过。

HTTP 与 WS 规则统一保存在 `.flutter-pilot/scenes.json`，由 `get_network_status` 的 `files.scenes` 返回准确路径。顶层为 `{version:1, activeSceneId:null, scenes:[{id,name,httpRules:[],wsRules:[]}]}`；规则 ID 在同一协议的所有场景中唯一。Agent 直接维护文件；配置非法时保留文件及上一份有效配置，外部编辑未读取前禁止 UI 覆盖。`reload_rules(sessionId)` 整份重载后按文件中的激活状态同步；用 `activate_scene` / `deactivate_scene` 选择或停用。未激活场景的编辑不影响运行时；VM 离线时可选择待应用场景，重连、IDE 重开后自动恢复，遵守自动连接设置。连接临时 WS 规则仅存在所属激活场景的内存中，切换场景或连接失效后清除。

## 可用性与验证边界

MCP 能连接不代表全部运行时能力均可用。请在 Tab 中查看 VM 状态和能力探测结果；不支持的 Flutter 运行时返回明确诊断。首次真实验证以 iOS 模拟器为基线，Android、真机及具体客户端版本通过范围以 [验收记录](validation.md) 为准，不能用传输层单测替代设备验收。

未打开 IDE、当前工作区未开启 MCP 或 VM 尚未连接时，Agent 会获得可用性提示。配置已写入但工具尚未出现时，先按客户端卡片提示检查信任、加载及策略状态，再重新检测。

规则重载结果中 `loaded` 表示读取及校验通过；`status.scene.runtime.http` / `ws` 分别返回 `unneeded`、`pending`、`applied`、`error`、`unsupported` 或 `paused`。`pending` 表示仍需连接或发现 Dio / 目标 WS 连接，代理模式的 WS 为 `unsupported`。激活不等于实际命中，需查询本次新记录核验。

适配卡片提示项目、全局及 Claude local 配置的同名覆盖关系。未知 Codex 握手名只显示实际名称，不推断来自 CLI 还是 App。

MCP 配置和 stdio 连接不需要 macOS 钥匙串。隔离 IDE 验收可能触发宿主自身的钥匙串提示，因此 `test:ide:mcp` 默认跳过 GUI，不能作为日常自动回归运行。

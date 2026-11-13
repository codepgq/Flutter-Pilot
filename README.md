# Flutter Pilot

<img src="resources/flutter-pilot-icon.png" width="96" height="96" alt="Flutter Pilot 导航罗盘图标">

**Flutter 运行时调试与 Agent 联调工作台**，面向 **VS Code 和 Cursor**。支持通过 **Flutter VM WebSocket 零源码记录 API、实验性运行时 Dio Mock**，也保留 HTTP/HTTPS 代理、双向修改、转发、手动断点和请求历史。

配合开发与 Agent 联调，快速构造并验证多种业务状态：通过 API Mock 模拟下单成功、失败、余额不足和不同资产数据，通过 WebSocket 驱动订单或资产事件，再按组件 Key、文字或语义定位页面，通过 VM 或设备输入操作，减少逐步截图识别的耗时与 token 消耗。

当前版本为 **0.0.14**，支持 macOS 本地桌面 IDE。默认使用 **Dart VM WS** 接入正在运行的 Flutter Debug 应用，无需安装代理引擎、CA 或修改应用源码；运行时 Mock 需主动开启，目前实测 Dio 5.9.0 / 5.10.0 / 5.11.1。代理作为备用方案，优先适配 **Dio 5 + IOHttpClientAdapter**，必要时使用可预览、可撤销的开发配置。

**0.0.14 更新**：MCP 支持 App 截图与长图；修复场景断线恢复和 JSON 编辑精度，并为 API 目录提供分页。

**0.0.12 更新**：同步远端最新版并重新构建 Cursor 安装包，包含可持久保存和切换的统一 HTTP / WebSocket Mock 场景，MCP 同步提供场景查询、激活和停用；侧栏与工作台新增 App 当前屏幕和滚动长截图，保存 PNG 并自动预览。

**本轮源码扩展**：新增私有 Appium 设备通道，支持无 Key 定位、多指手势、文本编辑、键盘和系统操作，详见 [移动交互指南](docs/mobile-automation.md)。尚未发布或安装本轮改动。

**MCP 全能力提示词**：42 个工具均有同名独立 Prompt，包括 `hot_reload` / `hot_restart` 和截图工具；保留四个场景模板，共 46 个。每个工具提示词提供操作步骤和生产参数定义，新增能力漏写模板会被检查发现。

**0.0.6 修复 Cursor 设置卡死和已有 VM 会话补查恢复**：打开工作台会重新补查先前已运行的 Flutter Debug 会话；新增 MCP `hot_reload` / `hot_restart`，精确控制当前 VM 绑定的 IDE 调试会话。

**0.0.5 优化全部六个 Tab 的内容布局**：压缩共用顶部，连接与设置收进“工作区与连接”，高级筛选、规则模板、诊断及维护说明按需展开，让列表和正文使用更多窗口空间。

**0.0.4 新增 MCP Prompts 与双向 WS 主动消息**：提供四个开发场景模板，通过 MCP 向 App 注入模拟服务端消息或经 App 当前连接发送给服务端，支持原始文本或 `topic/data`；配合 API 多状态 Mock 和 Key 精确交互完成开发验证。详见 [更新记录](CHANGELOG.md) 与 [MCP 使用说明](docs/mcp.md)。

**0.0.3 新增业务 WebSocket Tab**：通过现有 VM 手动开启 WS 采集，查看双向消息；激活包含 WS 规则的场景后，可按规则整条替换或丢弃文本消息，向 App 手动注入模拟推送。运行时结构须探测通过；接入前消息不可补抓。详见 [WebSocket 使用说明](docs/v0.0.3-websocket.md)。

**MCP 与编码 Agent 接入**：MCP 服务名为 `flutter-pilot`。工作台的 MCP Tab 默认按项目适配 Claude Code CLI、Codex CLI／App；Agent 可复用现有 VM 操作 UI、重载 HTTP／WS 规则并查询记录验证结果。详见 [MCP 与编码 Agent](#mcp-与编码-agent) 和 [MCP 使用说明](docs/mcp.md)。

项目首次初始化会生成 `.flutter-pilot/project.json` 保存 UUID 和项目配置，Mock 场景保存在 `.flutter-pilot/scenes.json`。复制项目或创建 worktree 后，各目录读取自己的规则、分别记录本机历史。API 与历史按新到旧展示，目录可折叠，响应自动尝试 JSON 格式化；规则启停使用简洁 switch。

> 当前通过 VSIX 安装，尚未发布到扩展商店。0.0.2 VM 路线已在 iPhone 18 Pro / iOS 27.2 模拟器实际验证，应用入口 SHA-256 保持不变。代理路线的旧版设备验收与 VM 新版验收分别记录，完整证据和限制见 [VM 使用与可行性验证](docs/v0.0.2-vm-service.md) 和 [验收记录](docs/validation.md)。

## 目录

- [功能概览](#功能概览)
- [MCP 与编码 Agent](#mcp-与编码-agent)
- [环境要求与兼容范围](#环境要求与兼容范围)
- [安装插件](#安装插件)
- [升级现有项目](#升级现有项目)
- [VM 快速上手：无需修改 Flutter 源码](#vm-快速上手无需修改-flutter-源码)
- [快速上手：完成第一条 HTTPS Mock](#快速上手完成第一条-https-mock)
- [Flutter 与设备接入](#flutter-与设备接入)
- [工作台使用](#工作台使用)
- [规则格式与执行顺序](#规则格式与执行顺序)
- [完整规则示例](#完整规则示例)
- [配置参考](#配置参考)
- [项目绑定与配置文件](#项目绑定与配置文件)
- [数据存储与隐私](#数据存储与隐私)
- [停止代理与恢复联网](#停止代理与恢复联网)
- [故障排查](#故障排查)
- [开发、测试与打包](#开发测试与打包)
- [架构与目录](#架构与目录)
- [已知限制与验证状态](#已知限制与验证状态)
- [许可证与第三方组件](#许可证与第三方组件)

## 功能概览

**默认推荐 VM WS 接入：输入本次 Flutter VM WS 并连接后即可后台采集，无需代理引擎、CA 或源码补丁；运行时 Mock 默认关闭，按需主动开启。** 代理是备用方案，适用于 VM 无法覆盖的网络场景或手动断点。两种模式关闭工作台都继续记录；无需创建规则也能发现 API。VM 地址不持久化，重开 IDE 需重新输入。已有工作区继续使用保存的模式，旧版没有模式字段的代理配置也会保留。

| 能力 | 具体行为 |
| --- | --- |
| 本地 Mock | 匹配请求后直接返回预设状态码、响应头和正文，不访问上游 |
| 请求修改 | 修改方法、完整 URL、查询参数、请求头及 JSON / 文本正文 |
| 响应修改 | 修改状态码、响应头及 JSON / 文本正文，支持服务端 4xx / 5xx 响应 |
| 地址转发 | 改写目标完整 URL，保留请求方法和正文，直接返回目标服务结果 |
| 手动断点 | 仅代理模式：请求发送前、响应返回前暂停，编辑放行、终止及超时自动放行 |
| 后台记录 | 代理模式默认随 Flutter 工作区打开启动；VM 模式连接后持续采集，关闭工作台仍继续 |
| VM 连接 | Flutter Debug VM WS 零源码采集；通过激活场景应用 Dio Mock、双向修改和转发 |
| App 截图 | 侧栏与工作台标题栏均可截取当前 Flutter App，支持当前屏幕和滚动长图，保存 PNG 后自动预览 |
| API 目录 | 独立保存方法、主机、路径、累计调用次数和首次 / 最近调用时间，不随历史清理消失，可手动删除 |
| 请求历史 | 按 API 查看、搜索筛选、三阶段快照、规则命中、耗时、备注与标签 |
| 规则管理 | 新增、查询、编辑、删除、启停、复制、调整顺序、JSON 导入导出；规则保存在项目目录 |
| 项目绑定 | 项目 UUID 与配置随项目保存；同一 UUID 的不同目录分别记录本机历史 |
| 开发接入 | 引擎下载管理、设备检测、Android USB 转发、Dio 补丁预览与保护性撤销 |

规则通过表单或完整 JSON 配置，首版不执行用户脚本。工作台跟随 IDE 明暗主题，并适配窄面板。

### App 截图与长图

先连接 Flutter Debug VM，在左侧工作台入口点击 **截取 App / 长截图**，或在工作台顶部点击 **截图**。选择“当前屏幕”或“滚动长截图”，指定 PNG 保存位置；长图从所选区域顶部滚动到底部，完成或失败后恢复原滚动位置。多个可见滚动区域会先让你选择；无需修改 App 源码或开启 MCP。

长图适用于普通向下滚动的 Flutter 列表，包含尚未挂载的懒加载列表项。截图期间保持页面和窗口尺寸稳定；运行中的动画、异步加载和滚动监听可能改变内容。暂不支持嵌套滚动、反向/横向长图，以及原生平台视图（例如 WebView）截图。图像为 Flutter 渲染内容，不含系统状态栏、原生键盘和系统弹窗。

截图采用最高 2 倍逻辑像素分辨率。长图最多 32 屏、30,000 像素高、2,400 万像素或 45 秒；超过限制会报错并放弃保存，不输出不完整长图。分段 PNG 在扩展端无损拼接，避免移动设备 GPU 对超长纹理的缩放和截断。

启用 MCP 后，Agent 也可调用 `take_screenshot` 获取当前 Flutter App 的 MCP PNG 图片；滚动长图可先调用 `list_screenshot_targets` 查询可见滚动区域，再指定区域截图。MCP 返回还受 32 MiB 传输上限约束，客户端调用超时建议设置为至少 90 秒，详见 [MCP 使用说明](docs/mcp.md)。

## MCP 与编码 Agent

MCP 服务名称和客户端配置项名称均为 **`flutter-pilot`**；插件显示名称是 **Flutter Pilot**。服务使用标准 MCP stdio 传输，支持工具、资源和提示模板；桥接进程通过本机私有 Unix socket 访问插件会话。它复用 Flutter Debug VM，无需向应用添加 Driver 或 helper。

1. 在受信任的本地 Flutter 工作区启动 Debug 应用，并在工作台的 **连接与诊断** 中确认 VM 已连接。
2. 在 **MCP** Tab 开启服务，选择目标 Agent 和 **当前项目**（默认）或全局范围，点击 **一键适配**。需要本机 Node.js 20+。
3. 按客户端提示加载配置、信任或批准项目 MCP；必要时重连或新建会话。**已配置不代表客户端已连接**，实际握手状态在工作台显示。
4. 让 Agent 使用 `flutter-pilot` 的 `get_usage_guide` 和 `list_sessions`，选择对应项目后执行任务。

Agent 可按 `ValueKey<String/int>`、文字、语义、类型、祖先或快照引用定位；连接设备后支持完整手势、原生编辑器与系统 UI，也可诊断当前界面的 Key 问题；也可查询 HTTP 请求和业务 WebSocket 消息、重载规则并控制采集与 Mock。场景由 Agent 编辑项目的 `.flutter-pilot/scenes.json`，`reload_rules` 整份重载，`list_scenes` 查询，`activate_scene` / `deactivate_scene` 统一控制 HTTP / WS Mock。激活状态持久保存，重连和重开 IDE 后自动恢复。多状态测试逐个切换场景，分别检查新网络记录和页面结果；Key 用于日常精确交互，视觉样式和布局验收再补充截图。

WS 提供两个主动消息工具：`inject_ws_message` 向 App 注入模拟服务端消息，`send_ws_message` 通过 App 当前真实 WS 连接发给服务端。均需开启 WS 采集并确认连接已接入，并选择准确的在线连接；不新建连接。可传原始 `text`，或传 `topic` 和 `data` 组装为 `{"topic": "...", "data": ...}`；自定义业务协议使用完整原始文本。真实发送经过当前 outbound 规则，可能被替换或丢弃；工具调用成功后仍需核对消息和业务结果。

服务提供 `overview`、`http`、`ws`、`ui`、`workflow` 五个指南主题，以及 46 个 MCP 提示模板：保留 `http_mock`、`websocket_mock`、`flutter_ui`、`mock_workflow` 四个场景模板，全部 42 个工具另有同名独立模板，包含 `hot_reload` 和 `hot_restart`。每个工具模板提供准备、操作、验证步骤及与工具共用的参数 schema；新增工具遗漏模板会使类型或测试检查失败。指南可通过工具或资源读取；支持 Prompts 的客户端可按需读取并填写任务。Agent 通过 `tools/list` 获取可调用能力，初始化说明与 Prompts 补充用法；是否主动使用仍取决于客户端和 Agent。

| 能力 | MCP 工具及同名 Prompt |
| --- | --- |
| 指南与会话 | `get_usage_guide`、`list_sessions` |
| 热更新 | `hot_reload`、`hot_restart` |
| 设备自动化           | `get_automation_status`、`setup_automation`、`connect_device`、`disconnect_device`                       |
| 手势                 | `double_tap`、`long_press`、`drag`、`swipe`、`pinch`、`rotate_gesture`、`perform_gesture`                |
| 编辑与系统           | `edit_text`、`press_key`、`get_keyboard_state`、`hide_keyboard`、`editor_action`、`device_action`        |
| 界面查询与操作 | `get_ui_snapshot`、`find_widget`、`tap`、`enter_text`、`scroll`、`wait_for_widget`、`inspect_key_issues` |
| App 截图 | `list_screenshot_targets`、`take_screenshot` |
| 网络状态与 HTTP 记录 | `get_network_status`、`get_requests`、`get_request` |
| WebSocket | `get_ws_connections`、`get_ws_messages`、`inject_ws_message`、`send_ws_message` |
| 场景与采集 | `reload_rules`、`set_capture_enabled`、`list_scenes`、`activate_scene`、`deactivate_scene` |

支持标准 MCP Prompts 的客户端可通过 `prompts/list` 发现这些模板，并用 `prompts/get` 按名称读取；`task` 是可选的提示词参数，不是工具参数。截图示例：先通过 `list_sessions` 选择已连接 VM 的项目，调用 `take_screenshot` 并传入 `sessionId` 和 `mode: "screen"`；需要长图时使用 `mode: "long"`，有多个滚动区域时先通过 `list_screenshot_targets` 选择 `targetId`。结果是 MCP PNG 图片内容，由客户端显示。

工具和 Prompt 以已安装并运行的插件版本为准；更新插件后，需要重新加载插件并按客户端要求重连或新建 MCP 会话，才能发现新增能力。

例如可以向 Agent 提出：

> 使用 `flutter-pilot` 模拟订单列表为空，并验证页面。先读取 HTTP 和工作流指南，选择当前项目；保留其他规则，重载后激活目标场景，通过实际 UI Key 操作页面，并检查新产生的请求和页面结果。

> 分别测试下单成功、下单失败和余额不足状态。每个场景只启用对应规则，按 Key 操作下单入口，核对请求命中、页面提示和资产变化，记录各场景结果。

> 按当前项目的 WS 协议向 App 注入一条资产更新事件，验证资产组件变化；再通过真实连接发送指定订阅 topic 和 data，核对实际发出的消息及业务响应。

Agent 可通过 `hot_reload` 保留页面状态应用源码变更，或通过 `hot_restart` 重置内存并重新执行应用入口。修改 Mock 后先调用 `reload_rules`，再按场景热重启并检查新请求与 UI；启动首请求可能早于 Mock 重新注入。两个工具仅控制当前 VM 绑定的 IDE Flutter Debug 会话。

`get_usage_guide` 不需要在线插件会话；其他操作需要相应的插件会话，Flutter 结构、VM 截图和热更新需要可用的 Debug VM；原生与系统操作需要设备自动化通道。能力按实际平台及动作报告。工具参数、配置范围、使用限制和验收范围见 [MCP 使用说明](docs/mcp.md) 与 [验收记录](docs/validation.md)。

## 环境要求与兼容范围

| 项目 | 要求或说明 |
| --- | --- |
| 开发电脑 | macOS；提供 Apple Silicon 和 Intel 引擎下载包，Intel 实际运行尚未验收 |
| IDE | VS Code 扩展 API `^1.96.0` 或兼容的 Cursor 桌面版；需要受信任的本地文件夹 |
| Flutter 网络库 | Dio 5 的默认原生 `IOHttpClientAdapter`；Retrofit 等封装需接入实际使用的 Dio 实例 |
| Android USB | Android SDK Platform Tools、USB 调试和设备授权 |
| iOS 模拟器 | Xcode、对应模拟器运行时及可用的 `xcrun` |
| iOS 真机 | 设备与电脑网络互通；运行示例需自行配置 Apple 开发团队 |
| VM 模式 | 可访问的 Flutter VM Service WS，运行时注入限 Debug / JIT；无需引擎或 CA |
| 首次引擎安装 | 仅代理模式需要；能访问 mitmproxy 官方下载站，也可指定本地兼容 mitmdump |
| 插件运行 | 不要求安装 Node.js 或 Python；独立引擎缺少 sqlite3 模块时使用 macOS 自带 SQLite |
| MCP Agent 接入 | 需要本机 Node.js 20+，以及已加载 MCP 配置的目标客户端；默认项目范围 |
| 源码开发 | Node.js 22.12+、npm；Python 测试需要 Python 3.9+；Flutter 示例要求 Dart `>=3.5.0 <4.0.0` |

首版不覆盖 Windows / Linux、Flutter Web、Remote SSH、Dev Containers、浏览器版 IDE，或所有自定义网络适配器。VS Code 与 Cursor 可读取同一项目目录中的配置和规则，各自的请求历史、API 目录与 CA 仍保存在各 IDE 私有目录。

## 安装插件

### 从 VSIX 安装

1. 获取 `flutter-pilot-0.0.14.vsix`。从源码构建见下方步骤。
2. 在 VS Code 或 Cursor 扩展面板右上角菜单选择 **Install from VSIX… / 从 VSIX 安装…**。
3. 选择安装包，按 IDE 提示重新加载窗口。
4. 打开包含 `pubspec.yaml` 的 Flutter 项目根目录，并信任工作区。
5. 执行 **Flutter Pilot: 打开工作台**。扩展激活后，也可点击状态栏 **Flutter Pilot**。
6. 默认进入推荐的 **VM 连接**，输入本次 Flutter VM WS 后点击 **连接并记录**。只有需要备用方案时才切换到 **代理连接**，安装 / 初始化引擎并按向导接入。新工作区即使已有引擎缓存，也不会自动启动代理。

安装当前 Flutter Pilot 包，例如：

```sh
cursor --install-extension artifacts/flutter-pilot-0.0.14.vsix --force
# VS Code 使用 code --install-extension 同一文件 --force
```

命令在仓库根目录执行，并要求对应 IDE 的 CLI 可用。安装后执行 **Developer: Reload Window / 重新加载窗口**。

插件显示名称为 **Flutter Pilot**，扩展 ID 为 `flutter-pilot.flutter-pilot`。重新加载后通过命令面板搜索 **Flutter Pilot: 打开工作台**，或点击状态栏 **Flutter Pilot**。也可点击活动栏的 **Flutter Pilot** 图标，在侧栏点击 **打开工作台**。如果图标藏在活动栏的“更多”列表中，找到 **Flutter Pilot** 并点击图钉固定；固定状态与位置由 IDE 保存。

打开项目或工作台不会静默下载引擎。以下自动启动说明仅适用于代理模式：已安装或显式配置兼容引擎后，默认在受信任的本地 Flutter 工作区打开时自动启动，无需打开面板。首次仍需完成引擎安装、设备连接及 Flutter 接入；未经过代理的请求无法被记录。

`flutterPilot.autoStart` 默认为 `true`。关闭它后，仍可手动启动；本次 IDE 会话中手动停止后，重新打开工作台不会自动恢复，重新打开 IDE / 工作区后则按设置再次自动启动。多根工作区为各 Flutter 文件夹维护独立会话，打开工作台时选择要查看的工作区。Dart workspace 根目录也支持自动识别显式列出的 Flutter 成员，共用根目录会话；最多检查 256 个成员，不递归扫描或展开 glob。

### 从源码构建安装包

在仓库根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run package
```

产物为 `artifacts/flutter-pilot-0.0.14.vsix`。打包命令自动执行构建，不会发布到商店。`artifacts/` 和 `dist/` 是忽略的生成目录，不随 Git 提交。

### 使用已有引擎

工作台点击 **选择本地引擎** 打开设置，将 `flutterPilot.enginePath` 设为 **mitmdump 可执行文件的绝对路径**，然后重新初始化。该按钮打开设置，不是文件选择器。

自动下载固定为 **mitmproxy 12.3.1**，按架构验证 [引擎清单](resources/engine-manifest.json) 中的 SHA-256。已有引擎目前检查是否属于 **12.x**；完整验收基于 12.3.1，建议使用相同版本。不要只复制 macOS 独立包内的单个 mitmdump 文件，应保留完整应用包结构。

## 升级现有项目

本次更名采用直接切换：插件 ID 为 `flutter-pilot.flutter-pilot`，命令和设置前缀为 `flutterPilot`，MCP 服务名为 `flutter-pilot`，项目目录为 `.flutter-pilot/`。新插件不会读取或自动迁移旧名称下的设置、项目配置、规则、本机历史及 MCP 适配。

1. 保存文件并结束旧插件的调试连接，停用或卸载旧插件，避免两个插件同时接管应用。更换扩展 ID 后，安装新包不会覆盖旧扩展。
2. 安装 Flutter Pilot VSIX，在方便时重新加载 IDE 窗口，然后执行 **Flutter Pilot: 打开工作台**。
3. 在新建的 `.flutter-pilot/` 中重新配置项目和规则，并按需设置 `flutterPilot.*`。默认使用 VM；重新连接后自动恢复已激活场景，也可按需开启采集。
4. 使用 MCP 时，在工作台重新执行目标 Agent 的 **一键适配**，加载新服务 `flutter-pilot`，并在客户端移除旧服务配置。改名不会自动修改已有真实 Agent 配置。
5. 代理接入需要使用新 helper 和 `FLUTTER_PILOT_PROXY` 参数重新配置。旧 helper 应在原插件中先撤销，或由项目自行恢复后再接入；VM 路线无需 helper。

后续 Flutter Pilot 版本升级会继续读取 `.flutter-pilot/`。外部修改规则后，先保存文件，再点击 **读取项目文件**。接入方式切换和插件升级是独立操作；由代理切换到 VM 时，先移除代理启动参数并重新运行应用。

## VM 快速上手：无需修改 Flutter 源码

1. 在 Cursor / VS Code 中用原有入口以 **Debug** 启动或附加 Flutter 应用，插件自动发现本项目的调试会话。外部终端独立运行时，先在 IDE 附加调试，或手动提供 VM Service 的 `ws://…/ws` 地址。
2. 打开 **Flutter Pilot: 打开工作台 → 连接与诊断 → VM 连接**。只有一个可用会话时自动连接并后台记录，多个时选择会话。手动地址入口保留，认证地址仅在内存中使用。
3. 在应用内触发请求，进入 **API 与历史** 查看自动发现的 API、请求和响应。此时仅采集，不改变请求结果。
4. 需要 Mock 时，在 **Mock 场景** 中激活目标场景，等待“已接入 Dio”数量更新。尚未创建的 Dio 会周期性发现；也可点 **重新发现并同步**。新实例首次请求可能早于接入，应确认接入后再触发。
5. 在 **Mock 场景** 创建场景并添加、启用规则，再激活场景。同步成功后，再次触发接口。已有规则可复用；VM 不支持手动断点。
6. 停用场景后保留观察采集；点击 **断开连接** 停止 VM 会话。Hot Restart 后会重发现新的 Isolate；完整停止后新调试会话可再次自动连接。手动断开会暂停当前会话自动重连，需要时点击候选的 **重新连接**。

自动连接使用实时调试事件，并通过 Dart Tooling Daemon 补查已经运行的会话；旧版 Dart 扩展不支持补查时仍保留实时发现和手动入口。详见 [VM 自动发现说明](docs/vm-auto-discovery.md)。

连接中会禁用地址输入和重复提交；初始化成功后，连接卡明确显示 **已连接 · 当前端点** 和后台记录状态，隐藏连接按钮，仅保留 **断开连接**。需要换地址时先断开。断开或失败后显示未连接，不再把上一次端点显示为当前连接。

Flutter 可能把原始 VM 连接重定向到 DDS（Dart Development Service）。插件支持本机地址之间的安全跳转，连接成功后显示实际 DDS 端点；不会自动跟随跳转到外部主机。遇到跳转提示时，使用调试工具提供的最终 DDS WS 地址，不要自行拼接认证路径。

要确认 Mock 真正生效，检查 **场景已激活 → HTTP 已应用且 Dio 大于 0 → 目标规则已启用**，再在 App 中重新触发请求。最新历史应显示 `MOCK` 和命中的规则，响应正文应包含预设内容。仅打开单条规则的 switch，不会激活所属场景；App 已缓存的页面也需要重新请求接口。

**从旧代理路线切换时，先停止当前 Flutter 调试，移除 `FLUTTER_PILOT_PROXY` 启动参数，使用原启动项重新运行应用。** 再停止旧代理并连接 VM。切换界面不会撤销已有 helper，也不会改写已运行 App 的代理设置。

VM 转发发生在应用的 Dio 中，因此 `127.0.0.1` 指应用所在设备；iOS 模拟器、Android 模拟器和真机访问电脑服务的地址不同。代理模式的转发则由开发电脑执行。详细边界、可复现验证命令和故障处理见 [0.0.2 VM 使用说明](docs/v0.0.2-vm-service.md)。

## 快速上手：完成第一条 HTTPS Mock

以下是备用代理路线；常规 Flutter Debug 开发优先使用上方的 VM 快速上手。仅选择并保存代理模式的工作区会自动启动已安装的代理引擎。

本节为**代理模式**，以仓库中的 [Flutter 示例](examples/flutter/README.md) 和 Android USB 真机为例，无需真实业务接口。

1. 在终端执行 `cd examples/flutter`、`flutter pub get`，并在 IDE 中打开这个目录。
2. 打开工作台，首次初始化引擎并确认代理已运行，记下实际端口。以后打开该 Flutter 项目时默认自动启动。
3. 连接 Android 手机，开启 USB 调试并授权；在工作台 **刷新设备 → 连接 USB**。
4. 点击 **检测 Flutter 项目**，选择 `lib/main.dart` 中的 `dio`，**预览补丁 → 应用当前预览**。
5. 在 **Mock 场景** 中选择场景，点击 **直接 Mock**，填写下表后保存、启用规则并激活场景。

   | 字段 | 示例值 |
   | --- | --- |
   | 名称 | 第一条 HTTPS Mock |
   | 方法 | GET |
   | 主机 | flutter-pilot.test |
   | 路径 | /hello |
   | 状态码 | 200 |
   | Headers JSON | `{"content-type":"application/json"}` |
   | Body | `{"message":"Hello from Flutter Pilot"}` |

6. 按工作台实际地址运行。下面假设端口为 8080；有多台设备时用 `-d` 指定设备。

   ```sh
   flutter run -d YOUR_ANDROID_SERIAL --dart-define=FLUTTER_PILOT_PROXY=127.0.0.1:8080
   ```

7. 在示例中将 URL 改为 `https://flutter-pilot.test/hello`，选择 GET 并发送。
8. 应用应显示预设 JSON；工作台 **API 与历史** 出现带 `MOCK` 标记的记录。该域名无需真实存在，完整匹配的 Mock 不访问上游。

这个流程通过 helper 信任当前调试 CA，无需在设备系统中安装证书。测试结束，去掉 `--dart-define` 参数重新运行应用，再停止代理。

## Flutter 与设备接入

### 选择接入路线

| 路线 | 项目改动 | 适用情况 |
| --- | --- | --- |
| Flutter VM WS | 无源码改动；Debug/JIT 下可主动开启实验性 Dio 运行时 Mock | 调试中采集、Mock 和双向修改；无需代理证书 |
| 系统代理 + 系统 CA | 可不改源码，但依赖应用是否遵循系统代理及证书信任 | 已确认请求能经过代理的项目 |
| Dio 最小开发配置 | 新增一个 helper，并在实际 Dio 初始化位置调用一次 | 系统代理不生效、Dio 不信任系统 CA，或希望用 Android USB 接入 |

仅配置设备 Wi-Fi 代理，并不保证 Dart 请求已经进入插件。以请求历史中出现真实流量、HTTPS 没有证书错误为准。当前向导提供指导、项目检测和设备操作，HTTP / HTTPS 验证仍需在应用中实际发请求完成。

### 系统代理与证书

1. 启动代理。Wi-Fi 真机接入时开启 **允许局域网真机连接**，选择手机可访问的电脑局域网 IPv4 地址。
2. 在手机 Wi-Fi 设置中将 HTTP 代理设为手动，填写该电脑 IP 和工作台端口。
3. 点击 **打开 CA 证书位置**，将 `mitmproxy-ca-cert.pem` 公钥证书传到设备并安装。
4. iOS 需安装描述文件，再到 **设置 → 通用 → 关于本机 → 证书信任设置** 开启信任；具体菜单名称依系统版本而异。
5. Android 应用是否信任用户 CA 取决于网络栈及应用配置。仍报证书错误时使用 Dio helper，不能靠关闭 TLS 校验解决。
6. 在应用中分别验证 HTTP 和 HTTPS 请求。

插件不会静默改系统代理或系统证书。完全零代码路线尚未实际验收，证书固定或自定义校验也可能阻止 HTTPS 解密。

### Dio 接入向导

向导读取 `pubspec.yaml` 与可用的 `pubspec.lock`，识别 Dio 5，并扫描 `lib/` 中可识别的 Dio 声明。自动插入仅用于明确的异步函数直接作用域；已有适配器、证书逻辑、`HttpOverrides`、复杂初始化和 `part` 文件需要人工处理。

应用补丁通常包含：

- 新增 `lib/flutter_pilot_debug.dart`，其中只嵌入当前代理 CA 的公钥证书。
- 在选定文件中导入 helper，并在第一次请求前调用 `await configureFlutterPilot(dio)`。
- 在 `.dart_tool/flutter_pilot_setup.json` 保存撤销记录。

典型接入位置如下。helper 应由向导生成，不需要新增 Flutter SDK 依赖：

```dart
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import 'flutter_pilot_debug.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final dio = Dio();
  await configureFlutterPilot(dio);
  runApp(MyApp(dio: dio));
}
```

上面的 `MyApp` 代表项目自己的入口 Widget。接入每个实际发请求的 Dio 实例；只接入一个实例不会覆盖其他实例。

helper 同时满足以下条件才启用：**Debug 构建**，且编译时传入 `FLUTTER_PILOT_PROXY=host:port`。Profile / Release 保持原配置。参数中不加 `http://` 或路径；修改 `--dart-define` 需要停止并重新运行应用，热重载不能更新编译时参数。

实现使用 `SecurityContext(withTrustedRoots: true)` 加入当前调试 CA，保留上游证书校验，不设置无条件通过的 `badCertificateCallback`。已有自定义客户端工厂或证书回调会拒绝自动覆盖，需在项目中人工合并。

### 不同设备的地址

| 调试目标 | FLUTTER_PILOT_PROXY 中的地址 | 操作与验证状态 |
| --- | --- | --- |
| Android USB 真机 | `127.0.0.1:<端口>` | 启动代理后刷新设备、连接 USB；已实际验证 |
| Android 模拟器 | 使用插件创建 USB/ADB reverse 后填 `127.0.0.1:<端口>` | 需要设备处于已授权状态；尚未实际验收 |
| iOS 模拟器 | `127.0.0.1:<端口>` | 启动代理后运行；已实际验证 |
| Android / iOS Wi-Fi 真机 | `<电脑局域网IPv4>:<端口>` | 开启局域网监听；两端网络互通，iOS 真机路线尚未实际验收 |

`0.0.0.0` 是代理监听地址，不能作为手机连接目标。Android 模拟器使用 ADB reverse 时也不需要改成宿主机别名。USB 转发只在 Android 上提供，iOS 真机不要套用该方式。

插件只创建和清理本会话拥有的 `adb reverse`，不会覆盖冲突映射。会记住所选设备、代理端口及局域网地址；下次启动时尝试为在线且已授权的已选 Android 设备恢复转发。设备离线、未授权或端口冲突时，需连接设备后在工作台重新操作。使用系统代理时仍需单独配置手机代理，创建 reverse 本身不会让所有应用自动走代理。

### 撤销与重新接入

点击 **撤销接入** 可恢复向导记录的原文件。预览后源码变化会拒绝应用；应用后相关文件发生变化时，会整体保留并提示人工合并，避免删除仍被引用的 helper。

`.dart_tool/` 可能被 `flutter clean` 删除。需要自动撤销时应先撤销再清理；撤销记录丢失后，需要手动移除调用、导入及 helper。手动添加的初始化片段也应自行检查和移除。

不同工作区、不同 IDE 私有目录通常使用各自的 CA。切换后若证书不匹配，应重新生成对应 helper，或安装对应系统证书。不要将 CA 私钥复制进 Flutter 项目。

## 工作台使用

### 连接与诊断

提供 **VM 连接 / 代理连接** 两种方式。VM 页输入 WS、连接 / 断开、控制 HTTP 采集、重新发现并同步；Mock 在场景页统一激活和停用；代理页准备引擎、设备、CA 和接入补丁。顶部持续展示记录状态，**工作区与连接** 可查看端点、启停连接及打开设置。已连接时，调试会话与手动地址默认收起；项目配置和规则文件入口位于页面底部的折叠区域。底部诊断日志和 IDE 的 **输出 → Flutter Pilot** 可用于排查错误。

### API 请求

**API 请求** 独立展示按 **请求方法 + 主机 + 路径** 去重的 API 目录，查询参数不进入目录键。默认列表占满内容区，按最近调用时间从新到旧排列，紧凑展示方法、路径、域名、累计调用次数和最近调用时间，支持独立搜索和方法筛选。

点击 API 打开详情，查看累计调用、首次和最近调用时间，以及最近一次请求的请求、响应、修改对比和备注。新请求被采集后，已选 API 的详情自动跟随最新记录；请求历史中选中的单次记录保持固定。点击 **查看调用历史** 跳转到 **请求历史** Tab 并按该 API 筛选；浏览 API 不改变历史页已有的筛选和分页。

域名旁显示激活场景内当前启用且方法、域名、路径匹配的规则 tag，包括 **Mock、转发、修改请求、修改响应、断点**。列表显示首类规则和其余类型数量，详情展示全部类型；悬停查看规则名称与优先级。带查询参数或请求头条件的规则标为“条件”，需具体请求满足条件才可能命中。tag 表示当前规则配置，随规则启停、编辑和删除更新，不依赖历史记录；实际拦截仍需所属场景激活并完成运行时接入，并按每阶段优先级选择规则。

目录独立保存，即使对应历史过期或已清空，API 和累计次数仍会保留；此时详情提示暂无请求历史。可手动删除不再需要的目录项，该操作不删除请求历史或规则；未来同一 API 再次被当前模式采集时，会重新发现并从新的目录计数开始。旧版现存历史会在首次升级时迁移为目录，迁移只执行一次。

### 请求历史

**请求历史** 独立记录每次 HTTP 调用，按请求时间从新到旧排列。默认全宽展示方法、路径、状态码、域名、时间、耗时、Mock 和规则命中情况。宽列表使用紧凑单行，窄列表使用三行，长路径省略并可悬停查看完整 URL。

点击一条请求后打开详情，优先展示 **响应（Response）**，切换 **请求（Request）** 查看请求数据。宽窗口左右分栏，可使用 **放大 / 返回列表** 集中阅读正文；窄窗口直接展示详情，点击右上角关闭按钮回到完整列表。

顶部保留搜索和方法筛选，**清空记录** 在确认后清空当前项目全部 HTTP 历史（包含筛选外记录），保留 API 目录和 Mock 规则。点击 **筛选** 可按状态码、时间、Mock 状态或命中规则筛选，收起后保留条件并显示数量。搜索覆盖主机、路径、原始 / 目标 URL、备注和标签。详情显示原始、自动规则后、最终三阶段快照、耗时、目标 URL、规则和错误信息。

请求和响应的文本正文自动尝试解析 JSON，成功时显示缩进格式；通过 **JSON / 原文** 切换，**复制正文** 复制当前展示的内容。即使响应头不是 JSON，也会尝试解析；格式化保留长整数、高精度数字和重复键，不修改历史快照。非 JSON 会提示并显示原文；二进制保持 Base64，空正文、截断和未收到响应分别提示。超过 1 MiB 的文本或超过 4 MiB 的格式化结果回退原文。

历史事实保持不变；备注、标签可以编辑，记录可以删除或清空。要修改请求或响应内容，使用 **生成 Mock** 或 **更多规则** 创建草稿。草稿默认禁用，检查后再启用。清空历史不会删除 API 目录、规则或 CA。

### Mock 场景

一个场景独立持有一组 HTTP 和 WebSocket 规则，例如“下单成功”可包含账户接口、订单接口及订单事件 WS Mock。同一时间只激活一个场景；切换会先停用旧场景，再整体加载新场景。

场景默认以列表展示，显示激活状态及 HTTP / WebSocket 规则数量；列表开关可激活对应场景或停用当前场景，同一时间仅有一个场景激活。点击场景查看详情，关闭详情返回完整列表。宽窗口同时显示列表和详情，窄窗口优先显示详情。场景支持新建、重命名、复制、删除、激活和停用。浏览与编辑场景不会激活它；修改未激活场景不影响运行时，修改激活场景后立即同步。每个场景内分 HTTP / WebSocket 两组，规则各有独立的启停开关，也支持编辑、复制及排序；HTTP 支持直接 Mock、请求/响应修改、转发与代理断点。生成规则时可选择目标场景，默认当前浏览场景，其次激活场景，最后默认场景。

激活会保存选择并开启所需协议的采集和 Mock；关闭采集暂停该域 Mock，重新开启采集恢复。停用场景关闭两域 Mock，保留采集；删除激活场景也会停用。重连或重开 IDE 后自动恢复已激活场景，不改变 VM 自动连接设置。显示分域待应用、已应用、失败、不支持和暂停状态；没有 Dio 实例或目标 WS 连接不能表示已应用，实际命中仍须查看新记录。同步失败不恢复旧场景，旧租约可能需要最多约 16 秒等待。

首次升级将当前 `.flutter-pilot/rules.json` 与 `ws-rules.json` 一次性归入“默认场景”，保留规则 ID、顺序和启停，默认不激活；新项目创建空默认场景。生成 `scenes.json` 后旧文件保留但不再读取或更新。文件无效或被外部修改时拒绝覆盖，修复后使用 **读取项目文件**。

复制场景重新生成场景与规则 ID，保留启停状态且不自动激活；复制单条规则仍默认禁用。导入使用场景格式，重新生成 ID 后追加，保留启停状态并保持当前激活场景。导出整份场景配置，不含历史或 CA。持久 WS 使用 URL；当前连接的临时规则仅属于激活场景，连接失效或切换场景时清除。WS 手动推送继续在 WebSocket 页面操作，不提供自动推送、定时或重放。代理模式仅支持 HTTP，混合场景的 WS 显示不支持。

### 断点队列

**仅代理模式支持手动断点；VM 模式会明确提示不支持。** 请求和响应阶段可独立暂停，命中后进入队列。每个条目显示倒计时、原始数据和自动规则处理后的当前数据，可直接放行、编辑后放行或终止请求。

默认 60 秒，可设置 10–300 秒；超时按当前自动结果放行，未提交的编辑不会应用。客户端网络超时可能更短，需在应用调试配置中合理设置。关闭工作台、停止代理或控制连接中断时，会释放等待断点；客户端取消后断点会失效。关闭面板后，后台继续运行自动规则和历史记录，但不再因人工断点规则暂停新请求；重新打开面板后恢复交互式断点。

## 规则格式与执行顺序

场景文件和导入结构为 `{"version":1,"activeSceneId":null,"scenes":[{"id":"default","name":"默认场景","httpRules":[],"wsRules":[]}]}`。最多 1000 个场景，每场景每个协议最多 1000 条规则；规则 ID 在同一协议的所有场景中唯一。HTTP 单条规则的字段如下：

| 字段 | 含义 |
| --- | --- |
| `id`、`name` | 非空 ID 和名称，ID 最长 128 字符 |
| `enabled` | 是否启用，布尔值 |
| `priority` | 整数，值越大优先级越高 |
| `match` | 匹配原始请求；空对象表示匹配所有请求 |
| `request` | 修改方法、URL、头部、查询参数或正文 |
| `redirect` | `{ "url": "/目标路径 或 完整HTTP/HTTPS URL" }` |
| `mock` | `{ "status": 200, "headers": {}, "body": "正文字符串" }` |
| `response` | 修改状态码、头部或正文 |
| `breakpoint` | 选择请求 / 响应阶段及可选等待秒数 |

每条规则至少包含一个动作；`mock` 与 `redirect` 不能同时存在。状态码为 200–599。未知字段会在插件侧拒绝保存或导入。

### 匹配条件

- `method`：忽略大小写；省略、空字符串或 `*` 表示任意方法。
- `host`：不含协议、端口和路径的主机名，忽略大小写、精确匹配；省略、空字符串或 `*` 表示任意主机。
- `path`：只匹配 URL 路径，区分大小写，支持 glob，例如 `/v1/orders/*`；不是正则表达式。省略或空字符串表示任意路径。
- `query`：键值均为字符串，所有指定条件都需满足；重复参数中存在指定值即可匹配，未指定参数不限制。
- `headers`：头部名称忽略大小写，值按字符串匹配；所有指定条件都需满足。

正文不参与匹配；JSON 字段条件、正则、延迟和故障注入不属于当前规则能力。

### 执行顺序

下图为代理模式完整顺序；VM 模式沿用自动规则阶段，不执行人工断点。

```text
原始请求
  → 请求阶段最高优先级的首条规则（request / redirect / mock）
  → 请求断点，人工编辑后放行
  → 访问上游，或使用本地 Mock 响应
  → 响应阶段最高优先级的首条规则（response）
  → 响应断点，人工编辑后放行
  → 应用收到最终响应
```

每个阶段独立选择规则，但始终根据**原始请求**匹配。优先级相同按列表顺序，断点也独立选取首条匹配规则。多条请求修改规则不会依次叠加；需要同时改多个字段时放入同一规则。

### 修改与转发语义

- `body` 必须是字符串。JSON 正文先序列化，例如 `"body":"{\"ok\":true}"`；不是 JSON Merge Patch。
- 省略 `body` 保留原正文，空字符串表示清空；表单的 **替换正文** 开关控制这一点。
- `request.headers`、`request.query`、`response.headers` 中字符串值表示设置，`null` 表示删除，未列出的键保留。
- `redirect.url` 支持 `/path` 或完整 HTTP/HTTPS URL。仅路径时保留原协议、域名、端口和查询参数；路径带 `?` 时替换查询参数（末尾 `?` 表示清空）。完整 URL 替换整个地址，不继承原查询参数。
- `redirect` 保留 `Authorization`、`Cookie`、`Proxy-Authorization` 等请求头，跨站时 Host 随目标更新。同一规则的 `request.headers` 仍可显式修改请求头。
- `request.url` 仍为完整地址替换，跨 origin 默认移除上述凭证头。同一规则同时存在时，以 `redirect.url` 为目标，再应用 `request.query`。
- 转发保留请求方法和正文，不向应用生成额外的 301 / 302。
- 本地 Mock 响应仍经过响应规则，代理模式还支持响应断点；修改 4xx / 5xx 状态会影响 Dio 最终按成功还是错误交付，具体也取决于应用的 `validateStatus` 配置。

## 完整规则示例

以下文件可直接导入，包含本地 Mock、请求 / 响应组合修改、地址转发和双向断点。导入保留启停状态，不自动激活。

```json
{
  "version": 1,
  "activeSceneId": null,
  "scenes": [
    {
      "id": "example-scene",
      "name": "示例场景",
      "httpRules": [
        {
          "id": "orders-empty",
          "name": "订单列表：空数据",
          "enabled": false,
          "priority": 20,
          "match": {
            "method": "GET",
            "host": "api.example.com",
            "path": "/v1/orders",
            "query": {
              "scene": "empty"
            }
          },
          "mock": {
            "status": 200,
            "headers": {
              "content-type": "application/json"
            },
            "body": "{\"data\":[],\"total\":0}"
          }
        },
        {
          "id": "orders-modify",
          "name": "订单查询：修改参数与响应",
          "enabled": false,
          "priority": 10,
          "match": {
            "method": "GET",
            "host": "api.example.com",
            "path": "/v1/orders",
            "headers": {
              "x-debug-scene": "modify"
            }
          },
          "request": {
            "headers": {
              "x-debug": "true",
              "x-old-debug": null
            },
            "query": {
              "page": "2",
              "debug": null
            }
          },
          "response": {
            "status": 200,
            "headers": {
              "content-type": "application/json",
              "x-mocked": "true"
            },
            "body": "{\"data\":[{\"id\":1001,\"state\":\"paid\"}]}"
          }
        },
        {
          "id": "orders-local",
          "name": "创建订单：转发到开发电脑",
          "enabled": false,
          "priority": 10,
          "match": {
            "method": "POST",
            "host": "api.example.com",
            "path": "/v1/orders"
          },
          "redirect": {
            "url": "http://127.0.0.1:3000/v1/orders"
          },
          "request": {
            "headers": {
              "x-debug-source": "flutter-pilot"
            }
          }
        },
        {
          "id": "orders-breakpoint",
          "name": "订单详情：双向断点",
          "enabled": false,
          "priority": 10,
          "match": {
            "method": "GET",
            "host": "api.example.com",
            "path": "/v1/orders/*"
          },
          "breakpoint": {
            "request": true,
            "response": true,
            "timeout": 60
          }
        }
      ],
      "wsRules": []
    }
  ]
}
```

代理模式转发由开发电脑上的代理引擎执行，因此目标中的 `127.0.0.1:3000` 指开发电脑本机服务；VM 模式转发由 App 的 Dio 执行，`127.0.0.1` 指应用所在设备。它与手机访问代理时使用的 `FLUTTER_PILOT_PROXY` 地址是两个不同的配置。

仓库还提供可导入的最小示例 [example.scenes.json](resources/example.scenes.json)。从历史生成规则草稿也能避免手动填写方法、主机和路径。

## 配置参考

项目配置优先保存在下述 `.flutter-pilot/project.json`；没有指定的设置使用 IDE 工作区 / 用户设置。可在 IDE 设置中搜索 `Flutter Pilot`。外部修改后点击工作台的 **读取项目文件**，规则校验后同步；接入方式和采集参数在重新加载 IDE 窗口后生效，仅关闭工作台不会重启后台会话。

| 设置 | 默认值 | 有效范围与说明 |
| --- | --- | --- |
| `flutterPilot.autoStart` | `true` | 仅已选择代理模式时，随受信任的本地 Flutter 工作区启动已安装 / 配置的引擎 |
| `flutterPilot.autoConnectVm` | `true` | VM 模式自动发现 Flutter Debug 会话；唯一会话自动连接并记录 HTTP，多个会话由用户选择 |
| `flutterPilot.enginePath` | `""` | 本地 mitmdump 绝对路径；留空使用插件管理的引擎 |
| `flutterPilot.proxyPort` | `8080` | 1024–65535；初始端口占用时选择其他可用端口 |
| `flutterPilot.retentionDays` | `7` | 1–365 天 |
| `flutterPilot.maxRecords` | `10000` | 1–100000 条历史 |
| `flutterPilot.maxBodyBytes` | `1048576` | 1024–10485760 字节；代理 / VM 观察的本地正文保存上限；VM 注入另有 256 KiB 上限 |
| `flutterPilot.breakpointTimeout` | `60` | 10–300 秒；规则内可单独设置 |

```json
{
  "flutterPilot.autoStart": true,
  "flutterPilot.autoConnectVm": true,
  "flutterPilot.enginePath": "",
  "flutterPilot.proxyPort": 8080,
  "flutterPilot.retentionDays": 7,
  "flutterPilot.maxRecords": 10000,
  "flutterPilot.maxBodyBytes": 1048576,
  "flutterPilot.breakpointTimeout": 60
}
```

端口始终以工作台实际显示为准；端口变化后要同步更新设备代理和 Flutter 启动参数。局域网监听通过工作台开关控制，首次默认关闭，已选择的连接信息会保留供下次启动恢复；管理通道始终只监听本机。

命令面板入口：

| 命令 ID | 显示名称 |
| --- | --- |
| `flutterPilot.open` | Flutter Pilot: 打开工作台 |
| `flutterPilot.start` | Flutter Pilot: 启动代理 |
| `flutterPilot.stop` | Flutter Pilot: 停止代理 |

## 项目绑定与配置文件

插件绑定 Cursor / VS Code 当前选中的项目根目录，首次初始化生成项目 UUID，保存在 `.flutter-pilot/project.json`，以后读取并复用。配置和 Mock 规则随项目文件保存，运行时采集数据留在 IDE 私有目录。

连接页的项目绑定卡显示项目名称与 UUID，提供 **项目配置**、**规则文件** 入口和 **读取项目文件** 操作。手动编辑规则后先读取，再在工作台继续修改；若磁盘文件已变化，插件会阻止使用未更新的工作台状态覆盖它。修改 UUID、接入方式或采集参数后按提示重新加载窗口，当前连接不会被读取操作强制中断。

```text
项目根目录/
└── .flutter-pilot/
    ├── project.json              # 项目 UUID、格式版本、接入方式和项目设置
    └── scenes.json               # 场景及持久激活状态，统一包含 HTTP / WS 规则
```

`project.json` 示例（UUID 由插件生成，下面仅演示结构）：

```json
{
  "version": 1,
  "projectId": "edb038d8-0a2a-4b1f-a974-d39e1a5af278",
  "name": "commerce_app",
  "connection": {
    "mode": "vm"
  },
  "settings": {
    "autoStart": true,
    "retentionDays": 7,
    "maxRecords": 10000,
    "maxBodyBytes": 1048576,
    "breakpointTimeout": 60
  }
}
```

`settings` 可省略；其中字段使用不带 `flutterPilot.` 前缀的名称，优先于对应 IDE 设置。引擎路径仍使用本机 IDE 的 `flutterPilot.enginePath`。`scenes.json` 与导入 / 导出使用相同场景结构；工作台增删改、复制、启停和排序都会保存到当前目录的规则文件。

| 修改内容 | 生效方式 |
| --- | --- |
| 工作台编辑规则 | 保存到项目文件，并同步运行中的会话；以同步结果为准 |
| 外部编辑 `scenes.json` | 保存文件后点击 **读取项目文件**，校验并同步 |
| 外部编辑项目名称 | 保存后点击 **读取项目文件**，更新项目显示名称 |
| 外部编辑接入方式、端口、采集参数 | 保存后重新加载窗口；当前会话继续使用启动时的配置 |
| 修改 `projectId` | 重新加载窗口建立新绑定；当前会话拒绝直接切换 UUID |

如果规则文件已被外部修改，工作台会提示先读取，避免旧内存内容覆盖磁盘。非法 JSON、未知版本或无效字段需要先修复，插件不会用默认文件覆盖；读取操作不会自动保存尚未保存的编辑器内容。

同一项目复制到另一目录、创建 Git worktree 或重新克隆时，如果文件中保留相同 UUID，各目录仍分别记录历史、API 目录和后台会话；规则从各自目录读取，互不覆盖。移动项目时 UUID 可以保留，但新路径不自动接续旧路径的请求历史。多根工作区以所选文件夹为绑定根；Dart workspace 仍以打开的根目录维护会话。

更名前的配置和规则不会自动导入；请在 `.flutter-pilot/` 中重新配置。是否将该目录纳入 Git 由项目自行决定，插件不会自动暂存或提交这些文件。字段和读取方式见 [项目绑定说明](docs/project-binding.md)。

## 数据存储与隐私

项目配置和规则保存在项目 `.flutter-pilot/` 中。API 目录、请求历史、CA 以及设备相关的本机连接信息保存在 IDE 的 `globalStorage` 中，按项目身份与实际工作区目录隔离。VM WS 只保存在当前会话内存，不写入项目配置或本机连接文件。

```text
<IDE globalStorage>/flutter-pilot.flutter-pilot/
├── engines/<版本>-<架构>/
└── projects/<项目 UUID>/<工作区 URI 哈希>/
    ├── history.sqlite3           # 代理历史和 API 目录
    ├── vm-history.sqlite3        # VM 历史和 API 目录
    ├── connection.json           # 当前目录的本机连接记录
    └── ca/                       # 当前目录的 CA 公钥与私钥
```

macOS 默认 VS Code 用户数据下通常为 `~/Library/Application Support/Code/User/globalStorage/`，Cursor 通常为对应的 `Cursor/User/globalStorage/`；自定义用户目录会改变实际位置。

- 默认保留最近 7 天、最多 10000 条请求历史；超期 / 超量记录会清理。API 目录独立保存，不随这些保留策略删除，需手动删除不再需要的目录项。单正文默认保存 1 MiB，超限标记截断，不截断真实转发数据。
- VM WS 含调试访问凭据，仅保存在当前会话内存；输入框提交后清空，状态仅显示 host。不要公开 VM Service 或分享认证地址。
- VM SDK profiling 还会在 App 内保存采集缓存；本地 SQLite 的条数 / 时间限制不等于 App 缓存上限。长时间大量采集有额外内存开销，使用后及时断开。插件恢复自己改变的 profiling 开关，不清空其他 DevTools 的网络数据。异常断线时无法立即恢复开关，会给出警告；同一应用重连后再正常断开可重试恢复，IDE 崩溃或身份无法确认时请 Hot Restart。
- 请求详情包含头部和正文，可能包含业务数据与凭证；首版没有通用的自动脱敏开关。仅抓取开发调试流量，分享前检查数据。
- 规则导出不含历史或 CA，但规则中显式填写的凭证仍会导出。
- 数据在本地持久化，不提供云端同步。首次安装引擎需要联网，真实上游请求仍按规则访问对应服务。
- CA 私钥只保存在插件私有目录；helper 包含的是 CA 公钥证书，不能将私钥放入项目或共享规则。
- 引擎运行时不要直接删除私有数据库或 CA 文件。备份或手动清理前先退出 IDE，或移除对应工作区以确保后台引擎退出；仅关闭工作台不会关闭引擎。换 CA 后需要重新配置相关信任。

撤销接入记录单独位于 Flutter 项目的 `.dart_tool/flutter_pilot_setup.json`，与历史数据库不是同一个文件。

## 停止代理与恢复联网

| 操作 | 结果 |
| --- | --- |
| 停用场景 / 断开 VM | 正常操作尽量立即卸载本插件拦截器；异常断连依赖最长约 15 秒租约到期后旁路，已发出的请求改写无法撤回 |
| 停止代理 | 关闭流量监听、释放等待断点并尝试清理本会话 Android 转发；引擎管理通道和历史查询保留 |
| 关闭工作台 | 关闭界面；VM 连接 / Mock 或后台代理继续记录，代理人工断点释放并停用 |
| 退出 IDE / 移除 Flutter 工作区 | 断开 VM 或退出后台引擎，释放断点并清理本会话转发；规则、API 目录和历史保留 |
| 撤销接入 | 恢复向导记录的项目补丁；不会替你移除手机系统代理或证书 |

使用 helper 时，去掉 `--dart-define=FLUTTER_PILOT_PROXY=...` 并停止、重新运行应用，即可恢复直接联网。已创建的 `HttpClient` 不会在 IDE 停止代理后自动切换为直连。

使用系统代理时，在设备 Wi-Fi 设置中恢复 **无代理 / 关闭**，按需移除调试 CA。引擎崩溃或 IDE 关闭后，如果客户端仍指向代理，可能暂时无法联网，按上述步骤恢复。

设备离线导致转发清理失败时，重新连接设备后按诊断日志移除对应端口：

```sh
adb -s YOUR_ANDROID_SERIAL reverse --remove tcp:8080
```

使用日志中的实际端口，避免移除其他工具的转发。

## 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 找不到命令 | 确认 VSIX 安装在当前 IDE、本地受信任工作区已打开，必要时重新加载窗口 |
| 下载失败 / 校验失败 | 检查能否访问官方站点后重试；也可在设置中指定完整包中的 12.3.1 mitmdump 绝对路径 |
| 找不到 Flutter 项目 | 打开包含 `pubspec.yaml` 的包根目录；monorepo 中应选择真正创建 Dio 的包 |
| 没发现 Dio 初始化位置 | 确认直接依赖 Dio 5、实际声明位于 `lib/`；工厂、生成代码或复杂结构按手动片段接入 |
| 预览后不能应用 | 保存相关文件并重新检测；已有 helper、自定义网络配置或源码变化会触发保护 |
| 未自动启动 | VM 检查项目 / IDE 的 `autoConnectVm`，确认在本地 IDE 内启动或附加 Flutter Debug；多个会话需选择，手动断开后需点击重新连接。DTD 不可用时重新启动调试或手动填写地址；代理模式检查 `autoStart`、工作区信任及可用引擎 |
| VM 连接失败 | 按具体提示区分端口未监听、超时、认证路径失效或初始化失败；使用本次 Debug 的完整 WS，不要填 DevTools 网页地址。App 重新运行后端口和认证路径可能变化，不能只替换旧地址的端口 |
| VM 记录正常但 Mock 不生效 | 激活目标场景，检查 HTTP 分域状态、已接入 Dio 数和规则同步状态；新实例可重新发现，不支持所有自定义拦截链 |
| VM 意外断开后暂不能启用 Mock | 可先重连观察，等待最长约 16 秒冷却，确保旧 15 秒租约已到期；正常显式关闭 / 断开且卸载成功时不受该冷却限制 |
| 无请求历史 | VM 确认已连接当前 Debug App，并重新触发请求；代理确认已运行、应用使用已接入的 Dio、启动参数地址正确，Android reverse 和设备网络可用。只打开插件不会自动接管全部网络 |
| HTTPS 握手失败 | helper 是否对应当前工作区 CA；系统代理路线是否信任当前证书；是否有证书固定或自定义校验 |
| 手机连不上电脑 | 不要使用 `0.0.0.0` 作目标；Wi-Fi 路线开启局域网监听，检查 IP、网络隔离和防火墙；Android USB 检查授权 |
| 规则没有命中 | 检查启停、方法、主机和原始路径；主机不填协议或端口，查询参数另填；检查更高优先级规则 |
| 规则已保存但未生效 | 查看激活场景及分域状态；VM 检查已接入 Dio 数并重新发现 / 同步，代理初始化 / 重启引擎后同步 |
| 只改请求头后正文不对 | 确认未开启“替换正文”；空字符串正文会清空内容 |
| 断点提前消失 | 应用自己的超时或取消可能早于插件倒计时；也检查是否停止代理、关闭面板或控制断连 |
| 转发后鉴权失败 | redirect 保留鉴权头；若鉴权签名包含原路径或域名，需由业务侧按目标重新签名 |
| 撤销提示保留文件 | 接入后源码已被修改，需人工合并；若 `.dart_tool` 记录被清理也要手动移除接入 |
| 停止后应用无法联网 | 去掉启动参数并重启应用，或移除设备系统代理，已创建客户端不会自动恢复直连 |
| API 目录有条目但没有请求历史 | 目录独立保留，对应历史可能已过期或清空；再次请求后会出现新记录 |
| 删除的 API 后来又出现 | 同一 API 被再次调用后会自动重新发现，删除目录不禁用采集 |
| 重启后历史看不到 | 确认同一 IDE、项目 UUID、目录和接入模式，检查保留策略；复制或移动目录不会共享旧路径历史。VM 历史不需初始化引擎，代理历史需对应引擎可用 |
| 找不到 `.flutter-pilot/` | 确认当前工作区受信任、目录可写且插件已初始化；升级后重新加载窗口，再打开工作台查看项目绑定卡或输出日志 |
| 提示项目规则文件已被修改 | 保存外部编辑，点击 **连接与诊断 → 读取项目文件**，再继续在工作台编辑 |
| 修改项目配置后没有变化 | 规则和名称可重新读取；接入方式及采集参数需重新加载窗口，UUID 改动也需建立新会话 |

请提供 IDE / macOS / Flutter / Dio 版本、设备类型、接入路线、复现步骤及脱敏日志。不要把 CA 私钥或真实业务凭证放入问题报告。

## 开发、测试与打包

### 本地开发

在仓库根目录安装依赖并构建：

```sh
npm ci
npm run typecheck
npm test
npm run build
```

迭代时执行 `npm run watch`。可通过 IDE 的扩展开发宿主加载该仓库，也可重新打包 VSIX 安装。构建使用 esbuild，扩展运行时依赖已打入 `dist/`，不需要用户在 IDE 中运行 npm。

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 扩展和 Webview 的 TypeScript 类型检查 |
| `npm test` | Vitest 单测与扩展整合回归 |
| `npm run format:check` | 检查 TypeScript / CSS / 构建脚本格式 |
| `npm run build` / `npm run watch` | 一次构建 / 持续构建 |
| `npm run test:ui` | 以构建产物运行 Playwright 工作台测试 |
| `npm run test:proxy` | Python 单测；设置 MITMDUMP 后同时执行真实代理集成 |
| `npm run test:ide` | 代理模式实际 IDE 扩展宿主 smoke；需设置引擎路径 |
| `npm run test:vm` | 真实 Dart VM + Dio 运行时注入集成 |
| `npm run test:vm:flutter` | 真实 Flutter iOS 模拟器零源码 VM 采集 / Mock；设置 VM_FLUTTER_DEVICE |
| `npm run test:ide:vm` | 无代理引擎的真实 IDE VM 消息链路 smoke |
| `npm run package` | 构建并生成 VSIX，不发布 |

### 工作台与真实代理测试

UI 测试使用本机 Google Chrome，修改浏览器选择见 `playwright.config.ts`。应先构建，测试服务器只在本机启动：

```sh
npm run build
npm run test:ui
```

代理集成测试使用 Python 测试驱动，并启动真实独立引擎：

```sh
MITMDUMP=/absolute/path/to/mitmdump npm run test:proxy
FLUTTER_PILOT_SQLITE_CLI=1 python3 -m unittest discover -s tests/proxy -p test_storage.py -v
```

不设置 `MITMDUMP` 时，真实集成测试会跳过，不能把跳过计为通过。Python 是源码测试驱动的要求，安装后的插件运行不依赖用户 Python。

### IDE 与 Flutter 设备验收

IDE 测试脚本使用 `/Applications` 下的 VS Code / Cursor，运行独立临时用户目录，测试端口为 18080；执行前需构建：

```sh
npm run build
FLUTTER_PILOT_TEST_ENGINE=/absolute/path/to/mitmdump npm run test:ide
FLUTTER_PILOT_TEST_ENGINE=/absolute/path/to/mitmdump FLUTTER_PILOT_TEST_IDE=cursor npm run test:ide
```

可用 `FLUTTER_PILOT_TEST_EXTENSION_PATH` 指向解压 VSIX 中的 `extension/`，验证打包产物。测试宿主会实际打开 IDE 窗口。

Flutter 示例检查：

```sh
cd examples/flutter
flutter pub get
flutter analyze
flutter test
```

设备 smoke 需要仓库 npm 依赖、Flutter、已启动的 iOS 模拟器或已授权 Android 设备，示例不能已有未撤销的接入补丁：

```sh
python3 tool/device_smoke.py --mitmdump /absolute/path/to/mitmdump --android YOUR_ANDROID_SERIAL
python3 tool/device_smoke.py --mitmdump /absolute/path/to/mitmdump --ios YOUR_SIMULATOR_UDID
```

两个设备参数也可一起使用。脚本会安装并运行测试示例，临时生成 helper；完成后撤销自身补丁、清理本会话转发及引擎，不安装系统 CA。详情与日志位置见 [示例说明](examples/flutter/README.md)。

### 构建可分发安装包

```sh
npm run package
shasum -a 256 artifacts/flutter-pilot-0.0.14.vsix
```

VSIX 包含扩展构建产物、VM 注入模板、代理 addon、引擎清单及文档，不包含 Node 开发依赖、Flutter 示例构建结果或真实证书。首次引擎下载单独发生。源码中的 README 修改后，应重新打包，安装包内的文档才会更新。

## 架构与目录

```text
VS Code / Cursor
  React 工作台 ← Webview 消息 → TypeScript 扩展
                                   │
                          本机 TCP JSONL v1 + 会话令牌
                                   │
Flutter Dio → HTTP/HTTPS 代理 → mitmdump + Python addon → 目标服务
                                   │
                       SQLite API 目录与历史 / CA
```

VM 模式由 TypeScript 扩展通过 VM Service JSON-RPC 读取 SDK HTTP profiling，或在用户激活含 HTTP 规则的场景后给已有 Dio 安装运行时拦截器。共用规则文件，SQLite 单独保存 VM 历史；不写 App 源码，不接管 TLS。

代理模式的 Flutter 业务流量与管理通道分离；每个 Flutter 工作区拥有独立后台会话，工作台只连接并查看选定会话。扩展管理引擎进程、下载、规则文件及设备接入，addon 执行网络修改与断点，并通过 SQLite 分别保存 API 目录和请求历史。详情按需读取，避免列表反复传输完整正文。

```text
src/                  # 扩展入口、引擎管理、规则模型、Dio 接入与设备工具
src/vm/               # VM RPC、profiling、运行时注入、会话与 SQLite 存储
webview/              # React 工作台与主题样式
proxy/                # mitmproxy addon、规则执行、SQLite 及 CLI 后备
resources/            # 固定引擎版本/校验清单、示例规则与 VM Dart 注入模板
scripts/              # 构建、工作台测试服务器、IDE 测试驱动
tests/                # TypeScript、Python、UI 和扩展宿主测试
examples/flutter/     # Android/iOS Dio 示例与设备 smoke
docs/validation.md    # 实际验收记录与未验证项
.harness/momory/      # 已确认需求、工程记忆和实现经验
```

管理协议、RPC 和正文处理限制见 [代理说明](proxy/README.md)。首版没有独立 Dart SDK、HTTP 对外管理 API 或云端服务。

## 已知限制与验证状态

### 正文处理

下表为代理模式。VM 注入模式只编辑受支持的 JSON / 文本，单正文上限 256 KiB；上传、流和二进制不主动读取。VM 数据为 Dio 层快照，不是原始 wire 数据。

| 内容 | 首版处理 |
| --- | --- |
| 上限内 JSON / 文本 | 可查看和完整替换 |
| 上限内 gzip / deflate | 支持有界解码和正文编辑 |
| 上传文件、multipart、二进制 | 正文只读直通 |
| SSE、chunked、无长度流 | 正文只读直通，不为编辑等待完整流 |
| 超过记录上限 | 只保存前缀并标记截断，真实数据直通 |
| br / zstd 压缩 | 正文只读直通 |

只读正文仍可按规则修改地址或头部；应避免手动设置与正文不一致的长度或编码头。极端正文转义导致管理帧超限时，详情会明确报错，断点直接放行。

证书固定、自定义适配器、应用签名、缓存与重试可能影响代理结果。网络层修改不能自动重签业务报文。首版不保证捕获原生插件和其他网络库的全部流量，也不提供请求重放、规则版本历史或任意脚本能力。

### 已验收与未验收

截至 2026-11-08，当前代码回归通过 **174 项 Vitest、24 项 Playwright**，类型检查、格式检查和构建通过。项目文件、UUID/目录隔离、旧数据迁移、外部规则防覆盖，以及 switch 和窄面板交互已有自动化覆盖；最新 VSIX 解包后通过 Cursor VM 隔离宿主检查，安装内容已核对与包内产物一致。IDE VM smoke 使用合成 JSON-RPC 服务，真实 Flutter 与设备结果单独列出。

0.0.2 的 VM 可行性已通过真实 Flutter iOS 模拟器验证：零源码观察采集、已有 Dio HTTPS 本地 Mock、请求 / 响应修改、503 改 200、Hot Restart 重发现及开关恢复。应用入口 SHA-256 未变，无代理、helper 或 CA。纯 Dart 集成另覆盖多 Dio、转发凭证清理、错误路径和租约旁路。最新各层测试结果见 [验收记录](docs/validation.md)，复现命令与兼容边界见 [VM 专题](docs/v0.0.2-vm-service.md)。

VM Mock 当前限 Debug / JIT，不能承诺 Profile / Release、所有 Dio 版本、自定义适配器或应用拦截器短路场景。每 Isolate 最多接入 128 个 Dio，新实例存在首次请求早于周期扫描的窗口。VM 路线尚未在 Android 及 iOS 真机实际验收，也未验证 EXIO 登录链路恢复。
代理路线历史基线已实际运行 VS Code / Cursor 扩展宿主、Android 三星 USB 真机及 iPhone 模拟器，覆盖 HTTPS Mock、转发、双向修改和真实 HTTPS 上游。arm64 引擎完整安装与运行已验证，Intel 包已验证下载内容和校验值。

以下仍标记为**未验证**：Android 模拟器、iOS 真机局域网、macOS Intel 运行、系统代理与系统 CA 的完全零代码接入，以及设备级手动断点。断点已在真实代理集成及工作台交互测试中覆盖。完整环境、覆盖场景和复现命令见 [验收记录](docs/validation.md) 与 [设备结果](examples/flutter/tool/device-validation.json)。

## 许可证与第三方组件

项目采用 [MIT License](LICENSE)。使用 mitmproxy、React / React DOM、ws 和 VS Code Extension API，第三方许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

mitmproxy 按需从官方站点下载，保留独立包中的许可证和声明。插件引擎清单锁定版本与校验值；本仓库不包含 CA 私钥、个人设备标识或 Apple 签名团队信息。

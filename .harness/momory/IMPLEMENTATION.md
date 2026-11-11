# 实现与验证结论

## 活动栏入口与插件图标（2026-11-11）

- 用户确认原生活动栏入口＋侧栏“打开工作台”按钮，使用 viewsContainers.activitybar、空 TreeDataProvider 和 viewsWelcome；标题栏快捷按钮复用 flutterPilot.open，无额外代理或 Mock 开关操作。
- 按用户确认的蓝青色导航罗盘＋指针设计，新增 resources/flutter-pilot-icon.svg、256px PNG 及单色 flutter-pilot-activity.svg，扩展 manifest 引用对应图标；SVG 为手工矢量源文件，通过浏览器导出 PNG 并检查预览。
- 类型、格式及 357 项 Vitest 通过。使用独立包 artifacts/flutter-pilot-0.0.7-activitybar.vsix，保持版本 0.0.7；通过 CLI 更新 Cursor，28 个安装文件与 VSIX 一致，报告 artifacts/flutter-pilot-activitybar-install-report.json。不启动 IDE GUI、不强制重载、不更改固定布局。

## Flutter Pilot 完整更名（2026-11-11）

- 用户确认直接切换、不兼容旧配置。显示名 Flutter Pilot，扩展 ID flutter-pilot.flutter-pilot，MCP flutter-pilot，命令/设置 flutterPilot，项目目录 .flutter-pilot，代理参数 FLUTTER_PILOT_PROXY；桥接根目录、规则导出、helper、VM事件及示例同时更新。
- 版本保持 0.0.7；357 项 Vitest、37 项 UI、示例 3 项 Widget 测试、类型/格式/构建通过。真实 Dart Debug VM 的 HTTP/Dio 21 项、WS/WSS 两种传输及 MCP 链路通过。Python 17 项通过，19 项引擎集成跳过。
- 新包 artifacts/flutter-pilot-0.0.7.vsix；包一致性与 SDK stdio 报告 artifacts/flutter-pilot-rename-report.json。未提交、安装、发布、启动 IDE GUI 或修改真实 Agent 配置；原历史截图和报告保留事实。

## 0.0.7 发布（2026-11-10）

- 用户要求提交、发布及安装Cursor；manifest、lockfile、MCP serverInfo、打包路径、README和CHANGELOG升为0.0.7。包含21个工具的独立同名Prompts及覆盖检查，共25个提示词。
- 类型、格式、357项Vitest通过；发布验证报告保存在artifacts/v0.0.7-install-report.json。安装通过CLI执行，不启动IDE GUI或强制重载窗口。
- Cursor CLI --force安装成功，活动登记api-mocks.flutter-api-mocks@0.0.7；25项包文件与源码及安装目录逐项一致，manifest除Cursor元数据外一致。源码和安装bridge均通过真实SDK stdio：版本0.0.7、21工具、25 Prompts、5资源；全部同名提示词含参数schema，离线可读。

## MCP 全工具同名 Prompts（2026-11-10）

- src/mcp/prompts.ts为21个工具补同名操作计划，保留4个场景模板，共25个；getMcpPrompt按需输出指南主题、步骤与实时生产JSON Schema。toolPromptPlans通过Record<McpToolName,...>约束，新增工具漏模板会类型检查失败。
- 初始化说明列全21个工具、同名Prompt入口及未加载Prompts时的指南回退。get_usage_guide/list_sessions模板明确无需在线VM或sessionId。
- 357项Vitest、类型、格式、构建及diff检查通过；真实SDK读取构建后dist桥接，离线发现21工具/25Prompts，全部21工具同名Prompt可读、含参数schema且在初始化说明中出现。证据artifacts/mcp-prompt-coverage-report.json。
- 用户随后授权本地提交、发布及CLI安装0.0.7；不启动IDE GUI、不控制用户App、不修改Agent配置。活跃窗口需在方便时重载并重连MCP以加载更新。

## 0.0.6 发布（2026-11-10）

- 用户要求提交、发布新版本及安装Cursor；manifest/lockfile、MCP serverInfo、打包路径、README/CHANGELOG升为0.0.6。包含设置入口、已有VM补查修复、已提交MCP热更新和已确认Tab滚动条调整。
- 354项Vitest、类型、格式、构建通过；37项UI沿用修复后已通过结果。VSIX、安装一致性与SDK stdio报告：artifacts/v0.0.6-install-report.json。
- 当前main无远端，交付本地VSIX并CLI安装；不发布商店、不启动IDE GUI、不访问钥匙串、不强制重载窗口。先前“不提交/不安装”由本次用户授权覆盖。
- Cursor CLI --force安装成功，活动登记api-mocks.flutter-api-mocks@0.0.6；25项包文件与源码和安装目录逐项一致，manifest除Cursor安装元数据外一致。源码与安装bridge均通过真实SDK stdio：版本0.0.6、21工具、4 Prompts、5资源及离线指南读取。

## 设置入口及已有 VM 补查修复（2026-11-10）

- 用户确认工作台设置入口打开即卡死，Flutter 通过 Cursor Run/Debug 先运行后打开插件时无法连接。沿用既有支持已有 IDE Debug 会话的方案，无需重新设计或扩展到终端日志 / 端口扫描。
- 设置及本地引擎入口用 renderer 原生命令链接，Webview 精确白名单；移除宿主 openSettings 调用，避开 Cursor 返回编辑器实例的 RPC 序列化。
- VmDiscovery.start 每次打开工作台补查，启动并发共享任务，首次公开 API 不可用允许重试；已连 DTD 重新查询，断线或订阅失败关闭旧连接后支持同 URI 重连，失效旧查询不得发布状态。
- 354项Vitest、37项Playwright、类型、格式、构建和diff检查通过。新增超时重查、同URI重连、失败订阅清理、API恢复及扩展打开后自动连接已有VM用例；设置链接参数、白名单及旧消息不触发RPC也有回归。
- 版本保持0.0.5，本轮未提交、覆盖安装或启动IDE GUI；修复包使用独立文件名，不覆盖此前发布产物。用户实际IDE重开设置和已有VM连接尚待复验。

## MCP 热重载与热重启（2026-11-10）

- 新增 hot_reload / hot_restart，工具总数21；sessionId必填，timeoutMs为100..30000，默认30000。list_sessions暴露capabilities.lifecycle支持及繁忙状态。
- 当前VM必须准确匹配当前项目发现的IDE调试会话及地址；按session对象customRequest控制，已有DTD会话回退Editor.hotReload/Editor.hotRestart，独立30秒控制超时。不调用全局多会话命令。
- hot_reload核验当前Flutter Isolate或Group成功事件；hot_restart核验旧Isolate消失及新Flutter Isolate就绪。未确认、取消、断线不声称完成，在途请求未结束时拒绝重复操作。预检期间关闭MCP会阻止后续发送。
- UI锚点失效；刷新profiling isolate、清旧Dio锚点并同步已开启Mock，WS采集已开才重扫，禁用开关不自动开启。真实VM断线沿用原关闭策略；不保证启动首请求已Mock。指南、Prompts和文档含完整流程。
- 类型、格式、构建、348项Vitest通过；Flutter3.47.8 SDK Debug Adapter及iPhone18Pro/iOS27.2独立fixture，经真实MCP stdio、IPC、调试协议及VM验证14项：源码热更且状态保留、restart重置状态、两种Mock数据及HTTP规则命中和UI闭环、无变更及编译失败不误报。报告artifacts/mcp-lifecycle-flutter-report.json，脚本npm run test:mcp:lifecycle。
- 未启动IDE GUI、未访问钥匙串、未控制用户业务应用；已安装IDE真实会话、Android及真机未在本轮验收。用户随后授权本地提交；未安装或递增版本。

## 0.0.4 打包与 Cursor 安装（2026-11-09）

- 扩展 manifest、lockfile、MCP serverInfo 和安装包命名统一为 0.0.4，README/CHANGELOG 同步。324 项测试、类型和格式检查通过，VSIX 构建成功。
- Cursor 3.29.9 CLI `--force` 安装成功；VSIX、源码构建和安装目录 11 项文件 SHA-256 一致，manifest 除 Cursor 元数据外完全一致。构建及安装桥接均通过真实 SDK stdio：版本 0.0.4、19 工具、4 Prompts、5 资源及离线读取。报告 artifacts/v0.0.4-install-report.json。
- 未强制 Reload Window、未修改 Agent 配置；用户方便时重载 Cursor 窗口并重连 Agent MCP，才能让已有进程加载本次更新。当前改动未提交。

## MCP Prompts 与双向 WS 消息（2026-11-09）

- 新增标准 prompts/list、prompts/get，4 个开发场景模板；新增 inject_ws_message / send_ws_message，现有工具共 19 个。支持 text 或 topic/data，序列化后最多 256 KiB，仍受具体运行时采集上限限制。
- 复用现有 push 入 App，新增 socket.add 出站并保留规则替换/丢弃与记录。要求采集与 WS Mock 显式开启，按准确连接操作；MCP 取消信号透传各级队列，断线或在途取消不声称动作未执行，不自动重试。
- 324 项单测、类型、格式、构建、diff 检查通过。Dart 3.13.7 / macOS arm64 真实 WS/WSS 均通过 SDK stdio→IPC→网络控制器→VM 的双向 topic/data、记录与规则闭环。报告 artifacts/ws-mcp-bidirectional-report.json。非 Flutter 设备/IDE GUI 验收；本轮未安装或提交。

## MCP 内置 Agent 指南（2026-11-09）

- 新增 src/mcp/guide.ts，初始化 instructions、工具描述、get_usage_guide 工具和5份固定 URI 资源共用指南；17个工具可被发现。指南在桥接本地处理，不转发运行时调用，不依赖会话注册目录可用。
- 包含两类文件字段与合法示例、增量维护与保留已有规则、重载状态判断、独立采集/Mock、快照发现真实 typed Key、父范围、诊断与闭环验证；MCP Tab 和 docs/mcp.md 同步说明。
- 316项 Vitest、类型、格式和构建通过；新增 stdio SDK 测试覆盖离线/不安全registry仍能读取指南、工具和资源内容一致、未知主题/URI拒绝、不向运行时转发；示例通过真实规则和工具schema校验。MCP工作台3项Playwright通过，390px截图已目视检查。未启动Cursor/VSCode GUI验收，未访问钥匙串；没有重新计入真实Flutter/客户端模型验收。
- 延续用户安装要求，Cursor CLI覆盖安装成功；VSIX、当前构建及安装目录8项文件SHA-256一致，manifest一致；解包桥接通过真实SDK stdio发现17工具、5资源、离线读取全部主题且工具/资源内容一致。报告 artifacts/mcp-guide-report.json；未强制重载窗口，需用户方便时重载插件并重连Agent MCP。本增量在main；用户随后明确要求完成后commit，随本轮提交，不推送。

## Flutter UI MCP 与 Agent 适配实现（2026-11-09）

- 用户随后要求安装并归入 main：当前已在 main，无需合并。重新构建0.0.3 VSIX，Cursor CLI `--force` 覆盖安装成功；安装目录的扩展/bridge/Webview JS与CSS、3份Dart模板共7项 SHA-256 与VSIX及当前构建逐项一致，package.json除安装元数据外完全一致。报告 `artifacts/mcp-install-report.json`。未启动隔离IDE、未访问钥匙串、未强制Reload Window。

- `src/mcp` 提供官方 SDK stdio bridge、认证 Unix socket registry、严格16工具 schema、项目/全局隔离、取消与代次保护、客户端真实握手状态；稳定桥接脚本在用户私有目录，Node20+绝对路径，不输出 VM 凭证。
- `src/vm/ui.ts` 与固定 `resources/vm/ui.dart.txt` 通过已有 VM 访问 Element 树，支持 typed ValueKey、祖先范围、真实 pointer 命中/点击/滚动、EditableText 输入、postEvent 异步完成、IsolateExit 及 HotRestart 失效；文本仅诊断。多个交互/滚动目标拒绝操作，缺 Key 判定复用真实目标解析，快照有界且保留祖先 Key。
- MCP Tab 提供服务开关、项目默认适配、Claude/Codex 卡片、配置差异/覆盖来源、桥接自检和 UI 探测。配置文件 JSON/TOML 定点编辑、原子保存及外部变化检查，保留其他 MCP；仅显式 repair 替换冲突，remove 只删除插件管理项。
- 提取文件规则重载/网络服务供 Webview 和 MCP 共用；加载、同步接收与实际运行时应用分开报告，HTTP 采集可独立暂停，WS 重载保留有效临时规则。
- 已通过305项 Vitest、34项 Playwright、类型/格式/构建；真实 Flutter3.47.8/iPhone18Pro/iOS27.2 UI41项、真实 stdio/IPC/UI/Dio Mock/HTTP 闭环16项，源码 SHA 不变；Claude2.1.292/Codex0.162.1项目和全局协议4场景通过。桌面 Codex App 界面、Android/真机未验收。
- VSCode1.116.0 与 Cursor3.29.9 隔离扩展宿主两阶段各12断言通过；Cursor 测试引发用户钥匙串提示后立即停止 GUI 测试，确认测试进程退出，脚本默认 skip 并显式门控。未访问钥匙串、不重启用户 IDE、不安装或提交。包含 HotRestart 的 Flutter fixture 停止时偶发 SDK 临时 dill 清理噪音，断言和 exit0 均通过，MCP 闭环无此噪音。

2026-11-08 已实现首版。入口 src/extension.ts；React webview；proxy/addon.py；Dio 接入 src/setup.ts。

- mitmproxy 固定 12.3.1，arm64/x64 SHA 来自真实下载及官方交叉核对，manifest 位于 resources/engine-manifest.json。
- 官方 standalone 不带 Python sqlite3，proxy/sqlite_cli.py 使用 macOS /usr/bin/sqlite3，经 stdin 传固定SQL模板和正确转义的参数，不需用户Python。
- proxy.start/stop 只切流量监听。新增后台会话生命周期：关闭工作台后继续记录；退出 IDE / 移除对应工作区时才关闭引擎。
- history.list 返回摘要，history.get 返回三快照，避免大量正文通过 TCP/Webview 反复发送。
- 流式、二进制、上传、超限和 br/zstd 正文仅直通；gzip/deflate 有界解压。
- 已实际通过 VS Code/Cursor 独立扩展宿主 HTTPS Mock，以及 Android USB 真机和 iOS 模拟器最小开发接入。完整测试统计见 docs/validation.md。
- 尚未实际验收 Android 模拟器、iOS 真机 LAN、Intel 运行、系统代理零代码路线；不得宣传已全覆盖。

## 可复用修复经验

- helper 必须保留系统可信根，只加入当前调试 CA；不允许无条件跳过 TLS 验证。
- 下载中关闭工作台仍可继续后台初始化；退出 IDE / 移除工作区必须在异步恢复后检查 disposed，防止遗留 sidecar。
- 断点编辑只提交变化的头部，避免 Object.fromEntries 压缩未改动的重复 Set-Cookie。
- 保存规则和引擎确认生效是两个状态；同步失败保留已保存规则并明确显示未生效。
- 选中详情仅在变化时发送，普通流量事件不重复携带六份正文；TCP 按完整帧解码 UTF-8。
- 对用户后续编辑的接入文件整体保护，不单独删除仍被引用的 helper。

## 后台自动记录与独立 API 目录增量

- 用户已确认默认行为，需求无需再次询问：完成首次接入后，打开受信任本地 Flutter 工作区自动启动已安装 / 配置引擎，不静默下载；autoStart 默认 true。
- 工作台与后台会话分离，多根工作区按 Flutter 文件夹隔离；重新打开面板不会撤销本会话的手动停止。
- connection.json 保存连接地址、端口与已选 Android 设备，后台启动尝试恢复在线且已授权设备的本会话转发。
- history.apis 查询独立目录，累计次数不等于现存历史条数；旧历史只迁移一次，防止用户删除目录后被旧记录复活。
- api.delete 仅删除目录项，不删除历史或规则；未来新调用会重新发现。历史过期、删除或清空不删除目录。
- breakpoint.setInteractive 控制人工暂停：后台默认关闭，打开工作台开启，关闭 / 断连时释放等待断点并关闭；自动规则始终按当前配置执行。
- 增量已通过 59 项 TypeScript、36 项 Python、12 项强制 SQLite CLI 和 9 项 UI 测试；真实 IDE 与设备验收范围以 docs/validation.md 为准，不能用首版测试统计替代。

## EXIO 实际接入与复用（2026-11-08）

- 项目：`/Users/mark.pan/Documents/exio/exio_app`；Cursor + Flutter 3.47.8 + iPhone 18 Pro / iOS 27.2，dev flavor。
- 代理：`127.0.0.1:8080`，仅本机监听。模拟器不需要 Android reverse 或局域网监听；地址端口以工作台实际值为准。
- 启动项：`exio_app (API Mocks · iPhone 18 Pro)`；独立入口 `apps/exio_app/lib/main_api_mocks.dart`，Debug + `API_MOCK_PROXY` 才启用，通过现有 `apiClientInterceptorInstallerProvider` 安装适配器。保留系统可信根并加入当前 CA 公钥证书，不使用旧 `EXIO_DEBUG_HTTP_PROXY` 的无条件放行路线。
- 实测快照：10 个 API、39 条请求；多个真实 HTTPS 200，法币接口本地 Mock 命中 2 次，响应头带 `x-api-mocks-demo: exio-cursor`。计数是当次验收快照，不是后续固定预期。
- 结束状态：教程规则“教程 · 法币列表 Mock（原响应）”保留且停用；代理继续采集。重载 Cursor、未打开工作台时自动启动已实际验证。
- 自动发现修复：根 pubspec 的显式 Dart workspace 成员识别 Flutter，最多 256 项，不递归、不展开 glob，拒绝根外路径，按 IDE 根目录建立单会话。TypeScript 全套 59 项通过。
- 覆盖主 API Dio；下载临时 Dio、WebView、原生插件和 WebSocket 未计入覆盖。首轮超时后重试、登录恢复 401 已如实记录，没有登录或交易操作。
- 换电脑或 CA 重建需更新公钥证书；恢复常规开发先停止当前调试，切回原 `exio_app` 启动项，再停止代理。
- [完整图文教程与 12 张截图](../../docs/exio-cursor-guide/README.md)；[验证结论](../../docs/validation.md)。EXIO 仓库内同步保存教程 `docs/api-mocks/README.md`，接入约束位于 `.harness/memory/rules/runtime-services.md`。

## API 工作台布局与正文阅读（2026-11-08）

- 目录按 lastAt、请求列表按 startedAt 倒序，客户端对乱序输入显式排序；存储端已有倒序和分页，跨页仍依存储排序。
- 目录可折叠、独立搜索；折叠不清除当前 API 筛选，折叠偏好通过 Webview getState/setState 保留；窄面板目录放在列表上方，不再直接隐藏。
- 点击新请求默认展示响应，提供请求/响应标签、放大详情/返回列表、状态/耗时/完整日期摘要；长路径两行截断，完整 URL 保留可滚动查看。
- 文本正文不依赖 Content-Type，自动尝试 JSON 格式化，支持切原文与复制当前展示内容；非 JSON 明确回退原文，二进制仅 Base64，无响应、空正文、截断分别展示。
- `webview/body.ts` 使用 JSON.parse 验证语法，但通过原始 token 格式化，不重序列化解析结果，保留大整数、数字精度、重复键和转义。正文 1 MiB、格式化结果 4 MiB、缩进深度 24 层设阅读资源边界，超限回退原文。历史实际快照不变。
- 本轮 68 项单元测试、17 项 Playwright、TypeScript/Webview 类型检查通过；截图使用合成数据。设备网络与上轮 MFA 代理超时问题未在本轮修复或重新验收。

## 0.0.2 VM Service 实现与证据（2026-11-08）

- `src/vm/client.ts` 使用 ws + JSON-RPC；请求超时、连接关闭和帧限制受控，错误不输出认证 WS。`profiler.ts` 使用 SDK HTTP profiling 服务扩展采集多 Isolate，按稳定 ID 去重，并在 Hot Restart 重发现。
- `session.ts` 与 UI / 引擎分离；连接、规则同步、Mock 开关和卸载串行。Mock 成功接入时改用 Dio 事件记录，避免与 SDK 两路重复；没有实例时继续观察。只恢复本插件改变的 profiling 开关，不清理其他 DevTools 数据。
- `injection.ts` + `resources/vm/interceptor.dart.txt` 通过 getInstances/evaluate 找已有 Dio 并安装运行时 InterceptorsWrapper；不修改源码，不替换 adapter 或 TLS。每 Isolate 上限 128 实例，周期重扫新实例，存在首请求窗口。
- 每阶段按原请求选最高优先级首条规则，本地 Mock 进入响应修改；跨源默认去源凭证。空规则和仅正文修改保留业务错误分类，仅明确改 status 后应用 validateStatus；onError 恢复限 badResponse，不能把网络错误变成伪成功。
- 正常停用立即尝试卸载；15 秒租约及心跳续期保护异常断开，意外断开重新启用 Mock 有约 16 秒冷却，可先重连观察。已发出改写无法撤回，停用后在途响应不再改写。
- VM 注入单正文上限 256 KiB；上传、流、自定义正文不主动读取。SDK profiling 的 App 内缓存无插件强制容量上限，不能用本地历史限制替代内存边界。Dio 层快照不是 wire 数据，App 其他拦截器仍会加工或短路。
- `storage.ts` 直接用 `/usr/bin/sqlite3`，无引擎 / Python 依赖；`vm-history.sqlite3` 与原 `history.sqlite3` 分离，目录 700 / DB 600。SQL 经 stdin，字符串 hex literal，不用 shell 拼接，不在错误里回显凭证。API 目录不随历史清理删除。
- 真实 Flutter iPhone 18 Pro / iOS 27.2 模拟器 8 项通过：观察 POST、已有 Dio HTTPS 本地 Mock、请求/响应修改、真实 503→200、Hot Restart、关闭再开启、异常观察断线后重连恢复 SDK 开关、应用入口 SHA-256 不变；noProxy/noHelper/noCA。纯 Dart 实测 Dio 5.9.0 / 5.10.0 / 5.11.1。
- 本轮 TypeScript / Webview 检查、构建和 UI 20 项通过；最终单测及 IDE 统计统一维护在 `docs/validation.md`，不复用旧版代理统计。VM 说明见 `docs/v0.0.2-vm-service.md`。

### VM 注入可复用审计经验

- 未接管的 flow 必须完全旁路，不能改变应用自身 validateStatus 或业务 reject 的语义。
- 规则同步 / detach 必须串行，避免停用后的延迟扫描重新安装；异常断开要等旧租约过期再恢复修改权限。
- 用户正文可能含模板占位符或 Dart 插值，模板替换应一次完成，不重写用户内容。
- 完整 URI 修改 query 时需要处理 path 自带查询参数与删除，重定向仍按原始请求选响应规则。
- 本地 Mock 和流响应要保持外层 / ResponseBody 的状态及头部一致，正文改变后清理旧长度和编码头。

- 最终审计：运行中的代理与 VM 共用规则，VM 页保存也必须同步旧代理，避免 UI 已停用而旧代理继续旧规则；代理控制重连在 VM 页不得恢复人工断点。慢心跳仅允许一个在运行 / 排队，避免多次 RPC 超时延迟停用。
- SDK profiling 异常断线后恢复失败的 ownership 保留在内存；仅 VM pid + startTime + isolate 一致时重认领，成功恢复后消费记录，不能关闭后续外部工具开启的采集。连接断开后无法立即关闭 App 开关，需提示重连再断开或 Hot Restart；严禁自动 clear SDK 缓存。
- 二进制编辑资格按规则改头前原始 Content-Type 判断：非 JSON 的 List<int> 和非文本 Content-Type 只读，JSON 数字数组仍可修改。Dio 既有请求头匹配键先收集再逐个 remove，避免大小写无关 Map 的 removeWhere 动态类型错误。纯 Dart Dio 5.9.0/5.10.0/5.11.1 各 21 项真实 VM 验证通过。
- v0.0.2 最终：116 项 Vitest、20 项 UI、36 项真实代理回归通过；真实 Flutter 模拟器 8 项、Dio 三版本各 21 项通过。VSIX 包含模板，解包产物在 VS Code/Cursor 的隔离 VM 宿主 smoke 均退出 0；未替换用户当前安装，未提交或推送。详见 docs/validation.md。

## EXIO VM Mock 实际 UI 验证（2026-11-08）

- 用户 EPXC 产品详情规则已启用且正文含 789，但 VM 处于只采集状态（运行时 Mock 关闭、接入 Dio=0），因此历史 source=vm、mocked=false，App 仍显示真实内容；规则启用和运行时 Mock 总开关是两层状态。
- 通过 Cursor“连接与诊断”开启运行时 Dio Mock，确认接入 1 个 Dio；模拟器返回 RWA 列表并重新进入 EPXC 后，Product Overview 实际显示“The WisdomTree 789Equity …”。最新历史 source=vm-dio、mocked=true、命中对应规则，响应正文含 789。
- 本次未修改 EXIO 源码、未热重启、不重放认证请求；保留用户规则与运行时 Mock 开启状态。此结果仅证明公开产品详情 Mock 接入，不能当作登录/MFA 验证通过。

## VM WS 默认接入（2026-11-08）

- 用户明确要求 VM WS 作为首要与默认接入，代理作为备用兜底。新 Workbench 和 Webview 初始状态均为 VM，无连接文件时不探测或启动缓存代理引擎。
- 沿用已保存的 proxy/vm；旧连接文件没有 mode 字段时按历史代理配置兼容，避免破坏现有调试链路。切换方式后继续持久化用户选择。
- VM 按钮标注推荐，代理标注备用，并说明 VM 不适用或手动断点场景；README 与 VM 专题同步。运行时 Mock 仍需显式开启，WS 不落盘。
- 118 项 Vitest、21 项 Playwright、类型检查、格式检查与构建通过；新增覆盖新工作区有引擎缓存仍默认 VM、不启动代理，以及旧版配置兼容和初始界面推荐入口。

## 规则启停可发现性（2026-11-08）

- 用户将小复选框及整体变灰的停用规则误认为 disabled。规则列表现使用带滑块、状态和点击动作提示的 button[role=switch]，整块按钮可点击，支持 Space/Enter，保留 aria-checked 和规则名称；只有实际操作繁忙时禁用按钮。
- 移除停用卡片整体 opacity，启用规则使用主题强调色与左侧色条；off 仍保留正常文字与编辑按钮对比度。680px 窄面板调整内容占比避免横向溢出。
- 类型检查、构建、格式检查与现有 21 项 UI 回归通过；额外用合成规则检查鼠标和 Space 均发出 toggle 消息，并人工查看深色、浅色和窄面板截图，产物位于 artifacts/rule-switch-*.png。不改变规则执行语义。

## 项目 UUID 绑定（2026-11-08）

- 用户确认 `.api-mocks/project.json` 保存 version:1、projectId、name、connection 和可选 settings；`.api-mocks/rules.json` 保存规则。VM WS、CA 私钥、历史及本机 Android 设备信息不进入项目文件。
- IDE 私有目录按 `projects/<projectId>/<workspaceUri SHA-256 前24位>` 隔离；同 UUID 的不同副本 / worktree 读取各自规则，SQLite 与后台会话分开。移动路径不保证接续旧路径历史。
- 项目设置优先于 IDE 设置，未指定时回退；本机 enginePath 不写入共享项目文件。会话使用启动配置快照，读取项目文件可同步规则，接入 / 采集参数变化提示重载窗口后生效，不能强制中断活跃连接。
- 旧规则 / 连接配置只在目的项目文件缺失时迁入，原文件保留；历史 DB、CA 和私有连接按白名单复制到新目录，旧数据认领标记防止换 UUID 重复导入。
- 配置非法、未知版本、符号链接越界均报错并保留原文件；外部编辑后先读取，再允许工作台继续保存规则，避免用旧内存规则覆盖磁盘改动。UUID 改变需重载建立新会话。
- 连接页项目绑定卡提供名称与 UUID，以及“项目配置”“规则文件”“读取项目文件”入口。当前规则启停按用户最终反馈只保留 switch、悬停提示和无障碍状态，不显示冗余启停说明文字。
- 项目文件是否纳入 Git 由用户决定，不自动 git add、提交或推送。专题文档为 `docs/project-binding.md`。
- 已执行构建及隔离配置的 Cursor VM IDE smoke：项目 UUID/名称、项目配置和规则路径、私有目录隔离、规则保存、外部编辑防覆盖、读取后切换规则、VM 连接及工作台关闭后保持连接均通过；认证 WS 未写入项目文件。此项使用合成 JSON-RPC 服务，不替代真实 Flutter 注入或设备验收。完整测试统计见 `docs/validation.md`。

### 项目绑定最终整合验证

- 159 项 Vitest、23 项 Playwright 通过，类型、格式、构建与 diff 检查通过；Cursor 隔离 VM / 真实代理 smoke 通过。详见 docs/validation.md。
- 项目卡长名称换行、顶部项目名称省略，680px 无横向溢出；规则启停仅保留 switch。截图为合成数据。
- 本轮不自动提交，不强制重载用户 Cursor；覆盖安装后由用户在调试方便时 Reload Window，再输入本次 Flutter VM WS。

- 最终 VSIX 已用 Cursor CLI `--force` 覆盖安装成功；安装目录的 extension.js、webview.js/css 与 VM 模板逐项 SHA-256 和 VSIX 一致。未强制 Reload Window，真实 EXIO 项目文件迁移等待用户方便时重载触发，不声称已对活跃 EXIO 数据做迁移验收。

## VM DDS 连接和状态同步（2026-11-08）

- 用户确认成功连接后禁用地址输入，显示“已连接 · 当前端点”，仅留断开，换地址先断开；前后端均防重复连接，不重置当前 Mock。
- VmServiceClient 支持最多两次字面 loopback 间 DDS 跳转，不使用不受限自动重定向；WSS 不得降级，不携带凭证到外站。VmConnectionError 对端口、超时、认证、路径和跳转分类，未知初始化错误仍脱敏兜底。
- VmSession 在初始化提交前检查真实 socket / 状态 / generation，意外断开立即失效本次初始化，清旧 endpoint 和计数；成功状态使用实际 DDS 端点。
- 174 项 Vitest、24 项 Playwright、类型 / 格式 / 构建通过；真实 Flutter 从原始 WS 经过 DDS 跳转后 getVM 只读验证通过。未改 EXIO 源码、未发业务请求、未保存认证地址；完整验证见 docs/validation.md。
- 最新 VSIX 解包后的 Cursor VM 隔离宿主退出 0；已强制覆盖安装，安装的扩展和 Webview JS/CSS 与构建 SHA-256 一致。未自动重载用户窗口，需重载后输入本次有效 WS；未提交或推送。


## 0.0.3 WebSocket 实现与验收（2026-11-09）

- `src/vm/websocket.ts` 与独立 Dart 模板包装已有 dart:io WS 的入站订阅及协议编码前稳定出站订阅，覆盖 add/addStream/addUtf8Text；不修改应用源码、adapter/TLS。运行时结构探测，handler 身份保护，15 秒租约；外部工具改 handler 后插件旧 wrapper 也立即旁路。
- `src/ws/` 提供独立状态机、规则及私有 SQLite。WS Mock 与 Dio 分开；RPC/同步失败停止续租旧规则；同步 invalidate 和 epoch/revision 防旧异步结果复活在线状态。存储/事件队列有界，过载只丢记录并计数，业务流不等待 IDE。
- 握手仅成功101能用于关联，以Isolate/本地端口/远端地址端口唯一匹配；握手绑定socket serviceId不可转移，URL未知不命中URL规则。控制连接排除、临时规则随准确连接关闭过期。新VM握手不入HTTP目录，旧VM握手只投影不改事实或旧累计数，代理握手沿旧行为。
- WebSocket Tab：连接/消息、原始与生效对比、JSON/原文、复制、分页搜索、独立采集与Mock、手动入站推送，以及WS规则CRUD/排序。规则外部编辑需读取项目文件，不覆盖磁盘，失败保留编辑草稿。
- 233项Vitest、28项UI、TypeScript/Webview类型检查、格式检查、构建通过；Cursor与VS Code隔离VM宿主新WS规则/查询/详情/冲突保护链路均退出0。Python代理规则/存储17项通过，19项引擎集成因未指定MITMDUMP跳过；本轮未宣称全部代理实测。
- Dart3.13.7真实隔离WS/WSS：双向replace/drop/push、UTF8/流、二进制、pingpong、pause/resume、租约旁路、未发送close、SDK握手→URL规则、外部handler所有权、500burst全部业务送达且400遗漏计数。每种保存115消息。
- Flutter3.47.8/Dart3.13.7，iPhone18 Pro/iOS27.2模拟器一次性fixture四连接：dart:io WS/WSS及web_socket_channel3.0.3 WS/WSS，双向规则/推送不串线、addUtf8Text/addStream、卸载恢复、Hot Restart新isolate/新ID/旧推送拒绝和采集恢复均通过，25消息，无warning，fixture源码SHA不变。未连接或修改用户EXIO App。
- SDK HTTP profiling会缓存HTTP正文，App内无本插件强制容量上限；本机历史上限不能替代该边界。Android/iOS真机、其他SDK、Socket.IO/原生插件/WebView未验收。具体见docs/v0.0.3-websocket.md、docs/validation.md。代码未自动提交，未覆盖用户当前安装。

- 最终0.0.3 VSIX已生成，解包逐项核对extension.js、webview.js/css及两份Dart模板与构建一致；使用解包产物在Cursor隔离宿主执行新增WS消息链路验收退出0。SHA-256记录于忽略目录artifacts/v0.0.3-package-report.json。未覆盖当前安装。

- 用户随后要求覆盖安装到 Cursor，CLI `--force` 安装 0.0.3 成功；活动扩展登记为 api-mocks.flutter-api-mocks@0.0.3，安装后扩展/Webview JS/CSS 与两份 Dart 模板均与 VSIX SHA-256 一致。未自动重载用户窗口。用户已明确要求提交本轮实现。

## VM 自动发现与连接（2026-11-09）

- `src/vm/discovery.ts` 提前注册公开 debug custom/start/stop 监听，合并 Flutter appStart 的实际 mode/device 与 debuggerUris；不依赖 Dart-Code 私有数字枚举或复制剪贴板命令。DTD 通过公开 API v3 URI 接入，订阅 Editor / Service 并调用 Editor.getDebugSessions 补查，处理延迟就绪、超时和旧响应。
- 候选摘要与地址分离，真实路径按最具体工作区归属；另一个根目录缺失不影响有效根。DTD 多会话完整快照原子发布；stop tombstone 不被迟到 DTD started 清除，revision/generation 防旧异步结果复活。地址不会进入 WorkbenchState。
- `autoConnect.ts` 独立管理默认关闭至Workbench初始化完成的自动调度、唯一候选、多候选选择、三次预算、手动优先、暂停与owner断开。回调只负责连接与历史刷新；历史刷新异常不误报VM连接失败。project.settings.autoConnectVm布尔校验、IDE配置更新及项目读取即时应用，关闭设置保留在线连接。
- 新增 `vm.discovery.connect` 消息动作，以ID选择候选，Webview展示设备、来源、脱敏端点、等待/失败/暂停状态，390px窄屏无横向溢出。所有Mock与WS采集仍手动开启。
- 本轮269项Vitest、31项Playwright、类型/格式/构建/diff检查通过；Cursor与VSCode合成隔离消息链路退出0。真实Cursor3.29.9（宿主API1.128.0）及VSCode1.116.0，Dart扩展3.146.0，Flutter3.47.8/Dart3.13.7，iPhone18Pro/iOS27.2各9项断言通过：IDE launch/attach、真实HTTP记录、已有会话DTD补查、HotRestart、手动断开抑制与显式恢复、stop/start及源码SHA不变。未修改或控制用户EXIO会话。
- 自动连接可能早于应用HTTP profiling服务就绪，测试需等待vm.state.isolates>0后发请求；不承诺补抓采集就绪前流量。真实测试使用/tmp独立fixture与IDE profile，只控制自身调试会话；Android/真机/其他SDK未验收。报告在忽略目录artifacts/vm-discovery-{cursor,vscode}-report.json。
- 用户随后要求安装并提交：重新构建0.0.3 VSIX，解包后Cursor隔离VM消息链路退出0；Cursor CLI --force覆盖安装成功，活动登记0.0.3。安装后的extension.js、webview.js/css及两份Dart模板SHA-256与包一致；package.json除Cursor新增__metadata外内容一致。校验报告artifacts/vm-discovery-package-report.json。未自动重载当前窗口，需用户在调试方便时Reload Window加载新版。

## Dio Mock 控件简化（2026-11-09）

- 按用户确认保留连接页位置，复用规则列表button[role=switch]的滑块样式，去掉多段技术说明和重复标题；保留实验性标记、一句说明，重新发现按钮仅开启时显示。vm.mock消息和禁用条件不变。
- 类型检查、构建、格式/diff检查及27项工作台UI回归通过；扩展现有用例验证鼠标/Space切换、繁忙/断线禁用、390px布局及卡片高度，合成窄屏截图artifacts/dio-mock-switch-narrow.png已目视检查。
- 用户随后要求安装到Cursor：0.0.3 VSIX重新构建并CLI --force覆盖安装成功；扩展、Webview JS/CSS与两份Dart模板均与VSIX及构建SHA-256一致，清单除安装元数据外一致。报告artifacts/dio-mock-ui-install-report.json。未强制Reload Window，未提交本次UI改动。

## 六个 Tab 内容优先布局（2026-11-10）

- React/CSS 调整共用紧凑顶部，内容区使用剩余窗口高度并独立滚动；覆盖连接、HTTP 历史、WebSocket、Mock 规则、断点和 MCP。
- 历史高级条件展开/收起保留查询；规则模板、导入导出、项目文件、WS 采集说明、MCP 维护与说明折叠。VM 已连接收起地址输入，错误/冲突及手动开启语义保留。
- 类型检查、构建、修改文件 Prettier、git diff --check 和36项 Playwright通过；新增1280px/390px六Tab内容位置、主区域无横向溢出及筛选保留检查，合成数据截图位于 artifacts/compact-*.png。已目视检查截图；本轮未启动IDE GUI、未安装或提交。

## 0.0.5 打包与 Cursor 安装（2026-11-10）

- 用户要求发布新版本、commit并安装Cursor，补丁版本递增0.0.5。manifest、lockfile、MCP serverInfo、包名、README/CHANGELOG及验收说明已同步。
- 324项Vitest、36项Playwright（布局轮）、类型检查、全仓格式检查与构建通过。本轮不重复设备/IDE GUI验收。
- Cursor CLI --force安装成功，CLI已列出0.0.5；包内25项文件与当前源码/构建及安装目录逐项一致，manifest除Cursor元数据外一致。构建与安装桥接分别通过SDK stdio：0.0.5、19工具、4 Prompts、5资源、离线指南读取。报告artifacts/v0.0.5-install-report.json。
- 当前在main，无远端；提交本轮布局和版本改动，不推送。未启动IDE GUI、未访问钥匙串、未强制重载窗口，用户方便时执行Developer: Reload Window加载新版。

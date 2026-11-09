# 实现与验证结论

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

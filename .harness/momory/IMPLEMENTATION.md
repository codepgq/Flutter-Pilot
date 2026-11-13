# 实现与验证结论

## 移动交互交付范围（2026-11-13）

- 修复及复验完成后，用户授权 `commit and push`。本轮移动交互功能、六项修复、测试和文档统一提交并常规推送 main；此前的未提交记录为验证时历史状态。
- 版本保持 0.0.14，不创建新标签，不打包、发布或安装扩展。

## 移动交互审查修复（2026-11-13，用户授权 fix all）

- 已处理六项审查问题：WDA 启动清理所有权、iOS 菜单目标归属、MCP 长操作宿主超时、Unicode 簇内选区、原生追加语义及跨设备 VM 长图租约。
- 连接适配器升级 v3，在附着模式跳过 startup.cleanupApps；旧 v2 回执即使经旧安装 fallback 也不可启动，需重新准备。仍清理自身 WDA／进程，不操作其他工具资源。
- 菜单复用和最终点击前核验目标焦点与原生活动编辑器身份；Flutter 提供唯一 RenderEditable 与 TextField／CupertinoTextField 的真实边界，兼容 iOS 无障碍整框，不能用任意外层 Key 边界替代。原生 append 在输入前明确不支持，能力项同步 false；Flutter 追加显式 backend=flutter。
- 文本编辑基于完整原字符串字符簇，聚焦前及执行前拒绝 INVALID_TEXT_BOUNDARY；保留合法 UTF-16 反向选区、formatter／onChanged。完整生产模板由实际 Dart／Flutter 编译执行，25 项内部测试通过。
- MCP 认证和参数校验后应用共享期限，setup 660s／connect 240s／截图 85s，宿主多 5s。真实未缩时 Unix IPC 的 50 秒 setup／connect 模拟处理分别在 50004／50003ms 完成，取消只触发一次、不重放，报告 artifacts/mcp-long-operation-fix-report.json。
- Flutter 长图按实际 VM 设备持有临时租约，仅当前原生会话已持有同设备时复用；已连接不同原生设备不能绕过 DEVICE_BUSY。
- iOS 页面快照的 AppiumAUT 包装层不属于 WDA XPath 查询树；仅在 iOS 查询时去除该前缀，Android 保持原路径。实际双字段菜单流程与两平台路径回归通过，独立复核未发现新增问题。
- 505 项 Vitest／34 文件、70 项 Playwright、类型、构建、格式及 diff 检查通过；Python 代理 21 项通过、21 项缺 MITMDUMP 跳过。独立复核发现的缺失字段边界契约和实际 iOS 整框差异已修复并加入回归。
- 独立 iPhone 17／iOS 26.5 模拟器通过真实 MCP stdio → IPC → VM／Appium 完成 152／152 项检查（含清理），completed=true、cleanupErrors=[]。涵盖四类 Unicode 簇、中间光标／选区的原生追加拒绝、A 菜单下对 B 的 cut／paste 拒绝及两字段不变；报告 artifacts/automation-flutter-smoke-report.json。
- 本轮 fixtureSourceHash 仅指生成的 Dart main；包含 Swift fixture 的测试脚本及相关源码哈希见 artifacts/automation-fix-validation-evidence.json。模拟器与私有验证运行时清理证据见 artifacts/automation-fix-cleanup-report.json。Android／物理 iOS 未验收，保持 0.0.14，未提交或发布。

## 移动交互扩展初始验收（2026-11-13，未发布源码；修复后结果见上节）

- 新增 src/automation：独立锁定 Appium 3.9.0 / UiAutomator2 8.7.3 / XCUITest 12.22.8，私有 APPIUM_HOME 和原子安装指针，失败保留原可用环境。只读检查不会安装；跨工作区设备独占租约，不冒险回收崩溃后孤儿租约。
- Flutter VM + Appium 双通道统一队列。key / ancestorKey 兼容；组合 selector、原生 accessibility/resource ID、快照引用、状态和边界；VM 会话代次、源／布局变化拒绝旧引用。映射核对 VM 设备、App PID、前台、窗口、覆盖层、方向及布局，失败不重放。
- 共享有界多指轨迹支持双击、长按、拖拽、滑动、缩放、旋转、嵌套横纵滚动；查找限制区域后代，设备滚动后读取 Flutter isScrollingNotifier 等待惯性停止。
- 文本替换／追加、光标／选区、剪贴板、按键、键盘状态／隐藏／编辑提交和系统导航。Flutter 精确编辑使用编辑协议，保留 formatter / onChanged；iOS 剪贴板使用可见中英文菜单及真实选区内坐标，点击 Copy / Cut 前复核选区。硬件按键另走 XCTest typeKey，依赖设备条件，不把接口接受等同业务验证。
- 私有 XCUITest / WDA 连接适配器 v2 跳过模拟器启动／GUI／偏好修改及其他 XCTest 进程清理，并清理自身 WDA。原生附着不重启、不清数据、不自动接受权限；真机需要用户预签名 WDA，不操作钥匙串。
- 工作台设备自动化区、42 个 MCP 工具和 46 个 Prompts、离线指南、README 和 docs/mobile-automation.md 已更新。分平台／动作能力与具体限制可读，真实 stdio 返回 PNG 图片块。
- 最终类型检查、477 项 Vitest / 31 文件、70 项 Playwright、构建、格式及 diff 检查通过；Python 21 项通过、21 项缺 MITMDUMP 跳过。分发枚举确认独立 lockfile 入包，未生成新 VSIX。
- 初始独立 iPhone 17 / iOS 26.5 fixture 经真实 MCP stdio → IPC → VM / Appium，107 / 107 项通过；Dart main SHA-256 ad6537d221519f549e011e6e10623ebe6d37999759fa6cd49da749b8b426f08e。artifacts/automation-flutter-smoke-report.json 已由上节修复后 152 项结果更新，四设备矩阵见 docs/mobile-automation-validation.md。
- Android 无可用设备，iOS 真机未提供专用验收设备和签名 WDA，均未验收；已配对的用户真机未连接或操作。硬件组合键／方向键、其他语言菜单、物理断线仍未现场验收。
- 保持 0.0.14，不提交、推送、发布、安装扩展或启动 IDE GUI；只清理本轮独立模拟器、fixture 及其进程。

## 0.0.14 发布验证与 Cursor 安装（2026-11-13）

- 456 项 Vitest、68 项 Playwright、类型、格式、构建及打包通过；Python 21 项通过、21 项因未配置 MITMDUMP 跳过。场景恢复含失联模式切换保护；本轮未执行真实引擎故障注入或设备验收。
- VSIX 为 `artifacts/flutter-pilot-0.0.14.vsix`，SHA-256 `49b5b38c7a8372241066b12eacb018d9b5482999dacdeb1754b5b5fc1117db63`。Cursor CLI 安装成功，活动登记为 0.0.14；包内 29 个分发文件与安装一致，manifest 仅排除 Cursor 元数据，四个 dist 文件与构建一致。
- 构建与安装桥接的真实 SDK stdio 均返回 0.0.14、25 工具、29 Prompts、5 资源，离线指南读取成功。报告 `artifacts/v0.0.14-install-report.json`。用户现有窗口需方便时手动 Reload Window 加载新版。

## 0.0.12 远端同步、标签与 Cursor 安装（2026-11-12）

- 拉取确认 origin/main 仍为 2fccee4。完成本地 0.0.11 安装记录与远端 Mock 场景、App 截图的合并，manifest、lockfile、MCP serverInfo、README、CHANGELOG 与 VSIX 路径统一为 0.0.12。
- 440 项 Vitest、63 项 Playwright、TypeScript / Webview 类型检查、Prettier 与构建通过。Python 代理发现 40 项，19 项通过，21 项因未设置 MITMDUMP 跳过。
- 生成 `artifacts/flutter-pilot-0.0.12.vsix`（SHA-256 `1d0e75ffee04f15834dd3392e469d20b5a8ef4b6907ce02f9d3247a2b3b59813`）。Cursor CLI `--force` 安装后列表为 `flutter-pilot.flutter-pilot@0.0.12`。包内 29 个分发文件与安装目录逐项一致，清单只排除 Cursor `__metadata`；安装目录另有 `.vsixmanifest`。构建产物与包内 dist 四个文件 SHA-256 一致。
- 构建与安装桥接的真实 SDK stdio 均为 flutter-pilot 0.0.12、23 个工具、27 个 Prompts、5 个资源，并读到离线指南。报告 `artifacts/v0.0.12-install-report.json`。
- 按授权在 main 提交合并，创建附注标签 v0.0.12，并常规推送 main 与该标签。不发布扩展商店，不自动重载当前窗口。

## 0.0.11 发布（2026-11-12）

- 按用户最新授权发布统一 Mock 场景与 App 截图，版本、MCP serverInfo、安装文档、CHANGELOG 与 VSIX 路径同步为 0.0.11，包含此前本地 Scene 提交与本轮截图改动。
- 440 项 Vitest、63 项 Playwright、类型、全仓格式与 diff 检查通过；Python 代理 19 项通过、21 项缺 MITMDUMP 跳过。构建并生成 `artifacts/flutter-pilot-0.0.11.vsix`。
- 远端检查确认 origin/main 为 2d72c92；按授权在 main 提交并常规推送。未要求安装用户 Cursor，继续采用本地 VSIX、不发布商店的既有流程。

## App 截图与长图（2026-11-12）

- 左侧原生 viewsWelcome、侧栏标题图标和工作台顶部“截图”接入 flutterPilot.screenshot / screenshot.capture，共用截图模式、区域选择、保存和预览流程；未连接 Debug VM、繁忙和代理模式阻止截图。
- resources/vm/screenshot.dart.txt 经现有 VmUiController 注入，逐屏裁片覆盖懒加载列表；finally 在成功、失败或取消时恢复滚动位置。PNG 不进入工作台 state、历史或日志；可取消进度复用 UI 会话失效机制。
- src/screenshot.ts 用 pngjs 校验并在扩展端无损拼接，规避真实模拟器中 GPU 长纹理被缩小到 8192 的问题；累计高度不全、尺寸不匹配和超限拒绝保存。补充第三方许可。
- 类型、构建、相关格式与 diff 检查通过；438 项全量 Vitest 通过后新增入口集成回归（相关 71 项通过）；63 项全量 Playwright 通过。独立 iOS 模拟器 57 项检查通过，含屏幕 PNG、804×9082 长图、可见项位置恢复、取消恢复、多区域枚举、过期目标与超限拒绝；长图末尾 Item 79 和拼接处已目视检查。
- README 记录入口、使用步骤与边界；Android、iOS 真机和真实 IDE 保存对话框尚未现场验收。保持 0.0.10，未提交、打包、发布或安装用户 Cursor。

## HTTP / WS Scene 实现（2026-11-12）

- SceneStore 使用原子创建/替换、整份严格校验及外部编辑检测；SceneController 串行持久化、场景投影与运行时同步，包含连接标识/revision 防旧结果、租约等待重试、采集暂停及临时 WS 规则清理。
- 场景页管理新建/重命名/复制/删除/激活/停用、HTTP/WS 规则和导入导出。生成规则可选择目标场景；API tag 仅用激活规则，历史 ID 不改写。MCP 工具、同名提示词、指南、示例和 smoke 脚本同步新格式。
- 429 项 Vitest、61 项 Playwright、类型检查、Prettier 和构建通过。场景生命周期使用合成运行时验证；390px / 1280px 场景截图已检查。
- 三位子代理分别审查运行时、UI、MCP 与文档；已修复代理重启恢复、非激活场景重载扰动、采集失败与租约重试、文件切换暂停状态、WS 草稿重复、历史规则筛选、MCP 摘要大小和代理状态等问题，并补回归。最终测试使用仅含 Scene 暂存内容的隔离快照。
- 隔离真实 Dart 3.13.7 Debug VM 的 WS/WSS 均通过，每种 122 条消息、400 条预期队列遗漏、无警告；覆盖采集模式手动消息、replace/drop、MCP 链路、租约过期与卸载。不是 Flutter 设备或 IDE GUI 验收。
- 代理 40 项发现、19 项通过、21 项因缺 MITMDUMP 跳过。本轮未执行真实 IDE / Flutter 设备场景恢复验收；按后续授权本地提交，未安装、发布或推送，版本不变。

## 本地早期 0.0.11 更新与 Cursor 安装（合并前历史）（2026-11-12）

- 用户要求更新新版本并安装 Cursor，沿用已确认的补丁递增与本地 VSIX 流程；工作区原本干净，0.0.11 功能沿用 0.0.10。manifest、lockfile、MCP 版本、README、CHANGELOG 与打包路径已同步。
- 类型、全仓格式、构建与打包通过，402 项 Vitest 全部通过。首次沙箱运行因本机监听限制失败，允许测试监听后全量通过；此次仅版本与文档变更，未重跑 UI 或真实 Flutter/IDE GUI 验收。
- Cursor CLI --force 安装成功；28 个分发文件与源码/构建、VSIX、安装目录逐项一致（manifest 排除 Cursor 元数据）。构建与安装桥接真实 SDK stdio 均验证 0.0.11、21 工具、25 Prompts、5 资源及离线指南。
- 安装包 artifacts/flutter-pilot-0.0.11.vsix，报告 artifacts/v0.0.11-install-report.json。未自动重载用户窗口；需方便时执行 Developer: Reload Window 加载新版。此次未提交或推送。

## 0.0.10 发布与 Cursor 安装（2026-11-11）

- 用户要求发布新版本、推送GitHub并安装Cursor，沿用记忆中的补丁版本与VSIX流程，包含API规则配置标签、API最新详情自动刷新及Mock运行时恢复修复。manifest、lockfile、MCP版本、README、CHANGELOG与打包路径统一0.0.10。
- 类型检查、全仓格式、构建与打包通过；402项Vitest、53项Playwright全部通过。首次沙箱单测因本机监听受限失败，允许测试监听后全量通过。
- Cursor CLI --force安装成功，28个分发文件与当前源码/构建、VSIX及安装目录逐项一致，manifest仅排除Cursor安装元数据。构建和安装桥接均通过真实SDK stdio：0.0.10、21工具、25 Prompts、5资源及离线指南。报告artifacts/v0.0.10-install-report.json，安装包artifacts/flutter-pilot-0.0.10.vsix。
- 发布前fetch确认origin/main与HEAD一致；按授权提交main并常规推送origin/main。不发布商店、不启动IDE GUI、不强制重载窗口。用户活动窗口需方便时Reload Window并重连MCP；真实IDE热重启恢复尚未复验。

## Mock 接入状态与 API 最新详情（2026-11-11）

- EXIO 最新未命中记录的最终响应确为INDIVIDUAL，较早同规则存在MARKET_MAKER命中；重载原有规则后，通过正常账户页导航触发的新请求，mocked=true、requestRuleId=account-market-maker、最终userType=MARKET_MAKER，RWA列表警告恢复。未修改账户Mock正文或业务代码，不能据此断言每个启动首请求都会被拦截。
- `reloadHistory` 同步已选API最新记录，按API标识及请求代次保护异步回写；历史单次详情保持固定，删除当前API清除选择。补新请求后INDIVIDUAL→MARKET_MAKER更新、切换历史时迟到正文不覆盖的集成测试。
- VM Isolate更换即清除旧instances，自动为仍开启的Mock重新接入；同步失败及心跳失败清计数并恢复观察，旧Isolate在途同步结果不能回写成功。新增外部重启自动恢复及同步失败状态测试，旧实现两项失败、修复后通过。
- 修复副本完整402项Vitest通过，相关5文件103项通过，TypeScript（含Webview）、修改文件格式及构建通过。新源码尚未加载到用户活动Cursor窗口，未自动安装或重载。

## API 规则配置 tag（2026-11-11）

- webview/api-rules.ts 按启用规则的方法、域名与 fnmatch 路径匹配目录，按类型和是否附加条件聚合，优先级稳定排序。提取原 VM globRegex 至 src/glob.ts 共用，保留原导出与运行时行为。
- API 列表域名旁显示首类及 +N，概览展示全部类别；tooltip 含名称、优先级及条件字段名，不展示请求头值。条件以虚线边框和“条件”文字标识，提示实际命中按阶段优先级且需开启运行时功能。
- 类型检查、构建、12 项相关 Vitest 与 46 项工作台 Playwright 全部通过；修改文件 Prettier 与 git diff --check 通过。首次 UI 测试受沙箱本机监听 EPERM 限制，允许本机测试服务器后通过。覆盖规则编辑、启停、删除、无历史、各操作类型、通配符及查询/请求头条件。
- artifacts/api-rule-tags-{1280,680,390}.png 为合成截图；已目视检查 1280 和 390，tag 可见、无横向溢出、保持紧凑。未运行真实 IDE/App 验收，未打包、安装或提交。

## 0.0.9 发布与 Cursor 安装（2026-11-11）

- 用户授权提交全部当前改动、发布新版本、安装 Cursor 并推送远端；manifest、lockfile、MCP serverInfo、README、CHANGELOG和VSIX路径同步为0.0.9，交付API请求与历史独立Tab及全宽列表。
- 本次布局已通过394项Vitest、51项Playwright；版本升级后类型、全仓格式、构建及VSIX打包通过，CLI安装0.0.9成功。28个分发文件与当前源码/构建、VSIX及安装目录逐项一致，manifest仅排除Cursor安装元数据。
- 构建及安装桥接均通过真实SDK stdio握手：版本0.0.9、21工具、25 Prompts、5资源及离线指南。安装报告 artifacts/v0.0.9-install-report.json，安装包 artifacts/flutter-pilot-0.0.9.vsix。
- 已fetch确认远端origin/main与发布前HEAD一致；本次授权在main提交并常规推送，不发布扩展商店。不启动IDE GUI、不强制重载窗口；当前Cursor窗口需用户方便时Reload Window加载新版。

## API 与历史独立 Tab 及全宽请求布局（2026-11-11）

- 顶级拆分“API 请求”“请求历史”。API 默认全宽紧凑列表，宽容器约37px/条，窄容器约52px/条；历史宽容器约35px/条，窄容器67px/条。未选中不占用详情空白区，点击后宽屏分栏、760px及以下切单栏详情，关闭恢复完整列表。
- API 详情展示目录统计与最近完整请求，新增 api.select 按准确方法/主机/路径仅取最新记录再读取正文，不修改历史查询/分页；“查看调用历史”显式跳转筛选。selectedSource 保证异步详情按 Tab 来源分发，同请求编辑同步，清空清除两处缓存详情。
- 沿用搜索、高级筛选、历史清空/删除/备注、JSON/原文、规则草稿及目录删除语义；移除同页三栏、折叠目录及互相冲突的响应式规则。README、CHANGELOG及需求记忆已更新。
- 类型、构建、格式和 diff 检查通过；394项 Vitest、51项 Playwright 全部通过，覆盖最新API详情、查询隔离、空历史、窄屏密度/点击/关闭、Tab异步回写与清空。首次沙箱全量测试因回环监听 EPERM 失败，允许本机测试监听后全量通过。
- 已目视检查浅色示例数据截图 artifacts/{api-request,request-history,api-detail,history-detail}-light-{1280,680,390}.png，以及1280/760/680/390深色布局；无横向溢出。1280可直接看到18条，390 API约14条、历史10条。截图生成记录 artifacts/http-layout-screenshot-report.json。
- 版本保持0.0.8；此次未提交、安装新包或重载用户Cursor，未进行IDE GUI验收。

## 0.0.8 发布与规则卡片紧凑布局（2026-11-11）

- 用户确认两行规则卡片，首行名称、类型、优先级与操作，第二行方法/URL；桌面约 64px、390px 窄窗口约 87px，长地址省略并提供完整 title，保留开关和全部操作。截图 artifacts/rules-compact-{1280,680,390}.png 已检查。
- manifest、lockfile、MCP serverInfo、README、CHANGELOG 和 VSIX 包名统一 0.0.8，包含 API 转发与历史列表增量。
- 类型、格式、388 项 Vitest、42 项 Playwright、40 项 Python（含真实代理）及 22 项真实 Dart/Dio VM 检查通过。
- Cursor CLI 安装成功，28 个安装文件与 VSIX 逐项一致（manifest 排除 Cursor 元数据）；报告 artifacts/v0.0.8-install-report.json。不强制重载用户窗口；用户方便时 Reload Window 加载新版。

## API 转发路径与私有接口凭证（2026-11-11）

- redirect.url 支持 /path 与完整 HTTP/HTTPS URL，代理及 VM 一致：路径默认保留原查询串，显式 ? 覆盖或清空；完整 URL 全量替换。真实发送并保留方法、正文和鉴权头，跨源仅调整 Host；request.url 原行为保留。
- 表单、MCP 指南和 README 同步，校验拒绝协议相对地址、反斜杠、fragment、空白控制字符及内嵌凭证。真实 HTTP 服务验证跨源 Authorization/Cookie/Proxy-Authorization、正文、方法、原请求响应规则匹配、重复及编码查询参数。
- 类型检查、构建、387 项全量 Vitest 通过，随后增加查询参数含 @ 的校验回归，model 41 项通过；40 项 Python 测试（含 21 项真实代理集成）、真实 Dart/Dio VM smoke 与新增表单 Playwright 通过。首次表单测试使用旧 dist 失败，构建后通过。
- 未打包安装或提交；需要加载新版扩展后才会在用户 IDE 生效。业务签名如包含原 URL，保留签名头不代表新 URL 能通过服务端签名校验。

## HTTP 历史清空入口与紧凑列表（2026-11-11）

- 将高级筛选中的清空入口移至排序说明旁，常驻“清空记录”；复用 history.clear 确认流程，提示清空当前项目全部 HTTP 历史（包含筛选外记录），保留独立 API 目录及 Mock 规则。筛选结果为空仍可操作，繁忙时禁用。
- 请求行合并方法、路径与状态，保持域名、时间与耗时，共三行；路径和域名省略并提供悬停信息，固定内容高度不随长路径增长，禁止 flex 纵向压缩。
- 构建、类型/格式及 diff 检查通过；42 项扩展测试、40 项 Playwright UI 测试通过，覆盖取消/确认清空、清除详情、空筛选及繁忙状态、1280px/390px 布局。合成截图 artifacts/history-compact-{1280,390}.png 已目视检查，每条约 67px，桌面窗口完整展示至少 8 条。
- 本轮仅修改与验证代码，未提交、打包安装或重载用户 Cursor；版本保持 0.0.7。

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

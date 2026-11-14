# 验收记录

## 0.0.21 发布验证（2026-11-14）

- 交付 Cursor MCP 项目 / 全局适配、JSONC 配置和实际客户端握手，以及 Mock 场景页各区块 / 操作运行结果展开与收起。源码版本、lockfile、README / CHANGELOG 与 VSIX 路径同步为 0.0.21；下方“源码未发布”条目为发布前历史记录。
- 本轮 777 项 Vitest / 46 文件、99 项 Playwright、TypeScript / Webview 类型、全仓格式、构建和 diff 检查通过，独立只读审查无待修复问题。日志 `artifacts/v0.0.21-{unit,ui,typecheck,format,build}.log`；场景和 MCP 宽窄布局、键盘折叠、输入 / 草稿保留及新建自动展开均在工作台回归范围内。
- `artifacts/flutter-pilot-0.0.21.vsix` 经 Cursor CLI `--force` 安装；包、当前源码 / 构建与安装分发文件逐项一致，安装构建包含 Cursor 适配和场景折叠。构建 / 安装 / 固定桥接的 SDK stdio 离线发现并读取 51 工具、59 Prompts 与 6 份指南，验证版本、图标、Cursor 导航及指南工具 / 资源一致性，证据 `artifacts/v0.0.21-install-report.json`。
- main 与附注标签 v0.0.21 常规推送并核验远端引用，记录 `artifacts/v0.0.21-release-report.json`。不自动重载活动 Cursor 窗口或重启现有 MCP 客户端；用户在方便时 Reload Window 并重连客户端生效。本轮未操作业务 App / 设备、修改真实 Agent 配置或执行实际 Cursor Agent 端到端，沿用既有业务与设备验收边界。

## Mock 场景页全部区块展开与收起（2026-11-14，源码未发布）

- 运行状态、场景列表、场景详情、UI 操作、HTTP 规则、WS 规则均有独立标题开关，与已有运行结果折叠配套；默认展开。收起保留标题 / 数量 / 来源，当前激活与分域错误摘要持续可见；搜索、操作参数、名称、模板状态及 WS 草稿保持挂载，新建规则会展开对应编辑区。
- 全量 99 项 Playwright、类型、全仓格式、构建和 diff 检查通过；两份场景测试 32 项通过。测试覆盖鼠标 / Enter / Space、同场景刷新、独立折叠不发业务消息、新建自动展开、草稿与筛选保留、1280 / 390px 布局及规则末尾滚动。独立只读审查无待修复项。
- 日志 `artifacts/scene-panels-collapse-{ui,typecheck,format,build}.log`、`artifacts/scene-panels-collapse-related-ui.log`；已目视检查合成截图 `artifacts/scene-http-collapsed-{1280,390}.png`。本轮保持 0.0.20，未提交、发布或安装，未操作真实 IDE 或业务 App / 设备。

## 场景操作结果折叠（2026-11-14，源码未发布）

- 点击运行记录标题可展开 / 收起消息、耗时、诊断和步骤；名称、状态、操作来源与本轮 Mock 始终显示。默认展开，同一运行刷新保持选择，新运行重新展开；运行中取消与单步调用路径展开独立可用。
- 16 项 Scene 工作台 Playwright、类型、全仓格式、构建与 diff 检查通过。覆盖 Enter / Space、1280 / 390px 无横向溢出、同轮刷新、新运行、嵌套步骤与收起时取消。已目视检查合成截图 `artifacts/scene-run-{collapsed,expanded}-{1280,390}.png`，日志 `artifacts/scene-run-collapse-{ui,typecheck,format,build}.log`；独立只读审查无待修复项。
- 本轮仅验证源码与合成工作台，版本保持 0.0.20，未发布安装，也未操作真实 IDE 或业务 App / 设备。

## Cursor MCP 适配（2026-11-14，源码未发布）

- MCP Agent 适配增加 Cursor，支持项目 `<workspace>/.cursor/mcp.json` 与全局 `~/.cursor/mcp.json` 的 `mcpServers` stdio 配置，以及一键适配、重新检测、打开配置、显式修复和自有条目移除。JSONC 注释 / 尾逗号、其他服务 / 设置保留、缺省 stdio type、配置冲突、符号链接拒绝和范围隔离均有回归。
- 核对本机 Cursor 3.29.15 的实现后，Cursor 项目 / 全局同名 stdio 条目按可能分别加载处理，两个范围同时存在时提示检查重复；实际连接仅接受 `cursor-vscode` 且范围对应的握手。配置成功、桥接自检与目标客户端实际连接分别显示，不以检测到客户端或自检通过替代实际握手。
- 最终 777 项 Vitest / 46 文件、93 项 Playwright、TypeScript / Webview 类型、全仓格式及构建通过；JSONC 最后调整后的相关 4 文件 147 项通过。日志为 `artifacts/cursor-adapter-{unit,ui,typecheck,format,build}.log` 和 `artifacts/cursor-adapter-final-related.log`。独立只读审查未发现遗留问题。
- 扩展消息测试通过隔离 home / workspace 与真实 MCP SDK stdio 覆盖项目 / 全局适配、自检、打开、移除、错误客户端名 / 范围拒绝、正确握手和断连清理；离线指南 / Prompt 测试覆盖 `overview.agentAdapters`、`capabilities` 与同名 `get_usage_guide` 的 Cursor 导航，读取不触发运行时。工具、Prompts、指南仍为 51 / 59 / 6。
- 工作台测试覆盖四卡片、项目 / 全局操作、冲突修复、配置与连接状态区分和繁忙禁用。已目视检查 `artifacts/mcp-cursor-1280.png` 与 `artifacts/mcp-cursor-390.png` 合成截图，宽屏 2 × 2、窄屏堆叠且无水平溢出。
- 本轮为源码实现，版本保持 0.0.20，未提交、发布或安装；当前已安装的 0.0.20 尚无本功能。没有修改真实用户 Agent 配置、启动 IDE GUI、调用实际 Cursor Agent 或操作业务 App / 设备，SDK 协议和合成界面通过不构成真实 Cursor Agent 端到端或业务验收。

## 0.0.20 发布验证（2026-11-14）

- 正式发布 MCP 十类任务映射、截图优先入口 / 离线指南与插件 / MCP 图标。源码、lockfile、安装说明和 VSIX 路径同步为 0.0.20；本地 `.flutter-pilot/` 状态保留且不进入提交或安装包。
- 本轮 763 项 Vitest / 46 文件、89 项 Playwright、类型、全仓格式、构建与 diff 检查通过；Python 代理 28 项通过、23 项真实代理集成因缺少 `MITMDUMP` 跳过。修改后的设备 / IDE smoke 脚本仅做 Node 语法检查。日志为 `artifacts/v0.0.20-{unit,ui,typecheck,format,build,proxy}.log`。
- `artifacts/flutter-pilot-0.0.20.vsix` 经 Cursor CLI `--force` 安装成功，47 个分发文件与源码 / 构建及安装目录一致；离线 SDK stdio 验证构建、安装及固定 bridge 的版本、初始化截图说明和 PNG 图标，全部 51 个工具、59 个 Prompts 和 6 份指南均可发现 / 读取，指南工具与资源内容一致。核验报告为 `artifacts/v0.0.20-install-report.json`。
- main 提交及 v0.0.20 附注标签按约定常规推送，远端引用核验另见 `artifacts/v0.0.20-release-report.json`。未重载活动 Cursor 窗口或重启已有 MCP 客户端；用户方便时重载窗口并重连客户端生效。
- 本轮不操作真实设备 / 业务 App，也不调用实际 Agent 模型，不将离线发现与界面回归作为业务通过或客户端必然遵循任务引导的证明；启动首请求、完整地址恢复、资金及真机边界沿用下方记录。

## MCP 功能介绍与截图优先引导（2026-11-14）

- 现有 51 个工具按 10 类任务提供用户措辞、功能入口和实际前提；初始化 `instructions`、`overview.capabilityRoutes` 与 `capabilities` 共用类型化映射。新增 `app_screenshot` Prompt 和 `screenshot` 指南，现为 59 Prompts / 6 指南；全部同名工具 Prompt 保留生产参数 schema。
- 修正启动后无条件推进 Mock/Scene、只读与截图共用交互准备、Flutter Key 诊断误导原生参数，以及设备/IDE smoke 固定旧数量。普通截图只需会话和 VM，长图明确滚动目标，设备整屏显式 source；桌面/网页等目标不误导至 Flutter Pilot。
- 763 项 Vitest / 46 文件、5 项 MCP 工作台 Playwright、TypeScript/Webview 类型、全仓格式、构建和 diff 检查通过。日志为 `artifacts/mcp-task-routing-{unit,ui,typecheck,format,build}.log`。设备和 IDE smoke 修改仅通过 Node 语法检查，未启动设备或 IDE。
- 构建桥接真实 SDK stdio 在无 IDE 注册目录通过：初始化即收到截图优先说明、全部工具被映射、59 个 Prompts 与6个资源均可读取、无运行会话；报告 `artifacts/mcp-task-routing-dist-smoke.json`。协议夹具另证实会话发现后可仅派发一次 Flutter screen 截图并返回 MCP image 内容，离线查阅不转发运行时操作。
- 本轮验证能力发现与协议，不操作真实 App/设备、不调用实际 Agent 模型；客户端是否遵循路由仍需实际加载后观察。版本保持 0.0.19，当前 IDE/Agent 要加载包含本次改动的插件并刷新或重连后生效，未安装或发布。

## 0.0.19 发布验证（2026-11-14）

- 正式交付此前 0.0.18 本地安装版及后续公共操作归档、离线能力导航和等待失败诊断；发布版本、安装说明、lockfile 与 VSIX 路径统一为 0.0.19。
- 758 项 Vitest / 46 文件、89 项 Playwright、TypeScript / Webview 类型、全仓格式、构建及 diff 检查通过。Python 代理 28 项通过、23 项真实代理集成因缺少 `MITMDUMP` 跳过。日志为 `artifacts/v0.0.19-{unit,ui,typecheck,format,build,proxy}.log`。
- 安装包为 `artifacts/flutter-pilot-0.0.19.vsix`，采用 Cursor CLI `--force` 安装；包内文件与源码 / 构建、安装目录一致性及两个 MCP bridge 的离线 SDK stdio 结果见 `artifacts/v0.0.19-install-report.json`。核验包括 0.0.19 服务版本、51 个工具、58 个 Prompts、5 个指南资源、全部同名 Prompt 及离线指南读取。
- 发布使用 main 提交及 v0.0.19 附注标签并常规推送；远端引用记录于 `artifacts/v0.0.19-release-report.json`。用户在方便时执行 Developer: Reload Window 加载新版；本轮不重复真实设备业务验收，启动首请求、完整地址恢复、资金流程及真机边界仍按下方记录。

## 手动 Scene 超时诊断与现场恢复（2026-11-14）

- 原 `open_home` 失败于首步 `wait_app_shell`，0/4 步、30173 ms。14:22:05 资料请求及 14:22:06 刷新请求未命中 Mock，均返回 401；14:22:12 开始的导航无法等到 App shell。现场查询确认 `registrationLogin.page.root` 与 Switch account 可见。不能仅凭这些记录确定漏拦截由重启首请求还是宿主暂停 / 租约失效引起。
- 重载原 40 条规则后按实际页面显式复用 `switch_account_login_to_home`，15/15 步、4091 ms；本轮 18 次请求 / 17 个唯一接口全部 Mock，无新真实 401。原 `open_home` 再运行 4/4 步、271 ms，独立确认 `home.page.root` 可见，当前 Mock 保持不变。摘要证据见 `artifacts/scene-timeout-recovery-2026-11-14.json`。
- 等待失败的源码诊断与工作台展示分别保留运行快照中的选择器、条件及最后观测，并区分目标未找到与状态未满足。现场恢复使用当前已安装扩展；新诊断源码尚未安装到活动 IDE。没有重启 App、清数据、修改业务源码或新增 Mock；冷启动完整拦截、完整地址恢复和资金流程不在本轮通过范围。
- 全量 754 项 Vitest / 46 文件通过；最后补齐原生定位抛错诊断后，相关 5 文件 135 项通过，覆盖原生歧义 / 失效引用立即失败、未知存在状态、取消语义及候选不外泄。14 项 Scene 操作 Playwright、TypeScript / Webview 类型、全仓格式、构建和 diff 检查通过；390 / 1280px 合成失败报告截图已目视确认，无水平溢出。

## MCP 能力与 Prompts 发现更新（2026-11-14）

- 增加 `capabilities`、`scene_action_quick_run`、`scene_action_authoring` 三个入口，现共 58 个 Prompts / 51 个工具。能力目录从当前工具注册表生成，同名 Prompt 继续包含生产参数 schema；`overview`、初始化说明、README 和 MCP 文档同步导航。只查阅能力无需任务、IDE 或 sessionId，不触发运行时操作。
- 补充 App 启动 / 复用、Scene 自动与手动执行、真实 Key、键盘稳定确认、公共操作归档及 Test Case v2；等待诊断可从直接等待、Scene 运行和测试步骤的同名 Prompt 查询。Flutter VM 操作不强制准备设备通道。
- 全量 753 项 Vitest / 46 文件、类型、格式、构建及 diff 检查通过。真实 SDK stdio 在离线注册目录验证 `prompts/list` / `prompts/get`，58 个模板可读取，能力目录覆盖全部工具；证据为 `artifacts/mcp-capability-{unit,typecheck,format,build}.log` 和 `artifacts/mcp-capability-dist-smoke.json`。本节仅记录 MCP 发现与指引验证，不新增设备业务验收。

## Scene 联调经验与操作归档（2026-11-14）

- 根 `AGENTS.md`、`docs/scene-authoring.md` 及项目记忆固定了已有会话 / 动作优先、真实 Key、键盘确认、请求基线、后台初始化查漏和结果未确认不重放等约束。MCP 初始化、工具描述、同名 Prompt 与离线 `workflow.quickRun` 同步，动作目录仅索引，运行配置仍唯一来自业务 `scenes.json`。
- 随包示例归档邮箱公共核心、首次入口、最近账号入口与已有会话返回主页；生产 schema / 编译器回归覆盖全部动作、15/15/4 展开、调用参数与秘密传播。Wali 新增纯操作 `wali_common_operations`，保留原三个业务入口、40 条 Mock 和激活选择，原子工具、选择器及参数逐项等价，报告为 `artifacts/wali-scene-action-archive-preflight.json`。
- 配置重载后，iPhone 17 分别直接运行公共 `open_home`、从业务入口跨 Scene 调用公共 `open_home`，均 4/4 完成；独立确认主页可见，实际激活 Mock 仍为 `wali-wallet-logged-in`，40 条规则保持应用。证据为 `artifacts/wali-action-archive-{public-result,entry-result,home,network-status}.json`。本轮不重新登录、不重启 App，15 步登录实测沿用下方归档前的等价动作证据。
- 归档后全量 740 项 Vitest / 45 文件、23 项 Scene / 操作工作台测试、类型、格式及构建通过，独立子代理联合复审通过。地址 probe 的有意 Mock 503、启动首请求窗口及未验收资金 / 完整地址恢复范围保持。

## 0.0.18 Scene 滚动、Key 操作与 Wali 登录（2026-11-14，本地安装）

- Scene 详情恢复连续滚动；UI 操作（Workflow）支持手动选择、参数、通道、步骤 Key 预览、运行、进度、取消及配置重载。真实 Cursor 工作台已滚动至 WS 规则末尾，并从钱包页手动运行 `open_home`，4/4 步完成，保留当前 Mock；证据为 `artifacts/wali-v18-manual-home-result.json`。
- `steps[].target` 在编译时解析为所属 Scene 的 `targets` 选择器。Wali 的 11 个目标均绑定真实 Flutter Widget Key，执行时重新精确匹配已挂载控件，无需 Agent 再探索；缺失、重复、禁用和遮挡仍按现有契约拒绝或等待。真实底栏 Key 修复后 Home 可操作，Wallet Key 点击已验证。
- iPhone 17 模拟器使用已保存的 `wali_app (Flutter Pilot)` Debug 配置启动，复用正式启动、认证及路由。`switch_account_login_to_home` 的 15 步登录已完成，含邮箱输入、稳定收起键盘、验证码及主页等待；独立查询 `home.page.root` 可见，验证码、登录、资料均命中 Mock 200。证据为 `artifacts/wali-v18-login-result.json`、`artifacts/wali-v18-home.json` 及对应 HTTP 记录。
- Wali Scene 补齐为 40 条 HTTP 规则，覆盖账号详情、地址、组合、余额、活动、扫描及恢复任务通知；FUNGIBLE refresh 采用兼容响应。地址 probe 明确模拟 503 并退避，避免本登录场景伪造依赖请求内容的地址恢复结果；完整地址恢复与单独 NFT 刷新不在本轮范围内。
- 最终 40 条配置加载后直接运行操作，15/15 步约 4.4 秒完成，独立确认主页可见；本轮验证码、登录、资料及主页初始化新请求全部命中 Mock，未再出现真实 401 / 刷新循环。地址 probe 命中上述有意设置的 Mock 503。结果与请求证据为 `artifacts/wali-v18-final40-{result,home,network}.json`；这是本轮观察结果，不代表长期压力或完整资产恢复验收。
- 独立子代理审查并修复启动配置身份、取消竞态、按钮子区域手势归属、真实注入库可见符号及测试初始化竞态。最终 734 项 Vitest / 44 文件、86 项 Playwright、类型、格式、构建和打包通过；生产 VM 模板另以 Wali Flutter SDK 验证，Wali 底栏 9 项 Widget 测试通过。
- 本地 VSIX 为 `artifacts/flutter-pilot-0.0.18.vsix`，已安装 Cursor。激活或重载 Scene 不会自动执行操作；Agent 显式调用 `start_app`、激活 Mock 和 `run_scene_action`，工作台也可手动运行。启动首请求可能早于 VM 注入，需在操作前同步并检查 Dio 接入及本轮请求；不宣称冷启动全部请求已拦截。Android、真机、创建钱包、签名和资金操作未在本轮验收。

## 0.0.17 Scene 操作与 Workflow 合并（2026-11-14）

- `scenes.json` 成为 Mock、共享 targets 和多个命名 actions 的唯一配置来源；纯 Mock、纯操作、targets-only 与跨 Scene 子操作均支持。操作来源与当前 Mock 独立，激活、重载、重连和 IDE 恢复不重放 UI。
- 工作台操作入口并入 Scene 详情，MCP 改用 Scene action 工具；Test Case v2 显式引用操作并保留 HTTP / WS / UI 断言、事件及临时环境清理。旧 workflows.json 保留但不再读取或创建，旧测试格式明确报错。
- 独立子代理完成核心、运行时、测试、UI、协议及文档审核；已修复 secret 默认值暴露、测试等待设备锁时的环境变更、排队启动与连接设置绕过运行锁、参数重载残留和名称规范化问题。
- 发布 UI 检查发现的场景重命名初始化竞态已修复，原失败用例连续执行 20 次通过。
- 发布验证：689 项 Vitest / 42 文件、82 项 Playwright，TypeScript / Webview 类型、格式、构建及 diff 检查。设备业务 E2E 沿用既有验收边界，本轮未重复真机验收。
- 本地 VSIX、Cursor CLI 安装及 main / 附注标签 v0.0.17 推送沿用既有发布流程。安装包为 `artifacts/flutter-pilot-0.0.17.vsix`，包与安装文件一致性及离线 MCP 握手结果记录于 `artifacts/v0.0.17-install-report.json`。活动 Cursor 窗口在方便时执行 Developer: Reload Window 加载新版。

## 0.0.16 API 请求与请求历史合并（2026-11-13）

- API 请求统一使用历史数据源，每次调用分别展示，保留搜索、组合筛选、30 条分页、单次详情、备注标签、删除、清空和生成 Mock；底层目录统计与 MCP 接口兼容。
- 独立审核发现的快速切换异步详情覆盖已修复，成功与失败两条回归验证旧详情及操作不会保留；同时覆盖清空后详情重置与末页删除后的页码回退。
- 发布版本下 664 项 Vitest / 42 文件、77 项 Playwright 全部通过；TypeScript / Webview 类型、全仓格式、构建与 diff 检查通过。UI 用例覆盖 1280、760、680、390px 和明暗主题。
- 版本与 VSIX 为 0.0.16，附注标签为 v0.0.16；沿用本地 VSIX、Cursor CLI 安装与 main / 标签常规推送流程。包与安装文件一致性及离线 MCP 握手核验报告路径为 `artifacts/v0.0.16-install-report.json`，安装包为 `artifacts/flutter-pilot-0.0.16.vsix`。
- 本轮验证使用合成请求与隔离 MCP 注册目录；真实设备、业务 App 和代理引擎沿用既有验收边界。活动 Cursor 窗口需在方便时执行 Developer: Reload Window 加载新版。

## 0.0.15 Workflow、业务测试与移动交互发布（2026-11-13）

- 完成本轮全部改动与新增文件的审核，修复 8 项问题并补充回归；详细范围、缺陷与验证边界见 [0.0.15 审核记录](review-0.0.15.md)。
- 664 项 Vitest、74 项 Playwright、28 项 Python 代理测试通过；23 项真实代理集成因缺少 `MITMDUMP` 跳过。类型、格式、构建与 diff 检查通过；独立 Dart / Dio 5.11.1 smoke 的 32 项检查通过。
- 版本与 VSIX 统一为 0.0.15，附注标签为 v0.0.15；沿用本地 VSIX、Cursor CLI 安装和常规推送流程，安装一致性与 SDK stdio 核验记录在 `artifacts/v0.0.15-install-report.json`。用户可在调试方便时执行 Developer: Reload Window 加载新版。
- 下方章节保留各次验证时的源码、发布和设备状态；移动交互随本版发布，本轮未重复设备业务 E2E。

## 移动交互扩展与审查修复（2026-11-13，源码未发布）

- Flutter VM + 私有 Appium 双通道，42 个 MCP 工具、46 个 Prompts；版本保持 0.0.14，未发布、提交、推送或安装扩展。
- 六项审查问题已修复：WDA 启动清理所有权、编辑菜单目标归属、MCP 宿主长操作期限、Unicode 字符簇边界、原生 append 语义和 VM 长图实际设备租约。适配器升级 v3，旧 v2 环境需重新准备；原生 append 明确不支持，Flutter 追加显式使用 `backend=flutter`。
- 类型检查、505 项 Vitest / 34 个文件、70 项 Playwright、构建、格式与 diff 检查通过。Vitest 的生产注入模板包装用例内部另有 25 项实际 Dart / Flutter 测试通过，不与 505 项相加。Python 代理 42 项发现，21 项通过，21 项缺 `MITMDUMP` 跳过。
- 独立 iPhone 17 / iOS 26.5 模拟器 `FlutterPilot-Automation-Fix-Fixture` 通过真实 SDK MCP stdio → bridge → IPC → VM / Appium，152 / 152 项通过，`completed=true`、`nativeRequested=true`，测试进程清理无错误；覆盖业务排序／删除、多指值、Unicode 整簇编辑、formatter、原生菜单错字段拒绝、原生追加拒绝、真实权限弹窗、系统导航、嵌套滚动、旋转重新定位及取消后继续输入。
- 真实未缩时 Unix IPC 中，50 秒 setup／connect 模拟处理分别在 50004／50003ms 完成，取消只中止一次且不重放，报告 `artifacts/mcp-long-operation-fix-report.json`。此前 107 项设备检查、477 项 Vitest / 31 个文件及适配器 v2 仅为修复前基线。
- Android 无可用设备，iOS 真机未提供专用验收设备及预签名 WDA，均未验收；已配对的用户真机未连接或操作。四类设备逐项矩阵、限制与发现问题见 [移动交互验收表](mobile-automation-validation.md)。
- 设备输入不自动重放，菜单归属／选区或坐标映射无法确认时拒绝执行。逐项设备结果见 `artifacts/automation-flutter-smoke-report.json`；其 `fixtureSourceHash` 仅覆盖 Dart `main.dart`，不含 Swift 或测试脚本。独立模拟器、私有环境及进程清理证据见 `artifacts/automation-fix-cleanup-report.json`，最终证据汇总见 `artifacts/automation-fix-validation-evidence.json`。

## 0.0.12 远端同步、标签与 Cursor 安装（2026-11-12）

- 合并远端 Mock 场景与 App 截图，并保留本地安装记录。manifest、lockfile、MCP serverInfo、README、CHANGELOG 与 VSIX 命名统一为 0.0.12。
- 发布回归：440 项 Vitest、63 项 Playwright 全部通过；TypeScript / Webview 类型检查、Prettier 与构建通过。Python 代理发现 40 项，19 项通过，21 项因未设置 MITMDUMP 跳过。
- Cursor CLI `--force` 安装成功，扩展列表为 `flutter-pilot.flutter-pilot@0.0.12`。VSIX 内 29 个分发文件与安装目录逐项一致，`package.json` 仅排除 Cursor `__metadata`；安装目录另有 `.vsixmanifest`。`extension.js`、`mcp-bridge.cjs`、`webview.js`、`webview.css` 与当前构建 SHA-256 一致。
- 构建与安装桥接的真实 SDK stdio 均返回 flutter-pilot 0.0.12、23 个工具、27 个 Prompts、5 个资源，并读到离线指南。安装包为 `artifacts/flutter-pilot-0.0.12.vsix`，校验值与文件一致性见 `artifacts/v0.0.12-install-report.json`。
- 附注标签为 v0.0.12。未发布扩展商店，未自动重载当前窗口。真实 IDE 保存对话框、Android / iOS 真机和完整 Scene 的设备恢复验收仍沿用下方既有边界，本轮没有重复。

## 0.0.11 本地 VSIX 发布（2026-11-12）

- 统一发布 HTTP / WebSocket Mock 场景与 App 当前屏幕 / 滚动长截图；manifest、lockfile、MCP serverInfo、README、CHANGELOG 与 VSIX 命名统一为 0.0.11。
- 本轮发布回归：440 项 Vitest、63 项 Playwright 全部通过，TypeScript / Webview 类型检查、Prettier、构建和 diff 检查通过；Python 代理 19 项通过、21 项因未设置 MITMDUMP 跳过。
- 截图实现阶段已有独立 Flutter 3.47.8 / iOS 模拟器 57 项检查，报告 `artifacts/ui-flutter-smoke-report.json`：包含当前屏幕、804 × 9082 完整长图、原位置恢复、取消恢复、多区域枚举、过期目标和超限拒绝，fixture 源码哈希未变。本轮发布没有重复设备验收。
- 安装包为 `artifacts/flutter-pilot-0.0.11.vsix`。本次沿用本地 VSIX 与 origin/main 常规推送流程；未安装用户 Cursor、未发布扩展商店。真实 IDE 保存对话框、Android / iOS 真机和完整 Scene 的设备恢复验收边界仍见下方记录。

## HTTP / WebSocket Mock Scene（2026-11-12，源码未发布）

- 版本保持 0.0.10。429 项 Vitest、61 项 Playwright、TypeScript / Webview 类型检查、Prettier、构建和 diff 检查通过。
- 三位子代理审查运行时、UI、MCP 与文档，发现的问题已修复并补回归；最终结果来自仅含 Scene 暂存内容的隔离快照，不包含并行截图功能。修复覆盖代理重启恢复、采集租约失败后恢复、非激活场景重载、历史筛选、WS 草稿、MCP 摘要与状态。首次单测早于快照构建导致 MCP 入口不可用，构建完成后全量复测通过。
- 合成运行时测试覆盖一次性默认场景迁移、重复初始化、非法文件与外部冲突、复制隔离、激活持久化、混合场景切换、未激活编辑、停用/删除、断线/重开恢复、同步失败、租约等待重试和快速切换。UI 覆盖场景管理、规则目标归属、状态、草稿保留及 390px / 1280px 布局；MCP 覆盖 23 个工具与 27 个提示词。
- 隔离真实 Dart 3.13.7 Debug VM 的 WS / WSS 回归通过，每种 122 条消息、400 条预期队列遗漏、无警告。覆盖采集模式下手动发送/推送、替换/丢弃、真实 SDK MCP stdio 链路、租约到期及卸载；复现命令 `npm run test:ws`。这项是 Dart 运行时验证，不是完整 Scene 的 Flutter 设备验收。
- Python 代理回归发现 40 项，19 项通过；21 项真实代理集成因未设置 `MITMDUMP` 跳过。代理场景仅应用 HTTP、混合场景 WS 不支持的状态由合成测试验证。
- 真实 IDE / Flutter 设备上的场景切换、重连和重开恢复尚未验收。没有操作用户业务 App、启动 IDE GUI、安装扩展、推送或发布；用户后续授权审查修复后本地提交。

以下历史章节为更名前各版本的验收证据。原始 VSIX 路径保留当时名称；复现命令中的环境变量已按当前 Flutter Pilot 脚本名称更新。历史通过结果不代表本次更名后的安装或设备验收已经执行。

## Flutter Pilot 更名验证（2026-11-11）

- 插件显示名、扩展 ID、命令与设置、MCP 服务与资源、项目目录、生成 helper、代理参数、运行时事件、文档及示例统一更名；采用直接切换，不读取旧名称配置。
- 357 项 Vitest、37 项 Playwright、TypeScript 类型检查、Prettier、构建及 diff 检查通过；Flutter 示例 3 项 Widget 测试通过。
- 真实隔离 Dart Debug VM 的 HTTP/Dio 注入验证 21 项通过；WS/WSS 采集、Mock、主动消息及 MCP 链路均通过，每种传输 120 条记录、400 条预期队列遗漏、无警告。
- Python 代理规则与存储 17 项通过，19 项真实代理集成因未设置 MITMDUMP 跳过。没有启动 IDE GUI、执行 Flutter 设备验收、安装扩展或修改真实 Agent 配置。
- 新安装包为 `artifacts/flutter-pilot-0.0.7.vsix`；版本保持 0.0.7，更名改动尚未发布。打包内容与 MCP 握手结果记录于 `artifacts/flutter-pilot-rename-report.json`。

## 0.0.7 本地发布（2026-11-10）

- 发布MCP全工具同名提示词：21个工具、25个Prompts、5份指南资源；manifest、lockfile、MCP serverInfo及VSIX命名统一为0.0.7。
- 357项Vitest、类型和格式检查通过。VSIX、安装文件一致性及构建/安装桥接的真实SDK stdio验证结果见`artifacts/v0.0.7-install-report.json`；本地包为`artifacts/flutter-api-mocks-0.0.7.vsix`。
- 本轮不启动IDE GUI、不访问钥匙串、不强制重载当前窗口；用户方便时执行Developer: Reload Window，再重连Agent MCP以加载全部提示词。

## MCP 全能力提示词覆盖（2026-11-10）

- 检查结果：热更新此前已出现在初始化说明、指南和场景模板正文中，但没有独立同名Prompt；现全部21工具均有同名提示词，并保留4场景模板，共25个。工具模板包含准备、执行、验证步骤及与生产工具共用的JSON Schema。
- 357项Vitest、类型、格式、构建及diff检查通过。真实SDK通过构建后的dist/mcp-bridge.cjs，在离线注册目录下发现21工具/25Prompts，逐个读取全部21工具模板，验证同名覆盖、参数schema和初始化说明中的能力名称；未转发运行时操作。报告：[提示词覆盖结果](../artifacts/mcp-prompt-coverage-report.json)。
- 新增工具遗漏同名模板会触发类型或协议测试失败。用户随后授权发布及安装0.0.7；未启动IDE GUI、未连接用户App或修改真实Agent配置。工具通过tools/list提供，Prompts为可选说明，不声称仅补提示词即可保证Agent主动使用能力。

## 0.0.6 本地发布与 Cursor 安装（2026-11-10）

- 本版本包含设置入口卡死修复、已有VM补查恢复、MCP热重载/热重启和Tab滚动条隐藏。manifest、lockfile、MCP serverInfo、README及VSIX包名统一为0.0.6。
- 354项Vitest、类型、格式、构建通过；37项Playwright沿用本轮已完成的界面验证，版本递增不修改UI逻辑。
- 本地VSIX：`artifacts/flutter-api-mocks-0.0.6.vsix`。Cursor CLI安装结果、包/源码/安装目录逐项一致性及真实SDK stdio握手见`artifacts/v0.0.6-install-report.json`。
- 未启动IDE GUI、未访问钥匙串、不强制重载窗口；在调试方便时执行Developer: Reload Window加载新版，再重连Agent MCP。用户真实窗口设置页与已有VM连接仍需实际复验。

## Cursor 设置卡死与已有 VM 补查修复（2026-11-10）

- 354项Vitest、37项Playwright、TypeScript/Webview类型、格式、构建和diff检查通过。
- 设置及本地引擎入口的命令URI、精确Webview白名单和不再走宿主RPC已验证；没有在本轮自动打开Cursor设置页，不能将浏览器测试视为Cursor GUI复验。
- 合成DTD服务覆盖首次查询超时、相同URI断线重连、订阅失败清理及公开API暂不可用后恢复。扩展整合用真实WebSocket传输模拟已有Flutter会话：首次Editor查询失败，打开工作台重查并自动连接，无需新启动事件，Dio Mock、WS采集及WS Mock仍关闭，认证地址不进入界面状态。
- 未启动IDE GUI、未连接用户Flutter应用、未覆盖安装；用户实际Cursor会话尚待复验。终端独立flutter run边界沿用原约定。

## MCP 热重载与热重启（2026-11-10）

- 348项Vitest、类型、格式和构建通过。覆盖工具参数、精确调试会话控制、DTD已有会话、无VM及手动地址诊断、取消、超时、关闭MCP、失败不误报、独立开关及重发现Mock。
- 独立Flutter3.47.8应用，SDK Debug Adapter及iPhone18Pro/iOS27.2模拟器，真实SDK MCP stdio和IPC调用验证14项。hot_reload应用源码且保留计数；hot_restart重置计数，新Isolate重新接入已开启Dio Mock；修改规则后重启，按Key请求并显示第二种数据，HTTP历史保留两次Mock命中证据；无变更及编译失败不报告成功。报告：[MCP热更新验证结果](../artifacts/mcp-lifecycle-flutter-report.json)。复现：设置VM_FLUTTER_DEVICE后执行npm run test:mcp:lifecycle。
- 未启动Cursor或VSCode GUI，未访问钥匙串、未修改或控制用户业务应用；已安装IDE真实会话、Android及真机未在本轮验收。启动请求可能早于Mock注入，不保证启动首请求已Mock。用户随后授权本地提交；未安装。

## MCP Prompts 与双向 WS 主动消息（2026-11-09）

- 324 项 Vitest（26 个文件）、TypeScript / Webview 类型检查、Prettier、构建和 diff 检查通过。标准 SDK stdio 验证 4 个 Prompts 的发现与读取、19 个工具的发现、双向消息参数、错误处理和指南示例；覆盖原始 text 与 topic/data 互斥、JSON 值、UTF-8 序列化上限及队列取消。
- `npm run test:ws` 在 Dart 3.13.7 / macOS arm64 的隔离 Debug VM 完成真实 WS 和 WSS 验证：SDK stdio → 认证 IPC → 网络控制器 → Dart 运行时；`inject_ws_message` 的 topic/data 仅进入 App，`send_ws_message` 经 App 既有 socket 到达真实服务端，消息记录可查询。出站 replace/drop、Mock 关闭、未知/失效连接、超限正文和卸载后旧连接拒绝均通过。
- 两种传输各产生 120 条记录，压力场景各 400 条预期队列遗漏，无运行时警告。报告：[双向 WS 验证结果](../artifacts/ws-mcp-bidirectional-report.json)。复现命令：`npm run test:ws`。
- 本次未进行 Flutter 设备或 IDE GUI 验收，未操作用户 App、安装扩展或修改真实 Agent 配置。工具返回成功表示本地提交，不代表服务端收到或业务成功；仍需结合本次消息与页面/业务响应验证。

## MCP Agent 指南增量（2026-11-09）

- 316项 Vitest（26个文件）通过，含新增11项：指南HTTP/WS示例使用生产校验器验证，每条工具调用示例使用真实schema验证；真实MCP SDK stdio验证初始化说明、17工具发现、5份指南工具/资源内容一致，IDE离线或registry不可用仍能读取；无运行时转发，非法主题和任意文件URI拒绝。
- TypeScript / Webview类型检查、Prettier、构建和diff检查通过；MCP工作台3项Playwright通过，390px合成截图目视无横向溢出，指南按主题可读。
- 本轮不启动Cursor/VSCode GUI、不访问钥匙串、不重新操作Flutter fixture或用户App；测试验证能力介绍可被发现和读取，不声称所有模型都会自动调用。此前真实Flutter及客户端验收范围保持下文记录。

## Flutter UI MCP 与 Agent 适配（2026-11-09）

- TypeScript：305项 Vitest 通过，包含16工具 schema/stdio/IPC、配置原子更新与覆盖优先级、网络重载、扩展生命周期和 UI 控制器。工作台34项 Playwright 通过，包含 MCP 项目默认、配置与连接分离、冲突修复、390px 窄面板。类型、格式和构建通过。
- 真实 Flutter：Flutter3.47.8/Dart3.13.7，iPhone18Pro/iOS27.2 独立 fixture。41项 UI 断言覆盖 typed Key、父范围、歧义、缺 Key、遮挡禁用、中文输入/formatter/onChanged、唯一滚动区域、懒加载、并发、HotReload/Restart 与失效。报告 `artifacts/ui-flutter-smoke-report.json`。
- 真实 MCP 闭环：stdio SDK → bridge → Unix IPC → VM UI/VmSession，编辑规则文件、reload、显式开启 Dio Mock、按 Key 真实点击、UI 回显、HTTP 历史详情、二次修改规则和关闭 Mock，16项通过。报告 `artifacts/mcp-flutter-smoke-report.json`。两套 fixture 均确认业务源码哈希不变，未连接或修改用户 EXIO 应用。
- 客户端：ClaudeCode2.1.292 项目/全局使用真实 CLI 与本地模型协议 fixture；CodexCLI0.162.1 项目/全局使用公开 app-server 工具接口，均完成 initialize/tools/list/tools/call（4场景）。无生产模型调用、无复制真实凭证。报告 `artifacts/mcp-agent-smoke.json`。Codex 桌面 App 自身界面加载未验收，不能用 app-server 代替声明通过。
- IDE：VSCode1.116.0 与 Cursor3.29.9 源码独立 bundle，各两次隔离进程共12断言，覆盖适配、SDK 工具调用、配置文件重载、非法规则保留、关闭面板保持、停用/恢复/退出清理。报告 `artifacts/mcp-vscode-ide-report.json`、`artifacts/mcp-cursor-ide-report.json`。使用宿主内部消息路由，不声称 Webview 鼠标或最终 VSIX 安装验收。
- Cursor 隔离启动触发钥匙串提示。用户反馈后已停止 GUI 验收并确认测试进程退出；脚本默认 skip，需显式门控才会启动。MCP 配置本身无需钥匙串，不访问或修改钥匙串。
- 边界：Android/真机未验证；文本输入模拟 Flutter 编辑协议，不覆盖真实 IME 组合；Key 诊断只覆盖当前挂载树。HotRestart fixture 停止时偶发 FlutterSDK 临时 dill 清理噪音，UI 断言及 exit0 已通过；无 HotRestart 的 MCP 闭环退出干净。
- 可复现：`npm run test:ui:flutter`、`npm run test:mcp:flutter` 需显式提供测试模拟器 ID；`npm run test:mcp:agents` 只用隔离配置；`npm run test:ide:mcp` 默认跳过 GUI，不应自动开启 Cursor。

日期：2026-11-08（Asia/Shanghai）。本报告区分实际运行与未验证项目。

## 环境

- macOS Apple Silicon / arm64。
- Node.js 22.22.2；Flutter 3.47.8、Dart 3.13.7、Dio 5.11.1。
- 官方 mitmproxy 12.3.1 macOS arm64 standalone；SQLite 使用 macOS 系统 CLI 后备，运行不依赖用户 Python。
- VS Code 1.116.0，Cursor 3.29.9；测试使用隔离的临时用户目录。
- Android：Samsung SM_A1760 已授权 USB 真机。
- iOS：iPhone 18 Pro / iOS 27.2 模拟器。

## 首版基线已通过

| 层级 | 验证内容 |
| --- | --- |
| TypeScript | 44 项单测：引擎下载校验/缓存/安全解压、进程与令牌协议、端口冲突、UTF-8分包、RPC 超时/崩溃、规则文件与历史草稿、Dio 检测/补丁/撤销、设备解析和转发、扩展生命周期及生效状态 |
| Python | 28 项测试：12 项规则/SQLite 单测、16 项真实 HTTP/HTTPS 代理集成；使用真实官方独立引擎 |
| SQLite 后备 | 强制 FLUTTER_PILOT_SQLITE_CLI=1，7 项存储测试，含 SQL/CLI 注入字符串、空字符、Unicode、保留策略、查询及跨重启读取 |
| 工作台 | 6 项 Playwright 交互测试：连接操作、规则表单/JSON 校验及 CRUD 消息、历史/对比/备注/规则草稿、并发断点编辑/终止、浅色主题/680px窄面板无横向溢出；保存截图；额外回归仅修改头部保留正文及关闭断点后保存 |
| 扩展宿主 | VS Code、Cursor 分别激活扩展、打开工作台、启动真实引擎、HTTPS Mock、SQLite 历史落盘、停止代理监听；均通过 |
| Flutter | flutter analyze 无问题，3 项 Widget 测试；Android debug、iOS simulator 构建通过 |
| Android 真机 | 真实向导生成 helper，USB adb reverse，HTTP Mock、HTTPS Mock、HTTPS 转发、POST JSON/请求头修改、响应状态202/头修改、跨站凭证剥离、真实 example.com 上游 HTTPS |
| iOS 模拟器 | 同上代理场景；通过独立 SecurityContext 信任调试 CA，不安装系统 CA，不关闭证书校验 |
| 引擎供应 | arm64、x64 官方压缩包均实际下载计算 SHA-256，和官方 Sigstore 及 Homebrew cask 交叉核对；arm64 完整安装与运行流程通过 |

代理集成还覆盖：Mock 无上游调用、4xx 改为成功、请求和响应手动编辑、并发断点、超时、终止、客户端取消、控制断连放行与重连、停止监听后仍可查历史、恢复监听、multipart/二进制/大正文/SSE直通、gzip 修改、有界解压防止超大解压输出。

设备级结果保存在 `examples/flutter/tool/device-validation.json`。可复现脚本为 `examples/flutter/tool/device_smoke.py`。设备测试累计写入 8 条历史，结束后恢复示例源码，清理自己创建的 adb reverse、临时 helper、引擎与测试应用。

## 未验证和兼容限制

- **Android 模拟器、iOS 真机局域网、macOS Intel 实际运行**尚未验证；Intel 仅验证下载包与校验值。
- **系统代理与系统 CA 的完全零代码接入**尚未实际验收；设备通过的是 Dio 最小开发配置路线。
- 设备级手动断点未验收；断点已在真实代理集成和浏览器 UI 分别验证。
- br/zstd、文件上传、二进制、SSE、chunked/无长度流和超限正文保持直通，首版不支持其正文修改。
- 原生插件、其他网络库、自定义适配器、证书固定、应用层签名、Web 和远程 IDE 不计入兼容承诺。
- 本地 VSIX 未发布扩展商店，尚未配置发布者账号、商店审核或签名发布流程。

## 复现命令

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:ui
MITMDUMP=/absolute/path/to/mitmdump npm run test:proxy
FLUTTER_PILOT_SQLITE_CLI=1 python3 -m unittest discover -s tests/proxy -p test_storage.py -v
FLUTTER_PILOT_TEST_ENGINE=/absolute/path/to/mitmdump npm run test:ide
FLUTTER_PILOT_TEST_ENGINE=/absolute/path/to/mitmdump FLUTTER_PILOT_TEST_IDE=cursor npm run test:ide
cd examples/flutter
flutter analyze
flutter test
```

最终 VSIX 通过 `npm run package` 生成，并在 VS Code、Cursor 的独立扩展目录实际安装验证。解压安装包后另跑 VS Code 扩展宿主 HTTPS Mock 与历史落盘验证。默认的 Python 测试命令在未设置 MITMDUMP 时跳过真实集成测试，不能把跳过计为通过。

## 后台记录与独立 API 目录增量验收

本节对应用户新确认行为，以下结果均已实际执行，不计入上方首版基线统计。

- 受信任本地 Flutter 工作区打开后，已安装 / 配置引擎无需打开工作台即可启动；首次无引擎不静默下载。
- autoStart=false 保留手动启动；本会话手动停止后，重新打开面板不会自动恢复。
- 关闭工作台后后台仍能采集 API 和历史；重开面板附着原会话，退出 IDE / 移除工作区释放引擎与拥有的转发。
- 多工作区会话隔离；连接设置保留，已选 Android 在线授权设备可恢复转发。
- API 目录累计调用及首次 / 最近调用时间独立保存，历史过期、删除、清空后仍在，跨重启保留。
- 旧历史仅迁移一次；手动删除目录不影响请求历史，重启不因旧历史恢复，后续新请求重新发现。
- 关闭工作台释放已有断点，后台新请求不被人工断点规则暂停，重开工作台恢复交互式断点。

本次整体验证结果：

| 层级 | 实际结果 |
| --- | --- |
| TypeScript | 59 项通过，包含无面板启动、首次无引擎不下载、不受信任工作区、autoStart 热切换、关闭面板保活、手动停止后重开不恢复、退出 / 下载竞态和多工作区隔离 |
| Python | 36 项通过：17 项规则 / 存储单测和 19 项真实 HTTP / HTTPS 集成；包含目录迁移、历史清理后保留、删除后重新发现、后台断点和断连释放 |
| SQLite 后备 | 强制 FLUTTER_PILOT_SQLITE_CLI=1，12 项存储测试通过 |
| 工作台 | 9 项 Playwright 测试通过，包含自动记录提示、空历史下目录保留及目录独立删除 |
| Cursor | 真实扩展宿主通过：激活后无需 UI 即可 HTTPS Mock，关闭 UI 后继续、后台跳过断点、未配置 Mock 的接口自动发现并保存目录、手动停止后重开 UI 不重启 |
| VS Code | 使用本次 VSIX 解包后的扩展运行真实扩展宿主，上述自动记录场景全部通过 |
| 静态检查 | TypeScript / Webview 类型检查、Prettier 格式检查、构建及 git diff --check 通过 |

连接设置及 Android 已授权设备的自动恢复已实现；本次未重新进行设备重连实际验收。设备 HTTP / HTTPS 能力沿用首版基线，不把代码实现视为新的设备验收通过。

### EXIO 多包项目实际接入（2026-11-08）

- Cursor 打开真实 EXIO Dart workspace 根目录，专用 Debug 入口通过主 API installer 加入代理 CA 公钥证书，保留 TLS 信任链和主机名校验。
- Cursor 使用 dev flavor 在 iPhone 18 Pro / iOS 27.2 启动成功；已发现 10 个 API，多个真实 HTTPS 接口返回 200。
- 从法币列表接口的真实响应生成 Mock，应用 hot restart 后 2 条请求返回 200 并命中规则，带自定义响应头；结束时规则停用、保留供用户练习，代理继续采集。
- 首轮 config / refresh-token 出现超时，随后重试；旧登录态 refresh-token 返回 401，未进行登录或交易操作。
- 修复 Dart workspace 根目录识别，59 项 TypeScript 回归通过；显式成员列表最多 256 项，不递归、不展开 glob。已安装修复并重载真实 Cursor，未打开工作台即显示后台记录中。
- 实际操作截图及说明见 [EXIO Cursor 图文教程](exio-cursor-guide/README.md)。

## API 工作台布局优化验收（2026-11-08）

- TypeScript/Webview 类型检查通过，68 项 Vitest 单元测试通过（含 JSON token 格式化、长整数/精度/重复键保留、无效正文与资源边界）。
- 17 项 Playwright 工作台测试通过：乱序 API 与历史倒序、目录折叠保留筛选与跨标签折叠偏好、新记录默认响应、JSON/原文切换、非 JSON/HTML 安全回退、空/二进制/截断/无响应、680px 长路径布局、详情放大恢复、复制模式与失败提示。
- 已人工检查生成截图：`artifacts/workbench-history.png`、`artifacts/workbench-api-sorted.png`、`artifacts/workbench-api-focused.png`、`artifacts/workbench-api-narrow.png`，均使用合成数据，不包含真实认证内容。
- 本轮不修改代理转发行为；未重新执行设备网络或真实登录验收，MFA 代理链路超时问题仍按 `.harness/momory/FAILURES.md` 跟踪。

## 0.0.2 VM 零源码路线验收（2026-11-08）

本节为新分支 `codex/v0.0.2-vm-service` 的增量验收，旧章节的代理、设备和布局统计保持历史基线，不代表 VM 覆盖范围。

| 层级 | 实际结果 |
| --- | --- |
| 类型与构建 | `npm run typecheck`、`npm run build` 通过 |
| TypeScript 回归 | 116 项 Vitest（12 个文件）通过，含注入、JSON-RPC、会话生命周期、profiling、SQLite 及原功能回归 |
| 工作台 | 20 项 Playwright 通过；包含 VM 无引擎 / 无 CA 接入、WS 输入提交清空、开关 / 重新发现 / 断开、旧代理恢复提示、VM 无引擎历史查询及 680px 布局 |
| 截图 | 已实际检查 `artifacts/workbench-vm.png`，使用合成数据，无溢出 |
| Flutter 真实运行时 | iPhone 18 Pro / iOS 27.2 模拟器 8 项通过；只连 VM 采集 POST 请求 / 响应，已有 Dio HTTPS 本地 Mock、双向修改、真实 503 改 200、Hot Restart 后重新接入、Mock 开关恢复、异常观察断线后重连恢复 SDK 开关及源文件 SHA-256 不变 |
| 零源码证据 | `examples/flutter/lib/main.dart` 运行前后 SHA-256 一致；无代理、helper、CA；本地 Mock 未访问上游 |
| 纯 Dart 真实 VM | Dio 5.9.0 / 5.10.0 / 5.11.1 各 21 项全部通过；含真实 15 秒租约过期、跨源凭证清理、流式响应、无效 JSON 与网络错误历史 |
| 真实 IDE VM 消息链路 | VS Code 与 Cursor 独立扩展宿主均退出 0：VM 模式激活、无 engine / CA、SQLite 查询 / 详情 / 规则草稿、合成 WS 连接、关闭工作台保活 / 重开、认证地址不落盘及 dispose 断开 |
| 代理回归 | 官方 mitmproxy 12.3.1 standalone：36 项通过（19 项真实 HTTP / HTTPS 集成、17 项规则 / 存储），本轮实际重跑 |

真实 IDE smoke 使用合成 JSON-RPC 服务并调用扩展内部消息入口，验证宿主生命周期与消息链路，不宣称覆盖真实 Webview 鼠标操作，也不替代 Flutter 真运行时 Mock 验证；浏览器交互与真实 Flutter 分别由其他测试覆盖。

实现同时包含 VM JSON-RPC、SDK profiling、多 Isolate 与 Hot Restart、Dio 对象发现 / 注入、规则同步及卸载、SQLite CLI 存储和受控 UI 交互测试。VM 与代理共用规则文件，历史分库；清空历史不删除 API 目录，目录删除后仅未来调用重新发现。

VM 连接默认仅采集，用户主动开启运行时 Mock 后才安装拦截器。运行中的代理也同步共用规则；代理在 VM 页重连时不会恢复人工断点。慢心跳只保留一个运行 / 排队任务，避免停用被重复超时阻塞。关闭工作台不关闭连接。正常停用尽量立即卸载，意外断开后依赖 15 秒租约旁路，并在重新启用 Mock 前提供约 16 秒冷却。新实例周期扫描存在首个请求早于接入的窗口；每 Isolate 最多接入 128 个 Dio。SDK profiling 在 App 内的缓存没有本插件强制容量上限，本地历史容量不能当作 App 内存限制。

### VSIX 产物复验

`artifacts/flutter-api-mocks-0.0.2.vsix` 已生成，解包确认包含 `resources/vm/interceptor.dart.txt`，运行时代码已内嵌 ws。使用该 VSIX 解包的 `extension/` 分别运行 VS Code、Cursor VM 扩展宿主 smoke，两者退出码均为 0。该复验使用隔离 IDE 配置，不覆盖用户当前安装。

最终模板另在真实 iPhone 模拟器上重跑全部 8 项通过，包含 SDK profiling 异常断线后同 VM 重连恢复。通过范围仍按上表的运行时、UI 与宿主三层分别计。

### VM 本轮未验证范围

- VM 路线的 Android 模拟器 / USB 真机和 iOS 真机；旧代理设备通过不能换算为 VM 通过。
- Profile / AOT / Release 运行时注入；当前承诺限 Debug/JIT。
- 全部 Dio 版本、原生插件 / WebView、自定义 adapter 以及会短路后续拦截器的应用拦截链。
- EXIO 的真实登录与 MFA 链路恢复。独立示例通过不等于此前代理超时问题已归因或解决。

### 默认接入改为 VM WS 的增量回归

用户将 VM WS 指定为默认和推荐方案，代理为备用。118 项 Vitest、21 项 Playwright、类型检查、格式检查、构建通过。新增覆盖新工作区即使存在可用引擎缓存仍不启动代理、旧版无 mode 连接文件保持代理、已保存方式优先，以及 Webview 初始直接展示 VM、代理标记备用。此增量不改变请求执行逻辑，不重复计算之前的设备验收。

真实 Cursor 隔离宿主使用全新、没有 connection.json 的工作区通过：默认 VM、无引擎 / CA、离线历史和目录、合成 WS 连接、关闭 / 重开工作台及退出断开，退出码 0。

复现步骤、运行时数据语义和模式切换恢复见 [VM 使用与可行性验证](v0.0.2-vm-service.md)。本版本按用户指定使用 0.0.2，低于已安装的 0.1.0；安装构建 VSIX 时使用 `--force` 覆盖。

## 项目 UUID 绑定与简洁开关增量验收（2026-11-08）

- 159 项 Vitest（14 个文件）通过，含 24 项项目文件、9 项私有迁移及 34 项扩展整合测试。验证 UUID 稳定、同 UUID 不同目录隔离、项目设置优先、外部规则防覆盖与读取、配置快照、旧历史备注/标签/API 目录迁移、SQLite live WAL 一致快照，以及非法配置/符号链接拒绝。
- 23 项 Playwright 通过。项目卡显示 UUID、配置/规则入口和读取反馈；长项目名在 680px 下不横向溢出；规则仅显示 switch，鼠标与 Space 可切换，繁忙时禁用。已检查深色、浅色窄面板及项目卡合成截图。
- Cursor 隔离扩展宿主的 VM 与代理 smoke 均退出 0。VM 使用合成 JSON-RPC 服务，覆盖规则写入项目、外部冲突拒绝、重新读取、连接保活与认证地址不落盘；代理使用真实 mitmdump，验证旧规则/配置迁移、HTTPS Mock、后台采集及目录持久化。
- TypeScript / Webview 类型检查、Prettier、构建及 `git diff --check` 通过。

本增量不重新计入设备验收；未对用户活跃 EXIO 会话强制重载。使用说明见 [项目绑定说明](project-binding.md)。

本轮最终 VSIX 解包后再次运行 Cursor VM 隔离宿主，退出码 0，项目绑定、规则读写/冲突保护与 VM 生命周期检查均通过。

## VM 连接与状态同步修复验收（2026-11-08）

- 174 项 Vitest、24 项 Playwright、TypeScript / Webview 类型检查、Prettier 和构建通过。新增覆盖真实 HTTP/WebSocket DDS 跳转、路径/认证/端口/超时分类、跳转边界、连接取消、重复连接保护、初始化断连竞态、失败清计数及连接页四态一致。
- 真实 EXIO worktree 的当前 Flutter VM：原始 WS 返回 HTTP 302 到本机 DDS，修复后的 VmServiceClient 从原始地址连接并完成只读 getVM，返回 VM 与 1 个 Isolate；实际端点更新为 DDS。未修改应用源码、profiling 或业务请求，完整认证地址未保存。此项仅验收传输和只读 RPC，不代表重新完成业务 Mock 或登录验收。
- 已查看 `artifacts/workbench-vm-connected.png` 合成截图：680px 下显示“已连接 · 当前端点”，地址输入禁用，仅保留断开；连接中、失败与断开的端点和按钮状态由 Playwright 验证。
- 原用户日志仅记录统一错误，截图端点可能残留自旧会话，不能反推出当次输入；本轮将可复现 DDS 缺陷与旧端点/状态缺陷分别修复。

## 0.0.3 WebSocket（2026-11-09）

| 层级 | 本轮实际结果 |
| --- | --- |
| 类型/格式/构建 | TypeScript、Webview、Prettier、构建与diff检查通过 |
| 单元及存储 | 233项Vitest通过；包含真实SQLite、规则外部编辑保护、生命周期串行及断线竞态回归 |
| 工作台 | 28项Playwright通过，其中4项WS UI；680px深浅色截图已目视，截图使用合成数据 |
| IDE消息链路 | Cursor及VS Code隔离宿主退出0；WS规则保存/读取/冲突保护、私有历史摘要/详情、默认采集Mock关、离线推送拒绝 |
| Dart真实VM | Dart3.13.7，WS/WSS各保存115条消息，500条burst业务均送达、400条遗漏计数；双向替换/丢弃、手动推送、addStream/addUtf8Text、binary、ping/pong、暂停恢复、租约过期、卸载、未发送即close、SDK握手→URL规则与外部handler保护通过 |
| Flutter真实模拟器 | Flutter3.47.8/Dart3.13.7，iPhone18 Pro/iOS27.2；四个并行dart:io WS/WSS、web_socket_channel3.0.3 WS/WSS；双向替换/丢弃/推送不串线、UTF8/流、卸载恢复、Hot Restart重新发现及拒绝旧推送通过，共25消息，无warning |
| 源码与TLS | 一次性测试fixture源码SHA-256在运行时安装前后相同；不连接或改用户EXIO App。WSS使用测试CA加入fixture可信根，未跳过证书校验；生产注入不改TLS或CA |
| 代理回归 | 17项Python规则/存储通过；19项需MITMDUMP的引擎集成跳过，本轮未重新验收代理设备链路 |

复现命令：`npm run test:ws`；`VM_FLUTTER_DEVICE=<booted-simulator-id> npm run test:ws:flutter`；`FLUTTER_PILOT_TEST_IDE=cursor npm run test:ide:vm`（vscode同理）。

本轮未验收Android、iOS真机、其他Dart SDK、Socket.IO专用协议、原生插件或WebView；不把测试fixture成功当作EXIO业务WS或登录链路验收。URL关联会开启SDK HTTP profiling，App内缓存无插件强制容量上限；本地历史有界不替代该边界。代理WS不在首版范围。

安装产物为`artifacts/flutter-api-mocks-0.0.3.vsix`，包含独立WS Dart模板；未覆盖用户当前安装，未自动提交或推送。

## VM 自动发现与自动连接（2026-11-09）

| 层级 | 实际通过范围 |
| --- | --- |
| 类型、格式与构建 | TypeScript / Webview、Prettier、构建及 `git diff --check` 通过 |
| 单元及集成 | 269 项 Vitest；覆盖 DTD 延迟就绪/超时、多会话原子发布、真实路径归属、过期通知、三次重试预算、手动优先、暂停、代理排除及项目设置 |
| 工作台 | 31 项 Playwright；新增候选选择、失败重试、暂停恢复、禁用状态和 390px 窄面板，合成截图已目视检查 |
| 隔离 IDE 消息链路 | Cursor、VS Code 均退出 0；合成候选经 `vm.discovery.connect` 消息选择后连接合成 VM，验证暂停、owner 移除、新会话自动连接及认证地址不进入摘要/项目文件 |
| 真实 Cursor | 3.29.9（宿主 API 1.128.0），Dart 扩展 3.146.0，9 项断言通过 |
| 真实 VS Code | 1.116.0，Dart 扩展 3.146.0，9 项断言通过 |
| Flutter 与设备 | Flutter 3.47.8 / Dart 3.13.7，iPhone 18 Pro / iOS 27.2 模拟器 |

两种 IDE 均通过：IDE 内 launch 自动连接、自动连接后的真实 dart:io HTTP 记录、新建发现实例通过 DTD 补查已运行的真实调试会话、Hot Restart、手动断开后等待 5 秒保持暂停与候选显式恢复、停止调试自动断开、全停后新会话自动连接，以及独立启动测试 Flutter 后 IDE attach 自动连接。Dio Mock、WS 采集和 WS Mock 全程默认关闭，fixture 应用源码 SHA-256 未变。

真实测试使用 `/tmp` 独立 fixture、隔离的 IDE profile 与扩展目录，只控制测试创建的调试会话；没有修改或控制用户的 EXIO 会话。测试曾因 Dart 自动追加调试名称而修正会话定位；HTTP 验证等待 profiling 就绪（`vm.state.isolates > 0`）后再发请求，未把采集前请求当作可补录。

复现：`FLUTTER_PILOT_TEST_IDE=cursor node scripts/ide-vm-discovery-test.mjs`，VS Code 改为 `vscode`；可设置 `FLUTTER_PILOT_TEST_DEVICE` 和 `FLUTTER_PILOT_TEST_FLUTTER`。完整脱敏报告在忽略目录 `artifacts/vm-discovery-cursor-report.json`、`artifacts/vm-discovery-vscode-report.json`。合成 IDE 验证仍用 `test:ide:vm`，不能替代上述真实验收。

本轮未验收 Android、iOS 真机、其他 SDK / Dart 扩展版本、Web、Profile / Release 或 Remote SSH。外部终端独立运行不属于自动发现范围；本轮验证的是在 IDE 附加后发现。版本和分支沿用 0.0.3，未提交、合并或覆盖安装。

用户随后要求覆盖安装并提交。最新 0.0.3 VSIX 解包后再次通过 Cursor 隔离 VM 消息链路验证，退出 0；使用 Cursor CLI `--force` 安装成功。安装后的扩展、Webview JS/CSS 和两份 Dart 模板均与包内 SHA-256 一致，扩展清单除 Cursor 注入的 `__metadata` 外一致。未自动重载用户当前窗口，需在方便时执行 **Developer: Reload Window** 加载新版；未合并分支。

## 0.0.5 内容优先布局（2026-11-10）

- 覆盖连接与诊断、API 与历史、WebSocket、Mock 规则、断点队列、MCP 全部六个 Tab。共用顶部压缩，连接与设置、项目文件、规则模板及诊断维护按需展开；历史内容区使用剩余窗口高度。
- 324 项 Vitest、36 项 Playwright、TypeScript / Webview 类型检查、全仓格式检查通过。UI 覆盖 1280px / 390px 的内容位置和主区域无横向溢出，高级筛选收起后保留条件、False 值筛选计数及导入入口均通过。
- 使用合成数据，已目视检查截图；未重新执行真实 Flutter 设备或 IDE GUI 验收。已有运行时能力的验收边界沿用之前记录。
- 本地 VSIX 为 `artifacts/flutter-api-mocks-0.0.5.vsix`；通过 Cursor CLI 安装，包与安装目录一致性及离线 MCP 握手结果记录在 `artifacts/v0.0.5-install-report.json`。不自动重载用户窗口；在方便时执行 **Developer: Reload Window** 加载新版。

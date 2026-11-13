# CWR code review issues（原始快照与修复跟踪）

日期：2026-11-13（Asia/Shanghai）

original_review_verdict: fail

remediation_status: completed（F-1 至 F-6 已修复并验证，2026-11-13）

blockers_summary: iOS附着可能卸载其他工具的WDA；编辑菜单可能操作错误输入框；MCP长耗时安装/连接被45秒宿主超时中断。

范围：HEAD 979b632888a98bc58afcb6ab9c26e7647573a5a4 上的全部未提交改动及新增文件（24个已跟踪修改、15个原始新增文件）。

原始审查确认6项问题：P1 3项，P2 3项；审查阶段未修改业务代码。用户随后明确要求 `fix all`，修复记录见下方；原始问题及机器可读结果保留作为历史证据。

## 修复跟踪（用户授权 fix all）

| ID | 源码处理 | 回归证据 |
| --- | --- | --- |
| F-1 | 适配器 v3 在附着模式跳过 startup.cleanupApps；所有安装查找路径拒绝旧 v2 回执 | 实际执行补丁后的预签名真机／模拟器启动函数，多 WDA、非附着对照、幂等、签名不匹配、旧安装 fallback 共 5 项 |
| F-2 | 已有菜单须属于目标活动编辑器，点击前再次核验；Flutter 结合焦点、唯一内部编辑框／字段边界及选区；iOS XPath 去除仅快照使用的 AppiumAUT 包装层 | 双原生输入框 cut／paste 错归属、焦点改变、相同边界不同身份、Flutter 装饰字段／大外层 Key、坐标映射等回归；真实 iOS A 菜单下请求 B 均拒绝且两字段不变 |
| F-3 | 认证、会话和参数校验后延长宿主期限；桥接与宿主共用 setup 660s、connect 240s、截图 85s 规则，宿主多 5s | 真实 Unix IPC 缩时回归；另以未缩时的 50 秒 setup／connect 并发调用分别在 50004／50003ms 完成，取消只中止一次且不重放 |
| F-4 | 完整原字符串计算字符簇边界，聚焦前及执行前拒绝簇内光标／部分已有选区 | 完整生产注入模板的实际 Dart／Flutter 测试，含 Unicode、反向选区、formatter／onChanged 及真实编辑区域输出 |
| F-5 | 设备通道 append 在定位／输入前返回明确不支持；Flutter 显式追加保留，设备能力项同步为 false | iOS／Android 模拟驱动无输入断言、原生替换回归；真实模拟器中间光标／已有选区拒绝追加并保持文本 |
| F-6 | Flutter 长图按实际 VM 设备获取临时租约，仅同设备原生连接可复用 | VM=A／native=B 且 A 已被占用时拒绝，释放后允许；同设备复用、非滚动截图分支回归 |

修复后验证：505 项 Vitest／34 文件、70 项 Playwright、类型检查、构建、格式与 diff 检查通过；Vitest 包含实际编译完整生产注入模板并执行 25 项 Dart／Flutter 内部测试的入口。Python 代理 21 项通过、21 项因缺 MITMDUMP 跳过。

独立 iPhone 17／iOS 26.5 模拟器经真实 MCP stdio → IPC → VM／Appium 完成 152／152 项检查（含清理），`completed=true`、`cleanupErrors=[]`，报告 `artifacts/automation-flutter-smoke-report.json`。真实未缩时 50 秒 IPC 与取消结果见 `artifacts/mcp-long-operation-fix-report.json`；源码和测试脚本哈希、适配器 v3 回执及清理证据分别见 `artifacts/automation-fix-validation-evidence.json`、`artifacts/automation-fix-cleanup-report.json`。Dart fixture 哈希不涵盖 Swift fixture 或测试脚本。

独立复核未发现新增缺陷。本次未验收 Android 或物理 iOS，不将驱动模拟测试外推为真机验收。版本保持 0.0.14，未提交、推送、发布或安装扩展。下方问题与机器可读 fail 结果属于修复前历史快照。

## F-1 [P1] 附着适配器仍允许 XCUITest 卸载不属于本插件的 WDA

file: `src/automation/runtime.ts`；location: 35–46，patchManagedSimulatorAttach

category: correctness；reviewer: correctness；confidence: 0.99；requires_verification: false；pre_existing: false

Evidence: 固定 XCUITest 12.22.8 的 startup.js:34–44 的 preparePreinstalled 调用 cleanupApps；cleanupApps:62–68 枚举相同 CFBundleName 的其他 WDA 并 removeApp。模拟器 prepareForXcodebuild:130–157 也包含清理。当前适配器仅覆盖 simulator.js、stop.js 和 processes.js。

Detail: NativeSession.connect 对真机使用 usePreinstalledWDA=true/prebuiltWDAPath，进入上述启动路径；设备上已有其他工具或团队安装的不同Bundle ID的WDA时，连接会卸载这些WDA。noReset/useNewWDA=false不跳过清理，违反仅清理本插件拥有资源的约定。已核对官方Git tag和npm发布tarball，未在用户设备进行破坏性复现。

Recommendation: 覆盖启动阶段cleanupApps路径，禁止卸载无本插件所有权记录的WDA；对真机预签名连接和模拟器首次连接加入多WDA驱动层回归，确认其他Bundle ID的removeApp从未被调用。

## F-2 [P1] 已有编辑菜单未绑定目标输入框，可能剪切或粘贴错误字段

file: `src/automation/controller.ts`；location: 742–743（关联777–787）

category: correctness；reviewer: correctness；confidence: 0.99；requires_verification: false；pre_existing: false

Evidence: iosEditMenu先全局搜索可见Cut/Copy/Paste菜单；已有唯一菜单时跳过聚焦目标逻辑。最小重现：A已有Cut菜单，调用B的cut返回ok:true，唯一输入为菜单中心(45,95)点击，没有点击B中心(150,420)。

Detail: native selector路径没有活动编辑器检查；Flutter路径只比较B的选区不变，不能证明菜单属于B。对B请求cut/paste可能修改A。现有测试仅覆盖打开菜单导致选区变化。

Recommendation: 先核实目标字段取得焦点且对应当前活动编辑器，再确认菜单归属；无法确认时拒绝。增加A打开菜单后请求cut/paste B的双输入框回归，断言A不被修改。

## F-3 [P1] 长耗时安装和设备连接仍被宿主的 45 秒超时中断

file: `src/mcp/server.ts`；location: 384–388（关联 accept:154–175）

category: correctness；reviewer: correctness；confidence: 1；requires_verification: false；pre_existing: false

Evidence: requestSession 为 setup_automation/connect_device 分别设为 660000/240000ms；accept 仍 socket.setTimeout(45000)，仅 take_screenshot 被提升。真实 Unix IPC 配合 50000ms 模拟 setup 操作，在 45004ms 收到 SESSION_CLOSED。

Detail: 首次 npm 安装和 WDA/UiAutomator2 建连允许超过45秒，但客户端延长超时无法改变宿主端超时；宿主关闭 socket 后触发 AbortSignal，导致安装或连接取消，无法完成文档承诺的十分钟准备与较长设备连接。

Recommendation: 在宿主完成请求解析和认证后，为 setup/connect 应用对应的有界超时，与桥接客户端统一超时策略；补充大于45秒的 IPC安装和连接回归，并覆盖取消清理。

## F-4 [P2] 在字符簇内部移动光标后删除会拆坏 Unicode 文本

file: `resources/vm/ui.dart.txt`；location: 445–449，edit_text/delete

category: correctness；reviewer: correctness；confidence: 0.97；requires_verification: false；pre_existing: false

Evidence: 按当前算法对 😀（UTF-16 [55357,56832]）设 cursor=1 后删除，只剩孤立低代理 [56832]；e\u0301 在cursor=1时删除只剩组合重音。子代理使用实际 characters-1.4.1 的独立Dart脚本复现。

Detail: move_cursor/select_range 接受任意UTF-16 offset且仅检查长度。delete先对substring(0,start)分字符簇，截断前缀会把原始完整字符簇误判为已结束，随后replaceRange留下孤立代理或损坏组合字符。Flutter编辑协议不会自动归一化簇内选区。

Recommendation: 基于完整原字符串计算字符簇边界，对簇内光标和选区拒绝或明确归一化；补充代理对、组合重音、ZWJ序列及部分选区验证。

## F-5 [P2] 原生 append 在当前光标处插入，不能保证追加到文本末尾

file: `src/automation/controller.ts`；location: 634–641，enterText

category: correctness；reviewer: correctness；confidence: 0.98；requires_verification: false；pre_existing: false

Evidence: 先点击输入框中心；append仅跳过/clear，再直接发送/value。固定XCUITest 12.22.8和WDA 16.17.7的/value使用fb_typeText(shouldClear:NO)，已有焦点时不移动插入点。模拟该键入语义：abcdef+append X得到abcXdef。

Detail: 中心点击会移动插入点或保留当前选区，随后输入可能插到中间或替换选区；Flutter同参数则before.text+requested，后端语义不一致。fixture的append验收显式使用backend=flutter，未覆盖原生分支。

Recommendation: 通过受支持的原生编辑动作确认并移动插入点到末尾后输入；无法可靠完成的平台返回明确不支持。加入非空长文本、中间光标和有选区的原生append验证。

## F-6 [P2] 连接其他设备时，Flutter长截图绕过VM设备独占租约

file: `src/automation/controller.ts`；location: 163–170（关联225–233、236–240）

category: concurrency；reviewer: concurrency；confidence: 1；requires_verification: false；pre_existing: false

Evidence: 租约判断依赖backend(args)==flutter；已连接原生设备B且默认auto时判为device，但Flutter长截图仍走screenshotVm。内存打包真实controller并预先持有A租约：VM=A/native=B时，take_screenshot(mode=long,rawParts=true)仍返回ok:true，vmExecute实际收到take_screenshot(mode=long)，没有DEVICE_BUSY。

Detail: 长截图会滚动当前Flutter页面并恢复滚动位置。另一工作区持有设备A时，本工作区只要已连接原生B，就能在未申请A租约的情况下滚动A，破坏跨工作区输入独占和截图/手势稳定性。通过本地双设备绑定模拟复现，未操作真实设备；rawParts是现有工作台截图路径使用的参数。

Recommendation: 按操作真正使用的VM设备申请租约；Flutter长截图应独立于输入backend判断，只有同一原生绑定已持有该VM设备租约时可复用。增加VM=A/native=B且A被其他控制器占用时拒绝长截图的回归。

## 审查说明与证据追踪

- 范围：HEAD 979b632888a98bc58afcb6ab9c26e7647573a5a4 之上的全部已跟踪修改及15个新增文件；未排除新增文件。
- 初始patch SHA-256: 5a9cf10fb31773785545fad325fa1350c04b6ab4caac2c37e6e5307822b1ef43；+15085/-286行，含独立lockfile。
- 安全分层判定：HIGH；override=auto；security=full reviewer (high risk)；应用源码、供应链、大diff和env/credential赋值强信号。secret-pattern无命中，敏感路径无命中。弱信号：console.log/delete/endpoint/env/fetch/http/https/insert/session/update/url/where。
- 条件路由：api-contract triggered（MCP schemas与第三方设备适配）；concurrency triggered（队列/取消/进程/租约）；performance triggered（树遍历和轮询）。
- 额外读取：src/screenshot.ts——核对扩展截图和MCP截图消费者；src/devices.ts——核对设备发现和状态生产者；scripts/build.mjs/playwright.config.ts/scripts/ui-server.mjs——确认实际构建和工作台验证入口；tests/vm-ui.test.ts——核对VM失效与超时基线。
- 额外读取：本机Flutter editable_text.dart及characters-1.4.1——由VM子代理核实UTF-16选区处理并执行最小算法复现；.harness/momory移动交互记忆及docs/mobile-automation*——核对已批准行为和设备验收边界。
- security full reviewer：完成硬编码机密、PII、敏感文件、安全反模式、环境泄漏及供应链输入完整性；无确认的凭据/PII泄漏。lockfile中487个无独立integrity条目均为inBundle=true，归属父包具有来源和integrity。
- 视角覆盖：correctness、testing、maintainability始终覆盖；api-contract/concurrency/performance按触发覆盖。树遍历重复未取得足够实际性能证据，未报告推测性缺陷。
- 额外读取：src/mcp/adapters.ts——核对Node运行时发现；src/engine.ts findAvailablePort——核对本机端口分配；src/automation/native.ts/lease.ts/vm/ui.ts——追踪文本编辑、输入释放、活动元素、租约和失效。
- 外部原始证据：固定版本官方源码 https://raw.githubusercontent.com/appium/appium-xcuitest-driver/v12.22.8/lib/commands/wda/startup.ts 与 npm tarball https://registry.npmjs.org/appium-xcuitest-driver/-/appium-xcuitest-driver-12.22.8.tgz；子代理只在内存读取，确认WDA清理行为。
- 外部原始证据：锁定的appium-webdriveragent 16.17.7中 FBElementCommands.m、XCUIElement+FBTyping.m，以及xcuitest 12.22.8 element.js；核对/value保留当前插入点。
- 本轮复验：TypeScript与Webview类型检查通过；Vitest 477项/31文件通过；构建通过；Playwright 70项通过；Python代理21项通过、21项缺MITMDUMP跳过；Prettier和git diff --check通过。
- 本轮定向验证：真实Unix IPC模拟50秒安装于45004ms返回SESSION_CLOSED；内存打包真实AutomationController复现错菜单唯一点击(45,95)；按固定WDA插入语义模拟append得到abcXdef；持有A租约且native绑定B仍向VM A分发长截图。
- 根代理复核：在内存解包固定XCUITest 12.22.8官方npm tarball，确认startup.js cleanupApps的removeApp以及随包WDA /value shouldClear:NO和焦点已存在时直接保留插入点。未安装或执行第三方设备驱动。
- 边界：本轮未重新执行真实Flutter设备fixture、真机或模拟器操作，未做破坏性WDA卸载验证、MITMDUMP集成或外部CVE在线扫描。历史设备验收记录不是本轮重新验收结果。模拟重现不等于真实设备验收。
- 额外读取清单理由已由各模块审查记录汇总在以上条目；本轮业务代码未修改，仅新增此审查报告。

## 机器可读结果

```json
{
  "verdict": "fail",
  "blockers_summary": "iOS附着可能卸载其他工具的WDA；编辑菜单可能操作错误输入框；MCP长耗时安装/连接被45秒宿主超时中断。",
  "findings": [
    {
      "id": "F-1",
      "severity": "P1",
      "category": "correctness",
      "reviewer": "correctness",
      "confidence": 0.99,
      "file": "src/automation/runtime.ts",
      "location": "35–46，patchManagedSimulatorAttach",
      "summary": "附着适配器仍允许 XCUITest 卸载不属于本插件的 WDA",
      "evidence": "固定 XCUITest 12.22.8 的 startup.js:34–44 的 preparePreinstalled 调用 cleanupApps；cleanupApps:62–68 枚举相同 CFBundleName 的其他 WDA 并 removeApp。模拟器 prepareForXcodebuild:130–157 也包含清理。当前适配器仅覆盖 simulator.js、stop.js 和 processes.js。",
      "detail": "NativeSession.connect 对真机使用 usePreinstalledWDA=true/prebuiltWDAPath，进入上述启动路径；设备上已有其他工具或团队安装的不同Bundle ID的WDA时，连接会卸载这些WDA。noReset/useNewWDA=false不跳过清理，违反仅清理本插件拥有资源的约定。已核对官方Git tag和npm发布tarball，未在用户设备进行破坏性复现。",
      "recommendation": "覆盖启动阶段cleanupApps路径，禁止卸载无本插件所有权记录的WDA；对真机预签名连接和模拟器首次连接加入多WDA驱动层回归，确认其他Bundle ID的removeApp从未被调用。",
      "requires_verification": false,
      "pre_existing": false
    },
    {
      "id": "F-2",
      "severity": "P1",
      "category": "correctness",
      "reviewer": "correctness",
      "confidence": 0.99,
      "file": "src/automation/controller.ts",
      "location": "742–743（关联777–787）",
      "summary": "已有编辑菜单未绑定目标输入框，可能剪切或粘贴错误字段",
      "evidence": "iosEditMenu先全局搜索可见Cut/Copy/Paste菜单；已有唯一菜单时跳过聚焦目标逻辑。最小重现：A已有Cut菜单，调用B的cut返回ok:true，唯一输入为菜单中心(45,95)点击，没有点击B中心(150,420)。",
      "detail": "native selector路径没有活动编辑器检查；Flutter路径只比较B的选区不变，不能证明菜单属于B。对B请求cut/paste可能修改A。现有测试仅覆盖打开菜单导致选区变化。",
      "recommendation": "先核实目标字段取得焦点且对应当前活动编辑器，再确认菜单归属；无法确认时拒绝。增加A打开菜单后请求cut/paste B的双输入框回归，断言A不被修改。",
      "requires_verification": false,
      "pre_existing": false
    },
    {
      "id": "F-3",
      "severity": "P1",
      "category": "correctness",
      "reviewer": "correctness",
      "confidence": 1,
      "file": "src/mcp/server.ts",
      "location": "384–388（关联 accept:154–175）",
      "summary": "长耗时安装和设备连接仍被宿主的 45 秒超时中断",
      "evidence": "requestSession 为 setup_automation/connect_device 分别设为 660000/240000ms；accept 仍 socket.setTimeout(45000)，仅 take_screenshot 被提升。真实 Unix IPC 配合 50000ms 模拟 setup 操作，在 45004ms 收到 SESSION_CLOSED。",
      "detail": "首次 npm 安装和 WDA/UiAutomator2 建连允许超过45秒，但客户端延长超时无法改变宿主端超时；宿主关闭 socket 后触发 AbortSignal，导致安装或连接取消，无法完成文档承诺的十分钟准备与较长设备连接。",
      "recommendation": "在宿主完成请求解析和认证后，为 setup/connect 应用对应的有界超时，与桥接客户端统一超时策略；补充大于45秒的 IPC安装和连接回归，并覆盖取消清理。",
      "requires_verification": false,
      "pre_existing": false
    },
    {
      "id": "F-4",
      "severity": "P2",
      "category": "correctness",
      "reviewer": "correctness",
      "confidence": 0.97,
      "file": "resources/vm/ui.dart.txt",
      "location": "445–449，edit_text/delete",
      "summary": "在字符簇内部移动光标后删除会拆坏 Unicode 文本",
      "evidence": "按当前算法对 😀（UTF-16 [55357,56832]）设 cursor=1 后删除，只剩孤立低代理 [56832]；e\\u0301 在cursor=1时删除只剩组合重音。子代理使用实际 characters-1.4.1 的独立Dart脚本复现。",
      "detail": "move_cursor/select_range 接受任意UTF-16 offset且仅检查长度。delete先对substring(0,start)分字符簇，截断前缀会把原始完整字符簇误判为已结束，随后replaceRange留下孤立代理或损坏组合字符。Flutter编辑协议不会自动归一化簇内选区。",
      "recommendation": "基于完整原字符串计算字符簇边界，对簇内光标和选区拒绝或明确归一化；补充代理对、组合重音、ZWJ序列及部分选区验证。",
      "requires_verification": false,
      "pre_existing": false
    },
    {
      "id": "F-5",
      "severity": "P2",
      "category": "correctness",
      "reviewer": "correctness",
      "confidence": 0.98,
      "file": "src/automation/controller.ts",
      "location": "634–641，enterText",
      "summary": "原生 append 在当前光标处插入，不能保证追加到文本末尾",
      "evidence": "先点击输入框中心；append仅跳过/clear，再直接发送/value。固定XCUITest 12.22.8和WDA 16.17.7的/value使用fb_typeText(shouldClear:NO)，已有焦点时不移动插入点。模拟该键入语义：abcdef+append X得到abcXdef。",
      "detail": "中心点击会移动插入点或保留当前选区，随后输入可能插到中间或替换选区；Flutter同参数则before.text+requested，后端语义不一致。fixture的append验收显式使用backend=flutter，未覆盖原生分支。",
      "recommendation": "通过受支持的原生编辑动作确认并移动插入点到末尾后输入；无法可靠完成的平台返回明确不支持。加入非空长文本、中间光标和有选区的原生append验证。",
      "requires_verification": false,
      "pre_existing": false
    },
    {
      "id": "F-6",
      "severity": "P2",
      "category": "concurrency",
      "reviewer": "concurrency",
      "confidence": 1,
      "file": "src/automation/controller.ts",
      "location": "163–170（关联225–233、236–240）",
      "summary": "连接其他设备时，Flutter长截图绕过VM设备独占租约",
      "evidence": "租约判断依赖backend(args)==flutter；已连接原生设备B且默认auto时判为device，但Flutter长截图仍走screenshotVm。内存打包真实controller并预先持有A租约：VM=A/native=B时，take_screenshot(mode=long,rawParts=true)仍返回ok:true，vmExecute实际收到take_screenshot(mode=long)，没有DEVICE_BUSY。",
      "detail": "长截图会滚动当前Flutter页面并恢复滚动位置。另一工作区持有设备A时，本工作区只要已连接原生B，就能在未申请A租约的情况下滚动A，破坏跨工作区输入独占和截图/手势稳定性。通过本地双设备绑定模拟复现，未操作真实设备；rawParts是现有工作台截图路径使用的参数。",
      "recommendation": "按操作真正使用的VM设备申请租约；Flutter长截图应独立于输入backend判断，只有同一原生绑定已持有该VM设备租约时可复用。增加VM=A/native=B且A被其他控制器占用时拒绝长截图的回归。",
      "requires_verification": false,
      "pre_existing": false
    }
  ],
  "notes_for_commit_message": [
    "范围：HEAD 979b632888a98bc58afcb6ab9c26e7647573a5a4 之上的全部已跟踪修改及15个新增文件；未排除新增文件。",
    "初始patch SHA-256: 5a9cf10fb31773785545fad325fa1350c04b6ab4caac2c37e6e5307822b1ef43；+15085/-286行，含独立lockfile。",
    "安全分层判定：HIGH；override=auto；security=full reviewer (high risk)；应用源码、供应链、大diff和env/credential赋值强信号。secret-pattern无命中，敏感路径无命中。弱信号：console.log/delete/endpoint/env/fetch/http/https/insert/session/update/url/where。",
    "条件路由：api-contract triggered（MCP schemas与第三方设备适配）；concurrency triggered（队列/取消/进程/租约）；performance triggered（树遍历和轮询）。",
    "额外读取：src/screenshot.ts——核对扩展截图和MCP截图消费者；src/devices.ts——核对设备发现和状态生产者；scripts/build.mjs/playwright.config.ts/scripts/ui-server.mjs——确认实际构建和工作台验证入口；tests/vm-ui.test.ts——核对VM失效与超时基线。",
    "额外读取：本机Flutter editable_text.dart及characters-1.4.1——由VM子代理核实UTF-16选区处理并执行最小算法复现；.harness/momory移动交互记忆及docs/mobile-automation*——核对已批准行为和设备验收边界。",
    "security full reviewer：完成硬编码机密、PII、敏感文件、安全反模式、环境泄漏及供应链输入完整性；无确认的凭据/PII泄漏。lockfile中487个无独立integrity条目均为inBundle=true，归属父包具有来源和integrity。",
    "视角覆盖：correctness、testing、maintainability始终覆盖；api-contract/concurrency/performance按触发覆盖。树遍历重复未取得足够实际性能证据，未报告推测性缺陷。",
    "额外读取：src/mcp/adapters.ts——核对Node运行时发现；src/engine.ts findAvailablePort——核对本机端口分配；src/automation/native.ts/lease.ts/vm/ui.ts——追踪文本编辑、输入释放、活动元素、租约和失效。",
    "外部原始证据：固定版本官方源码 https://raw.githubusercontent.com/appium/appium-xcuitest-driver/v12.22.8/lib/commands/wda/startup.ts 与 npm tarball https://registry.npmjs.org/appium-xcuitest-driver/-/appium-xcuitest-driver-12.22.8.tgz；子代理只在内存读取，确认WDA清理行为。",
    "外部原始证据：锁定的appium-webdriveragent 16.17.7中 FBElementCommands.m、XCUIElement+FBTyping.m，以及xcuitest 12.22.8 element.js；核对/value保留当前插入点。",
    "本轮复验：TypeScript与Webview类型检查通过；Vitest 477项/31文件通过；构建通过；Playwright 70项通过；Python代理21项通过、21项缺MITMDUMP跳过；Prettier和git diff --check通过。",
    "本轮定向验证：真实Unix IPC模拟50秒安装于45004ms返回SESSION_CLOSED；内存打包真实AutomationController复现错菜单唯一点击(45,95)；按固定WDA插入语义模拟append得到abcXdef；持有A租约且native绑定B仍向VM A分发长截图。",
    "根代理复核：在内存解包固定XCUITest 12.22.8官方npm tarball，确认startup.js cleanupApps的removeApp以及随包WDA /value shouldClear:NO和焦点已存在时直接保留插入点。未安装或执行第三方设备驱动。",
    "边界：本轮未重新执行真实Flutter设备fixture、真机或模拟器操作，未做破坏性WDA卸载验证、MITMDUMP集成或外部CVE在线扫描。历史设备验收记录不是本轮重新验收结果。模拟重现不等于真实设备验收。",
    "额外读取清单理由已由各模块审查记录汇总在以上条目；本轮业务代码未修改，仅新增此审查报告。"
  ]
}
```

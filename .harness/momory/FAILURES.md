# 问题与验证记录

## 移动交互代码审查六项修复（2026-11-13）

- 状态：六项源码问题已修复并补回归。原始审查报告保留 fail 历史快照，新增修复跟踪；不得将历史 107 项设备结果当作修复后的复验。
- WDA startup.cleanupApps 会卸载其他团队的 WDA，旧 v2 适配器未覆盖；v3 跳过该路径并拒绝旧回执，继续只清理自身资源。
- 全局可见编辑菜单不能证明属于目标字段；复用前和点击前都须核验。iOS 无障碍字段整框可能大于 RenderEditable，生产模板同时输出所属 TextField／CupertinoTextField 边界，不能仅靠 mock 出来的 inputBounds 测试。
- 任意 UTF-16 选区可拆坏 emoji／组合字符；用完整字符串字符簇边界，拒绝簇内偏移及外部提供的非法选区。原生 /value 保留当前光标，不能声称 append；无法可靠移动到末尾时必须在输入前拒绝。
- 客户端超时变长不改变宿主 45 秒限制；认证后共享工具期限并留出宿主余量。50 秒真实 IPC setup／connect 与取消回归通过。
- 长截图会滚动实际 VM 设备，租约必须由操作目标设备决定，不能依赖 auto 输入后端。
- iOS /source 快照包含 AppiumAUT 作用域，WDA XPath 查询直接从 Application 开始。把快照路径原样查询会误报过期节点；仅移除 iOS 路径的开头包装层，Android 原路径保留，两平台回归与真实双字段身份核验通过。
- 修复后复验：505 项 Vitest／34 文件、70 项 Playwright 通过；完整生产模板另含 25 项 Dart／Flutter 内部测试。独立 iOS 模拟器 152／152 项检查通过、无清理错误，涵盖错字段 cut／paste、Unicode 与原生追加拒绝。设备报告 artifacts/automation-flutter-smoke-report.json，清理与源码哈希见 artifacts/automation-fix-cleanup-report.json 和 artifacts/automation-fix-validation-evidence.json；Android／物理 iOS 仍未验收。

## 移动交互真实设备验收（2026-11-13）

- 已修复：W3C 拖拽只发起终点不能稳定触发排序。增加中间采样和释放前停顿；按实际排序／滑动删除结果通过。
- 已修复：惯性滚动期间 Flutter 子节点命中被屏蔽，反复滚动越过目标。读取 ScrollableState.position.isScrollingNotifier 等待停止；查找按指定区域后代限定，加入区域外同名项，原生横纵嵌套查找通过。
- 已修复：iOS 返回成功的组合键不能证明选区／剪切生效，硬件键盘偏好会影响行为。剪贴板使用可见原生菜单；从 EditableTextState.renderEditable 计算选区内点，点击而不长按折叠现有选区，并在 Copy / Cut 前复核选区。用中文文本、formatter、onChanged 和实际文本结果验证。
- 已修复：手势包含双击识别器时普通 tap 业务回调会延迟。取消后的输入验收用状态等待确认，不能在系统接受输入后立即断言回调已运行；最终取消、等待释放及下一次 tap 通过。
- 已修复：默认 Appium 模拟器附着会重启 headless 设备、写入共享偏好，并可能清理其他 XCTest 进程／留下自身 WDA。固定版本连接适配器 v2 跳过这些行为，仅清理自身 WDA；最终无 Appium / WDA 残留。早期试验已写入共享偏好，原始值未知，不擅自覆盖用户当前值。
- 验收边界：Android 未提供可用设备；iOS 真机未提供专用验收设备与签名 WDA，用户已配对真机未操作。硬件修饰键／方向键、其他语言、多行／密码编辑菜单及物理断线不能按模拟器其余通过项目外推。

## 长图被 GPU 纹理尺寸限制缩放（2026-11-12）

- 状态：已修复。首次真实模拟器测试在 Flutter 内合成长图，期望 804 × 9082，实际 PNG 为 725 × 8192，末尾缺失；渲染器返回成功不等同完整输出。
- 改为 Flutter 逐条带界限裁取 PNG，校验每段尺寸；扩展端 pngjs 在 CPU 内存拼接并核验累计高度。真实输出 804 × 9082，目视确认 Item 79 和拼接处完整；超过 8192 高度的像素边界另有回归测试。

## API 最新详情陈旧与 Mock 接入计数残留（2026-11-11）

- 状态：源码已修复；402项Vitest、53项Playwright、类型、格式及构建通过。随后授权发布0.0.10并CLI安装，包与安装文件一致；用户活动Cursor窗口仍需重载后加载新源码。
- 已确认：API已打开详情不会随新请求刷新；Isolate变化或同步失败后旧instances可能继续显示已接入。前者以新响应自动更新集成测试闭环，后者以外部重启与失败状态回归闭环。用户截图中INDIVIDUAL也有实际未命中历史证据，不能将全部现象归为展示缓存。
- 已用当前已安装插件重载原规则并导航账户页，确认新记录命中MARKET_MAKER且RWA列表警告恢复。重启首请求可能早于注入；最新源码的真实IDE热重启恢复尚未验收，不把合成单测等同用户当前运行版本已修复。

## Cursor 设置入口卡死及已有 VM 补查无法恢复（2026-11-10）

- 状态：源码已修复，354 项单测、37 项 UI、类型、格式与构建通过；随后用户授权发布0.0.6及Cursor CLI安装，交付证据见artifacts/v0.0.6-install-report.json。未启动 IDE GUI 复验。
- 用户确认从工作台点击设置、尚未修改即卡死。Cursor main.log 在 15:55:49 记录窗口8阻塞15秒，随后无响应；6次采样均在 RPC serializeReplyOK / JSON.stringify，扩展宿主随后正常 exit0。本机 Cursor 的 openSettings 返回设置编辑器实例，宿主 executeCommand 会导致 renderer 序列化该对象图。
- 两处设置入口改为原生 command URI，仅放行 workbench.action.openSettings；移除 settings.open 消息处理。不能仅删除 await，因为序列化发生在宿主收到返回值之前。
- 用户确认先通过 Cursor Run/Debug 运行 Flutter。发现已有会话补查 start 一次性锁存，首次 API / DTD 查询失败或断线后再打开工作台无法恢复。改为每次打开重新补查、并发去重、恢复相同 URI 的 DTD 连接，失败关闭连接并阻止旧代结果回写。
- 合成 DTD / VM 的扩展整合已验证首次 Editor 未就绪后打开工作台自动连接已有会话，不需要新调试事件，Mock / WS 仍关闭且不泄漏认证地址。该证据不等于用户当前 Cursor 真实会话已复验。

## VM DDS 跳转失败与连接状态误导（2026-11-08）

- 状态：已修复；174 项单测、24 项 UI、真实 Flutter DDS 只读 RPC 及打包后的 Cursor 隔离宿主验证通过。安装已覆盖，活跃用户窗口等待手动重载。
- 用户在 EXIO worktree 输入 VM 地址后收到统一连接错误；原日志没有保留底层原因，无法从该截图确定当次输入或失败阶段。
- 实际复现：当前 Flutter 原始 VM WS 返回 HTTP 302 到本机 DDS，旧 client 设置 followRedirects:false 导致连接失败。新 client 受限跟随本机跳转后，只读 getVM 成功返回 VM 和 1 个 Isolate；未修改 EXIO 源码或触发业务请求，未记录认证路径。
- 状态缺陷：已连接仍允许再次输入并连接，隐式断开会重置 Mock；断开后保留旧 endpoint，截图端口可能是上次成功端点，不能据此断言用户当次地址过期。初始化期间 socket close 后存在回写 connected 竞态。
- 修复：安全的本机 DDS 跳转、脱敏分类提示、前后端重复连接保护、成功提交前核验实际 socket、断开/失败清运行态。用户确认已连接禁用输入且只保留断开，换地址先断开。

## EXIO 登录 MFA 在代理链路超时（2026-11-08）

- 状态：待归因、待修复；此前 HTTPS 首页和 Mock 验收不代表登录链路已经通过。
- 事实：密码登录接口返回 HTTP 200；随后同一组四条 `POST /api/v1/public/auth/login-mfa` 均无响应快照，约 10,003–10,007 ms 后记录 `client disconnected`。请求前后快照及目标地址一致，无规则命中、无 Mock。唯一教程规则停用。
- 四条开始时间相差约 13 / 15 / 20 秒，与 EXIO 的 10 秒超时及 3 / 5 / 10 秒重试间隔吻合；不能把四条历史直接解释成用户提交四次。
- 非认证对照：两个公开 GET 接口直连 HTTP 200（约 4–5 秒），同批经过当前代理均等待 15 秒无响应；指定可达 IP、保留域名和 TLS 校验后，代理可返回 200（约 1–2 秒）。后续普通域名代理请求又恢复 200，DNS 返回节点中也观察到连接超时。支持代理上游连接/节点选择存在间歇性问题，尚不能锁定 DNS、CDN 或引擎的单一根因。
- EXIO 提示缺陷：`TwoFactorErrorText.mfa` 未检查 `LoginMfaFailure.isNetworkError`，无业务 code 的网络异常显示为通用 `Verification failed`；该提示不能证明验证码错误。
- 下一步：用不含账号的公开接口继续采集代理 DNS、上游建连/握手阶段及失败节点信息；比较域名直连、代理和指定节点，验证恢复与超时行为；修复 EXIO 网络错误提示。登录成功需用户用有效验证方式实际验收，本次不重放认证请求、不修改业务代码、不保存认证正文或凭证。
- 临时恢复：停止当前调试，切回 EXIO 原 `exio_app` 启动项并重新运行，再停代理；不能在 App 仍指向代理时直接停止引擎。

## 0.0.2 VM 待验收边界（2026-11-08）

- 状态：VM 在真实 Flutter iOS 模拟器的零源码采集 / Mock 已通过，不代表所有设备或项目通过。
- 尚未实际验收 Android 模拟器、Android USB 真机、iOS 真机的 VM 路线；Profile/AOT/Release 注入不在当前承诺范围。
- 自定义 Dio adapter、原生插件 / WebView、应用拦截器提前 resolve/reject 的组合需逐项目验证；周期扫描无法保证新实例首请求已经接入。
- EXIO MFA 代理超时仍按上方条目待归因。VM 示例通过不构成 EXIO 登录修复结论，不重放认证请求或存储真实 VM 认证地址。

## WS 异步状态复活与旧 URL 误关联（2026-11-09）

- 状态：已修复并以回归测试验证。较早的历史刷新和scan等待SQLite期间断线可能回写在线/active；现使用epoch、refresh序号及每次await后校验。
- TCP端口可复用，单凭握手tuple不能把同一握手分配给新socket；仅成功101允许关联，维护握手所有权，不唯一时保持URL未知。关闭采集清握手缓存，不从历史导入运行时关联。
- 出站不能只包consumer._subscription，该订阅会被addStream更换；现使用协议transformer前稳定controller订阅。恢复handler前检查身份，外部工具持有的旧wrapper用record enabled再保证旁路。

## 热重载完成事件兼容（2026-11-10）

- 已修复：Dart3.13的IsolateReload成功事件可仅含isolateGroup而无isolate，按单个isolate匹配会误报TIMEOUT。现预读Flutter isolateGroupId并按准确group或isolate确认，补回归测试及真实Flutter验证。
- 已知边界：无源码变化时Flutter可能跳过VM reload事件；DAP返回也可能掩盖编译失败，因此保持completed=false并提示核对UI或IDE诊断，不声称成功、不自动重试。

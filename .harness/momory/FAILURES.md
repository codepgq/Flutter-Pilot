# 问题与验证记录

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

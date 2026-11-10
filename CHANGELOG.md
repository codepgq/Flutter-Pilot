# Changelog

## 0.0.4 — MCP 开发场景与双向 WS 消息（2026-11-09）

- 新增标准 MCP Prompts，提供 HTTP Mock、WebSocket Mock、Flutter UI 和完整验证流程四个模板，支持按任务读取、IDE 离线发现与获取。
- 新增 `inject_ws_message` 向 App 注入模拟服务端事件，以及 `send_ws_message` 经 App 当前真实 WS 连接发送给服务端；支持原始 `text` 或 `topic/data`，真实发送沿用出站规则和消息记录。
- 完善消息大小限制、准确连接校验、队列取消和断线处理；采集与 WS Mock 需显式开启，发送结果通过新消息及业务响应验证。
- 指南、模板及 README 突出下单成功/失败、资产信息等多状态开发场景，优先按 Key 精确操作组件并核对网络与页面证据。
- 标准 SDK stdio、真实 Dart WS/WSS 双向消息验证通过；Flutter 设备及客户端界面验收边界见 [验收记录](docs/validation.md)。

## 0.0.3 — 业务 WebSocket（2026-11-09）

- MCP 新增按主题读取的 `get_usage_guide` 和指南资源：介绍 HTTP/WS 规则编辑、Key 发现与 UI 操作、Mock 与网络验证闭环；初始化及工具描述引导 Agent 按任务主动使用，离线也可读取。
- 新增 MCP Tab：服务开关、Claude Code CLI / Codex CLI / App 项目或全局适配，默认项目；配置与实际握手状态分开，保留其他 MCP 配置并提示同名覆盖。
- 新增 stdio → 本地 Unix socket → 现有 Dart VM 桥接；按稳定 ValueKey 查找、点击、输入、滚动、等待及缺 Key 诊断，无需修改应用源码，不使用文本定位回退。
- Agent 继续编辑现有 HTTP/WS 规则文件，通过 MCP 重载、控制采集和 Mock、查询网络结果；规则加载与运行时实际应用分开报告。真实已验证范围见 `docs/mcp.md`、`docs/validation.md`。

- 新增独立 WebSocket Tab：连接列表、双向消息、正文与生效内容对比、JSON 格式化和摘要分页。
- 新增手动开启的实验性 VM WS 采集和独立 Mock 开关，支持文本整条替换、丢弃与向 App 手动模拟推送；不修改应用源码或 TLS。
- 项目 WS 规则独立保存到 `.api-mocks/ws-rules.json`；URL 未知时可创建当前连接临时规则，临时规则不落盘。
- WS 历史使用工作区隔离的私有 SQLite；正文和队列有界，断线及租约到期自动旁路，关闭工作台后继续记录。
- 新握手从 HTTP API 目录分离，旧 HTTP 历史保留；详细验证和支持边界见 `docs/v0.0.3-websocket.md` 与 `docs/validation.md`。

## 0.0.2 — VM Service（2026-11-08）

本版本沿用用户指定版本号；低于之前的 0.1.0，已有安装需使用 `--force` 覆盖 VSIX。

- 修复原始 VM WS 跳转本机 DDS 时连接失败，增加受限跳转和脱敏错误分类；修复初始化期间断开后误标为已连接及旧端点残留。
- VM 成功连接后突出显示已连接及实际端点，禁用地址输入，仅保留断开操作；前后端阻止重复连接，避免意外卸载已开启的 Mock。
- VM WS 改为新工作区默认且推荐接入，代理标注为备用方案；首次打开不自动启动缓存代理，已有工作区继续沿用保存的方式，兼容旧版无 mode 的代理连接配置。
- 规则启停改为简洁滑块开关，停用卡片保留正常对比度；保留悬停和键盘焦点反馈，移除冗余状态文字。
- 新增项目 UUID 绑定，配置和规则分别保存在项目 `.api-mocks/project.json`、`.api-mocks/rules.json`；同 UUID 的不同目录与 worktree 隔离本机历史，保留旧版数据迁移。

- 新增 Flutter VM WS 连接，默认只采集 API、请求与响应，无需代理引擎、CA 或应用源码补丁；关闭工作台后继续记录。VM 认证地址仅保存在会话内存。
- 新增主动开启的实验性 Debug/JIT Dio 运行时 Mock，支持已有 / 后续发现的多 Dio、本地 Mock、双向修改、转发、规则同步及 Hot Restart 重发现。VM 不支持手动断点。
- VM 专用 SQLite 历史及独立 API 目录，无引擎也可查询；共用原规则文件，保留代理接入与原历史。
- 新增 Mock 关闭 / 重新开启、异常断开租约旁路及重新开启冷却；明确新实例扫描窗口、正文上限、SDK profiling 内存和自定义拦截链边界。
- 真实 iPhone 18 Pro / iOS 27.2 模拟器完成 8 项零源码验证；纯 Dart 真实 VM 实测 Dio 5.9.0 / 5.10.0 / 5.11.1。详细范围见 `docs/v0.0.2-vm-service.md` 和 `docs/validation.md`。

## 0.1.0

- 优化 API 工作台：目录和请求从新到旧，目录可折叠及搜索，详情可放大；响应优先展示，正文自动尝试 JSON、原文切换与复制，保留数字精度。
- 首次提供 macOS 上 VS Code/Cursor 的 Flutter Dio API 调试工作台。
- 支持 HTTP/HTTPS 代理、双向修改、本地 Mock、目标转发、手动断点。
- 新增按 API 分组的 SQLite 请求历史和 JSON 规则管理。
- 新增固定版本引擎安装、设备连接、Dio 接入预览及保护性撤销。

- 默认随受信任的 Flutter 工作区后台启动代理，关闭工作台继续采集，保留手动启停和自动启动设置。
- 新增独立持久化 API 目录，保留累计调用、首次和最近调用时间；支持旧历史迁移、手动删除及后续重新发现。
- 记住连接端口、局域网地址和已选 Android 设备，启动时尝试恢复已授权在线设备转发。
- 关闭工作台释放断点并暂停人工断点交互，后台自动规则和记录保持运行。

- 支持 Dart workspace 根目录识别显式 Flutter 成员，兼容 EXIO 等多包项目的后台自动记录。

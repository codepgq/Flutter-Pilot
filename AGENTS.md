# Flutter Pilot 开发约束

本仓库是 TypeScript 扩展、React 工作台和 Python 代理。使用 npm；验证命令见 `package.json`。

## 开始工作

- Scene、UI 操作和 MCP 任务先读 [Scene 联调流程](docs/scene-authoring.md)，再按需读 [操作格式](docs/workflows.md)、[动作目录](docs/scene-actions-catalogue.md)、[MCP](docs/mcp.md) 和 [测试](docs/testing.md)。优先复用已有 Scene action。
- 当前决策保存在 `.harness/momory/PROJECT.md`，实现与失败经验分别在同目录的 `IMPLEMENTATION.md`、`FAILURES.md`。保留现有目录名；历史章节的旧 Workflow 配置格式以最新 Scene 约束为准。
- 用户说“发布一个新版本”时，按项目 memory 的“默认发布流程”完成提交、插件版本更新、新 tag、远端推送和 Cursor 安装，并记录验证结果。
- 保留工作区已有修改。修改业务调试项目时先读该仓库自己的规范，仅编辑用户任务需要的配置和源码。

## Scene 与操作

- `.flutter-pilot/scenes.json` 是每个业务项目唯一的持久 Mock / targets / actions 来源，保持 `version:1`。不读取、创建或迁移 `workflows.json`，不为动作目录再建运行配置或独立 catalogue。
- 公共操作保存在同一文件中的纯操作 Scene，业务入口使用 `call` 并显式映射参数。保持已有入口 ID 稳定；调用公共操作不激活或切换 Mock。Test Case 仍独立使用 v2 引用 Scene action。
- Flutter 重复操作优先使用经过实际验证的 `ValueKey<String/int>`，显式 `source:flutter`。`target` 是 `targets` 别名；运行器按 Key 重新匹配当前挂载控件，不要求 Agent 每步截图或 `find_widget`。缺 Key 时在已授权源码范围补稳定 Key；不把文字、坐标或临时 ref 当作自动回退。
- Key 放在真实可见、唯一且对应实际交互区域的控件上。保持实际指针输入、禁用和遮挡检查；不能为了让 `actionable` 成功直接调用业务回调。`wait_for_widget` 等待状态，不是模型探索或固定延时。
- 起始页不同就保存不同入口；描述前提、参数、终点及 Mock 要求。复用公共步骤，避免复制完整动作；秘密参数声明 `secret:true`，逐层调用保持脱敏。输入影响布局时显式 `hide_keyboard`，确认后再等待和点击。
- 激活、reload、重连、IDE 恢复不执行 UI。运行使用加载快照，动作与测试共享设备锁，期间禁止环境修改。失败即停，取消或结果未确认时先核对业务结果，不自动重放。

## 联调与交付

- 先发现准确项目和已有 Debug 会话；App 未运行才使用现有命名配置 `start_app`。启动超时先查会话，不重复启动，不自动改设备或清数据。
- 先读操作目录和参数；只在没有合适动作、Key 失效或页面前提不符时探索。编辑配置后 `reload_rules`，检查所需 Dio / WS 接入；无需等待与本次任务无关的所有网络域。
- 触发前记录网络基线。分别核对运行终态、最终 UI 和本轮实际 Mock 命中；`applied`、`completed` 均不能代替业务通过。出现 401 / refresh 循环先停止触发，补齐实际缺失接口，不清数据或用跳过认证掩盖问题。
- 启动首请求可能早于 VM 注入；惰性 Dio 的首请求也可能早于扫描。需要时在业务项目允许的开发入口提前创建正式客户端，复用正式启动和认证，不预置身份或覆盖 Provider。只声明实际验证的覆盖范围。
- 区分预期失败 Mock 和漏 Mock。请求相关的地址恢复等能力没有可靠夹具时保留明确未验收边界，不能伪造成功；登录到主页不等于资金、完整恢复或跨设备验收。
- VM 注入模板须在实际注入库的 imports / SDK 上验证；不要用 umbrella imports 掩盖运行时不可见的 Flutter 类型。异步测试等待真实状态或事件，不依赖极短 sleep。
- 新增或调整 MCP 能力，同步工具描述、同名 Prompt、离线指南、协议测试和文档；重要使用流程须在场景 Prompt、`capabilities` 与 `overview` 导航中可查阅，不能只写在仓库文档。保留离线 `prompts/list` / `prompts/get` 发现与读取，不让只读查阅依赖在线会话或触发运行时操作；可执行示例使用生产 schema / 编译器校验。
- 验证按改动范围运行类型、相关单元 / 协议及工作台测试、格式和构建。动作重构比较展开后的原子步骤与参数；归档记录证据和未验收范围。授权安装时核对 VSIX、源码与安装文件一致性，不擅自重载正在调试的 IDE。

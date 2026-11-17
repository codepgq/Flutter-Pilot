# 固定验收与推进规则

基线 v1，冻结日期：2026-11-16。各 phase 文件中的 Pxx-Axx 表格是验收要求的唯一正文；[progress.json](progress.json) 保存状态与条款 ID 索引，不另存一份不同标准。

## 状态与通过条件

phase 状态使用 `not_started`、`in_progress`、`verifying`、`passed`、`failed`、`blocked`。全部实现阶段初始为 `not_started`；分支/文档建档不算 phase-01 完成。

- 进入 `in_progress`：全部依赖已 passed，且已获覆盖该阶段的实现授权；整体实施授权可覆盖全部阶段，无需逐阶段再次确认。记录开始时间。
- 进入 `verifying`：任务交付齐全，执行固定条款及对应验证命令。
- 进入 `passed`：所有必需条款通过，证据对应实际源码，清理完成，报告归档，更新结果摘要和完成时间。
- 失败记 `failed`；缺少必需浏览器、证书、设备或客户端导致无法验证时记 `blocked`，写明缺项。修复或补环境后可恢复验证。
- 单项结果只能为 `not_run`、`passed`、`failed`、`blocked`、`skipped`；`skipped` 不等于通过。首轮所有 Pxx-Axx 都是必需项，不设置“可选失败”。
- 已验收条款相关实现后续再改动时，将受影响条款标记待复验；不能仅引用修改前的通过结果。
- 只做与变更相关的测试；phase-07 执行最终完整回归，不在每个小改动反复执行全部真实设备测试。

## 每个条款的证据

使用 [报告模板](acceptance-report.template.md)，在 `evidence/phase-NN.md` 归档至少以下信息：

1. 基线版本、phase ID、验收条款 ID、预期与实际结果、结果状态。
2. 基础 commit；如有未提交实现，附补丁 SHA-256 和文件清单；所有证据采集后再改代码则补复验记录。
3. 实际命令、退出码、通过/失败/跳过数量，浏览器/引擎/SDK/系统/客户端版本及夹具来源。
4. 本轮 runId、运行时/页面标识、请求/消息基线、ruleId、mocked、业务 ID 和 UI 断言；标识按需要脱敏，不记录认证 URL 或真实凭据。
5. 日志、截图或 JSON 报告相对路径与 SHA-256；原始输出默认放 `artifacts/web-flutter-runtime/<phase>/<run>/`。该目录被 Git 忽略，必需事实、结果和校验值必须同时写入受版本管理的验收摘要，不仅给出将来可能丢失的本机路径。
6. 恢复和清理结果、限制、失败/阻塞项、下一步。合成工作台、SDK stdio、真实浏览器、真实 Flutter、真实 Agent 客户端证据分别标注。

本轮建档不创建填有“passed”的阶段报告。源时钟/事件序列要来自具体采集器，不能直接将浏览器、代理与 Dart 的时间戳当作同一时钟；旧在途请求、setup 请求和其他目标不能满足本轮断言。

## 通用验证入口

以下命令已存在于当前 package.json，按阶段涉及范围使用：

```sh
npm run typecheck
npm test
npm run test:proxy
npm run test:ui
npm run format:check
npm run build
git diff --check
```

相关单元/协议可以通过 `npm test -- <实际测试文件>` 选择；工作台可用 `npm run test:ui -- <实际 spec>` 选择。Markdown 规划文档额外执行：

```sh
node_modules/.bin/prettier --check "docs/roadmap/web-flutter-runtime/**/*.md" docs/roadmap/web-flutter-runtime/progress.json
```

`npm run test:proxy` 未设置有效 `MITMDUMP` 时会跳过真实集成。phase-02 与 phase-07 必须设置实际引擎绝对路径并重新运行真实代理用例；HTTPS 使用测试 CA 信任，不能以 TLS 绕过通过。

真实 Flutter 使用仓库已有 `test:vm`、`test:vm:flutter`、`test:ws:flutter`、`test:ui:flutter`、`test:mcp:flutter` 等实际入口，按变更范围和参数选择独立夹具。先检查脚本如何启动/绑定设备，不能默认操作用户当前模拟器或业务 App。

## 阶段验证入口

以下 npm scripts 已随各阶段实现。脚本存在不代表验收通过；实际命令、退出码、夹具、结果和清理以阶段报告为准：

| 新入口                 | 负责 phase | 最低职责                                                                      |
| ---------------------- | ---------- | ----------------------------------------------------------------------------- |
| `test:web:proxy`       | phase-02   | 真实 Chromium → 代理 → 本地 HTTP/HTTPS；CORS、预检、命中与上游计数            |
| `test:web:http`        | phase-03   | 生产 Worker → 浏览器 HTTP 拦截、首请求、Context 隔离、退出及恢复              |
| `test:web:ui`          | phase-04   | 真实 DOM 交互、frame、截图、Scene 编译与动作执行                              |
| `test:web:ws`          | phase-05   | 真实 WS/WSS、规则、发送/注入、断连及目标隔离                                  |
| `test:web:e2e`         | phase-06   | 生产 Test Runner 的 HTTP/WS/UI 关联及失败/取消/清理反例                       |
| `test:mcp:web`         | phase-07   | 构建后的 MCP stdio 调用生产 Web Adapter，覆盖发现、规则、动作、测试与离线说明 |
| `test:web:coexistence` | phase-07   | 真实 Flutter 夹具与 Web Worker 并存、同路径规则隔离及 Worker 故障不串扰       |

测试浏览器必须调用生产规则同步、适配器和运行器。用测试内 `page.route` 自己返回数据而绕过插件 Mock，只能证明夹具可用，不能计为产品通过。工作台 Playwright 测试仅验证工作台 UI，也不能替代真实业务浏览器验收。

## 统一交付门槛

- 所有新增/调整 MCP 能力在所属 phase 同步工具描述、schema、同名 Prompt、离线指南、场景 Prompt、`overview`、`capabilities` 和协议测试。
- 生产 schema/编译器校验随包示例；运行定义只保存在 Scene v2 目录，Test Case 保持 v2，不生成 workflows.json 或第二份动作配置。
- 读取状态/说明无副作用；激活、reload、重连和恢复不执行 UI；取消或未确认不自动重放。
- 安装、发布、推送和活动 IDE 重载不是“阶段通过”的隐含动作。打包验证可使用隔离产物；正式发布按用户指令执行。

## 基线变更记录

| 版本 | 日期       | 原因                                    | 变更范围                           | 追踪           |
| ---- | ---------- | --------------------------------------- | ---------------------------------- | -------------- |
| v1   | 2026-11-16 | 用户要求存储最终/阶段目标并固定验收标准 | G01–G10、7 个 phase、53 条必需验收 | 本分支初始规划 |

修改验收预期、必需性、支持范围或 phase 归属时新增一行并提升版本；保留原条款 ID，说明替代关系和目标影响。文字修正、证据补充和执行状态更新不改变标准，不需要提升基线。不能静默删除失败条款或将未执行改为已通过。

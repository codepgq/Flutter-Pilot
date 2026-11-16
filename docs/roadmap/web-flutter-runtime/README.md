# Flutter / Web 统一运行时路线图

创建日期：2026-11-16。验收基线：v1。工作分支：`codex/web-flutter-unified-runtime`。
起点提交：`efc65160703fdf44aef200751a2dd1dfbb5292df`（0.0.22）。

本目录保存最终目标、架构边界、阶段任务与验收标准。它是开发规划，不表示当前插件已支持 Web。当前只完成分支与规划建档，全部实现阶段均未开始；状态以 [progress.json](progress.json) 为准。

## 最终交付

在同一个插件和代码仓库内，以默认一个 MCP 服务入口支持 Flutter Debug 与 Web 浏览器项目。共享 Scene、Mock、动作、测试及证据模型；Flutter 与 Web 使用独立运行时和独立状态。Web 浏览器操作在独立 Worker 中执行，依赖按需准备，已有 Flutter 使用方式保持兼容。

- [最终目标与范围](goals.md)：G01–G10、首轮支持矩阵、明确排除项。
- [架构决策](architecture.md)：公共核心、适配器、目标身份、隔离和兼容方案。
- [验收约定](verification.md)：证据格式、检查命令、阶段状态与基线变更规则。
- [验收报告模板](acceptance-report.template.md)：每次验收逐条填写，模板本身不是通过证据。

## 阶段与依赖

| Phase                                          | 阶段目标                     | 依赖     | 可交付结果                                       | 固定验收条款 |
| ---------------------------------------------- | ---------------------------- | -------- | ------------------------------------------------ | ------------ |
| [phase-01](phases/phase-01-runtime-core.md)    | 运行时核心与现有代理路由修复 | 无       | 公共接口、明确目标、VM/代理查询和开关分流        | P01-A01–A07  |
| [phase-02](phases/phase-02-web-proxy.md)       | Web 项目与代理 HTTP Mock     | phase-01 | 浏览器手动操作，工作台和 MCP 查询真实代理命中    | P02-A01–A07  |
| [phase-03](phases/phase-03-browser-runtime.md) | 独立浏览器运行时与 HTTP 拦截 | phase-02 | 浏览器 Worker、Context、页面生命周期及首请求拦截 | P03-A01–A08  |
| [phase-04](phases/phase-04-web-actions.md)     | Web UI、截图与 Scene actions | phase-03 | 稳定 DOM 目标、真实交互、截图和可复用动作        | P04-A01–A08  |
| [phase-05](phases/phase-05-websocket.md)       | WebSocket 采集与 Mock        | phase-04 | 双向消息、替换/丢弃、准确连接注入及记录          | P05-A01–A07  |
| [phase-06](phases/phase-06-business-tests.md)  | Web 业务测试与证据关联       | phase-05 | HTTP → WS → UI 关联断言、取消及环境恢复          | P06-A01–A08  |
| [phase-07](phases/phase-07-delivery.md)        | 双端验收与交付准备           | phase-06 | 双端共存、真实 MCP 验收、分发检查与最终证据      | P07-A01–A08  |

各阶段顺序推进，前一阶段验收通过后才开始下一阶段的业务实现。阅读、方案调查和准备不依赖上一阶段通过，但不能提前把后续阶段标为实现完成。Phase 不是新的 Codex 聊天，也不会自动建立调度任务。

## 里程碑

- M1：phase-02 通过，Web HTTP 代理 Mock 可用；此时不宣称网页自动化、WS 或业务测试已支持。
- M2：phase-04 通过，托管浏览器的 HTTP Mock、页面操作及 Scene actions 可用。
- M3：phase-06 通过，Web HTTP/WS/UI 业务测试形成完整证据链。
- M4：phase-07 通过，G01–G10 全部满足，达到本路线图的交付标准。

## 执行方式

1. 读取当前 phase、前置报告和项目规范，确认实际源码与环境。
2. 先将阶段需要的新验证入口实现为可运行 npm script；规划中的命令不能当作已有能力。
3. 按该 phase 的任务实现，更新任务复选框；任务完成不代表验收通过。
4. 按固定条款记录预期、实际、证据、失败与跳过，生成 `evidence/phase-NN.md`。
5. 只在全部必需条款通过、证据可核对且环境清理完成后将阶段状态置为 `passed`，再推进下一阶段。

本次建档不启动任何实现 phase，不自动提交、推送、发布、安装或操作用户业务 App。后续执行由用户的实现指令开始；发布仍遵循仓库的显式发布流程。

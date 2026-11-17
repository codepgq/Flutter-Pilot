# phase-07：双端验收与交付准备

依赖：phase-06 passed。目标：G01–G10 最终核验。验收基线：v1。

## 阶段目标

验证同一个插件/MCP 的实际双端使用、故障隔离、离线发现和分发产物，形成完整且可追溯的最终交付报告。本阶段默认不发布、安装或推送。

## 任务与产出

- [x] P07-T01：新增 `test:mcp:web`，从构建后的 stdio 入口驱动生产 Web Adapter；新增 `test:web:coexistence`。
- [x] P07-T02：执行原生 HTML、React、Vue 的完整 Web 夹具矩阵，以及独立 Flutter iOS 模拟器回归。
- [x] P07-T03：以一个真实 Agent 客户端验证发现、能力理解和实际 Web 调用，区别 SDK 与模型行为证据。
- [x] P07-T04：核对首次使用、依赖未准备、断线、取消、进程退出、IDE 恢复及多目标错误场景。
- [x] P07-T05：生成并核对隔离 VSIX 产物，检查 Worker/清单/私有依赖路径与 bridge；更新用户文档与支持矩阵。
- [x] P07-T06：填写最终验收报告、G01–G10 对照及所有遗留限制，更新 progress 与项目 memory。

## 固定验收标准

| ID      | 必需预期                                                                                                                                                     | 验证方式                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| P07-A01 | 一个 MCP 服务配置可同时发现 Flutter 与 Web 目标，明确选择后分别运行 Scene/测试；同路径不同返回值不串 Mock、历史、UI 或状态                                   | test:web:coexistence，真实浏览器和独立 Flutter 夹具   |
| P07-A02 | 新代码真实 Flutter 回归通过 HTTP 采集/Mock、WS、Key actions 与截图；旧项目/Scene v2/Agent 绑定兼容；Android/真机未复验如实列明                               | 独立 iOS 模拟器、既有生产 smoke 与证据                |
| P07-A03 | Web 全量核心路径在原生 HTML、React、Vue 真实 Chromium 夹具运行；实际引擎 HTTP/HTTPS 代理和浏览器直接拦截均有通过证据                                         | 新增 Web scripts 与真实 proxy 集成，无必需跳过        |
| P07-A04 | 构建后 MCP SDK stdio 验证生产 Web 路径；至少一个实际 Agent 客户端完成发现、HTTP Mock、Scene action 与 run_test，并查询网络/UI/测试结果                       | test:mcp:web ＋实际客户端独立记录，不能仅自检握手     |
| P07-A05 | Worker 崩溃/重启、页面关闭、IDE 恢复和网络断开不复活旧 run/连接或重放 UI；Flutter 会话继续使用；本轮自有进程/端口/临时环境可完整清理                         | 双端故障注入、恢复前后计数与资源核对                  |
| P07-A06 | typecheck、全部单元/协议、工作台 UI、格式、build 及必需真实脚本通过；记录基线/最终启动时间、内存、包体积及测量环境；未启用 Web 的 Flutter 无浏览器准备和启动 | 全量日志与前后测量，不凭单次耗时承诺 SLA              |
| P07-A07 | 隔离 VSIX 包含 Worker、资源和清单，解包产物与源码构建一致，离线 bridge 可发现/读取工具和 Prompts；不混入本机历史、用户配置、CA 私钥或浏览器 Profile          | 打包文件/哈希清单、隔离 bridge 核验，无需安装活动 IDE |
| P07-A08 | G01–G10 全部有对应条款和当前源码证据，七阶段报告完整；README/指南/Prompt/支持矩阵不宣称 SSR、Flutter Web DOM、未测平台或接入前流量全覆盖                     | 最终报告、文档/协议一致性与限制逐项复核               |

## 验证与移交

执行 [verification.md](../verification.md) 的完整检查及全部已交付 Web scripts。真实 Agent 客户端涉及用户现有配置时先检查可复用会话；不能私自覆盖配置或重载活动 IDE。缺少真实客户端或独立 Flutter 环境时此阶段保留 blocked，不能用 SDK/单元结果代替。

交付 `evidence/phase-07.md` 与 `evidence/final.md`。最终报告逐条列 G01–G10、支持矩阵、源码标识、命令/证据、清理及限制，满足 M4 后将路线图置 completed。正式 commit/tag/push/安装仍在用户要求发布时按默认发布流程执行。

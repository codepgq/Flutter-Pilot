# phase-04 验收报告

基线 v1；2026-11-17；passed。基础提交 `efc65160703fdf44aef200751a2dd1dfbb5292df`；前置 phase-03 passed。未提交实现补丁和文件清单见校验值。

生产 Worker 的 DOM 操作与现有 WorkflowController/SceneStore 编译执行，私有 Chromium 158.0.8127.18 / Playwright 1.65.0，macOS arm64、Node 26.8.1。夹具为本地原生 HTML、真实 React、锁定 Vue 3.5.13；仅夹具自身业务处理使用 JS，插件未注入业务回调。

| 条款    | 结果   | 实际证据                                                                                                                                            |
| ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| P04-A01 | passed | Web source/testId 或显式 role/name，frame.testId 定位；重复、缺失、失效 frame 分别拒绝；生产 schema 拒绝混合 Flutter 字段、临时 ref 和缺 Page。     |
| P04-A02 | passed | 三类真实页面输入事件、单次 submit 计数和最终 Submitted 内容；禁用和遮挡按钮 NOT_ACTIONABLE，不 force、不调用组件回调。                              |
| P04-A03 | passed | present/absent/visible/enabled/actionable/text 状态和 WAIT_TIMEOUT 最后观测验证；真实 wheel 只移动 inner，边界不链到 outer。                        |
| P04-A04 | passed | screen/full_page PNG 尺寸与头部一致；目视确认 TOP START/BOTTOM END；超 16384 高拒绝；构建后 MCP SDK stdio 返回生产浏览器的 PNG image。              |
| P04-A05 | passed | Scene v2 中跨 shared/flow call 带 secret 输入，共 3 步完成；每步重新匹配，结果无秘密参数；随包 Web 示例经生产编译器验证。                           |
| P04-A06 | passed | 运行期间同 Context reload/tap 拒绝；取消后不执行 submit；外部关闭 Page 终止运行且无提交；独立 Context 可导航。                                      |
| P04-A07 | passed | 旧 Flutter workflows/参数/示例/键盘与协议回归通过；Web 混入 hide_keyboard 在整条预检拒绝，前置 tap 未执行。                                         |
| P04-A08 | passed | 工作台固定 Page，显示截图和动作步骤失败位置，窄屏深色结果通过；同名 Prompt、场景 Prompt、capabilities、overview.browserRuntime 与生产 schema 同步。 |

验证退出 0：`test:web:ui` 71/71；`test:web:http` 31/31；11 文件相关单元/协议 162/162；工作台相关 5/5，scene-actions 16/16；typecheck、format:check、build、git diff --check 通过。MCP 图片验证为 SDK 客户端，不冒充真实 Agent 行为。

真实 UI run `2026-11-17T03-29-47-775Z`；报告保存 Context/Page、完整展开路径、定义指纹、脱敏运行和服务器事件。截图目视核对 run `2026-11-17T03-25-57-998Z`，后续相同页面的尺寸/内容检查持续通过。HTTP 复验 run `2026-11-17T03-28-36-232Z`。本轮无必需跳过。

Context、Worker、自有浏览器、临时目录和服务器均在 finally 清理。Web 仅支持列出的 DOM 能力，不含设备手势、移动软键盘；full_page 不等于 Flutter long。completed 仍不表示业务 passed。未安装、发布、推送。下一阶段 WS。

## Evidence hashes

- `artifacts/web-flutter-runtime/phase-04/20261117-final/browser.log` SHA-256 `270c02a55e5118ea3edd506bd6f752a634fa5e3e239157cfb9044f236684e167`.

- `artifacts/web-flutter-runtime/phase-04/20261117-final/build.log` SHA-256 `d425d2e206f5c4119a2750b71c61eec93793eeebac44911fc7b0b02b6a1f9c11`.

- `artifacts/web-flutter-runtime/phase-04/20261117-final/files.json` SHA-256 `f613d18120453cfae4ea2d260d6a087ad8f61e8f4fbb2b81f7ba483b1046c380`.

- `artifacts/web-flutter-runtime/phase-04/20261117-final/format.log` SHA-256 `c55a6adf7e45dc84809d087b404b41bb6607f0e29c2857e0ad7d70d3f58e8fc9`.

- `artifacts/web-flutter-runtime/phase-04/20261117-final/http.log` SHA-256 `1d4a992e1043df4e86541f78e4144854476212f043980966deafa27c738058c5`.

- `artifacts/web-flutter-runtime/phase-04/20261117-final/implementation.patch` SHA-256 `d32f27d42b53e6f5f24a069a77daad8ca6f6e3c6be3b3c5234b109fa6684e0eb`.

- `artifacts/web-flutter-runtime/phase-04/20261117-final/scene-ui.log` SHA-256 `4464ab98f1f8435764bcdf9dc9ba3c7560f5acb1195be9cc27574ca8fe1bc1fb`.

- `artifacts/web-flutter-runtime/phase-04/20261117-final/tests.log` SHA-256 `2cdb49b164a739bb7b2d62adff5a09850367797e65bb649f1f186615df00d122`.

- `artifacts/web-flutter-runtime/phase-04/20261117-final/typecheck.log` SHA-256 `593487df21ca068acf5d9d80e0453ae9e2998b5afd81b1d2538d093977bfa50d`.

- `artifacts/web-flutter-runtime/phase-04/20261117-final/ui.log` SHA-256 `be5b86b5c741ab985a39023bf0d58ab56bce89b5fc10051423e98c02a7ee5968`.

- `artifacts/web-flutter-runtime/phase-04/2026-11-17T03-29-47-775Z/full_page.png` SHA-256 `eeba748f9b9e5aa320085cc9c29989938e04c2e98a5333d0440612f308b708e9`.

- `artifacts/web-flutter-runtime/phase-04/2026-11-17T03-29-47-775Z/report.json` SHA-256 `e892ec4b44c550d5b2e3c08c4af55f8bafd6498eacaee6432f546317b85ab248`.

- `artifacts/web-flutter-runtime/phase-04/2026-11-17T03-29-47-775Z/screen.png` SHA-256 `5acebc71dafd2f93f054b01cfb13443c023d8f6b0aea22d5c6ea30837a03b43c`.

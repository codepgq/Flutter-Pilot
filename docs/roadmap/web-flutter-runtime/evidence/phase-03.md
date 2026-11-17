# phase-03 验收报告

基线 v1；2026-11-17；passed。基础提交 `efc65160703fdf44aef200751a2dd1dfbb5292df`，未提交实现见下方补丁及文件清单。前置 phase-02 已通过。

生产 BrowserController 使用独立认证 Worker、私有 Playwright 1.65.0 / Chromium 158.0.8127.18，macOS arm64、Node 26.8.1。实际浏览器调用生产 SceneController、规则同步、历史及生命周期；MCP SDK stdio 与合成工作台分别验证协议和入口。真实 Flutter 并存及真实 Agent 客户端留待 phase-07。

| 条款    | 结果   | 实际证据                                                                                                                                                                            |
| ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P03-A01 | passed | 状态/构造/离线 Prompt 不启动或安装；真实依赖安装中取消，清理 staging，显式重试成功，损坏 receipt 被拒绝；锁文件与可执行文件 SHA-256 可查询。                                        |
| P03-A02 | passed | 独立 PID、认证/代次校验、超时和取消后拒绝继续动作；关闭后迟到响应丢弃；SIGKILL 后回收自有 Chromium 并作废目标，重建无 UI 重放；扩展 VM 路由回归通过。                               |
| P03-A03 | passed | 固定 Context/Page 创建、列举、导航、刷新、关闭；外来 Page、关闭目标和旧代次拒绝。工作台提交准确目标，协议 schema 验证必需身份。                                                     |
| P03-A04 | passed | 先激活 a/b，再首次导航；两 Context 的 fetch/XHR 分别命中 requestRuleId=a/b，上游无 /first 请求；正常、503 Mock、原始/有效修改可查询。                                               |
| P03-A05 | passed | 优先级、匹配、双向修改验证；multipart 真实正文保留、二进制不编辑；已知/未知长度 1048577 字节正文完整，SSE 首消息到达。direct 无代理，32 MiB/1000 条有界历史。                       |
| P03-A06 | passed | 两 Context 首次 Cookie 为空，其后分别 fixture=a/b；localStorage 各从 1 开始，同 Context 再开为 2；规则与历史分离；崩溃重建 runtimeId/generation 更新且无重放。                      |
| P03-A07 | passed | Service Worker 无上游注册请求，cache 策略可查。真实 credentials 请求 OPTIONS 到达上游；拒绝预检后 POST 未发出，普通错误 CORS 页面无法读取。未关闭浏览器安全检查。                   |
| P03-A08 | passed | build 产出独立 browser-worker.cjs 和资源清单；9 个生命周期工具由同名 Prompt、capabilities、overview.browserRuntime 发现；stdio/离线协议通过；自有浏览器/临时 Profile/服务器已清理。 |

验证命令均退出 0：`test:web:http` 31/31；`test:web:dependencies` 5/5；指定 MITMDUMP 12.3.1 的 `test:web:proxy` 34/34；browser-runtime、mcp-guide、mcp-transport、extension 共 147/147；工作台 Web/浏览器/VM 自动发现 5/5；typecheck、相关 prettier、build、git diff --check 通过，无必需跳过。

真实 HTTP run：`2026-11-17T03-16-59-099Z`；报告含 runtimeId/generation/pageId、请求 ID、ruleId、mocked、上游计数及依赖摘要。代理复验 run：`2026-11-17T03-16-13-248Z`。首请求用新 Context 的空历史为基线；取消用 /slow 上游计数确认没有重放。

修复过程中发现 Playwright 常规 route 自动应答预检；生产改用 CDP Fetch 的请求/响应阶段，不以自动 CORS 头掩盖拒绝。未知长度正文只截断历史快照，继续原响应；流式在收到响应头后直接继续。强制 Worker 退出由父进程回收其认证上报的 Chromium 进程组。先前失败已在最终 31 项重新验证。

范围：显式 open 的首次导航前拦截就绪；弹窗仅覆盖接入后的流量。不捕获 SSR，不附着日常 Profile，不支持本阶段的 Web UI/WS/Test。未发布、安装或推送。后续改动相关路径需复验。

## Evidence hashes

- `artifacts/web-flutter-runtime/phase-03/20261117-final/browser.log` SHA-256 `b7becc9328d3b3fb46a3363963e71f7ebeb7735925dfb7f11b6982ed7f635036`.

- `artifacts/web-flutter-runtime/phase-03/20261117-final/build.log` SHA-256 `d425d2e206f5c4119a2750b71c61eec93793eeebac44911fc7b0b02b6a1f9c11`.

- `artifacts/web-flutter-runtime/phase-03/20261117-final/dependencies.log` SHA-256 `c8f72fe98928d5bbbcdeda72cd9983eb0db7b90297c9a5367336afc2d0b9ea6f`.

- `artifacts/web-flutter-runtime/phase-03/20261117-final/files.json` SHA-256 `fa52148e43d854729075ca246a205cfd0c3e67a5a83494fc5515364b122bc4e3`.

- `artifacts/web-flutter-runtime/phase-03/20261117-final/format.log` SHA-256 `17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20`.

- `artifacts/web-flutter-runtime/phase-03/20261117-final/implementation.patch` SHA-256 `9ae026a4e87e878b6700cc276607767290f8c7b333ca56f9cf6c8cb56e8f3caa`.

- `artifacts/web-flutter-runtime/phase-03/20261117-final/proxy.log` SHA-256 `d86a2cef7ff6e41af531c4923376a5652f2c1f2f557eb053eda08fbcce1c827c`.

- `artifacts/web-flutter-runtime/phase-03/20261117-final/tests.log` SHA-256 `ca90b700f1f6408422a17d99dbc766d898db0681a594753ca752e60fc70cc372`.

- `artifacts/web-flutter-runtime/phase-03/20261117-final/typecheck.log` SHA-256 `593487df21ca068acf5d9d80e0453ae9e2998b5afd81b1d2538d093977bfa50d`.

- `artifacts/web-flutter-runtime/phase-03/20261117-final/ui.log` SHA-256 `9bf09e62b2bfe51a19ff5128fe2dd6d1ed93d4bffe02cd640fed9d84954ba8bc`.

- `artifacts/web-flutter-runtime/phase-03/2026-11-17T03-16-59-099Z/report.json` SHA-256 `c9a58120e89c65282434611d66fa0ee04fc6273e5125eca1e585e2e856384e0e`.

- `artifacts/web-flutter-runtime/phase-03/2026-11-17T03-16-59-099Z/cleanup.json` SHA-256 `ebc181fe44ed435cf5a05192a4766e0012460b70e99f9e91f17351c0c9b204f6`.

- 原依赖生命周期报告使用固定输出目录，phase-07 复验覆盖了该文件；原始历史校验值为 `35366afa648aa5d099ccca0938c2aa05e86b0d389fe5582815be540e7bb9c3bb`，不再把该路径当作不可变历史证据。已修正脚本按时间戳归档，并重新执行5项全部通过；以下独立复验证据替代该单项引用。

- `artifacts/web-flutter-runtime/phase-03/2026-11-17T04-17-16-105Z-dependency-lifecycle/report.json` SHA-256 `5549693a95359b653e9248dadad819d062b9a33c3bdf44f6e7d046fc82101ad0`.

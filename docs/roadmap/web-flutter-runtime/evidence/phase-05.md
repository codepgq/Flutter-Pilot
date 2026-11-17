# phase-05 验收报告

基线 v1；2026-11-17；passed。基础提交 `efc65160703fdf44aef200751a2dd1dfbb5292df`，前置 phase-04 passed。生产 BrowserSockets/Worker/SceneController/MCP，Chromium 158.0.8127.18、Playwright 1.65.0、macOS arm64、Node 26.8.1；本地 WS 和带测试 CA 的 WSS 夹具。

| 条款    | 结果   | 实际证据                                                                                                                                                                      |
| ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P05-A01 | passed | WS/WSS 文本双向记录 URL、Context/Page/连接、原始和有效正文；私有 CA 正常 WSS，未信任 Worker 发生 TLS 错误；vite-hmr socket 未列入业务连接。                                   |
| P05-A02 | passed | out/in 高优先级替换、低优先级不命中；outbound drop 无上游收件，inbound drop 后下一条正常消息抵达；ruleId 和 outcome 可查。                                                    |
| P05-A03 | passed | send 通过真实服务器并经过 outbound；inject 仅页面改变，上游计数不变，记录 synthetic；同 URL 其他 Context 未变。                                                               |
| P05-A04 | passed | 双 Context 同 URL、单页多连接、刷新重连拥有独立 ID；foreign/stale 拒绝；已取消 send 不发送不重放。                                                                            |
| P05-A05 | passed | Page 创建时注册，capture 关闭期间历史为空；开启后只有新消息，reload 不重连；指南明确只覆盖接入后流量。                                                                        |
| P05-A06 | passed | 二进制 0,255,3 原样到达；262145 字节超限只读且标 truncated；关闭 capture 暂停 Mock，恢复后原激活规则继续。                                                                    |
| P05-A07 | passed | 共用 WS schema 和方向工具；新增只读 get_browser_ws_message 有同名 Prompt/能力导航；工作台 Context 可查询 WS 与切换采集；旧 WS 30 项及协议/规则回归通过，proxy WS 保持不支持。 |

命令均退出 0：`test:web:ws` 22/22；`test:web:http` 31/31；`test:web:ui` 71/71；相关 8 文件单元/协议 97/97、旧 ws-session/ws-runtime 30/30，最终 guide/transport 54/54；工作台 Web 3/3；typecheck、format:check、build、git diff --check 通过。

最终 WS run `2026-11-17T03-39-01-105Z` 报告记录三方消息/计数和连接身份；HTTP/UI 复验 run 分别 `2026-11-17T03-38-09-869Z`、`2026-11-17T03-38-12-792Z`。无必需跳过。消息仅 submitted，是否业务通过仍需 UI/网络断言。

显式 CA 信任只写自有临时 Profile，指纹可查，同 Worker 的 Context 共用该明确范围；默认 TLS 校验未关闭。所有 Worker、Profile、CA、WS 服务和临时目录已清理。未安装、发布、推送；未宣称接入前消息或 SSR 可回补。下一阶段生产业务测试。

## Evidence hashes

- `artifacts/web-flutter-runtime/phase-05/20261117-final/browser.log` SHA-256 `7392f2b06a4ab59ab5fb9d30ae1791c71760fd8200928ff565e98c179e3f4ae4`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/build.log` SHA-256 `d425d2e206f5c4119a2750b71c61eec93793eeebac44911fc7b0b02b6a1f9c11`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/files.json` SHA-256 `10d28c4175cdb9d752110961f53daf45b5dfbbe107a4484e143ea4b11af8ccb6`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/flutter-ws.log` SHA-256 `b2baff55337bd20d8d4ad5909e96835c02af8031480241cb72fb35f8460f88a9`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/format.log` SHA-256 `c55a6adf7e45dc84809d087b404b41bb6607f0e29c2857e0ad7d70d3f58e8fc9`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/http.log` SHA-256 `91eca6cce4f0bfd66a47db1e6b5d514438578e1e41aab36bea178e363a1be0cc`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/implementation.patch` SHA-256 `96efdd77ba3e73fdf04658916f2b8d4822b0d2a264ef2e963eefd2f222a321b2`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/protocol-final.log` SHA-256 `36eddec67c9c554f3dc97bf18beacd80f5c004f48afcf967bebc6ddf40f93a24`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/tests.log` SHA-256 `43089bd4863ffb7d7d46335a4c22544eff9830d0c2553300e38ff9e422b872cf`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/typecheck.log` SHA-256 `593487df21ca068acf5d9d80e0453ae9e2998b5afd81b1d2538d093977bfa50d`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/ui-browser.log` SHA-256 `6def781048e9d0afc9dcfbd4445a76a51c22bdbc09ce18f1ece67f8e5f8ca4e6`.

- `artifacts/web-flutter-runtime/phase-05/20261117-final/ui.log` SHA-256 `861d4ddbc0b97ba75114e2f1921eb24a090521ae1c76ee63988f650e4d937363`.

- `artifacts/web-flutter-runtime/phase-05/2026-11-17T03-39-01-105Z/report.json` SHA-256 `90f3c9edc861b260f8ebb828f81a9be8ad1c2ccb97a293ef5ca8f6d55d053311`.

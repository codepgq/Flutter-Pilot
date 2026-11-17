# phase-06 验收报告

基线 v1；2026-11-17；passed。基础提交 `efc65160703fdf44aef200751a2dd1dfbb5292df`，前置 phase-05 passed。生产 BrowserController / TestController / SceneController，Chromium 158.0.8127.18、Playwright 1.65.0、Node 26.8.1、macOS arm64。本地订单夹具，不代表真实后端交易验收。

| 条款    | 结果   | 实际证据                                                                                                                                                                                            |
| ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P06-A01 | passed | Web Test Case v2 使用固定 Page；setup 建立连接后开启 WS，再取 Worker 源时钟基线。观察器按 Context/Page 过滤；test-network 回归排除同毫秒旧在途、延迟事件、布防期间 ID，真实旧历史不能满足本轮断言。 |
| P06-A02 | passed | 两轮成功各自生成 order-runId，检查 amount、mocked、HTTP orderId、synthetic WS orderId/status、最终订单行和 committed 状态；HTTP 200 / INSUFFICIENT 通过业务拒绝预期。                               |
| P06-A03 | passed | 错参数、ruleId、响应、订单 WS、旧历史、重复请求、事件丢失和观察窗口溢出均非 passed；旧 pending 及未完成重复请求由共享测试回归覆盖。                                                                 |
| P06-A04 | passed | HTTP 响应前提交状态，紧接刷新看到 committed；连续两轮临时 scenario 与 orderId 独立；有状态规则时序回归通过。                                                                                        |
| P06-A05 | passed | 运行开始后修改 action 文件不影响冻结快照；同 Context reload 被锁拒绝；生产锁按 Context 保管，独立 Context 操作由 Web UI 集成覆盖，Flutter 使用其独立执行锁。真实双端并存另在 phase-07 验收。        |
| P06-A06 | passed | 取消停止 confirm；Page 关闭和 SIGKILL 后测试不通过，旧目标不恢复。共享控制器测试覆盖 confirm 超时、uncertain 和不重复提交。断线后的已脱敏报告保留最多 100 条，可经原目标 get_test_run 查询。        |
| P06-A07 | passed | 正常、失败与取消均恢复临时规则/采集；传输故障使 cleanup failed 且阻止新 run；cancel_test_run 重试仅清理，请求数量不增加。终态只在清理和释放结束后暴露。                                             |
| P06-A08 | passed | 返回实际 target、定义 hash、HTTP/WS/connection/ruleId、mocked、提取 orderId、最终 UI；递归秘密参数回归通过。工具/同名 Prompt/离线指南/工作台及旧 Flutter 测试契约回归通过。                         |

命令退出 0：`test:web:e2e` 29/29，`test:web:http` 31/31，`test:web:ws` 22/22，`test:web:ui` 71/71；8 文件单元/协议 202/202；相关工作台 39/39；typecheck、format:check、build。无必需跳过。

业务原始报告 run `2026-11-17T03-51-23-411Z` 保存每次目标、运行、断言、清理状态及上游请求；HTTP/UI/WS 复验分别为 `2026-11-17T03-51-31-079Z`、`2026-11-17T03-51-38-006Z`、`2026-11-17T03-51-34-206Z`。所有临时源文件恢复，Worker、Profile、端口和夹具目录清理完成。未操作用户业务项目、活动 IDE 或用户浏览器。下一阶段双端及 Agent 交付验收。

## Evidence hashes

- `artifacts/web-flutter-runtime/phase-06/20261117-final/browser.log` SHA-256 `f58d39e1a61f5d6fa8f0a4dd3a4b69c97339c4eb4e0fb2f8e9c9c691b428c7b0`.

- `artifacts/web-flutter-runtime/phase-06/20261117-final/build.log` SHA-256 `d425d2e206f5c4119a2750b71c61eec93793eeebac44911fc7b0b02b6a1f9c11`.

- `artifacts/web-flutter-runtime/phase-06/20261117-final/files.json` SHA-256 `7a08a968b929e8892ffdca588b9882303bcf186c3534371880215c82ecad6a8a`.

- `artifacts/web-flutter-runtime/phase-06/20261117-final/format.log` SHA-256 `c55a6adf7e45dc84809d087b404b41bb6607f0e29c2857e0ad7d70d3f58e8fc9`.

- `artifacts/web-flutter-runtime/phase-06/20261117-final/http.log` SHA-256 `a56694551d4e68ef0e8a80c436aaa6ad4586b25dac77c7ec1254420b433cb1d7`.

- `artifacts/web-flutter-runtime/phase-06/20261117-final/implementation.patch` SHA-256 `5135098ec160d000d7741b414d4c6bc022c6241df95ab55e214ec5699679b2dc`.

- `artifacts/web-flutter-runtime/phase-06/20261117-final/tests.log` SHA-256 `8c0eee51100211ebfbda2a176055acc16c8690c20dc2220f092f28bbaa6d6880`.

- `artifacts/web-flutter-runtime/phase-06/20261117-final/typecheck.log` SHA-256 `593487df21ca068acf5d9d80e0453ae9e2998b5afd81b1d2538d093977bfa50d`.

- `artifacts/web-flutter-runtime/phase-06/20261117-final/ui.log` SHA-256 `deba62f12285c2fcde6d31914fb6da956b9d6db2282127c0932479023e919be2`.

- `artifacts/web-flutter-runtime/phase-06/20261117-final/webui.log` SHA-256 `db3c273bdfa9a2fd544d0e162ca0d9804f29cbc4752d348df901ddc77030af36`.

- `artifacts/web-flutter-runtime/phase-06/20261117-final/ws.log` SHA-256 `3605bbd90fe49b12978daf6f7f99db1e805160c01f5ad96622edfcad23ca7262`.

- `artifacts/web-flutter-runtime/phase-06/2026-11-17T03-51-23-411Z/report.json` SHA-256 `c44fa528a1e31be4872dbce2cf0f22609f00116b7c3e2c4a2f8b99abced3b5c0`.

- `artifacts/web-flutter-runtime/phase-06/2026-11-17T03-51-23-411Z/partial-runs.json` SHA-256 `8cfae53e4e6c1fedc25c00fafec1aaaa45147a8316e540766aa956a14255aa65`.

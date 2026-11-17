# phase-02 验收报告

基线 v1；2026-11-17；结果 passed。基础提交 `efc65160703fdf44aef200751a2dd1dfbb5292df`。

实现包括声明发现、本地 URL/相对子根登记、扩展激活与显式代理准备、工作台 Web 入口、MCP proxy 诊断、显式上游 CA 和真实浏览器验证入口，保留旧 UUID/Scene v2。

| 条款    | 结果   | 本轮实际证据                                                                                                                                                                                              |
| ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P02-A01 | passed | web-discovery 与扩展测试识别 React/Vue/Vite，普通 Node 不发现；HTML 显式登记，混合子根验证且拒绝越界；工作台保存 URL/子根。                                                                               |
| P02-A02 | passed | 无 pubspec 的扩展开启同一 MCP；认证 IPC 查询；缓存引擎也不隐式启动；离线 guide/transport 通过。                                                                                                           |
| P02-A03 | passed | Chrome 经生产 EngineManager/Python addon；HTTP/HTTPS × fetch/XHR 验证转发、200/503 Mock 和双向修改；Mock 上游零访问，取消激活后转发。                                                                     |
| P02-A04 | passed | 代理信任上游夹具 CA，私有 Chrome Profile 信任代理 CA；未信任 Profile 报 ERR_CERT_AUTHORITY_INVALID。跨域 credentials、真实和 Mock OPTIONS 可读，错误 CORS 仍失败。                                        |
| P02-A05 | passed | 生产 SceneController/McpNetworkController/认证 IPC 列表与工作台同源 engine history.list 精确相等；详情验证原始/有效正文及 requestRuleId=ok；关闭/恢复采集、reload 无导航；扩展 UI 与 stdio 协议回归通过。 |
| P02-A06 | passed | 两真实引擎同路径分别返回 project-a/project-b，历史按监听端口隔离；占用首选端口选实际空闲端口；清理私有 Context/引擎/IPC/服务/Profile/CA，未改系统代理或全局证书。                                         |
| P02-A07 | passed | overview/http.webProxy、capabilities/http_mock/同名 Prompt 与 docs/mcp.md 同步；随包 Scene 生产 schema 校验；实际 MITMDUMP 的 51 项 Python 检查通过，无跳过。                                             |

## 验证

- 私有 mitmproxy 12.3.1 arm64，由生产下载器校验清单 SHA-256。真实浏览器 Chrome 157.0.8103.51。
- `MITMDUMP=<private-runtime 的绝对路径> npm run test:web:proxy`：34/34，通过，退出 0。
- `MITMDUMP=<同一路径> npm run test:proxy`：51/51，通过，0 跳过，退出 0。
- 12 文件选定单元/协议：264/264，通过，退出 0，含 phase-01 受影响路径复验。
- `npm run test:ui -- tests/ui/workbench.spec.ts tests/ui/scenes.spec.ts tests/ui/mcp.spec.ts`：77/77，通过，退出 0。
- `npm run typecheck`、`npm run format:check`、`npm run build`、`git diff --check`：退出 0。

原始浏览器报告目录：`artifacts/web-flutter-runtime/phase-02/2026-11-17T02-51-35-832Z/`。HTTP、HTTPS 和代理监听均为动态端口。专用 Profile 仅信任本轮 CA；未使用 ignoreHTTPSErrors、ssl_insecure 或关闭 Web 安全。生产 addon 请求阶段 Mock 设置 requestRuleId，不虚构 responseRuleId。

全部自有引擎、浏览器、IPC 和监听服务已清理。未安装、发布或推送。此阶段仅手动浏览器 HTTP 代理，无页面身份、Web WS/UI/业务测试或 SSR 覆盖。下一阶段 phase-03。

## Evidence hashes

- `artifacts/web-flutter-runtime/phase-02/20261117-final/browser.log` SHA-256 `cb5083173b8d25bf817f02c96dd1f280faab06a1eabd8885badbac96c2fa99b8`.
- `artifacts/web-flutter-runtime/phase-02/20261117-final/proxy.log` SHA-256 `5e9f5bd3961b111fc027d0cfbce10a568d28614811cc4002549d7bb0cbed0b0c`.
- `artifacts/web-flutter-runtime/phase-02/20261117-final/tests.log` SHA-256 `aa7200dc2e93c1440a63ce666b53fd3ed6e4188d9397dc96f3dd2222330c0954`.
- `artifacts/web-flutter-runtime/phase-02/20261117-final/ui.log` SHA-256 `ae7814918c0bb7e278b4a7fd59102eeb6d46d3c72687092e9f9e72e3a70c456c`.
- `artifacts/web-flutter-runtime/phase-02/20261117-final/build.log` SHA-256 `d425d2e206f5c4119a2750b71c61eec93793eeebac44911fc7b0b02b6a1f9c11`.
- `artifacts/web-flutter-runtime/phase-02/20261117-final/format.log` SHA-256 `c55a6adf7e45dc84809d087b404b41bb6607f0e29c2857e0ad7d70d3f58e8fc9`.
- `artifacts/web-flutter-runtime/phase-02/20261117-final/typecheck.log` SHA-256 `593487df21ca068acf5d9d80e0453ae9e2998b5afd81b1d2538d093977bfa50d`.
- Uncommitted implementation patch `artifacts/web-flutter-runtime/phase-02/20261117-final/implementation.patch` SHA-256 `e5d65ccec39a804b544d440020e35bbb917be6f0974183c14a9d244678f14f81`.
- `artifacts/web-flutter-runtime/phase-02/2026-11-17T02-51-35-832Z/report.json` SHA-256 `e1fcb81baa64f6bf1390f1ff4648046e03edb9987095d5854cc562eaf88856b5`.
- `artifacts/web-flutter-runtime/phase-02/2026-11-17T02-51-35-832Z/requests.json` SHA-256 `251f2429eda137160a3539c1e3f57982da0f2e100073bf85b711fc19ecd15838`.
- `artifacts/web-flutter-runtime/phase-02/2026-11-17T02-51-35-832Z/cleanup.json` SHA-256 `bb6708ed152604cf1fa8389c19715aa4676789234ff7fd8e5114711c92d326dd`.

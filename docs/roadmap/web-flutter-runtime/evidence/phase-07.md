# phase-07 验收报告

基线 v1；2026-11-17；passed。前置 phase-06 passed。基础提交 `efc65160703fdf44aef200751a2dd1dfbb5292df`；当前实现未提交，补丁和文件清单见本报告末尾哈希。环境：macOS 26.6.2 arm64、Node 26.8.1、Flutter 3.47.8、独立 iPhone 18 Pro / iOS 27.0 模拟器、Chromium 158.0.8127.18、Playwright 1.65.0、mitmproxy 12.3.1、Codex CLI 0.167.0。没有启动 IDE GUI。

## 条款结果

| 条款    | 结果   | 实际观测                                                                                                                                                                                                                                       |
| ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P07-A01 | passed | 同一构建 stdio/MCP registry 发现真实 Flutter VM 与 Chromium Context；明确目标后分别运行 Scene/Test。同 `/value` 分别为 flutter-only/web-only，历史与 UI 独立；两个业务 Test 同时 passed。                                                      |
| P07-A02 | passed | 本轮 iOS HTTP8、VM注入32、UI57、MCP19通过；WS/WSS dart:io/web_socket_channel 四类连接、25条消息及重启通过。保留 UUID/Scene v2/Agent 绑定契约的全量协议/宿主回归通过。Android、真机未复验。                                                     |
| P07-A03 | passed | HTML/React/Vue 各走生产 Mock、Scene、HTTP→WS→UI Test 和 PNG；真实代理34、直接 HTTP31、UI71、WS22、业务29、依赖5均通过。没有用测试 page.route 自行返回 Mock 替代产品。                                                                          |
| P07-A04 | passed | test:mcp:web 构建 stdio 三框架23项；MCP_WEB_AGENT=codex 增加真实模型/CLI调用后35项。Agent完成发现、指南、激活、Scene、HTTP详情、测试/最终UI查询与Context关闭，业务 passed；SDK与真实客户端日志分开。                                           |
| P07-A05 | passed | 并存夹具强杀 Web Worker，旧 run 非 completed 且报告可查，Flutter 继续 fetch；新 Worker 不恢复旧 Context/Mock/run。Page关闭、取消、网络故障/重连及 IDE 恢复无 UI 副作用由生产浏览器与宿主回归证明。自有进程/Profile/端口/模拟器清理核验无残留。 |
| P07-A06 | passed | 全量54文件852项、工作台108项、Python代理51项无跳过；typecheck、format、build及全部必需真实脚本通过。基线/最终 stdio 启动、RSS、VSIX体积及一次独立Worker启动测量归档。Flutter无Web时只读发现不准备依赖/启动Worker。                             |
| P07-A07 | passed | 隔离VSIX含browser-worker、bridge、私有依赖package/lock和示例；解包构建/资源哈希一致，离线61工具69Prompts、全部工具同名Prompt、指南读取通过。包无历史、用户配置、Profile、CA私钥或node_modules。未安装活动IDE。                                 |
| P07-A08 | passed | 七阶段报告、G01–G10映射、源码补丁/证据哈希、用户指南/支持矩阵和memory已同步。明确排除SSR、Flutter Web DOM、未测平台、接入前流量和跨端事务。                                                                                                    |

## 实际命令与结果

所有下列最终命令退出0，无必需跳过。真实 Flutter 命令仅指向本轮专用设备 UUID `77F5D8FE-0D9E-4282-86A1-AF9899BBFE6D`，代理命令显式设置 MITMDUMP 为私有12.3.1引擎绝对路径。

| 命令                                                                                     | 结果                                                 |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| npm run typecheck / format:check / build；git diff --check                               | passed                                               |
| npm test                                                                                 | 54文件，852 passed                                   |
| npm run test:ui                                                                          | 108 passed                                           |
| npm run test:proxy                                                                       | 51 passed，0 skipped                                 |
| npm run test:web:proxy                                                                   | 34 passed                                            |
| npm run test:web:dependencies / test:web:http / test:web:ui / test:web:ws / test:web:e2e | 5 / 31 / 71 / 22 / 29 passed                         |
| npm run test:mcp:web；MCP_WEB_AGENT=codex npm run test:mcp:web                           | SDK23；含真实Agent35 passed                          |
| npm run test:web:coexistence                                                             | 双端10 + Flutter MCP19 passed                        |
| npm run test:vm / test:vm:flutter                                                        | 32 / 8 passed                                        |
| npm run test:ws:flutter                                                                  | 4类连接、25条消息、热重启/分离/旧连接拒绝 passed     |
| npm run test:ui:flutter                                                                  | 57 passed                                            |
| node scripts/web-delivery-smoke.mjs                                                      | 两份隔离VSIX、源码/包哈希、离线发现、前后测量 passed |
| 最后工具说明调整后的 guide/transport                                                     | 55 passed；不改变运行实现                            |

## 真实业务与客户端证据

- 并存 run `2026-11-17T04-10-35-304Z-coexistence`：Flutter Test `863cecb5-679c-409f-a61c-b3f19dbbd873`，HTTP规则 `run-cd5a97436953a5aea1e48a20-0-0`、mocked:true、最终echo=flutter-test；Web Test `2ebf2744-0bf4-4b2f-9970-fa3d7c8c411f`，HTTP `df601ebc-26ec-4252-b841-ca97eb520cd7`、规则 `run-e230ef211513f7073e571ef7-0-0`，WS `6c3a2a14-791f-40e6-a6b4-f25fa9de6ffe`、连接 `802affdb-b172-4c5d-ac66-ff285441355b`，订单行确认，两者清理完成。
- 实际 Codex run `2026-11-17T04-09-07-861Z`：action `583f0cda-a3a8-4666-b66b-5c9d8f8e615e` completed；`/value` mocked:true / web-value / web-only；Test `a8a60d6f-62b3-4c14-900c-2a69084526ac` passed，order/confirmation/order-row三断言通过，最终UI `order-a8a60d6f-62b3-4c14-900c-2a69084526ac confirmed`，只提交一次并关闭Context。
- Agent使用真实已配置模型服务，无伪造模型协议；只复用选定模型连接认证，隔离MCP配置/工具白名单，不改用户配置、不在参数/日志中记录认证。最初缺认证与工具授权策略的失败保留在早期原始日志，调整本轮夹具客户端配置后通过。
- 三框架截图返回真实PNG；人工查看React截图的HTTP订单ID与confirmed行一致。长图顶部/底部的视觉检查已在phase-04归档。secret只承诺结构化运行报告脱敏，独立原始UI/截图仍反映实际页面。

## 测量、修复与清理

测量脚本从同一HEAD建立临时基线源，与最终源用相同依赖打包；每份bridge顺序启动3次，计时覆盖initialize及工具/Prompt发现，RSS在发现后取样。完整数值以末尾delivery report为准，不据此承诺IDE启动SLA。参考本轮测量：基线1,335,156字节、bridge66.12–73.86ms/68.52–69.45MiB；最终1,534,649字节、bridge68.02–69.67ms/69.38–69.77MiB；独立Worker含浏览器启动622.08ms，Worker RSS约119.69MiB（不含Chromium子进程）。

实测修复了Flutter显式target schema和proxy UI误路由、只读等待取消后的错误uncertain锁、旧SceneStore夹具API和Flutter文本等待夹具路由；增加native代次/能力协议与宿主测试。工作台把Web入口放在Flutter主连接内容之后，恢复桌面紧凑布局。相关前阶段条款以本轮全量与真实浏览器/双端结果复验。

本轮专用模拟器已shutdown/delete；原有用户模拟器保留。最终进程核对无本轮Worker、托管Chromium或Flutter夹具残留；Profile/CA/服务端口/临时目录清理，示例pubspec.lock恢复。Flutter UI teardown曾输出已结束工具临时dill缺失诊断，命令退出0、57断言及源码哈希通过，随后无进程残留；未清用户数据或重跑提交掩盖问题。

未操作用户业务App、系统信任、日常浏览器、已有IDE或Agent配置。未提交/tag/push/发布/安装。Android/真机、SSR、Flutter Web Canvas/Key、Firefox/WebKit、远程宿主及真实后端订单不在本轮通过声明中。

## Evidence hashes

- `artifacts/web-flutter-runtime/phase-07/20261117-final/agent.log` SHA-256 `b6bc05e2d475959abad2e865a6e7a42c5671d2ce4f40602ca294134dfae4c600`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/build.log` SHA-256 `d425d2e206f5c4119a2750b71c61eec93793eeebac44911fc7b0b02b6a1f9c11`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/cleanup.json` SHA-256 `ac604392dbb856f0e1bc504cae120e595a704cb3c49a6ff1aeb4d22a36264ef8`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/coexistence.log` SHA-256 `c255716f73b2f92c54b3be9b4fe210182e6fa15f7808f9691ddbf5264b730bb2`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/dart.log` SHA-256 `79738cab0b1ce90e1933dc7c48e881390494a1e21ee9385728e7437a837f4b8c`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/delivery.log` SHA-256 `d7c162a2960798ab1937f0989364f0f639501bb5f587d400a2867c364b64df71`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/dependencies.log` SHA-256 `38588137f978deb5d78c692e132535cad164254a647b97f9a541512e737a872a`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/docformat.log` SHA-256 `941c94d285d5b06710a33174db950296d15c4aaedc18eca48f5c27974bc004ca`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/e2e.log` SHA-256 `8aa82ff61f717375e8d34082ecf81fdd670a205cefe5f2c092193404491725c7`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/files.json` SHA-256 `efa1a0c896fe0b6ac222958da22f7b3d5c436b0bdcd1d328021033405a0b3c1e`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/flutter-app-long.png` SHA-256 `fa6475b71e354cc4d3bca6284c701e950f6558edb6e9f1a000ff64d5e828e49a`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/flutter-app-screen.png` SHA-256 `1c96a00364943c453868f2ba175a49081b4dd1a743ad98f986eb96860cd7b15e`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/flutter-http.log` SHA-256 `b2de3e2d134b2f3da6de930897aac5620bcc26c24463eb94337e332741b728ad`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/flutter-pub.log` SHA-256 `5f755fde529f234c8337683b15f1b17d0b7a8318729ab9527400ad91b4982b1b`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/flutter-ui.log` SHA-256 `a3c72ed5f449d4e13334f19dcfdc21011d62753fc3e8607f4a01e27e43e13aba`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/flutter-ws.log` SHA-256 `9bae83f2772a3cebba54d4c04711f349a79fdc9a85372867e45abe4398c0b45e`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/format.log` SHA-256 `c55a6adf7e45dc84809d087b404b41bb6607f0e29c2857e0ad7d70d3f58e8fc9`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/http.log` SHA-256 `5f103f0d6a39f670b001318d2251b3f3058fb5166daff447f27b250a1db7fb90`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/implementation.patch` SHA-256 `1e6715fb3273e10f99236c7ab82d13896796980bfc0249055ceb4f04a5968845`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/mcp-flutter-smoke-report.json` SHA-256 `bf28b79682cec2728cd85681d63e8b8274f7591399f9af04303b00f604e7451e`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/mcp-web.log` SHA-256 `e209a009f63cbd35a7046a3fe5f0c1d08bbbc2424a3ef02c048843b6ee860db7`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/protocol-final.log` SHA-256 `43b3ed64b980fa12d718c5346420a4181c66314578d79561ec136df2734c3f0d`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/proxy.log` SHA-256 `8a0352b1eea7319e0e8823b582ec5d45362b84fb9232ff4f668aa72a300258bc`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/simulator.log` SHA-256 `c7dfd4e9f7f9c2828bc3e9120f1126cc26ca7c47e7af11ddfe4910a4bdc87279`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/target-fix.log` SHA-256 `e7bec08add1aaef3787fa64ed5f0e401bb04e77ef414ffa706e925291bf3d248`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/tests.log` SHA-256 `7c7382287a66d4362688dcfb194e9ebb989298fe7a81535b891fa165a405799f`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/typecheck.log` SHA-256 `593487df21ca068acf5d9d80e0453ae9e2998b5afd81b1d2538d093977bfa50d`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/ui-fix.log` SHA-256 `55544f90a3d9c14128335201c1fb84f988af943d574aa002d1c393b3166aaf48`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/ui-flutter-smoke-report.json` SHA-256 `22a15ee6de5f839c3fe3af847b87898671928cf797b82af428a0f8fe193f5d26`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/ui.log` SHA-256 `30f209c7efeab19ba471f188f9d547b699a2e8640481ac8260cbdcd38c551bed`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/vm-flutter-validation.json` SHA-256 `3edb2551dedfd661d1325d26a14830ee8ab540895550bbae50c0f01917ee02da`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/webproxy.log` SHA-256 `209b2787a462b176d90782fac7169bb5aa95ef52ff6ccf1208b33ce2dc939bc1`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/webui.log` SHA-256 `abd3041d2f64d1a724f11ba93cd4a5bb107ecca1ee2ee2c665c93d59c4063499`.

- `artifacts/web-flutter-runtime/phase-07/20261117-final/ws.log` SHA-256 `f196db25f7033d2ede461d529eaa2dc26c05e46793f0b94446d19cbdbb6efce0`.

- `artifacts/web-flutter-runtime/phase-07/2026-11-17T04-09-07-861Z/report.json` SHA-256 `87424c23de60e69525c66976a8d0e368d13a908e3bed878f94acac339051113d`.

- `artifacts/web-flutter-runtime/phase-07/2026-11-17T04-09-07-861Z/agent.json` SHA-256 `0df12d673b16aa149de652b4141abcbf52252ccdd5f11b483357c82e671fe110`.

- `artifacts/web-flutter-runtime/phase-07/2026-11-17T04-09-07-861Z/agent-tool-calls.json` SHA-256 `3443ced94360c1855aa269ed7030a86135ab6f296e82995c4c982ee92fce15a4`.

- `artifacts/web-flutter-runtime/phase-07/2026-11-17T04-10-35-304Z-coexistence/report.json` SHA-256 `649b3960f8e17dc659d1ad3372ae66c551fb5dbb3b55254a9e58df2b883c2281`.

- `artifacts/web-flutter-runtime/phase-07/2026-11-17T04-10-35-304Z-coexistence/partial-runs.json` SHA-256 `e6d1c3ac0b100e97bba67b4afc78b01332b57984e0c2cf4dc45e647d190cc2e5`.

- `artifacts/web-flutter-runtime/phase-07/2026-11-17T04-15-27-830Z-delivery/report.json` SHA-256 `4c9d657220a4a729e1ac60c7796ca336d5e3003e16d19b93fadd206afe56378c`.

- `artifacts/web-flutter-runtime/phase-03/2026-11-17T03-51-31-079Z/report.json` SHA-256 `77733d73701035a753fdf78ba01200336698078d36291b84e6538cd96e30a1ba`.

- `artifacts/web-flutter-runtime/phase-06/2026-11-17T04-08-57-893Z/report.json` SHA-256 `0b6e3f8addb97faab886b1d288cdfe40c99865866dadb98032cdbb8d0568b084`.

依赖验收脚本固定输出目录曾覆盖旧单项证据，已改为时间戳目录并复验5项通过；phase-03保留历史校验值并明确转向新的不可变报告。产品运行代码未变。

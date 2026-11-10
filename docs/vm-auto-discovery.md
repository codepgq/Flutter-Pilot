# VM 自动发现与自动连接

在 macOS 本地 Cursor / VS Code 中使用原来的 Flutter Debug 启动项运行或附加应用，插件会自动获取本项目的 VM 地址。无需修改应用源码，也不需要复制调试输出。

## 使用方式

1. 确认工作台使用 VM 模式，在 IDE 内启动或附加 Flutter Debug。
2. 当前项目只有一个可用会话时，插件自动连接并后台记录 HTTP；多个会话时，在“连接与诊断”的会话列表选择。
3. Dio Mock、业务 WS 采集和 WS Mock 均保持手动开启。自动连接不会启用它们。
4. 手动断开后，当前已有候选暂停自动重连；点击“重新连接”可恢复。完整停止调试后，新会话可以再次自动连接。

关闭工作台继续后台记录。已有 VM 连接不会被新候选、重复事件或地址更新替换；需要换会话时先断开。结束由候选建立连接的调试会话时，插件断开相应 VM；手动填写地址的连接不由其他调试会话控制。

## 设置

`flutterApiMocks.autoConnectVm` 默认 `true`，独立于代理的 `autoStart`。项目 `.api-mocks/project.json` 中的 `settings.autoConnectVm` 优先于 IDE 设置；未指定时回退 IDE。修改项目文件后点击“读取项目文件”，该设置立即生效。关闭自动连接保留当前已经建立的连接，仍允许在候选列表中手动选择连接。

自动尝试最多三次：立即连接、等待 1 秒、再等待 3 秒。连接成功后意外断线的自动重连也共用本次会话及地址的三次预算；重复事件不会刷新预算。用尽后点击“重试连接”，或等待新的调试会话。发生真正的 VM 断线重连后，Dio Mock、WS 采集及 WS Mock 需要重新手动开启。

## 发现通道与边界

实时通道使用 VS Code 公开调试事件接口接收 `flutter.appStart` 和 `dart.debuggerUris`。插件启动前已存在的会话，通过 Dart 扩展公开 API v3 提供的 Dart Tooling Daemon（DTD），调用 `Editor.getDebugSessions` 补查，并监听会话变化。DTD 服务延迟注册时会补查；每次打开工作台也会重新补查，首次 API / 查询失败或 DTD 连接断开后可恢复，无需为重试重新启动 Flutter。补查仍不可用时保留实时发现和手动地址入口。

候选按调试会话 ID 去重，按项目真实路径与工作区归属，支持 Dart workspace 下的 Flutter 子项目。不会按项目名称猜测，也不会跨工作区连接。多个已有候选整批发布，避免补查过程中误触单会话自动连接。

首版自动发现仅面向受信任的 macOS 本地工作区、Flutter native Debug 启动与附加；不承诺 Web、Profile / Release、Remote SSH。外部终端独立执行 `flutter run` 时，先在 IDE 附加调试，或使用保留的手动地址入口。

VM 和 DTD 认证地址只保留在扩展宿主内存，不传给工作台，不写入项目文件、本机连接配置或日志。界面显示会话名称、设备 ID、来源和主机端口。自动发现不扫描端口、不读取剪贴板或用户终端日志。

## 验证入口

- `npm test`：发现、DTD 协议与竞态、调度、项目设置和扩展集成。
- `npm run test:ui`：候选选择、失败重试、暂停重连、禁用状态及窄面板。
- `API_MOCK_TEST_IDE=cursor npm run test:ide:vm`（或 `vscode`）：隔离 IDE 内合成候选与 VM JSON-RPC 的消息链路验证。
- `API_MOCK_TEST_IDE=cursor node scripts/ide-vm-discovery-test.mjs`（或 `vscode`）：隔离 IDE、真实 Dart 扩展与 Flutter fixture 验收。可通过 `API_MOCK_TEST_DEVICE`、`API_MOCK_TEST_FLUTTER` 指定本机模拟器与 SDK；脚本只控制自己创建的调试会话。

实际通过的环境与未验证范围统一记录在 [验收记录](validation.md)。合成服务不替代真实 Flutter 验收。

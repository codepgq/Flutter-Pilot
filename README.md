# Flutter API Mocks

在 VS Code 和 Cursor 中管理 Flutter Dio 项目的接口调试：本地 Mock、请求和响应修改、地址转发、手动断点，以及按 API 分组的请求历史。

首版面向 **macOS 本地桌面 IDE、Dio 5、Android / iOS**。插件使用本地 mitmproxy 引擎，数据保存在当前工作区对应的插件私有目录。首次安装引擎需要联网，之后规则和历史可本地使用。

## 安装

1. 下载或构建 `flutter-api-mocks-0.1.0.vsix`。
2. 在 VS Code 或 Cursor 的扩展面板右上角菜单选择 **Install from VSIX… / 从 VSIX 安装…**，选择该文件。
3. 打开 Flutter 项目并信任工作区。
4. 在命令面板执行 **Flutter API Mocks: 打开工作台**，或点击底部 **API Mocks**。
5. 点击 **安装 / 初始化引擎**。插件下载固定版本 mitmproxy 12.3.1，校验 SHA-256 后安装到私有目录，不要求安装 Python。下载失败可重试，或通过设置指定本地兼容的 `mitmdump` 绝对路径。

插件尚未发布到扩展商店；当前通过 VSIX 安装。

## 第一次连接

工作台“连接与诊断”按四步组织：准备引擎、选择设备、信任证书、按需接入 Dio。

### 优先尝试系统代理

启动代理，选择设备能访问的电脑地址。真机通过 Wi-Fi 时开启“允许局域网真机连接”，在设备 Wi-Fi 设置中填写电脑 IP 和工作台显示的端口。局域网代理只应在调试期间启用，管理通道始终监听本机。

HTTPS 需要安装并信任工作台“打开 CA 证书位置”提供的 `mitmproxy-ca-cert.pem` 公钥证书。iOS 安装描述文件后，还需在“设置 → 通用 → 关于本机 → 证书信任设置”中开启信任；Android 应用是否信任用户 CA 取决于应用网络配置。

**Flutter 的 Dart 网络栈不保证遵循系统代理或系统 CA 信任配置**。如果历史中看不到请求，或者 Dio 报证书错误，使用下面的最小接入方式。系统代理和证书配置不会被插件静默修改。

### Dio 最小接入（推荐在系统代理无效时使用）

1. 点击 **检测 Flutter 项目**，选择实际发请求的 Dio 初始化位置。
2. 点击 **预览补丁**，检查 IDE 展示的源码差异，再在工作台点击 **应用当前预览**。
3. 补丁新增 `lib/api_mocks_debug.dart`，并在可识别的异步初始化位置调用 `await configureApiMocks(dio)`。复杂工厂、自定义适配器只生成 helper 和手动片段。
4. Android USB：开启 USB 调试、刷新设备并点击 **连接 USB**；插件只创建自己的 `adb reverse`。iOS 模拟器使用 `127.0.0.1`；iOS 真机使用电脑的局域网地址。
5. 使用工作台显示的命令运行，例如：

   ```sh
   flutter run --dart-define=API_MOCK_PROXY=127.0.0.1:8080
   ```

helper 仅在 `kDebugMode` 且显式传入 `API_MOCK_PROXY` 时生效。它为当前 Dio 创建独立 `SecurityContext`，在系统可信根基础上加入当前调试 CA，不关闭证书校验。已有自定义 adapter、`createHttpClient` 或证书校验逻辑不会被覆盖，需要手动处理。

每个实际使用的 Dio 实例分别接入。向导应用前重新检查文件，预览后文件变化会拒绝应用。点击 **撤销接入** 可恢复原文件；如果接入后又编辑了相关文件，会整体保留并提示手动合并，避免删除仍被引用的 helper。

在应用里分别发起 HTTP 和 HTTPS 请求，确认工作台收到请求且没有证书错误。可用 [Flutter 示例](examples/flutter/README.md) 验证链路。

## 规则与 Mock

“Mock 规则”提供五个模板：

| 模板 | 行为 |
| --- | --- |
| 直接 Mock | 不访问上游，返回预设状态码、头部和 JSON/文本正文 |
| 修改请求 | 修改方法、完整 URL、查询参数、请求头或正文 |
| 修改响应 | 修改状态码、响应头或正文，包含服务端 4xx/5xx 响应 |
| 转发地址 | 改写目标完整 URL，保留原方法和正文，直接返回目标服务响应 |
| 手动断点 | 在请求发送前或响应返回前暂停，人工编辑后放行 |

- 匹配条件为请求方法、主机、路径通配符，可附加查询参数和请求头条件。主机按名称精确匹配；路径支持 `*`、`?` 等 glob 通配符。
- 匹配始终使用原始请求。请求和响应阶段分别选优先级最高的首条规则，同优先级按列表顺序；断点独立选择。
- 请求阶段的修改、转发和 Mock 共同属于一次规则选择。需要组合动作时使用“完整 JSON”编辑同一规则。
- 转发填写**完整目标 URL**，例如 `http://localhost:3000/v1/orders`；不会自动拼接原路径或查询参数。跨站默认移除 `Authorization`、`Cookie`、`Proxy-Authorization`，目标凭证可通过同规则的 `request.headers` 显式配置。
- 请求/响应正文修改是完整替换，表单中可关闭“替换正文”以保留原正文。头部与查询参数修改使用 JSON 对象，`null` 表示删除对应键。
- Mock 响应仍进入响应规则和响应断点。手动编辑在自动规则之后执行。
- 保存显示的“已保存但未生效”错误需要修正并重新同步；引擎确认成功后才生效。
- 规则可新增、编辑、复制、删除、启停、调整顺序、导入和导出。导入追加为默认禁用的副本，不覆盖现有规则。导出仅包含规则，但规则内显式填写的凭证也会导出，请自行检查。

规则文件格式示例：

```json
{
  "version": 1,
  "rules": [
    {
      "id": "orders-empty",
      "name": "订单列表 · 空数据",
      "enabled": true,
      "priority": 10,
      "match": { "method": "GET", "host": "api.example.com", "path": "/v1/orders" },
      "mock": {
        "status": 200,
        "headers": { "content-type": "application/json" },
        "body": "{\"data\":[]}"
      }
    }
  ]
}
```

## 手动断点

在规则里开启请求或响应断点，命中后进入“断点队列”，支持并发请求。可查看原始数据和自动修改后的数据，再选择直接放行、编辑后放行或终止请求。

默认等待 60 秒，可设置 10–300 秒。超时使用当前自动规则结果放行，不应用未提交的编辑。应用自身的网络超时可能更短；客户端取消后条目会失效。关闭工作台、停止代理或控制连接中断时释放等待断点。

## 请求历史

- 按 `方法 + 主机 + 路径` 分组，支持搜索、方法、状态码、时间、Mock 和规则命中筛选。
- 详情保存原始、自动规则后、最终的请求与响应快照，显示耗时、目标地址、规则与错误。
- 一键从历史生成默认禁用的 Mock、请求修改、响应修改或转发规则草稿。
- 备注和标签可修改；真实请求事实保持不变。历史可删除或清空，清空不删除规则。
- SQLite 历史与 JSON 规则跨重启保留，按工作区隔离。停止代理关闭流量监听，保留历史查询。关闭工作台才退出后台引擎。

默认保留 7 天、最多 10,000 条，单个正文保存上限 1 MiB。工作台“设置”可调整：

| 设置 | 默认值 |
| --- | --- |
| `flutterApiMocks.enginePath` | 空，使用插件管理的引擎 |
| `flutterApiMocks.proxyPort` | 8080，占用时选择可用端口 |
| `flutterApiMocks.retentionDays` | 7 |
| `flutterApiMocks.maxRecords` | 10000 |
| `flutterApiMocks.maxBodyBytes` | 1048576 |
| `flutterApiMocks.breakpointTimeout` | 60 |

修改运行参数后关闭工作台再打开，以重新启动引擎。大正文可能使历史占用较多磁盘，可降低保留数量并清空历史。

## 正文与兼容范围

JSON、文本和上限内的 gzip/deflate 正文可编辑。文件上传、multipart、二进制、SSE、chunked/无长度流、超限正文，以及 br/zstd 压缩正文首版只读直通；地址和头部仍可修改。界面会显示限制或截断标记，转发不因记录上限截断。极端正文转义导致控制帧超限时，详情明确报错，断点直接放行，不断开管理连接。

证书固定、应用层签名、缓存和重试可能影响调试结果。代理修改发生在网络层，无法自动重签业务报文。首版不覆盖 Flutter Web、其他网络库、自定义适配器的完整兼容性、Remote SSH、Dev Containers 或浏览器版 IDE。

## 停止与恢复联网

- 使用辅助接入时，不传入 `API_MOCK_PROXY` 参数重新运行应用即可恢复直接联网；需要移除代码时使用向导撤销。
- 使用设备系统代理时，在设备 Wi-Fi 设置里恢复“无代理/关闭”，按需移除调试证书。
- 插件停止时清理自己创建的 Android 转发，已有转发不会覆盖或误删。设备离线清理失败时，按日志执行 `adb -s <设备> reverse --remove tcp:<端口>`。
- 引擎崩溃或 IDE 关闭后，客户端仍指向代理会暂时无法联网，按上述步骤恢复。

## 开发与验证

开发环境使用 Node.js 22.12+ 和 npm，Flutter 示例需要本机 Flutter SDK。

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:ui
npm run package
```

真实代理集成测试需指定引擎：

```sh
MITMDUMP=/absolute/path/to/mitmdump npm run test:proxy
API_MOCK_SQLITE_CLI=1 python3 -m unittest discover -s tests/proxy -p 'test_storage.py' -v
API_MOCK_TEST_ENGINE=/absolute/path/to/mitmdump npm run test:ide
API_MOCK_TEST_ENGINE=/absolute/path/to/mitmdump API_MOCK_TEST_IDE=cursor npm run test:ide
```

界面测试使用本机 Google Chrome，可在 `playwright.config.ts` 中修改 browser channel。IDE 测试使用独立临时用户目录，不修改个人 IDE 配置。

项目结构：`src/` 扩展和接入工具、`webview/` React 工作台、`proxy/` 代理与 SQLite、`tests/` 自动化验证、`examples/flutter/` 可运行示例。控制协议见 [代理说明](proxy/README.md)，实际验收与限制见 [验证报告](docs/validation.md)。

## 第三方组件

使用 mitmproxy（MIT）、React（MIT）、VS Code Extension API。引擎按需从官方站点下载，保留独立包内的许可证和第三方声明；详见 [第三方说明](THIRD_PARTY_NOTICES.md)。

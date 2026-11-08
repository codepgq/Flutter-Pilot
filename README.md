# Flutter API Mocks

面向 **VS Code 和 Cursor** 的 Flutter Dio 接口调试插件。在 IDE 内完成本地 Mock、请求和响应修改、接口转发、手动断点及请求历史管理。

当前版本为 **0.1.0**，支持 macOS 本地桌面 IDE，优先适配 Android / iOS 上的 **Dio 5 + IOHttpClientAdapter**。插件采用本地代理引擎，优先尝试系统代理接入；Dart 网络栈无法直接接入时，提供可预览、可撤销的最小开发配置。

> 当前通过 VSIX 安装，尚未发布到扩展商店。Android USB 真机、iOS 模拟器及两款 IDE 已完成实际验证；完全零代码的系统代理路线仍需按项目验证。完整结果见 [验收记录](docs/validation.md)。

## 目录

- [功能概览](#功能概览)
- [环境要求与兼容范围](#环境要求与兼容范围)
- [安装插件](#安装插件)
- [快速上手：完成第一条 HTTPS Mock](#快速上手完成第一条-https-mock)
- [Flutter 与设备接入](#flutter-与设备接入)
- [工作台使用](#工作台使用)
- [规则格式与执行顺序](#规则格式与执行顺序)
- [完整规则示例](#完整规则示例)
- [配置参考](#配置参考)
- [数据存储与隐私](#数据存储与隐私)
- [停止代理与恢复联网](#停止代理与恢复联网)
- [故障排查](#故障排查)
- [开发、测试与打包](#开发测试与打包)
- [架构与目录](#架构与目录)
- [已知限制与验证状态](#已知限制与验证状态)
- [许可证与第三方组件](#许可证与第三方组件)

## 功能概览

| 能力 | 具体行为 |
| --- | --- |
| 本地 Mock | 匹配请求后直接返回预设状态码、响应头和正文，不访问上游 |
| 请求修改 | 修改方法、完整 URL、查询参数、请求头及 JSON / 文本正文 |
| 响应修改 | 修改状态码、响应头及 JSON / 文本正文，支持服务端 4xx / 5xx 响应 |
| 地址转发 | 改写目标完整 URL，保留请求方法和正文，直接返回目标服务结果 |
| 手动断点 | 请求发送前、响应返回前暂停；支持编辑放行、直接放行、终止及超时自动放行 |
| 请求历史 | 按 API 分组、搜索筛选、三阶段快照、规则命中、耗时、备注与标签 |
| 规则管理 | 新增、查询、编辑、删除、启停、复制、调整顺序、JSON 导入导出 |
| 开发接入 | 引擎下载管理、设备检测、Android USB 转发、Dio 补丁预览与保护性撤销 |

规则通过表单或完整 JSON 配置，首版不执行用户脚本。工作台跟随 IDE 明暗主题，并适配窄面板。

## 环境要求与兼容范围

| 项目 | 要求或说明 |
| --- | --- |
| 开发电脑 | macOS；提供 Apple Silicon 和 Intel 引擎下载包，Intel 实际运行尚未验收 |
| IDE | VS Code 扩展 API `^1.96.0` 或兼容的 Cursor 桌面版；需要受信任的本地文件夹 |
| Flutter 网络库 | Dio 5 的默认原生 `IOHttpClientAdapter`；Retrofit 等封装需接入实际使用的 Dio 实例 |
| Android USB | Android SDK Platform Tools、USB 调试和设备授权 |
| iOS 模拟器 | Xcode、对应模拟器运行时及可用的 `xcrun` |
| iOS 真机 | 设备与电脑网络互通；运行示例需自行配置 Apple 开发团队 |
| 首次引擎安装 | 能访问 mitmproxy 官方下载站；也可指定本地兼容的 mitmdump |
| 插件运行 | 不要求安装 Node.js 或 Python；独立引擎缺少 sqlite3 模块时使用 macOS 自带 SQLite |
| 源码开发 | Node.js 22.12+、npm；Python 测试需要 Python 3.9+；Flutter 示例要求 Dart `>=3.5.0 <4.0.0` |

首版不覆盖 Windows / Linux、Flutter Web、Remote SSH、Dev Containers、浏览器版 IDE，或所有自定义网络适配器。VS Code 与 Cursor 分别保存各自的插件数据，不会自动共享规则或历史。

## 安装插件

### 从 VSIX 安装

1. 获取 `flutter-api-mocks-0.1.0.vsix`。从源码构建见下方步骤。
2. 在 VS Code 或 Cursor 扩展面板右上角菜单选择 **Install from VSIX… / 从 VSIX 安装…**。
3. 选择安装包，按 IDE 提示重新加载窗口。
4. 打开包含 `pubspec.yaml` 的 Flutter 项目根目录，并信任工作区。
5. 执行 **Flutter API Mocks: 打开工作台**。扩展激活后，也可点击状态栏 **API Mocks**。
6. 点击 **安装 / 初始化引擎**，等待下载、校验和初始化完成，再点击 **启动代理**。

打开工作台本身不会触发引擎下载。已有引擎时会以暂停监听的方式初始化，便于查看历史；启动代理需要显式操作。

### 从源码构建安装包

在仓库根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run package
```

产物为 `artifacts/flutter-api-mocks-0.1.0.vsix`。打包命令自动执行构建，不会发布到商店。`artifacts/` 和 `dist/` 是忽略的生成目录，不随 Git 提交。

### 使用已有引擎

工作台点击 **选择本地引擎** 打开设置，将 `flutterApiMocks.enginePath` 设为 **mitmdump 可执行文件的绝对路径**，然后重新初始化。该按钮打开设置，不是文件选择器。

自动下载固定为 **mitmproxy 12.3.1**，按架构验证 [引擎清单](resources/engine-manifest.json) 中的 SHA-256。已有引擎目前检查是否属于 **12.x**；完整验收基于 12.3.1，建议使用相同版本。不要只复制 macOS 独立包内的单个 mitmdump 文件，应保留完整应用包结构。

## 快速上手：完成第一条 HTTPS Mock

下面以仓库中的 [Flutter 示例](examples/flutter/README.md) 和 Android USB 真机为例，无需真实业务接口。

1. 在终端执行 `cd examples/flutter`、`flutter pub get`，并在 IDE 中打开这个目录。
2. 打开工作台，初始化引擎并启动代理，记下实际端口。
3. 连接 Android 手机，开启 USB 调试并授权；在工作台 **刷新设备 → 连接 USB**。
4. 点击 **检测 Flutter 项目**，选择 `lib/main.dart` 中的 `dio`，**预览补丁 → 应用当前预览**。
5. 在 **Mock 规则** 点击 **直接 Mock**，填写下表后保存并启用。

   | 字段 | 示例值 |
   | --- | --- |
   | 名称 | 第一条 HTTPS Mock |
   | 方法 | GET |
   | 主机 | api-mocks.test |
   | 路径 | /hello |
   | 状态码 | 200 |
   | Headers JSON | `{"content-type":"application/json"}` |
   | Body | `{"message":"Hello from API Mocks"}` |

6. 按工作台实际地址运行。下面假设端口为 8080；有多台设备时用 `-d` 指定设备。

   ```sh
   flutter run -d YOUR_ANDROID_SERIAL --dart-define=API_MOCK_PROXY=127.0.0.1:8080
   ```

7. 在示例中将 URL 改为 `https://api-mocks.test/hello`，选择 GET 并发送。
8. 应用应显示预设 JSON；工作台 **API 与历史** 出现带 `MOCK` 标记的记录。该域名无需真实存在，完整匹配的 Mock 不访问上游。

这个流程通过 helper 信任当前调试 CA，无需在设备系统中安装证书。测试结束，去掉 `--dart-define` 参数重新运行应用，再停止代理。

## Flutter 与设备接入

### 选择接入路线

| 路线 | 项目改动 | 适用情况 |
| --- | --- | --- |
| 系统代理 + 系统 CA | 可不改源码，但依赖应用是否遵循系统代理及证书信任 | 已确认请求能经过代理的项目 |
| Dio 最小开发配置 | 新增一个 helper，并在实际 Dio 初始化位置调用一次 | 系统代理不生效、Dio 不信任系统 CA，或希望用 Android USB 接入 |

仅配置设备 Wi-Fi 代理，并不保证 Dart 请求已经进入插件。以请求历史中出现真实流量、HTTPS 没有证书错误为准。当前向导提供指导、项目检测和设备操作，HTTP / HTTPS 验证仍需在应用中实际发请求完成。

### 系统代理与证书

1. 启动代理。Wi-Fi 真机接入时开启 **允许局域网真机连接**，选择手机可访问的电脑局域网 IPv4 地址。
2. 在手机 Wi-Fi 设置中将 HTTP 代理设为手动，填写该电脑 IP 和工作台端口。
3. 点击 **打开 CA 证书位置**，将 `mitmproxy-ca-cert.pem` 公钥证书传到设备并安装。
4. iOS 需安装描述文件，再到 **设置 → 通用 → 关于本机 → 证书信任设置** 开启信任；具体菜单名称依系统版本而异。
5. Android 应用是否信任用户 CA 取决于网络栈及应用配置。仍报证书错误时使用 Dio helper，不能靠关闭 TLS 校验解决。
6. 在应用中分别验证 HTTP 和 HTTPS 请求。

插件不会静默改系统代理或系统证书。完全零代码路线尚未实际验收，证书固定或自定义校验也可能阻止 HTTPS 解密。

### Dio 接入向导

向导读取 `pubspec.yaml` 与可用的 `pubspec.lock`，识别 Dio 5，并扫描 `lib/` 中可识别的 Dio 声明。自动插入仅用于明确的异步函数直接作用域；已有适配器、证书逻辑、`HttpOverrides`、复杂初始化和 `part` 文件需要人工处理。

应用补丁通常包含：

- 新增 `lib/api_mocks_debug.dart`，其中只嵌入当前代理 CA 的公钥证书。
- 在选定文件中导入 helper，并在第一次请求前调用 `await configureApiMocks(dio)`。
- 在 `.dart_tool/api_mocks_setup.json` 保存撤销记录。

典型接入位置如下。helper 应由向导生成，不需要新增 Flutter SDK 依赖：

```dart
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import 'api_mocks_debug.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final dio = Dio();
  await configureApiMocks(dio);
  runApp(MyApp(dio: dio));
}
```

上面的 `MyApp` 代表项目自己的入口 Widget。接入每个实际发请求的 Dio 实例；只接入一个实例不会覆盖其他实例。

helper 同时满足以下条件才启用：**Debug 构建**，且编译时传入 `API_MOCK_PROXY=host:port`。Profile / Release 保持原配置。参数中不加 `http://` 或路径；修改 `--dart-define` 需要停止并重新运行应用，热重载不能更新编译时参数。

实现使用 `SecurityContext(withTrustedRoots: true)` 加入当前调试 CA，保留上游证书校验，不设置无条件通过的 `badCertificateCallback`。已有自定义客户端工厂或证书回调会拒绝自动覆盖，需在项目中人工合并。

### 不同设备的地址

| 调试目标 | API_MOCK_PROXY 中的地址 | 操作与验证状态 |
| --- | --- | --- |
| Android USB 真机 | `127.0.0.1:<端口>` | 启动代理后刷新设备、连接 USB；已实际验证 |
| Android 模拟器 | 使用插件创建 USB/ADB reverse 后填 `127.0.0.1:<端口>` | 需要设备处于已授权状态；尚未实际验收 |
| iOS 模拟器 | `127.0.0.1:<端口>` | 启动代理后运行；已实际验证 |
| Android / iOS Wi-Fi 真机 | `<电脑局域网IPv4>:<端口>` | 开启局域网监听；两端网络互通，iOS 真机路线尚未实际验收 |

`0.0.0.0` 是代理监听地址，不能作为手机连接目标。Android 模拟器使用 ADB reverse 时也不需要改成宿主机别名。USB 转发只在 Android 上提供，iOS 真机不要套用该方式。

插件只创建和清理本会话拥有的 `adb reverse`，不会覆盖冲突映射。使用系统代理时仍需单独配置手机代理，创建 reverse 本身不会让所有应用自动走代理。

### 撤销与重新接入

点击 **撤销接入** 可恢复向导记录的原文件。预览后源码变化会拒绝应用；应用后相关文件发生变化时，会整体保留并提示人工合并，避免删除仍被引用的 helper。

`.dart_tool/` 可能被 `flutter clean` 删除。需要自动撤销时应先撤销再清理；撤销记录丢失后，需要手动移除调用、导入及 helper。手动添加的初始化片段也应自行检查和移除。

不同工作区、不同 IDE 私有目录通常使用各自的 CA。切换后若证书不匹配，应重新生成对应 helper，或安装对应系统证书。不要将 CA 私钥复制进 Flutter 项目。

## 工作台使用

### 连接与诊断

准备引擎、启动 / 停止代理、刷新设备、连接 Android USB、选择局域网地址、打开 CA 位置、检测 Flutter 项目、预览 / 应用 / 撤销接入配置。底部诊断日志和 IDE 的 **输出 → Flutter API Mocks** 可用于排查错误。

### API 与历史

左侧按 **请求方法 + 主机 + 路径** 分组；查询参数不进入分组键。中间按时间展示请求，右侧查看请求、响应、修改对比和备注信息。

支持搜索主机、路径、原始 / 目标 URL、备注和标签，并按方法、状态码、时间、Mock 状态或命中规则筛选。详情显示原始、自动规则后、最终三阶段快照、耗时、目标 URL、规则和错误信息。

历史事实保持不变；备注、标签可以编辑，记录可以删除或清空。要修改记录中的请求或响应内容，使用 **生成 Mock** 或 **更多规则** 创建草稿。草稿默认禁用，检查后再启用。清空历史不会删除规则，也不会删除 CA。

### Mock 规则

提供直接 Mock、修改请求、修改响应、转发地址、手动断点五个模板。表单覆盖常见场景，完整 JSON 可组合动作。保存后规则先持久化，再同步引擎；**已保存但未生效** 表示引擎尚未确认。

复制的规则默认禁用。导入会重新生成 ID，以禁用状态追加到现有列表；导出只包含版本号和规则，不含请求历史或 CA。通过导入 / 导出可在 IDE 或同事之间手动共享配置，首版不提供云端同步或规则版本回滚。

### 断点队列

请求和响应阶段可独立暂停，命中后进入队列。每个条目显示倒计时、原始数据和自动规则处理后的当前数据，可直接放行、编辑后放行或终止请求。

默认 60 秒，可设置 10–300 秒；超时按当前自动结果放行，未提交的编辑不会应用。客户端网络超时可能更短，需在应用调试配置中合理设置。关闭工作台、停止代理或控制连接中断时，会释放等待断点；客户端取消后断点会失效。

## 规则格式与执行顺序

导入文件结构为 `{"version":1,"rules":[...]}`。版本必须为 1，最多 1000 条规则，ID 在文件内唯一。单条规则的字段如下：

| 字段 | 含义 |
| --- | --- |
| `id`、`name` | 非空 ID 和名称，ID 最长 128 字符 |
| `enabled` | 是否启用，布尔值 |
| `priority` | 整数，值越大优先级越高 |
| `match` | 匹配原始请求；空对象表示匹配所有请求 |
| `request` | 修改方法、URL、头部、查询参数或正文 |
| `redirect` | `{ "url": "完整目标URL" }` |
| `mock` | `{ "status": 200, "headers": {}, "body": "正文字符串" }` |
| `response` | 修改状态码、头部或正文 |
| `breakpoint` | 选择请求 / 响应阶段及可选等待秒数 |

每条规则至少包含一个动作；`mock` 与 `redirect` 不能同时存在。状态码为 200–599。未知字段会在插件侧拒绝保存或导入。

### 匹配条件

- `method`：忽略大小写；省略、空字符串或 `*` 表示任意方法。
- `host`：不含协议、端口和路径的主机名，忽略大小写、精确匹配；省略、空字符串或 `*` 表示任意主机。
- `path`：只匹配 URL 路径，区分大小写，支持 glob，例如 `/v1/orders/*`；不是正则表达式。省略或空字符串表示任意路径。
- `query`：键值均为字符串，所有指定条件都需满足；重复参数中存在指定值即可匹配，未指定参数不限制。
- `headers`：头部名称忽略大小写，值按字符串匹配；所有指定条件都需满足。

正文不参与匹配；JSON 字段条件、正则、延迟和故障注入不属于当前规则能力。

### 执行顺序

```text
原始请求
  → 请求阶段最高优先级的首条规则（request / redirect / mock）
  → 请求断点，人工编辑后放行
  → 访问上游，或使用本地 Mock 响应
  → 响应阶段最高优先级的首条规则（response）
  → 响应断点，人工编辑后放行
  → 应用收到最终响应
```

每个阶段独立选择规则，但始终根据**原始请求**匹配。优先级相同按列表顺序，断点也独立选取首条匹配规则。多条请求修改规则不会依次叠加；需要同时改多个字段时放入同一规则。

### 修改与转发语义

- `body` 必须是字符串。JSON 正文先序列化，例如 `"body":"{\"ok\":true}"`；不是 JSON Merge Patch。
- 省略 `body` 保留原正文，空字符串表示清空；表单的 **替换正文** 开关控制这一点。
- `request.headers`、`request.query`、`response.headers` 中字符串值表示设置，`null` 表示删除，未列出的键保留。
- `redirect.url` 和 `request.url` 都是完整地址替换，不自动拼接原路径或查询参数。同一规则同时存在时，`redirect.url` 作为目标，再应用 `request.query`。
- 跨 origin（协议、主机或端口变化）默认移除 `Authorization`、`Cookie`、`Proxy-Authorization`；同一规则的 `request.headers` 可以显式设置目标凭证。
- 转发保留请求方法和正文，不向应用生成额外的 301 / 302。
- 本地 Mock 响应仍经过响应规则和响应断点；修改 4xx / 5xx 状态会影响 Dio 最终按成功还是错误交付，具体也取决于应用的 `validateStatus` 配置。

## 完整规则示例

以下文件可直接导入：包含本地 Mock、请求 / 响应组合修改、地址转发和双向断点。导入后插件会将规则统一置为禁用，按需启用。

```json
{
  "version": 1,
  "rules": [
    {
      "id": "orders-empty",
      "name": "订单列表：空数据",
      "enabled": false,
      "priority": 20,
      "match": {
        "method": "GET",
        "host": "api.example.com",
        "path": "/v1/orders",
        "query": { "scene": "empty" }
      },
      "mock": {
        "status": 200,
        "headers": { "content-type": "application/json" },
        "body": "{\"data\":[],\"total\":0}"
      }
    },
    {
      "id": "orders-modify",
      "name": "订单查询：修改参数与响应",
      "enabled": false,
      "priority": 10,
      "match": {
        "method": "GET",
        "host": "api.example.com",
        "path": "/v1/orders",
        "headers": { "x-debug-scene": "modify" }
      },
      "request": {
        "headers": { "x-debug": "true", "x-old-debug": null },
        "query": { "page": "2", "debug": null }
      },
      "response": {
        "status": 200,
        "headers": { "content-type": "application/json", "x-mocked": "true" },
        "body": "{\"data\":[{\"id\":1001,\"state\":\"paid\"}]}"
      }
    },
    {
      "id": "orders-local",
      "name": "创建订单：转发到开发电脑",
      "enabled": false,
      "priority": 10,
      "match": { "method": "POST", "host": "api.example.com", "path": "/v1/orders" },
      "redirect": { "url": "http://127.0.0.1:3000/v1/orders" },
      "request": { "headers": { "x-debug-source": "flutter-api-mocks" } }
    },
    {
      "id": "orders-breakpoint",
      "name": "订单详情：双向断点",
      "enabled": false,
      "priority": 10,
      "match": { "method": "GET", "host": "api.example.com", "path": "/v1/orders/*" },
      "breakpoint": { "request": true, "response": true, "timeout": 60 }
    }
  ]
}
```

转发由开发电脑上的代理引擎执行，因此目标中的 `127.0.0.1:3000` 指开发电脑本机服务。它与手机访问代理时使用的 `API_MOCK_PROXY` 地址是两个不同的配置。

仓库还提供可导入的最小示例 [example.rules.json](resources/example.rules.json)。从历史生成规则草稿也能避免手动填写方法、主机和路径。

## 配置参考

在 IDE 设置中搜索 `Flutter API Mocks`，或编辑工作区 / 用户 `settings.json`。修改引擎参数后关闭工作台再打开，使新参数生效。

| 设置 | 默认值 | 有效范围与说明 |
| --- | --- | --- |
| `flutterApiMocks.enginePath` | `""` | 本地 mitmdump 绝对路径；留空使用插件管理的引擎 |
| `flutterApiMocks.proxyPort` | `8080` | 1024–65535；初始端口占用时选择其他可用端口 |
| `flutterApiMocks.retentionDays` | `7` | 1–365 天 |
| `flutterApiMocks.maxRecords` | `10000` | 1–100000 条历史 |
| `flutterApiMocks.maxBodyBytes` | `1048576` | 1024–10485760 字节；单个正文记录和编辑上限 |
| `flutterApiMocks.breakpointTimeout` | `60` | 10–300 秒；规则内可单独设置 |

```json
{
  "flutterApiMocks.enginePath": "",
  "flutterApiMocks.proxyPort": 8080,
  "flutterApiMocks.retentionDays": 7,
  "flutterApiMocks.maxRecords": 10000,
  "flutterApiMocks.maxBodyBytes": 1048576,
  "flutterApiMocks.breakpointTimeout": 60
}
```

端口始终以工作台实际显示为准；端口变化后要同步更新设备代理和 Flutter 启动参数。局域网监听通过工作台开关控制，初始为关闭，管理通道始终只监听本机。

命令面板入口：

| 命令 ID | 显示名称 |
| --- | --- |
| `flutterApiMocks.open` | Flutter API Mocks: 打开工作台 |
| `flutterApiMocks.start` | Flutter API Mocks: 启动代理 |
| `flutterApiMocks.stop` | Flutter API Mocks: 停止代理 |

## 数据存储与隐私

规则和历史保存在 IDE 的 `globalStorage` 中，按工作区 URI 的哈希隔离。规则不是自动提交到项目的配置；移动项目目录或换 IDE 后，不会自动复用原工作区数据。

```text
<IDE globalStorage>/api-mocks.flutter-api-mocks/
├── engines/<版本>-<架构>/         # 引擎及安装校验记录
└── workspaces/<工作区哈希>/
    ├── rules.json                # version: 1 的规则文件
    ├── history.sqlite3           # 请求历史，运行时可能有 WAL/SHM 文件
    └── ca/                       # 当前工作区的 CA 公钥与私钥
```

macOS 默认 VS Code 用户数据下通常为 `~/Library/Application Support/Code/User/globalStorage/`，Cursor 通常为对应的 `Cursor/User/globalStorage/`；自定义用户目录会改变实际位置。

- 默认保留最近 7 天、最多 10000 条历史；超期 / 超量记录会清理。单正文默认保存 1 MiB，超限标记截断，不截断真实转发数据。
- 请求详情包含头部和正文，可能包含业务数据与凭证；首版没有通用的自动脱敏开关。仅抓取开发调试流量，分享前检查数据。
- 规则导出不含历史或 CA，但规则中显式填写的凭证仍会导出。
- 数据在本地持久化，不提供云端同步。首次安装引擎需要联网，真实上游请求仍按规则访问对应服务。
- CA 私钥只保存在插件私有目录；helper 包含的是 CA 公钥证书，不能将私钥放入项目或共享规则。
- 引擎运行时不要直接删除私有数据库或 CA 文件。备份或手动清理前先关闭工作台；换 CA 后需要重新配置相关信任。

撤销接入记录单独位于 Flutter 项目的 `.dart_tool/api_mocks_setup.json`，与历史数据库不是同一个文件。

## 停止代理与恢复联网

| 操作 | 结果 |
| --- | --- |
| 停止代理 | 关闭流量监听、释放等待断点并尝试清理本会话 Android 转发；引擎管理通道和历史查询保留 |
| 关闭工作台 | 退出本次后台引擎、释放断点、清理本会话转发；数据保留 |
| 撤销接入 | 恢复向导记录的项目补丁；不会替你移除手机系统代理或证书 |

使用 helper 时，去掉 `--dart-define=API_MOCK_PROXY=...` 并停止、重新运行应用，即可恢复直接联网。已创建的 `HttpClient` 不会在 IDE 停止代理后自动切换为直连。

使用系统代理时，在设备 Wi-Fi 设置中恢复 **无代理 / 关闭**，按需移除调试 CA。引擎崩溃或 IDE 关闭后，如果客户端仍指向代理，可能暂时无法联网，按上述步骤恢复。

设备离线导致转发清理失败时，重新连接设备后按诊断日志移除对应端口：

```sh
adb -s YOUR_ANDROID_SERIAL reverse --remove tcp:8080
```

使用日志中的实际端口，避免移除其他工具的转发。

## 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 找不到命令 | 确认 VSIX 安装在当前 IDE、本地受信任工作区已打开，必要时重新加载窗口 |
| 下载失败 / 校验失败 | 检查能否访问官方站点后重试；也可在设置中指定完整包中的 12.3.1 mitmdump 绝对路径 |
| 找不到 Flutter 项目 | 打开包含 `pubspec.yaml` 的包根目录；monorepo 中应选择真正创建 Dio 的包 |
| 没发现 Dio 初始化位置 | 确认直接依赖 Dio 5、实际声明位于 `lib/`；工厂、生成代码或复杂结构按手动片段接入 |
| 预览后不能应用 | 保存相关文件并重新检测；已有 helper、自定义网络配置或源码变化会触发保护 |
| 无请求历史 | 确认代理已启动、应用使用已接入的 Dio、启动参数地址正确，Android reverse 和设备网络可用 |
| HTTPS 握手失败 | helper 是否对应当前工作区 CA；系统代理路线是否信任当前证书；是否有证书固定或自定义校验 |
| 手机连不上电脑 | 不要使用 `0.0.0.0` 作目标；Wi-Fi 路线开启局域网监听，检查 IP、网络隔离和防火墙；Android USB 检查授权 |
| 规则没有命中 | 检查启停、方法、主机和原始路径；主机不填协议或端口，查询参数另填；检查更高优先级规则 |
| 规则已保存但未生效 | 查看错误日志；初始化 / 重启引擎并重新保存，同步成功后才生效 |
| 只改请求头后正文不对 | 确认未开启“替换正文”；空字符串正文会清空内容 |
| 断点提前消失 | 应用自己的超时或取消可能早于插件倒计时；也检查是否停止代理、关闭面板或控制断连 |
| 转发后鉴权失败 | 跨站默认删除旧站凭证；按需在同规则 request.headers 中配置目标凭证；业务签名需项目自行处理 |
| 撤销提示保留文件 | 接入后源码已被修改，需人工合并；若 `.dart_tool` 记录被清理也要手动移除接入 |
| 停止后应用无法联网 | 去掉启动参数并重启应用，或移除设备系统代理，已创建客户端不会自动恢复直连 |
| 重启后历史看不到 | 确认打开相同路径的工作区和同一 IDE，初始化引擎以查询本地数据库，并检查保留策略 |

请提供 IDE / macOS / Flutter / Dio 版本、设备类型、接入路线、复现步骤及脱敏日志。不要把 CA 私钥或真实业务凭证放入问题报告。

## 开发、测试与打包

### 本地开发

在仓库根目录安装依赖并构建：

```sh
npm ci
npm run typecheck
npm test
npm run build
```

迭代时执行 `npm run watch`。可通过 IDE 的扩展开发宿主加载该仓库，也可重新打包 VSIX 安装。构建使用 esbuild，扩展运行时依赖已打入 `dist/`，不需要用户在 IDE 中运行 npm。

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 扩展和 Webview 的 TypeScript 类型检查 |
| `npm test` | Vitest 单测与扩展整合回归 |
| `npm run format:check` | 检查 TypeScript / CSS / 构建脚本格式 |
| `npm run build` / `npm run watch` | 一次构建 / 持续构建 |
| `npm run test:ui` | 以构建产物运行 Playwright 工作台测试 |
| `npm run test:proxy` | Python 单测；设置 MITMDUMP 后同时执行真实代理集成 |
| `npm run test:ide` | 实际 IDE 扩展宿主 smoke；需设置引擎路径 |
| `npm run package` | 构建并生成 VSIX，不发布 |

### 工作台与真实代理测试

UI 测试使用本机 Google Chrome，修改浏览器选择见 `playwright.config.ts`。应先构建，测试服务器只在本机启动：

```sh
npm run build
npm run test:ui
```

代理集成测试使用 Python 测试驱动，并启动真实独立引擎：

```sh
MITMDUMP=/absolute/path/to/mitmdump npm run test:proxy
API_MOCK_SQLITE_CLI=1 python3 -m unittest discover -s tests/proxy -p test_storage.py -v
```

不设置 `MITMDUMP` 时，真实集成测试会跳过，不能把跳过计为通过。Python 是源码测试驱动的要求，安装后的插件运行不依赖用户 Python。

### IDE 与 Flutter 设备验收

IDE 测试脚本使用 `/Applications` 下的 VS Code / Cursor，运行独立临时用户目录，测试端口为 18080；执行前需构建：

```sh
npm run build
API_MOCK_TEST_ENGINE=/absolute/path/to/mitmdump npm run test:ide
API_MOCK_TEST_ENGINE=/absolute/path/to/mitmdump API_MOCK_TEST_IDE=cursor npm run test:ide
```

可用 `API_MOCK_TEST_EXTENSION_PATH` 指向解压 VSIX 中的 `extension/`，验证打包产物。测试宿主会实际打开 IDE 窗口。

Flutter 示例检查：

```sh
cd examples/flutter
flutter pub get
flutter analyze
flutter test
```

设备 smoke 需要仓库 npm 依赖、Flutter、已启动的 iOS 模拟器或已授权 Android 设备，示例不能已有未撤销的接入补丁：

```sh
python3 tool/device_smoke.py --mitmdump /absolute/path/to/mitmdump --android YOUR_ANDROID_SERIAL
python3 tool/device_smoke.py --mitmdump /absolute/path/to/mitmdump --ios YOUR_SIMULATOR_UDID
```

两个设备参数也可一起使用。脚本会安装并运行测试示例，临时生成 helper；完成后撤销自身补丁、清理本会话转发及引擎，不安装系统 CA。详情与日志位置见 [示例说明](examples/flutter/README.md)。

### 构建可分发安装包

```sh
npm run package
shasum -a 256 artifacts/flutter-api-mocks-0.1.0.vsix
```

VSIX 包含扩展构建产物、代理 addon、引擎清单及文档，不包含 Node 开发依赖、Flutter 示例构建结果或真实证书。首次引擎下载单独发生。源码中的 README 修改后，应重新打包，安装包内的文档才会更新。

## 架构与目录

```text
VS Code / Cursor
  React 工作台 ← Webview 消息 → TypeScript 扩展
                                   │
                          本机 TCP JSONL v1 + 会话令牌
                                   │
Flutter Dio → HTTP/HTTPS 代理 → mitmdump + Python addon → 目标服务
                                   │
                            SQLite 历史 / CA
```

Flutter 业务流量与管理通道分离；每个工作台绑定一个工作区。扩展管理引擎进程、下载、规则文件及设备接入，addon 执行网络修改与断点，并通过 SQLite 保存历史。详情按需读取，避免列表反复传输完整正文。

```text
src/                  # 扩展入口、引擎管理、规则模型、Dio 接入与设备工具
webview/              # React 工作台与主题样式
proxy/                # mitmproxy addon、规则执行、SQLite 及 CLI 后备
resources/            # 固定引擎版本/校验清单、示例规则
scripts/              # 构建、工作台测试服务器、IDE 测试驱动
tests/                # TypeScript、Python、UI 和扩展宿主测试
examples/flutter/     # Android/iOS Dio 示例与设备 smoke
docs/validation.md    # 实际验收记录与未验证项
.harness/momory/      # 已确认需求、工程记忆和实现经验
```

管理协议、RPC 和正文处理限制见 [代理说明](proxy/README.md)。首版没有独立 Dart SDK、HTTP 对外管理 API 或云端服务。

## 已知限制与验证状态

### 正文处理

| 内容 | 首版处理 |
| --- | --- |
| 上限内 JSON / 文本 | 可查看和完整替换 |
| 上限内 gzip / deflate | 支持有界解码和正文编辑 |
| 上传文件、multipart、二进制 | 正文只读直通 |
| SSE、chunked、无长度流 | 正文只读直通，不为编辑等待完整流 |
| 超过记录上限 | 只保存前缀并标记截断，真实数据直通 |
| br / zstd 压缩 | 正文只读直通 |

只读正文仍可按规则修改地址或头部；应避免手动设置与正文不一致的长度或编码头。极端正文转义导致管理帧超限时，详情会明确报错，断点直接放行。

证书固定、自定义适配器、应用签名、缓存与重试可能影响代理结果。网络层修改不能自动重签业务报文。首版不保证捕获原生插件和其他网络库的全部流量，也不提供请求重放、规则版本历史或任意脚本能力。

### 已验收与未验收

2026-11-08 的实现验收包括：44 项 TypeScript 测试、28 项 Python 测试（含 16 项真实 HTTP / HTTPS 集成）、强制 SQLite CLI 后备的 7 项存储测试、6 项工作台交互测试，以及 3 项 Flutter Widget 测试。

已实际运行 VS Code / Cursor 扩展宿主、Android 三星 USB 真机及 iPhone 模拟器，覆盖 HTTPS Mock、转发、双向修改和真实 HTTPS 上游。arm64 引擎完整安装与运行已验证，Intel 包已验证下载内容和校验值。

以下仍标记为**未验证**：Android 模拟器、iOS 真机局域网、macOS Intel 运行、系统代理与系统 CA 的完全零代码接入，以及设备级手动断点。断点已在真实代理集成及工作台交互测试中覆盖。完整环境、覆盖场景和复现命令见 [验收记录](docs/validation.md) 与 [设备结果](examples/flutter/tool/device-validation.json)。

## 许可证与第三方组件

项目采用 [MIT License](LICENSE)。使用 mitmproxy、React / React DOM 和 VS Code Extension API，第三方许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

mitmproxy 按需从官方站点下载，保留独立包中的许可证和声明。插件引擎清单锁定版本与校验值；本仓库不包含 CA 私钥、个人设备标识或 Apple 签名团队信息。

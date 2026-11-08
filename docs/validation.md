# 验收记录

日期：2026-11-08（Asia/Shanghai）。本报告区分实际运行与未验证项目。

## 环境

- macOS Apple Silicon / arm64。
- Node.js 22.22.2；Flutter 3.47.8、Dart 3.13.7、Dio 5.11.1。
- 官方 mitmproxy 12.3.1 macOS arm64 standalone；SQLite 使用 macOS 系统 CLI 后备，运行不依赖用户 Python。
- VS Code 1.116.0，Cursor 3.29.9；测试使用隔离的临时用户目录。
- Android：Samsung SM_A1760 已授权 USB 真机。
- iOS：iPhone 18 Pro / iOS 27.2 模拟器。

## 已通过

| 层级 | 验证内容 |
| --- | --- |
| TypeScript | 44 项单测：引擎下载校验/缓存/安全解压、进程与令牌协议、端口冲突、UTF-8分包、RPC 超时/崩溃、规则文件与历史草稿、Dio 检测/补丁/撤销、设备解析和转发、扩展生命周期及生效状态 |
| Python | 28 项测试：12 项规则/SQLite 单测、16 项真实 HTTP/HTTPS 代理集成；使用真实官方独立引擎 |
| SQLite 后备 | 强制 API_MOCK_SQLITE_CLI=1，7 项存储测试，含 SQL/CLI 注入字符串、空字符、Unicode、保留策略、查询及跨重启读取 |
| 工作台 | 6 项 Playwright 交互测试：连接操作、规则表单/JSON 校验及 CRUD 消息、历史/对比/备注/规则草稿、并发断点编辑/终止、浅色主题/680px窄面板无横向溢出；保存截图；额外回归仅修改头部保留正文及关闭断点后保存 |
| 扩展宿主 | VS Code、Cursor 分别激活扩展、打开工作台、启动真实引擎、HTTPS Mock、SQLite 历史落盘、停止代理监听；均通过 |
| Flutter | flutter analyze 无问题，3 项 Widget 测试；Android debug、iOS simulator 构建通过 |
| Android 真机 | 真实向导生成 helper，USB adb reverse，HTTP Mock、HTTPS Mock、HTTPS 转发、POST JSON/请求头修改、响应状态202/头修改、跨站凭证剥离、真实 example.com 上游 HTTPS |
| iOS 模拟器 | 同上代理场景；通过独立 SecurityContext 信任调试 CA，不安装系统 CA，不关闭证书校验 |
| 引擎供应 | arm64、x64 官方压缩包均实际下载计算 SHA-256，和官方 Sigstore 及 Homebrew cask 交叉核对；arm64 完整安装与运行流程通过 |

代理集成还覆盖：Mock 无上游调用、4xx 改为成功、请求和响应手动编辑、并发断点、超时、终止、客户端取消、控制断连放行与重连、停止监听后仍可查历史、恢复监听、multipart/二进制/大正文/SSE直通、gzip 修改、有界解压防止超大解压输出。

设备级结果保存在 `examples/flutter/tool/device-validation.json`。可复现脚本为 `examples/flutter/tool/device_smoke.py`。设备测试累计写入 8 条历史，结束后恢复示例源码，清理自己创建的 adb reverse、临时 helper、引擎与测试应用。

## 未验证和兼容限制

- **Android 模拟器、iOS 真机局域网、macOS Intel 实际运行**尚未验证；Intel 仅验证下载包与校验值。
- **系统代理与系统 CA 的完全零代码接入**尚未实际验收；设备通过的是 Dio 最小开发配置路线。
- 设备级手动断点未验收；断点已在真实代理集成和浏览器 UI 分别验证。
- br/zstd、文件上传、二进制、SSE、chunked/无长度流和超限正文保持直通，首版不支持其正文修改。
- 原生插件、其他网络库、自定义适配器、证书固定、应用层签名、Web 和远程 IDE 不计入兼容承诺。
- 本地 VSIX 未发布扩展商店，尚未配置发布者账号、商店审核或签名发布流程。

## 复现命令

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:ui
MITMDUMP=/absolute/path/to/mitmdump npm run test:proxy
API_MOCK_SQLITE_CLI=1 python3 -m unittest discover -s tests/proxy -p test_storage.py -v
API_MOCK_TEST_ENGINE=/absolute/path/to/mitmdump npm run test:ide
API_MOCK_TEST_ENGINE=/absolute/path/to/mitmdump API_MOCK_TEST_IDE=cursor npm run test:ide
cd examples/flutter
flutter analyze
flutter test
```

最终 VSIX 通过 `npm run package` 生成，并在 VS Code、Cursor 的独立扩展目录实际安装验证。解压安装包后另跑 VS Code 扩展宿主 HTTPS Mock 与历史落盘验证。默认的 Python 测试命令在未设置 MITMDUMP 时跳过真实集成测试，不能把跳过计为通过。

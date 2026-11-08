# 实现与验证结论

2026-11-08 已实现首版。入口 src/extension.ts；React webview；proxy/addon.py；Dio 接入 src/setup.ts。

- mitmproxy 固定 12.3.1，arm64/x64 SHA 来自真实下载及官方交叉核对，manifest 位于 resources/engine-manifest.json。
- 官方 standalone 不带 Python sqlite3，proxy/sqlite_cli.py 使用 macOS /usr/bin/sqlite3，经 stdin 传固定SQL模板和正确转义的参数，不需用户Python。
- proxy.start/stop 只切流量监听。新增后台会话生命周期：关闭工作台后继续记录；退出 IDE / 移除对应工作区时才关闭引擎。
- history.list 返回摘要，history.get 返回三快照，避免大量正文通过 TCP/Webview 反复发送。
- 流式、二进制、上传、超限和 br/zstd 正文仅直通；gzip/deflate 有界解压。
- 已实际通过 VS Code/Cursor 独立扩展宿主 HTTPS Mock，以及 Android USB 真机和 iOS 模拟器最小开发接入。完整测试统计见 docs/validation.md。
- 尚未实际验收 Android 模拟器、iOS 真机 LAN、Intel 运行、系统代理零代码路线；不得宣传已全覆盖。

## 可复用修复经验

- helper 必须保留系统可信根，只加入当前调试 CA；不允许无条件跳过 TLS 验证。
- 下载中关闭工作台仍可继续后台初始化；退出 IDE / 移除工作区必须在异步恢复后检查 disposed，防止遗留 sidecar。
- 断点编辑只提交变化的头部，避免 Object.fromEntries 压缩未改动的重复 Set-Cookie。
- 保存规则和引擎确认生效是两个状态；同步失败保留已保存规则并明确显示未生效。
- 选中详情仅在变化时发送，普通流量事件不重复携带六份正文；TCP 按完整帧解码 UTF-8。
- 对用户后续编辑的接入文件整体保护，不单独删除仍被引用的 helper。

## 后台自动记录与独立 API 目录增量

- 用户已确认默认行为，需求无需再次询问：完成首次接入后，打开受信任本地 Flutter 工作区自动启动已安装 / 配置引擎，不静默下载；autoStart 默认 true。
- 工作台与后台会话分离，多根工作区按 Flutter 文件夹隔离；重新打开面板不会撤销本会话的手动停止。
- connection.json 保存连接地址、端口与已选 Android 设备，后台启动尝试恢复在线且已授权设备的本会话转发。
- history.apis 查询独立目录，累计次数不等于现存历史条数；旧历史只迁移一次，防止用户删除目录后被旧记录复活。
- api.delete 仅删除目录项，不删除历史或规则；未来新调用会重新发现。历史过期、删除或清空不删除目录。
- breakpoint.setInteractive 控制人工暂停：后台默认关闭，打开工作台开启，关闭 / 断连时释放等待断点并关闭；自动规则始终按当前配置执行。
- 增量已通过 59 项 TypeScript、36 项 Python、12 项强制 SQLite CLI 和 9 项 UI 测试；真实 IDE 与设备验收范围以 docs/validation.md 为准，不能用首版测试统计替代。

## EXIO 实际接入与复用（2026-11-08）

- 项目：`/Users/mark.pan/Documents/exio/exio_app`；Cursor + Flutter 3.47.8 + iPhone 18 Pro / iOS 27.2，dev flavor。
- 代理：`127.0.0.1:8080`，仅本机监听。模拟器不需要 Android reverse 或局域网监听；地址端口以工作台实际值为准。
- 启动项：`exio_app (API Mocks · iPhone 18 Pro)`；独立入口 `apps/exio_app/lib/main_api_mocks.dart`，Debug + `API_MOCK_PROXY` 才启用，通过现有 `apiClientInterceptorInstallerProvider` 安装适配器。保留系统可信根并加入当前 CA 公钥证书，不使用旧 `EXIO_DEBUG_HTTP_PROXY` 的无条件放行路线。
- 实测快照：10 个 API、39 条请求；多个真实 HTTPS 200，法币接口本地 Mock 命中 2 次，响应头带 `x-api-mocks-demo: exio-cursor`。计数是当次验收快照，不是后续固定预期。
- 结束状态：教程规则“教程 · 法币列表 Mock（原响应）”保留且停用；代理继续采集。重载 Cursor、未打开工作台时自动启动已实际验证。
- 自动发现修复：根 pubspec 的显式 Dart workspace 成员识别 Flutter，最多 256 项，不递归、不展开 glob，拒绝根外路径，按 IDE 根目录建立单会话。TypeScript 全套 59 项通过。
- 覆盖主 API Dio；下载临时 Dio、WebView、原生插件和 WebSocket 未计入覆盖。首轮超时后重试、登录恢复 401 已如实记录，没有登录或交易操作。
- 换电脑或 CA 重建需更新公钥证书；恢复常规开发先停止当前调试，切回原 `exio_app` 启动项，再停止代理。
- [完整图文教程与 12 张截图](../../docs/exio-cursor-guide/README.md)；[验证结论](../../docs/validation.md)。EXIO 仓库内同步保存教程 `docs/api-mocks/README.md`，接入约束位于 `.harness/memory/rules/runtime-services.md`。

## API 工作台布局与正文阅读（2026-11-08）

- 目录按 lastAt、请求列表按 startedAt 倒序，客户端对乱序输入显式排序；存储端已有倒序和分页，跨页仍依存储排序。
- 目录可折叠、独立搜索；折叠不清除当前 API 筛选，折叠偏好通过 Webview getState/setState 保留；窄面板目录放在列表上方，不再直接隐藏。
- 点击新请求默认展示响应，提供请求/响应标签、放大详情/返回列表、状态/耗时/完整日期摘要；长路径两行截断，完整 URL 保留可滚动查看。
- 文本正文不依赖 Content-Type，自动尝试 JSON 格式化，支持切原文与复制当前展示内容；非 JSON 明确回退原文，二进制仅 Base64，无响应、空正文、截断分别展示。
- `webview/body.ts` 使用 JSON.parse 验证语法，但通过原始 token 格式化，不重序列化解析结果，保留大整数、数字精度、重复键和转义。正文 1 MiB、格式化结果 4 MiB、缩进深度 24 层设阅读资源边界，超限回退原文。历史实际快照不变。
- 本轮 68 项单元测试、17 项 Playwright、TypeScript/Webview 类型检查通过；截图使用合成数据。设备网络与上轮 MFA 代理超时问题未在本轮修复或重新验收。

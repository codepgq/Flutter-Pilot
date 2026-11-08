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
- 增量已通过 54 项 TypeScript、36 项 Python、12 项强制 SQLite CLI 和 9 项 UI 测试；真实 IDE 与设备验收范围以 docs/validation.md 为准，不能用首版测试统计替代。

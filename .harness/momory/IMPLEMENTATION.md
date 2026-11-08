# 实现与验证结论

2026-11-08 已实现首版。入口 src/extension.ts；React webview；proxy/addon.py；Dio 接入 src/setup.ts。

- mitmproxy 固定 12.3.1，arm64/x64 SHA 来自真实下载及官方交叉核对，manifest 位于 resources/engine-manifest.json。
- 官方 standalone 不带 Python sqlite3，proxy/sqlite_cli.py 使用 macOS /usr/bin/sqlite3，经 stdin 传固定SQL模板和正确转义的参数，不需用户Python。
- proxy.start/stop 只切流量监听；工作台关闭才关闭引擎，历史仍可查看。
- history.list 返回摘要，history.get 返回三快照，避免大量正文通过 TCP/Webview 反复发送。
- 流式、二进制、上传、超限和 br/zstd 正文仅直通；gzip/deflate 有界解压。
- 已实际通过 VS Code/Cursor 独立扩展宿主 HTTPS Mock，以及 Android USB 真机和 iOS 模拟器最小开发接入。完整测试统计见 docs/validation.md。
- 尚未实际验收 Android 模拟器、iOS 真机 LAN、Intel 运行、系统代理零代码路线；不得宣传已全覆盖。

## 可复用修复经验

- helper 必须保留系统可信根，只加入当前调试 CA；不允许无条件跳过 TLS 验证。
- 下载中关闭工作台必须在异步恢复后检查 disposed，防止遗留 sidecar。
- 断点编辑只提交变化的头部，避免 Object.fromEntries 压缩未改动的重复 Set-Cookie。
- 保存规则和引擎确认生效是两个状态；同步失败保留已保存规则并明确显示未生效。
- 选中详情仅在变化时发送，普通流量事件不重复携带六份正文；TCP 按完整帧解码 UTF-8。
- 对用户后续编辑的接入文件整体保护，不单独删除仍被引用的 helper。

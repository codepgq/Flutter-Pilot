# Flutter API Mocks 项目记忆

## 已完成头脑风暴并确认的需求

- macOS 上的 VS Code/Cursor 桌面扩展，Android/iOS Dio 5 优先。
- 代理路线优先零代码；系统代理/证书不兼容时提供开发期最小辅助代码和可预览、可撤销补丁。
- 插件管理固定版本 mitmproxy 独立引擎，不依赖用户 Python。
- 请求、响应规则修改，本地 mock，目标地址改写（不是 301/302）。
- 自动规则及双向人工断点；默认超时 60 秒自动放行。
- 请求历史与 mock 规则分开；历史事实不直接改写，备注标签可改，规则支持 CRUD。
- 默认历史 7 天 / 10,000 条 / 正文 1 MiB；规则与 SQLite 按工作区私有存储。
- 2026-11-08 用户确认：打开 Flutter 项目后默认后台自动记录，关闭工作台仍继续；首次仍需安装引擎并完成 Flutter 代理接入。
- API 目录独立持久化，按方法、主机、路径保存累计调用数及首次 / 最近调用时间；历史清理不影响目录，可手动删除，后续请求重新发现。
- autoStart 默认 true，手动停止本会话后不因重新打开面板恢复；下次打开 IDE / 工作区按设置启动。
- 2026-11-08 用户确认 API 工作台优化：API 目录按最近调用、请求历史按发生时间从新到旧；目录可折叠；点击请求便于查看 Request / Response，响应优先尝试 JSON 解析。允许补充相关布局与使用体验优化。
- 关闭面板仅释放等待断点并关闭人工暂停；后台继续执行已启用自动规则及记录。退出 IDE / 移除工作区才关闭会话。
- 不开放任意脚本，不承诺支持 pinning、自定义适配器、Web、Remote SSH 或所有网络库。

## 工程约定

- 扩展 TypeScript，工作台 React，代理 Python addon，管理通道本机 TCP JSONL v1 + 会话令牌。
- 文件按 src/、webview/、proxy/、tests/、examples/flutter/ 分工。
- 规则按原始请求匹配；每阶段最高优先级首条执行，列表稳定排序；手工编辑最后执行。
- 必须保留证书校验，禁止 badCertificateCallback 无条件放行。
- 用户已授权完整实现本计划，不重复询问已确认需求。
- 真实设备或 IDE 无法验收的项目标注未验证，不能冒充通过。

## 实际项目接入记录入口

- EXIO 已完成 Cursor + iPhone 18 Pro 模拟器实际接入。配置、操作截图、Mock 演示和恢复步骤见 [EXIO 图文教程](../../docs/exio-cursor-guide/README.md)，实际通过范围见 [验收记录](../../docs/validation.md)。
- Dart workspace 根目录即使没有直接声明 Flutter，也应根据显式 workspace 成员识别 Flutter 项目，并以 IDE 根目录维护一个后台会话；不递归扫描、不展开 glob，最多检查 256 项。
- 遇到自定义 Dio 适配器时先检查项目已有开发接入口；EXIO 通过独立开发入口复用 API installer，加入当前代理 CA 公钥证书并保留 TLS 校验，不沿用无条件放行证书的代理设置。

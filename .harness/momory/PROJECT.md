# Flutter API Mocks 项目记忆

## 已完成头脑风暴并确认的需求

- macOS 上的 VS Code/Cursor 桌面扩展，Android/iOS Dio 5 优先。
- 代理路线优先零代码；系统代理/证书不兼容时提供开发期最小辅助代码和可预览、可撤销补丁。
- 插件管理固定版本 mitmproxy 独立引擎，不依赖用户 Python。
- 请求、响应规则修改，本地 mock，目标地址改写（不是 301/302）。
- 自动规则及双向人工断点；默认超时 60 秒自动放行。
- 请求历史与 mock 规则分开；历史事实不直接改写，备注标签可改，规则支持 CRUD。
- 默认历史 7 天 / 10,000 条 / 正文 1 MiB；规则与 SQLite 按工作区私有存储。
- 不开放任意脚本，不承诺支持 pinning、自定义适配器、Web、Remote SSH 或所有网络库。

## 工程约定

- 扩展 TypeScript，工作台 React，代理 Python addon，管理通道本机 TCP JSONL v1 + 会话令牌。
- 文件按 src/、webview/、proxy/、tests/、examples/flutter/ 分工。
- 规则按原始请求匹配；每阶段最高优先级首条执行，列表稳定排序；手工编辑最后执行。
- 必须保留证书校验，禁止 badCertificateCallback 无条件放行。
- 用户已授权完整实现本计划，不重复询问已确认需求。
- 真实设备或 IDE 无法验收的项目标注未验证，不能冒充通过。

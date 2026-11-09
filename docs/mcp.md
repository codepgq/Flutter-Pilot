# 通过 MCP 接入编码 Agent

MCP 让 Claude Code CLI、Codex CLI 和 Codex App 复用插件已经连接的 Dart VM，在 Flutter Debug 应用中按 Key 定位、点击、输入和滚动，并读取 HTTP／WebSocket 记录验证结果。接入无需在应用中添加 Driver、测试入口或 helper。插件仍需在受信任的 macOS 本地 Cursor／VS Code 工作区中运行。

## 开启与适配

1. 用项目原来的入口启动 Flutter Debug 应用，在 **连接与诊断** 确认 VM 已连接。
2. 打开工作台 **MCP** Tab，开启 MCP。服务默认关闭，开关按当前工作区保存在 IDE 私有存储中。
3. 在目标 Agent 卡片中选择 **当前项目** 或 **全局**，默认当前项目，点击 **一键适配**。未开启服务时适配会同时开启当前工作区 MCP。
4. 按卡片提示在客户端加载配置。Claude Code 可能需要批准项目 MCP；Codex 可能需要信任项目、重新加载 MCP 或新建会话。插件不会跳过这些客户端步骤。
5. 让 Agent 调用 `list_sessions`，确认项目与会话，然后执行后续工具。

适配需要本机可用的 Node.js 20+；插件检测并保存其绝对路径，不自动安装运行时。桥接脚本存放在用户私有的稳定路径，升级插件后无需因为扩展安装目录变化重新配置 Agent。

**已配置，待客户端连接** 表示配置文件已就绪，不能证明 Agent 已加载。一键适配还会进行桥接自检，但自检不会使客户端被标记为已连接。只有实际 MCP 客户端握手后才显示连接信息。客户端信任、批准及组织策略无法仅从配置文件确认；状态未知时明确提示，不会静默改成全局配置。

## 项目与全局范围

| 客户端          | 当前项目                    | 全局                                                  |
| --------------- | --------------------------- | ----------------------------------------------------- |
| Claude Code CLI | 项目 `.mcp.json`            | 用户级 Claude MCP 配置                                |
| Codex CLI       | 项目 `.codex/config.toml`   | `CODEX_HOME/config.toml`，默认 `~/.codex/config.toml` |
| Codex App       | 其实际加载的项目 Codex 配置 | 其实际加载的用户 Codex 配置                           |

Codex CLI 与 App 可能共用配置；卡片会显示共享来源，配置不会重复写入。是否支持项目配置以目标客户端实测为准。项目适配仅能访问绑定工作区，全局适配可以发现本机已开启 MCP 的工作区；全局适配不会为其他项目自动开启服务。所有有目标的操作均需传入明确的 `sessionId`。

已有其他 MCP 配置会保留。同名配置不匹配时显示冲突，点击 **修复本插件配置** 才替换该条目；**移除适配** 只移除确认属于本插件的配置。关闭 MCP 保留客户端配置，重新开启即可恢复。关闭工作台不停止后台服务；退出 IDE 或关闭工作区后会话不可用。

VM 认证地址不写入 Agent 配置。桥接进程通过私有 Unix socket 访问插件，每次请求校验本地会话凭证与工作区；注册文件、凭证和 socket 不进入项目仓库。

## Widget 定位与 Key 诊断

正式定位支持精确的 `ValueKey<String>` 与 `ValueKey<int>`，工具参数 `key` 使用字符串或整数。可用 `ancestorKey` 限定父节点范围；Key 在局部树中可重复，范围内多个匹配会报告 `AMBIGUOUS_KEY`。

```json
{ "sessionId": "从 list_sessions 获取", "key": "login.submit", "ancestorKey": "login.page" }
```

工具不会把 Key 的显示文本作为标识，不回退到页面文字或裸坐标。`UniqueKey`、对象身份 Key 及自定义 Key 子类不作为首版稳定选择器。每次操作重新查找，Hot Restart 后不复用旧对象。

`find_widget` 返回 `NOT_FOUND` 只说明当前未找到：页面可能尚未进入，或者列表项尚未创建。`inspect_key_issues` 检查当前已挂载交互目标的缺失／不稳定 Key，不是全项目静态审计。稳定的外层 Key 能唯一定位内部交互节点时，不会要求给框架内部所有节点补 Key。诊断尽可能包含源码位置，无法可靠映射时会说明。编码 Agent 应结合业务源码补 Key，再热重载或重启并重新验证。

点击与滚动通过 Flutter pointer 事件和命中测试执行，不直接调用按钮回调；遮挡、禁用、屏幕外目标可能无法操作。输入先取得焦点，再走 Flutter 文本编辑更新链路，支持 formatter 和 `onChanged`；它模拟文本编辑协议，**不覆盖真实系统键盘 IME 组合输入**。

同一会话的 UI 操作串行执行，多个 Agent 的一次手势不会穿插。多个工具调用组成的业务流程不持有跨调用锁。等待和滚动均有上限；操作超时可能已经触发业务，Agent 应先查询界面或网络结果，不能自动重试点击。

## 工具列表

| 工具                                       | 用途                                            |
| ------------------------------------------ | ----------------------------------------------- |
| `list_sessions`                            | 获取已开启 MCP 的项目和能力                     |
| `get_ui_snapshot`                          | 获取有界的已挂载 UI 结构                        |
| `find_widget`                              | 按 Key 查询目标                                 |
| `tap` / `enter_text` / `scroll`            | 点击、替换输入内容、滚动                        |
| `wait_for_widget`                          | 等待出现、消失或可操作                          |
| `inspect_key_issues`                       | 诊断当前界面交互目标的 Key                      |
| `get_network_status`                       | 查询采集／Mock／规则加载状态和文件位置          |
| `get_requests` / `get_request`             | 分页查询 HTTP 记录与详情                        |
| `get_ws_connections` / `get_ws_messages`   | 查询 WS 连接和消息；`includeBodies` 请求正文    |
| `reload_rules`                             | 重新读取、校验并同步 `http`、`ws` 或 `all` 规则 |
| `set_capture_enabled` / `set_mock_enabled` | 显式控制指定 `http`／`ws` 域的开关              |

除 `list_sessions` 外，工具均需 `sessionId`。正式参数及边界以客户端发现的工具 schema 为准。MCP 不提供任意 Dart 求值、规则增删改或 WS 手动推送工具。

## Agent 操作示例

可以向编码 Agent 下达以下任务：

> 调用 Flutter API Mocks 的 `list_sessions`，选择当前项目。查看 `get_network_status` 返回的规则路径，保留已有规则，只修改产品详情 Mock 正文。保存 `.api-mocks/rules.json` 后调用 `reload_rules`，确认加载和同步成功，显式开启 HTTP Mock。使用 Key `products.item.123` 点击产品，等待 Key `product.detail` 出现，查询对应 HTTP 请求并验证响应字段。出现 Key 诊断问题时修改业务源码补稳定 Key，重新验证；不要用文本点击绕过问题。

HTTP 规则保存在 `.api-mocks/rules.json`，WS 持久规则保存在 `.api-mocks/ws-rules.json`。Agent 直接维护文件；配置非法时保留文件及上一份有效规则。重载并不自动开启 Mock，WS 重载保留仍有效的连接临时规则。HTTP 与 WS 开关彼此独立，VM 断线后按原有规则关闭，重新连接后须显式开启。

## 可用性与验证边界

MCP 能连接不代表全部运行时能力均可用。请在 Tab 中查看 VM 状态和能力探测结果；不支持的 Flutter 运行时返回明确诊断。首次真实验证以 iOS 模拟器为基线，Android、真机及具体客户端版本通过范围以 [验收记录](validation.md) 为准，不能用传输层单测替代设备验收。

未打开 IDE、当前工作区未开启 MCP 或 VM 尚未连接时，Agent 会获得可用性提示。配置已写入但工具尚未出现时，先按客户端卡片提示检查信任、加载及策略状态，再重新检测。

规则重载结果中 `loaded` 表示读取及校验通过，`synchronized` 表示插件接受规则并完成当前可执行的同步，`runtimeApplied` 表示运行中的 Mock 已实际接入；`pending` 表示仍需连接 VM、开启 Mock 或发现实例。不能仅凭文件加载成功断言请求已被 Mock。

适配卡片提示项目、全局及 Claude local 配置的同名覆盖关系。未知 Codex 握手名只显示实际名称，不推断来自 CLI 还是 App。

MCP 配置和 stdio 连接不需要 macOS 钥匙串。隔离 IDE 验收可能触发宿主自身的钥匙串提示，因此 `test:ide:mcp` 默认跳过 GUI，不能作为日常自动回归运行。

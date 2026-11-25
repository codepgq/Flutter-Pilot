# Flutter 与 Web 统一运行时

当前开发源码在一个插件、一个默认 `flutter-pilot` MCP 中提供 Flutter Debug、HTTP 代理和托管 Chromium。插件标识、项目 UUID、`.flutter-pilot/scenes/` v2 与 `tests.json` v2 保持兼容。安装与发布单独执行；开发分支不会更改活动 IDE。

## 接入

1. React/Vue/Vite package 可被识别。原生 HTML 或混合仓库在「连接与诊断 → Web 项目接入」保存本地 URL，必要时指定相对子项目根；普通 Node package 不自动当作 Web。
2. 项目启动配置位于 `.flutter-pilot/launch.json`。「连接与诊断 → 项目启动」可直接启动 Web 开发服务器或现有 Flutter Debug 配置；也可手动编辑该文件后点击「重新读取」。示例见 [example.launch.json](../resources/example.launch.json)。
3. Web profile 仅接受工作区内相对 `root`、`npm/pnpm/yarn/bun` 与 `package.json` 中存在的脚本，使用无 shell 子进程；Flutter profile 引用 `.vscode/launch.json` 中命名且唯一的 Dart Debug 配置。
4. 准备浏览器时先安装锁定版 Playwright 运行时；若本机已安装 Chrome/Chromium/Edge/Brave，则以其启动隔离临时 Profile 并跳过 190 MB 的 Chromium 下载。仅在没有受支持系统浏览器时下载私有 Chromium。显式准备后再创建 Context；仅使用 Flutter 无需准备浏览器。
5. MCP 先 `list_sessions`，再按目标调用 `get_browser_status`、`create_browser_context`。记录返回的 runtimeId/generation；按需激活 Scene 后 `open_browser_page`，后续 UI 固定传 runtimeId/generation/pageId。
6. 一个项目多个目标时显式选择，不能靠当前窗口、焦点或最近页面推断。纯操作 Scene 的 `call` 不切换 Mock；激活、reload、重连均不操作页面。
7. 按新请求的 mocked、requestRuleId/responseRuleId、响应内容及最终 UI 验证。动作 completed 仅代表步骤结束；业务测试以 passed 和本轮关联证据为准。

MCP 只读指南与 Prompts 无在线会话前提，入口为 `capabilities`、`overview.browserRuntime`、`http`、`ws`、`ui`、`workflow`。全部工具均有同名 Prompt。可执行 Scene 示例见 `resources/example.web-scenes.json`。

## 项目启动配置

工作台打开项目时会让 `.flutter-pilot/launch.json` 保持存在；首次创建会尽力生成可用的 Web profile 和现有 Dart Debug profile。也可直接手工编辑：

```json
{
  "version": 1,
  "selectedProfileId": "web-dev",
  "profiles": [
    {
      "id": "web-dev",
      "name": "Web · dev:pilot",
      "type": "web",
      "root": ".",
      "packageManager": "pnpm",
      "script": "dev:pilot",
      "args": [],
      "url": "http://localhost:3000/",
      "readyTimeoutMs": 120000
    },
    {
      "id": "flutter-ios",
      "name": "Flutter · iOS",
      "type": "flutter",
      "configuration": "App (local)",
      "deviceId": "simulator-device-id"
    }
  ]
}
```

- `web.root` 必须是工作区内普通相对目录；`script` 必须存在于该目录 `package.json`。
- Web 启动只调用固定 package manager 的 `run` 子命令，不经过 shell，不执行 launch.json 中任意可执行路径。
- Flutter `configuration` 必须来自当前工作区命名且唯一的 Dart Debug 启动配置；省略时要求当前只有一个可用配置。
- 侧栏和工作台会检查 Web `url` 的本机 TCP 端口。Flutter 从对应 Debug 配置的 `toolArgs` 读取固定的本机调试端口，支持 `--host-vmservice-port`、`--dds-port` 和旧版 `--vm-service-port`。端口 `0` 由系统动态分配，`--device-vmservice-port` 属于设备侧。
- 启动遇到端口冲突且能确认唯一监听进程时，点击「结束进程并重新启动」，核对弹窗里的地址、进程名和 PID。确认后，插件会重新核对进程身份，等端口释放后再运行原启动项。macOS 和 Linux 使用 `lsof` 查询监听进程，Windows 使用系统 PowerShell。查询失败或进程身份不明确时，启动卡片会保留端口冲突提示。
- 工作台「项目启动」会等待 Web URL 就绪，展示有界日志并支持停止；手动编辑后点击「重新读取」。

## 操作与测试

Web selector 使用 `{source:"web",testId:"submit"}` 或显式 `{source:"web",role:"button",name:"Submit"}`；frame 可用 `{testId:"checkout"}` 限定。缺失和重复目标明确失败，不退回坐标或任意 JavaScript。输入、点击、按键和滚动均通过真实浏览器输入；禁用、不可见、被遮挡控件不能触发业务回调。

`take_screenshot` 支持 `source:web, mode:screen/full_page`，返回 PNG；上限单边 16384、3200 万像素、PNG 12 MiB。Flutter 继续使用其 VM/设备截图和 Widget Key，Web DOM selector 不映射 Flutter Key。

Test Case v2 的 setup、主动作和 Mock 使用冻结快照。同一 Context 内测试、Scene action 与直接操作共享锁；其他 Context 和 Flutter 独立。setup 创建 WS 后才启用测试 WS，主流程用采集器源时钟建立观察窗口；HTTP 提取的 orderId 可以关联 WS 注入与最终 UI。HTTP 200 仍需业务 code 断言。

运行结果含 target、定义指纹、实际请求/规则/连接/消息和业务 ID；声明 `secret:true` 的参数逐层脱敏。结束先清理再发布终态；`cleanupPending` 时禁止新运行，`cancel_test_run` 重试清理，不重新提交。取消、超时和断线后的 uncertain 必须先核对业务结果，不自动重放。Worker 退出/Context 关闭后，当前会话保留最近最多 100 条断线运行报告，按原目标查询；IDE 重启不恢复旧运行。

## 网络与证书

托管 Context 使用直接 HTTP 拦截，首次显式导航前安装；与代理 Mock 分别选择，不叠加。真实 OPTIONS/CORS/TLS 规则仍执行，Service Worker 被阻止，HTTP cache 关闭。HTTP 正文快照上限 1 MiB，历史 1000 条/32 MiB；二进制、流式及超限正文透传，不能据截断内容判定完整业务数据。

WS/WSS 仅覆盖 Page 接入后的业务连接。支持文本方向匹配、优先级替换/丢弃、准确 connectionId 发送和本地 synthetic 注入。发送只表示投递，需另查业务确认；二进制及超过 256 KiB 内容只读，HMR socket 排除。消息历史 1000 条/16 MiB。

默认校验 TLS。测试私有 CA 可在首个 Context 显式传 `trustedCertificates` PEM；只写本轮私有 Chromium Profile，同 Worker Context 共享此明确范围，返回指纹。关闭 Worker 清理 Profile，不修改系统信任或用户浏览器。

手动浏览器代理使用实际监听端口与项目 CA，仅归属于 listener，不能识别具体 Page，也不支持 WS/UI/业务测试。缓存或 Service Worker 可能使流量不经过代理。详见 [MCP 指南](mcp.md)。

## 支持矩阵

| 范围                      | 当前范围与限制                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------ |
| macOS 本地 VS Code/Cursor | 保留原插件；本轮不自动安装或重载 IDE                                                 |
| Flutter Debug             | VM/Dio、Key actions、截图和原有设备能力；本轮独立 iOS 模拟器实测，Android/真机未复验 |
| HTML/React/Vue            | 托管 Chromium 真实 DOM、HTTP/WS、Scene actions 与业务测试夹具                        |
| HTTP/HTTPS                | 实际代理与托管直接拦截分别验证，CORS/预检/TLS 保留                                   |
| Flutter Web               | 仅浏览器网络接入范围；不承诺 Canvas/语义层 UI、Widget Key 或 VM 注入                 |
| SSR/Node 后台             | 不采集、不 Mock 非浏览器进程流量                                                     |
| 浏览器与系统              | 不附着日常 Profile/任意 CDP，不覆盖 Firefox/WebKit、移动浏览器、系统权限 UI          |
| 平台与部署                | 未扩展 Windows/Linux、SSH、容器或远程宿主；无独立 CI 服务                            |
| 多端业务                  | 各 run 固定单运行时，不提供跨端分布式事务编排                                        |

阶段结果与失败记录见 [路线图证据](roadmap/web-flutter-runtime/evidence/)。测试使用本地受控夹具，不能替代真实后端、资金、认证恢复或跨设备验收。

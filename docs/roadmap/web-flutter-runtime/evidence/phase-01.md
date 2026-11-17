# phase-01 验收报告

基线 v1；验收日期 2026-11-17；结果 passed。基础提交 `6d56366a221f4931df80cec63a17a3404d8068fa`。
本阶段为生产 Host/IPC 与兼容回归，不包含真实浏览器代理、真实 Flutter 设备或 Agent 模型验收。

## 源码与环境

未提交实现补丁 SHA-256：`c57d37a9931ca5d79f2a1c535eaaef9ab38f97d59f1b9d2b01ef269de4359b8e`。
文件：`docs/mcp.md`, `src/extension.ts`, `src/mcp/capabilities.ts`, `src/mcp/capability-prompts.ts`, `src/mcp/guide.ts`, `src/mcp/network.ts`, `src/mcp/prompts.ts`, `src/mcp/tools.ts`, `src/scene-controller.ts`, `tests/extension.test.ts`, `tests/mcp-guide.test.ts`, `tests/mcp-network.test.ts`, `tests/mcp-transport.test.ts`, `tests/scene-target-generation.test.ts`。
环境：macOS-26.6.2-arm64-arm-64bit；Node v26.8.1；Vitest 5.1.0；工作台 Chromium 使用本机 Chrome。
原始证据目录：`artifacts/web-flutter-runtime/phase-01/20261117-core/`。

## 固定条款

| 条款    | 结果   | 实际验证                                                                                                                                                       |
| ------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01-A01 | passed | runtime/targets.ts、network.ts 提供值类型身份、代次、能力和窄 Adapter；typecheck 通过，接口不引用 VM/浏览器对象。                                              |
| P01-A02 | passed | extension.test.ts 生产 Host + 认证 requestSession IPC：VM SQLite 哨兵 vm-sentinel 与代理 proxy-sentinel 分别查询列表和详情；工作台切换后来源一致；错误不回退。 |
| P01-A03 | passed | 同集成测试验证代理 proxy.start/stop、rules.sync 与状态一致，VM capture/mock 未被调用；deactivate 后仍采集。真实流量留 phase-02。                               |
| P01-A04 | passed | 独立 SceneStore/控制器隔离激活、规则与错误；原 UUID 多根目录测试隔离历史；runtime-targets 验证作用域；启动固定快照与设备租约。                                 |
| P01-A05 | passed | 真实 IPC 歧义/过期/断开反例；Scene await 与排队换代、测试获取锁期间换代和旧环境恢复反例，副作用计数确认无重放。                                                |
| P01-A06 | passed | project、scenes、workflow、testcases、automation 兼容回归；旧 sessionId/Key、Scene v2、设备锁与默认连接保持；扩展测试确认无浏览器准备。                        |
| P01-A07 | passed | guide/transport/network 验证 target schema、同名 Prompt、capabilities/overview 与离线说明；无会话发现不创建状态或启动进程。                                    |

## 命令与结果

- `npm run typecheck`：退出 0。
- 核心选择测试（tests.log 中保留完整命令）：10 文件、243 项通过，0 失败/跳过，退出 0。
- 兼容选择测试（compat.log 中保留完整命令）：7 文件、143 项通过，0 失败/跳过，退出 0。
- `npm run test:ui -- tests/ui/workbench.spec.ts tests/ui/scenes.spec.ts tests/ui/mcp.spec.ts`：76 项通过，0 失败/跳过，退出 0。合成工作台，不是业务浏览器。
- `npm run build`、相关源码/测试 `prettier --check`、`git diff --check`：退出 0。

日志 SHA-256：

- `tests.log`：`6599c570800d68316b39db30faa493621f217cefa6f8930baa6256a45597b9b2`。
- `compat.log`：`430c2979a7e4014d971c08fe04a0fda8e116f5ba10ec81c6b01346a300d9c0d3`。
- `ui.log`：`61f7225aa4d28db40a3453d25a98b4fc96b0af70c66fc79e62b5d7be34ef4d33`。
- `build.log`：`d425d2e206f5c4119a2750b71c61eec93793eeebac44911fc7b0b02b6a1f9c11`。
- `format.log`：`17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20`。

## 清理与移交

测试自行清理临时项目、SQLite、IPC 服务和工作台浏览器；未启动业务 App，未修改系统代理或证书，未安装/发布/推送扩展。下一阶段 phase-02；真实 HTTP/HTTPS、CORS 和流量归属继续验证。

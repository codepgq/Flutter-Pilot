# phase-02：Web 项目与代理 HTTP Mock

依赖：phase-01 passed。目标：G03、G08、G09。验收基线：v1。

## 阶段目标

普通 Web 项目通过显式代理接入，在浏览器手动操作后，工作台和 MCP 均能查询真实请求及 Scene Mock 命中。此阶段不交付网页自动操作、WS Mock 或 Web Test Runner。

## 任务与产出

- [ ] P02-T01：支持显式 Web 接入、已知前端项目声明识别、混合仓库子项目选择和相应扩展激活。
- [ ] P02-T02：提供代理地址、实际监听端口、证书与连接诊断；保持项目 UUID、Scene v2 和旧项目兼容。
- [ ] P02-T03：补齐代理模式 MCP 查询/状态/开关端到端路径，明确流量归属和 browser/server 范围。
- [ ] P02-T04：建立本地 HTTP/HTTPS、跨域和独立 Chromium 夹具，新增 `test:web:proxy`。
- [ ] P02-T05：同步工作台入口、MCP 离线说明、场景 Prompt 与验收证据。

主要落点：`package.json`、`src/discovery.ts`、`src/project.ts`、工作台连接页、Proxy Adapter、`proxy/` 及夹具。

## 固定验收标准

| ID      | 必需预期                                                                                                                                   | 验证方式                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| P02-A01 | 原生 HTML 显式 URL、React/Vite、Vue/Vite 夹具可接入；仅有普通 Node package.json 不被误认；混合仓库可明确选子项目                           | 发现单元、扩展集成、工作台 UI                        |
| P02-A02 | 无 pubspec 的 Web 工作区可初始化并开启同一 MCP；查询说明不下载/启动引擎；首次代理准备为显式操作                                            | 扩展激活与离线协议回归                               |
| P02-A03 | 真实 Chromium 的 fetch 与 XHR 经代理请求本地 HTTP 和 HTTPS，分别验证正常转发、Mock 成功/失败、请求/响应修改及取消激活                      | test:web:proxy；Mock 时上游计数为零                  |
| P02-A04 | 跨域带凭据的正常请求与 OPTIONS 预检可在明确 CORS 响应配置下被页面读取；错误 CORS 仍失败并可诊断；HTTPS 使用真实信任的夹具 CA               | 浏览器结果、预检记录及 TLS 信任证据；不关闭 Web 安全 |
| P02-A05 | 每轮新请求在工作台与 MCP 具有相同 method/path/status、mocked、ruleId 和详情；禁用采集/Mock、重连及重载行为与声明一致                       | 请求 ID/基线与 UI/stdio 对照                         |
| P02-A06 | 两个项目使用相同接口路径时不串规则/历史；端口占用返回实际可用端口；浏览器代理在测试结束恢复，无更改用户系统代理或全局证书                  | 双引擎、端口冲突、清理核对                           |
| P02-A07 | 指南明确“手动浏览器＋HTTP 代理”的范围、WS/UI 未支持、缓存/Service Worker/SSR 限制；随包 Scene 用生产 schema 装配，真实代理集成无缺引擎跳过 | 协议/示例校验、实际引擎回归和报告                    |

## 验证与移交

新增可运行 `test:web:proxy`；设置有效 `MITMDUMP` 跑真实 `test:proxy`，同时运行相关 project/discovery/extension/MCP 与连接页测试、typecheck、格式和 build。浏览器夹具不可通过自己返回 Mock 绕过生产代理。

交付 `evidence/phase-02.md`，记录 CA 信任方式、实际端口、所有上游计数及清理结果。通过即达到 M1；浏览器 Worker 尚未交付。

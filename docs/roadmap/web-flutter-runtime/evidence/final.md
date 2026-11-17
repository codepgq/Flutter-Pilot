# Flutter / Web 统一运行时最终验收

> 后续发布：2026-11-17 用户授权审核并发布 0.0.23，修复及本轮复验见 [发布验收记录](../../../validation.md)。下文为发布前七阶段验收快照，保留其版本、设备和未发布状态的历史事实。

2026-11-17，基线v1，七阶段/53条必需验收完成。基础提交 `efc65160703fdf44aef200751a2dd1dfbb5292df`，分支 `codex/web-flutter-unified-runtime`；实现保留为未提交修改，版本仍0.0.22，未发布或安装。源码补丁、文件清单与各命令原始日志哈希见 [phase-07](phase-07.md)。

## 最终目标映射

| 目标 | 实际结果                                                | 当前源码证据                                    |
| ---- | ------------------------------------------------------- | ----------------------------------------------- |
| G01  | 同一插件/MCP明确选择Flutter和Web，真实双端并存          | phase-01/03；P07-A01，双端10项                  |
| G02  | 扩展/MCP名称、UUID、目录v2和旧Flutter调用保留           | phase-01；P07-A02，全量852及真实MCP19           |
| G03  | React/Vue/Vite发现与显式HTML/子项目，真实HTTP/HTTPS代理 | phase-02；P07-A03，proxy34/Python51             |
| G04  | 私有依赖、独立Worker、首次导航前HTTP直接拦截            | phase-03；P07-A03/A05/A06，依赖5/HTTP31         |
| G05  | 稳定DOM/Frame选择、真实交互、截图、Scene复用            | phase-04；P07-A03，UI71/三框架stdio23           |
| G06  | WS/WSS双向记录、替换/丢弃、发送/注入和准确连接          | phase-05；P07-A03，浏览器WS22                   |
| G07  | Web Test v2本轮HTTP→WS→UI证据、失败/取消/清理           | phase-06；P07-A01/A04，业务29/双端/真实Agent    |
| G08  | 项目/运行时/Context状态隔离，Worker故障Flutter继续      | phase-01至06；P07-A01/A05，真实并发与SIGKILL    |
| G09  | 生产schema、同名Prompt、离线指南、能力导航一致          | 各阶段；P07-A04/A07，61工具69Prompts/最终协议55 |
| G10  | 浏览器、独立iOS、真实Codex及隔离VSIX验证和限制          | P07-A01至A08，完整日志/截图/哈希及测量          |

## 交付范围

新增托管Chromium与私有Playwright Worker、Web接入/目标、HTTP及WS路由、DOM操作/截图、Scene/Test适配与断线证据查询；补齐同一MCP的精确Flutter目标验证和运行时隔离。业务定义仍由Scene v2目录与tests.json v2保存，没有第二套配置库。用户指南见 [Web运行时](../../../web-runtime.md)。

最终验证：852单元/协议、108工作台、51真实代理测试；浏览器代理34、HTTP31、UI71、WS22、业务29、依赖5；三框架SDK23及真实Codex总35；双端10、Flutter MCP19、VM注入32、HTTP8、UI57、WS/WSS四类连接与25条消息。类型/格式/构建通过，无必需跳过。隔离包与源码构建一致，私有状态未入包；前后包体积、启动及内存测量见phase-07报告。

## 边界与恢复

本轮为macOS本地、Chromium HTML/React/Vue和独立iOS模拟器受控夹具。Android/真机未复验；不承诺SSR/Node后台、Flutter Web DOM/Canvas/Key、跨端分布式事务、接入前流量、日常Profile、其他浏览器或远程宿主。HTTP200、applied和action completed不能代替业务passed；Mock订单不等于真实后端交易。

自有模拟器已关闭删除，用户已有模拟器和App未改；临时Worker、Chromium、Profile、CA、端口、夹具与示例锁文件恢复。Agent配置未改，仅在本轮验收进程限定服务与工具。源码未提交、推送、发布或安装，活动IDE未重载。

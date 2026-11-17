# phase-04：Web UI、截图与 Scene actions

依赖：phase-03 passed。目标：G05、G08、G09。验收基线：v1。

## 阶段目标

以显式 Web 选择器和真实浏览器输入执行可复用动作，复用 Scene v2 的 targets/actions 与公共 call，生成视口和整页截图。

## 任务与产出

- [x] P04-T01：增加 Web selector 判别类型，支持 testId、显式 role/name 及 frame 范围；旧 Flutter Key 保持兼容。
- [x] P04-T02：实现 DOM 结构读取、定位、点击、输入、等待、滚动与明确键盘能力；失败不切换选择器或通道重放。
- [x] P04-T03：实现 Web 视口/整页截图、尺寸/容量限制和 MCP 图像返回，区分 Flutter 长图语义。
- [x] P04-T04：扩展 Scene 预检、编译和运行结果，支持 Web 目标、秘密参数与跨 Scene call。
- [x] P04-T05：新增 `test:web:ui` 与原生 HTML/React/Vue 夹具，补工作台、指南和示例。

主要落点：`src/automation/`、Web Adapter/Worker、`src/workflows/`、Scene schema、截图、MCP tools/prompts、随包示例。

## 固定验收标准

| ID      | 必需预期                                                                                                                                               | 验证方式                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| P04-A01 | Web target 可按 testId 或显式 role/name 在指定 frame 解析；重复、缺失、失效 frame 均给准确诊断，不回退文字/坐标；Flutter 字段与 Web 字段混用在预检拒绝 | 生产 schema/编译器及真实 DOM 反例 |
| P04-A02 | 原生 HTML、React、Vue 输入和点击触发页面真实事件与业务状态；禁用/遮挡目标不绕过，不直接执行组件回调或 force 点击                                       | test:web:ui，事件/提交计数        |
| P04-A03 | 等待 present/absent/visible/enabled/actionable 与文本状态由真实状态完成；超时有目标、条件和最后观测；滚动限于选定区域                                  | 状态变化、嵌套滚动和超时反例      |
| P04-A04 | 视口与整页 PNG 尺寸可校验、首尾内容完整，超过限额明确失败；MCP 返回有效图片，不误截 Flutter 或浏览器外系统界面                                         | 真实页面截图、像素尺寸、目视检查  |
| P04-A05 | 保存于 Scene v2 的 Web actions 可带参数及公共 call 执行，目标每步重新解析；运行来源不切换 Mock；secret 逐层脱敏，临时 ref 不可持久化                   | 生产装配/编译/运行与泄漏检查      |
| P04-A06 | 同 Context 操作与运行共用锁，运行期间修改环境被拒绝；页面关闭/取消/输入已发未确认时停止后续步骤，不自动二次提交                                        | 双调用竞态及提交计数              |
| P04-A07 | 相同旧 Flutter actions 展开步骤/参数与基线一致；Web 不支持设备动作和键盘能力时在首次副作用前明确拒绝，不为凑通用流程静默跳步                           | 展开比对、Flutter 回归和预检反例  |
| P04-A08 | 工作台可正确显示 Web 目标、动作/截图结果和失败位置；工具、同名/场景 Prompt、指南、capabilities 与示例生产 schema 一致                                  | UI spec、离线协议、示例编译       |

## 验证与移交

运行 `test:web:ui`、相关 browser HTTP、selector/workflows/scene/screenshot/协议回归，工作台宽窄屏及明暗主题，typecheck、格式和 build。截图至少目视核对一次真实产物，不能仅看接口返回成功。

交付 `evidence/phase-04.md`，包括完整动作展开、事件数、截图与限制。通过达到 M2；completed 仍不代表业务测试 passed。

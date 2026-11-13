# 可复用 Workflow

Workflow 将 Agent 已探索、验证过的操作保存成参数化流程。后续一次 `run_workflow` 即可由插件完成输入、点击和等待，省去每一步的模型判断及工具往返。

Mock Scene 继续只管理 HTTP/WS 环境。Workflow 只在明确启动时运行；激活 Scene、VM 重连或重开 IDE 都不会自动登录或再次下单。`completed` 仅代表保存的操作完成，不能据此声称业务测试通过。

## 从一次探索到重复运行

1. 读取 `get_usage_guide(topic="workflow")`，通过 `list_sessions` 选择当前项目。
2. 调用 `list_workflows` 获取 `files.workflows` 的准确绝对路径和已有流程。缺少文件时返回空列表，不会自动创建或覆盖文件。
3. 首次用快照和定位工具确认实际控件，在目标 App 中验证操作、起始页面和等待条件。将稳定选择器提取为命名目标，增量保存到该路径。
4. 再次 `list_workflows` 校验定义，使用 `run_workflow` 传入流程 ID 和字符串参数。
5. 保存返回的 `runId`，用 `get_workflow_run` 查看进度，必要时 `cancel_workflow_run`；后续复跑无需 Agent 再逐个寻找控件。

保存流程后不需要 `reload_rules`。`list_workflows` 和每次 `run_workflow` 都读取最新流程文件；`reload_rules` 仍只负责 Scene。已经开始的运行使用校验后的定义快照，不受文件中途编辑影响。

需要 Mock 时，在运行前独立完成 `reload_rules`、`activate_scene` 和运行时接入检查。Workflow 不隐式切换 Scene、热重启 App、跳过登录或清空数据。可以显式调用已保存的登录子流程；如果要求已登录，则在起点用等待条件核对实际账号。

## 文件与参数

文件位于项目 `.flutter-pilot/workflows.json`，完整示例见 [example.workflows.json](../resources/example.workflows.json)。**示例 Key 是占位名称，必须替换为 Agent 在实际 App 确认过的选择器。示例没有内置业务接口或真实账号。**

最小定义：

```json
{
  "version": 1,
  "workflows": [
    {
      "id": "fill_price",
      "name": "填写价格",
      "inputs": { "price": { "required": true } },
      "targets": { "priceInput": { "key": "order.price" } },
      "steps": [
        { "id": "fillPrice", "type": "enter_text", "target": "priceInput", "text": "${inputs.price}" }
      ]
    }
  ]
}
```

每个流程包含 `id`、`name`、`targets`、`steps`，`inputs` 可省略。流程 ID、目标名称及步骤 ID 使用字母或数字开头的字母、数字、`_`、`.`、`-`，最长 128 字符；每个流程内步骤 ID 唯一。输入名称使用字母开头的字母、数字和 `_`，最长 64 字符。

`inputs` 声明允许的字符串参数。`required:true` 要求运行时提供值，或由 `default` 提供默认字符串；`secret:true` 会在运行参数和返回的错误消息中脱敏，列表也不显示秘密默认值。不要将真实密码写入项目文件。输入框和 App 本身仍会接收到输入，`secret` 不代替 App 的数据保护。

模板只支持 `${inputs.name}`，可用于步骤文本、选择器字符串及子流程输入；不执行表达式、函数或脚本。price、quantity 等数值业务参数保留字符串，不经过浮点数转换。未声明的输入、缺少的必填参数和无值模板在执行任何 UI 动作前报错。

## 稳定目标与步骤

`targets` 的值沿用 UI 组合选择器：Key、文字、语义、Widget 类型、`ancestor`，或原生 `source:"device"`、`accessibilityId`、`resourceId` 等。保留 Key 的字符串或整数类型。

不允许保存快照 `ref`、坐标或控件对象。执行每一步时重新定位；找不到或匹配不唯一时直接停止，不静默换选择器或修补当前测试。列表项优先用包含业务标识的 Key 和祖先范围。

| `type`            | 必需字段               | 可选字段与行为                                                                |
| ----------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `tap`             | `id`、`target`         | `timeoutMs`；点击一次                                                         |
| `enter_text`      | `id`、`target`、`text` | `timeoutMs`；替换文本                                                         |
| `wait_for_widget` | `id`、`target`         | `state`、`text`、`timeoutMs`；有界等待                                        |
| `scroll`          | `id`、`target`         | `untilTarget`、`direction`、`distance`、`durationMs`、`maxSteps`、`timeoutMs` |
| `call`            | `id`、`workflowId`     | `inputs`；按顺序展开子流程                                                    |

等待状态为 `present`（默认）、`absent`、`visible`、`enabled`、`actionable`、`text_equals`、`text_contains` 或 `text_changed`；后三种要求 `text`。等待及动作超时沿用原子工具默认值，显式 `timeoutMs` 范围为 100–30,000 毫秒。不要用固定 sleep 替代业务条件。

`scroll.target` 指滚动容器，`untilTarget` 引用同一流程内需要滚动到的目标；`maxSteps` 上限 30。子流程使用自己的目标和输入，父流程通过 `call.inputs` 显式传参。循环引用、超过 16 层嵌套或展开超过 1,000 个动作会被拒绝。

单个文件最多 2 MiB、200 个流程、5,000 个定义步骤；每个流程最多 500 个定义步骤。目录和文件必须为普通本地目录和文件，不能使用符号链接。未知字段会报错，防止拼写错误被忽略。

## MCP 调用与运行记录

```json
{
  "sessionId": "<从 list_sessions 取得>",
  "workflowId": "submit_order",
  "inputs": { "price": "100.00", "quantity": "2" },
  "backend": "auto"
}
```

将上述参数传给 `run_workflow`。所有定义、输入、目标引用和展开后的原子动作参数预检通过后，返回 `runId`，由插件后台执行。MCP 启动调用返回、连接结束或客户端没有持续等待，都不会自动重放或取消运行。

`backend` 可为 `auto`（默认）、`flutter` 或 `device`。沿用现有路由：设备已连接时 `auto` 使用设备输入；原生/系统目标需要设备通道。窗口、前台、设备身份及命中等检查继续生效，不为提速跳过。单设备串行；流程执行期间外部 UI 操作被拒绝，进度查询与取消独立可用。

向 `get_workflow_run` 传 `{ "sessionId":"…", "runId":"…" }`，结果的 `run` 包括：

- 流程 ID、定义哈希、脱敏输入、后端和起止时间。
- 当前步骤以及展开后的子流程路径、目标、状态、耗时、错误码及 `uncertain`。
- 总耗时、动作/等待耗时和可用的定位/输入耗时。

等待耗时包含等待期间的控件查找，不能与定位耗时相加推算总耗时；Flutter 输入的分阶段时间来自运行时，总耗时另包含工具传输。

终态为 `completed`、`failed`、`cancelled` 或 `uncertain`。`completed` 不表示下单成功，更不表示真实服务端收到订单。当前会话最多保留最近 50 次运行；重开 IDE 后不恢复记录或自动继续执行。

`cancel_workflow_run` 只请求取消。插件等待当前原子动作结束后才释放资源，期间不能插入新流程。已经提交的订单、登录状态或服务端操作不回滚。confirm 超时、断线或取消后结果可能未确认；先检查页面与本次网络记录，不自动再次点击 confirm 或重跑整个流程。

## 下单与业务测试

示例的 `submit_order` 仅负责填写、核对确认内容和点击确认，成功、余额不足和业务拒绝可以复用同一操作流程。`login_and_submit_order` 演示显式调用登录子流程，并等待账号标识，不能只凭登录接口返回 token 判断 App 已登录。

Test Case 引用同一个 Workflow，组合临时 Scene、运行参数、本轮 HTTP/WS 观察、响应变量提取和 UI 断言；有状态 HTTP Mock 保持提交前后列表一致。需要验证 pending order 时，检查本次原始提交参数和响应 `orderId`，沿实际列表或 WS 链路等待同一订单，再核对 price、quantity 和 pending。不能只检查任意旧 pending。

使用 `list_tests`、`run_test`、`get_test_run` 和 `cancel_test_run` 管理业务测试；只有 `passed` 表示全部断言通过。事件在对应本轮 HTTP 断言成功后注入，测试结束恢复自身临时 Mock。完整格式与示例见 [业务测试指南](testing.md)。录制器、复杂分支和 CI 的 App 启动及数据隔离仍不提供。

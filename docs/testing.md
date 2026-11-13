# 复用 Workflow 的业务测试

Test Case 组合环境、操作和业务断言。Workflow 仍只负责登录、输入、点击、等待和滚动；同一个 `submit_order` 可以用于成功或余额不足测试。`run_workflow` 的 `completed` 表示操作完成，`run_test` 的 `passed` 才表示用例全部通过。

| 定义       | 保存位置                        | 职责                                     |
| ---------- | ------------------------------- | ---------------------------------------- |
| Mock Scene | `.flutter-pilot/scenes.json`    | HTTP/WS 数据条件与持久激活状态           |
| Workflow   | `.flutter-pilot/workflows.json` | 参数化操作、稳定选择器和子流程           |
| Test Case  | `.flutter-pilot/tests.json`     | 环境、前置流程、本轮 HTTP/WS/UI 关联断言 |
| Run        | 当前插件会话                    | 步骤、断言、耗时、失败证据及清理结果     |

Scene 激活、VM 重连及 IDE 重开不会执行 UI 或重跑测试。运行器使用当前已运行的 Debug App，单设备串行；不启动 App、清数据或替用户创建测试账号。

本版业务测试要求使用 VM 连接模式，以同一 Debug App 的本地记录完成网络关联。临时状态在同一个 Dart isolate 的 Dio 实例之间共享，跨 isolate 的状态编排暂不支持。

HTTP 环境先于 `setup` 应用。若登录等前置流程负责创建 WS 连接，运行器会在前置流程后重新发现目标连接，再启用相应 WS Mock 和开始主流程；事件投递前也会等待唯一的在线目标，但消息只投递一次。依赖 WS 的测试须在主流程前建立订阅。

本轮观察使用 App 的源时钟和独立内存窗口，不依赖历史列表分页或保留条数；旧的未完成请求不能跨越观察边界。观察最多保存 10,000 条、32 MiB，来源报告遗漏或窗口溢出会使测试失败。

清理失败会保留恢复信息，原运行仍报告失败或结果未确认。连接恢复后，可在“业务测试”点击“恢复测试环境”，或再次调用该运行的 `cancel_test_run` 仅重试环境清理；启动新测试也会先尝试恢复遗留环境。清理不会重放 UI、confirm 或 WS 事件。

## 保存与运行

1. `get_usage_guide(topic="workflow")` 读取离线指南，`list_sessions` 选择项目。
2. `list_workflows` 获取 `files.workflows`，首次探索并验证控件后保存流程。起始页面、目标账号和按钮可操作条件应明确；完整格式见 [Workflow 指南](workflows.md)。
3. `list_tests` 获取 `files.tests` 的准确绝对路径，使用 Agent 文件工具增量维护用例。缺文件返回空列表，不会写入默认测试或覆盖已有定义。
4. 再次 `list_tests` 校验定义，`run_test` 显式启动，保存返回的 `runId`。
5. `get_test_run` 查询终态和证据；需要停止时 `cancel_test_run`，继续查询直到资源释放与临时环境清理完成。

```json
{
  "sessionId": "从 list_sessions 获取",
  "testId": "order_pending",
  "inputs": { "price": "100.00", "quantity": "2" },
  "backend": "auto"
}
```

保存测试或流程无需 `reload_rules`；每次启动重读并预检定义，运行中的快照不受后续文件编辑影响。`reload_rules` 只负责 Scene。运行期间其他 UI 操作和环境修改会被拒绝，避免步骤之间插入动作。

## 用例结构

文件严格使用 `{ "version": 1, "tests": [...] }`。每个用例包含 `id`、`name`、`workflowId` 和至少一项 `expect` 业务断言；可配置 `inputs`、`setup`、`sceneId`、`mock`、`events` 和 `timeoutMs`。

完整示例见 [example.tests.json](../resources/example.tests.json)，与 [example.workflows.json](../resources/example.workflows.json) 配套，演示同一提交流程的 pending 成功和 HTTP 200 业务拒绝。**示例 Key、URL、JSON 字段和页面结构都是占位，必须依据实际 App 和协议调整。不要将示例当作已有业务能力。**

`inputs` 给主流程提供字符串默认参数，`run_test.inputs` 可以覆盖。price、quantity 始终作为字符串，不做浮点转换。测试模板只支持以下引用，不执行表达式或脚本：

| 模板              | 用途                                           |
| ----------------- | ---------------------------------------------- |
| `${inputs.price}` | 本轮解析后的输入                               |
| `${run.id}`       | 本轮唯一标识，可用作 Mock 订单 ID              |
| `${vars.orderId}` | 本轮 HTTP 响应提取的变量，供后续断言和事件使用 |

JSON Mock 正文和事件 `text` 仍保存为 JSON 字符串。执行时先解析 JSON，再绑定字符串值并重新序列化，参数包含引号、反斜线时仍保持合法 JSON。模板应放在 JSON 的字符串值内；不支持拼接任意代码或非 JSON 事件模板。

`setup` 显式引用前置流程，例如：`[{"workflowId":"login","inputs":{"username":"fixture@example.test","password":"${inputs.password}"}}]`。先在主流程声明并通过运行参数传入所需输入，避免把真实密码写入测试文件。登录流程应等待实际目标账号标识；Mock 响应带 token 不能证明 App 已登录。主流程开始前重新建立本轮网络基线，前置流程和旧历史不能替主流程满足断言。

## HTTP、WS 与 UI 关联

`expect.http` 按主流程开始后的请求观察。`match` 支持 `method`、`host`、`path`，至少指定一项；以实际方法、域名和路径缩小范围。`requestJson` 和 `responseJson` 都是 JSON Pointer 到预期值的字典：前者检查 App 原始请求正文，后者检查响应正文，`status` 与 `mocked` 另外断言 HTTP 状态和 Mock 命中。

```json
{
  "id": "createOrder",
  "match": { "method": "POST", "host": "api.example.test", "path": "/v1/orders" },
  "requestJson": { "/price": "${inputs.price}", "/quantity": "${inputs.quantity}" },
  "status": 200,
  "mocked": true,
  "responseJson": { "/data/orderId": "${run.id}" },
  "extract": { "orderId": "/response/body/data/orderId" },
  "timeoutMs": 15000
}
```

HTTP 断言 ID 唯一，`extract` 变量名不能重复；提取指针从包含 `request`、`response` 的记录视图开始，例如 `/response/body/data/orderId`。正文断言的指针从 JSON 正文本身开始，例如 `/price`；空指针表示整个值，`~0` 和 `~1` 分别转义 `~` 与 `/`。HTTP 200 中的业务错误应按协议断言 `code` 等字段。

`expect.ws` 可配置 `url`、`direction`、`json`、`contains`、`outcome`、`timeoutMs`，至少指定 URL、JSON 或文字条件。`json` 以有效消息正文的 JSON Pointer 为键；使用 `${vars.orderId}` 关联本轮订单。`outcome` 为 `original`、`replaced`、`dropped` 或 `synthetic`，模拟注入应明确断言 `synthetic`。

`expect.ui` 指定稳定 `selector`、`state` 和可选 `text`、`timeoutMs`、`stableForMs`。状态包括 `present`、`absent`、`visible`、`enabled`、`actionable`、`text_equals`、`text_contains`；文字断言必须提供 `text`。禁止临时 ref、坐标或保存控件对象。订单行应按 `${vars.orderId}` 限定祖先，再分别核对 price、quantity 和 pending，不能只查任意旧 pending。

## pending 的来源

| App 实际使用的链路   | 测试配置                                                               |
| -------------------- | ---------------------------------------------------------------------- |
| 下单响应直接更新列表 | 检查请求与响应，按响应订单 ID 断言 UI                                  |
| 下单后重新查询列表   | 使用状态一致的 Mock，或等待真实查询响应                                |
| WS 推送更新列表      | 建立本轮 WS 观察；模拟事件关联成功下单响应后注入，或等待真实服务端事件 |

`events` 每项包含 `id`、`after`、`url`、`text`。`after` 必须指向本例 HTTP 断言；只有该断言验证成功并提取变量后，运行器才向匹配 URL 的唯一已接入连接注入一次事件。缺连接、连接歧义或注入未确认会报告错误，不新建业务连接或自动重放。

```json
{
  "id": "pushPending",
  "after": "createOrder",
  "url": "wss://api.example.test/orders",
  "text": "{\"topic\":\"order.pending\",\"data\":{\"orderId\":\"${vars.orderId}\",\"status\":\"pending\"}}"
}
```

这能避免“没有正确下单请求却直接收到 pending”的假通过。全 Mock 加模拟事件验证客户端集成行为；若要验证真实服务端推送，则省略 `events`、等待真实 WS 消息并关联同一订单 ID。不能将模拟注入测试报告为真实前后端链路通过。

## 运行范围的有状态 Mock

`sceneId` 可以引用项目已有 Scene；省略时沿用当前激活场景。测试以临时内存覆盖应用，不改写持久激活 ID。`mock` 则声明本轮状态机：

```json
{
  "initialState": "empty",
  "states": [
    { "id": "empty", "httpRules": [] },
    { "id": "pending", "httpRules": [] }
  ]
}
```

每个状态的 `httpRules` 使用标准直接 HTTP `mock` 规则，可用 `nextState` 指向已有状态。不接受请求改写、响应改写、重定向或人工断点。运行时为规则和状态范围生成唯一标识，每轮从 `initialState` 开始；命中带 `nextState` 的规则时，在返回 Mock 响应前切换状态，App 立即刷新列表会读取新状态。

示例在 `empty` 状态返回空列表，创建订单后进入 `pending`，后续 GET 返回同一 `${run.id}` 订单；同时为重复 POST 返回明确拒绝响应。状态机只覆盖声明的匹配范围，其他接口仍遵循实际环境。按真实链路选择响应、列表或 WS 观察，不要求 App 不会发生的事件。

## 结果、取消与边界

| 结果        | 含义                                                          |
| ----------- | ------------------------------------------------------------- |
| `passed`    | 操作及本例全部断言通过                                        |
| `failed`    | 业务断言不满足；查看失败断言、错误码与证据                   |
| `error`     | 流程或环境执行失败，或临时环境清理失败；查看错误诊断         |
| `cancelled` | 取消后停止后续动作，查看已发生步骤和清理结果                  |
| `uncertain` | 动作可能已发出但结果未确认，需要核查页面与本轮记录            |

具体结果以 `get_test_run` 的状态、错误分类、断言和清理记录为准。测试超时、取消或断线不会自动再次点击 confirm、重发事件或重跑整个测试。定位失败直接停止；修复定义后应明确启动新一轮，不能沿用失败运行宣称通过。

结束后恢复自身临时 Scene、Mock 和采集状态；页面默认保留供继续调试。已经发生的登录、真实订单和注入事件不能当作自动回滚。清理失败会保留诊断，不能仅凭主流程完成报告通过。

运行记录有界保留在当前插件会话中，IDE 重开不恢复执行。当前没有手动录制器、复杂分支语言、另一套 Dart 测试生成系统，或 CI 的 App 启动、测试账号与数据隔离。真实设备和业务链路验证需单独报告，源码回归不能替代设备验收。

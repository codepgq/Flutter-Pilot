# Scene 操作

Scene 在 `.flutter-pilot/scenes.json` 中统一保存 HTTP/WS Mock、共享 `targets` 和多个命名 `actions`。可以只保存 Mock、只保存操作，或只保存 targets。文件仍使用 `version:1`，原有纯 Mock 场景继续有效。

Agent 首次探索并验证控件后保存稳定选择器；后续调用 `run_scene_action`，由插件顺序执行输入、点击、等待、滚动与子操作，无需再次逐个探索控件。激活、重载、重连或重开 IDE 都不会自动执行操作。`completed` 仅说明操作完成；业务通过应使用 Test Case 的 `passed`。

## 保存配置

通过 `get_network_status` 获取 `files.scenes` 的准确路径。增量编辑 Scene 后调用 `reload_rules` 更新加载快照；配置无效时保留上一份有效配置。所有操作只从此文件加载。插件停止读取或创建 `workflows.json`，不会迁移或删除用户原文件。

以下 Key 是格式示例，必须替换为在实际 App 验证过的选择器：

```json
{
  "version": 1,
  "activeSceneId": null,
  "scenes": [
    {
      "id": "insufficient_balance",
      "name": "余额不足",
      "httpRules": [],
      "wsRules": []
    },
    {
      "id": "common_operations",
      "name": "公共操作",
      "httpRules": [],
      "wsRules": [],
      "targets": {
        "price": { "key": "order.price" },
        "submit": { "key": "order.submit" }
      },
      "actions": [
        {
          "id": "submit_order",
          "name": "提交订单",
          "description": "起始页面为下单页；点击一次提交。",
          "inputs": { "price": { "required": true } },
          "steps": [
            { "id": "price", "type": "enter_text", "target": "price", "text": "${inputs.price}" },
            { "id": "submit", "type": "tap", "target": "submit" }
          ]
        },
        {
          "id": "submit_default",
          "name": "提交默认价格",
          "steps": [
            { "id": "submit", "type": "call", "actionId": "submit_order", "inputs": { "price": "100.00" } }
          ]
        }
      ]
    }
  ]
}
```

完整登录、订单确认和同 Scene 调用示例见 [example.scenes.json](../resources/example.scenes.json)。`targets` 归 Scene 共享，每个操作只绑定实际使用的 targets，避免不同操作的参数相互影响。输入定义支持 `required`、字符串 `default` 和 `secret`；运行输入必须是字符串，金额与数量不转浮点数。秘密参数在运行记录中脱敏。

| 步骤              | 必填字段              | 可选字段                                                       |
| ----------------- | --------------------- | -------------------------------------------------------------- |
| `tap`             | `id,type,target`      | `timeoutMs`                                                    |
| `enter_text`      | `id,type,target,text` | `timeoutMs`                                                    |
| `wait_for_widget` | `id,type,target`      | `state,text,timeoutMs`                                         |
| `scroll`          | `id,type,target`      | `untilTarget,direction,distance,durationMs,maxSteps,timeoutMs` |
| `call`            | `id,type,actionId`    | `sceneId,inputs`                                               |

`call.sceneId` 省略时引用当前 Scene；跨 Scene 引用 `{id:"submit",type:"call",sceneId:"common_operations",actionId:"submit_order",inputs:{price:"${inputs.price}"}}` 只复用操作，不切换 Mock。参数必须显式映射。定位支持稳定 Key、文字、语义、类型及祖先范围，原生目标可显式指定 `source:device`；不能持久保存快照 ref、坐标或任意脚本。

每操作最多 500 步、整个文件最多 5000 定义步骤，嵌套最多 16 层，一次展开最多 1000 原子动作；`timeoutMs` 为 100..30000，滚动 `maxSteps` 为 1..30。预检拒绝未知目标、缺失参数、无效引用、循环及超限，在 UI 动作前完成校验。

## 发现和执行

1. `list_sessions` 选择项目，`list_scenes` 查看 Mock 与操作概要。
2. `list_scene_actions({sessionId,sceneId})` 查看指定 Scene 的 targets、操作说明和参数，无需读取完整 Mock 正文。
3. 按任务决定是否先 `activate_scene` 激活 Mock；操作来源 Scene 可以是其他公共 Scene，也允许未激活 Mock 时执行纯操作。
4. 显式调用 `run_scene_action`，保存返回的 `runId`。
5. `get_scene_action_run` 查询进度、耗时和终态，`cancel_scene_action_run` 请求取消。

```json
{
  "sessionId": "从 list_sessions 获取",
  "sceneId": "common_operations",
  "actionId": "submit_order",
  "inputs": { "price": "100.00" },
  "backend": "auto"
}
```

操作始终使用已加载配置快照，不隐式激活或切换 Mock。Agent 查看 HTTP/WS 状态并决定调用时机；运行器不强制等待所有网络域就绪，因为操作可能负责建立连接。运行记录同时保存操作来源 `sceneId/actionId` 和实际激活的 `mockSceneId`。

MCP 启动调用返回或连接结束后，后台运行继续。单设备串行，普通操作与 Test Case 共享设备锁；运行期间拒绝其他 UI 动作和环境修改。失败即停，不更换选择器或输入通道重放。结束保留当前 Mock。

取消只停止后续动作，等待当前动作结束后释放资源；已提交的订单或登录不能回滚。`uncertain` 表示结果未确认，应先检查页面及新网络记录，不自动再次点击 confirm 或重跑。运行记录有界保留在当前插件会话，IDE 重开不恢复执行。

工作台在 Scene 详情中提供操作选择、说明、参数、执行通道、运行进度和取消，同时显示操作来源与当前 Mock；“打开场景配置”可编辑文件。本版不提供可视化步骤编辑器。业务验证见 [测试指南](testing.md)。

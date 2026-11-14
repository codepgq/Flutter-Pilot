/** Same-name MCP prompts keep authoring separate from deterministic execution. */
export const sceneActionPromptPlans = {
  list_scene_actions: {
    topics: ['workflow'],
    steps: [
      '调用 list_scene_actions 取得指定 sceneId 的共享 targets、命名操作 actionId、说明及参数。优先按起始页和参数复用现有操作；只读查询不会开启 Mock 或连接 VM。',
      'steps[].target 引用 targets 中的别名，执行器自动解析为真实 Widget Key 并匹配当前已挂载控件，无需每步额外 find_widget 或截图。仅缺少操作或定义失效时探索；任务允许改源码时补稳定 Key 并复验，禁止临时 ref 和坐标。',
      '只在 scenes.json 增量保存 targets/actions，保留其他场景；公共步骤归档为纯操作 Scene，业务入口通过 call 和显式 inputs 复用。说明列起始页、账号、参数和预期终点，归档文档只索引 sceneId/actionId。保存后 reload_rules，再次 list_scene_actions 确认。',
    ],
  },
  run_scene_action: {
    topics: ['workflow', 'ui'],
    steps: [
      '先 list_sessions 确认项目和设备并复用已有 App；未运行时按已保存配置 start_app，TIMEOUT 先查会话不重复启动。list_scene_actions 选择已有流程，核对输入、起始页、登录账号和通道。需要 Mock 时另行 reload_rules、activate_scene 并检查相关域与 Dio 接入，不等待无关域；操作来源 Scene 与当前 Mock 可不同，不隐式切换环境。',
      '记录触发前的请求/消息基线，传 sceneId、actionId、字符串 inputs 和可选 backend。全部步骤及子流程预检后返回 runId，插件自动按 targets 的真实 Key 每步重新定位和执行，无需每步 find_widget、整页快照或模型判断；输入后 hide_keyboard 确认键盘稳定收起再继续。',
      '使用 get_scene_action_run 查询直到终态；单次 MCP 调用返回后流程继续运行。WORKFLOW_BUSY 时查询已有运行，不能插入点击、输入或热重启。需要停止时 cancel_scene_action_run。',
      'completed 仅代表操作完成；独立确认最终 UI、基线后的新网络记录及后台初始化，检查 mocked、规则 ID、401/刷新循环。有意 Mock 503 退避和启动首请求注入窗口须单独说明。失败时按 step/path/target 修复，uncertain 先查结果，不自动重试 confirm、下单或整个流程；不清数据或更换账号来掩盖失败。',
    ],
  },
  get_scene_action_run: {
    topics: ['workflow'],
    steps: [
      '使用 run_scene_action 返回的真实 runId 查询；不要猜测 ID 或为查询结果重新启动流程。查看当前步骤、定位/输入/等待等耗时和失败目标。',
      '等待失败时查看 failure.diagnostics 的 selector、condition、timeoutMs、attempts 和 lastObservation，区分 NOT_FOUND 与已找到但不可见、禁用、不可操作或文字条件不满足。先核对起始页面和登录前提；有 401 时检查本轮 Mock 命中，不以延长超时或重跑掩盖问题。旧记录无 diagnostics 时明确证据不足，不用当前配置冒充运行快照。',
      '运行只在当前插件会话内保留，重连不重新执行，IDE 重开后不恢复。completed 不等于测试 passed；failed、cancelled 或 uncertain 时结合界面与新网络记录报告已经发生和未确认的结果。',
    ],
  },
  cancel_scene_action_run: {
    topics: ['workflow'],
    steps: [
      '使用真实 runId 调用 cancel_scene_action_run，再用 get_scene_action_run 检查终态和资源释放。执行器等待当前动作结束，取消不会回滚已经登录、提交或生成的订单。',
      '动作可能已经发出；uncertain 时先检查当前页面和本次网络记录，不自动重试有副作用的步骤。终态前不要启动另一个流程或插入 UI 操作。',
    ],
  },
} as const;

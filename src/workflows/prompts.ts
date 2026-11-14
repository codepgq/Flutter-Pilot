/** Same-name MCP prompts keep authoring separate from deterministic execution. */
export const sceneActionPromptPlans = {
  list_scene_actions: {
    topics: ['workflow'],
    steps: [
      '调用 list_scene_actions 取得指定 sceneId 的共享 targets、命名操作 actionId、说明及参数。只读查询不会开启 Mock 或连接 VM。',
      '首次由 Agent 探索并验证界面操作，再增量保存到 scenes.json 的 targets/actions；保留其他场景。保存后 reload_rules。目标保存稳定 Key、祖先或明确语义，禁止临时 ref 和坐标。文件格式见 workflow 指南，重载后再次 list_scene_actions 校验。',
    ],
  },
  run_scene_action: {
    topics: ['workflow', 'ui'],
    steps: [
      '先 list_scene_actions 选择已有流程，确认输入、起始页面、登录账号和所需运行时能力。需要 Mock 时另行 reload_rules、activate_scene 并确认接入；操作来源 Scene 不必是当前激活的 Mock Scene，执行操作不会自动切换 Mock、热重启或登录。',
      '向 run_scene_action 传 sceneId、actionId、字符串 inputs 和可选 backend。全部步骤及子流程预检后返回 runId，后续由插件顺序执行，不为每步另取整页快照或重新调用模型。',
      '使用 get_scene_action_run 查询直到终态；单次 MCP 调用返回后流程继续运行。WORKFLOW_BUSY 时查询已有运行，不能插入点击、输入或热重启。需要停止时 cancel_scene_action_run。',
      'completed 仅代表操作完成；按任务另查本次网络记录和业务结果。失败时根据 step/path/target 修复定义，uncertain 时先检查结果，不自动重试 confirm、下单或整个流程。',
    ],
  },
  get_scene_action_run: {
    topics: ['workflow'],
    steps: [
      '使用 run_scene_action 返回的真实 runId 查询；不要猜测 ID 或为查询结果重新启动流程。查看当前步骤、定位/输入/等待等耗时和失败目标。',
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

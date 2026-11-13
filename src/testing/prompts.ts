/** Same-name prompts describe test authoring, execution and evidence boundaries. */
export const testPromptPlans = {
  list_tests: {
    topics: ['workflow'],
    steps: [
      '调用 list_tests 读取测试 ID、流程引用及 files.tests 准确路径；list_workflows 确认复用流程。缺文件返回空列表，由 Agent 文件工具增量保存，保留其他定义。',
      '根据实际 API、WS 协议和控件编写测试。Scene 管环境，Workflow 管动作，Test Case 管本轮关联断言；格式见 workflow 指南，示例 Key、URL 和字段不能直接当作真实协议。',
    ],
  },
  run_test: {
    topics: ['workflow', 'http', 'ws', 'ui'],
    steps: [
      '先 list_tests 选择已保存用例，list_workflows 核对参数、明确起始页面和登录账号。需要登录时显式配置 setup 流程并验证目标账号，不能把 Mock token 等同 App 已登录。',
      '调用 run_test 传 testId、字符串 inputs 和可选 backend。运行器在触发主流程前建立网络观察基线，持有操作权；临时 Scene 和有状态 Mock 不写入持久激活状态，结束恢复自身环境。',
      '保存 runId，使用 get_test_run 查询终态。事件必须等待指定本轮 HTTP 断言成功再注入，以同一 orderId 关联响应、WS 和订单行；仅存在 pending 或收到工具成功返回不能算通过。',
      '只有 passed 才报告测试通过，同时说明 Mock/真实后端范围。failed、环境错误、cancelled 或 uncertain 逐项报告证据和清理结果；不修改失败步骤后继续沿用原结论，不自动重试提交、注入或整个测试。',
    ],
  },
  get_test_run: {
    topics: ['workflow'],
    steps: [
      '使用 run_test 返回的真实 runId 查询进度、流程步骤、HTTP/WS/UI 断言与证据。查询不会执行或恢复步骤，不为获取结果重新启动测试。',
      '区分操作 completed 与测试 passed；检查原始请求参数、本轮响应提取的订单 ID、同一订单事件及精确订单行，说明失败或未确认位置与清理结果。结果未确认时先检查页面和新网络记录，不自动重试有副作用的动作。',
    ],
  },
  cancel_test_run: {
    topics: ['workflow'],
    steps: [
      '使用真实 runId 调用 cancel_test_run，随后 get_test_run 等待终态及临时 Mock 清理。当前动作可能已经发出，取消不能回滚登录、真实订单或注入事件。',
      '终态前不要插入 UI 操作或启动另一个运行；uncertain 表示结果未确认，先检查当前页面和本轮记录，不自动重试 confirm、事件或整个用例。',
    ],
  },
} as const;

import { z } from 'zod';

const session = { sessionId: z.string().min(1).max(256) };
const run = { ...session, runId: z.string().min(1).max(128) };
const inputs = z
  .record(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    z.string().max(16384),
  )
  .refine((value) => Object.keys(value).length <= 64, '测试参数最多 64 个。');

/** Test definitions are project files; execution always starts explicitly. */
export const testMcpTools = {
  list_tests: {
    description:
      '读取项目 Test Case、关联流程及 files.tests 路径；离线也可查询定义。测试组合 Workflow、临时 Mock 和本轮 HTTP/WS/UI 断言；保存或重连不会执行 UI。',
    schema: z.object(session).strict(),
  },
  run_test: {
    description:
      '校验并显式启动保存的 Test Case，立即返回 runId。后台准备临时环境、建立本轮网络基线、执行 Workflow 并验证关联断言；用 get_test_run 查询，只有 passed 表示测试通过。超时不自动重放提交或事件。',
    schema: z
      .object({
        ...session,
        testId: z.string().min(1).max(128),
        inputs: inputs.optional(),
        backend: z.enum(['auto', 'flutter', 'device']).optional(),
      })
      .strict(),
  },
  get_test_run: {
    description:
      '查询本会话 Test Run 的步骤、HTTP/WS/UI 断言、证据、耗时和清理结果，不执行或恢复动作。区分 passed、断言失败、环境错误、取消与结果未确认；不会把旧记录或任意 pending 当作本轮成功。',
    schema: z.object(run).strict(),
  },
  cancel_test_run: {
    description:
      '请求取消指定 Test Run，停止后续动作并清理自身临时 Mock，查询 get_test_run 确认终态。已经发生的登录、订单或注入事件不能回滚；结果未确认时不自动重试 confirm 或整个测试。',
    schema: z.object(run).strict(),
  },
} as const;

export const testToolNames = new Set(Object.keys(testMcpTools));

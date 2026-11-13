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
  .refine((value) => Object.keys(value).length <= 64, '流程参数最多 64 个。');

/** Workflow definitions remain project files; these tools only discover and run them. */
export const workflowMcpTools = {
  list_workflows: {
    description:
      '读取项目可复用流程、参数及 files.workflows 路径；VM 离线也可查询。Agent 首次探索后保存稳定选择器和步骤，后续 run_workflow 无需逐步模型判断。',
    schema: z.object(session).strict(),
  },
  run_workflow: {
    description:
      '校验并显式启动保存的参数化流程，立即返回 runId，插件在后台串行执行。用 get_workflow_run 查询；返回 completed 只代表操作完成。超时或结果未确认不自动重跑。',
    schema: z
      .object({
        ...session,
        workflowId: z.string().min(1).max(128),
        inputs: inputs.optional(),
        backend: z.enum(['auto', 'flutter', 'device']).optional(),
      })
      .strict(),
  },
  get_workflow_run: {
    description:
      '查询本会话 Workflow 的进度、步骤耗时与失败位置，不执行或恢复步骤。终态 completed 不是测试通过；IDE 重开不恢复运行，结果未确认时先检查界面和新网络记录。',
    schema: z.object(run).strict(),
  },
  cancel_workflow_run: {
    description:
      '请求取消指定 Workflow；后台等待当前动作结束后释放运行资源，已发生的业务操作不回滚。取消后查询状态，uncertain 表示结果未确认，不自动再次点击或重跑。',
    schema: z.object(run).strict(),
  },
} as const;

export const workflowToolNames = new Set(Object.keys(workflowMcpTools));

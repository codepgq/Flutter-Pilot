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

/** Scene-owned actions are discovered and explicitly run without changing Mock selection. */
export const sceneActionMcpTools = {
  list_scene_actions: {
    description:
      '读取指定 Scene 的共享 targets、命名操作、起始前提及参数；VM 离线也可查询。优先复用已有操作，target 自动解析真实 Key，无需逐步截图或 find_widget；仅缺少操作时探索并归档到 scenes.json。',
    schema: z.object({ ...session, sceneId: z.string().min(1).max(128) }).strict(),
  },
  run_scene_action: {
    description:
      '显式启动指定 Scene 的命名操作，不切换当前 Mock；公共操作可跨场景复用。立即返回 runId，插件在后台串行执行。用 get_scene_action_run 查询；返回 completed 只代表操作完成。超时或结果未确认不自动重跑。',
    schema: z
      .object({
        ...session,
        sceneId: z.string().min(1).max(128),
        actionId: z.string().min(1).max(128),
        inputs: inputs.optional(),
        backend: z.enum(['auto', 'flutter', 'device']).optional(),
      })
      .strict(),
  },
  get_scene_action_run: {
    description:
      '查询本会话 场景操作 的进度、步骤耗时与失败位置；等待失败的 failure.diagnostics 包含实际选择器、条件、期限和最后观测状态。不执行或恢复步骤。终态 completed 不是测试通过；IDE 重开不恢复运行，结果未确认时先检查界面和新网络记录。',
    schema: z.object(run).strict(),
  },
  cancel_scene_action_run: {
    description:
      '请求取消指定 场景操作；后台等待当前动作结束后释放运行资源，已发生的业务操作不回滚。取消后查询状态，uncertain 表示结果未确认，不自动再次点击或重跑。',
    schema: z.object(run).strict(),
  },
} as const;

export const sceneActionToolNames = new Set(Object.keys(sceneActionMcpTools));

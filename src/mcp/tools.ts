import { z } from 'zod';
import { guideTopics } from './guide';
import { automationMcpTools } from '../automation/tools';
import { sceneActionMcpTools } from '../workflows/tools';
import { testMcpTools } from '../testing/tools';

const session = { sessionId: z.string().min(1).max(256) };
const timeout = z.number().int().min(100).max(30000).optional();
const page = {
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(1000000).optional(),
};
const wsMessage = z
  .object({
    ...session,
    connectionId: z.string().min(1).max(512),
    text: z.string().max(262144).optional(),
    topic: z.string().min(1).max(1024).optional(),
    data: z.json().optional(),
  })
  .strict();

export function encodeWsMessage(args: Record<string, unknown>): string {
  const hasText = args.text !== undefined;
  const hasTopic = args.topic !== undefined;
  const hasData = args.data !== undefined;
  if (hasText ? hasTopic || hasData : !hasTopic || !hasData)
    throw new McpToolError('INVALID_ARGUMENTS', '消息须二选一：text 原始文本，或 topic 与 data。');
  const text = hasText ? (args.text as string) : JSON.stringify({ topic: args.topic, data: args.data });
  if (Buffer.byteLength(text, 'utf8') > 256 * 1024)
    throw new McpToolError('INVALID_ARGUMENTS', 'WS 消息序列化后最多 256 KiB。');
  return text;
}

export const mcpTools = {
  get_usage_guide: {
    description:
      '离线查阅功能与“用户任务→工具”路由。topic 为 overview/screenshot/http/ws/ui/workflow；截图看 screenshot/app_screenshot，已有操作看 workflow.quickRun，capabilities 查全部能力。涵盖 App 启动/热更新、API/WS Mock、Key、键盘、设备、Scene 和测试，无需 sessionId 或在线 IDE。',
    schema: z.object({ topic: z.enum(guideTopics).optional() }).strict(),
  },
  list_sessions: {
    description:
      '列出项目并选择任务对应 sessionId；检查 vmConnected、capabilities.appLaunch 的已有会话/设备和命名配置，优先复用已运行 App。VM 离线也能发现 Scene；启动超时先查询此处，不重复启动或操作无关项目。',
    schema: z.object({}).strict(),
  },
  start_app: {
    description:
      '显式启动当前项目已保存的 Dart Debug launch 配置，或复用同名现有会话，并等待 VM 连接。先从 list_sessions 的 capabilities.appLaunch.configurations 选择 configurationName；可选 deviceId 明确原生设备，不接受命令、启动参数或任意脚本。指定设备时只复用能确认同一设备的会话。启动不会执行 Scene 操作；检查网络状态后再 run_scene_action。超时可能仍在编译，先查询会话和 IDE，勿重复启动。',
    schema: z
      .object({
        ...session,
        configurationName: z.string().min(1).max(256),
        deviceId: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/)
          .refine((value) => !/^(chrome|edge|web-server)$/i.test(value))
          .optional(),
        timeoutMs: timeout,
      })
      .strict(),
  },
  hot_reload: {
    description:
      '通过当前 VM 绑定的 Cursor/VS Code Flutter Debug 会话热重载已保存源码，保留页面内存状态。仅 MCP 入口，无需终端；无法绑定 IDE 会话时返回诊断。Mock 文件修改先 reload_rules；完成后重新定位 UI 并检查新网络记录，超时勿自动重试。',
    schema: z.object({ ...session, timeoutMs: timeout }).strict(),
  },
  hot_restart: {
    description:
      '通过当前 VM 绑定的 Cursor/VS Code Flutter Debug 会话热重启，重置内存并重新执行入口。先 reload_rules 并激活所需场景；返回重启确认及网络状态，启动首请求可能早于 Mock 注入，需查新记录和 UI。旧 WS 连接及 UI 对象失效；超时勿自动重试。',
    schema: z.object({ ...session, timeoutMs: timeout }).strict(),
  },
  ...automationMcpTools,
  ...sceneActionMcpTools,
  ...testMcpTools,
  get_network_status: {
    description:
      '查询 files.scenes、当前 Mock 与分域接入状态；HTTP 查看 attachedDioInstances 和覆盖边界，只要求本流程所需域/客户端就绪。编辑后 reload_rules 并激活所需 Mock；applied 需以本轮新记录验证。',
    schema: z.object(session).strict(),
  },
  get_requests: {
    description: '分页查询已采集 HTTP 请求。',
    schema: z
      .object({
        ...session,
        ...page,
        search: z.string().max(1000).optional(),
        method: z.string().max(20).optional(),
        host: z.string().max(512).optional(),
        path: z.string().max(2000).optional(),
      })
      .strict(),
  },
  get_request: {
    description: '读取已采集 HTTP 请求详情。',
    schema: z.object({ ...session, id: z.string().min(1).max(512) }).strict(),
  },
  get_ws_connections: {
    description: '查询当前业务 WebSocket 连接。',
    schema: z.object(session).strict(),
  },
  get_ws_messages: {
    description: '分页查询已采集 WebSocket 消息。',
    schema: z
      .object({
        ...session,
        ...page,
        connectionId: z.string().max(512).optional(),
        direction: z.enum(['inbound', 'outbound']).optional(),
        search: z.string().max(1000).optional(),
        includeBodies: z.boolean().optional(),
      })
      .strict(),
  },
  inject_ws_message: {
    description:
      '向准确的业务 WS 连接注入一条模拟服务端消息供 App 接收，不发往服务端。需先开启 WS 采集并确认连接已接入；参数二选一：text 原始文本，或 topic 与 data（序列化为 {topic,data}）。自定义协议用 text，最多256 KiB；按 Key 验证界面并查询新消息，超时不自动重试。',
    schema: wsMessage,
  },
  send_ws_message: {
    description:
      '通过 App 当前准确的真实 WS 连接向服务端发送一条文本，不新建连接。需先开启 WS 采集并确认连接已接入；参数二选一：text，或 topic 与 data（序列化为 {topic,data}），最多256 KiB。经过 outbound 规则，可能替换或丢弃；返回仅表示已提交，需查新消息及业务响应，超时不自动重试。',
    schema: wsMessage,
  },
  reload_rules: {
    description:
      '整份读取并验证scenes.json，同步持久激活场景；无激活场景时不自动选择。检查loaded和status.scene.runtime，再用新记录验证命中。',
    schema: z.object(session).strict(),
  },
  set_capture_enabled: {
    description: '开启或关闭指定域采集；关闭同时暂停该域场景Mock，重新开启后恢复激活场景。',
    schema: z.object({ ...session, domain: z.enum(['http', 'ws']), enabled: z.boolean() }).strict(),
  },
  list_scenes: {
    description:
      '优先发现项目 Scene、HTTP/WS 规则数量、targets/actions 概要和当前 Mock；再 list_scene_actions 选择已有操作及参数，无需逐步探索或读取整份 Mock。VM 离线也可查询；定义仅来自 files.scenes。',
    schema: z.object(session).strict(),
  },
  activate_scene: {
    description:
      '持久激活指定场景，整体替换旧场景并开启所需HTTP/WS采集和Mock；离线待应用，重连和IDE重开自动恢复。检查分域状态并验证新记录，不把激活等同已命中。',
    schema: z.object({ ...session, sceneId: z.string().min(1).max(128) }).strict(),
  },
  deactivate_scene: {
    description: '清除持久激活状态，停用HTTP和WS Mock，保留采集；重连不再恢复场景。',
    schema: z.object(session).strict(),
  },
} as const;

export type McpToolName = keyof typeof mcpTools;

export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseTool(name: string, args: unknown): Record<string, unknown> {
  if (!Object.hasOwn(mcpTools, name)) throw new McpToolError('UNKNOWN_TOOL', '未知 MCP 工具。');
  const parsed = mcpTools[name as McpToolName].schema.safeParse(args);
  if (!parsed.success) throw new McpToolError('INVALID_ARGUMENTS', '工具参数不符合接口定义。');
  if (name === 'inject_ws_message' || name === 'send_ws_message') encodeWsMessage(parsed.data);
  return parsed.data;
}

export function toolError(error: unknown): { code: string; message: string } {
  return error instanceof McpToolError
    ? { code: error.code, message: error.message }
    : { code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : '操作失败。' };
}

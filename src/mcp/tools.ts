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
      '当需要编辑 scenes.json、Mock API/WS、操作Flutter UI、修复Key或热重载/热重启时，先读取本指南。topic为overview/http/ws/ui/workflow，热更新见workflow。无需sessionId或在线IDE。每个工具另有同名MCP Prompt可按需读取操作步骤。',
    schema: z.object({ topic: z.enum(guideTopics).optional() }).strict(),
  },
  list_sessions: {
    description:
      '需要Flutter Mock、UI操作或hot_reload/hot_restart时先get_usage_guide，再列出项目选择对应sessionId；检查vmConnected和capabilities.lifecycle等能力，不操作无关项目。',
    schema: z.object({}).strict(),
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
      '编辑Mock前获取files.scenes准确路径及开关状态；Agent读取并增量编辑文件，格式见get_usage_guide(topic=http/ws)，保存后reload_rules，再activate_scene统一开启所需Mock。',
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
      '列出项目场景ID、名称、HTTP/WS规则数量、targets/actions 概要及当前激活和运行时状态，VM离线也可查询。规则正文通过files.scenes读取。',
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

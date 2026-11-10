import { z } from 'zod';
import { guideTopics } from './guide';

const session = { sessionId: z.string().min(1).max(256) };
const key = z.union([z.string().min(1).max(512), z.number().int().safe()]);
const selector = { key, ancestorKey: key.optional() };
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
      '当需要编辑 rules.json/ws-rules.json、Mock API/WS、查找和操作Flutter UI或修复Key时，先读取本指南。包含字段说明、可复制示例和验证流程；topic为overview/http/ws/ui/workflow。无需sessionId或在线IDE。文件由Agent编辑，MCP负责重载和运行时操作。',
    schema: z.object({ topic: z.enum(guideTopics).optional() }).strict(),
  },
  list_sessions: {
    description:
      '需要Flutter Mock或UI操作时先get_usage_guide，再列出项目选择对应sessionId；不要操作无关项目。',
    schema: z.object({}).strict(),
  },
  get_ui_snapshot: {
    description:
      '不知道UI Key时先读取当前界面快照，从key/ancestorKeys发现目标，再find_widget确认唯一。详细流程见get_usage_guide(topic=ui)。',
    schema: z.object({ ...session, maxNodes: z.number().int().min(1).max(1000).optional() }).strict(),
  },
  find_widget: {
    description: '按 ValueKey<String/int> 精确定位；可用 ancestorKey 缩小范围；不使用文本回退。',
    schema: z.object({ ...session, ...selector }).strict(),
  },
  tap: {
    description: '按 Key 定位并通过实际命中测试点击。超时结果可能不确定，请勿自动重试。',
    schema: z.object({ ...session, ...selector, timeoutMs: timeout }).strict(),
  },
  enter_text: {
    description: '聚焦 Key 指定的输入目标，通过 Flutter 文本编辑链路替换文本。',
    schema: z.object({ ...session, ...selector, text: z.string().max(16384), timeoutMs: timeout }).strict(),
  },
  scroll: {
    description: '在 Key 指定区域通过 pointer 拖动滚动；可有界滚动直至 targetKey 出现。',
    schema: z
      .object({
        ...session,
        ...selector,
        direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        distance: z.number().min(1).max(2000).optional(),
        targetKey: key.optional(),
        maxSteps: z.number().int().min(1).max(30).optional(),
        timeoutMs: timeout,
      })
      .strict(),
  },
  wait_for_widget: {
    description: '有界等待 Key 目标出现、消失或可操作。未找到不代表缺少 Key。',
    schema: z
      .object({
        ...session,
        ...selector,
        state: z.enum(['present', 'absent', 'actionable']).optional(),
        timeoutMs: timeout,
      })
      .strict(),
  },
  inspect_key_issues: {
    description: '诊断当前已挂载交互目标缺少或不稳定 Key 的问题；非全项目静态审计。',
    schema: z.object({ ...session, maxNodes: z.number().int().min(1).max(1000).optional() }).strict(),
  },
  get_network_status: {
    description:
      '编辑Mock前获取files.http/files.ws准确路径及开关状态；Agent读取并增量编辑文件，格式见get_usage_guide(topic=http/ws)，保存后reload_rules。',
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
      '向准确的业务 WS 连接注入一条模拟服务端消息供 App 接收，不发往服务端。需先显式开启 WS 采集和 Mock；参数二选一：text 原始文本，或 topic 与 data（序列化为 {topic,data}）。自定义协议用 text，最多256 KiB；按 Key 验证界面并查询新消息，超时不自动重试。',
    schema: wsMessage,
  },
  send_ws_message: {
    description:
      '通过 App 当前准确的真实 WS 连接向服务端发送一条文本，不新建连接。需先显式开启 WS 采集和 Mock；参数二选一：text，或 topic 与 data（序列化为 {topic,data}），最多256 KiB。经过 outbound 规则，可能替换或丢弃；返回仅表示已提交，需查新消息及业务响应，超时不自动重试。',
    schema: wsMessage,
  },
  reload_rules: {
    description:
      'Agent编辑rules.json/ws-rules.json后必须调用，检查loaded/synchronized/runtimeApplied/pending；不自动开启Mock，仍需显式开关并触发请求验证。字段及示例见get_usage_guide。',
    schema: z.object({ ...session, domain: z.enum(['http', 'ws', 'all']).optional() }).strict(),
  },
  set_capture_enabled: {
    description: '显式开启或关闭指定域的采集，不自动开启 Mock。',
    schema: z.object({ ...session, domain: z.enum(['http', 'ws']), enabled: z.boolean() }).strict(),
  },
  set_mock_enabled: {
    description: '显式开启或关闭 Dio/WS Mock；规则内容继续通过项目文件维护。',
    schema: z.object({ ...session, domain: z.enum(['http', 'ws']), enabled: z.boolean() }).strict(),
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

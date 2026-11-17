import { z } from 'zod';
import { guideTopics } from './guide';
import { automationMcpTools } from '../automation/tools';
import { sceneActionMcpTools } from '../workflows/tools';
import { testMcpTools } from '../testing/tools';
import { RuntimeTargetError } from '../runtime/targets';
import { browserMcpTools, BrowserError } from '../browser/protocol';
import { webUiTools } from '../browser/ui-schema';

const session = { sessionId: z.string().min(1).max(256) };
const networkSession = {
  ...session,
  target: z
    .object({ runtimeId: z.string().min(1).max(256), generation: z.number().int().min(0) })
    .strict()
    .optional(),
};
const timeout = z.number().int().min(100).max(30000).optional();
const page = {
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(1000000).optional(),
};
const wsMessage = z
  .object({
    ...networkSession,
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
  ...browserMcpTools,
  get_usage_guide: {
    description:
      '离线查阅功能与“用户任务→工具”路由。topic 为 overview/screenshot/http/ws/ui/workflow；截图看 screenshot/app_screenshot，已有操作看 workflow.quickRun，capabilities 查全部能力。涵盖 App 启动/热更新、API/WS Mock、Key、键盘、设备、Scene 和测试，无需 sessionId 或在线 IDE。',
    schema: z.object({ topic: z.enum(guideTopics).optional() }).strict(),
  },
  list_sessions: {
    description:
      '列出项目并选择任务对应 sessionId 和 runtimeTargets 中的运行目标；网络工具可传 target:{runtimeId,generation}，多连接目标必须明确选择，不能用工作台焦点猜测。检查 vmConnected、capabilities.appLaunch 的已有会话/设备和命名配置，优先复用已运行 App。VM 离线也能发现 Scene；启动超时先查询此处，不重复启动或操作无关项目。',
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
  ...Object.fromEntries(
    Object.entries(webUiTools).map(([name, definition]) => [
      name,
      {
        description:
          automationMcpTools[name as keyof typeof automationMcpTools].description +
          ' Flutter 可选显式 target:{runtimeId,generation}；旧代次或 proxy UI 目标在执行前拒绝。 ' +
          definition.description,
        schema: z.union([
          automationMcpTools[name as keyof typeof automationMcpTools].schema,
          definition.schema,
        ]),
      },
    ]),
  ),
  get_network_status: {
    description:
      '查询指定运行目标的 storageVersion:2、files.scenes、当前 Mock 与分域接入状态；target 从 list_sessions.runtimeTargets 取得。Web 手动浏览器 HTTP 代理先按 http.webProxy 显式接入，端口/CA 见工作台连接与诊断，无页面身份或 WS/UI。Flutter HTTP 查看 attachedDioInstances。编辑后 reload_rules 并激活所需 Mock；applied 需以本轮新记录验证。',
    schema: z.object(networkSession).strict(),
  },
  get_requests: {
    description:
      '分页查询指定运行目标已采集 HTTP 请求；VM 与代理读取各自历史，与同目标工作台一致，查询失败不回退另一来源。多连接目标须传 target:{runtimeId,generation}。',
    schema: z
      .object({
        ...networkSession,
        ...page,
        search: z.string().max(1000).optional(),
        method: z.string().max(20).optional(),
        host: z.string().max(512).optional(),
        path: z.string().max(2000).optional(),
      })
      .strict(),
  },
  get_request: {
    description:
      '读取指定运行目标的 HTTP 请求详情；id 取自同一 target 的 get_requests，找不到或查询失败不回退其他历史库。',
    schema: z.object({ ...networkSession, id: z.string().min(1).max(512) }).strict(),
  },
  get_ws_connections: {
    description:
      '查询指定 Flutter 或托管浏览器运行目标的业务 WebSocket 连接；浏览器返回 Page 身份。代理目标不支持 WS，不切换到 VM。',
    schema: z.object(networkSession).strict(),
  },
  get_ws_messages: {
    description:
      '分页查询指定 Flutter 或托管浏览器运行目标已采集 WebSocket 消息；使用同目标 connectionId，代理目标不支持 WS。',
    schema: z
      .object({
        ...networkSession,
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
      '增量刷新 scenes/index.json v2 目录与资源摘要，仅装配当前激活场景；错误隔离并保留最后有效运行快照，stale 表示新配置未生效；无激活场景时不自动选择。检查loaded和status.scene.runtime，再用新记录验证命中。',
    schema: z.object(networkSession).strict(),
  },
  set_capture_enabled: {
    description:
      '开启或关闭指定运行目标的域采集；代理仅 HTTP，Flutter 与托管浏览器支持 HTTP/WS。关闭同时暂停该域场景 Mock，重新开启恢复该目标激活场景；失效代次或断开目标在副作用前拒绝。',
    schema: z.object({ ...networkSession, domain: z.enum(['http', 'ws']), enabled: z.boolean() }).strict(),
  },
  list_scenes: {
    description:
      '分页搜索项目 Scene 摘要，返回目录、清单路径、规则/操作数量、健康状态及当前 Mock，不读取正文。offset 默认0，limit 默认50且最多200；search 匹配名称、ID、规则与动作名称。再 list_scene_actions 查询独立 action 文件路径和参数。',
    schema: z
      .object({
        ...networkSession,
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        search: z.string().max(1000).optional(),
      })
      .strict(),
  },
  activate_scene: {
    description:
      '为指定运行目标持久激活场景，整体替换该目标旧场景并开启所需 HTTP/WS 采集和 Mock；离线待应用，重连和 IDE 重开恢复同目标，不影响其他目标。检查分域状态并验证新记录，不把激活等同已命中。',
    schema: z.object({ ...networkSession, sceneId: z.string().min(1).max(128) }).strict(),
  },
  deactivate_scene: {
    description: '清除指定运行目标的持久激活状态，停用该目标 HTTP 和 WS Mock，保留采集；重连不再恢复场景。',
    schema: z.object(networkSession).strict(),
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
  return error instanceof McpToolError || error instanceof RuntimeTargetError || error instanceof BrowserError
    ? { code: error.code, message: error.message }
    : { code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : '操作失败。' };
}

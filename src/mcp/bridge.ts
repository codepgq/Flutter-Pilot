import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { discoverSessions, requestSession, type SessionDescriptor } from './server';
import { mcpTools, McpToolError, parseTool, toolError } from './tools';

export interface BridgeOptions {
  registryRoot: string;
  workspace?: string;
}

/** MCP remains usable while the IDE is offline, so agents receive a useful diagnostic. */
export function createMcpBridge(options: BridgeOptions): { server: Server; close: () => Promise<void> } {
  const connectionId = randomUUID();
  const announced = new Map<string, SessionDescriptor>();
  const server = new Server(
    { name: 'flutter-api-mocks', version: '0.0.3' },
    {
      capabilities: { tools: {} },
      instructions:
        '先 list_sessions，再为每次操作指定 sessionId。UI 仅使用 ValueKey<String/int>，无文本回退。Mock 规则由项目 .api-mocks/rules.json 和 ws-rules.json 维护，编辑后 reload_rules 并显式开启对应 Mock。UI 超时不应自动重试。',
    },
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  const announce = async (descriptor: SessionDescriptor, event: 'connected' | 'disconnected') => {
    const info = server.getClientVersion();
    if (!info) return;
    await requestSession(descriptor, {
      kind: 'client',
      client: {
        name: info.name,
        version: info.version,
        scope: options.workspace ? 'project' : 'global',
        connectionId,
        event,
      },
    });
    if (event === 'connected') announced.set(descriptor.sessionId, descriptor);
  };
  const refreshClients = async () => {
    const descriptors = await discoverSessions(options.registryRoot, options.workspace);
    await Promise.allSettled(descriptors.map((d) => announce(d, 'connected')));
  };
  server.oninitialized = () => {
    void refreshClients().catch(() => undefined);
    timer = setInterval(() => void refreshClients().catch(() => undefined), 15000);
    timer.unref();
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(mcpTools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema) as { type: 'object'; properties?: Record<string, unknown> },
      annotations: {
        readOnlyHint: [
          'list_sessions',
          'get_ui_snapshot',
          'find_widget',
          'wait_for_widget',
          'inspect_key_issues',
          'get_network_status',
          'get_requests',
          'get_request',
          'get_ws_connections',
          'get_ws_messages',
        ].includes(name),
        openWorldHint: true,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = parseTool(request.params.name, request.params.arguments ?? {});
      const descriptors = await discoverSessions(options.registryRoot, options.workspace);
      let data: unknown;
      if (request.params.name === 'list_sessions') {
        const results = await Promise.allSettled(
          descriptors.map(async (descriptor) => {
            await announce(descriptor, 'connected');
            return requestSession(descriptor, { kind: 'describe' }, extra.signal);
          }),
        );
        const sessions = results
          .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
          .map((r) => r.value);
        data = {
          sessions,
          ...(!sessions.length
            ? { message: '没有可用的插件会话；请在 Cursor/VS Code 中打开项目并开启 MCP。' }
            : {}),
        };
      } else {
        const descriptor = descriptors.find((d) => d.sessionId === args.sessionId);
        if (!descriptor)
          throw new McpToolError('SESSION_UNAVAILABLE', '指定项目会话不可用或不在此 MCP 配置的范围内。');
        await announce(descriptor, 'connected');
        data = await requestSession(
          descriptor,
          { kind: 'call', tool: request.params.name, args },
          extra.signal,
        );
      }
      const result =
        data !== null && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : { result: data ?? null };
      const isError = result.ok === false || ('error' in result && result.error !== undefined);
      return {
        ...(isError ? { isError: true } : {}),
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const result = { error: toolError(error) };
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
  });
  const close = async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    await Promise.allSettled([...announced.values()].map((d) => announce(d, 'disconnected')));
    announced.clear();
    await server.close();
  };
  server.onclose = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    void Promise.allSettled([...announced.values()].map((d) => announce(d, 'disconnected')));
    announced.clear();
  };
  return { server, close };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let registryRoot: string | undefined;
  let workspace: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1] || !['--registry', '--workspace'].includes(args[i]))
      throw new Error('参数应为 --registry <绝对路径> [--workspace <绝对路径>]。');
    if (args[i] === '--registry') registryRoot = args[i + 1];
    else workspace = args[i + 1];
  }
  if (!registryRoot || !isAbsolute(registryRoot) || (workspace !== undefined && !isAbsolute(workspace)))
    throw new Error('MCP 注册目录和工作区必须为绝对路径。');
  const bridge = createMcpBridge({
    registryRoot: resolve(registryRoot),
    workspace: workspace && resolve(workspace),
  });
  const shutdown = () => void bridge.close().finally(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.stdin.once('end', shutdown);
  await bridge.server.connect(new StdioServerTransport());
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write('Flutter API Mocks MCP 无法启动，请检查配置和 Node.js 版本。\n');
    process.exitCode = 1;
  });
}

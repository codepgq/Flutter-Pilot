import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Socket } from 'node:net';
import { mkdtemp, chmod, mkdir, symlink, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from '../package.json';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  McpSessionServer,
  discoverSessions,
  pruneStaleSessions,
  requestSession,
  type McpClientInfo,
} from '../src/mcp/server';
import { mcpTools, parseTool } from '../src/mcp/tools';
import { agentInstructions, getUsageGuide, guideResources, guideTopics } from '../src/mcp/guide';

const roots: string[] = [];
const servers: McpSessionServer[] = [];
const clients: Client[] = [];
let bridgeFile: string;
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-build-'));
  roots.push(root);
  bridgeFile = join(root, 'bridge.cjs');
  await build({
    entryPoints: ['src/mcp/bridge.ts'],
    outfile: bridgeFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  for (const root of roots.slice(1)) await rm(root, { recursive: true, force: true });
  roots.splice(1);
});

async function fixture(
  workspaceName = 'project-a',
  call?: ConstructorParameters<typeof McpSessionServer>[0]['call'],
) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-fixture-'));
  roots.push(root);
  const registryRoot = join(root, 'sessions');
  const workspace = join(root, workspaceName);
  const events: McpClientInfo[] = [];
  const server = new McpSessionServer({
    registryRoot,
    workspace,
    name: workspaceName,
    sessionId: workspaceName,
    describe: () => ({ connected: true, rulesFiles: ['.flutter-pilot/rules.json'] }),
    call: call ?? (async (tool, args) => ({ tool, key: args.key ?? null })),
    onClient: (event) => events.push(event),
  });
  servers.push(server);
  await server.start();
  return {
    server,
    root,
    registryRoot,
    workspace,
    events,
    descriptor: (await discoverSessions(registryRoot))[0],
  };
}

async function connect(registryRoot: string, workspace?: string, name = 'codex-test-client') {
  const client = new Client({ name, version: '1.0.0' });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bridgeFile, '--registry', registryRoot, ...(workspace ? ['--workspace', workspace] : [])],
      stderr: 'pipe',
    }),
  );
  return client;
}

describe('MCP local session transport', () => {
  it.each([
    ['setup_automation', 660000, {}],
    ['connect_device', 240000, { deviceId: 'fixture-device', appId: 'dev.fixture' }],
  ] as const)('keeps %s alive beyond the initial host deadline', async (tool, timeout, args) => {
    const f = await fixture('long-operation', async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { ok: true, completed: true };
    });
    const deadlines: number[] = [];
    const original = Socket.prototype.setTimeout;
    // Scale only socket deadlines so this exercises real IPC past the old 45-second limit.
    const deadlineSpy = vi.spyOn(Socket.prototype, 'setTimeout').mockImplementation(function (
      this: Socket,
      milliseconds: number,
      callback?: () => void,
    ) {
      deadlines.push(milliseconds);
      return original.call(this, milliseconds >= 40000 ? milliseconds / 100 : milliseconds, callback);
    });
    try {
      await expect(
        requestSession(f.descriptor, {
          kind: 'call',
          tool,
          args: { sessionId: 'long-operation', ...args },
        }),
      ).resolves.toEqual({ ok: true, completed: true });
      expect(deadlines).toContain(timeout);
      expect(deadlines).toContain(timeout + 5000);
    } finally {
      deadlineSpy.mockRestore();
    }
  });

  it('discovers mobile actions, validates selectors, returns device PNG metadata and preserves uncertain errors over stdio', async () => {
    const calls: string[] = [];
    const f = await fixture('mobile', async (tool, args) => {
      calls.push(tool);
      if (tool === 'take_screenshot')
        return {
          ok: true,
          source: 'device',
          width: 400,
          height: 800,
          geometry: { orientation: 'PORTRAIT', rect: { x: 0, y: 0, width: 400, height: 800 } },
          image: { mimeType: 'image/png', data: 'aW1hZ2U=' },
        };
      if (tool === 'double_tap') return { ok: false, code: 'DEVICE_CONNECTION_FAILED', uncertain: true };
      return { ok: true, selector: args.selector };
    });
    const client = await connect(f.registryRoot, f.workspace);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      'setup_automation',
      'connect_device',
      'perform_gesture',
      'edit_text',
      'device_action',
      'hide_keyboard',
    ])
      expect(names).toContain(name);
    const screenshot = await client.callTool({
      name: 'take_screenshot',
      arguments: { sessionId: 'mobile', source: 'device', mode: 'screen' },
    });
    expect(screenshot.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' });
    expect(screenshot.structuredContent).toMatchObject({
      source: 'device',
      width: 400,
      geometry: { orientation: 'PORTRAIT' },
    });
    const target = {
      sessionId: 'mobile',
      selector: { source: 'device', text: '允许', type: 'XCUIElementTypeButton' },
    };
    expect((await client.callTool({ name: 'tap', arguments: target })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'tap', arguments: { ...target, key: 'conflict' } })).isError).toBe(
      true,
    );
    expect(
      (await client.callTool({ name: 'double_tap', arguments: target })).structuredContent,
    ).toMatchObject({ uncertain: true, code: 'DEVICE_CONNECTION_FAILED' });
    expect(calls).toEqual(['take_screenshot', 'tap', 'double_tap']);
  });
  it.each(['missing', 'unsafe'] as const)(
    'discovers and reads usage guides over stdio with a %s registry and no IDE',
    async (registryState) => {
      const root = await mkdtemp(join(tmpdir(), 'mcp-offline-guide-'));
      roots.push(root);
      const registry = join(root, 'sessions');
      if (registryState === 'unsafe') await mkdir(registry, { mode: 0o755 });
      const client = await connect(registry);
      expect(client.getServerVersion()).toMatchObject({ name: 'flutter-pilot', version });
      expect(client.getInstructions()).toBe(agentInstructions);
      expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {}, prompts: {} });
      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
        'capabilities',
        'scene_action_quick_run',
        'scene_action_authoring',
        'http_mock',
        'websocket_mock',
        'flutter_ui',
        'mock_workflow',
        ...Object.keys(mcpTools),
      ]);
      for (const prompt of prompts.prompts) {
        const result = await client.getPrompt({ name: prompt.name, arguments: { task: '验证订单页面' } });
        expect(result.messages[0]).toMatchObject({ role: 'user', content: { type: 'text' } });
        expect(JSON.stringify(result)).toContain('验证订单页面');
        expect(JSON.stringify(result)).toContain('get_usage_guide');
        await expect(client.getPrompt({ name: prompt.name })).resolves.toHaveProperty('messages');
      }
      await expect(client.getPrompt({ name: 'unknown' })).rejects.toMatchObject({ code: -32602 });
      const capabilities = await client.getPrompt({ name: 'capabilities' });
      const capabilityText = JSON.stringify(capabilities);
      expect(capabilityText).not.toContain('尚未指定具体任务');
      for (const name of Object.keys(mcpTools)) expect(capabilityText).toContain(`- ${name}：`);
      await expect(client.getPrompt({ name: 'http_mock', arguments: { extra: 'x' } })).rejects.toMatchObject({
        code: -32602,
      });
      const tools = await client.listTools();
      for (const tool of tools.tools) {
        const prompt = await client.getPrompt({ name: tool.name, arguments: { task: '检查此工具的用法' } });
        expect(JSON.stringify(prompt)).toContain(`目标工具：${tool.name}`);
        expect(JSON.stringify(prompt)).toContain('检查此工具的用法');
        expect(prompts.prompts.some((item) => item.name === tool.name)).toBe(true);
      }
      expect(tools.tools.find((tool) => tool.name === 'get_usage_guide')).toMatchObject({
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: { properties: { topic: { enum: [...guideTopics] } } },
      });
      const overview = await client.callTool({ name: 'get_usage_guide', arguments: {} });
      expect(overview.isError).not.toBe(true);
      expect(overview.structuredContent).toEqual(getUsageGuide());
      expect((await client.listResources()).resources).toEqual(guideResources);
      for (const topic of guideTopics) {
        const result = await client.callTool({ name: 'get_usage_guide', arguments: { topic } });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(getUsageGuide(topic));
        const resource = await client.readResource({ uri: `flutter-pilot://guides/${topic}` });
        expect(resource.contents).toHaveLength(1);
        expect(resource.contents[0].mimeType).toBe('application/json');
        const content = resource.contents[0];
        if (!('text' in content)) throw new Error('指南必须以文本返回');
        expect(JSON.parse(content.text)).toEqual(result.structuredContent);
      }
      const invalid = await client.callTool({ name: 'get_usage_guide', arguments: { topic: 'unknown' } });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' } });
      await expect(client.readResource({ uri: 'file:///etc/passwd' })).rejects.toMatchObject({
        code: -32602,
      });
    },
  );

  it('serves guides locally without forwarding a runtime tool call', async () => {
    let calls = 0;
    const f = await fixture('guide', async () => {
      calls++;
      return {};
    });
    const client = await connect(f.registryRoot, f.workspace);
    await client.callTool({ name: 'get_usage_guide', arguments: { topic: 'http' } });
    await client.readResource({ uri: 'flutter-pilot://guides/ui' });
    await client.listPrompts();
    await client.getPrompt({ name: 'flutter_ui' });
    for (const name of ['capabilities', 'scene_action_quick_run', 'scene_action_authoring'])
      await client.getPrompt({ name });
    expect(calls).toBe(0);
    const list = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(list.structuredContent).toMatchObject({
      usageGuide: { tool: 'get_usage_guide', topics: [...guideTopics] },
    });
  });

  it('discovers and dispatches both WS message directions over real SDK stdio', async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const f = await fixture('ws-messages', async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true, submitted: true };
    });
    const client = await connect(f.registryRoot, f.workspace);
    const tools = (await client.listTools()).tools;
    for (const tool of ['inject_ws_message', 'send_ws_message']) {
      expect(tools.find((entry) => entry.name === tool)).toMatchObject({
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false },
      });
      const args = { sessionId: 'ws-messages', connectionId: 'exact', topic: 'assets', data: { amount: 9 } };
      expect((await client.callTool({ name: tool, arguments: args })).isError).not.toBe(true);
      expect(calls.at(-1)).toEqual({ tool, args });
      const invalid = await client.callTool({ name: tool, arguments: { ...args, text: 'conflicting' } });
      expect(invalid.isError).toBe(true);
    }
    expect(calls).toHaveLength(2);
  });

  it('returns screenshots as MCP image content, including images larger than the normal IPC limit', async () => {
    const imageData = Buffer.alloc(4 * 1024 * 1024, 42).toString('base64');
    const calls: string[] = [];
    const f = await fixture('screenshot', async (tool) => {
      calls.push(tool);
      if (tool === 'list_screenshot_targets') return { ok: true, targets: [{ id: 'one', label: 'list' }] };
      return { ok: true, width: 1, height: 1, image: { data: imageData, mimeType: 'image/png' } };
    });
    const client = await connect(f.registryRoot, f.workspace);
    const targets = await client.callTool({
      name: 'list_screenshot_targets',
      arguments: { sessionId: 'screenshot' },
    });
    expect(targets.structuredContent).toMatchObject({ targets: [{ id: 'one' }] });
    const result = await client.callTool({
      name: 'take_screenshot',
      arguments: { sessionId: 'screenshot', mode: 'long', targetId: 'one' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ ok: true, width: 1, height: 1 }) },
      { type: 'image', data: imageData, mimeType: 'image/png' },
    ]);
    expect(result.structuredContent).toEqual({ ok: true, width: 1, height: 1 });
    const invalid = await client.callTool({
      name: 'take_screenshot',
      arguments: { sessionId: 'screenshot', mode: 'screen', targetId: 'one' },
    });
    expect(invalid.isError).toBe(true);
    expect(calls).toEqual(['list_screenshot_targets', 'take_screenshot']);
  });

  it('preserves screenshot errors and rejects malformed successful images', async () => {
    const f = await fixture('screenshot-errors', async (_tool, args) =>
      args.mode === 'long' ? { ok: false, code: 'NO_TARGET', message: '没有可用区域' } : { ok: true },
    );
    const client = await connect(f.registryRoot, f.workspace);
    const failed = await client.callTool({
      name: 'take_screenshot',
      arguments: { sessionId: 'screenshot-errors', mode: 'long' },
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ code: 'NO_TARGET' });
    const invalid = await client.callTool({
      name: 'take_screenshot',
      arguments: { sessionId: 'screenshot-errors', mode: 'screen' },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: { code: 'INVALID_RESPONSE' } });
  });

  it('publishes private descriptors without VM credentials and removes them on stop', async () => {
    const f = await fixture();
    expect((await stat(f.registryRoot)).mode & 0o777).toBe(0o700);
    const file = join(f.registryRoot, (await readdir(f.registryRoot))[0]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(f.descriptor.socket)).mode & 0o777).toBe(0o600);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('ws://');
    expect(text).not.toContain('VM');
    await expect(requestSession(f.descriptor, { kind: 'ping' })).resolves.toEqual({ available: true });
    await f.server.stop();
    expect(await discoverSessions(f.registryRoot)).toEqual([]);
    await expect(requestSession(f.descriptor, { kind: 'ping' })).rejects.toMatchObject({
      code: 'SESSION_UNAVAILABLE',
    });
  });

  it('rejects wrong credentials, workspace and unknown tool parameters', async () => {
    const f = await fixture();
    await expect(
      requestSession({ ...f.descriptor, token: 'a'.repeat(64) }, { kind: 'ping' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      requestSession({ ...f.descriptor, workspace: '/another' }, { kind: 'ping' }),
    ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    await expect(
      requestSession(f.descriptor, {
        kind: 'call',
        tool: 'tap',
        args: { sessionId: 'project-a', key: 'save', expression: 'evil()' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(
      requestSession(f.descriptor, { kind: 'call', tool: 'evaluate', args: {} }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
    expect(() => parseTool('tap', { sessionId: 'a', key: 1.5 })).toThrow();
    expect(() => parseTool('tap', { sessionId: 'a', key: 'save', timeoutMs: 90000 })).toThrow();
  });

  it('uses real SDK stdio tool discovery/calls with explicit project isolation', async () => {
    const f = await fixture();
    const second = new McpSessionServer({
      registryRoot: f.registryRoot,
      workspace: '/other-project',
      sessionId: 'other',
      name: 'other',
      describe: () => ({}),
      call: async () => ({}),
    });
    servers.push(second);
    await second.start();
    const client = await connect(f.registryRoot, f.workspace);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(Object.keys(mcpTools).sort());
    const list = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(list.structuredContent).toMatchObject({ sessions: [{ sessionId: 'project-a', connected: true }] });
    expect(JSON.stringify(list)).not.toContain(f.descriptor.token);
    expect(JSON.stringify(list)).not.toContain(f.descriptor.socket);
    const result = await client.callTool({
      name: 'tap',
      arguments: { sessionId: 'project-a', key: 'submit', ancestorKey: 20 },
    });
    expect(result.structuredContent).toEqual({ tool: 'tap', key: 'submit' });
    const denied = await client.callTool({ name: 'tap', arguments: { sessionId: 'other', key: 'submit' } });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({ error: { code: 'SESSION_UNAVAILABLE' } });
    expect(f.events.some((e) => e.name === 'codex-test-client' && e.event === 'connected')).toBe(true);
    expect(f.events.some((e) => e.name === 'codex-test-client' && e.scope === 'project')).toBe(true);
    await client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(f.events.some((e) => e.event === 'disconnected')).toBe(true);
  });

  it('global bridge lists all enabled projects and stays useful while IDE is offline', async () => {
    const f = await fixture();
    const second = new McpSessionServer({
      registryRoot: f.registryRoot,
      workspace: '/other-project',
      sessionId: 'other',
      name: 'other',
      describe: () => ({}),
      call: async () => ({}),
    });
    servers.push(second);
    await second.start();
    const client = await connect(f.registryRoot);
    expect(
      ((await client.callTool({ name: 'list_sessions', arguments: {} })).structuredContent as any).sessions,
    ).toHaveLength(2);
    await Promise.all([f.server.stop(), second.stop()]);
    const empty = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(empty.structuredContent).toMatchObject({
      sessions: [],
      message: expect.stringContaining('开启 MCP'),
    });
  });

  it('self-test handshake never claims an Agent loaded the configuration', async () => {
    const f = await fixture();
    const client = await connect(f.registryRoot, f.workspace, 'flutter-pilot-selftest');
    await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(f.events).toEqual([]);
  });

  it('reports runtime failures as MCP isError rather than successful calls', async () => {
    const f = await fixture('failure', async () => ({
      ok: false,
      error: { code: 'NOT_FOUND', message: '未找到目标' },
    }));
    const client = await connect(f.registryRoot, f.workspace);
    const result = await client.callTool({ name: 'tap', arguments: { sessionId: 'failure', key: 'save' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: '未找到目标' },
    });
    const unknown = await client.callTool({
      name: 'tap',
      arguments: { sessionId: 'failure', key: 'save', callback: 'invalid' },
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' } });
  });

  it('aborts in-flight work on cancellation or disable without replay', async () => {
    let calls = 0;
    let aborted = false;
    const f = await fixture('cancel', async (_tool, _args, { signal }) => {
      calls++;
      await new Promise<void>((done) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            done();
          },
          { once: true },
        ),
      );
      return { complete: true };
    });
    const abort = new AbortController();
    const pending = requestSession(
      f.descriptor,
      { kind: 'call', tool: 'tap', args: { sessionId: 'cancel', key: 'submit' } },
      abort.signal,
    );
    await new Promise((r) => setTimeout(r, 30));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await new Promise((r) => setTimeout(r, 30));
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
    aborted = false;
    const disabled = requestSession(f.descriptor, {
      kind: 'call',
      tool: 'tap',
      args: { sessionId: 'cancel', key: 'submit' },
    });
    await new Promise((r) => setTimeout(r, 30));
    const rejected = expect(disabled).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
    await f.server.stop();
    await rejected;
    expect(aborted).toBe(true);
    expect(calls).toBe(2);
  });

  it('ignores unsafe descriptor files and rejects a public registry', async () => {
    const f = await fixture();
    const file = join(f.registryRoot, (await readdir(f.registryRoot))[0]);
    await chmod(file, 0o644);
    expect(await discoverSessions(f.registryRoot)).toEqual([]);
    await chmod(file, 0o600);
    await writeFile(file, '{broken');
    expect(await discoverSessions(f.registryRoot)).toEqual([]);
    await chmod(f.registryRoot, 0o755);
    await expect(discoverSessions(f.registryRoot)).rejects.toMatchObject({ code: 'UNSAFE_REGISTRY' });
  });

  it('canonicalizes workspace aliases and prunes stale entries without touching live sessions', async () => {
    const f = await fixture();
    await mkdir(f.workspace);
    const alias = join(f.root, 'alias');
    await symlink(f.workspace, alias);
    expect(await discoverSessions(f.registryRoot, alias)).toHaveLength(1);
    const client = await connect(f.registryRoot, alias);
    const listed = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect((listed.structuredContent as any).sessions).toHaveLength(1);
    const file = join(f.registryRoot, (await readdir(f.registryRoot))[0]);
    const original = await readFile(file, 'utf8');
    await pruneStaleSessions(f.registryRoot);
    expect(await readFile(file, 'utf8')).toBe(original);
    await f.server.stop();
    await writeFile(file, original, { mode: 0o600 });
    await pruneStaleSessions(f.registryRoot);
    expect(await discoverSessions(f.registryRoot)).toEqual([]);
  });
});

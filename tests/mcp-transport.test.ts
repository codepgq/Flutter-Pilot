import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, chmod, mkdir, symlink, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    describe: () => ({ connected: true, rulesFiles: ['.api-mocks/rules.json'] }),
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
    const client = await connect(f.registryRoot, f.workspace, 'flutter-api-mocks-selftest');
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

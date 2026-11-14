import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpSessionServer } from '../src/mcp/server';
import { mcpTools, parseTool } from '../src/mcp/tools';
import { getMcpPrompt, mcpPrompts } from '../src/mcp/prompts';
import { getUsageGuide } from '../src/mcp/guide';
import { sceneActionToolNames } from '../src/workflows/tools';
import { compileSceneAction } from '../src/workflows/model';
import { validateSceneDocument } from '../src/scene-model';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('Workflow MCP contracts', () => {
  it('keeps the shipped login/order example executable against the production compiler', async () => {
    const example = JSON.parse(await readFile('resources/example.scenes.json', 'utf8'));
    expect((getUsageGuide('workflow').reusable as Record<string, unknown>).exampleDocument).toEqual(example);
    const document = validateSceneDocument(example);
    const compiled = compileSceneAction(document, 'common_operations', 'login_and_submit_order', {
      username: 'fixture@example.test',
      password: 'fixture-only-password',
      price: '0.000000001',
    });
    expect(compiled.steps.find((step) => step.target === 'priceInput')?.args.text).toBe('0.000000001');
    expect(compiled.steps.find((step) => step.target === 'quantityInput')?.args.text).toBe('2');
    expect(compiled.steps.filter((step) => step.target === 'confirmButton')).toHaveLength(1);
    expect(compiled.steps.some((step) => step.actionId === 'login')).toBe(true);
    expect(compiled.secrets).toContain('fixture-only-password');
    const documentation = await readFile('docs/workflows.md', 'utf8');
    const examples = [...documentation.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]),
    );
    const sceneExample = examples.find((value) => value.version === 1 && Array.isArray(value.scenes));
    const runExample = examples.find((value) => value.sessionId && value.sceneId && value.actionId);
    expect(sceneExample).toBeDefined();
    expect(runExample).toBeDefined();
    expect(() => validateSceneDocument(sceneExample)).not.toThrow();
    expect(() => parseTool('run_scene_action', runExample)).not.toThrow();
  });

  it('accepts parameterized saved flows and rejects inline actions, scripts, paths and numeric money', () => {
    expect(
      parseTool('run_scene_action', {
        sessionId: 'project',
        sceneId: 'common_operations',
        actionId: 'submit_order',
        inputs: { price: '0.000000001', quantity: '2' },
      }),
    ).toMatchObject({ inputs: { price: '0.000000001', quantity: '2' } });
    for (const args of [
      { steps: [{ tool: 'tap', key: 'confirm' }] },
      { expression: 'submitOrder()' },
      { path: '/tmp/workflows.json' },
      { inputs: { price: 100 } },
      { inputs: { price: 'x'.repeat(16385) } },
      { inputs: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`input${i}`, 'value'])) },
      { actionId: '' },
      { backend: 'coordinates' },
    ])
      expect(() =>
        parseTool('run_scene_action', {
          sessionId: 'project',
          sceneId: 'common_operations',
          actionId: 'submit_order',
          ...args,
        }),
      ).toThrow();
    for (const tool of ['get_scene_action_run', 'cancel_scene_action_run']) {
      expect(() => parseTool(tool, { sessionId: 'project', runId: '' })).toThrow();
      expect(() => parseTool(tool, { sessionId: 'project', runId: 'run', restart: true })).toThrow();
    }
  });

  it('discovers every flow tool through the offline guide and a same-name prompt', () => {
    const guide = JSON.stringify(getUsageGuide('workflow'));
    for (const name of sceneActionToolNames) {
      expect(mcpTools).toHaveProperty(name);
      expect(mcpPrompts.some((prompt) => prompt.name === name)).toBe(true);
      expect(guide).toContain(name);
      const prompt = getMcpPrompt(name, { task: '复用已确认的下单步骤' }).messages[0].content.text;
      expect(prompt).toContain(`目标工具：${name}`);
      expect(prompt).toContain('不自动重试');
    }
    expect(guide).toContain('completed');
    expect(guide).toContain('不是测试 passed');
    expect(guide).toContain('reload_rules');
  });

  it('documents wait diagnostics in tools, same-name prompts and offline guides', () => {
    for (const name of ['wait_for_widget', 'get_scene_action_run']) {
      expect(mcpTools[name as keyof typeof mcpTools].description).toContain('diagnostics');
      const prompt = getMcpPrompt(name).messages[0].content.text;
      expect(prompt).toContain('lastObservation');
      expect(prompt).toContain('NOT_FOUND');
    }
    for (const topic of ['ui', 'workflow'] as const)
      expect(JSON.stringify(getUsageGuide(topic))).toContain('lastObservation');
  });

  it('exposes read-only queries and forwards start/query/cancel over the real stdio bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-workflow-protocol-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bridgeFile = join(root, 'bridge.cjs');
    await build({
      entryPoints: ['src/mcp/bridge.ts'],
      outfile: bridgeFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const diagnostics = {
      selector: { source: 'flutter', key: 'app.shell.root' },
      condition: 'visible',
      timeoutMs: 30000,
      attempts: 20,
      lastObservation: { code: 'NOT_FOUND', present: false },
    };
    const registryRoot = join(root, 'sessions');
    const workspace = join(root, 'project');
    const server = new McpSessionServer({
      registryRoot,
      workspace,
      sessionId: 'project',
      name: 'workflow-test',
      describe: () => ({ capabilities: { sceneActions: true } }),
      call: async (tool, args) => {
        calls.push({ tool, args });
        return {
          ok: true,
          runId: 'saved-run',
          status: tool === 'run_scene_action' ? 'running' : 'completed',
          ...(tool === 'get_scene_action_run'
            ? { run: { status: 'failed', failure: { code: 'WAIT_TIMEOUT', diagnostics } } }
            : {}),
        };
      },
    });
    await server.start();
    cleanups.push(() => server.stop());
    const client = new Client({ name: 'workflow-contract', version: '1.0.0' });
    cleanups.push(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bridgeFile, '--registry', registryRoot, '--workspace', workspace],
        stderr: 'pipe',
      }),
    );
    const { tools } = await client.listTools();
    for (const removed of ['list_workflows', 'run_workflow', 'get_workflow_run', 'cancel_workflow_run'])
      expect(tools.some((tool) => tool.name === removed)).toBe(false);
    for (const name of ['list_scene_actions', 'get_scene_action_run'])
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    for (const name of ['run_scene_action', 'cancel_scene_action_run'])
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
    const start = await client.callTool({
      name: 'run_scene_action',
      arguments: {
        sessionId: 'project',
        sceneId: 'common_operations',
        actionId: 'submit_order',
        inputs: { price: '1.20' },
      },
    });
    expect(start.isError).not.toBe(true);
    expect(start.structuredContent).toMatchObject({ runId: 'saved-run', status: 'running' });
    const query = await client.callTool({
      name: 'get_scene_action_run',
      arguments: { sessionId: 'project', runId: 'saved-run' },
    });
    expect(query.structuredContent).toMatchObject({
      run: { status: 'failed', failure: { code: 'WAIT_TIMEOUT', diagnostics } },
    });
    await client.callTool({
      name: 'cancel_scene_action_run',
      arguments: { sessionId: 'project', runId: 'saved-run' },
    });
    expect(calls).toEqual([
      {
        tool: 'run_scene_action',
        args: {
          sessionId: 'project',
          sceneId: 'common_operations',
          actionId: 'submit_order',
          inputs: { price: '1.20' },
        },
      },
      { tool: 'get_scene_action_run', args: { sessionId: 'project', runId: 'saved-run' } },
      { tool: 'cancel_scene_action_run', args: { sessionId: 'project', runId: 'saved-run' } },
    ]);
  });
});

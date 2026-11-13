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
import { getUsageGuide, guideTopics } from '../src/mcp/guide';
import { testToolNames } from '../src/testing/tools';
import { bindJsonTemplate, bindTestMock, validateTestDocument } from '../src/testing/model';
import { compileTestMock } from '../src/testing/mock-model';
import { compileWorkflow, validateWorkflowDocument } from '../src/workflows/model';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('Test Case MCP contracts', () => {
  it('ships valid success/rejection examples that reuse the same single-confirm workflow', async () => {
    const example = JSON.parse(await readFile('resources/example.tests.json', 'utf8'));
    expect((getUsageGuide('workflow').testing as Record<string, unknown>).exampleDocument).toEqual(example);
    const document = validateTestDocument(example);
    const workflows = validateWorkflowDocument(
      JSON.parse(await readFile('resources/example.workflows.json', 'utf8')),
    );
    expect(document.tests).toHaveLength(2);
    for (const test of document.tests) {
      expect(test.workflowId).toBe('submit_order');
      const compiled = compileWorkflow(workflows, test.workflowId, test.inputs ?? {});
      expect(compiled.steps.filter((step) => step.target === 'confirmButton')).toHaveLength(1);
    }
    const success = document.tests[0];
    const mock = bindTestMock(success.mock, success.inputs ?? {}, 'current-run')!;
    const rules = compileTestMock(mock, 'current-run');
    const create = rules.find((rule) => rule.scenario?.next === 'pending')!;
    expect(JSON.parse(create.mock!.body!)).toMatchObject({ data: { orderId: 'current-run' } });
    const second = compileTestMock(mock, 'next-run');
    expect(second.map((rule) => rule.id).some((id) => rules.some((rule) => rule.id === id))).toBe(false);
    const event = JSON.parse(
      bindJsonTemplate(success.events![0].text, success.inputs ?? {}, 'current-run', {
        orderId: 'current-run',
      }),
    );
    expect(success.events![0].after).toBe(success.expect.http![0].id);
    expect(event).toMatchObject({ data: { orderId: 'current-run', price: '100.00', quantity: '2' } });
    expect(success.expect.ui!.every((assertion) => assertion.selector.ancestor?.key)).toBe(true);
    const documentation = await readFile('docs/testing.md', 'utf8');
    const snippets = [...documentation.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]),
    );
    expect(() => parseTool('run_test', snippets[0])).not.toThrow();
    expect(() =>
      validateTestDocument({
        version: 1,
        tests: [
          {
            id: 'doc',
            name: '文档片段',
            workflowId: 'submit_order',
            inputs: { price: '100.00', quantity: '2' },
            expect: { http: [snippets[1]] },
            events: [snippets[2]],
            mock: snippets[3],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts saved parameterized tests and rejects inline scripts, paths and numeric money', () => {
    expect(
      parseTool('run_test', {
        sessionId: 'project',
        testId: 'order_pending',
        inputs: { price: '0.000000001', quantity: '2' },
        backend: 'flutter',
      }),
    ).toMatchObject({ inputs: { price: '0.000000001', quantity: '2' }, backend: 'flutter' });
    for (const args of [
      { steps: [{ tool: 'tap', key: 'confirm' }] },
      { expression: 'submitOrder()' },
      { path: '/tmp/tests.json' },
      { inputs: { price: 100 } },
      { inputs: { 'bad-input': '1' } },
      { inputs: { price: 'x'.repeat(16385) } },
      { inputs: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`input${i}`, 'value'])) },
      { testId: '' },
      { backend: 'coordinates' },
      { retry: true },
    ])
      expect(() =>
        parseTool('run_test', { sessionId: 'project', testId: 'order_pending', ...args }),
      ).toThrow();
    for (const tool of ['get_test_run', 'cancel_test_run']) {
      expect(() => parseTool(tool, { sessionId: 'project', runId: '' })).toThrow();
      expect(() => parseTool(tool, { sessionId: 'project', runId: 'run', restart: true })).toThrow();
    }
    expect(() => parseTool('list_tests', { sessionId: 'project', activate: true })).toThrow();
  });

  it('discovers all four test tools through the existing five guides and same-name prompts', () => {
    expect(guideTopics).toEqual(['overview', 'http', 'ws', 'ui', 'workflow']);
    const guide = JSON.stringify(getUsageGuide('workflow'));
    for (const name of testToolNames) {
      expect(mcpTools).toHaveProperty(name);
      expect(mcpPrompts.some((prompt) => prompt.name === name)).toBe(true);
      expect(guide).toContain(name);
      const prompt = getMcpPrompt(name, { task: '验证本次订单进入 pending' }).messages[0].content.text;
      expect(prompt).toContain(`目标工具：${name}`);
      expect(prompt).toContain('不自动重试');
    }
    expect(guide).toContain('passed');
    expect(guide).toContain('orderId');
    expect(guide).toContain('基线');
  });

  it('marks queries read-only and forwards test start/query/cancel over the real stdio bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-testcase-protocol-'));
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
    const registryRoot = join(root, 'sessions');
    const workspace = join(root, 'project');
    const server = new McpSessionServer({
      registryRoot,
      workspace,
      sessionId: 'project',
      name: 'testcase-test',
      describe: () => ({ capabilities: { tests: true } }),
      call: async (tool, args) => {
        calls.push({ tool, args });
        return { ok: true, runId: 'test-run', status: tool === 'run_test' ? 'running' : 'passed' };
      },
    });
    await server.start();
    cleanups.push(() => server.stop());
    const client = new Client({ name: 'testcase-contract', version: '1.0.0' });
    cleanups.push(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bridgeFile, '--registry', registryRoot, '--workspace', workspace],
        stderr: 'pipe',
      }),
    );
    const { tools } = await client.listTools();
    for (const name of ['list_tests', 'get_test_run'])
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    for (const name of ['run_test', 'cancel_test_run'])
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
    const { prompts } = await client.listPrompts();
    for (const name of testToolNames) expect(prompts.some((prompt) => prompt.name === name)).toBe(true);
    const start = await client.callTool({
      name: 'run_test',
      arguments: { sessionId: 'project', testId: 'order_pending', inputs: { price: '1.20' } },
    });
    expect(start.isError).not.toBe(true);
    expect(start.structuredContent).toMatchObject({ runId: 'test-run', status: 'running' });
    await client.callTool({ name: 'list_tests', arguments: { sessionId: 'project' } });
    await client.callTool({
      name: 'get_test_run',
      arguments: { sessionId: 'project', runId: 'test-run' },
    });
    await client.callTool({
      name: 'cancel_test_run',
      arguments: { sessionId: 'project', runId: 'test-run' },
    });
    expect(calls).toEqual([
      {
        tool: 'run_test',
        args: { sessionId: 'project', testId: 'order_pending', inputs: { price: '1.20' } },
      },
      { tool: 'list_tests', args: { sessionId: 'project' } },
      { tool: 'get_test_run', args: { sessionId: 'project', runId: 'test-run' } },
      { tool: 'cancel_test_run', args: { sessionId: 'project', runId: 'test-run' } },
    ]);
  });
});

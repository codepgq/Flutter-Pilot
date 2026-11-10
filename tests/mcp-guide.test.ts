import { describe, expect, it } from 'vitest';
import { getUsageGuide, guideTopics, httpExample, wsExample } from '../src/mcp/guide';
import { mcpTools, parseTool } from '../src/mcp/tools';
import { getMcpPrompt, mcpPrompts, toolPromptPlans } from '../src/mcp/prompts';
import { agentInstructions } from '../src/mcp/guide';
import { z } from 'zod';
import { validateRuleDocument } from '../src/model';
import { validateWsRuleDocument } from '../src/ws/model';

describe('Agent usage guide contracts', () => {
  it('covers every registered tool with a same-name prompt, instructions and the production schema', () => {
    expect(Object.keys(toolPromptPlans).sort()).toEqual(Object.keys(mcpTools).sort());
    for (const [name, tool] of Object.entries(mcpTools)) {
      expect(agentInstructions).toContain(name);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(mcpPrompts.find((prompt) => prompt.name === name)).toBeDefined();
      const text = getMcpPrompt(name, { task: '验证该能力' }).messages[0].content.text;
      expect(text).toContain(`目标工具：${name}`);
      expect(text).toContain(JSON.stringify(z.toJSONSchema(tool.schema), null, 2));
      expect(text).toContain('验证该能力');
      expect(text).toContain('不自动重试');
      expect(toolPromptPlans[name as keyof typeof toolPromptPlans].steps.length).toBeGreaterThan(0);
    }
  });
  it.each(['hot_reload', 'hot_restart'])(
    'offers a standalone %s prompt with lifecycle verification',
    (name) => {
      const text = getMcpPrompt(name, { task: '展示新页面状态' }).messages[0].content.text;
      expect(text).toContain('capabilities.lifecycle');
      expect(text).toContain('completed');
      expect(text).toContain('network');
      expect(text).toContain('reload_rules');
    },
  );
  it('keeps HTTP documents and each action example valid against the production validator', () => {
    expect(validateRuleDocument(httpExample)).toEqual(httpExample);
    const variants = getUsageGuide('http').variants as Record<string, unknown>;
    for (const action of Object.values(variants)) {
      const { mock: _, ...base } = httpExample.rules[0];
      expect(() =>
        validateRuleDocument({ version: 1, rules: [{ ...base, ...(action as object) }] }),
      ).not.toThrow();
    }
  });

  it('keeps WS documents and drop example valid as persistent rules', () => {
    expect(validateWsRuleDocument(wsExample, false)).toEqual(wsExample);
    const variants = getUsageGuide('ws').variants as Record<string, unknown>;
    expect(() =>
      validateWsRuleDocument(
        { version: 1, rules: [{ ...wsExample.rules[0], ...(variants.drop as object) }] },
        false,
      ),
    ).not.toThrow();
  });

  it.each(guideTopics)('keeps every %s tool example compatible with the real schema', (topic) => {
    let count = 0;
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const object = node as Record<string, unknown>;
      if (typeof object.tool === 'string' && object.arguments) {
        expect(() => parseTool(object.tool as string, object.arguments)).not.toThrow();
        count++;
      }
      Object.values(object).forEach(visit);
    };
    visit(getUsageGuide(topic));
    expect(count).toBeGreaterThan(0);
  });

  it('rejects arbitrary session, path or expression parameters on the local guide', () => {
    for (const args of [{ sessionId: 'project' }, { path: '/tmp/file' }, { expression: 'arbitrary()' }]) {
      expect(() => parseTool('get_usage_guide', args)).toThrow();
    }
  });

  it('explains rule loading before restart and evidence after runtime reinjection', () => {
    const lifecycle = getUsageGuide('workflow').lifecycle as Record<string, unknown>;
    expect(lifecycle.restart).toEqual({
      tool: 'hot_restart',
      arguments: { sessionId: expect.any(String), timeoutMs: 30000 },
    });
    expect(lifecycle.reload).toEqual({
      tool: 'hot_reload',
      arguments: { sessionId: expect.any(String), timeoutMs: 30000 },
    });
    expect(lifecycle.restartMeaning).toContain('先reload_rules');
    expect(lifecycle.runtime).toContain('启动首请求可能早于Mock重新注入');
    expect(lifecycle.verification).toContain('不自动重试重启');
  });

  it.each(['http_mock', 'flutter_ui', 'mock_workflow'])(
    'makes MCP lifecycle controls discoverable through %s',
    (name) => {
      const text = getMcpPrompt(name, { task: '修改API后展示不同状态和UI' }).messages[0].content.text;
      expect(text).toContain('hot_reload');
      expect(text).toContain('hot_restart');
      expect(text).toContain('IDE');
    },
  );
});

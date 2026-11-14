import { describe, expect, it } from 'vitest';
import { getUsageGuide, guideTopics, httpExample, wsExample } from '../src/mcp/guide';
import { mcpTools, parseTool } from '../src/mcp/tools';
import { getMcpPrompt, mcpPrompts, toolPromptPlans } from '../src/mcp/prompts';
import { agentInstructions } from '../src/mcp/guide';
import { z } from 'zod';
import { validateRuleDocument } from '../src/model';
import { validateWsRuleDocument } from '../src/ws/model';
import { capabilityRoutes } from '../src/mcp/capabilities';

describe('Agent usage guide contracts', () => {
  it('discovers Cursor setup offline without treating configuration as a client handshake', () => {
    const adapters = getUsageGuide('overview').agentAdapters as any;
    expect(adapters.clients).toContain('Cursor');
    expect(adapters.cursor).toMatchObject({
      project: '<workspace>/.cursor/mcp.json',
      global: '~/.cursor/mcp.json',
      server: 'mcpServers.flutter-pilot',
      transport: 'stdio',
    });
    expect(adapters.verification).toContain('不写入配置');
    for (const name of ['capabilities', 'get_usage_guide']) {
      const text = getMcpPrompt(name).messages[0].content.text;
      expect(text).toContain('Cursor');
      expect(text).toContain('overview.agentAdapters');
      expect(text).toContain('握手');
    }
  });

  it('exposes a read-only capability prompt backed by every registered tool and scenario', () => {
    const result = getMcpPrompt('capabilities');
    const text = result.messages[0].content.text;
    expect(result.description).toContain('只读能力总览');
    expect(text).toContain('无需 list_sessions、sessionId 或在线 IDE');
    expect(text).not.toContain('尚未指定具体任务');
    expect(text).not.toContain('调用 list_sessions，按项目路径和任务上下文选择对应会话');
    expect(text).not.toContain('完成后报告修改的规则/源码');
    for (const [name, tool] of Object.entries(mcpTools))
      expect(text).toContain(`- ${name}：${tool.description}`);
    for (const name of [
      'app_screenshot',
      'scene_action_quick_run',
      'scene_action_authoring',
      'http_mock',
      'websocket_mock',
      'flutter_ui',
      'mock_workflow',
    ]) {
      const prompt = mcpPrompts.find((item) => item.name === name)!;
      expect(text).toContain(`- ${name}：${prompt.description}`);
    }
  });

  it('routes offline guide discovery to the same high-level prompt descriptions', () => {
    const discovery = getUsageGuide('overview').promptDiscovery as {
      protocol: string;
      entrypoints: { name: string; description: string; topics: string[] }[];
    };
    expect(discovery.protocol).toContain('读取不执行操作');
    expect(discovery.entrypoints.map((entry) => entry.name)).toEqual([
      'capabilities',
      'app_screenshot',
      'scene_action_quick_run',
      'scene_action_authoring',
    ]);
    for (const entry of discovery.entrypoints) {
      expect(mcpPrompts.find((prompt) => prompt.name === entry.name)?.description).toBe(entry.description);
      expect(agentInstructions).toContain(entry.name);
      expect(entry.topics.every((topic) => guideTopics.includes(topic as (typeof guideTopics)[number]))).toBe(
        true,
      );
    }
  });

  it('routes user requests to registered capabilities consistently across startup and offline discovery', () => {
    expect(getUsageGuide('overview').capabilityRoutes).toEqual(capabilityRoutes);
    expect(new Set(capabilityRoutes.map((route) => route.id)).size).toBe(capabilityRoutes.length);
    const advertisedTools = new Set<string>();
    const capabilityText = getMcpPrompt('capabilities').messages[0].content.text;
    for (const route of capabilityRoutes) {
      expect(route.requests.length).toBeGreaterThan(0);
      expect(route.tools.length).toBeGreaterThan(0);
      expect(route.workflow.length).toBeGreaterThan(0);
      expect(mcpPrompts.some((prompt) => prompt.name === route.prompt)).toBe(true);
      expect(route.topics.every((topic) => guideTopics.includes(topic))).toBe(true);
      expect(agentInstructions).toContain(route.title);
      expect(capabilityText).toContain(route.title);
      for (const name of route.tools) {
        expect(Object.hasOwn(mcpTools, name)).toBe(true);
        expect(agentInstructions).toContain(name);
        advertisedTools.add(name);
      }
    }
    expect([...advertisedTools].sort()).toEqual(Object.keys(mcpTools).sort());
    const screenshot = capabilityRoutes.find((route) =>
      route.tools.some((name) => name === 'take_screenshot'),
    )!;
    expect(screenshot).toBeDefined();
    expect(screenshot.prompt).toBe('app_screenshot');
    expect(screenshot.topics).toContain('screenshot');
    expect(screenshot.requests.join(' ')).toMatch(/截图|截屏/);
    expect(agentInstructions).toContain('Flutter Pilot');
    expect(agentInstructions).toContain('优先');
    expect(agentInstructions).toContain('app_screenshot');
  });

  it('provides focused screenshot guidance and executable screen, long and device examples', () => {
    expect(guideTopics).toContain('screenshot');
    const guide = getUsageGuide('screenshot');
    const examples = guide.examples as { tool: string; arguments: Record<string, unknown> }[];
    for (const args of [
      { mode: 'screen', source: 'flutter' },
      { mode: 'long', source: 'flutter' },
      { mode: 'screen', source: 'device' },
    ])
      expect(examples).toContainEqual({
        tool: 'take_screenshot',
        arguments: expect.objectContaining(args),
      });
    expect(examples.some((example) => example.tool === 'list_screenshot_targets')).toBe(true);
    for (const example of examples) expect(() => parseTool(example.tool, example.arguments)).not.toThrow();
    for (const name of ['app_screenshot', 'take_screenshot']) {
      const text = getMcpPrompt(name, { task: '截取当前 Flutter App 页面' }).messages[0].content.text;
      expect(text).toMatch(/source(?:=|:")flutter/);
      expect(text).toMatch(/source(?:=|:")device/);
      expect(text).toContain('list_screenshot_targets');
      expect(text).not.toContain('根据工具 JSON Schema 传参。backend=auto');
      expect(text).not.toContain('操作后通过 wait_for_widget');
    }
    expect(() =>
      parseTool('take_screenshot', { sessionId: 'app', source: 'device', mode: 'long' }),
    ).toThrow();
    expect(() =>
      parseTool('take_screenshot', { sessionId: 'app', mode: 'screen', targetId: 'list' }),
    ).toThrow();
  });

  it('keeps lookup, device management and launch prompts within the requested task', () => {
    for (const name of [
      'get_automation_status',
      'get_ui_snapshot',
      'find_widget',
      'inspect_key_issues',
      'get_keyboard_state',
      'list_screenshot_targets',
      'disconnect_device',
    ]) {
      const text = getMcpPrompt(name, { task: '只查询或管理当前连接' }).messages[0].content.text;
      expect(text).not.toContain('优先使用实际 Key');
      expect(text).not.toContain('操作后通过 wait_for_widget');
    }
    expect(getMcpPrompt('get_automation_status').messages[0].content.text).toContain('不安装、不连接设备');
    expect(getMcpPrompt('list_screenshot_targets').messages[0].content.text).toContain('不自动滚动或截图');
    const keyDiagnosis = getMcpPrompt('inspect_key_issues').messages[0].content.text;
    expect(keyDiagnosis).toContain('当前挂载的 Flutter Widget Key');
    expect(keyDiagnosis).not.toContain('source=device');
    expect(getMcpPrompt('start_app').messages[0].content.text).toContain('只启动任务确认启动结果即可');
    for (const text of [agentInstructions, getMcpPrompt('app_screenshot').messages[0].content.text]) {
      expect(text).toContain('桌面、浏览器网页');
      expect(text).toContain('不切换 Mock');
      expect(text).toContain('先确认');
    }
  });

  it('makes saved action execution and authoring discoverable without reading tool bodies', () => {
    const quick = mcpPrompts.find((prompt) => prompt.name === 'scene_action_quick_run')!;
    expect(quick.description).toContain('启动 App');
    expect(quick.description).toContain('Widget Key');
    const run = getMcpPrompt(quick.name, { task: '使用已保存操作登录到主页' }).messages[0].content.text;
    for (const requirement of [
      'list_scene_actions',
      'start_app',
      'TIMEOUT',
      '不隐式切换当前 Mock',
      '无需 Agent 每步 find_widget',
      'get_scene_action_run',
      'cancel_scene_action_run',
      '独立',
      'UI 操作（Workflow）',
    ])
      expect(run).toContain(requirement);
    const authoring = getMcpPrompt('scene_action_authoring').messages[0].content.text;
    for (const requirement of [
      'version:1',
      'steps[].target',
      '真实 Widget Key',
      'hide_keyboard',
      '该步骤没有 target',
      'secret:true',
      '纯操作 Scene',
      '显式映射',
      '展开后的原子工具',
      'version:2',
    ])
      expect(authoring).toContain(requirement);
  });

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
  it('describes screenshot transport and avoids requiring a scene for direct WS messages', () => {
    const screenshot = getMcpPrompt('take_screenshot', { task: '截图' }).messages[0].content.text;
    expect(screenshot).toContain('list_screenshot_targets');
    expect(screenshot).toContain('32 MiB');
    expect(screenshot).toContain('90 秒');
    const ws = getMcpPrompt('websocket_mock', { task: '注入消息' }).messages[0].content.text;
    expect(ws).toContain('仅注入、发送消息时无需激活场景');
  });

  it('explains keyboard confirmation and keeps VM interaction independent of device setup', () => {
    const hide = getMcpPrompt('hide_keyboard').messages[0].content.text;
    for (const requirement of [
      '无需安装 Appium',
      '该步骤无 target',
      'shown:false',
      '连续隐藏观测',
      'get_keyboard_state',
      'KEYBOARD_STATE_UNCONFIRMED',
      '不自动重放',
    ])
      expect(hide).toContain(requirement);
    const tap = getMcpPrompt('tap').messages[0].content.text;
    expect(tap).toContain('使用 backend=flutter 时直接操作');
    expect(tap).toContain('再按需 setup_automation / connect_device');
    const examples = getUsageGuide('ui').examples as { tool: string; arguments: Record<string, unknown> }[];
    const keyboard = examples.find((example) => example.tool === 'hide_keyboard')!;
    expect(keyboard).toBeDefined();
    expect(parseTool(keyboard.tool, keyboard.arguments)).toMatchObject({ backend: 'flutter' });
    expect(keyboard.arguments).not.toHaveProperty('target');
  });

  it('makes wait failures discoverable through direct, Scene and Test Case prompts', () => {
    for (const name of ['wait_for_widget', 'get_scene_action_run', 'get_test_run']) {
      const text = getMcpPrompt(name).messages[0].content.text;
      for (const field of [
        'diagnostics',
        'selector',
        'condition',
        'timeoutMs',
        'attempts',
        'lastObservation',
      ])
        expect(text).toContain(field);
    }
    const guide = getUsageGuide('ui').waitDiagnostics as { tools: string[]; interpretation: string };
    expect(guide.tools).toEqual(['wait_for_widget', 'get_scene_action_run', 'get_test_run']);
    expect(guide.interpretation).toContain('present:false');
    expect(guide.interpretation).toContain('present:true');
    const capabilities = getMcpPrompt('capabilities').messages[0].content.text;
    expect(capabilities).toContain('wait_for_widget / get_scene_action_run / get_test_run');
    expect(capabilities).toContain('lastObservation');
  });
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

  it('discovers saved actions before exploration and keeps the short run path executable', () => {
    const quickRun = getUsageGuide('workflow').quickRun as Record<
      'discover' | 'prepare' | 'execute' | 'verify',
      (string | { tool: string; arguments: Record<string, unknown> })[]
    >;
    const calls = (phase: keyof typeof quickRun) =>
      quickRun[phase].filter((item) => typeof item !== 'string');
    expect(calls('discover').map((item) => item.tool)).toEqual([
      'list_sessions',
      'list_scenes',
      'list_scene_actions',
    ]);
    expect(calls('execute').map((item) => item.tool)).toEqual(['run_scene_action', 'get_scene_action_run']);
    for (const phase of ['discover', 'prepare', 'execute', 'verify'] as const)
      for (const item of calls(phase)) expect(() => parseTool(item.tool, item.arguments)).not.toThrow();
    expect(JSON.stringify(quickRun.prepare)).toContain('基线');
    expect(JSON.stringify(quickRun.verify)).toContain('独立确认');
    expect(JSON.stringify(quickRun.verify)).toContain('401/刷新循环');
  });

  it('explains target-to-key resolution and archives shared definitions only in scenes.json', () => {
    const reusable = getUsageGuide('workflow').reusable as {
      fields: Record<string, string>;
      authoring: string[];
    };
    expect(reusable.fields.targets).toContain('steps[].target');
    expect(reusable.fields.targets).toContain('真实 Key');
    expect(reusable.fields.targets).toContain('每步重新定位');
    const authoring = reusable.authoring.join('\n');
    expect(authoring).toContain('纯操作 Scene');
    expect(authoring).toContain('call 和显式 inputs');
    expect(authoring).toContain('hide_keyboard');
    expect(authoring).toContain('不增加第二份动作配置');
  });

  it('keeps reusable action prompts on saved execution followed by independent evidence', () => {
    const run = getMcpPrompt('run_scene_action').messages[0].content.text;
    for (const requirement of [
      '真实 Key',
      '无需每步 find_widget',
      '请求/消息基线',
      '最终 UI',
      '401/刷新循环',
      'Mock 503',
      'TIMEOUT',
    ])
      expect(run).toContain(requirement);
    const ui = getMcpPrompt('flutter_ui').messages[0].content.text;
    expect(ui).toContain('先 list_scenes / list_scene_actions');
    expect(ui).toContain('选择器失效或结果异常时才 get_ui_snapshot');
    expect(ui).toContain('hide_keyboard');
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

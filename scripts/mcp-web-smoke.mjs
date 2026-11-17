import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWebMcpFixture } from './web-mcp-fixture.mjs';
import { until } from './web-test-support.mjs';
const fixture = await createWebMcpFixture();
const artifact = resolve(
  'artifacts/web-flutter-runtime/phase-07',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(artifact, { recursive: true });
const checks = [],
  runs = [];
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
};
const client = new Client({ name: 'production-web-stdio-acceptance', version: '1.0.0' });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/mcp-bridge.cjs'), '--registry', fixture.registry, '--workspace', fixture.root],
      stderr: 'pipe',
    }),
  );
  const call = async (name, args = {}) => {
    const result = await client.callTool({
      name,
      arguments: { ...(name === 'list_sessions' ? {} : { sessionId: fixture.sessionId }), ...args },
    });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  check(
    'built bridge discovers tools',
    (await client.listTools()).tools.some((t) => t.name === 'run_test'),
  );
  check(
    'offline browser prompt',
    (await client.getPrompt({ name: 'create_browser_context' })).messages.length > 0,
  );
  check(
    'offline capability navigation',
    (await client.getPrompt({ name: 'capabilities' })).messages.some((m) => m.content.text.includes('Web')),
  );
  check(
    'session discovery',
    (await call('list_sessions')).sessions.some((s) => s.sessionId === fixture.sessionId),
  );
  for (const kind of ['html', 'react', 'vue']) {
    const context = await call('create_browser_context');
    const target = { runtimeId: context.runtimeId, generation: context.generation };
    await call('reload_rules', { target });
    await call('activate_scene', { target, sceneId: 'web' });
    const page = await call('open_browser_page', { target, url: fixture.url + '/' + kind });
    const selected = { ...target, pageId: page.pageId };
    await call('wait_for_widget', { target: selected, selector: fixture.sel('fetch'), state: 'actionable' });
    check(
      kind + ' Scene action discovered',
      (await call('list_scene_actions', { target, sceneId: 'web' })).actions.some((a) => a.id === 'fetch'),
    );
    const action = await call('run_scene_action', { target: selected, sceneId: 'web', actionId: 'fetch' });
    let actionRun;
    await until(async () => {
      actionRun = await call('get_scene_action_run', { target, runId: action.runId });
      return actionRun.run.status !== 'running';
    }, 'action terminal');
    check(kind + ' Scene action completed', actionRun.run.status === 'completed');
    const history = await call('get_requests', { target, path: '/value' });
    const detail = await call('get_request', { target, id: history.items[0].id });
    check(
      kind + ' HTTP Mock rule and body',
      detail.requestRuleId === 'web-value' && JSON.parse(detail.response.body).marker === 'web-only',
    );
    const test = await call('run_test', { target: selected, testId: 'order-success' });
    let testRun;
    await until(
      async () => {
        testRun = await call('get_test_run', { target, runId: test.runId });
        return testRun.run.status !== 'running';
      },
      'business test terminal',
      20000,
    );
    runs.push(testRun);
    check(kind + ' HTTP WS UI business assertions', testRun.run.status === 'passed');
    check(kind + ' recursive secret redaction', !JSON.stringify(testRun).includes('private-amount-9381'));
    const screen = await client.callTool({
      name: 'take_screenshot',
      arguments: { sessionId: fixture.sessionId, target: selected, source: 'web', mode: 'screen' },
    });
    check(
      kind + ' actual PNG screenshot',
      screen.content.some((c) => c.type === 'image' && c.mimeType === 'image/png'),
    );
    const image = screen.content.find((c) => c.type === 'image');
    await writeFile(join(artifact, kind + '.png'), Buffer.from(image.data, 'base64'));
    await call('close_browser_context', { target });
  }
  check(
    'Mock order/value requests never hit upstream',
    !fixture.upstream.some((p) => p === '/orders' || p === '/value'),
  );
  if (process.env.MCP_WEB_AGENT === 'codex') {
    // Reuse only the user's selected model endpoint, never their MCP servers,
    // hooks, project settings or credentials in command arguments/artifacts.
    const config = parseToml(await readFile(join(homedir(), '.codex/config.toml'), 'utf8'));
    const provider = config.model_providers?.[config.model_provider];
    const agentEnv = { ...process.env };
    const providerArgs = [];
    if (provider?.experimental_bearer_token) {
      agentEnv.PILOT_ACCEPTANCE_API_KEY = provider.experimental_bearer_token;
      for (const [key, value] of Object.entries({
        model: config.model,
        model_provider: 'acceptance',
        'model_providers.acceptance.name': 'Existing user model endpoint',
        'model_providers.acceptance.base_url': provider.base_url,
        'model_providers.acceptance.wire_api': provider.wire_api ?? 'responses',
        'model_providers.acceptance.requires_openai_auth': false,
        'model_providers.acceptance.env_key': 'PILOT_ACCEPTANCE_API_KEY',
      }))
        providerArgs.push('-c', key + '=' + JSON.stringify(value));
    }
    const start = fixture.calls.length;
    const allowedTools = [
      'list_sessions',
      'get_usage_guide',
      'get_browser_status',
      'create_browser_context',
      'list_browser_pages',
      'open_browser_page',
      'close_browser_context',
      'list_scenes',
      'list_scene_actions',
      'list_tests',
      'activate_scene',
      'run_scene_action',
      'get_scene_action_run',
      'get_requests',
      'get_request',
      'run_test',
      'get_test_run',
      'get_ui_snapshot',
    ];
    for (const tool of allowedTools)
      providerArgs.push('-c', `mcp_servers.flutter-pilot.tools.${tool}.approval_mode="approve"`);
    providerArgs.push('-c', 'mcp_servers.flutter-pilot.enabled_tools=' + JSON.stringify(allowedTools));
    const prompt = `You are testing the installed flutter-pilot MCP server against an isolated local fixture. Use only this MCP server; do not use shell, file tools, other servers, or delegate. First discover sessions and read the Web usage guide. Create a browser Context, list Scenes/actions/tests, explicitly activate Scene web, open ${fixture.url}/react, run Scene web action fetch and confirm completed by querying its run. Query /value HTTP history and detail and verify web-only and rule web-value, then run test order-success on the same Page, poll get_test_run until terminal, query final UI and confirm order confirmed. Do not retry submissions automatically. Report exact runId and assertions. Close your Context after collecting evidence. The task succeeds only with the business test passed.`;
    const args = [
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
      '-C',
      fixture.root,
      '-c',
      'approval_policy="never"',
      '-c',
      'features.shell_tool=false',
      '-c',
      'mcp_servers.flutter-pilot.command=' + JSON.stringify(process.execPath),
      '-c',
      'mcp_servers.flutter-pilot.args=' +
        JSON.stringify([
          resolve('dist/mcp-bridge.cjs'),
          '--registry',
          fixture.registry,
          '--workspace',
          fixture.root,
        ]),
      ...providerArgs,
      prompt,
    ];
    const result = await new Promise((done, reject) => {
      const child = spawn('codex', args, {
        cwd: fixture.root,
        env: agentEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
      child.stdout.on('data', (v) => (stdout += v));
      child.stderr.on('data', (v) => (stderr += v));
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        done({ code, signal, stdout, stderr });
      });
    });
    await writeFile(join(artifact, 'agent.json'), JSON.stringify(result, null, 2));
    const actual = fixture.calls.slice(start);
    await writeFile(join(artifact, 'agent-tool-calls.json'), JSON.stringify(actual, null, 2));
    check('real Agent client exits successfully', result.code === 0);
    for (const tool of [
      'create_browser_context',
      'activate_scene',
      'run_scene_action',
      'get_scene_action_run',
      'get_requests',
      'get_request',
      'run_test',
      'get_test_run',
      'get_ui_snapshot',
      'close_browser_context',
    ])
      check(
        'real Agent called ' + tool,
        actual.some((c) => c.tool === tool),
      );
    check(
      'real Agent queried passed business result',
      actual.some((c) => c.tool === 'get_test_run' && c.status === 'passed'),
    );
  }
  await writeFile(
    join(artifact, 'report.json'),
    JSON.stringify(
      { checks, passed: checks.length, runs, calls: fixture.calls, upstream: fixture.upstream },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ artifact, passed: checks.length }));
} finally {
  await client.close();
  await fixture.dispose();
}

// Real CLI MCP loading and tool invocation against isolated local protocol fixtures.
// No credentials, user configuration, model service, or user's Flutter App is used.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const temporary = await realpath(await mkdtemp(join(tmpdir(), 'flutter-pilot-agent-smoke-')));
const results = [];
const processes = new Set();
const server = createServer();
const reportPath = resolve(process.env.MCP_AGENT_REPORT ?? 'artifacts/mcp-agent-smoke.json');
const protocolEvents = [];
let modelCalls = 0;
function run(command, args, env, cwd, timeout = 25000) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.add(child);
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', () => undefined);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      processes.delete(child);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}
async function codexAppServerCall(env, cwd) {
  const child = spawn('codex', ['app-server', '--stdio'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  processes.add(child);
  const pending = new Map();
  let sequence = 0,
    buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'),
        line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const value = JSON.parse(line);
        const item = pending.get(value.id);
        if (item) {
          pending.delete(value.id);
          value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result);
        }
      } catch {
        /* Non-protocol diagnostics. */
      }
    }
  });
  child.stderr.on('data', () => undefined);
  const call = (method, params) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('app-server request timeout'));
        }, 10000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveCall(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  try {
    await call('initialize', {
      clientInfo: { name: 'isolated_mcp_fixture', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const thread = await call('thread/start', { cwd, approvalPolicy: 'never', model: 'gpt-5.5' });
    const inventory = await call('mcpServerStatus/list', {
      threadId: thread.thread.id,
      serverName: 'flutter-pilot',
    });
    const result = await call('mcpServer/tool/call', {
      threadId: thread.thread.id,
      server: 'flutter-pilot',
      tool: 'verify_echo',
      arguments: { marker: 'app-server-fixture' },
    });
    return { success: !result.isError, inventoryFound: JSON.stringify(inventory).includes('verify_echo') };
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    processes.delete(child);
  }
}

function toolsIn(body) {
  return (body.tools ?? []).flatMap((tool) =>
    tool.name ? [tool.name] : tool.function?.name ? [tool.function.name] : [],
  );
}
server.on('request', async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    protocolEvents.push({
      invalidPath: request.url,
      method: request.method,
      contentType: request.headers['content-type'],
      rawPrefix: raw.slice(0, 100),
    });
    response.writeHead(400);
    response.end();
    return;
  }
  modelCalls++;
  protocolEvents.push({
    path: request.url,
    toolNames: toolsIn(body).filter((name) => name.includes('verify_echo')),
  });
  const names = toolsIn(body);
  const toolName = names.find((name) => name.includes('verify_echo'));
  const claude = request.url.includes('/messages');
  const priorCall = claude
    ? JSON.stringify(body.messages ?? []).includes('fixture-tool-call')
    : JSON.stringify(body.input ?? []).includes('fixture-tool-call');
  if (!priorCall && !toolName) {
    protocolEvents.push({
      path: request.url,
      tools: names,
      error: 'fixture tool missing from model request',
    });
  }
  if (claude) {
    const content =
      priorCall || !toolName
        ? [{ type: 'text', text: 'MCP fixture completed.' }]
        : [{ type: 'tool_use', id: 'fixture-tool-call', name: toolName, input: { marker: 'cli-fixture' } }];
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content,
        stop_reason: priorCall || !toolName ? 'end_turn' : 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    );
  } else {
    response.setHeader('content-type', 'text/event-stream');
    const item =
      priorCall || !toolName
        ? {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'MCP fixture completed.', annotations: [] }],
          }
        : {
            id: 'fc_fixture',
            type: 'function_call',
            call_id: 'fixture-tool-call',
            name: toolName,
            arguments: '{"marker":"cli-fixture"}',
            status: 'completed',
          };
    const completed = {
      id: `resp_${modelCalls}`,
      object: 'response',
      status: 'completed',
      model: 'fixture',
      output: [item],
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
    };
    for (const [event, data] of [
      ['response.created', { response: { ...completed, status: 'in_progress', output: [] } }],
      ['response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response: completed }],
    ])
      response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    response.end();
  }
});
try {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  await build({
    entryPoints: ['src/mcp/adapters.ts'],
    outfile: join(temporary, 'adapter.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const { AgentAdapterManager } = createRequire(import.meta.url)(join(temporary, 'adapter.cjs'));
  const bridgeRoot = join(temporary, 'bridge');
  await mkdir(bridgeRoot);
  const events = join(temporary, 'events.jsonl');
  await writeFile(
    join(bridgeRoot, 'bridge.cjs'),
    `
const fs=require('node:fs'),readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{try{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({method:m.method,params:m.method==='tools/call'?m.params:undefined})+'\\n');if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'flutter-pilot-cli-fixture',version:'1.0.0'}};if(m.method==='tools/list')result={tools:[{name:'verify_echo',description:'Verify the isolated MCP client fixture',inputSchema:{type:'object',properties:{marker:{type:'string'}},required:['marker'],additionalProperties:false}}]};if(m.method==='tools/call')result={content:[{type:'text',text:'verified:'+m.params.arguments.marker}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}catch{}});
`,
  );
  for (const agent of ['codex-cli', 'claude']) {
    for (const scope of ['project', 'global']) {
      const directory = join(temporary, `${agent}-${scope}`),
        workspace = join(directory, 'project'),
        home = join(directory, 'home'),
        codexHome = join(home, '.codex');
      await mkdir(workspace, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      const env = {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ENABLE_TOOL_SEARCH: 'false',
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_API_KEY: 'local-fixture',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CODEX_API_KEY: 'local-fixture',
        OPENAI_API_KEY: 'local-fixture',
        OTEL_SDK_DISABLED: 'true',
      };
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      for (const key of Object.keys(env))
        if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') delete env[key];
      env.RUST_LOG = 'error';
      await writeFile(
        join(codexHome, 'config.toml'),
        `model="gpt-5.5"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local isolated fixture"\nbase_url=${JSON.stringify(base)}\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(workspace)}]\ntrust_level="trusted"\n`,
      );
      const manager = new AgentAdapterManager({
        workspace,
        bridgeRoot,
        nodePath: process.execPath,
        home,
        codexHome,
        env,
        detectClient: async () => true,
      });
      const state = await manager.adapt(agent, scope);
      const command = agent === 'claude' ? 'claude' : 'codex';
      const get = await run(
        command,
        ['mcp', 'get', 'flutter-pilot', ...(agent === 'claude' ? [] : ['--json'])],
        env,
        workspace,
      );
      assert.equal(get.code, 0, `${agent} ${scope} cannot load generated config`);
      const before = (await readFile(events, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
      const args = [
        '-p',
        'Call the verify_echo MCP tool with marker cli-fixture, then finish.',
        '--model',
        'fixture',
        '--output-format',
        'json',
        '--allowedTools',
        'mcp__flutter-pilot__verify_echo',
        ...(scope === 'project' ? ['--mcp-config', state.path, '--strict-mcp-config'] : []),
      ];
      let execution = { code: 0, signal: null, stdout: '', stderr: '' };
      let appServer;
      if (agent === 'codex-cli') {
        try {
          appServer = await codexAppServerCall(env, workspace);
        } catch (error) {
          execution = { ...execution, code: 1, stderr: error.message };
        }
      } else execution = await run(command, args, env, workspace);
      const entries = (await readFile(events, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .slice(before)
        .map(JSON.parse);
      results.push({
        client: agent,
        scope,
        configLoaded: true,
        appServer,
        exit: execution.code,
        signal: execution.signal,
        initialized: entries.some((entry) => entry.method === 'initialize'),
        toolsListed: entries.some((entry) => entry.method === 'tools/list'),
        toolCalled: entries.some(
          (entry) => entry.method === 'tools/call' && entry.params.name === 'verify_echo',
        ),
        diagnostic: execution.code === 0 ? undefined : (execution.stderr + execution.stdout).slice(-3000),
      });
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    results,
    modelFixtureCalls: modelCalls,
    protocolEvents,
    boundary:
      'Claude Code uses real CLI print mode with an isolated local model-protocol fixture; Codex uses real CLI app-server MCP inventory and direct tool-call APIs. Both project/global configurations initialize, discover and invoke tools. This is not production model reasoning or Flutter UI acceptance. Codex desktop App itself is not installed as a separately identifiable Codex.app and remains unverified.',
  };
  await mkdir(join(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert(
    results.every(
      (result) => result.configLoaded && result.initialized && result.toolsListed && result.toolCalled,
    ),
    'Some CLI tool invocations did not complete; inspect report',
  );
} finally {
  for (const child of processes) child.kill('SIGTERM');
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temporary, { recursive: true, force: true });
}

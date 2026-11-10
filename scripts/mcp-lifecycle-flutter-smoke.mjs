// Independent Flutter fixture + SDK debug adapter; never starts an IDE or controls a user app.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve('.');
const flutter = process.env.FLUTTER ?? 'flutter';
const device = process.env.VM_FLUTTER_DEVICE;
if (!device) throw new Error('设置 VM_FLUTTER_DEVICE 为测试模拟器 ID');
const temp = await mkdtemp(join(tmpdir(), 'api-mocks-lifecycle-'));
const run = (args) =>
  new Promise((done, reject) => {
    const child = spawn(flutter, args, { stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? done() : reject(new Error(output.slice(-3000)))));
  });
const wait = async (predicate, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('fixture timeout');
};
await run(['create', '--platforms=ios', '--project-name=api_mocks_lifecycle_fixture', temp]);
await run(['pub', 'add', '--offline', '--directory', temp, 'dio:^5.9.0']);
const sourcePath = join(temp, 'lib/main.dart');
const source = `import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:dio/dio.dart';
void main() { jsonDecode('{}'); runApp(const MaterialApp(home: Fixture())); }
class Fixture extends StatefulWidget { const Fixture({super.key}); @override State<Fixture> createState() => _FixtureState(); }
class _FixtureState extends State<Fixture> {
 final dio = Dio(); int count = 0; String response = '';
 @override Widget build(BuildContext context) => Scaffold(body: SafeArea(child: Column(children: [
 Text('version-one', key: const ValueKey('label')),
 Text('count:$count', key: const ValueKey('count')),
 ElevatedButton(key: const ValueKey('increment'), onPressed: () => setState(() => count++), child: const Text('Increment')),
 ElevatedButton(key: const ValueKey('fetch'), onPressed: () async { final value = await dio.get('https://lifecycle.fixture.invalid/value'); if (mounted) setState(() => response = value.data['marker']); }, child: const Text('Fetch')),
 Text(response, key: const ValueKey('response')),
 ])));
}
`;
await writeFile(sourcePath, source);
await build({
  entryPoints: [
    'src/mcp/lifecycle.ts',
    'src/mcp/bridge.ts',
    'src/mcp/server.ts',
    'src/vm/session.ts',
    'src/vm/ui.ts',
    'src/mcp/network.ts',
    'src/store.ts',
  ],
  outdir: join(temp, 'js'),
  platform: 'node',
  format: 'cjs',
  bundle: true,
  outExtension: { '.js': '.cjs' },
});
const require = createRequire(import.meta.url);
const load = (name) => require(join(temp, 'js', name + '.cjs'));
const { McpLifecycleController } = load('mcp/lifecycle');
const { McpSessionServer } = load('mcp/server');
const { VmSession } = load('vm/session');
const { VmUiController } = load('vm/ui');
const { McpNetworkController } = load('mcp/network');
const { RuleStore } = load('store');
const child = spawn(flutter, ['debug_adapter'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = Buffer.alloc(0),
  sequence = 0,
  vmUri,
  initialized = false,
  appStarted = false;
let dapLog = '';
const pending = new Map();
const request = (command, args = {}, timeout = 120000) =>
  new Promise((done, reject) => {
    const seq = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(seq);
      reject(new Error(`DAP timeout ${command}`));
    }, timeout);
    pending.set(seq, (response) => {
      clearTimeout(timer);
      response.success ? done(response.body) : reject(new Error(`DAP failure ${command}`));
    });
    const body = JSON.stringify({ seq, type: 'request', command, arguments: args });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
child.stdout.on('data', (data) => {
  buffer = Buffer.concat([buffer, data]);
  for (;;) {
    const sep = buffer.indexOf('\r\n\r\n');
    if (sep < 0) break;
    const size = Number(
      buffer
        .subarray(0, sep)
        .toString()
        .match(/Content-Length: (\d+)/i)?.[1],
    );
    if (buffer.length < sep + 4 + size) break;
    const message = JSON.parse(buffer.subarray(sep + 4, sep + 4 + size).toString());
    buffer = buffer.subarray(sep + 4 + size);
    if (message.type === 'response') {
      pending.get(message.request_seq)?.(message);
      pending.delete(message.request_seq);
    }
    if (message.event === 'initialized') initialized = true;
    if (message.event === 'dart.debuggerUris') vmUri = message.body.vmServiceUri;
    if (message.event === 'flutter.appStarted' || message.event === 'flutter.appStart') appStarted = true;
    if (message.event === 'output') dapLog += message.body.output;
  }
});
child.stderr.on('data', () => {});
const vm = new VmSession(
  join(temp, 'history'),
  { retentionDays: 7, maxRecords: 1000, maxBodyBytes: 1048576 },
  join(root, 'resources/vm/interceptor.dart.txt'),
);
const ui = new VmUiController(vm.client, { templatePath: join(root, 'resources/vm/ui.dart.txt') });
let mcp,
  ipc,
  passed = 0;
const check = (value, name) => {
  assert.ok(value, name);
  passed++;
  console.log(`PASS ${name}`);
};
try {
  await request('initialize', {
    adapterID: 'dart',
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
  });
  const launch = request('launch', {
    cwd: temp,
    program: join(temp, 'lib/main.dart'),
    toolArgs: ['--no-pub', '-d', device],
    console: 'internalConsole',
  });
  await wait(() => initialized, 30000);
  await request('configurationDone');
  await launch;
  await wait(() => vmUri && appStarted, 120000);
  const address = new URL(vmUri);
  address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
  if (!address.pathname.endsWith('/ws')) address.pathname = address.pathname.replace(/\/?$/, '/ws');
  await vm.connect(address.toString(), []);
  check((await ui.probe()).supported, 'Flutter UI available through Debug VM');
  const store = new RuleStore(join(temp, '.api-mocks'));
  const network = new McpNetworkController({
    httpRulesPath: store.file,
    wsRulesPath: join(temp, '.api-mocks/ws-rules.json'),
    readHttpRules: async () => (await store.load()).rules,
    readWsRules: async () => [],
    applyHttpRules: (rules) => vm.updateRules(rules),
    applyWsRules: async () => {},
    status: () => ({
      vmConnected: vm.state.status === 'connected',
      http: {
        captureEnabled: vm.state.captureEnabled,
        mockEnabled: vm.state.mockEnabled,
        runtimeApplied: vm.state.mockEnabled && vm.state.instances > 0,
      },
    }),
    listHttp: (query) => vm.store.list(query),
    getHttp: (id) => vm.store.get(id),
    connections: async () => [],
    messages: async () => ({ items: [], total: 0 }),
    setCapture: (_, enabled) => vm.setCaptureEnabled(enabled),
    setMock: (_, enabled) => vm.setMockEnabled(enabled),
    injectWs: async () => {},
    sendWs: async () => {},
  });
  const lifecycle = new McpLifecycleController({
    target: () => ({ debugSessionId: 'independent-flutter-dap' }),
    connected: () => vm.state.status === 'connected',
    rpc: vm.client,
    control: async (_, action) => {
      await request(action === 'hot_reload' ? 'hotReload' : 'hotRestart', { reason: 'manual' }, 40000);
    },
    invalidateUi: () => ui.invalidate(),
    refresh: (signal) => vm.refreshAfterLifecycle(signal),
    networkStatus: () => network.status(),
  });
  const registryRoot = join(temp, 'registry'),
    sessionId = 'independent-lifecycle-mcp';
  ipc = new McpSessionServer({
    registryRoot,
    workspace: temp,
    sessionId,
    name: 'Independent lifecycle fixture',
    describe: () => ({ lifecycle: lifecycle.status() }),
    call: async (tool, args, context) => {
      if (tool === 'hot_reload' || tool === 'hot_restart')
        return lifecycle.execute(tool, args.timeoutMs, context.signal);
      if (tool === 'tap' || tool === 'find_widget')
        return ui.execute(tool, { ...args, key: { type: 'string', value: args.key } });
      return network.execute(tool, args, context.signal);
    },
  });
  await ipc.start();
  mcp = new Client({ name: 'real-lifecycle-smoke', version: '1' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(temp, 'js/mcp/bridge.cjs'), '--registry', registryRoot, '--workspace', temp],
      stderr: 'pipe',
    }),
  );
  const call = async (name, args = {}) => {
    const result = await mcp.callTool({ name, arguments: { sessionId, ...args } });
    if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const text = async (key) => (await call('find_widget', { key })).widget?.text;
  const tools = (await mcp.listTools()).tools;
  check(
    tools.some((x) => x.name === 'hot_reload') && tools.some((x) => x.name === 'hot_restart'),
    'both lifecycle MCP tools discoverable',
  );
  await call('tap', { key: 'increment' });
  await wait(async () => (await text('count')) === 'count:1');
  await writeFile(sourcePath, source.replace('version-one', 'version-two'));
  const reload = await call('hot_reload');
  check(reload.completed && reload.statePreserved, 'hot_reload confirmed through MCP');
  check((await text('count')) === 'count:1', 'hot_reload preserves state');
  check((await text('label')) === 'version-two', 'hot_reload applies saved source');
  const unchanged = await mcp.callTool({ name: 'hot_reload', arguments: { sessionId, timeoutMs: 1500 } });
  check(
    unchanged.isError && !unchanged.structuredContent.completed,
    'no runtime reload evidence is reported as unconfirmed',
  );
  const document = {
    version: 1,
    rules: [
      {
        id: 'lifecycle-mock',
        name: 'scenario',
        enabled: true,
        priority: 1,
        match: { host: 'lifecycle.fixture.invalid', path: '/value' },
        mock: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ marker: 'first-state' }),
        },
      },
    ],
  };
  await store.save(document);
  await call('reload_rules', { domain: 'http' });
  await call('set_mock_enabled', { domain: 'http', enabled: true });
  await call('tap', { key: 'fetch' });
  await wait(async () => (await text('response')) === 'first-state');
  check(true, 'first Mock scenario reaches UI');
  document.rules[0].mock.body = JSON.stringify({ marker: 'second-state' });
  await store.save(document);
  check((await call('reload_rules', { domain: 'http' })).ok, 'edited API rules reload before restart');
  const restart = await call('hot_restart');
  check(restart.completed && !restart.statePreserved, 'hot_restart confirmed through MCP');
  check((await text('count')) === 'count:0', 'hot_restart resets application memory');
  check(restart.network.http.runtimeApplied, 'enabled Mock reapplied to new isolate');
  await call('tap', { key: 'fetch' });
  await wait(async () => (await text('response')) === 'second-state');
  check(true, 'edited API restart flow renders new UI state');
  const records = await wait(async () => {
    const r = await call('get_requests', { host: 'lifecycle.fixture.invalid' });
    return r.items.some((x) => x.requestRuleId === 'lifecycle-mock') && r.items.length >= 2 ? r : undefined;
  });
  check(records.items.filter((x) => x.mocked).length >= 2, 'network evidence records both Mock scenarios');
  // A failed compilation must not be reported as successful merely because DAP acknowledged it.
  await writeFile(sourcePath, source + '\nthis is invalid Dart;');
  const failed = await mcp.callTool({ name: 'hot_reload', arguments: { sessionId, timeoutMs: 5000 } });
  check(
    failed.isError && failed.structuredContent.completed === false,
    'compile failure does not report successful reload',
  );
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(
    join(root, 'artifacts/mcp-lifecycle-flutter-report.json'),
    JSON.stringify(
      {
        passed,
        device,
        sdkDebugAdapter: true,
        ideGuiStarted: false,
        userAppControlled: false,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed }));
} catch (error) {
  // Keep the log private; it can contain VM authentication addresses.
  await writeFile(join(temp, 'dap.log'), dapLog);
  if (process.env.KEEP_UI_FIXTURE === '1') console.error(`私有诊断保存在 ${temp}/dap.log`);
  throw error;
} finally {
  await mcp?.close();
  await ipc?.stop();
  await ui.dispose();
  await vm.dispose();
  await request('disconnect', { terminateDebuggee: true }, 10000).catch(() => {});
  child.kill('SIGTERM');
  if (process.env.KEEP_UI_FIXTURE !== '1') await rm(temp, { recursive: true, force: true });
}

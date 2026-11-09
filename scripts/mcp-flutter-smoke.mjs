// Independent fixture only: no connection to or edits of the user's application.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve('.');
const flutter = process.env.FLUTTER ?? 'flutter';
const device = process.env.VM_FLUTTER_DEVICE;
if (!device) throw new Error('设置 VM_FLUTTER_DEVICE 为测试模拟器 ID');
const temp = process.env.UI_FIXTURE_DIR ?? (await mkdtemp(join(tmpdir(), 'api-mocks-ui-')));
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(flutter, args, { stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', (value) => (output += value));
    child.stderr.on('data', (value) => (output += value));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(output.slice(-4000)))));
  });
if (!process.env.UI_FIXTURE_DIR)
  await run(['create', '--platforms=ios', '--project-name=api_mocks_ui_fixture', temp]);
await run(['pub', 'add', '--offline', '--directory', temp, 'dio:^5.9.0']);
const source = join(temp, 'lib/main.dart');
await writeFile(
  source,
  `import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
void main() { jsonDecode('{}'); runApp(const MaterialApp(home: Fixture())); }
class Fixture extends StatefulWidget { const Fixture({super.key}); @override State<Fixture> createState() => _FixtureState(); }
class _FixtureState extends State<Fixture> {
 final dio = Dio(); int taps = 0; String value = ''; bool covered = true;
 @override Widget build(BuildContext context) => Scaffold(body: SafeArea(child: Column(children: [
  Text('taps:$taps', key: const ValueKey('status')),
  ElevatedButton(key: const ValueKey('fetch'), onPressed: () async { final response = await dio.get('https://mcp.fixture.invalid/value'); if (mounted) setState(() => value = response.data['marker'].toString()); }, child: const Text('Fetch')),
  ElevatedButton(key: const ValueKey('submit'), onPressed: () => setState(() => taps++), child: const Text('Submit')),
  ElevatedButton(key: const ValueKey<int>(42), onPressed: () => setState(() => taps++), child: const Text('Integer')),
  const ElevatedButton(key: ValueKey('disabled'), onPressed: null, child: Text('Disabled')),
  TextField(key: const ValueKey('input'), inputFormatters: [LengthLimitingTextInputFormatter(5)], onChanged: (text) => setState(() => value = text)),
  Text(value, key: const ValueKey('echo')),
  const TextField(key: ValueKey('readonly'), readOnly: true),
  Row(children: [Container(key: const ValueKey('left'), child: ElevatedButton(key: const ValueKey('duplicate'), onPressed: () {}, child: const Text('Left'))), Container(key: const ValueKey('right'), child: ElevatedButton(key: const ValueKey('duplicate'), onPressed: () {}, child: const Text('Right')))]),
  SizedBox(height: 45, child: Stack(children: [ElevatedButton(key: const ValueKey('covered'), onPressed: () => setState(() => taps++), child: const Text('Covered')), if (covered) Positioned.fill(child: GestureDetector(onTap: () {}, child: const ColoredBox(color: Colors.black)))])),
  ElevatedButton(onPressed: () {}, child: const Text('Missing key')),
  ElevatedButton(key: UniqueKey(), onPressed: () {}, child: const Text('Unstable key')),
  Expanded(child: ListView.builder(key: const ValueKey('list'), itemCount: 80, itemExtent: 48, itemBuilder: (context, index) => Text('Item $index', key: ValueKey('item.$index')))),
 ])));
}
`,
);
await build({
  entryPoints: [
    'src/vm/ui.ts',
    'src/vm/session.ts',
    'src/mcp/server.ts',
    'src/mcp/network.ts',
    'src/store.ts',
    'src/mcp/bridge.ts',
  ],
  outdir: join(temp, 'js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
});
const require = createRequire(import.meta.url);
const { VmUiController } = require(join(temp, 'js/vm/ui.cjs'));
const { VmSession } = require(join(temp, 'js/vm/session.cjs'));
const { McpSessionServer } = require(join(temp, 'js/mcp/server.cjs'));
const { McpNetworkController } = require(join(temp, 'js/mcp/network.cjs'));
const { RuleStore } = require(join(temp, 'js/store.cjs'));
const hash = async () =>
  createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
const before = await hash();
let buffer = '',
  uri,
  appId,
  started = false;
const commands = new Map();
let sequence = 0;
const child = spawn(flutter, ['run', '--machine', '--no-pub', '-d', device], {
  cwd: temp,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const exited = new Promise((resolve) => child.once('exit', resolve));
child.stdout.on('data', (value) => {
  buffer += value;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n'),
      line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    try {
      for (const message of JSON.parse(line)) {
        if (message.event === 'app.start') appId = message.params.appId;
        if (message.event === 'app.debugPort') uri = message.params.wsUri;
        if (message.event === 'app.started') started = true;
        if (message.id && commands.has(message.id)) {
          commands.get(message.id)(message);
          commands.delete(message.id);
        }
      }
    } catch {}
  }
});
child.stderr.on('data', (value) =>
  process.stderr.write(String(value).replace(/(?:ws|http):\/\/\S+/g, '[endpoint]')),
);
const waitFor = async (predicate, timeout = 120000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('fixture timeout');
};
const machine = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      commands.delete(id);
      reject(new Error('machine timeout'));
    }, 90000);
    commands.set(id, (message) => {
      clearTimeout(timer);
      message.error ? reject(new Error('machine error')) : resolve(message);
    });
    child.stdin.write(`${JSON.stringify([{ id, method, params }])}\n`);
  });
const vm = new VmSession(
  join(temp, 'history'),
  { retentionDays: 7, maxRecords: 1000, maxBodyBytes: 1048576 },
  join(root, 'resources/vm/interceptor.dart.txt'),
);
const client = vm.client;
const ui = new VmUiController(client, { templatePath: join(root, 'resources/vm/ui.dart.txt') });
let passed = 0;
let mcp, ipc;
const key = (value) => ({ type: typeof value === 'string' ? 'string' : 'int', value });
const check = (condition, label) => {
  assert.ok(condition, label);
  passed++;
  console.log(`PASS ${label}`);
};
try {
  await waitFor(() => uri && started);
  await vm.connect(uri, []);
  check((await ui.probe()).supported, 'VM UI capability');
  const store = new RuleStore(join(temp, '.api-mocks'));
  const network = new McpNetworkController({
    httpRulesPath: store.file,
    wsRulesPath: join(temp, '.api-mocks/ws-rules.json'),
    readHttpRules: async () => (await store.load()).rules,
    readWsRules: async () => [],
    applyHttpRules: async (rules) => {
      await vm.updateRules(rules);
    },
    applyWsRules: async () => {},
    status: () => ({
      vmConnected: vm.state.status === 'connected',
      http: {
        captureEnabled: vm.state.captureEnabled,
        mockEnabled: vm.state.mockEnabled,
        instances: vm.state.instances,
      },
    }),
    listHttp: (query) => vm.store.list(query),
    getHttp: (id) => vm.store.get(id),
    connections: async () => [],
    messages: async () => ({ items: [], total: 0 }),
    setCapture: async (domain, enabled) => {
      assert.equal(domain, 'http');
      await vm.setCaptureEnabled(enabled);
    },
    setMock: async (domain, enabled) => {
      assert.equal(domain, 'http');
      await vm.setMockEnabled(enabled);
    },
  });
  const registry = join(temp, 'registry');
  const sessionId = 'fixture-mcp-session';
  const uiTools = new Set([
    'get_ui_snapshot',
    'find_widget',
    'tap',
    'enter_text',
    'scroll',
    'wait_for_widget',
    'inspect_key_issues',
  ]);
  ipc = new McpSessionServer({
    registryRoot: registry,
    workspace: temp,
    sessionId,
    name: 'Independent Flutter fixture',
    describe: () => ({ connected: vm.state.status === 'connected', ui: true }),
    call: async (tool, args) =>
      uiTools.has(tool)
        ? ui.execute(tool, {
            ...args,
            ...(args.key !== undefined ? { key: key(args.key) } : {}),
            ...(args.ancestorKey !== undefined ? { ancestor: key(args.ancestorKey) } : {}),
            ...(args.targetKey !== undefined ? { targetKey: key(args.targetKey) } : {}),
          })
        : network.execute(tool, args),
  });
  await ipc.start();
  mcp = new Client({ name: 'real-flutter-mcp-sdk-client', version: '1.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(temp, 'js/mcp/bridge.cjs'), '--registry', registry, '--workspace', temp],
      stderr: 'pipe',
    }),
  );
  const call = async (name, args = {}) => {
    const result = await mcp.callTool({
      name,
      arguments: name === 'list_sessions' ? args : { sessionId, ...args },
    });
    if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  check(
    (await mcp.listTools()).tools.some((x) => x.name === 'tap'),
    'MCP tools discovery',
  );
  check((await call('list_sessions')).sessions[0].sessionId === sessionId, 'MCP stdio session discovery');
  check((await call('find_widget', { key: 'fetch' })).ok, 'MCP Key lookup');
  const state = await call('get_network_status');
  check(state.files.http === store.file, 'MCP exposes rule file location');
  await store.save({
    version: 1,
    rules: [
      {
        id: 'fixture-mock',
        name: 'fixture response',
        enabled: true,
        priority: 0,
        match: { host: 'mcp.fixture.invalid', path: '/value' },
        mock: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ marker: 'mcp-first' }),
        },
      },
    ],
  });
  const reload = await call('reload_rules', { domain: 'http' });
  check(reload.ok && reload.results.http.count === 1, 'edited rule file reloads via MCP');
  const mock = await call('set_mock_enabled', { domain: 'http', enabled: true });
  check(mock.http.mockEnabled && mock.http.instances === 1, 'MCP explicitly enables runtime mock');
  check((await call('tap', { key: 'fetch' })).ok, 'MCP pointer click triggers business request');
  await waitFor(async () => (await call('find_widget', { key: 'echo' })).widget?.text === 'mcp-first', 10000);
  check(true, 'UI receives mocked response from pointer click');
  const requests = await waitFor(async () => {
    const r = await call('get_requests', { host: 'mcp.fixture.invalid' });
    return r.items.length ? r : null;
  }, 10000);
  const detail = await call('get_request', { id: requests.items[0].id });
  check(
    detail.mocked === true && detail.requestRuleId === 'fixture-mock',
    'MCP network history identifies applied rule',
  );
  check(JSON.parse(detail.response.body).marker === 'mcp-first', 'MCP response detail matches UI');
  const rules = await store.load();
  rules.rules[0].mock.body = JSON.stringify({ marker: 'mcp-updated' });
  await store.save(rules);
  check((await call('reload_rules', { domain: 'http' })).ok, 'MCP resynchronizes edited active rule');
  check((await call('tap', { key: 'fetch' })).ok, 'MCP second action');
  await waitFor(
    async () => (await call('find_widget', { key: 'echo' })).widget?.text === 'mcp-updated',
    10000,
  );
  check(true, 'updated rule affects next UI action');
  await call('set_mock_enabled', { domain: 'http', enabled: false });
  check(!vm.state.mockEnabled, 'MCP disables runtime mock');
  check((await hash()) === before, 'fixture source unchanged during MCP operations');
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(
    join(root, 'artifacts/mcp-flutter-smoke-report.json'),
    JSON.stringify(
      {
        passed,
        device,
        fixture: temp,
        sourceUnchanged: true,
        flutter: '3.47.8',
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, fixture: temp }));
} finally {
  await ui.dispose();
  await mcp?.close();
  await ipc?.stop();
  await vm.dispose();
  if (appId) await machine('app.stop', { appId }).catch(() => {});
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGTERM');
  await exited;
  if (!process.env.UI_FIXTURE_DIR && process.env.KEEP_UI_FIXTURE !== '1')
    await rm(temp, { recursive: true, force: true });
}

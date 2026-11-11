// Independent fixture only: no connection to or edits of the user's application.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const root = resolve('.');
const flutter = process.env.FLUTTER ?? 'flutter';
const device = process.env.VM_FLUTTER_DEVICE;
if (!device) throw new Error('设置 VM_FLUTTER_DEVICE 为测试模拟器 ID');
const temp = process.env.UI_FIXTURE_DIR ?? (await mkdtemp(join(tmpdir(), 'flutter-pilot-ui-')));
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
  await run(['create', '--platforms=ios', '--project-name=flutter_pilot_ui_fixture', temp]);
const source = join(temp, 'lib/main.dart');
await writeFile(
  source,
  `import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
void main() { jsonDecode('{}'); runApp(const MaterialApp(home: Fixture())); }
class Fixture extends StatefulWidget { const Fixture({super.key}); @override State<Fixture> createState() => _FixtureState(); }
class _FixtureState extends State<Fixture> {
 int taps = 0; String value = ''; bool covered = true; bool cases = false;
 @override Widget build(BuildContext context) {
 if (cases) return Scaffold(body: SafeArea(child: Column(key: const ValueKey('mixed-page'), children: [
  ElevatedButton(onPressed: () {}, child: const Text('Unkeyed case button')),
  TextField(onChanged: (text) => setState(() => value = text)),
  Text(value, key: const ValueKey('case-echo')),
  SizedBox(key: const ValueKey('parallel-lists'), height: 200, child: Row(children: [
   Expanded(child: ListView.builder(key: const ValueKey('case-list-left'), itemCount: 50, itemExtent: 40, itemBuilder: (context, index) => Text('L$index', key: ValueKey('left.$index')))),
   Expanded(child: ListView.builder(key: const ValueKey('case-list-right'), itemCount: 50, itemExtent: 40, itemBuilder: (context, index) => Text('R$index', key: ValueKey('right.$index')))),
  ])),
 ])));
 return Scaffold(body: SafeArea(child: Column(children: [
  Text('taps:$taps', key: const ValueKey('status')),
  ElevatedButton(key: const ValueKey('cases'), onPressed: () => setState(() => cases = true), child: const Text('Regression cases')),
  ElevatedButton(key: const ValueKey('blur'), onPressed: () => FocusScope.of(context).unfocus(), child: const Text('Hide keyboard')),
  ElevatedButton(key: const ValueKey('submit'), onPressed: () => setState(() => taps++), child: const Text('Submit')),
  ElevatedButton(key: const ValueKey<int>(42), onPressed: () => setState(() => taps++), child: const Text('Integer')),
  const ElevatedButton(key: ValueKey('disabled'), onPressed: null, child: Text('Disabled')),
  const SizedBox(key: ValueKey('disabled-wrapper'), height: 40, child: ElevatedButton(onPressed: null, child: Text('Wrapped disabled'))),
  TextField(key: const ValueKey('input'), inputFormatters: [LengthLimitingTextInputFormatter(5)], onChanged: (text) => setState(() => value = text)),
  Text(value, key: const ValueKey('echo')),
  const TextField(key: ValueKey('readonly'), readOnly: true),
  Row(children: [Container(key: const ValueKey('left'), child: ElevatedButton(key: const ValueKey('duplicate'), onPressed: () {}, child: const Text('Left'))), Container(key: const ValueKey('right'), child: ElevatedButton(key: const ValueKey('duplicate'), onPressed: () {}, child: const Text('Right')))]),
  SizedBox(height: 45, child: Stack(children: [ElevatedButton(key: const ValueKey('covered'), onPressed: () => setState(() => taps++), child: const Text('Covered')), if (covered) Positioned.fill(child: GestureDetector(onTap: () {}, child: const ColoredBox(color: Colors.black)))])),
  ElevatedButton(onPressed: () {}, child: const Text('Missing key')),
  ElevatedButton(key: UniqueKey(), onPressed: () {}, child: const Text('Unstable key')),
  Expanded(child: ListView.builder(key: const ValueKey('list'), itemCount: 80, itemExtent: 48, itemBuilder: (context, index) => Text('Item $index', key: ValueKey('item.$index')))),
 ]))); }
}
`,
);
await build({
  entryPoints: ['src/vm/ui.ts', 'src/vm/client.ts'],
  outdir: join(temp, 'js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
});
const require = createRequire(import.meta.url);
const { VmServiceClient } = require(join(temp, 'js/client.cjs'));
const { VmUiController } = require(join(temp, 'js/ui.cjs'));
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
const client = new VmServiceClient();
const ui = new VmUiController(client, { templatePath: join(root, 'resources/vm/ui.dart.txt') });
let passed = 0;
const key = (value) => ({ type: typeof value === 'string' ? 'string' : 'int', value });
const invoke = async (tool, args = {}) => ui.execute(tool, args);
const check = (condition, label) => {
  assert.ok(condition, label);
  passed++;
  console.log(`PASS ${label}`);
};
try {
  await waitFor(() => uri && started);
  await client.connect(uri);
  await client.call('streamListen', { streamId: 'Extension' });
  await client.call('streamListen', { streamId: 'Isolate' });
  const probe = await ui.probe();
  console.log('probe', probe);
  check(probe.supported, 'runtime capability probe');
  let result = await invoke('find_widget', { key: key('submit') });
  console.log('find', JSON.stringify(result));
  check(result.ok, 'string Key');
  check((await invoke('find_widget', { key: key(42) })).ok, 'integer Key');
  check((await invoke('find_widget', { key: key('duplicate') })).code === 'AMBIGUOUS_KEY', 'duplicate Key');
  check((await invoke('find_widget', { key: key('duplicate'), ancestor: key('left') })).ok, 'ancestor scope');
  check(
    (await invoke('find_widget', { key: key('missing') })).code === 'NOT_FOUND',
    'absent Key is not missing-Key defect',
  );
  check((await invoke('tap', { key: key('disabled') })).code === 'NOT_ENABLED', 'disabled button');
  check(
    (await invoke('tap', { key: key('disabled-wrapper') })).code === 'NOT_ENABLED',
    'disabled descendant under stable wrapper',
  );
  check(
    (await invoke('find_widget', { key: key('disabled-wrapper') })).widget.enabled === false,
    'wrapper enabled state reflects descendant',
  );
  check(
    (await invoke('wait_for_widget', { key: key('disabled-wrapper'), state: 'actionable', timeoutMs: 150 }))
      .code === 'WAIT_TIMEOUT',
    'disabled wrapper is not actionable',
  );
  check(
    (await invoke('find_widget', { key: key('duplicate'), ancestor: key('left') })).widget.ancestorKeys.some(
      (x) => x.value === 'left',
    ),
    'snapshot preserves ancestor Key path',
  );
  check((await invoke('tap', { key: key('covered') })).code === 'NOT_HIT_TESTABLE', 'obscured button');
  check((await invoke('tap', { key: key('submit') })).ok, 'pointer click');
  result = await invoke('find_widget', { key: key('status') });
  check(result.widget.text === 'taps:1', 'pointer activates callback exactly once');
  result = await invoke('enter_text', { key: key('input'), text: '中文ABCDEF' });
  console.log('input', result);
  check(result.ok && result.formatted === true, 'text formatter respected');
  result = await invoke('find_widget', { key: key('echo') });
  check(result.widget.text === '中文ABC', 'onChanged and Chinese input');
  check(
    (await invoke('enter_text', { key: key('readonly'), text: 'no' })).code === 'NOT_ENABLED',
    'readonly input',
  );
  result = await invoke('inspect_key_issues');
  console.log('issues', JSON.stringify(result));
  check(result.ok && result.issues.some((x) => x.code === 'MISSING_KEY'), 'missing-Key diagnostics');
  check(
    result.issues.some((x) => x.code === 'UNSTABLE_KEY'),
    'unstable-Key diagnostics',
  );
  check(!result.issues.some((x) => x.type === 'EditableText'), 'stable ancestor input not misreported');
  check(
    result.issues.some((x) => x.source?.file),
    'creation source location',
  );
  check((await invoke('get_ui_snapshot', { limit: 3 })).truncated, 'bounded snapshot');
  check((await invoke('wait_for_widget', { key: key('missing'), condition: 'absent' })).ok, 'wait absent');
  check(
    (await invoke('wait_for_widget', { key: key('missing'), timeoutMs: 150 })).code === 'WAIT_TIMEOUT',
    'bounded wait timeout',
  );
  // Hide keyboard by clicking status outside the text field before list gestures.
  await invoke('tap', { key: key('blur') });
  check(
    (await invoke('scroll', { key: key('list'), direction: 'down', distance: 180 })).ok,
    'pointer list scroll',
  );
  check(
    (await invoke('scroll', { key: key('list'), targetKey: key('item.12'), maxSteps: 15, distance: 180 })).ok,
    'bounded scrolling creates lazy target',
  );
  check(
    (await invoke('scroll', { key: key('list'), targetKey: key('item.999'), maxSteps: 1 })).code ===
      'SCROLL_LIMIT',
    'bounded scroll limit',
  );
  const concurrent = await Promise.all([
    invoke('tap', { key: key('submit') }),
    invoke('tap', { key: key('submit') }),
  ]);
  check(
    concurrent.every((x) => x.ok),
    'serialized concurrent actions',
  );
  result = await invoke('find_widget', { key: key('status') });
  check(result.widget.text === 'taps:3', 'concurrent clicks execute once');
  await machine('app.restart', { appId, fullRestart: false, pause: false });
  check((await invoke('find_widget', { key: key('submit') })).ok, 'hot reload fresh lookup');
  const pending = invoke('wait_for_widget', { key: key('missing'), timeoutMs: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  ui.invalidate();
  check((await pending).code === 'SESSION_INVALIDATED', 'invalidate pending operation');
  await machine('app.restart', { appId, fullRestart: true, pause: false });
  check((await ui.probe()).supported, 'hot restart reprobe');
  check(
    (await invoke('find_widget', { key: key('status') })).widget.text === 'taps:0',
    'hot restart new tree',
  );
  await machine('app.restart', { appId, fullRestart: true, pause: false });
  check((await ui.probe()).supported, 'hot restart auto invalidates without manual reset');
  check((await invoke('tap', { key: key('cases') })).ok, 'open independent regression cases');
  check(
    (await invoke('tap', { key: key('mixed-page') })).code === 'AMBIGUOUS_ACTION_TARGET',
    'mixed page cannot select button by type',
  );
  result = await invoke('inspect_key_issues');
  check(
    result.issues.some(
      (x) =>
        x.type === 'ElevatedButton' &&
        x.code === 'MISSING_KEY' &&
        x.ancestorKeys.some((parent) => parent.value === 'mixed-page'),
    ),
    'mixed page Key does not hide missing button Key',
  );
  check(
    (await invoke('scroll', { key: key('parallel-lists'), direction: 'down' })).code ===
      'AMBIGUOUS_SCROLL_TARGET',
    'parallel lists reject ambiguous drag',
  );
  check(
    (await invoke('scroll', { key: key('parallel-lists'), targetKey: key('left.12'), maxSteps: 5 })).code ===
      'AMBIGUOUS_SCROLL_TARGET',
    'target scroll also rejects parallel lists',
  );
  check(
    (await invoke('scroll', { key: key('case-list-left'), direction: 'down', distance: 120 })).ok,
    'explicit list Key scrolls uniquely',
  );
  check((await hash()) === before, 'fixture source unchanged during VM operations');
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(
    join(root, 'artifacts/ui-flutter-smoke-report.json'),
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
  await client.disconnect();
  if (appId) await machine('app.stop', { appId }).catch(() => {});
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGTERM');
  await exited;
  if (!process.env.UI_FIXTURE_DIR && process.env.KEEP_UI_FIXTURE !== '1')
    await rm(temp, { recursive: true, force: true });
}

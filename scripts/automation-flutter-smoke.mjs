// Only an explicitly selected independent test device is controlled by this script.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const deviceId = process.env.AUTOMATION_TEST_DEVICE;
if (!deviceId) throw new Error('Set AUTOMATION_TEST_DEVICE to an independent fixture device ID.');
const platform = process.env.AUTOMATION_TEST_PLATFORM ?? 'ios';
if (!['ios', 'android'].includes(platform)) throw new Error('Unsupported fixture platform');
const root = resolve('.'),
  flutter = process.env.FLUTTER ?? 'flutter';
const temp = await mkdtemp(join(tmpdir(), 'flutter-pilot-automation-fixture-'));
const run = (file, args, cwd) =>
  new Promise((done, reject) => {
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (b) => (output = `${output}${b}`.slice(-8000)));
    child.stderr.on('data', (b) => (output = `${output}${b}`.slice(-8000)));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? done(output) : reject(new Error(output))));
  });
if (platform === 'android')
  await run('adb', ['-s', deviceId, 'uninstall', 'dev.flutterpilot.pilot_automation_fixture']).catch(
    () => {},
  );
if (platform === 'ios') {
  await run('xcrun', [
    'simctl',
    'privacy',
    deviceId,
    'reset',
    'all',
    'dev.flutterpilot.pilotAutomationFixture',
  ]).catch(() => {});
  await run('xcrun', ['simctl', 'uninstall', deviceId, 'dev.flutterpilot.pilotAutomationFixture']).catch(
    () => {},
  );
}
await run(flutter, [
  'create',
  `--platforms=${platform}`,
  '--project-name=pilot_automation_fixture',
  '--org=dev.flutterpilot',
  temp,
]);
await writeFile(
  join(temp, 'lib/main.dart'),
  `import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
void main() => runApp(const MaterialApp(home: Fixture()));
class Fixture extends StatefulWidget { const Fixture({super.key}); @override State<Fixture> createState() => _FixtureState(); }
class _FixtureState extends State<Fixture> {
 int taps=0, doubles=0, longs=0, drags=0, scales=0, submitted=0; double factor=1, angle=0; String text=''; String native='';
 @override Widget build(BuildContext context) => Scaffold(body: SafeArea(child: MediaQuery.sizeOf(context).height<650 ? const Center(child:Text('Landscape fixture')) : Column(children:[
 Text('tap:$taps double:$doubles long:$longs drag:$drags scale:$scales submit:$submitted', key: const ValueKey('status')),
 GestureDetector(key:const ValueKey('touch'), behavior:HitTestBehavior.opaque, onTap:()=>setState(()=>taps++), onDoubleTap:()=>setState(()=>doubles++), onLongPress:()=>setState(()=>longs++), child:const SizedBox(width:300,height:65,child:ColoredBox(color:Colors.blue,child:Center(child:Text('Touch target'))))),
 GestureDetector(key:const ValueKey('drag'), behavior:HitTestBehavior.opaque, onPanUpdate:(_)=>setState(()=>drags++), child:const SizedBox(width:300,height:65,child:ColoredBox(color:Colors.green,child:Center(child:Text('Drag target'))))),
 GestureDetector(key:const ValueKey('scale'), behavior:HitTestBehavior.opaque, onScaleUpdate:(d)=>setState((){scales++;factor=d.scale;angle=d.rotation;}), child:const SizedBox(width:300,height:120,child:ColoredBox(color:Colors.orange,child:Center(child:Text('Scale target'))))),
 Text('factor:$factor angle:$angle',key:const ValueKey('transform')),
 Semantics(label:'Unkeyed action',child:TextButton(onPressed:()=>setState(()=>taps++),child:const Text('No Key action'))),
 TextField(key:const ValueKey('input'),inputFormatters:[FilteringTextInputFormatter.deny(RegExp('#'))],onChanged:(v)=>setState(()=>text=v),onSubmitted:(_)=>setState(()=>submitted++),textInputAction:TextInputAction.search),
 Text(text,key:const ValueKey('echo')),
 Text(native,key:const ValueKey('native-result')),
 TextButton(key:const ValueKey('native-dialog'),onPressed:()async{final r=await const MethodChannel('pilot.fixture').invokeMethod<String>('dialog');setState(()=>native=r??'');},child:const Text('Native dialog')),
 TextButton(key:const ValueKey('complex'),onPressed:()=>Navigator.of(context).push(MaterialPageRoute<void>(builder:(_)=>const ComplexFixture())),child:const Text('Complex cases')),
 TextButton(key:const ValueKey('permission'),onPressed:()=>const MethodChannel('pilot.fixture').invokeMethod<void>('permission'),child:const Text('Permission')),
 Expanded(child:ListView.builder(key:const ValueKey('list'),itemCount:60,itemExtent:45,itemBuilder:(c,i)=>Text('Row $i',key:ValueKey('row.$i')))),
 ])));
}
class ComplexFixture extends StatefulWidget { const ComplexFixture({super.key}); @override State<ComplexFixture> createState()=>_ComplexFixtureState(); }
class _ComplexFixtureState extends State<ComplexFixture> {
 final items=<int>[0,1,2,3]; bool deleted=false;
 @override Widget build(BuildContext context)=>Scaffold(appBar:AppBar(title:const Text('Complex fixture')),body:Column(children:[
 Text(items.join(','),key:const ValueKey('sort.order')),
 SizedBox(height:225,child:ReorderableListView(key:const ValueKey('sort.list'),onReorder:(oldIndex,newIndex)=>setState((){if(newIndex>oldIndex)newIndex--;items.insert(newIndex,items.removeAt(oldIndex));}),children:[for(final i in items) ListTile(key:ValueKey('sort.$i'),title:Text('Sort $i'))])),
 if(!deleted) Dismissible(key:const ValueKey('delete.row'),direction:DismissDirection.endToStart,onDismissed:(_)=>setState(()=>deleted=true),child:const SizedBox(height:60,width:double.infinity,child:ColoredBox(color:Colors.red,child:Center(child:Text('Swipe delete'))))),
 Text(deleted?'deleted':'pending',key:const ValueKey('delete.status')),
 const Text('Column 8'),
 Expanded(child:Scrollable(key:const ValueKey('nested.outer'),viewportBuilder:(context,offset)=>Viewport(offset:offset,slivers:[SliverList(delegate:SliverChildListDelegate([
 SizedBox(height:110,child:ListView.builder(key:const ValueKey('nested.inner'),scrollDirection:Axis.horizontal,itemExtent:120,itemCount:20,itemBuilder:(_,i)=>Center(child:Text('Column $i',key:ValueKey('column.$i'))))),
 for(var i=0;i<12;i++) SizedBox(height:60,child:Text('Outer $i',key:ValueKey('outer.$i')))
 ]))]))),
 ]));
}
`,
);
if (platform === 'ios') {
  const swiftPath = join(temp, 'ios/Runner/AppDelegate.swift');
  let swift = await readFile(swiftPath, 'utf8');
  swift = swift.replace('import Flutter', 'import CoreLocation\nimport Flutter');
  swift = swift.replace('class AppDelegate: FlutterAppDelegate', 'class AppDelegate: FlutterAppDelegate');
  // New Flutter projects use FlutterImplicitEngineDelegate; attach after implicit engine initialization.
  const marker = 'GeneratedPluginRegistrant.register(with:';
  const offset = swift.indexOf(marker),
    lineEnd = swift.indexOf('\n', offset);
  const registrar = swift.includes('engineBridge.pluginRegistry')
    ? 'engineBridge.pluginRegistry.registrar(forPlugin: "PilotFixture")!'
    : 'self.registrar(forPlugin: "PilotFixture")!';
  swift =
    swift.slice(0, lineEnd) +
    `
    let channel = FlutterMethodChannel(name: "pilot.fixture", binaryMessenger: ${registrar}.messenger())
    channel.setMethodCallHandler { call, result in
      if call.method == "dialog" {
        let alert = UIViewController()
        alert.modalPresentationStyle = .formSheet
        alert.preferredContentSize = CGSize(width: 360, height: 520)
        alert.view.backgroundColor = .systemBackground
        let editorA = UITextField()
        editorA.accessibilityIdentifier = "fixture-editor-a"
        editorA.text = "alpha"
        editorA.borderStyle = .roundedRect
        let editorB = UITextField()
        editorB.accessibilityIdentifier = "fixture-editor-b"
        editorB.text = "beta"
        editorB.borderStyle = .roundedRect
        let confirm = UIButton(type: .system)
        confirm.setTitle("Fixture Confirm", for: .normal)
        confirm.addAction(UIAction { [weak alert] _ in alert?.dismiss(animated: true) { result("confirmed") } }, for: .touchUpInside)
        for view in [editorA, editorB, confirm] as [UIView] {
          view.translatesAutoresizingMaskIntoConstraints = false
          alert.view.addSubview(view)
        }
        let safe = alert.view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
          editorA.topAnchor.constraint(equalTo: safe.topAnchor, constant: 60),
          editorA.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 24),
          editorA.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -24),
          editorA.heightAnchor.constraint(equalToConstant: 44),
          editorB.topAnchor.constraint(equalTo: editorA.topAnchor, constant: 160),
          editorB.leadingAnchor.constraint(equalTo: editorA.leadingAnchor),
          editorB.trailingAnchor.constraint(equalTo: editorA.trailingAnchor),
          editorB.heightAnchor.constraint(equalToConstant: 44),
          confirm.topAnchor.constraint(equalTo: editorB.bottomAnchor, constant: 50),
          confirm.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
          confirm.heightAnchor.constraint(equalToConstant: 44),
        ])
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }.first { $0.isKeyWindow }?.rootViewController?.present(alert, animated: true)
      } else if call.method == "permission" { self.fixtureLocation.requestWhenInUseAuthorization(); result(nil) }
      else { result(FlutterMethodNotImplemented) }
    }
` +
    swift.slice(lineEnd);
  swift = swift.replace(
    /class AppDelegate([^\{]+)\{/,
    'class AppDelegate$1{\n  private let fixtureLocation = CLLocationManager()',
  );
  await writeFile(swiftPath, swift);
  const plistPath = join(temp, 'ios/Runner/Info.plist');
  await writeFile(
    plistPath,
    (await readFile(plistPath, 'utf8')).replace(
      '<dict>',
      '<dict>\n<key>NSLocationWhenInUseUsageDescription</key><string>Independent automation fixture</string>',
    ),
  );
} else {
  const activity = join(
    temp,
    'android/app/src/main/kotlin/dev/flutterpilot/pilot_automation_fixture/MainActivity.kt',
  );
  await writeFile(
    activity,
    `package dev.flutterpilot.pilot_automation_fixture
import android.Manifest
import android.app.AlertDialog
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
class MainActivity: FlutterActivity() {
  override fun configureFlutterEngine(engine: FlutterEngine) {
    super.configureFlutterEngine(engine)
    MethodChannel(engine.dartExecutor.binaryMessenger, "pilot.fixture").setMethodCallHandler { call, result ->
      when(call.method) {
        "dialog" -> AlertDialog.Builder(this).setTitle("Native fixture").setMessage("System channel fixture").setPositiveButton("Fixture Confirm") { _, _ -> result.success("confirmed") }.show()
        "permission" -> { requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 1); result.success(null) }
        else -> result.notImplemented()
      }
    }
  }
}`,
  );
  const manifest = join(temp, 'android/app/src/main/AndroidManifest.xml');
  await writeFile(
    manifest,
    (await readFile(manifest, 'utf8')).replace(
      '<application',
      '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/><uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/><application',
    ),
  );
}
await build({
  entryPoints: {
    ui: 'src/vm/ui.ts',
    client: 'src/vm/client.ts',
    automation: 'src/automation/controller.ts',
    runtime: 'src/automation/runtime.ts',
    server: 'src/mcp/server.ts',
    bridge: 'src/mcp/bridge.ts',
  },
  outdir: join(temp, 'js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
});
const require = createRequire(import.meta.url);
const { VmServiceClient } = require(join(temp, 'js/client.cjs'));
const { VmUiController } = require(join(temp, 'js/ui.cjs'));
const { AutomationController } = require(join(temp, 'js/automation.cjs'));
const { AutomationRuntime } = require(join(temp, 'js/runtime.cjs'));
const { McpSessionServer } = require(join(temp, 'js/server.cjs'));
const templatePath = join(root, 'resources/vm/ui.dart.txt');
const vm = new VmServiceClient(),
  ui = new VmUiController(vm, { templatePath });
const runtime = new AutomationRuntime({
  root: process.env.AUTOMATION_RUNTIME_DIR ?? join(temp, 'runtime'),
  resources: join(root, 'resources/automation'),
  nodePath: process.execPath,
  logLevel: process.env.AUTOMATION_TEST_DEBUG === '1' ? 'debug' : 'error',
});
if (process.env.AUTOMATION_TEST_DEBUG === '1')
  runtime.on('log', (line) => {
    if (/XCUITest|HTTP|ERROR|warn|xcodebuild/.test(line)) process.stderr.write(line);
  });
const automation = new AutomationController(
  runtime,
  {
    vmConnected: () => true,
    vmIdentity: () => ({ generation: 'fixture', deviceId }),
    vmProcessId: async () => (await vm.call('getVM')).pid,
    vmExecute: (tool, args) => ui.execute(tool, args),
    vmInvalidate: () => ui.invalidate(),
    changed: () => {},
  },
  join(temp, 'leases'),
);
const child = spawn(flutter, ['run', '--machine', '--no-pub', '-d', deviceId], {
  cwd: temp,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const commands = new Map();
let buffer = '',
  uri,
  appId,
  started = false,
  sequence = 0,
  logs = '';
const exited = new Promise((done) => child.once('exit', done));
child.stderr.on('data', (b) => (logs = `${logs}${b}`.slice(-6000)));
child.stdout.on('data', (b) => {
  buffer += b;
  while (buffer.includes('\n')) {
    const i = buffer.indexOf('\n'),
      line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    try {
      for (const m of JSON.parse(line)) {
        if (m.event === 'app.debugPort') uri = m.params.wsUri;
        if (m.event === 'app.start') appId = m.params.appId;
        if (m.event === 'app.started') started = true;
        if (m.event === 'app.log') logs = `${logs}${m.params.log}\n`.slice(-6000);
        if (m.id && commands.has(m.id)) {
          commands.get(m.id)(m);
          commands.delete(m.id);
        }
      }
    } catch {
      logs = `${logs}${line}\n`.slice(-6000);
    }
  }
});
const machine = (method, params) =>
  new Promise((done) => {
    const id = ++sequence;
    commands.set(id, done);
    child.stdin.write(JSON.stringify([{ id, method, params }]) + '\n');
  });
const records = [];
let mcp, ipc;
let completed = false,
  failure;
const check = (ok, label) => {
  records.push({ label, passed: Boolean(ok) });
  assert.ok(ok, label);
  console.log('PASS', label);
};
const invoke = async (tool, args = {}) => {
  const response = await mcp.callTool(
    { name: tool, arguments: { ...args, sessionId: 'automation-fixture' } },
    undefined,
    { timeout: tool === 'setup_automation' ? 660000 : tool === 'connect_device' ? 240000 : 90000 },
  );
  const r = response.structuredContent;
  if (tool === 'take_screenshot' && r.ok)
    check(
      response.content.some(
        (item) => item.type === 'image' && item.mimeType === 'image/png' && item.data.length > 100,
      ),
      'real stdio PNG content',
    );
  if (!r.ok) {
    console.log(tool, JSON.stringify(r));
    if (r.code === 'EDIT_TARGET_UNCONFIRMED') {
      const focused = await automation.execute('find_widget', { key: 'input' });
      const active = await automation.native.call('GET', '/element/active');
      const id = active?.['element-6066-11e4-a52e-4f735466cecf'];
      const rect = id
        ? await automation.native.call('GET', '/element/' + encodeURIComponent(id) + '/rect')
        : undefined;
      console.log(
        'Fixture editor focus diagnostics',
        JSON.stringify({
          focused: focused.widget?.focused,
          bounds: focused.widget?.bounds,
          inputBounds: focused.widget?.inputBounds,
          inputFieldBounds: focused.widget?.inputFieldBounds,
          active,
          rect,
        }),
      );
    }
    if (tool === 'connect_device') console.log(automation.snapshot.diagnostics);
    if (tool === 'scroll') {
      const snapshot = await automation.execute('get_ui_snapshot', { maxNodes: 600 });
      console.log(
        'Scroll failure nodes',
        JSON.stringify(
          snapshot.widgets?.filter((n) => n.text?.startsWith('Column ') || n.text?.startsWith('Outer ')),
        ),
      );
      const screenshot = await automation.execute('take_screenshot', { source: 'device', mode: 'screen' });
      if (screenshot.ok)
        await writeFile(
          '/tmp/flutter-pilot-scroll-failure.png',
          Buffer.from(screenshot.image.data, 'base64'),
        );
    }
  }
  return r;
};
const text = async (key) => {
  const r = await invoke('find_widget', { key });
  return r.widget?.text;
};
let native = false;
const complex = async (backend) => {
  const label = backend === 'flutter' ? 'VM' : 'native';
  check((await invoke('tap', { key: 'complex', backend })).ok, label + ' complex page');
  check(
    (await invoke('wait_for_widget', { key: 'sort.0', state: 'visible', timeoutMs: 3000 })).ok,
    label + ' reorder target',
  );
  await new Promise((resolve) => setTimeout(resolve, 450));
  check(
    (await invoke('drag', { key: 'sort.0', to: { key: 'sort.2' }, holdMs: 1200, durationMs: 1400, backend }))
      .ok,
    label + ' reorder drag',
  );
  check(
    (
      await invoke('wait_for_widget', {
        key: 'sort.order',
        state: 'text_changed',
        text: '0,1,2,3',
        timeoutMs: 3000,
      })
    ).ok,
    label + ' reordered business result',
  );
  check(
    (await invoke('swipe', { key: 'delete.row', direction: 'left', distance: 300, durationMs: 400, backend }))
      .ok,
    label + ' swipe delete',
  );
  check(
    (
      await invoke('wait_for_widget', {
        key: 'delete.status',
        state: 'text_equals',
        text: 'deleted',
        timeoutMs: 3000,
      })
    ).ok,
    label + ' deleted business result',
  );
  check(
    (
      await invoke('scroll', {
        key: 'nested.inner',
        direction: 'right',
        targetSelector: { text: 'Column 8', type: 'Text' },
        distance: 160,
        maxSteps: 15,
        durationMs: backend === 'device' ? 1000 : 250,
        backend,
      })
    ).ok,
    label + ' nested horizontal search',
  );
  check(
    (
      await invoke('scroll', {
        key: 'nested.outer',
        direction: 'down',
        targetSelector: { text: 'Outer 9', type: 'Text' },
        distance: 160,
        maxSteps: 15,
        durationMs: backend === 'device' ? 1000 : 250,
        backend,
      })
    ).ok,
    label + ' nested outer search',
  );
  check(
    (await invoke('tap', { selector: { type: 'BackButton' }, backend })).ok,
    label + ' visible Back button',
  );
  check(
    (await invoke('wait_for_widget', { key: 'touch', state: 'visible', timeoutMs: 3000 })).ok,
    label + ' returned fixture',
  );
};
try {
  const until = Date.now() + 180000;
  while (!uri || !started) {
    if (child.exitCode !== null) throw new Error(logs);
    if (Date.now() > until) throw new Error('Fixture startup timeout ' + logs);
    await new Promise((r) => setTimeout(r, 200));
  }
  await vm.connect(uri);
  await vm.call('streamListen', { streamId: 'Extension' });
  await vm.call('streamListen', { streamId: 'Isolate' });
  const registry = join(temp, 'registry');
  ipc = new McpSessionServer({
    registryRoot: registry,
    workspace: temp,
    sessionId: 'automation-fixture',
    name: 'Independent automation fixture',
    describe: () => ({ vmConnected: true, automation: automation.snapshot }),
    call: (tool, args, context) => automation.execute(tool, args, context.signal),
  });
  await ipc.start();
  mcp = new Client({ name: 'mobile-automation-fixture', version: '1.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(temp, 'js/bridge.cjs'), '--registry', registry, '--workspace', temp],
      stderr: 'pipe',
    }),
  );
  const { tools } = await mcp.listTools();
  const { prompts } = await mcp.listPrompts();
  check(
    ['get_automation_status', 'get_ui_snapshot', 'take_screenshot', 'list_screenshot_targets', 'tap'].every(
      (name) => tools.some((tool) => tool.name === name),
    ),
    'real stdio mobile capability discovery',
  );
  check(
    [...tools.map((tool) => tool.name), 'capabilities', 'app_screenshot'].every((name) =>
      prompts.some((prompt) => prompt.name === name),
    ),
    'real stdio mobile prompt discovery',
  );
  check(
    mcp.getInstructions().includes('截图优先') && mcp.getInstructions().includes('take_screenshot'),
    'initialization advertises screenshot routing before prompt retrieval',
  );
  check((await ui.probe()).supported, 'VM runtime probe');
  check(
    (await invoke('find_widget', { selector: { text: 'No Key action', type: 'Text' } })).ok,
    'unkeyed text + type selector',
  );
  check(
    (await invoke('find_widget', { selector: { semantics: 'Unkeyed action' } })).ok,
    'semantics selector',
  );
  const snapshot = await invoke('get_ui_snapshot', { maxNodes: 200 }),
    reference = snapshot.widgets.find((w) => w.key?.value === 'touch').ref;
  check((await invoke('find_widget', { selector: { ref: reference } })).ok, 'snapshot reference');
  check((await invoke('double_tap', { key: 'touch', backend: 'flutter' })).ok, 'VM double tap');
  check((await text('status')).includes('double:1'), 'VM double tap callback');
  check(
    (await invoke('long_press', { key: 'touch', backend: 'flutter', durationMs: 700 })).ok,
    'VM long press',
  );
  check((await text('status')).includes('long:1'), 'VM long press callback');
  check(
    (await invoke('drag', { key: 'drag', to: { point: { x: 250, y: 200 } }, backend: 'flutter' })).ok,
    'VM drag',
  );
  check((await invoke('pinch', { key: 'scale', scale: 1.5, backend: 'flutter' })).ok, 'VM pinch');
  check(Number(/factor:([0-9.eE+-]+)/.exec(await text('transform'))[1]) > 1.1, 'VM scale value');
  check(
    (await invoke('rotate_gesture', { key: 'scale', angleDegrees: 45, backend: 'flutter' })).ok,
    'VM rotate',
  );
  check(Math.abs(Number(/angle:([0-9.eE+-]+)/.exec(await text('transform'))[1])) > 0.1, 'VM rotation value');
  check(
    !(await text('status')).includes('drag:0') && !(await text('status')).includes('scale:0'),
    'VM gesture callbacks',
  );
  check(
    (await invoke('enter_text', { key: 'input', text: '中文#ABC', backend: 'flutter' })).ok,
    'VM Unicode input',
  );
  check((await text('echo')) === '中文ABC', 'VM input formatter');
  const cursor = await invoke('edit_text', { key: 'input', action: 'move_cursor', offset: 2 });
  check(cursor.ok && cursor.selection.start === 2 && cursor.selection.end === 2, 'VM precise cursor');
  check(
    (await invoke('edit_text', { key: 'input', action: 'select_range', start: 2, end: 5 })).ok,
    'VM text selection',
  );
  check((await invoke('edit_text', { key: 'input', action: 'delete' })).ok, 'VM selection delete');
  check((await text('echo')) === '中文', 'VM edit onChanged');
  check(
    (await invoke('enter_text', { key: 'input', text: '完成', mode: 'append', backend: 'flutter' })).ok,
    'VM append',
  );
  check((await text('echo')) === '中文完成', 'VM appended text');
  for (const [name, cluster] of [
    ['surrogate pair', '😀'],
    ['combining accent', 'e\u0301'],
    ['ZWJ family', '👨‍👩‍👧‍👦'],
    ['regional flag', '🇨🇳'],
  ]) {
    const value = 'A' + cluster + 'B';
    check(
      (await invoke('enter_text', { key: 'input', text: value, backend: 'flutter' })).ok,
      name + ' fixture input',
    );
    check(
      !(await invoke('edit_text', { key: 'input', action: 'move_cursor', offset: 2, backend: 'flutter' })).ok,
      name + ' interior cursor rejected',
    );
    check(
      !(
        await invoke('edit_text', {
          key: 'input',
          action: 'select_range',
          start: 1,
          end: 2,
          backend: 'flutter',
        })
      ).ok,
      name + ' partial selection rejected',
    );
    check((await text('echo')) === value, name + ' rejection preserves text');
    check(
      (
        await invoke('edit_text', {
          key: 'input',
          action: 'move_cursor',
          offset: 1 + cluster.length,
          backend: 'flutter',
        })
      ).ok,
      name + ' complete boundary accepted',
    );
    check(
      (await invoke('edit_text', { key: 'input', action: 'delete', backend: 'flutter' })).ok,
      name + ' whole cluster deletion',
    );
    check((await text('echo')) === 'AB', name + ' deletion preserves neighbors');
  }
  check(
    (await invoke('enter_text', { key: 'input', text: '中文完成', backend: 'flutter' })).ok,
    'VM Unicode fixture restoration',
  );
  check((await invoke('editor_action', { action: 'search', backend: 'flutter' })).ok, 'VM editor action');
  check((await text('status')).includes('submit:1'), 'VM editor submit callback');
  check((await invoke('hide_keyboard', { backend: 'flutter' })).ok, 'VM hide keyboard');
  check((await invoke('press_key', { keyName: 'Tab', backend: 'flutter' })).ok, 'VM key input');
  check(
    (await invoke('tap', { selector: { text: 'No Key action', type: 'Text' }, backend: 'flutter' })).ok,
    'VM unkeyed tap',
  );
  check(
    (
      await invoke('scroll', {
        key: 'list',
        targetSelector: { text: 'Row 12', type: 'Text' },
        maxSteps: 12,
        backend: 'flutter',
        distance: 120,
      })
    ).ok,
    'VM selector scroll search',
  );
  check(
    (
      await invoke('scroll', {
        key: 'list',
        direction: 'up',
        maxSteps: 20,
        backend: 'flutter',
        distance: 120,
      })
    ).ok,
    'VM reverse scroll',
  );
  check(
    (
      await invoke('wait_for_widget', {
        key: 'echo',
        state: 'text_equals',
        text: '中文完成',
        timeoutMs: 1000,
      })
    ).ok,
    'text wait condition',
  );
  check(
    (await invoke('find_widget', { selector: { ref: reference } })).code === 'STALE_REFERENCE',
    'stale VM reference rejected',
  );
  await complex('flutter');
  if (process.env.AUTOMATION_TEST_NATIVE === '1') {
    runtime.on('status', (s) => {
      if (s.progress) console.log(s.progress);
    });
    check((await invoke('setup_automation')).ok, 'managed Appium preparation');
    const bundleId =
      platform === 'ios'
        ? 'dev.flutterpilot.pilotAutomationFixture'
        : 'dev.flutterpilot.pilot_automation_fixture';
    const connection = await invoke('connect_device', { deviceId, appId: bundleId });
    check(connection.ok, 'native device attachment');
    native = true;
    const deviceSnapshot = await invoke('get_ui_snapshot', { source: 'device', maxNodes: 300 });
    check(deviceSnapshot.ok && deviceSnapshot.widgets.length > 0, 'device accessibility snapshot');
    check(
      (await invoke('take_screenshot', { source: 'device', mode: 'screen' })).ok,
      'native full-screen screenshot',
    );
    check(
      (
        await invoke('tap', {
          selector: {
            source: 'device',
            text: 'No Key action',
            type: platform === 'ios' ? 'XCUIElementTypeButton' : 'android.widget.Button',
          },
        })
      ).ok,
      'native unkeyed tap',
    );
    check((await invoke('double_tap', { key: 'touch' })).ok, 'native double tap');
    check((await text('status')).includes('double:2'), 'native double callback');
    check((await invoke('drag', { key: 'drag', to: { point: { x: 250, y: 200 } } })).ok, 'native drag');
    check((await invoke('long_press', { key: 'touch', durationMs: 700 })).ok, 'native long press');
    check((await text('status')).includes('long:2'), 'native hold callback');
    check((await invoke('pinch', { key: 'scale', scale: 1.25 })).ok, 'native pinch');
    check(Number(/factor:([0-9.eE+-]+)/.exec(await text('transform'))[1]) > 1.1, 'native scale value');
    check((await invoke('rotate_gesture', { key: 'scale', angleDegrees: 30 })).ok, 'native rotate');
    check(
      Math.abs(Number(/angle:([0-9.eE+-]+)/.exec(await text('transform'))[1])) > 0.1,
      'native rotation value',
    );
    check((await invoke('enter_text', { key: 'input', text: '设备#中文' })).ok, 'native Unicode input');
    check((await text('echo')) === '设备中文', 'native input callback');
    for (const selection of [
      { action: 'move_cursor', offset: 2 },
      { action: 'select_range', start: 1, end: 3 },
    ]) {
      check(
        (await invoke('edit_text', { key: 'input', ...selection, backend: 'flutter' })).ok,
        'native append ' + selection.action + ' precondition',
      );
      check(
        (await invoke('enter_text', { key: 'input', text: '尾', mode: 'append' })).code ===
          'UNSUPPORTED_OPERATION',
        'native append ' + selection.action + ' explicitly rejected',
      );
      check((await text('echo')) === '设备中文', 'native rejected append preserves ' + selection.action);
    }
    check(
      (await invoke('get_automation_status')).automation.capabilities['enter_text.append'].supported ===
        false,
      'native append capability restriction',
    );
    check(
      (
        await invoke('edit_text', {
          key: 'input',
          action: 'move_cursor',
          offset: 4,
          backend: 'flutter',
        })
      ).ok,
      'native clipboard cursor precondition restored',
    );
    check((await invoke('get_keyboard_state')).shown === true, 'native keyboard visible');
    const nativeSelection = await invoke('edit_text', { key: 'input', action: 'select_all' });
    const clipboardBackend = nativeSelection.ok ? 'device' : 'flutter';
    if (!nativeSelection.ok) {
      check(nativeSelection.code === 'UNSUPPORTED_OPERATION', 'native modifier restriction reported');
      const status = await invoke('get_automation_status');
      check(
        status.automation.capabilities['edit_text.copy'].supported === false,
        'device clipboard capability restriction',
      );
    }
    for (const action of ['select_all', 'copy', 'cut'])
      check(
        (await invoke('edit_text', { key: 'input', action, backend: clipboardBackend })).ok,
        clipboardBackend + ' edit ' + action,
      );
    check(
      (await invoke('wait_for_widget', { key: 'echo', state: 'text_equals', text: '', timeoutMs: 3000 })).ok,
      clipboardBackend + ' cut onChanged',
    );
    check(
      (await invoke('edit_text', { key: 'input', action: 'paste', backend: clipboardBackend })).ok,
      clipboardBackend + ' edit paste',
    );
    check(
      (
        await invoke('wait_for_widget', {
          key: 'echo',
          state: 'text_equals',
          text: '设备中文',
          timeoutMs: 3000,
        })
      ).ok,
      clipboardBackend + ' paste onChanged',
    );
    check(
      (await invoke('press_key', { keyName: 'Backspace', backend: clipboardBackend })).ok,
      clipboardBackend + ' delete key',
    );
    check(
      (
        await invoke('wait_for_widget', {
          key: 'echo',
          state: 'text_equals',
          text: '设备中',
          timeoutMs: 3000,
        })
      ).ok,
      clipboardBackend + ' keyboard edit result',
    );
    check((await invoke('editor_action', { action: 'search' })).ok, 'native editor action');
    check((await text('status')).includes('submit:2'), 'native editor callback');
    check((await invoke('hide_keyboard')).ok, 'native hide keyboard');
    check((await invoke('tap', { key: 'native-dialog' })).ok, 'open native fixture dialog');
    const dialog = await invoke('wait_for_widget', {
      selector: {
        source: 'device',
        text: 'Fixture Confirm',
        type: platform === 'ios' ? 'XCUIElementTypeButton' : 'android.widget.Button',
      },
      state: 'visible',
      timeoutMs: 5000,
    });
    check(dialog.ok, 'locate native dialog');
    if (platform === 'ios') {
      const editor = (name) => ({ source: 'device', accessibilityId: 'fixture-editor-' + name });
      check(
        (
          await invoke('enter_text', {
            selector: editor('a'),
            mode: 'append',
            text: 'suffix',
          })
        ).code === 'UNSUPPORTED_OPERATION',
        'pure native append explicitly rejected',
      );
      await new Promise((resolve) => setTimeout(resolve, 450));
      check((await invoke('tap', { selector: editor('a') })).ok, 'native editor A focused precondition');
      await new Promise((resolve) => setTimeout(resolve, 250));
      check(
        (await invoke('long_press', { selector: editor('a'), durationMs: 800 })).ok,
        'native editor A menu precondition',
      );
      check(
        (await invoke('edit_text', { selector: editor('a'), action: 'select_all' })).ok,
        'native editor A selected-text precondition',
      );
      const cutMenu = await invoke('wait_for_widget', {
        selector: { source: 'device', text: 'Cut', type: 'XCUIElementTypeMenuItem' },
        state: 'visible',
        timeoutMs: 3000,
      });
      const menu = await invoke('get_ui_snapshot', { source: 'device', maxNodes: 300 });
      if (!cutMenu.ok)
        console.log(
          'Fixture native menu diagnostics',
          JSON.stringify(menu.widgets.filter((node) => node.visible && /MenuItem|TextField/.test(node.type))),
        );
      check(
        cutMenu.ok &&
          menu.widgets.some((node) => node.visible && ['Cut', '剪切', '剪下'].includes(node.text)),
        'native editor A visible cut menu',
      );
      for (const action of ['cut', 'paste'])
        check(
          (await invoke('edit_text', { selector: editor('b'), action })).code === 'EDIT_TARGET_UNCONFIRMED',
          'native editor B ' + action + ' rejects editor A menu',
        );
      const editors = await invoke('get_ui_snapshot', { source: 'device', maxNodes: 300 });
      check(
        editors.widgets.find((node) => node.accessibilityId === 'fixture-editor-a')?.text === 'alpha' &&
          editors.widgets.find((node) => node.accessibilityId === 'fixture-editor-b')?.text === 'beta',
        'native wrong-editor menu preserves both fields',
      );
    }
    check(
      (
        await invoke('tap', {
          selector: {
            source: 'device',
            text: 'Fixture Confirm',
            type: platform === 'ios' ? 'XCUIElementTypeButton' : 'android.widget.Button',
          },
        })
      ).ok,
      'native dialog button',
    );
    check(
      (
        await invoke('wait_for_widget', {
          key: 'native-result',
          state: 'text_equals',
          text: 'confirmed',
          timeoutMs: 3000,
        })
      ).ok,
      'native dialog business callback',
    );
    check((await invoke('tap', { key: 'permission' })).ok, 'open location permission');
    const permissionType = platform === 'ios' ? 'XCUIElementTypeAlert' : 'android.widget.LinearLayout';
    check(
      (
        await invoke('wait_for_widget', {
          selector: { source: 'device', type: permissionType },
          state: 'visible',
          timeoutMs: 5000,
        })
      ).ok,
      'permission dialog visible',
    );
    const permissionSnapshot = await invoke('get_ui_snapshot', { source: 'device', maxNodes: 500 });
    const allow = permissionSnapshot.widgets.find(
      (n) =>
        n.type === (platform === 'ios' ? 'XCUIElementTypeButton' : 'android.widget.Button') &&
        /Allow While Using|While Using|Allow Once|使用\s*App\s*时允许|使用App期间|使用应用时|允许一次/i.test(
          n.text ?? n.semantics ?? '',
        ),
    );
    check(!!allow, 'permission explicit button');
    check((await invoke('tap', { selector: { ref: allow.ref } })).ok, 'permission explicit tap');
    check(
      (await invoke('device_action', { action: 'rotate', orientation: 'LANDSCAPE' })).ok,
      'native landscape',
    );
    check((await invoke('get_ui_snapshot', { source: 'device' })).ok, 'rotated device snapshot');
    check(
      (await invoke('device_action', { action: 'restore_orientation' })).ok,
      'native orientation restoration',
    );
    check(
      (await invoke('wait_for_widget', { key: 'touch', state: 'visible', timeoutMs: 5000 })).ok,
      'portrait Flutter layout restored',
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    check((await invoke('tap', { key: 'touch' })).ok, 'native relocalization after rotation');
    check((await invoke('device_action', { action: 'notifications' })).ok, 'native notifications open');
    check((await invoke('get_ui_snapshot', { source: 'device' })).ok, 'notification snapshot');
    check((await invoke('device_action', { action: 'close_panels' })).ok, 'native notifications close');
    if (platform === 'ios') {
      check((await invoke('device_action', { action: 'control_center' })).ok, 'native control center open');
      check((await invoke('device_action', { action: 'close_panels' })).ok, 'native control center close');
    }
    check((await invoke('device_action', { action: 'home' })).ok, 'native Home');
    check((await invoke('device_action', { action: 'foreground' })).ok, 'native foreground');
    await new Promise((resolve) => setTimeout(resolve, 700));
    await complex('device');
    const touchBounds = (await invoke('find_widget', { key: 'touch' })).widget.bounds;
    const point = { x: touchBounds.x + touchBounds.width / 2, y: touchBounds.y + touchBounds.height / 2 };
    const beforeCancel = await text('status');
    const abort = new AbortController();
    const cancelled = mcp.callTool(
      {
        name: 'long_press',
        arguments: { sessionId: 'automation-fixture', point, backend: 'device', durationMs: 2200 },
      },
      undefined,
      { signal: abort.signal, timeout: 10000 },
    );
    const cancelTimer = setTimeout(() => abort.abort(), 900);
    await assert.rejects(cancelled);
    clearTimeout(cancelTimer);
    check(true, 'real stdio native gesture cancellation');
    check((await invoke('tap', { key: 'touch' })).ok, 'native input after cancelled gesture');
    const tapsBefore = Number(/tap:(\d+)/.exec(beforeCancel)[1]);
    check(
      (
        await invoke('wait_for_widget', {
          key: 'status',
          state: 'text_contains',
          text: 'tap:' + (tapsBefore + 1) + ' ',
          timeoutMs: 3000,
        })
      ).ok,
      'cancelled gesture released before next input',
    );
    check((await invoke('disconnect_device')).ok, 'native session cleanup');
    native = false;
  }
  completed = true;
  console.log(JSON.stringify({ passed: records.filter((r) => r.passed).length, platform, native }));
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  const cleanupErrors = [];
  const clean = async (operation) => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  };
  await clean(() => mcp?.close());
  await clean(() => ipc?.stop());
  await clean(() => automation.dispose());
  await clean(() => ui.dispose());
  await clean(() => vm.disconnect());
  if (appId)
    await clean(() =>
      Promise.race([machine('app.stop', { appId }), new Promise((r) => setTimeout(r, 5000))]),
    );
  if (child.exitCode === null) child.kill('SIGTERM');
  await clean(() => exited);
  records.push({ label: 'owned fixture process cleanup', passed: cleanupErrors.length === 0 });
  completed = completed && cleanupErrors.length === 0;
  const fixtureSourceHash = createHash('sha256')
    .update(await readFile(join(temp, 'lib/main.dart')))
    .digest('hex');
  if (process.env.KEEP_AUTOMATION_FIXTURE !== '1')
    await clean(() => rm(temp, { recursive: true, force: true }));
  completed = completed && cleanupErrors.length === 0;
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(
    join(root, 'artifacts/automation-flutter-smoke-report.json'),
    JSON.stringify(
      {
        platform,
        deviceId,
        deviceKind: process.env.AUTOMATION_TEST_KIND ?? (platform === 'ios' ? 'simulator' : 'unspecified'),
        runtimeVersions: runtime.snapshot.versions,
        nativeRequested: process.env.AUTOMATION_TEST_NATIVE === '1',
        completed,
        failure,
        cleanupErrors,
        records,
        fixture: temp,
        fixtureSourceHash,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  if (!failure && cleanupErrors.length)
    throw new Error('Fixture cleanup failed: ' + cleanupErrors.join('; '));
}

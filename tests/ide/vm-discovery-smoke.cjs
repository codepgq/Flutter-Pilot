const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const sanitize = (value) => String(value).replace(/(?:wss?|https?):\/\/[^\s'"<>]+/g, '[redacted URL]');

exports.run = async () => {
  const report = {
    ide: process.env.FLUTTER_PILOT_TEST_IDE,
    ideVersion: vscode.version,
    ideAppVersion: process.env.FLUTTER_PILOT_TEST_IDE_APP_VERSION,
    flutterVersion: process.env.FLUTTER_PILOT_TEST_FLUTTER_VERSION,
    dartVersion: process.env.FLUTTER_PILOT_TEST_DART_VERSION,
    dartExtensionVersion: vscode.extensions.getExtension('Dart-Code.dart-code')?.packageJSON.version,
    device: process.env.FLUTTER_PILOT_TEST_DEVICE,
    passed: false,
    assertions: [],
    limits: ['macOS local iOS simulator only; Android and physical devices not exercised.'],
  };
  const passed = (label) => {
    report.assertions.push(label);
    console.log(`DISCOVERY_ASSERT_PASS ${label}`);
  };
  const folder = vscode.workspace.workspaceFolders[0];
  const workspace = folder.uri.fsPath;
  const owned = new Map();
  const started = vscode.debug.onDidStartDebugSession((session) => {
    if (session.configuration.cwd === workspace || session.name.startsWith('Flutter Pilot Discovery Fixture')) {
      owned.set(session.id, session);
      console.log('DISCOVERY_SESSION_STARTED ' + session.type + ' ' + session.name);
    }
  });
  const stoppedIds = new Set();
  const stopped = vscode.debug.onDidTerminateDebugSession((session) => stoppedIds.add(session.id));
  let workbench;
  let probe;
  let flutterProcess;
  let flutterAppId;
  let server;
  const assertDefaults = () => {
    assert.equal(workbench.vm.state.mockEnabled, false);
    assert.equal(workbench.vm.websocket.state.captureEnabled, false);
    assert.equal(workbench.vm.websocket.state.mockEnabled, false);
    assert.equal(workbench.engine.state.status, 'stopped');
  };
  async function begin(request = 'launch', extras = {}) {
    const name = `Flutter Pilot Discovery Fixture ${request} ${Date.now()}`;
    assert.equal(
      await vscode.debug.startDebugging(folder, {
        type: 'dart',
        request,
        name,
        cwd: workspace,
        ...(request === 'launch' ? { program: path.join(workspace, 'lib', 'main.dart') } : {}),
        deviceId: process.env.FLUTTER_PILOT_TEST_DEVICE,
        flutterMode: 'debug',
        ...extras,
      }),
      true,
      'Dart debugger accepted test configuration',
    );
    const session = await waitFor(
      () => [...owned.values()].find((candidate) => !stoppedIds.has(candidate.id)),
      'debug session start',
    );
    await waitFor(() => workbench.vm.state.status === 'connected', `${request} auto VM connection`, 180000);
    await waitFor(() => workbench.vm.state.isolates > 0, 'HTTP profiling isolate ready', 30000);
    assertDefaults();
    return session;
  }
  async function end(session) {
    await vscode.debug.stopDebugging(session);
    await waitFor(() => stoppedIds.has(session.id), 'owned debug session stopped', 60000);
    await waitFor(() => workbench.vm.state.status === 'disconnected', 'auto disconnect on stop', 30000);
    owned.delete(session.id);
  }
  async function verifyHttp() {
    server = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"fixture":"auto-vm"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const vm = await workbench.vm.client.call('getVM');
    const isolateId = vm.isolates.find((isolate) => isolate.name === 'main')?.id ?? vm.isolates[0].id;
    const isolate = await workbench.vm.client.call('getIsolate', { isolateId });
    const io = isolate.libraries.find((library) => library.uri === 'dart:io');
    assert.ok(io, 'dart:io loaded');
    const port = server.address().port;
    const result = await workbench.vm.client.call('evaluate', {
      isolateId,
      targetId: io.id,
      expression: `(HttpClient()..connectionTimeout = Duration(seconds: 5)).getUrl(Uri.parse('http://127.0.0.1:${port}/auto-vm-fixture')).then((r) => r.close()).then((r) => r.drain())`,
      disableBreakpoints: true,
    });
    assert.ok(!['Error', '@Error'].includes(result.type), 'HTTP evaluation accepted');
    await waitFor(
      async () => {
        const history = await workbench.vm.store.list({ search: '/auto-vm-fixture', limit: 10 }, false);
        return history.items.some((item) => item.response?.status === 200);
      },
      'real Flutter HTTP recording',
      30000,
    );
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
  try {
    const extension = vscode.extensions.getExtension('flutter-pilot.flutter-pilot');
    assert.ok(extension);
    await extension.activate();
    workbench = await vscode.commands.executeCommand('flutterPilot.open');
    assert.ok(workbench?.vm);
    const first = await begin();
    passed('real Flutter IDE launch auto-connects without a manually entered URI; Dio/WS remain off');
    await verifyHttp();
    passed('real Flutter dart:io HTTP request recorded after auto-connect');
    const { VmDiscovery, createVscodeDiscoveryHost } = require(process.env.FLUTTER_PILOT_TEST_DISCOVERY_BUNDLE);
    probe = new VmDiscovery(createVscodeDiscoveryHost(vscode));
    await probe.start();
    await waitFor(
      () =>
        probe
          .snapshot()
          .candidates.some(
            (candidate) =>
              candidate.id === first.id && candidate.source === 'dtd' && probe.address(candidate.id),
          ),
      'DTD existing debug session query',
      30000,
    );
    passed('new discovery instance supplements an already running real Flutter debug session through DTD');
    probe.dispose();
    probe = undefined;
    await first.customRequest('hotRestart', { reason: 'manual' });
    await waitFor(
      () => workbench.vm.state.status === 'connected' && workbench.vm.state.isolates > 0,
      'Hot Restart isolate refresh',
    );
    assertDefaults();
    passed('Hot Restart keeps automatic VM connection and manual feature defaults');
    await workbench.handle({ action: 'vm.disconnect', payload: {} });
    await sleep(5000);
    assert.equal(workbench.vm.state.status, 'disconnected');
    const candidate = workbench.vmAuto.snapshot.candidates.find((item) => item.id === first.id);
    assert.equal(candidate?.status, 'paused');
    await workbench.handle({ action: 'vm.discovery.connect', payload: { id: first.id } });
    await waitFor(() => workbench.vm.state.status === 'connected', 'explicit selected reconnect');
    assertDefaults();
    passed('manual disconnect suppresses same-session reconnect; explicit candidate route reconnects');
    await end(first);
    passed('ending owned debug session automatically disconnects its VM');
    const second = await begin();
    assert.notEqual(second.id, first.id);
    passed('fresh IDE debug session automatically reconnects after full stop/start');
    await end(second);

    let machineBuffer = '';
    let vmServiceUri;
    let appStarted = false;
    let machineFailure;
    flutterProcess = spawn(
      process.env.FLUTTER_PILOT_TEST_FLUTTER,
      ['run', '--machine', '--no-pub', '-d', process.env.FLUTTER_PILOT_TEST_DEVICE],
      { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    flutterProcess.stdout.on('data', (data) => {
      machineBuffer += data.toString();
      let newline;
      while ((newline = machineBuffer.indexOf('\n')) >= 0) {
        const line = machineBuffer.slice(0, newline).trim();
        machineBuffer = machineBuffer.slice(newline + 1);
        if (!line.startsWith('[')) continue;
        try {
          for (const event of JSON.parse(line)) {
            if (event.event === 'app.start') flutterAppId = event.params.appId;
            if (event.event === 'app.debugPort') vmServiceUri = event.params.wsUri ?? event.params.httpUri;
            if (event.event === 'app.started') appStarted = true;
          }
        } catch {
          /* Non-machine Flutter output is not used for discovery. */
        }
      }
    });
    flutterProcess.stderr.on('data', () => {});
    flutterProcess.on('error', () => {
      machineFailure = true;
    });
    flutterProcess.on('exit', () => {
      machineFailure = true;
    });
    await waitFor(
      () => {
        if (machineFailure) throw new Error('owned Flutter machine process exited early');
        return appStarted && vmServiceUri;
      },
      'external fixture Flutter app start',
      180000,
    );
    const attached = await begin('attach', { vmServiceUri });
    passed('real IDE attach to independently launched Flutter app auto-connects');
    await end(attached);
    const currentHash = createHash('sha256')
      .update(await fs.readFile(path.join(workspace, 'lib', 'main.dart')))
      .digest('hex');
    assert.equal(currentHash, process.env.FLUTTER_PILOT_TEST_SOURCE_HASH);
    passed('fixture Flutter application source SHA-256 unchanged');
    report.passed = true;
  } catch (error) {
    report.error = sanitize(error?.message ?? error);
    throw new Error(report.error);
  } finally {
    probe?.dispose();
    for (const session of owned.values()) await vscode.debug.stopDebugging(session).catch(() => {});
    started.dispose();
    stopped.dispose();
    if (flutterProcess && flutterProcess.exitCode === null) {
      if (flutterAppId)
        flutterProcess.stdin.write(
          JSON.stringify([{ id: 999, method: 'app.stop', params: { appId: flutterAppId } }]) + '\n',
        );
      await Promise.race([new Promise((resolve) => flutterProcess.once('exit', resolve)), sleep(5000)]);
      if (flutterProcess.exitCode === null) flutterProcess.kill('SIGTERM');
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.writeFile(process.env.FLUTTER_PILOT_TEST_DISCOVERY_REPORT, JSON.stringify(report, null, 2) + '\n');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
};

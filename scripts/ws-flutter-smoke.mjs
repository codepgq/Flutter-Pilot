// Builds a disposable Flutter application. It never changes or connects to a user's App.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:https';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
const root = resolve('.');
const flutter = process.env.FLUTTER ?? 'flutter';
const device = process.env.VM_FLUTTER_DEVICE;
if (!device) throw Error('设置 VM_FLUTTER_DEVICE 为已启动的 iOS 模拟器 ID');
const temp = await mkdtemp(join(tmpdir(), 'api-mocks-ws-flutter-'));
const peers = new Map();
const received = [];
const servers = [];
let child;
let appId;
let client;
let injector;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await test();
    if (value) return value;
    await sleep(100);
  }
  throw Error(`等待失败：${label}`);
}
try {
  await build({
    stdin: {
      contents: `export {WsVmInjector} from ${JSON.stringify(join(root, 'src/vm/websocket.ts'))};export {VmServiceClient} from ${JSON.stringify(join(root, 'src/vm/client.ts'))};`,
      resolveDir: root,
    },
    outfile: join(temp, 'runtime.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const { WsVmInjector, VmServiceClient } = createRequire(import.meta.url)(join(temp, 'runtime.cjs'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(temp, 'ca-key.pem'),
      '-out',
      join(temp, 'ca.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=API Mocks Flutter Test Root',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(temp, 'key.pem'),
      '-out',
      join(temp, 'server.csr'),
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  );
  await writeFile(
    join(temp, 'server.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      join(temp, 'server.csr'),
      '-CA',
      join(temp, 'ca.pem'),
      '-CAkey',
      join(temp, 'ca-key.pem'),
      '-CAcreateserial',
      '-out',
      join(temp, 'cert.pem'),
      '-days',
      '1',
      '-extfile',
      join(temp, 'server.ext'),
    ],
    { stdio: 'ignore' },
  );
  const secure = createServer({
    key: await readFile(join(temp, 'key.pem')),
    cert: await readFile(join(temp, 'cert.pem')),
  });
  await new Promise((r) => secure.listen(0, '127.0.0.1', r));
  servers.push(secure);
  const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wsServer.once('listening', r));
  const wssServer = new WebSocketServer({ server: secure });
  servers.push(wsServer, wssServer);
  for (const server of [wsServer, wssServer])
    server.on('connection', (socket, req) => {
      const index = Number(new URL(req.url, 'http://fixture').searchParams.get('index'));
      peers.set(index, socket);
      socket.on('message', (data, binary) =>
        received.push({ index, data: binary ? [...data] : data.toString() }),
      );
    });
  const project = join(temp, 'fixture');
  console.log('Creating disposable Flutter WS fixture…');
  execFileSync(
    flutter,
    ['create', '--platforms=ios', '--no-pub', '--project-name', 'api_mocks_ws_fixture', project],
    { stdio: 'pipe' },
  );
  const pubspec = await readFile(join(project, 'pubspec.yaml'), 'utf8');
  await writeFile(
    join(project, 'pubspec.yaml'),
    pubspec.replace('dependencies:\n', 'dependencies:\n  web_socket_channel: ^3.0.3\n'),
  );
  execFileSync(flutter, ['pub', 'get', '--offline'], { cwd: project, stdio: 'pipe' });
  const ca = (await readFile(join(temp, 'ca.pem'))).toString('base64');
  const source = `import 'dart:io';import 'dart:convert';import 'dart:async';import 'package:flutter/material.dart';import 'package:web_socket_channel/io.dart';
final sockets=<WebSocket>[];final sinks=<dynamic>[];final events=<dynamic>[];
void main(){runApp(const MaterialApp(home:Scaffold(body:Center(child:Text('API Mocks disposable WebSocket fixture')))));}
Future<void> connect() async {final context=SecurityContext(withTrustedRoots:true)..setTrustedCertificatesBytes(base64Decode('${ca}'));final client=HttpClient(context:context);for(var i=0;i<4;i++){final base=i.isEven?'ws://127.0.0.1:${wsServer.address().port}':'wss://127.0.0.1:${secure.address().port}';final socket=await WebSocket.connect('$base/business?index=$i',customClient:client);sockets.add(socket);if(i>=2){final channel=IOWebSocketChannel(socket);sinks.add(channel.sink);channel.stream.listen((dynamic data)=>events.add({'index':i,'data':data}));}else{sinks.add(socket);socket.listen((dynamic data)=>events.add({'index':i,'data':data}));}}events.add({'ready':true});}
void send(int index,String text)=>sinks[index].add(text);
void utf8Send(String text)=>sockets[0].addUtf8Text(utf8.encode(text));
Future<void> streamSend() async {await sockets[0].addStream(Stream.fromIterable(['stream-one','replace-stream','drop-stream']));events.add({'streamDone':true});}
Future<void> finish() async {for(final socket in sockets){await socket.close();}events.add({'closed':true});}
`;
  const main = join(project, 'lib/main.dart');
  await writeFile(main, source);
  const before = createHash('sha256').update(source).digest('hex');
  child = spawn(flutter, ['run', '--machine', '--no-pub', '-d', device], {
    cwd: project,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let uri;
  let started = false;
  let machineId = 0;
  const commands = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      try {
        const records = JSON.parse(line);
        if (!Array.isArray(records)) continue;
        for (const m of records) {
          if (m.event === 'app.start') appId = m.params.appId;
          if (m.event === 'app.debugPort') uri = m.params.wsUri;
          if (m.event === 'app.started') started = true;
          if (m.id && commands.has(m.id)) {
            commands.get(m.id)(m);
            commands.delete(m.id);
          }
        }
      } catch {}
    }
  });
  child.stderr.on('data', () => {});
  console.log('Building Flutter fixture on simulator…');
  await until(() => uri && started, 'Flutter app VM', 300000);
  client = new VmServiceClient();
  await client.connect(uri);
  await client.call('streamListen', { streamId: 'Extension' });
  const vm = await client.call('getVM');
  let isolateId = vm.isolates.find((i) => i.name === 'main').id;
  const isolate = await client.call('getIsolate', { isolateId });
  let library = isolate.libraries.find((l) => l.uri.endsWith('/main.dart'));
  async function evaluate(expression) {
    let v = await client.call('evaluate', {
      isolateId,
      targetId: library.id,
      expression,
      disableBreakpoints: true,
    });
    if (v.type === 'Error' || v.type === '@Error') throw Error('Fixture expression failed');
    if (v.valueAsStringIsTruncated) v = await client.call('getObject', { isolateId, objectId: v.id });
    return v;
  }
  async function readEvents() {
    return JSON.parse((await evaluate('jsonEncode(events)')).valueAsString);
  }
  await evaluate('connect()');
  await until(async () => (await readEvents()).some((e) => e.ready), 'four business WS connections');
  assert.equal(peers.size, 4);
  injector = new WsVmInjector(client, { templatePath: join(root, 'resources/vm/websocket.dart.txt') });
  const messages = [];
  injector.on('message', (m) => messages.push(m));
  const warnings = [];
  injector.on('warning', (w) => warnings.push(w));
  const connections = await injector.scan([isolateId], [], false);
  assert.equal(connections.length, 4);
  assert.ok(
    connections.every((c) => c.capture === 'attached'),
    JSON.stringify(warnings),
  );
  // Map actual socket coordinates, rather than guessing the order of discovery.
  const httpLibrary = isolate.libraries.find((l) => l.uri === 'dart:_http');
  let metadata = await client.call('evaluate', {
    isolateId,
    targetId: httpLibrary.id,
    expression:
      'jsonEncode(_WebSocketImpl._webSockets.values.where((s)=>!s._serverSide).map((s)=>{"serviceId":s._serviceId,"port":s._socket.port}).toList())',
    disableBreakpoints: true,
  });
  if (metadata.valueAsStringIsTruncated)
    metadata = await client.call('getObject', { isolateId, objectId: metadata.id });
  const coordinates = JSON.parse(metadata.valueAsString);
  const byIndex = new Map();
  for (const [index, peer] of peers) {
    const record = coordinates.find((c) => c.port === peer._socket.remotePort);
    byIndex.set(
      index,
      connections.find((c) => c.id.endsWith(':' + record.serviceId)),
    );
  }
  const rules = [];
  for (const [index, c] of byIndex) {
    for (const direction of ['inbound', 'outbound']) {
      rules.push({
        id: `replace-${index}-${direction}`,
        name: 'replace',
        enabled: true,
        priority: 0,
        match: { connectionId: c.id, direction, contains: 'replace' },
        action: { type: 'replace', text: `modified-${index}-${direction}` },
      });
      rules.push({
        id: `drop-${index}-${direction}`,
        name: 'drop',
        enabled: true,
        priority: 0,
        match: { connectionId: c.id, direction, contains: 'drop' },
        action: { type: 'drop' },
      });
    }
  }
  await injector.scan([isolateId], rules, true);
  for (let index = 0; index < 4; index++) {
    await evaluate(`send(${index},'replace-first')`);
    peers.get(index).send('replace-inbound');
    await injector.push(byIndex.get(index).id, `synthetic-${index}`);
    await evaluate(`send(${index},'drop-out')`);
    peers.get(index).send('drop-in');
  }
  await until(
    () => received.filter((e) => e.data === `modified-${e.index}-outbound`).length === 4,
    'WS/WSS raw/channel outgoing',
  );
  await until(async () => {
    const events = await readEvents();
    return [0, 1, 2, 3].every(
      (i) =>
        events.some((e) => e.index === i && e.data === `modified-${i}-inbound`) &&
        events.some((e) => e.index === i && e.data === `synthetic-${i}`),
    );
  }, 'WS/WSS raw/channel incoming and push');
  assert.ok(!received.some((e) => e.data === 'drop-out'));
  assert.ok(!(await readEvents()).some((e) => e.data === 'drop-in'));
  await evaluate("utf8Send('replace-utf8')");
  await evaluate('streamSend()');
  await until(async () => (await readEvents()).some((e) => e.streamDone), 'Flutter addStream');
  await until(
    () => received.filter((e) => e.index === 0 && e.data === 'modified-0-outbound').length === 3,
    'Flutter utf8+stream hook',
  );
  await injector.detach();
  for (let index = 0; index < 4; index++) {
    await evaluate(`send(${index},'replace-restored')`);
    peers.get(index).send('replace-restored-in');
  }
  await until(() => received.filter((e) => e.data === 'replace-restored').length === 4, 'restore outgoing');
  await until(
    async () => (await readEvents()).filter((e) => e.data === 'replace-restored-in').length === 4,
    'restore incoming',
  );
  // Keep hooks installed across Hot Restart, then discover the new application Isolate.
  const beforeRestart = await injector.scan([isolateId], [], false);
  const oldIsolateId = isolateId;
  const restartId = ++machineId;
  const restarted = new Promise((resolveRestart, rejectRestart) => {
    const timeout = setTimeout(() => rejectRestart(Error('Flutter Hot Restart timeout')), 90000);
    commands.set(restartId, (message) => {
      clearTimeout(timeout);
      message.error ? rejectRestart(Error('Flutter Hot Restart failed')) : resolveRestart(message.result);
    });
  });
  child.stdin.write(
    JSON.stringify([
      { id: restartId, method: 'app.restart', params: { appId, fullRestart: true, pause: false } },
    ]) + '\n',
  );
  await restarted;
  await until(async () => {
    const next = await client.call('getVM');
    const mainIsolate = next.isolates.find((i) => i.name === 'main');
    if (!mainIsolate || mainIsolate.id === oldIsolateId) return false;
    isolateId = mainIsolate.id;
    const info = await client.call('getIsolate', { isolateId });
    library = info.libraries.find((l) => l.uri.endsWith('/main.dart'));
    return !!library;
  }, 'Hot Restart new isolate');
  peers.clear();
  await evaluate('connect()');
  await until(
    async () => (await readEvents()).some((e) => e.ready) && peers.size === 4,
    'Hot Restart new sockets',
  );
  const afterRestart = await injector.scan([isolateId], [], false);
  assert.ok(beforeRestart.every((old) => afterRestart.find((c) => c.id === old.id)?.status === 'closed'));
  const reopened = afterRestart.filter((c) => c.status === 'open');
  assert.equal(reopened.length, 4);
  assert.ok(reopened.every((c) => !beforeRestart.some((old) => old.id === c.id)));
  await assert.rejects(injector.push(beforeRestart[0].id, 'stale-push'), /未接入|关闭/);
  await evaluate("send(0,'after-hot-restart')");
  await until(() => received.some((e) => e.data === 'after-hot-restart'), 'Hot Restart capture');
  await until(() => messages.some((m) => m.original === 'after-hot-restart'), 'Hot Restart saved event');
  await evaluate('finish()');
  await until(async () => (await readEvents()).some((e) => e.closed), 'close');
  await injector.dispose();
  await client.disconnect();
  client = undefined;
  const after = createHash('sha256')
    .update(await readFile(main))
    .digest('hex');
  assert.equal(after, before);
  const id = ++machineId;
  child.stdin.write(JSON.stringify([{ id, method: 'app.stop', params: { appId } }]) + '\n');
  await sleep(1500);
  console.log(
    JSON.stringify(
      {
        passed: true,
        device,
        flutter: execFileSync(flutter, ['--version'], { encoding: 'utf8' }).split('\n')[0],
        connections: 4,
        coverage: [
          'WS dart:io',
          'WSS dart:io',
          'WS web_socket_channel 3.0.3',
          'WSS web_socket_channel 3.0.3',
          'per-connection replace/drop/push isolation',
          'addUtf8Text',
          'addStream',
          'detach restores all four connections',
          'Hot Restart isolate rediscovery, new connection identity, stale push rejection and resumed capture',
        ],
        messages: messages.length,
        fixtureSha256Unchanged: before === after,
        noUserAppChanged: true,
        warnings,
      },
      null,
      2,
    ),
  );
} finally {
  if (injector) await injector.dispose().catch(() => {});
  if (client) client.disconnect();
  if (child) child.kill();
  for (const peer of peers.values()) peer.terminate();
  for (const server of servers.reverse()) await new Promise((r) => server.close(() => r()));
  await rm(temp, { recursive: true, force: true });
}

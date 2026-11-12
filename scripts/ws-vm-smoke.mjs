import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve('.');
const temp = await mkdtemp(join(tmpdir(), 'flutter-pilot-ws-vm-'));
const dart = process.env.DART ?? 'dart';
const children = [];
const servers = [];
const clients = [];
const mcpClients = [];
const mcpServers = [];
const results = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (test()) return;
    await pause(30);
  }
  throw new Error(`等待失败：${label}`);
}
try {
  await build({
    stdin: {
      contents: `export {WsVmInjector} from ${JSON.stringify(join(root, 'src/vm/websocket.ts'))};export {VmServiceClient} from ${JSON.stringify(join(root, 'src/vm/client.ts'))};export {VmNetworkProfiler} from ${JSON.stringify(join(root, 'src/vm/profiler.ts'))};export {McpSessionServer} from ${JSON.stringify(join(root, 'src/mcp/server.ts'))};export {McpNetworkController} from ${JSON.stringify(join(root, 'src/mcp/network.ts'))};`,
      resolveDir: root,
    },
    outfile: join(temp, 'runtime.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  await build({
    entryPoints: [join(root, 'src/mcp/bridge.ts')],
    outfile: join(temp, 'bridge.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const { WsVmInjector, VmServiceClient, VmNetworkProfiler, McpSessionServer, McpNetworkController } =
    createRequire(import.meta.url)(join(temp, 'runtime.cjs'));
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
      '/CN=Flutter Pilot Test Root',
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
  const fixture = `import 'dart:io';
import 'dart:convert';
import 'dart:async';
late WebSocket business;
late StreamSubscription subscription;
Future<void> main(List<String> args) async {
  HttpClient? client;
  if (args.length > 1) { final context=SecurityContext(withTrustedRoots:true)..setTrustedCertificates(args[1]);client=HttpClient(context:context); }
  business=await WebSocket.connect(args[0],customClient:client);
  subscription=business.listen((dynamic data){stdout.writeln(jsonEncode({'received': data, 'binary': data is List<int>}));},onError:(dynamic e){stdout.writeln(jsonEncode({'error':true}));},onDone:(){stdout.writeln(jsonEncode({'done':true}));});
  stdout.writeln('READY');
  await for(final line in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
    final c=jsonDecode(line);
    if(c['send']!=null)business.add(c['send'] is List ? List<int>.from(c['send']) : c['send']);
    if(c['burst']==true){for(var i=0;i<500;i++)business.add('burst-$i');}
    if(c['utf8']!=null)business.addUtf8Text(utf8.encode(c['utf8']));
    if(c['stream']!=null){await business.addStream(Stream<dynamic>.fromIterable(c['stream']));stdout.writeln(jsonEncode({'streamDone':true}));}
    if(c['pause']==true)subscription.pause();
    if(c['resume']==true)subscription.resume();
    if(c['close']==true){await business.close();stdout.writeln(jsonEncode({'closed':true}));}
    if(c['new']==true){business=await WebSocket.connect(args[0],customClient:client);subscription=business.listen((dynamic data){stdout.writeln(jsonEncode({'received':data}));});stdout.writeln(jsonEncode({'newReady':true}));}
    if(c['exit']==true)exit(0);
  }
}`;
  const fixtureFile = join(temp, 'fixture.dart');
  await writeFile(fixtureFile, fixture);
  const source = await readFile(fixtureFile, 'utf8');
  for (const secure of [false, true]) {
    const https = secure
      ? createServer({
          key: await readFile(join(temp, 'key.pem')),
          cert: await readFile(join(temp, 'cert.pem')),
        })
      : undefined;
    if (https) {
      servers.push(https);
      await new Promise((r) => https.listen(0, '127.0.0.1', r));
    }
    const server = secure
      ? new WebSocketServer({ server: https })
      : new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    if (!secure) await new Promise((r) => server.once('listening', r));
    const received = [];
    let peer;
    let pong = false;
    server.on('connection', (socket) => {
      peer = socket;
      socket.on('message', (data, binary) => {
        received.push(binary ? [...data] : data.toString());
      });
      socket.on('pong', () => {
        pong = true;
      });
    });
    const port = secure ? https.address().port : server.address().port;
    const target = `${secure ? 'wss' : 'ws'}://127.0.0.1:${port}/business`;
    const child = spawn(
      dart,
      ['--enable-vm-service=0', fixtureFile, target, ...(secure ? [join(temp, 'ca.pem')] : [])],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    children.push(child);
    let output = '';
    let stderr = '';
    let buffer = '';
    const app = [];
    child.stdout.on('data', (chunk) => {
      output += chunk;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        try {
          app.push(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    await until(
      () => output.includes('READY') && /http:\/\/127\.0\.0\.1:\d+\/[^\s]*\//.test(output),
      'Dart fixture ' + (secure ? 'WSS' : 'WS') + ' ' + stderr,
    );
    const service = output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*\//)?.[0];
    assert.ok(service, '必须提供 VM 地址');
    const client = new VmServiceClient();
    clients.push(client);
    await client.connect(service.replace('http:', 'ws:') + 'ws');
    await client.call('streamListen', { streamId: 'Extension' });
    const vm = await client.call('getVM');
    const isolateIds = vm.isolates.filter((i) => !i.isSystemIsolate).map((i) => i.id);
    const injector = new WsVmInjector(client, {
      templatePath: join(root, 'resources/vm/websocket.dart.txt'),
      maxBodyBytes: 1024,
    });
    const messages = [];
    let omitted = 0;
    const warnings = [];
    injector.on('message', (m) => messages.push(m));
    injector.on('warning', (w) => warnings.push(w));
    injector.on('omitted', (n) => (omitted += n));
    const connections = await injector.scan(isolateIds, [], false);
    assert.equal(connections.length, 1, '仅一个业务连接；不包含 VM 控制 WS');
    const connection = connections[0];
    assert.equal(connection.capture, 'attached', JSON.stringify(warnings));
    assert.equal(connection.url, undefined, '接入前握手未知时不猜 URL');
    await injector.send(connection.id, 'capture-only-send');
    await until(() => received.includes('capture-only-send'), '无激活场景时手动发送');
    await injector.push(connection.id, 'capture-only-push');
    await until(() => app.some((m) => m.received === 'capture-only-push'), '无激活场景时手动推送');
    assert.ok(!received.includes('capture-only-push'), '采集模式推送不发往服务端');
    const rule = (id, direction, contains, action) => ({
      id,
      name: id,
      enabled: true,
      priority: 0,
      match: { connectionId: connection.id, direction, contains },
      action,
    });
    const rules = [
      rule('out-replace', 'outbound', 'replace', { type: 'replace', text: 'out-modified' }),
      rule('in-replace', 'inbound', 'replace', { type: 'replace', text: 'in-modified' }),
      rule('out-drop', 'outbound', 'drop', { type: 'drop' }),
      rule('in-drop', 'inbound', 'drop', { type: 'drop' }),
    ];
    await injector.scan(isolateIds, rules, true);
    const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
    send({ send: 'replace-first' });
    await until(() => received.includes('out-modified'), '首条出站修改');
    peer.send('replace-in');
    await until(() => app.some((m) => m.received === 'in-modified'), '入站修改');
    send({ send: 'drop-out' });
    peer.send('drop-in');
    await pause(150);
    assert.ok(!received.includes('drop-out'));
    assert.ok(!app.some((m) => m.received === 'drop-in'));
    await injector.push(connection.id, 'synthetic-push');
    await until(() => app.some((m) => m.received === 'synthetic-push'), '模拟推送');
    assert.ok(!received.includes('synthetic-push'), '模拟推送不发给服务器');
    await injector.send(connection.id, JSON.stringify({ topic: 'assets', data: { balance: 100 } }));
    await until(
      () => received.includes('{"topic":"assets","data":{"balance":100}}'),
      '真实连接手动发送 topic/data',
    );
    await injector.send(connection.id, 'replace-manual');
    await until(() => received.filter((m) => m === 'out-modified').length === 2, '手动发送经过出站替换规则');
    await injector.send(connection.id, 'drop-manual');
    await until(
      () =>
        messages.some(
          (m) => m.original === 'drop-manual' && m.outcome === 'dropped' && m.ruleId === 'out-drop',
        ),
      '手动发送记录规则丢弃',
    );
    assert.ok(!received.includes('drop-manual'), '手动发送丢弃后未到服务端');
    await assert.rejects(injector.send(connection.id, '中文'.repeat(200)), /1024 字节/);
    await assert.rejects(injector.send('stale-connection', 'no-send'), /未接入/);
    // Exercise the actual SDK stdio -> authenticated IPC -> controller -> Dart path.
    const registryRoot = join(temp, secure ? 'mcp-wss' : 'mcp-ws');
    const network = new McpNetworkController({
      injectWs: (id, text, signal) => injector.push(id, text, signal),
      sendWs: (id, text, signal) => injector.send(id, text, signal),
      messages: async (query) => ({
        items: messages.filter((m) => m.connectionId === query.connectionId),
        total: messages.length,
      }),
    });
    const mcpServer = new McpSessionServer({
      registryRoot,
      workspace: temp,
      sessionId: 'ws-runtime',
      name: 'WS runtime smoke',
      describe: () => ({ vmConnected: true }),
      call: (tool, args, context) => network.execute(tool, args, context.signal),
    });
    mcpServers.push(mcpServer);
    await mcpServer.start();
    const mcpClient = new Client({ name: 'ws-runtime-smoke', version: '1.0.0' });
    mcpClients.push(mcpClient);
    await mcpClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(temp, 'bridge.cjs'), '--registry', registryRoot, '--workspace', temp],
        stderr: 'pipe',
      }),
    );
    const sessions = await mcpClient.callTool({ name: 'list_sessions', arguments: {} });
    assert.ok(!sessions.isError, '真实 MCP 会话发现');
    const inboundText = '{"topic":"asset.updated","data":{"balance":200}}';
    const injected = await mcpClient.callTool({
      name: 'inject_ws_message',
      arguments: {
        sessionId: 'ws-runtime',
        connectionId: connection.id,
        topic: 'asset.updated',
        data: { balance: 200 },
      },
    });
    assert.equal(injected.structuredContent.direction, 'inbound');
    await until(() => app.some((m) => m.received === inboundText), 'MCP topic/data 注入 App');
    assert.ok(!received.includes(inboundText), 'MCP 注入不发给服务端');
    const outboundText = '{"topic":"asset.subscribe","data":{"account":"demo"}}';
    const submitted = await mcpClient.callTool({
      name: 'send_ws_message',
      arguments: {
        sessionId: 'ws-runtime',
        connectionId: connection.id,
        topic: 'asset.subscribe',
        data: { account: 'demo' },
      },
    });
    assert.equal(submitted.structuredContent.submitted, true);
    assert.equal(submitted.structuredContent.direction, 'outbound');
    await until(() => received.includes(outboundText), 'MCP topic/data 发往真实服务端');
    await until(() => messages.some((m) => m.original === outboundText), 'MCP 手动发送可追溯记录');
    const recorded = await mcpClient.callTool({
      name: 'get_ws_messages',
      arguments: { sessionId: 'ws-runtime', connectionId: connection.id, includeBodies: true },
    });
    assert.ok(
      recorded.structuredContent.items.some((m) => m.original === inboundText && m.outcome === 'synthetic'),
    );
    assert.ok(
      recorded.structuredContent.items.some((m) => m.original === outboundText && m.direction === 'outbound'),
    );
    await mcpClient.close();
    await mcpServer.stop();
    send({ stream: ['stream-one', 'replace-stream', 'drop-stream', 'stream-two'] });
    await until(() => app.some((m) => m.streamDone), 'addStream 完成');
    await until(() => received.includes('stream-two'), 'addStream 修改和丢弃');
    assert.ok(!received.includes('replace-stream'));
    assert.ok(!received.includes('drop-stream'));
    send({ utf8: 'replace-utf8' });
    await until(() => received.filter((m) => m === 'out-modified').length === 4, 'addUtf8Text 修改');
    send({ send: [1, 2, 3] });
    peer.send(Buffer.from([4, 5, 6]));
    await until(() => received.some((m) => Array.isArray(m) && m.join(',') === '1,2,3'), '出站二进制直通');
    await until(
      () => app.some((m) => Array.isArray(m.received) && m.received.join(',') === '4,5,6'),
      '入站二进制直通',
    );
    peer.ping('ping');
    await until(() => pong, 'ping/pong 保留');
    send({ pause: true });
    await pause(50);
    peer.send('paused');
    await pause(100);
    assert.ok(!app.some((m) => m.received === 'paused'));
    send({ resume: true });
    await until(() => app.some((m) => m.received === 'paused'), '暂停恢复');
    send({ send: 'x'.repeat(2000) });
    await until(() => received.some((m) => typeof m === 'string' && m.length === 2000), '超限消息完整直通');
    await until(
      () =>
        messages.some((m) => m.outcome === 'synthetic') &&
        messages.some((m) => m.kind === 'binary') &&
        messages.some((m) => m.truncated),
      '消息记录',
    );
    assert.ok(messages.some((m) => m.outcome === 'dropped'));
    assert.ok(messages.every((m) => !m.truncated || m.original.length <= 1024));
    send({ burst: true });
    await until(
      () => received.filter((m) => typeof m === 'string' && m.startsWith('burst-')).length === 500,
      '高频消息不阻塞业务',
    );
    await until(() => omitted >= 400, '有界队列遗漏计数');
    await injector.detach();
    await assert.rejects(injector.send(connection.id, 'stale-after-detach'), /未接入/);
    send({ send: 'replace-restored' });
    peer.send('replace-restored-in');
    await until(
      () => received.includes('replace-restored') && app.some((m) => m.received === 'replace-restored-in'),
      '停用后原连接恢复',
    );
    const second = await injector.scan(isolateIds, [], false);
    const secondId = second.find((c) => c.status === 'open').id;
    await injector.scan(
      isolateIds,
      [{ ...rules[0], match: { connectionId: secondId, direction: 'outbound', contains: 'replace' } }],
      true,
    );
    await pause(15400);
    send({ send: 'replace-expired' });
    await until(() => received.includes('replace-expired'), '租约过期旁路');
    await injector.detach();
    send({ close: true });
    await until(() => app.some((m) => m.closed), '关闭连接');
    const profiler = new VmNetworkProfiler(client, { pollIntervalMs: 100 });
    const handshakes = [];
    profiler.on('websocket', (entry, handshake) => {
      if (handshake) handshakes.push(handshake);
    });
    await profiler.start();
    send({ new: true });
    await until(() => app.some((m) => m.newReady), '创建新连接');
    await until(() => handshakes.length === 1, 'SDK profiling WebSocket 握手');
    assert.equal(handshakes[0].url, target);
    const newConnections = await injector.scan(isolateIds, [], false, handshakes);
    assert.equal(newConnections.find((c) => c.status === 'open').url, target);
    await injector.scan(
      isolateIds,
      [
        {
          id: 'url-rule',
          name: 'url-rule',
          enabled: true,
          priority: 0,
          match: { url: target, direction: 'outbound', contains: 'url-match' },
          action: { type: 'replace', text: 'url-modified' },
        },
      ],
      true,
      handshakes,
    );
    send({ send: 'url-match' });
    await until(() => received.includes('url-modified'), 'profiling → URL匹配 → Mock');
    await profiler.stop();
    // Another tool may wrap our callback; disabling must not overwrite its new handler.
    const isolate = await client.call('getIsolate', { isolateId: isolateIds[0] });
    const httpLibrary = isolate.libraries.find((l) => l.uri === 'dart:_http');
    const asyncLibrary = isolate.libraries.find((l) => l.uri === 'dart:async');
    const evaluate = async (targetId, expression, scope = {}) => {
      const value = await client.call('evaluate', {
        isolateId: isolateIds[0],
        targetId,
        expression,
        scope,
        disableBreakpoints: true,
      });
      assert.ok(!['Error', '@Error', 'Sentinel'].includes(value.type), 'isolated ownership probe');
      return value;
    };
    const controller = await evaluate(
      httpLibrary.id,
      '_WebSocketImpl._webSockets.values.firstWhere((s) => !s._serverSide)._consumer._ensureController()',
    );
    const subscription = await evaluate(controller.id, '_subscription');
    const old = await evaluate(subscription.id, '_onData');
    const external = await evaluate(
      asyncLibrary.id,
      '(() { sub.onData((dynamic data) { previous(data); }); return sub._onData; })()',
      { sub: subscription.id, previous: old.id },
    );
    const changed = await injector.scan(isolateIds, [], false, handshakes);
    assert.equal(changed.find((c) => c.status === 'open').capture, 'unsupported');
    send({ send: 'url-match' });
    await until(() => received.includes('url-match'), '外部包装后的旧插件回调旁路');
    await injector.detach();
    const preserved = await evaluate(asyncLibrary.id, 'identical(sub._onData, external)', {
      sub: subscription.id,
      external: external.id,
    });
    assert.equal(preserved.valueAsString, 'true', '卸载不覆盖外部处理器');

    assert.equal(newConnections.filter((c) => c.status === 'open').length, 1);
    send({ close: true });
    await until(() => app.filter((m) => m.closed).length === 2, '接入后未发送即关闭');
    await injector.dispose();
    await client.disconnect();
    send({ exit: true });
    assert.equal(await readFile(fixtureFile, 'utf8'), source, 'fixture 源码不变');
    results.push({
      transport: secure ? 'WSS' : 'WS',
      passed: true,
      messages: messages.length,
      omitted,
      warnings,
    });
    for (const socket of server.clients) socket.terminate();
    if (stderr.trim()) assert.ok(!stderr.includes('Unhandled exception'), 'Dart 运行异常');
  }
  console.log(
    JSON.stringify(
      {
        dart: execFileSync(dart, ['--version'], { encoding: 'utf8' }).trim(),
        results,
        scope: '隔离 Dart Debug VM；不是 Flutter 设备验收',
      },
      null,
      2,
    ),
  );
} finally {
  for (const client of mcpClients) await client.close().catch(() => {});
  for (const server of mcpServers) await server.stop().catch(() => {});
  for (const client of clients) await Promise.resolve(client.disconnect()).catch(() => {});
  for (const child of children) child.kill();
  for (const server of servers.reverse()) await new Promise((r) => server.close(() => r()));
  await rm(temp, { recursive: true, force: true });
}

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = resolve('.');
const dart = process.env.DART ?? 'dart';
const packageConfig =
  process.env.VM_PACKAGE_CONFIG ?? join(root, 'examples/flutter/.dart_tool/package_config.json');
const temp = await mkdtemp(join(tmpdir(), 'flutter-pilot-vm-injection-'));
await build({
  entryPoints: ['src/vm/injection.ts'],
  outfile: join(temp, 'injector.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { DioVmInjector } = createRequire(import.meta.url)(join(temp, 'injector.cjs'));
const fixture = `import 'dart:convert';
import 'dart:io';
import 'package:dio/dio.dart';
Dio makeClient() { final d=Dio();d.interceptors.add(InterceptorsWrapper(onRequest:(options,handler) {options.headers['x-existing']='kept';handler.next(options);}, onResponse:(response,handler){if(response.requestOptions.uri.path=='/business-error')handler.reject(DioException(requestOptions:response.requestOptions,response:response,error:'synthetic business failure'),true);else handler.next(response);}));return d;}
final clients = [makeClient(), makeClient()];
Future<void> main() async {
  stdout.writeln('FIXTURE_READY ' + clients.length.toString());
  await for (final line in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
    final c = jsonDecode(line) as Map;
    if(c['create'] == true) {clients.add(makeClient()); stdout.writeln(jsonEncode({'commandId': c['id'], 'clients':clients.length})); continue;}
    try {
      final r = await clients[c['client'] ?? 0].request(c['url'], data:c['bytes']==true ? List<int>.from(c['body']) : c['body'], options: Options(method:c['method'] ?? 'GET', responseType:c['stream']==true ? ResponseType.stream : ResponseType.json, headers:Map<String,dynamic>.from(c['headers'] ?? {})));
      final data=r.data;final streamed=data is ResponseBody ? await utf8.decoder.bind(data.stream).join() : null;
      stdout.writeln(jsonEncode({'commandId':c['id'],'status':r.statusCode,'data':data is ResponseBody ? streamed : data,'headers':r.headers.map,if(data is ResponseBody)'streamStatus':data.statusCode,if(data is ResponseBody)'streamHeaders':data.headers}));
    } on DioException catch(e) { stdout.writeln(jsonEncode({'commandId':c['id'],'status':e.response?.statusCode,'data':e.response?.data,'error':e.type.name})); }
  }
}`;
await writeFile(join(temp, 'fixture.dart'), fixture);
let hits = 0;
const server = createServer(async (req, res) => {
  hits++;
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url === '/delayed-observation') await new Promise((resolve) => setTimeout(resolve, 250));
  res.writeHead(req.url.startsWith('/upstream-error') ? 503 : 200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      upstream: true,
      method: req.method,
      path: req.url,
      body,
      authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null,
      proxyAuthorization: req.headers['proxy-authorization'] ?? null,
      host: req.headers.host,
      marker: req.headers['x-marker'] ?? null,
      existing: req.headers['x-existing'] ?? null,
    }),
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const child = spawn(
  dart,
  ['--enable-vm-service=0', `--packages=${packageConfig}`, join(temp, 'fixture.dart')],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
let lineBuffer = '';
let output = '',
  serviceUri,
  fixtureReady = false;
let resolveReady, rejectReady;
const ready = new Promise((r, j) => {
  resolveReady = r;
  rejectReady = j;
});
const pendingCommands = new Map();
let commandSequence = 0;
child.stdout.on('data', (data) => {
  output += data.toString();
  const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*\//);
  if (match) serviceUri = match[0];
  if (output.includes('FIXTURE_READY')) fixtureReady = true;
  if (serviceUri && fixtureReady) resolveReady();
  lineBuffer += data.toString();
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop();
  for (const line of lines) {
    try {
      const m = JSON.parse(line);
      if (m.commandId) {
        const p = pendingCommands.get(m.commandId);
        if (p) {
          pendingCommands.delete(m.commandId);
          p(m);
        }
      }
    } catch {}
  }
});
let stderr = '';
child.stderr.on('data', (data) => {
  stderr += data;
});
child.on('exit', () => rejectReady(Error('Dart fixture exited: ' + stderr)));
child.once('error', () => rejectReady(Error('无法启动 Dart；请通过 DART 指定 SDK 可执行文件路径')));
const timer = setTimeout(() => rejectReady(Error('VM startup timeout')), 15000);
let ws, injector;
try {
  await ready;
  clearTimeout(timer);
  ws = new WebSocket(serviceUri.replace('http:', 'ws:') + 'ws');
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const rpc = new EventEmitter();
  const requests = new Map();
  let rpcId = 0;
  rpc.call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = String(++rpcId);
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(Error(`RPC ${method} timeout`));
      }, 12000);
      requests.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = requests.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        requests.delete(m.id);
        m.error
          ? p.reject(
              Error(
                JSON.stringify({
                  code: m.error.code,
                  message: m.error.message,
                  details: m.error.data?.details,
                  keys: Object.keys(m.error.data ?? {}),
                }).slice(0, 6000),
              ),
            )
          : p.resolve(m.result);
      }
    } else rpc.emit('notification', m);
  });
  await rpc.call('streamListen', { streamId: 'Extension' });
  const vm = await rpc.call('getVM');
  const isolateId = vm.isolates.find((i) => i.name === 'main').id;
  injector = new DioVmInjector(rpc, { templatePath: join(root, 'resources/vm/interceptor.dart.txt') });
  const histories = [],
    observations = [];
  injector.on('history', (entry) => histories.push(entry));
  injector.on('observation.http', (entry) => observations.push(entry));
  const command = async (options, expectHistory = true) => {
    const before = histories.length;
    const result = await new Promise((resolve, reject) => {
      const id = ++commandSequence;
      const timer = setTimeout(() => {
        pendingCommands.delete(id);
        reject(Error('fixture command timeout'));
      }, 12000);
      pendingCommands.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.stdin.write(JSON.stringify({ ...options, id }) + '\n');
    });
    if (expectHistory && !options.create) {
      const end = Date.now() + 1500;
      while (histories.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      assert.equal(histories.length, before + 1, 'one history per request');
    }
    return result;
  };
  const rule = (id, patch = {}) => ({
    id,
    name: id,
    enabled: true,
    priority: 0,
    match: { host: '127.0.0.1', path: '/mock' },
    ...patch,
  });
  let rules = [
    rule('mock', {
      mock: {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '999',
          'content-encoding': 'gzip',
          'transfer-encoding': 'chunked',
        },
        body: '{"mocked":true}',
      },
    }),
  ];
  const initial = await injector.sync(isolateId, rules);
  assert.equal(initial.instances, 2);
  const observedBefore = observations.length,
    completedBefore = histories.length;
  const pendingObservation = command({ url: base + '/delayed-observation' });
  const observationDeadline = Date.now() + 1500;
  while (observations.length === observedBefore && Date.now() < observationDeadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(observations.length, observedBefore + 1);
  assert.equal(histories.length, completedBefore, 'pending request is visible before its response');
  assert.equal(observations.at(-1).response, undefined);
  await pendingObservation;
  assert.equal(histories.at(-1).id, observations.at(-1).id, 'completion retains the observed request id');
  console.log('PASS pending request observed before delivery without adding incomplete history');
  let before = hits;
  let result = await command({ url: base + '/mock' });
  assert.deepEqual(result.data, { mocked: true });
  assert.equal(result.headers['content-length'], undefined);
  assert.equal(result.headers['content-encoding'], undefined);
  assert.equal(result.headers['transfer-encoding'], undefined);
  assert.equal(hits, before);
  assert.equal(histories.at(-1).mocked, true);
  console.log('PASS existing Dio instances + local mock without upstream');
  result = await command({ url: base + '/mock', client: 1 });
  assert.deepEqual(result.data, { mocked: true });
  console.log('PASS multiple Dio instances');
  const markerText = '__RULES__ __TAG__ __CLIENTS__ for (final client in clients) $HOME ${1+1}';
  await injector.sync(isolateId, [
    rule('literal-markers', {
      mock: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ literal: markerText }),
      },
    }),
  ]);
  result = await command({ url: base + '/mock' });
  assert.deepEqual(result.data, { literal: markerText });
  console.log('PASS rule text/template markers/Dart interpolation remain literal');
  rules = [
    rule('mock', {
      mock: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"updated":true}' },
    }),
    rule('response', { priority: 9, response: { status: 201, body: '{"responseModified":true}' } }),
  ];
  await injector.sync(isolateId, rules);
  result = await command({ url: base + '/mock' });
  assert.equal(result.status, 201);
  assert.deepEqual(result.data, { responseModified: true });
  assert.equal(histories.at(-1).originalResponse.status, 200);
  assert.equal(histories.at(-1).response.status, 201);
  console.log('PASS rule update + local mock response stage + original/final snapshots');
  result = await command({ url: base + '/mock', stream: true });
  assert.equal(result.status, 201);
  assert.equal(result.streamStatus, 201);
  assert.equal(result.streamHeaders['content-type'][0], 'application/json');
  assert.equal(typeof result.data, 'string');
  console.log(
    'PASS stream mock inner status/headers match outer response without consuming stream in interceptor',
  );
  rules = [
    rule('request', {
      match: { path: '/request' },
      request: {
        method: 'POST',
        headers: { 'x-marker': 'changed' },
        query: { q: 'changed', obsolete: null },
        body: '{"patched":true}',
      },
    }),
  ];
  await injector.sync(isolateId, rules);
  result = await command({
    url: base + '/request?obsolete=old&keep=first&keep=second',
    method: 'GET',
    body: { old: true },
  });
  assert.equal(result.data.method, 'POST');
  assert.equal(result.data.marker, 'changed');
  assert.equal(result.data.body, '{"patched":true}');
  assert.equal(result.data.path, '/request?keep=first&keep=second&q=changed');
  assert.equal(result.data.existing, 'kept');
  console.log('PASS request method/query/headers/body modification');
  await injector.sync(isolateId, []);
  const binaryBaseline = await command({
    url: base + '/binary',
    method: 'POST',
    bytes: true,
    body: [65, 66, 67],
    headers: { 'content-type': 'application/octet-stream' },
  });
  await injector.sync(isolateId, [
    rule('binary-body', {
      match: { path: '/binary' },
      request: { headers: { 'content-type': 'text/plain' }, body: 'must-not-replace-binary' },
    }),
  ]);
  result = await command({
    url: base + '/binary',
    method: 'POST',
    bytes: true,
    body: [65, 66, 67],
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.equal(result.data.body, binaryBaseline.data.body);
  assert.equal(histories.at(-1).originalRequest.editable, false);
  assert.equal(histories.at(-1).originalRequest.bodyEncoding, 'base64');
  assert.equal(histories.at(-1).originalRequest.body, 'QUJD');
  console.log(
    'PASS ordinary List<int> binary upload stays byte-identical despite body/header modification rule',
  );
  await injector.sync(isolateId, [
    rule('binary-body', {
      match: { path: '/binary' },
      request: { body: 'must-not-replace-binary' },
    }),
  ]);
  result = await command({
    url: base + '/binary',
    method: 'POST',
    body: 'original-binary-text',
    headers: { 'content-type': 'application/octet-stream' },
  });
  assert.equal(result.data.body, 'original-binary-text');
  assert.equal(histories.at(-1).originalRequest.editable, false);
  console.log('PASS octet-stream String body stays read-only');
  await injector.sync(isolateId, [
    rule('json-array', {
      match: { path: '/binary' },
      request: { body: '[4,5,6]' },
    }),
  ]);
  result = await command({
    url: base + '/binary',
    method: 'POST',
    bytes: true,
    body: [1, 2, 3],
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(result.data.body, '[4,5,6]');
  assert.equal(histories.at(-1).originalRequest.editable, true);
  console.log('PASS explicitly JSON numeric array remains editable');
  rules = [
    rule('redirect', {
      match: { path: '/redirect' },
      redirect: { url: base.replace('127.0.0.1', 'localhost') + '/target' },
      request: { headers: { 'x-marker': 'forwarded' } },
    }),
    rule('after-redirect', { match: { path: '/redirect' }, response: { body: '{"matchedOriginal":true}' } }),
  ];
  await injector.sync(isolateId, rules);
  result = await command({
    url: base + '/redirect?discard=1',
    method: 'POST',
    body: { redirectBody: true },
    headers: {
      authorization: 'synthetic-source-secret',
      cookie: 'test-cookie=1',
      'proxy-authorization': 'synthetic-proxy-secret',
      host: 'old.invalid',
    },
  });
  assert.deepEqual(result.data, { matchedOriginal: true });
  const entry = histories.at(-1);
  assert.equal(entry.targetUrl.endsWith('/target'), true);
  const forwarded = JSON.parse(entry.originalResponse.body);
  assert.equal(forwarded.authorization, 'synthetic-source-secret');
  assert.equal(forwarded.cookie, 'test-cookie=1');
  assert.equal(forwarded.proxyAuthorization, 'synthetic-proxy-secret');
  assert.equal(forwarded.host, `localhost:${port}`);
  assert.equal(forwarded.path, '/target');
  assert.equal(forwarded.marker, 'forwarded');
  assert.equal(forwarded.method, 'POST');
  assert.equal(forwarded.body, '{"redirectBody":true}');
  console.log('PASS redirect preserves cross-origin credentials + response matches original request');
  for (const [target, expected] of [
    ['/private/new%2Fitem', '/private/new%2Fitem?a=1&a=2&signed=x%2Fy+z'],
    ['/private/new?own=2&own=3', '/private/new?own=2&own=3'],
    ['/private/new?', '/private/new?'],
    [base + '/private/absolute?own=1', '/private/absolute?own=1'],
  ]) {
    await injector.sync(isolateId, [
      rule('private-path', { match: { path: '/private/old' }, redirect: { url: target } }),
    ]);
    const beforeHits = hits;
    result = await command({
      url: base + '/private/old?a=1&a=2&signed=x%2Fy+z',
      method: 'PATCH',
      body: 'unchanged-private-body',
      headers: {
        authorization: 'Bearer synthetic-private',
        cookie: 'session=synthetic',
        'x-marker': 'keep',
        'content-type': 'text/plain',
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.path, expected);
    assert.equal(result.data.upstream, true);
    assert.equal(result.data.authorization, 'Bearer synthetic-private');
    assert.equal(result.data.cookie, 'session=synthetic');
    assert.equal(result.data.marker, 'keep');
    assert.equal(result.data.method, 'PATCH');
    assert.equal(result.data.body, 'unchanged-private-body');
    assert.equal(hits, beforeHits + 1);
    assert.equal(histories.at(-1).mocked, false);
  }
  console.log('PASS private path and complete URL redirects preserve real requests and query semantics');
  rules = [
    rule('badmock', {
      mock: { status: 503, headers: { 'content-type': 'application/json' }, body: '{"maintenance":true}' },
    }),
  ];
  await injector.sync(isolateId, rules);
  result = await command({ url: base + '/mock' });
  assert.equal(result.status, 503);
  assert.equal(result.error, 'badResponse');
  console.log('PASS mock 503 follows Dio validateStatus error path');
  rules = [
    rule('recover-error', {
      match: { path: '/upstream-error' },
      response: { status: 200, body: '{"recovered":true}' },
    }),
  ];
  await injector.sync(isolateId, rules);
  result = await command({ url: base + '/upstream-error' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { recovered: true });
  assert.equal(histories.at(-1).originalResponse.status, 503);
  console.log('PASS upstream 503 response modified to 200 in onError');
  rules = [
    rule('make-error', { match: { path: '/normal' }, response: { status: 500, body: '{"nowError":true}' } }),
  ];
  await injector.sync(isolateId, rules);
  result = await command({ url: base + '/normal' });
  assert.equal(result.status, 500);
  assert.equal(result.error, 'badResponse');
  console.log('PASS response 200 modified to 500 follows error path');
  await command({ create: true });
  rules = [
    rule('new-instance', {
      mock: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"newInstance":true}' },
    }),
  ];
  const discovered = await injector.sync(isolateId, rules);
  assert.equal(discovered.instances, 3);
  result = await command({ url: base + '/mock', client: 2 });
  assert.deepEqual(result.data, { newInstance: true });
  console.log('PASS newly created Dio discovered without duplicate interception');
  await injector.sync(isolateId, [{ ...rules[0], enabled: false }]);
  before = hits;
  result = await command({ url: base + '/mock' });
  assert.equal(result.data.upstream, true);
  assert.equal(hits, before + 1);
  console.log('PASS disabled rule passthrough');
  await injector.sync(isolateId, []);
  result = await command({ url: base + '/business-error' });
  assert.equal(result.status, 200);
  assert.equal(result.error, 'unknown');
  await injector.sync(isolateId, [
    rule('body-only', { match: { path: '/business-error' }, response: { body: '{\"changed\":true}' } }),
  ]);
  result = await command({ url: base + '/business-error' });
  assert.equal(result.error, 'unknown');
  assert.deepEqual(result.data, { changed: true });
  console.log('PASS empty/body-only rules preserve original app business error classification');
  await injector.sync(isolateId, [
    rule('invalid-response-json', {
      match: { path: '/invalid-response' },
      response: { body: '{invalid json' },
    }),
  ]);
  result = await command({ url: base + '/invalid-response' });
  assert.equal(result.error, 'unknown');
  assert.equal(histories.at(-1).error, 'vmRuleApplicationFailed');
  console.log('PASS invalid response JSON records rule failure instead of losing history');
  await injector.sync(isolateId, rules);
  await injector.heartbeat();
  before = histories.length;
  result = await command({ url: 'http://127.0.0.1:1/no-server' });
  assert.equal(result.error, 'connectionError');
  assert.equal(histories.length, before + 1);
  assert.equal(typeof histories.at(-1).error, 'string');
  console.log('PASS network error history');
  await injector.detach();
  before = hits;
  result = await command({ url: base + '/mock' }, false);
  assert.equal(result.data.upstream, true);
  assert.equal(hits, before + 1);
  console.log('PASS detach restores real network behavior');
  await injector.sync(isolateId, rules);
  result = await command({ url: base + '/mock' });
  assert.deepEqual(result.data, { newInstance: true });
  console.log('PASS mock off/on reuses injector with live history events');
  const statefulRules = (runId, invalid = false) => [
    rule('initial-list', {
      match: { method: 'GET', path: '/orders' },
      scenario: { id: runId, initial: 'empty', when: 'empty' },
      mock: { status: 200, headers: {}, body: '[]' },
    }),
    rule('submit-once', {
      match: { method: 'POST', path: '/orders' },
      scenario: { id: runId, initial: 'empty', when: 'empty', next: 'pending' },
      mock: { status: 200, headers: {}, body: invalid ? '{invalid' : '{"orderId":"order-current"}' },
    }),
    rule('pending-list', {
      match: { method: 'GET', path: '/orders' },
      scenario: { id: runId, initial: 'empty', when: 'pending' },
      mock: { status: 200, headers: {}, body: '[{"orderId":"order-current","status":"pending"}]' },
    }),
  ];
  let scenarioRules = statefulRules('isolated-run-one');
  await injector.sync(isolateId, scenarioRules);
  assert.deepEqual((await command({ url: base + '/orders' })).data, []);
  const response = await command({
    url: base + '/orders',
    method: 'POST',
    body: { price: '10', quantity: '2' },
  });
  assert.equal(response.data.orderId, 'order-current');
  const pendingOrders = [{ orderId: 'order-current', status: 'pending' }];
  assert.deepEqual((await command({ url: base + '/orders' })).data, pendingOrders);
  await injector.heartbeat();
  await injector.sync(isolateId, scenarioRules);
  assert.deepEqual((await command({ url: base + '/orders' })).data, pendingOrders);
  await injector.sync(
    isolateId,
    scenarioRules.map((r) => ({ ...r, name: r.name + ' refreshed' })),
  );
  assert.deepEqual((await command({ url: base + '/orders' })).data, pendingOrders);
  await injector.sync(
    isolateId,
    scenarioRules.map((r) => ({ ...r, enabled: false })),
  );
  await injector.sync(isolateId, scenarioRules);
  assert.deepEqual((await command({ url: base + '/orders' })).data, pendingOrders);
  await injector.sync(isolateId, statefulRules('isolated-run-two'));
  assert.deepEqual((await command({ url: base + '/orders' })).data, []);
  await injector.sync(isolateId, []);
  await injector.sync(isolateId, scenarioRules);
  assert.deepEqual((await command({ url: base + '/orders' })).data, []);
  await injector.sync(isolateId, statefulRules('invalid-response-run', true));
  assert.equal((await command({ url: base + '/orders', method: 'POST', body: {} })).error, 'unknown');
  assert.deepEqual((await command({ url: base + '/orders' })).data, []);
  console.log(
    'PASS stateful mock synchronous commit, immediate refresh, sync/heartbeat/disabled preservation, run isolation, scope removal and malformed response does not commit',
  );

  console.log('Checking 15-second lease expiration without heartbeat...');
  await new Promise((r) => setTimeout(r, 15500));
  before = hits;
  result = await command({ url: base + '/mock' }, false);
  assert.equal(result.data.upstream, true);
  assert.equal(hits, before + 1);
  console.log('PASS lease expiration returns to passthrough');
  console.log(
    JSON.stringify({
      result: 'passed',
      dioInstances: 3,
      events: histories.length,
      checks: 32,
      upstreamHits: hits,
    }),
  );
} finally {
  clearTimeout(timer);
  if (injector) await injector.dispose().catch(() => {});
  if (ws) ws.close();
  child.kill();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}

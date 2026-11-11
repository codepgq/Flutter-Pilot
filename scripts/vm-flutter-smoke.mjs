// Runs the unchanged Flutter example on a real simulator and controls its
// existing Dio via VM expressions. No helper, proxy, certificate or test entry.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const root = resolve('.');
const flutter = process.env.FLUTTER ?? 'flutter';
const device = process.env.VM_FLUTTER_DEVICE;
if (!device) throw new Error('设置 VM_FLUTTER_DEVICE 为已启动的 iOS 模拟器 ID');
const temp = await mkdtemp(join(tmpdir(), 'flutter-pilot-vm-flutter-'));
await build({
  entryPoints: ['src/vm/session.ts'],
  outfile: join(temp, 'session.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { VmSession } = createRequire(import.meta.url)(join(temp, 'session.cjs'));
const source = join(root, 'examples/flutter/lib/main.dart');
const hash = async () =>
  createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
const beforeHash = await hash();
let hits = 0;
const server = createServer(async (req, res) => {
  hits++;
  let body = '';
  for await (const chunk of req) body += chunk;
  res.writeHead(req.url.startsWith('/error') ? 503 : 200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      upstream: true,
      method: req.method,
      path: req.url,
      marker: req.headers['x-vm-marker'],
      body,
    }),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const processChild = spawn(flutter, ['run', '--machine', '--no-pub', '-d', device], {
  cwd: join(root, 'examples/flutter'),
  stdio: ['pipe', 'pipe', 'pipe'],
});
let uri,
  appId,
  textBuffer = '',
  started = false;
let processError;
processChild.on('error', (error) => {
  processError = error;
});
let commandId = 0;
const commands = new Map();
const logs = [];
processChild.stdout.on('data', (chunk) => {
  textBuffer += chunk.toString();
  while (textBuffer.includes('\n')) {
    const n = textBuffer.indexOf('\n'),
      line = textBuffer.slice(0, n);
    textBuffer = textBuffer.slice(n + 1);
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
        if (m.event === 'app.log')
          logs.push(m.params.log.replace(/(?:ws|http):\/\/127\.0\.0\.1:\d+\/\S*/g, '[VM endpoint]'));
      }
    } catch {
      /* Non-machine build progress is not persisted. */
    }
  }
});
processChild.stderr.on('data', () => undefined);
const waitFor = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('验证等待超时');
};
const machine = async (method, params) => {
  const id = ++commandId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      commands.delete(id);
      reject(new Error(`Flutter ${method} timeout`));
    }, 90000);
    commands.set(id, (message) => {
      clearTimeout(timeout);
      message.error ? reject(new Error(`Flutter ${method} failed`)) : resolve(message.result);
    });
    processChild.stdin.write(JSON.stringify([{ id, method, params }]) + '\n');
  });
};
const session = new VmSession(
  join(temp, 'history'),
  { retentionDays: 7, maxRecords: 1000 },
  join(root, 'resources/vm/interceptor.dart.txt'),
);
const checks = [];
let isolateId, libraryId, dioId;
const discover = async () => {
  const vm = await session.client.call('getVM');
  const isolate = await session.client.call('getIsolate', {
    isolateId: vm.isolates.find((i) => i.name === 'main').id,
  });
  isolateId = isolate.id;
  libraryId = isolate.libraries.find((l) => l.uri === 'package:dio/src/dio_mixin.dart')?.id;
  if (!libraryId) return false;
  const classes = await session.client.call('getClassList', { isolateId });
  const dio = classes.classes.find((c) => c.name === 'Dio' && c.library?.uri === 'package:dio/src/dio.dart');
  const instances = await session.client.call('getInstances', {
    isolateId,
    objectId: dio.id,
    limit: 10,
    includeImplementers: true,
    includeSubclasses: true,
  });
  dioId = instances.instances[0]?.id;
  return !!dioId;
};
const evaluate = async (expression, scope = {}) => {
  const result = await session.client.call('evaluate', {
    isolateId,
    targetId: libraryId,
    expression,
    scope,
    disableBreakpoints: true,
  });
  if (result.type === '@Error' || result.type === 'Error') throw new Error('Flutter VM expression failed');
  return result;
};
const request = async (url, method = 'GET', body = null) => {
  // The result holder is a temporary VM object, not an application source edit.
  const expression = `(() { final result = <String,dynamic>{'done':false}; client.request(${JSON.stringify(url)}, data:jsonDecode(${JSON.stringify(JSON.stringify(body))}), options:Options(method:${JSON.stringify(method)})).then<void>((r) { result['status']=r.statusCode; result['data']=r.data; result['done']=true; }, onError:(Object e) { if(e is DioException) { result['status']=e.response?.statusCode; result['data']=e.response?.data; result['error']=e.type.name; } result['done']=true; }); return result; })()`;
  const holder = await evaluate(expression, { client: dioId });
  return waitFor(async () => {
    const read = await evaluate('jsonEncode(result)', { result: holder.id });
    const full = read.valueAsStringIsTruncated
      ? await session.client.call('getObject', { isolateId, objectId: read.id, offset: 0, count: 1048576 })
      : read;
    const value = JSON.parse(full.valueAsString);
    return value.done ? value : false;
  });
};
const rule = (id, match, actions) => ({ id, name: id, priority: 10, enabled: true, match, ...actions });
try {
  console.log('Building unchanged Flutter example; waiting for VM…');
  await waitFor(() => {
    if (processError) throw processError;
    return uri && started;
  }, 300000);
  await session.connect(uri, []);
  // This fixture contains only synthetic rules; retain compiler diagnostics for
  // reproducibility without exposing a real application's authentication data.
  session.client.socket?.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.error)
        console.log(
          'FIXTURE_VM_RPC_ERROR',
          String(message.error.data?.details ?? message.error.code).slice(0, 4000),
        );
    } catch {
      /* Not a JSON diagnostic. */
    }
  });
  await waitFor(discover);
  let result = await request(base + '/observe', 'POST', { original: true });
  assert.equal(result.status, 200);
  await waitFor(async () => (await session.store.list({ path: '/observe' })).items.length);
  let entry = (await session.store.list({ path: '/observe' }, false)).items[0];
  assert.match(entry.request.body, /original/);
  assert.match(entry.response.body, /upstream/);
  checks.push('Flutter VM WS captures real POST request/response without helper');
  console.log('PASS', checks.at(-1));
  let rules = [
    rule(
      'vm-mock',
      { host: 'vm.flutter-pilot.invalid', path: '/mock' },
      { mock: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"mocked":true}' } },
    ),
  ];
  await session.updateRules(rules);
  await session.setMockEnabled(true);
  assert.ok(session.state.instances >= 1);
  const previousHits = hits;
  result = await request('https://vm.flutter-pilot.invalid/mock');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { mocked: true });
  assert.equal(hits, previousHits);
  await waitFor(async () => (await session.store.list({ mocked: true })).items.length);
  checks.push('Existing Flutter Dio HTTPS mock without network or CA');
  console.log('PASS', checks.at(-1));
  rules = [
    rule(
      'vm-edit',
      { path: '/edit' },
      {
        request: {
          method: 'POST',
          query: { q: 'changed' },
          headers: { 'x-vm-marker': 'changed' },
          body: '{"patched":true}',
        },
        response: { status: 201 },
      },
    ),
  ];
  await session.updateRules(rules);
  result = await request(base + '/edit');
  assert.equal(result.status, 201);
  assert.equal(result.data.marker, 'changed');
  assert.equal(result.data.body, '{"patched":true}');
  assert.equal(result.data.path, '/edit?q=changed');
  checks.push('Request method/query/header/body and response status modification');
  console.log('PASS', checks.at(-1));
  rules = [rule('vm-recover', { path: '/error' }, { response: { status: 200, body: '{"recovered":true}' } })];
  await session.updateRules(rules);
  result = await request(base + '/error');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { recovered: true });
  checks.push('Real Flutter Dio 503 response recovered to 200');
  console.log('PASS', checks.at(-1));
  const oldIsolate = isolateId;
  await machine('app.restart', { appId, fullRestart: true, pause: false });
  await waitFor(async () => {
    try {
      return (await discover()) && isolateId !== oldIsolate;
    } catch {
      return false;
    }
  }, 30000);
  await waitFor(() => session.state.isolates >= 1, 10000);
  await new Promise((r) => setTimeout(r, 8500));
  await session.rescan();
  result = await request(base + '/error');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { recovered: true });
  checks.push('Flutter Hot Restart reconnects new isolate and reinstalls rules');
  console.log('PASS', checks.at(-1));
  await session.setMockEnabled(false);
  result = await request(base + '/error');
  assert.equal(result.status, 503);
  assert.equal(result.error, 'badResponse');
  await session.setMockEnabled(true);
  result = await request(base + '/error');
  assert.equal(result.status, 200);
  checks.push('Mock off/on restores and reinstalls without source edits');
  console.log('PASS', checks.at(-1));
  await session.setMockEnabled(false);
  session.client.disconnect();
  await waitFor(() => session.state.status === 'disconnected' && !session.state.mockEnabled);
  await session.connect(uri, rules);
  await session.disconnect();
  const verifier = new session.client.constructor();
  try {
    await verifier.connect(uri);
    const flag = await verifier.call('ext.dart.io.httpEnableTimelineLogging', { isolateId });
    assert.equal(flag.enabled, false, 'Owned SDK profiling flag must be restored after same-VM reconnect');
  } finally {
    verifier.disconnect();
  }
  checks.push('Unexpected observation disconnect followed by same-VM reconnect restores SDK capture flag');
  console.log('PASS', checks.at(-1));
  await session.disconnect();
  assert.equal(await hash(), beforeHash);
  checks.push('Unchanged application entry SHA-256; no proxy/helper/CA');
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const report = {
    result: 'passed',
    device,
    checks,
    sourceHashUnchanged: true,
    source: 'examples/flutter/lib/main.dart',
    runtime: 'Flutter Debug iOS simulator',
    requestCount: hits,
    noProxy: true,
    noHelper: true,
    noCA: true,
  };
  await writeFile(join(root, 'artifacts/vm-flutter-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await session.dispose().catch(() => undefined);
  if (appId && processChild.exitCode === null) await machine('app.stop', { appId }).catch(() => undefined);
  processChild.kill();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  assert.equal(await hash(), beforeHash, 'Flutter example source changed during VM test');
  await rm(temp, { recursive: true, force: true });
}

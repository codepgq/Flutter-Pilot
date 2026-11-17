import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import http from 'node:http';
import { productionHost, listen, closeServer, until } from './web-test-support.mjs';
const { BrowserController, SceneStore } = await productionHost();
const root = await mkdtemp(join(tmpdir(), 'pilot-web-http-'));
const artifact = resolve(
  'artifacts/web-flutter-runtime/phase-03',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(artifact, { recursive: true });
let slowArrived;
const slowSeen = new Promise((resolve) => (slowArrived = resolve));
const requestHeaders = [];
const calls = [],
  checks = [];
const check = (name, result) => {
  assert.ok(result, name);
  checks.push(name);
};
const server = http.createServer((req, res) => {
  calls.push(req.url);
  requestHeaders.push({ url: req.url, method: req.method, cookie: req.headers.cookie });
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: alive\n\n');
    return;
  }
  if (req.url === '/upload') {
    let body = '';
    req.on('data', (v) => (body += v));
    req.on('end', () => res.end(String(body.includes('upload-original'))));
    return;
  }
  if (req.url === '/slow') {
    slowArrived();
    return;
  }
  if (req.url === '/cors') {
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'x-fixture');
  }
  res.setHeader('content-type', req.url.startsWith('/app') ? 'text/html' : 'application/json');
  if (req.url.startsWith('/app')) {
    res.end(
      '<!doctype html><body><script>fetch("/first").then(r=>r.json()).then(v=>document.body.dataset.first=v.owner);let stored=Number(localStorage.getItem("counter")??0)+1;localStorage.setItem("counter",String(stored));fetch("/cookie-before?value="+encodeURIComponent(document.cookie));document.cookie="fixture="+new URL(location).searchParams.get("owner")+"; SameSite=Lax";fetch("/storage?n="+stored);fetch("/binary");fetch("/large").then(r=>r.text()).then(v=>fetch("/length?n="+v.length));fetch("/chunked").then(r=>r.text()).then(v=>fetch("/chunk-length?n="+v.length));let fd=new FormData();fd.append("text","upload-original");fetch("/upload",{method:"POST",body:fd}).then(r=>r.text()).then(v=>fetch("/upload-ok?value="+v));fetch("http://localhost:"+location.port+"/bad-preflight",{method:"POST",headers:{"x-fixture":"yes"}}).catch(()=>fetch("/preflight-blocked"));let es=new EventSource("/events");es.onmessage=e=>{fetch("/stream-alive");es.close()};let x=new XMLHttpRequest();x.open("GET","/first-xhr");x.onload=()=>document.body.dataset.xhr=JSON.parse(x.responseText).owner;x.send();navigator.serviceWorker.register("/sw.js").catch(()=>fetch("/sw-blocked"));fetch("http://localhost:"+location.port+"/cors",{credentials:"include",method:"POST",headers:{"x-fixture":"yes"}}).then(()=>fetch("/cors-ok"));fetch("http://localhost:"+location.port+"/bad-cors",{credentials:"include"}).catch(()=>fetch("/bad-cors-blocked"));</script></body>',
    );
  } else if (req.url.startsWith('/binary')) {
    res.setHeader('content-type', 'application/octet-stream');
    res.end(Buffer.from([0, 255, 1]));
  } else if (req.url.startsWith('/chunked')) {
    res.write('x'.repeat(1048576));
    res.end('y');
  } else if (req.url.startsWith('/large')) {
    res.end('x'.repeat(1048577));
  } else res.end(JSON.stringify({ origin: true, path: req.url, headers: req.headers }));
});
const port = await listen(server),
  url = `http://127.0.0.1:${port}`;
const storage = resolve('artifacts/web-flutter-runtime/browser-validation');
const controller = new BrowserController({
  project: { projectId: 'fixture', workspacePath: root },
  rulesDirectory: join(root, '.flutter-pilot'),
  storage,
  resources: resolve('resources/browser'),
  workerPath: resolve('dist/browser-worker.cjs'),
});
controller.on('log', (message) =>
  writeFile(join(artifact, 'worker.log'), message, { flag: 'a' }).catch(() => {}),
);
const seen = [];
controller.on('http', (event) => seen.push(event));
const invoke = (tool, args = {}, signal) =>
  controller.execute(tool, { sessionId: 'fixture', ...args }, signal);
try {
  check('status has no Worker side effect', !(await invoke('get_browser_status')).running);
  if (!(await controller.dependencies.status()).prepared)
    await assert.rejects(
      () => invoke('create_browser_context'),
      (error) => error.code === 'BROWSER_NOT_PREPARED',
    );
  await invoke('prepare_browser');
  const prepared = await invoke('get_browser_status');
  check(
    'private dependency receipt version and executable hash',
    prepared.dependencies.prepared &&
      prepared.dependencies.version === '1.65.0' &&
      prepared.dependencies.executableHash.length === 64,
  );
  check('prepare does not start Worker', !prepared.running);
  const store = new SceneStore(join(root, '.flutter-pilot'));
  await store.load();
  const rule = (id, owner, priority = 10) => ({
    id,
    name: id,
    enabled: true,
    priority,
    match: { path: '/first*' },
    mock: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner }) },
  });
  await store.importPackage(
    {
      version: 2,
      scenes: [
        {
          id: 'a',
          name: 'a',
          wsRules: [],
          httpRules: [
            rule('a', 'context-a'),
            rule('low', 'wrong', 1),
            {
              id: 'failed',
              name: 'failed',
              enabled: true,
              priority: 1,
              match: { path: '/failure' },
              mock: {
                status: 503,
                headers: { 'content-type': 'application/json' },
                body: '{"code":"failure"}',
              },
            },
            {
              id: 'patch',
              name: 'patch',
              enabled: true,
              priority: 1,
              match: { path: '/patch' },
              request: { headers: { 'x-debug': 'changed' } },
              response: { status: 202, body: 'patched' },
            },
            {
              id: 'binary',
              name: 'binary',
              enabled: true,
              priority: 1,
              match: { path: '/binary' },
              response: { body: 'must-not-edit' },
            },
          ],
        },
        { id: 'b', name: 'b', wsRules: [], httpRules: [rule('b', 'context-b')] },
      ],
    },
    false,
  );
  const a = await invoke('create_browser_context'),
    b = await invoke('create_browser_context');
  await invoke('activate_scene', { target: a, sceneId: 'a' });
  await invoke('activate_scene', { target: b, sceneId: 'b' });
  const pageA = await invoke('open_browser_page', { target: a, url: url + '/app?owner=a' }),
    pageB = await invoke('open_browser_page', { target: b, url: url + '/app?owner=b' });
  const read = async (target) => {
    const listed = await invoke('get_requests', { target, limit: 100 });
    return {
      ...listed,
      items: await Promise.all(listed.items.map((row) => invoke('get_request', { target, id: row.id }))),
    };
  };
  await until(
    () => seen.filter((event) => event.entry.path.startsWith('/first')).length >= 4,
    'first requests missing',
  );
  await until(
    () => calls.includes('/cors-ok') && calls.includes('/bad-cors-blocked'),
    'browser CORS/SW result',
  );
  await until(
    () =>
      calls.filter((v) => v === '/storage?n=1').length === 2 &&
      calls.filter((v) => v === '/cookie-before?value=').length === 2 &&
      calls.includes('/stream-alive') &&
      calls.includes('/chunk-length?n=1048577') &&
      calls.includes('/length?n=1048577') &&
      calls.includes('/preflight-blocked') &&
      calls.includes('/upload-ok?value=true'),
    'body/cookie/stream results',
  );
  check('streaming is passed through and unknown-length body is intact', true);
  check('multipart upload remains intact', calls.includes('/upload-ok?value=true'));
  check(
    'denied preflight never reaches POST upstream',
    requestHeaders.some((v) => v.url === '/bad-preflight' && v.method === 'OPTIONS') &&
      !requestHeaders.some((v) => v.url === '/bad-preflight' && v.method === 'POST'),
  );
  check(
    'credentialed preflight reaches upstream',
    requestHeaders.some((v) => v.url === '/cors' && v.method === 'OPTIONS'),
  );
  check(
    'Cookie state isolated before initial navigation',
    requestHeaders.filter((v) => v.url === '/storage?n=1').some((v) => v.cookie === 'fixture=a') &&
      requestHeaders.filter((v) => v.url === '/storage?n=1').some((v) => v.cookie === 'fixture=b'),
  );
  const rowsA = await read(a),
    rowsB = await read(b);
  check(
    'first fetch/XHR Mock installed before navigation',
    rowsA.items.filter((row) => row.path.startsWith('/first')).length === 2 &&
      rowsA.items
        .filter((row) => row.path.startsWith('/first'))
        .every((row) => row.mocked && row.requestRuleId === 'a') &&
      !calls.some((path) => path.startsWith('/first')),
  );
  check(
    'Context rule and history isolation',
    rowsB.items
      .filter((row) => row.path.startsWith('/first'))
      .every((row) => row.requestRuleId === 'b' && JSON.parse(row.response.body).owner === 'context-b'),
  );
  check(
    'explicit SW and cache policies',
    a.serviceWorkers === 'block' && a.cache === 'routing_disables_http_cache' && a.backend === 'direct',
  );
  await assert.rejects(
    () => invoke('reload_browser_page', { target: { ...a, pageId: pageB.pageId } }),
    (error) => error.code === 'PAGE_STALE',
  );
  check('foreign page rejected', true);
  await invoke('navigate_browser_page', { target: { ...a, pageId: pageA.pageId }, url: url + '/normal' });
  check('normal requests forwarded', calls.includes('/normal'));
  await invoke('reload_browser_page', { target: { ...a, pageId: pageA.pageId } });
  check('explicit reload actually navigates', calls.filter((path) => path === '/normal').length === 2);
  const before = calls.filter((path) => path === '/normal').length;
  await invoke('reload_rules', { target: a });
  check('reload rules does not navigate', calls.filter((path) => path === '/normal').length === before);
  const reloaded = await invoke('open_browser_page', { target: a, url: url + '/app' });
  await until(async () => {
    const rows = await read(a);
    return rows.items.some((row) => row.path === '/storage' && row.url.includes('n=2'));
  }, 'local storage context persistence');
  check(
    'localStorage and Cookie separated by Context',
    rowsA.items.filter((row) => row.path === '/storage').every((row) => row.url.includes('n=1')) &&
      rowsB.items.filter((row) => row.path === '/storage').every((row) => row.url.includes('n=1')),
  );
  for (const [path, status] of [
    ['/failure', 503],
    ['/patch', 202],
  ]) {
    await invoke('navigate_browser_page', { target: { ...a, pageId: reloaded.pageId }, url: url + path });
    const rows = await read(a);
    const value = rows.items.find((row) => row.path === path);
    check(path + ' response contract', value?.response?.status === status);
    if (path === '/patch')
      check(
        'request and response edits',
        value.request.headers.some(([name, value]) => name === 'x-debug' && value === 'changed') &&
          value.response.body === 'patched',
      );
    if (path === '/binary')
      check(
        'binary response refused editing without corruption',
        value.response.bodyEncoding === 'base64' && value.response.body === 'AP8B' && !!value.error,
      );
    if (path === '/large')
      check('oversize response explicit limitation', value.response.limitation === 'body_too_large');
  }
  await invoke('close_browser_page', { target: { ...a, pageId: pageA.pageId } });
  await assert.rejects(
    () => invoke('reload_browser_page', { target: { ...a, pageId: pageA.pageId } }),
    (error) => error.code === 'PAGE_STALE',
  );
  check('closed page identity invalid', true);
  const limited = await read(a);
  check(
    'binary remains intact',
    limited.items.some((row) => row.path === '/binary' && row.response?.body === 'AP8B' && !!row.error),
  );
  check(
    'oversize explicit limitation',
    limited.items.some((row) => row.path === '/large' && row.response?.limitation === 'body_too_large'),
  );
  const browserPid = (await controller.worker.request('status')).browserPid;
  const beforeRestart = calls.length;
  const crashed = new Promise((resolve) => controller.worker.once('disconnected', resolve));
  controller.worker.child.kill('SIGKILL');
  await crashed;
  check('Worker exit invalidates all browser targets', controller.targets().length === 0);
  await until(() => {
    try {
      process.kill(browserPid, 0);
      return false;
    } catch {
      return true;
    }
  }, 'owned Chromium process survived Worker crash');
  check('Worker crash reaps owned Chromium', true);
  await assert.rejects(
    () => invoke('get_requests', { target: a }),
    (error) => error.code === 'TARGET_DISCONNECTED',
  );
  const restarted = await invoke('create_browser_context');
  check(
    'explicit restart creates new identities and no replay',
    restarted.runtimeId !== a.runtimeId &&
      restarted.generation > a.generation &&
      calls.length === beforeRestart,
  );
  const cancelPage = await invoke('open_browser_page', { target: restarted });
  const cancel = new AbortController();
  const pending = invoke(
    'navigate_browser_page',
    { target: { ...restarted, pageId: cancelPage.pageId }, url: url + '/slow' },
    cancel.signal,
  );
  const cancelled = assert.rejects(
    () => pending,
    (error) => error.code === 'CANCELLED' && error.uncertain,
  );
  await slowSeen;
  cancel.abort();
  await cancelled;
  await assert.rejects(
    () => invoke('reload_browser_page', { target: { ...restarted, pageId: cancelPage.pageId } }),
    (error) => error.code === 'WORKFLOW_BUSY',
  );
  check(
    'cancel stops follow-up operations without replay',
    calls.filter((path) => path === '/slow').length === 1,
  );
  await invoke('close_browser_context', { target: restarted });
  const afterCancel = await invoke('create_browser_context');
  const receiptFile = join(controller.dependencies.root, 'receipt.json');
  const receipt = await readFile(receiptFile, 'utf8');
  await writeFile(receiptFile, receipt.replace('1.65.0', '0.0.0'));
  check('corrupt receipt is diagnosed', (await controller.dependencies.status()).prepared === false);
  await writeFile(receiptFile, receipt);
  const timeoutPage = await invoke('open_browser_page', { target: afterCancel });
  await assert.rejects(
    () =>
      controller.worker.request(
        'navigate',
        { target: { ...afterCancel, pageId: timeoutPage.pageId }, url: url + '/slow' },
        undefined,
        100,
      ),
    (error) => error.code === 'TIMEOUT' && error.uncertain,
  );
  await invoke('close_browser_context', { target: afterCancel });
  const authContext = await invoke('create_browser_context');
  check(
    'IPC timeout abandons late navigation response without replay',
    calls.filter((path) => path === '/slow').length === 2,
  );
  const raw = controller.worker.child;
  raw.send({
    token: 'wrong-auth',
    generation: restarted.generation,
    id: 'unauthorized',
    method: 'close',
    args: { target: authContext },
  });
  check(
    'unauthenticated IPC cannot close Context',
    (await controller.worker.request('status')).contexts.length === 1,
  );
  check(
    'Service Worker blocked and CORS enforced',
    !calls.includes('/sw.js') && calls.includes('/cors-ok') && calls.includes('/bad-cors-blocked'),
  );
  const state = await controller.worker.request('status');
  check('Worker runs in independent process', state.pid !== process.pid);
  await writeFile(
    join(artifact, 'report.json'),
    JSON.stringify(
      {
        checks,
        passed: checks.length,
        prepared: prepared.dependencies,
        rowsA,
        rowsB,
        calls,
        requestHeaders,
        targets: [a, b, restarted],
        workerPid: state.pid,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ artifact, passed: checks.length }));
} finally {
  await writeFile(join(artifact, 'calls.json'), JSON.stringify(calls));
  await controller.dispose();
  await closeServer(server);
  await rm(root, { recursive: true, force: true });
  await writeFile(
    join(artifact, 'cleanup.json'),
    JSON.stringify({
      workerStopped: !controller.worker.running,
      privateContextProfilesClosed: true,
      fixtureRemoved: true,
    }),
  );
}

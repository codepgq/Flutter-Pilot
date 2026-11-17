import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { productionHost, certificate, listen, closeServer, until } from './web-test-support.mjs';
const { BrowserController, SceneStore, parseTool } = await productionHost();
const root = await mkdtemp(join(tmpdir(), 'pilot-web-ws-')),
  artifact = resolve(
    'artifacts/web-flutter-runtime/phase-05',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
await mkdir(artifact, { recursive: true });
const ca = await certificate(join(root, 'ca'));
const tlsErrors = [];
const received = [],
  checks = [],
  clients = [];
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
};
let plainPort, securePort;
const handler = (req, res) => {
  if (req.url === '/tls-error') {
    tlsErrors.push(req.url);
    res.end('ok');
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(
    `<!doctype html><p data-testid="last"></p><p data-testid="binary"></p><button data-testid="send">Send</button><button data-testid="close">Close</button><button data-testid="multi">Multi</button><script>let target=new URL(location).searchParams.get('secure')?'wss://localhost:${securePort}/business':'ws://127.0.0.1:${plainPort}/business';let sockets=[];function open(){let ws=new WebSocket(target);sockets.push(ws);ws.onopen=()=>ws.send('hello');ws.onerror=()=>fetch('/tls-error');ws.onmessage=e=>{if(typeof e.data==='string')document.querySelector('[data-testid=last]').textContent=e.data;else e.data.arrayBuffer().then(v=>document.querySelector('[data-testid=binary]').textContent=Array.from(new Uint8Array(v)).join(','));};return ws;}let ws=open();document.querySelector('[data-testid=send]').onclick=()=>ws.send('replace-out');document.querySelector('[data-testid=close]').onclick=()=>ws.close();document.querySelector('[data-testid=multi]').onclick=()=>ws=open();let hmr=new WebSocket('ws://127.0.0.1:${plainPort}/hmr','vite-hmr');hmr.onopen=()=>hmr.send('hmr-ping');</script>`,
  );
};
const plain = http.createServer(handler),
  secure = https.createServer({ key: ca.key, cert: ca.cert }, handler);
plainPort = await listen(plain);
securePort = await listen(secure);
const servers = [new WebSocketServer({ server: plain }), new WebSocketServer({ server: secure })];
for (const [index, server] of servers.entries())
  server.on('connection', (ws, req) => {
    const item = { ws, url: req.url, secure: !!index };
    clients.push(item);
    ws.on('message', (data, binary) => {
      const value = binary ? Buffer.from(data) : data.toString();
      received.push({
        url: req.url,
        secure: !!index,
        value: binary ? value.toString('base64') : value,
        binary,
      });
      ws.send(binary ? value : 'echo:' + value, { binary });
    });
  });
const options = {
  project: { projectId: 'ws-fixture', workspacePath: root },
  rulesDirectory: join(root, '.flutter-pilot'),
  storage: resolve('artifacts/web-flutter-runtime/browser-validation'),
  resources: resolve('resources/browser'),
  workerPath: resolve('dist/browser-worker.cjs'),
};
const controller = new BrowserController(options);
const invoke = (tool, args = {}, signal) =>
  controller.execute(
    tool,
    parseTool(tool, {
      sessionId: 'fixture',
      ...args,
      ...(args.target
        ? {
            target: {
              runtimeId: args.target.runtimeId,
              generation: args.target.generation,
              ...(args.target.pageId ? { pageId: args.target.pageId } : {}),
            },
          }
        : {}),
    }),
    signal,
  );
const pageTarget = (c, p) => ({ runtimeId: c.runtimeId, generation: c.generation, pageId: p.pageId });
const waitText = (target, text) =>
  invoke('wait_for_widget', {
    target,
    selector: { source: 'web', testId: 'last' },
    state: 'text_equals',
    text,
  });
const tap = (target, testId) => invoke('tap', { target, selector: { source: 'web', testId } });
try {
  const store = new SceneStore(options.rulesDirectory);
  await store.load();
  const rule = (id, direction, contains, action, priority = 10) => ({
    id,
    name: id,
    enabled: true,
    priority,
    match: { url: '*', direction, contains },
    action,
  });
  await store.importPackage(
    {
      version: 2,
      scenes: [
        {
          id: 'ws',
          name: 'WS',
          httpRules: [],
          wsRules: [
            rule('out', 'outbound', 'replace-out', { type: 'replace', text: 'changed-out' }),
            rule('low', 'outbound', 'replace-out', { type: 'replace', text: 'wrong' }, 1),
            rule('in', 'inbound', 'echo:changed-out', { type: 'replace', text: 'changed-in' }),
            rule('drop-out', 'outbound', 'drop-out', { type: 'drop' }),
            rule('drop-in', 'inbound', 'drop-in', { type: 'drop' }),
          ],
        },
      ],
    },
    false,
  );
  const a = await invoke('create_browser_context', {
      trustedCertificates: [await readFile(join(root, 'ca/ca.pem'), 'utf8')],
    }),
    b = await invoke('create_browser_context');
  await invoke('activate_scene', { target: a, sceneId: 'ws' });
  await invoke('set_capture_enabled', { target: b, domain: 'ws', enabled: true });
  const pa = await invoke('open_browser_page', { target: a, url: `http://127.0.0.1:${plainPort}/app` }),
    pb = await invoke('open_browser_page', { target: b, url: `http://127.0.0.1:${plainPort}/app?secure=1` }),
    ta = pageTarget(a, pa),
    tb = pageTarget(b, pb);
  check('WS handshake and original echo', (await waitText(ta, 'echo:hello')).ok);
  check('WSS verifies private CA and echoes', (await waitText(tb, 'echo:hello')).ok);
  const connectionsA = await invoke('get_ws_connections', { target: a }),
    connectionsB = await invoke('get_ws_connections', { target: b });
  check(
    'development HMR excluded',
    connectionsA.length === 1 &&
      connectionsB.length === 1 &&
      !connectionsA.some((v) => v.url.endsWith('/hmr')),
  );
  const id = connectionsA[0].id;
  await tap(ta, 'send');
  check(
    'bidirectional priority replacements',
    (await waitText(ta, 'changed-in')).ok &&
      received.some((v) => v.value === 'changed-out') &&
      !received.some((v) => v.value === 'replace-out'),
  );
  const summaries = await invoke('get_ws_messages', { target: a, limit: 100 });
  const detail = await Promise.all(
    summaries.items.map((v) => invoke('get_browser_ws_message', { target: a, id: v.id })),
  );
  check(
    'raw/effective and rule identity',
    detail.some(
      (v) =>
        v.original === 'replace-out' &&
        v.effective === 'changed-out' &&
        v.ruleId === 'out' &&
        v.pageId === pa.pageId,
    ) &&
      detail.some(
        (v) => v.original === 'echo:changed-out' && v.effective === 'changed-in' && v.ruleId === 'in',
      ),
  );
  await invoke('send_ws_message', { target: a, connectionId: id, text: 'drop-out' });
  await invoke('send_ws_message', { target: a, connectionId: id, text: 'barrier' });
  check(
    'outbound drop never reaches server',
    (await waitText(ta, 'echo:barrier')).ok && !received.some((v) => v.value === 'drop-out'),
  );
  const own = clients.find((v) => v.url === '/business' && !v.secure);
  own.ws.send('drop-in');
  own.ws.send('after-drop');
  check('inbound drop does not overwrite page', (await waitText(ta, 'after-drop')).ok);
  const before = received.length;
  await invoke('inject_ws_message', { target: a, connectionId: id, text: 'injected-only' });
  check('inject targets page only', (await waitText(ta, 'injected-only')).ok && received.length === before);
  check('other Context unchanged', (await waitText(tb, 'echo:hello')).ok);
  await assert.rejects(
    () => invoke('send_ws_message', { target: b, connectionId: id, text: 'wrong-context' }),
    (e) => e.code === 'CONNECTION_STALE',
  );
  check('foreign connection rejected', true);
  own.ws.send(Buffer.from([0, 255, 3]));
  check(
    'binary passes intact',
    (
      await invoke('wait_for_widget', {
        target: ta,
        selector: { source: 'web', testId: 'binary' },
        state: 'text_equals',
        text: '0,255,3',
      })
    ).ok,
  );
  own.ws.send('z'.repeat(262145));
  await until(
    async () =>
      (await invoke('get_ws_messages', { target: a })).items.some((v) => v.bytes === 262145 && v.truncated),
    'large message',
  );
  check('oversize read-only captured', true);
  await invoke('set_capture_enabled', { target: a, domain: 'ws', enabled: false });
  await tap(ta, 'send');
  check('capture off pauses Mock', (await waitText(ta, 'echo:replace-out')).ok);
  await invoke('set_capture_enabled', { target: a, domain: 'ws', enabled: true });
  await tap(ta, 'send');
  check('capture restore restores active Mock', (await waitText(ta, 'changed-in')).ok);
  const beforeReload = clients.length;
  await invoke('reload_rules', { target: a });
  check('reload does not reconnect', clients.length === beforeReload);
  await tap(ta, 'multi');
  await until(
    async () =>
      (await invoke('get_ws_connections', { target: a })).filter((v) => v.status === 'open').length === 2,
    'two sockets',
  );
  check(
    'same Page concurrent connections distinct',
    new Set((await invoke('get_ws_connections', { target: a })).map((v) => v.id)).size === 2,
  );
  await invoke('reload_browser_page', { target: ta });
  await waitText(ta, 'echo:hello');
  await until(
    async () =>
      (await invoke('get_ws_connections', { target: a })).filter((v) => v.status === 'open').length === 1,
    'closed connections',
  );
  await assert.rejects(
    () => invoke('send_ws_message', { target: a, connectionId: id, text: 'stale' }),
    (e) => e.code === 'CONNECTION_STALE',
  );
  check('reconnect invalidates old ids', true);
  const late = await invoke('create_browser_context');
  const latePage = await invoke('open_browser_page', {
    target: late,
    url: `http://127.0.0.1:${plainPort}/app`,
  });
  const lateTarget = pageTarget(late, latePage);
  await waitText(lateTarget, 'echo:hello');
  check(
    'capture disabled does not backfill existing messages',
    (await invoke('get_ws_messages', { target: late })).total === 0,
  );
  await invoke('set_capture_enabled', { target: late, domain: 'ws', enabled: true });
  await tap(lateTarget, 'send');
  check('same URL independent Context has no Mock', (await waitText(lateTarget, 'echo:replace-out')).ok);
  check(
    'late capture includes only subsequent messages',
    (await invoke('get_ws_messages', { target: late })).items.every((v) => !v.preview.includes('hello')),
  );
  const untrusted = new BrowserController(options);
  try {
    const c = await untrusted.execute('create_browser_context', {});
    await untrusted.execute('open_browser_page', {
      target: c,
      url: `http://127.0.0.1:${plainPort}/app?secure=1`,
    });
    await until(() => tlsErrors.length > 0, 'untrusted TLS must fail');
    check('WSS without private trust fails TLS', true);
  } finally {
    await untrusted.dispose();
  }
  const current = (await invoke('get_ws_connections', { target: a })).find((v) => v.status === 'open');
  await assert.rejects(() =>
    invoke(
      'send_ws_message',
      { target: a, connectionId: current.id, text: 'cancelled' },
      AbortSignal.abort(),
    ),
  );
  check('cancelled send not replayed', !received.some((v) => v.value === 'cancelled'));
  await writeFile(
    join(artifact, 'report.json'),
    JSON.stringify({ checks, passed: checks.length, connectionsA, connectionsB, detail, received }, null, 2),
  );
  console.log(JSON.stringify({ artifact, passed: checks.length }));
} finally {
  await controller.dispose();
  for (const server of servers) {
    for (const client of server.clients) client.terminate();
    await new Promise((done) => server.close(done));
  }
  await closeServer(plain);
  await closeServer(secure);
  await rm(root, { recursive: true, force: true });
}

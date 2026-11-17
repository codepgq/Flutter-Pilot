import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { build } from 'esbuild';
import { productionHost, listen, closeServer } from './web-test-support.mjs';

export async function createWebMcpFixture(options = {}) {
  const host = await productionHost();
  const root = await mkdtemp(join(tmpdir(), 'pilot-mcp-web-'));
  const upstream = [],
    calls = [];
  const scripts = {};
  for (const kind of ['react', 'vue'])
    scripts[kind] = (
      await build({
        entryPoints: [`tests/fixtures/web/app/orders-${kind}.${kind === 'react' ? 'jsx' : 'js'}`],
        bundle: true,
        write: false,
        format: 'iife',
      })
    ).outputFiles[0].text;
  const plain = `<input data-testid="amount"><button data-testid="fetch">Fetch</button><button data-testid="connect">Connect</button><button data-testid="confirm">Confirm</button><p data-testid="ready"></p><p data-testid="result"></p><p data-testid="order"></p><script>
  const el=id=>document.querySelector('[data-testid='+id+']');let socket;
  el('fetch').onclick=async()=>el('result').textContent=(await(await fetch('/value')).json()).marker;
  el('connect').onclick=()=>{socket?.close();socket=new WebSocket(location.origin.replace('http','ws')+'/orders');socket.onopen=()=>el('ready').textContent='ready';socket.onmessage=e=>{const v=JSON.parse(e.data);el('order').textContent=v.orderId+' '+v.status}};
  el('confirm').onclick=async()=>{const v=await(await fetch('/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amount:el('amount').value})})).json();el('result').textContent=v.code??v.orderId};</script>`;
  const server = http.createServer((req, res) => {
    upstream.push(req.url);
    const kind = req.url.slice(1);
    if (['html', 'react', 'vue'].includes(kind)) {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><meta charset="utf-8"><h1>Order ${kind}</h1><div id="app">${kind === 'html' ? plain : ''}</div>${scripts[kind] ? '<script>' + scripts[kind] + '</script>' : ''}`,
      );
    } else {
      res.setHeader('content-type', 'application/json');
      res.end('{"marker":"upstream"}');
    }
  });
  const url = `http://127.0.0.1:${await listen(server)}`;
  const ws = new WebSocketServer({ server });
  const browser = new host.BrowserController({
    project: { projectId: 'mcp-web', workspacePath: root },
    rulesDirectory: options.rulesDirectory ?? join(root, '.flutter-pilot'),
    storage: resolve('artifacts/web-flutter-runtime/browser-validation'),
    resources: resolve('resources/browser'),
    workerPath: resolve('dist/browser-worker.cjs'),
  });
  const store = new host.SceneStore(options.rulesDirectory ?? join(root, '.flutter-pilot'));
  const sel = (testId) => ({ source: 'web', testId });
  const rule = (id, path, body, method = 'GET') => ({
    id,
    name: id,
    enabled: true,
    priority: 1,
    match: { path, method },
    mock: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  });
  await store.load();
  await store.importPackage(
    {
      version: 2,
      scenes: [
        {
          id: 'web',
          name: 'Web order fixture',
          httpRules: [rule('web-value', '/value', { marker: 'web-only' })],
          wsRules: [],
          targets: Object.fromEntries(
            ['fetch', 'result', 'amount', 'connect', 'ready', 'confirm', 'order', 'missing'].map((id) => [
              id,
              sel(id),
            ]),
          ),
          actions: [
            {
              id: 'fetch',
              name: 'Fetch Web value',
              steps: [
                { id: 'fetch', type: 'tap', target: 'fetch' },
                {
                  id: 'result',
                  type: 'wait_for_widget',
                  target: 'result',
                  state: 'text_equals',
                  text: 'web-only',
                },
              ],
            },
            {
              id: 'setup',
              name: 'Connect',
              steps: [
                { id: 'connect', type: 'tap', target: 'connect' },
                {
                  id: 'ready',
                  type: 'wait_for_widget',
                  target: 'ready',
                  state: 'text_equals',
                  text: 'ready',
                },
              ],
            },
            {
              id: 'order',
              name: 'Submit order',
              inputs: { amount: { required: true, secret: true } },
              steps: [
                { id: 'amount', type: 'enter_text', target: 'amount', text: '${inputs.amount}' },
                { id: 'confirm', type: 'tap', target: 'confirm' },
              ],
            },
            {
              id: 'waiting',
              name: 'Wait without submission',
              steps: [
                { id: 'wait', type: 'wait_for_widget', target: 'missing', timeoutMs: 30000 },
                { id: 'confirm', type: 'tap', target: 'confirm' },
              ],
            },
          ],
        },
      ],
    },
    false,
  );
  const success = {
    id: 'order-success',
    name: 'Order success',
    action: { sceneId: 'web', actionId: 'order' },
    setup: [{ action: { sceneId: 'web', actionId: 'setup' } }],
    inputs: { amount: 'private-amount-9381' },
    timeoutMs: 10000,
    mock: {
      initialState: 'ready',
      states: [
        { id: 'ready', httpRules: [rule('test-order', '/orders', { orderId: 'order-${run.id}' }, 'POST')] },
      ],
    },
    expect: {
      http: [
        {
          id: 'order',
          match: { method: 'POST', path: '/orders' },
          requestJson: { '/amount': '${inputs.amount}' },
          mocked: true,
          status: 200,
          responseJson: { '/orderId': 'order-${run.id}' },
          extract: { orderId: '/response/body/orderId' },
        },
      ],
      ws: [
        {
          id: 'confirmation',
          url: url.replace('http', 'ws') + '/orders',
          direction: 'inbound',
          outcome: 'synthetic',
          json: { '/orderId': '${vars.orderId}', '/status': 'confirmed' },
        },
      ],
      ui: [
        { id: 'order-row', selector: sel('order'), state: 'text_equals', text: '${vars.orderId} confirmed' },
      ],
    },
    events: [
      {
        id: 'confirmation',
        after: 'order',
        url: url.replace('http', 'ws') + '/orders',
        text: '{"orderId":"${vars.orderId}","status":"confirmed"}',
      },
    ],
  };
  await writeFile(
    join(options.rulesDirectory ?? join(root, '.flutter-pilot'), 'tests.json'),
    JSON.stringify({ version: 2, tests: [success] }),
  );
  const sessionId = 'web-production-fixture';
  const registry = join(root, 'registry');
  const ipc = new host.McpSessionServer({
    registryRoot: registry,
    workspace: root,
    name: 'Production Web acceptance',
    sessionId,
    describe: () => ({ runtimeTargets: browser.targets() }),
    call: async (tool, args, context) => {
      const result = await browser.execute(tool, args, context.signal);
      calls.push({ tool, target: args.target, runId: result?.runId, status: result?.run?.status });
      return result;
    },
  });
  await ipc.start();
  return {
    host,
    root,
    url,
    registry,
    sessionId,
    browser,
    ipc,
    store,
    calls,
    upstream,
    sel,
    async dispose() {
      await ipc.stop();
      await browser.dispose();
      for (const c of ws.clients) c.terminate();
      await new Promise((done) => ws.close(done));
      await closeServer(server);
      await rm(root, { recursive: true, force: true });
    },
  };
}

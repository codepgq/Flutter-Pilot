import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { productionHost, listen, closeServer, until } from './web-test-support.mjs';
const { BrowserController, SceneStore, parseTool } = await productionHost();
const root = await mkdtemp(join(tmpdir(), 'pilot-web-e2e-')),
  artifact = resolve(
    'artifacts/web-flutter-runtime/phase-06',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
await mkdir(artifact, { recursive: true });
const checks = [],
  runs = [],
  upstream = [];
let port;
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
};
const server = http.createServer((req, res) => {
  upstream.push(req.url);
  res.setHeader('content-type', 'text/html');
  res.end(
    `<!doctype html><button data-testid="connect">Connect</button><button data-testid="confirm">Confirm</button><button data-testid="refresh">Refresh</button><button data-testid="noop">Noop</button><input data-testid="amount"><p data-testid="ready"></p><p data-testid="result"></p><p data-testid="order"></p><p data-testid="state"></p><script>let socket;document.querySelector('[data-testid=connect]').onclick=()=>{if(socket)socket.close();socket=new WebSocket('ws://127.0.0.1:${port}/orders');socket.onopen=()=>{document.querySelector('[data-testid=ready]').textContent='ready';fetch('/setup')};socket.onmessage=e=>{let v=JSON.parse(e.data);document.querySelector('[data-testid=order]').textContent=v.orderId+' '+v.status;}};document.querySelector('[data-testid=confirm]').onclick=()=>{const submit=()=>fetch('/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amount:document.querySelector('input').value})}).then(r=>r.json()).then(v=>{document.querySelector('[data-testid=result]').textContent=v.code??v.orderId;fetch('/orders-state').then(r=>r.json()).then(v=>document.querySelector('[data-testid=state]').textContent=v.state);});submit();if(new URL(location).searchParams.has('duplicate'))submit();};document.querySelector('[data-testid=refresh]').onclick=()=>fetch('/orders-state').then(r=>r.json()).then(v=>document.querySelector('[data-testid=state]').textContent=v.state);</script>`,
  );
});
port = await listen(server);
const ws = new WebSocketServer({ server });
ws.on('connection', (socket) => socket.on('message', () => {}));
const controller = new BrowserController({
  project: { projectId: 'e2e', workspacePath: root },
  rulesDirectory: join(root, '.flutter-pilot'),
  storage: resolve('artifacts/web-flutter-runtime/browser-validation'),
  resources: resolve('resources/browser'),
  workerPath: resolve('dist/browser-worker.cjs'),
});
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
const sel = (testId) => ({ source: 'web', testId });
const rule = (id, path, body, method = 'GET') => ({
  id,
  name: id,
  enabled: true,
  priority: 10,
  match: { method, path },
  mock: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
});
const orderRule = rule('order', '/orders', { orderId: 'order-${run.id}' }, 'POST');
const success = {
  id: 'success',
  name: 'Order succeeds',
  action: { sceneId: 'actions', actionId: 'order' },
  setup: [{ action: { sceneId: 'actions', actionId: 'setup' } }],
  inputs: { amount: '10' },
  timeoutMs: 5000,
  mock: {
    initialState: 'empty',
    states: [
      {
        id: 'empty',
        httpRules: [
          { ...orderRule, nextState: 'committed' },
          rule('empty', '/orders-state', { state: 'empty' }),
        ],
      },
      { id: 'committed', httpRules: [orderRule, rule('committed', '/orders-state', { state: 'committed' })] },
    ],
  },
  expect: {
    http: [
      {
        id: 'order',
        match: { method: 'POST', path: '/orders' },
        requestJson: { '/amount': '10' },
        status: 200,
        mocked: true,
        responseJson: { '/orderId': 'order-${run.id}' },
        extract: { orderId: '/response/body/orderId' },
        timeoutMs: 600,
      },
    ],
    ws: [
      {
        id: 'update',
        url: `ws://127.0.0.1:${port}/orders`,
        direction: 'inbound',
        outcome: 'synthetic',
        json: { '/orderId': '${vars.orderId}', '/status': 'confirmed' },
        timeoutMs: 600,
      },
    ],
    ui: [
      {
        id: 'row',
        selector: sel('order'),
        state: 'text_equals',
        text: '${vars.orderId} confirmed',
        timeoutMs: 600,
      },
      { id: 'state', selector: sel('state'), state: 'text_equals', text: 'committed', timeoutMs: 600 },
    ],
  },
  events: [
    {
      id: 'update',
      after: 'order',
      url: `ws://127.0.0.1:${port}/orders`,
      text: '{"orderId":"${vars.orderId}","status":"confirmed"}',
    },
  ],
};
const clone = (id, mutate) => {
  const test = structuredClone(success);
  test.id = id;
  test.name = id;
  mutate(test);
  return test;
};
const definitions = [
  success,
  clone('wrong-parameter', (t) => (t.expect.http[0].requestJson['/amount'] = '11')),
  clone('wrong-rule', (t) => (t.expect.http[0].ruleId = 'wrong')),
  clone('wrong-response', (t) => (t.expect.http[0].responseJson['/orderId'] = 'wrong')),
  clone('wrong-ws', (t) => (t.events[0].text = '{"orderId":"wrong","status":"confirmed"}')),
  clone('old-history', (t) => {
    t.action.actionId = 'noop';
    t.setup = [];
  }),
  clone('duplicate', () => {}),
  clone('cancel', (t) => (t.action.actionId = 'waiting')),
  clone('refusal', (t) => {
    t.mock.states[0].httpRules[0].mock.body = '{"code":"INSUFFICIENT"}';
    t.expect = {
      http: [
        {
          id: 'refused',
          match: { path: '/orders', method: 'POST' },
          status: 200,
          mocked: true,
          responseJson: { '/code': 'INSUFFICIENT' },
        },
      ],
      ui: [{ id: 'code', selector: sel('result'), state: 'text_equals', text: 'INSUFFICIENT' }],
    };
    t.events = [];
  }),
];
let currentTarget;
const finish = async (id, target) => {
  await until(
    async () => (await invoke('get_test_run', { target, runId: id })).run.status !== 'running',
    'test terminal',
    15000,
  );
  const result = await invoke('get_test_run', { target, runId: id });
  runs.push(result);
  await writeFile(join(artifact, 'partial-runs.json'), JSON.stringify(runs, null, 2));
  return result.run;
};
try {
  const store = new SceneStore(join(root, '.flutter-pilot'));
  await store.load();
  await store.importPackage(
    {
      version: 2,
      scenes: [
        {
          id: 'actions',
          name: 'Order actions',
          httpRules: [],
          wsRules: [],
          targets: Object.fromEntries(
            ['connect', 'ready', 'confirm', 'amount', 'noop', 'missing'].map((id) => [id, sel(id)]),
          ),
          actions: [
            {
              id: 'setup',
              name: 'Setup',
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
              name: 'Order',
              inputs: { amount: { required: true } },
              steps: [
                { id: 'input', type: 'enter_text', target: 'amount', text: '${inputs.amount}' },
                { id: 'confirm', type: 'tap', target: 'confirm' },
              ],
            },
            {
              id: 'noop',
              name: 'Noop',
              inputs: { amount: { required: true } },
              steps: [{ id: 'noop', type: 'tap', target: 'noop' }],
            },
            {
              id: 'waiting',
              name: 'Waiting',
              inputs: { amount: { required: true } },
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
  await writeFile(
    join(root, '.flutter-pilot/tests.json'),
    JSON.stringify({ version: 2, tests: definitions }),
  );
  let c = await invoke('create_browser_context'),
    page = await invoke('open_browser_page', { target: c, url: `http://127.0.0.1:${port}/app` });
  currentTarget = { runtimeId: c.runtimeId, generation: c.generation, pageId: page.pageId };
  for (const id of [
    'success',
    'success',
    'refusal',
    'wrong-parameter',
    'wrong-rule',
    'wrong-response',
    'wrong-ws',
    'old-history',
    'duplicate',
  ]) {
    if (id === 'duplicate')
      await invoke('navigate_browser_page', {
        target: currentTarget,
        url: `http://127.0.0.1:${port}/app?duplicate=1`,
      });
    const started = await invoke('run_test', { target: currentTarget, testId: id });
    const run = await finish(started.runId, currentTarget);
    check(
      id + ' expected terminal',
      ['success', 'refusal'].includes(id) ? run.status === 'passed' : run.status !== 'passed',
    );
    check(id + ' cleanup completed', run.cleanup.status === 'completed');
    if (id === 'success')
      check(
        'actual order/WS/UI correlation',
        run.vars.orderId === 'order-' + run.runId &&
          run.assertions.every((a) => a.status === 'passed') &&
          run.evidence.ui.length > 0,
      );
  }
  check('Mock orders never reach upstream', !upstream.includes('/orders'));
  const pending = await invoke('run_test', { target: currentTarget, testId: 'cancel' });
  await until(() => controller.snapshot().contexts[0].busy === pending.runId, 'test owns Context');
  await assert.rejects(
    () => invoke('reload_rules', { target: c }),
    (e) => e.code === 'WORKFLOW_BUSY',
  );
  await invoke('cancel_test_run', { target: currentTarget, runId: pending.runId });
  const cancelled = await finish(pending.runId, currentTarget);
  check(
    'cancel stops confirm and cleanup',
    cancelled.status !== 'passed' && cancelled.cleanup.status === 'completed',
  );
  // Fault injection is in the transport boundary; cleanup recovery cannot replay UI.
  const request = controller.worker.request.bind(controller.worker);
  let failCleanup = false;
  controller.worker.request = (method, args, ...rest) => {
    if (failCleanup && method === 'configure' && args.rules?.length === 0) {
      failCleanup = false;
      return Promise.reject(new Error('fixture cleanup transport failure'));
    }
    return request(method, args, ...rest);
  };
  await invoke('navigate_browser_page', { target: currentTarget, url: `http://127.0.0.1:${port}/app` });
  const broken = await invoke('run_test', { target: currentTarget, testId: 'refusal' });
  await until(
    () => controller.snapshot().contexts[0].runtime.http.status === 'applied',
    'temporary Mock active',
  );
  failCleanup = true;
  const failedCleanup = await finish(broken.runId, currentTarget);
  check(
    'cleanup fault never passes',
    failedCleanup.status !== 'passed' && failedCleanup.cleanup.status === 'failed',
  );
  await assert.rejects(
    () => invoke('run_test', { target: currentTarget, testId: 'refusal' }),
    (e) => e.code === 'WORKFLOW_BUSY',
  );
  const count = (await invoke('get_requests', { target: c, path: '/orders' })).total;
  await invoke('cancel_test_run', { target: currentTarget, runId: broken.runId });
  check(
    'cleanup retry without resubmit',
    (await invoke('get_requests', { target: c, path: '/orders' })).total === count &&
      !controller.snapshot().contexts[0].cleanupPending.length,
  );
  controller.worker.request = request;
  let managed = controller.contexts.get(c.runtimeId);
  for (const fault of ['loss', 'overflow']) {
    const listener = (event) => {
      if (event.runtimeId === c.runtimeId && event.entry.path === '/orders' && fault === 'loss')
        controller.emit('loss');
    };
    controller.on('http', listener);
    if (fault === 'overflow') managed.observer.maximum = 0;
    const start = await invoke('run_test', { target: currentTarget, testId: 'success' });
    const run = await finish(start.runId, currentTarget);
    check(fault + ' cannot produce passed', run.status !== 'passed');
    controller.off('http', listener);
    managed.observer.maximum = 10000;
    if (managed.busy === 'uncertain') {
      await invoke('close_browser_context', { target: c });
      c = await invoke('create_browser_context');
      const fresh = await invoke('open_browser_page', { target: c, url: `http://127.0.0.1:${port}/app` });
      currentTarget = { runtimeId: c.runtimeId, generation: c.generation, pageId: fresh.pageId };
      managed = controller.contexts.get(c.runtimeId);
    }
  }
  // Change the source after acquisition; this run must keep its already assembled snapshot.
  const resource = await store.getAction('actions', 'order'),
    original = await readFile(resource.file, 'utf8');
  const frozen = await invoke('run_test', { target: currentTarget, testId: 'success' });
  await writeFile(resource.file, original.replace('"confirm"', '"missing"'));
  try {
    check(
      'source edits do not mutate frozen run',
      (await finish(frozen.runId, currentTarget)).status === 'passed',
    );
  } finally {
    await writeFile(resource.file, original);
  }
  const closed = await invoke('run_test', { target: currentTarget, testId: 'cancel' });
  await until(() => managed.observer.window !== undefined, 'observation armed');
  await controller.worker.request('page.close', { target: currentTarget });
  check('Page closure stops test', (await finish(closed.runId, currentTarget)).status !== 'passed');
  const nextPage = await invoke('open_browser_page', { target: c, url: `http://127.0.0.1:${port}/app` });
  currentTarget = { ...currentTarget, pageId: nextPage.pageId };
  const crash = await invoke('run_test', { target: currentTarget, testId: 'cancel' });
  await until(() => managed.observer.window !== undefined, 'crash observation armed');
  const disconnected = new Promise((resolve) => controller.worker.once('disconnected', resolve));
  controller.worker.child.kill('SIGKILL');
  await disconnected;
  await until(() => managed.tests.get(crash.runId).run.status !== 'running', 'crash terminal');
  await until(
    () => controller.snapshot().archivedRuns.some((r) => r.runId === crash.runId),
    'archived crash report',
  );
  const crashRun = await invoke('get_test_run', { target: currentTarget, runId: crash.runId });
  runs.push(crashRun);
  check(
    'Worker loss never passes or restores onto successor',
    crashRun.run.status !== 'passed' && controller.targets().length === 0,
  );
  await writeFile(
    join(artifact, 'report.json'),
    JSON.stringify({ checks, passed: checks.length, runs, upstream }, null, 2),
  );
  console.log(JSON.stringify({ artifact, passed: checks.length }));
} finally {
  await controller.dispose();
  for (const client of ws.clients) client.terminate();
  await new Promise((done) => ws.close(done));
  await closeServer(server);
  await rm(root, { recursive: true, force: true });
}

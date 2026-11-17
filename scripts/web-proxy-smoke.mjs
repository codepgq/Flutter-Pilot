import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { chromium } from '@playwright/test';
import { productionHost, certificate, seedTrust, listen, closeServer, until } from './web-test-support.mjs';
const host = await productionHost();
const root = await mkdtemp(join(tmpdir(), 'pilot-web-proxy-'));
const artifact = resolve(
  'artifacts/web-flutter-runtime/phase-02',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(artifact, { recursive: true });
const engines = [],
  scenes = [],
  sessions = [],
  contexts = [],
  servers = [],
  results = [],
  originCalls = [];
const check = (name, actual) => {
  assert.ok(actual, name);
  results.push({ name, result: 'passed' });
};
const executable = process.env.MITMDUMP;
if (!executable) throw new Error('test:web:proxy requires an absolute MITMDUMP; never skips the real engine');
try {
  const tls = await certificate(join(root, 'origin-ca'));
  const handler = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };
    originCalls.push(data);
    if (req.url.startsWith('/app')) {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><body>Web proxy fixture</body>');
      return;
    }
    if (!req.url.startsWith('/bad-cors') && req.headers.origin) {
      res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'x-fixture, content-type');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data));
  };
  const origin = http.createServer(handler),
    secure = https.createServer({ key: tls.key, cert: tls.cert }, handler);
  servers.push(origin, secure);
  const plainPort = await listen(origin),
    tlsPort = await listen(secure);
  const app = `http://localhost:${plainPort}`;
  const conflict = net.createServer();
  servers.push(conflict);
  const occupied = await listen(conflict);
  async function target(name, preferredPort) {
    const storage = join(root, name);
    await mkdir(storage, { recursive: true });
    const engine = new host.EngineManager();
    engines.push(engine);
    engine.on('log', (text) =>
      writeFile(join(artifact, name + '-engine.log'), text, { flag: 'a' }).catch(() => {}),
    );
    await engine.start({
      executable,
      addonPath: resolve('proxy/addon.py'),
      storagePath: storage,
      listenHost: '127.0.0.1',
      preferredPort,
      settings: { retentionDays: 1, maxRecords: 10000, maxBodyBytes: 1048576, breakpointTimeout: 10 },
      startPaused: true,
      upstreamTrustedCa: tls.ca,
    });
    let capture = false,
      rules = [],
      revision = 0;
    const store = new host.SceneStore(join(storage, 'project'), join(storage, 'activation'));
    await store.load();
    const rule = (id, path, patch) => ({
      id,
      name: id,
      enabled: true,
      priority: 10,
      match: { path },
      ...patch,
    });
    const cors = {
      'content-type': 'application/json',
      'access-control-allow-origin': app,
      'access-control-allow-credentials': 'true',
    };
    await store.importPackage(
      {
        version: 2,
        scenes: [
          {
            id: 'proxy-fixture',
            name,
            wsRules: [],
            httpRules: [
              rule('ok', '/mock-ok*', {
                mock: { status: 200, headers: cors, body: JSON.stringify({ owner: name, ok: true }) },
              }),
              rule('failure', '/mock-fail*', {
                mock: { status: 503, headers: cors, body: '{"code":"fixture_failure"}' },
              }),
              rule('modify', '/modify*', {
                request: { headers: { 'x-modified': name }, body: 'modified-request' },
                response: {
                  status: 202,
                  headers: { 'x-response-modified': name },
                  body: 'modified-response',
                },
              }),
              rule('preflight', '/mock-preflight*', {
                mock: {
                  status: 204,
                  headers: {
                    ...cors,
                    'access-control-allow-methods': 'POST, OPTIONS',
                    'access-control-allow-headers': 'x-fixture, content-type',
                  },
                  body: '',
                },
              }),
            ],
          },
        ],
      },
      false,
    );
    const controller = new host.SceneController(store, {
      snapshot: () => ({
        key: name + ':' + capture,
        targetKey: name + ':g1',
        mode: 'proxy',
        connected: engine.state.status === 'running' && capture,
        httpApplied: capture,
        wsApplied: false,
      }),
      disable: async (domain) => {
        if (domain === 'http')
          await engine.rpc('rules.sync', { version: 1, rules: [], revision: ++revision });
      },
      project: async (httpRules) => {
        rules = httpRules;
      },
      enable: async (domain) => {
        if (domain === 'http') await engine.rpc('rules.sync', { version: 1, rules, revision: ++revision });
      },
      capture: async (domain, enabled) => {
        assert.equal(domain, 'http');
        await engine.rpc(enabled ? 'proxy.start' : 'proxy.stop', {});
        capture = (await engine.rpc('health')).proxyActive;
      },
      changed: () => {},
    });
    scenes.push(controller);
    await controller.initialize();
    await controller.setCapture('http', true);
    const network = new host.McpNetworkController({
      scenesPath: store.file,
      listScenes: (q) => controller.summary(q),
      activateScene: (id) => controller.activate(id),
      reloadScenes: () => controller.reload(),
      status: () => ({
        http: { captureEnabled: capture, mockEnabled: controller.runtime.http.status === 'applied' },
        scene: controller.summary(),
        proxy: engine.state,
      }),
      listHttp: (q) => engine.rpc('history.list', q),
      getHttp: (id) => engine.rpc('history.get', { id }),
      setCapture: (domain, enabled) => controller.setCapture(domain, enabled),
      connections: async () => [],
      messages: async () => ({ items: [], total: 0 }),
      injectWs: async () => {
        throw new Error('unsupported');
      },
      sendWs: async () => {
        throw new Error('unsupported');
      },
    });
    const registry = join(root, 'registry');
    const session = new host.McpSessionServer({
      registryRoot: registry,
      workspace: storage,
      sessionId: name,
      name,
      describe: () => ({ proxy: engine.state }),
      call: (tool, args, { signal }) => network.execute(tool, args, signal),
    });
    sessions.push(session);
    await session.start();
    const descriptor = (await host.discoverSessions(registry, storage))[0];
    const call = (tool, args = {}) =>
      host.requestSession(descriptor, { kind: 'call', tool, args: { sessionId: name, ...args } });
    await call('activate_scene', { sceneId: 'proxy-fixture' });
    const profile = join(storage, 'chrome');
    await seedTrust(profile, [engine.state.caCertPath]);
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chrome',
      headless: true,
      proxy: { server: `http://127.0.0.1:${engine.state.proxyPort}`, bypass: '<-loopback>' },
      serviceWorkers: 'block',
    });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(app + '/app');
    return { engine, controller, network, call, context, page, storage };
  }
  const first = await target('project-a', occupied);
  check('occupied preferred port chooses actual free port', first.engine.state.proxyPort !== occupied);
  const fetchIn = (page, url, options = {}) =>
    page.evaluate(
      async ({ url, options }) => {
        try {
          const res = await fetch(url, options);
          return { status: res.status, text: await res.text() };
        } catch (error) {
          return { error: error.message };
        }
      },
      { url, options },
    );
  const xhrIn = (page, url, options = {}) =>
    page.evaluate(
      ({ url, options }) =>
        new Promise((done) => {
          const req = new XMLHttpRequest();
          req.open(options.method ?? 'GET', url);
          req.withCredentials = true;
          for (const [key, value] of Object.entries(options.headers ?? {})) req.setRequestHeader(key, value);
          req.onload = () => done({ status: req.status, text: req.responseText });
          req.onerror = () => done({ error: 'xhr failed' });
          req.send(options.body);
        }),
      { url, options },
    );
  const count = (path) => originCalls.filter((call) => call.path.startsWith(path)).length;
  for (const base of [app, `https://localhost:${tlsPort}`]) {
    for (const [transport, request] of [
      ['fetch', fetchIn],
      ['xhr', xhrIn],
    ]) {
      const prefix = `${new URL(base).protocol}-${transport}`;
      const normal = await request(first.page, base + '/normal?case=' + prefix, { credentials: 'include' });
      check(
        prefix + ' forwarded real JSON',
        normal.status === 200 && JSON.parse(normal.text).method === 'GET',
      );
      const before = count('/mock-ok');
      const mocked = await request(first.page, base + '/mock-ok?case=' + prefix, { credentials: 'include' });
      check(
        prefix + ' mock body and zero upstream',
        mocked.status === 200 &&
          JSON.parse(mocked.text).owner === 'project-a' &&
          count('/mock-ok') === before,
      );
      const modified = await request(first.page, base + '/modify?case=' + prefix, {
        method: 'POST',
        body: 'original-request',
        credentials: 'include',
      });
      check(
        prefix + ' request/response patches',
        modified.status === 202 &&
          modified.text === 'modified-response' &&
          originCalls.some(
            (call) =>
              call.path.includes('/modify?case=' + prefix) &&
              call.body === 'modified-request' &&
              call.headers['x-modified'] === 'project-a',
          ),
      );
      const failure = await request(first.page, base + '/mock-fail?case=' + prefix, {
        credentials: 'include',
      });
      check(
        prefix + ' expected failure mock',
        failure.status === 503 &&
          JSON.parse(failure.text).code === 'fixture_failure' &&
          count('/mock-fail') === 0,
      );
    }
    const modified = await fetchIn(first.page, base + '/modify', {
      method: 'POST',
      body: 'original-request',
      credentials: 'include',
    });
    check(
      base + ' request and response patches',
      modified.status === 202 &&
        modified.text === 'modified-response' &&
        originCalls.some(
          (call) =>
            call.path === '/modify' &&
            call.body === 'modified-request' &&
            call.headers['x-modified'] === 'project-a',
        ),
    );
  }
  const preflight = await fetchIn(first.page, `https://localhost:${tlsPort}/cors`, {
    method: 'POST',
    headers: { 'x-fixture': 'yes', 'content-type': 'application/json' },
    body: '{"x":1}',
    credentials: 'include',
  });
  check(
    'credentialed CORS and real OPTIONS',
    preflight.status === 200 &&
      originCalls.some((call) => call.method === 'OPTIONS' && call.path === '/cors'),
  );
  check(
    'incorrect CORS remains a browser error',
    !!(await fetchIn(first.page, `https://localhost:${tlsPort}/bad-cors`, { credentials: 'include' })).error,
  );
  const beforePreflight = count('/mock-preflight');
  const mockPreflight = await fetchIn(first.page, `https://localhost:${tlsPort}/mock-preflight`, {
    method: 'POST',
    headers: { 'x-fixture': 'mock' },
    credentials: 'include',
  });
  check(
    'mock OPTIONS explicit CORS, no origin',
    mockPreflight.status === 204 && count('/mock-preflight') === beforePreflight,
  );
  const rows = await until(async () => {
    const value = await first.call('get_requests', { limit: 100 });
    return value.total >= 16 ? value : undefined;
  }, 'missing proxy history');
  const workbenchRows = await first.engine.rpc('history.list', { limit: 100 });
  check(
    'MCP IPC and workbench backend agree on IDs and metadata',
    JSON.stringify(rows) === JSON.stringify(workbenchRows),
  );
  const mockRow = rows.items.find((row) => row.path.startsWith('/mock-ok'));
  const detail = await first.call('get_request', { id: mockRow.id });
  check(
    'MCP details expose actual Mock rule and body',
    detail.mocked && detail.requestRuleId === 'ok' && JSON.parse(detail.response.body).owner === 'project-a',
  );
  const patchRow = rows.items.find((row) => row.path === '/modify');
  const patchDetail = await first.call('get_request', { id: patchRow.id });
  check(
    'original/effective request/response snapshots',
    patchDetail.originalRequest.body === 'original-request' &&
      patchDetail.request.body === 'modified-request' &&
      patchDetail.response.status === 202,
  );
  await first.call('deactivate_scene');
  check('deactivation preserves capture', (await first.call('get_network_status')).http.captureEnabled);
  const after = await fetchIn(first.page, app + '/mock-ok?deactivated=1');
  check('deactivated mock forwards', after.status === 200 && JSON.parse(after.text).method === 'GET');
  await first.call('activate_scene', { sceneId: 'proxy-fixture' });
  const second = await target('project-b', first.engine.state.proxyPort);
  const isolated = await fetchIn(second.page, app + '/mock-ok?owner=b');
  check('same path rules belong to second project', JSON.parse(isolated.text).owner === 'project-b');
  check(
    'first project remains unchanged',
    JSON.parse((await fetchIn(first.page, app + '/mock-ok?owner=a')).text).owner === 'project-a',
  );
  const secondRows = await second.call('get_requests');
  check(
    'history belongs to its listener',
    secondRows.items.every((row) => !row.url.includes('owner=a')),
  );
  await first.call('reload_rules');
  check('reload does not navigate', first.page.url() === app + '/app');
  await first.call('set_capture_enabled', { domain: 'http', enabled: false });
  check('capture disable pauses Mock', (await first.call('get_network_status')).http.mockEnabled === false);
  await first.call('set_capture_enabled', { domain: 'http', enabled: true });
  check(
    'capture resumes active rules',
    JSON.parse((await fetchIn(first.page, app + '/mock-ok?resume=1')).text).owner === 'project-a',
  );
  await first.engine.rpc('breakpoint.setInteractive', { enabled: false });
  const noTrust = await chromium.launchPersistentContext(join(root, 'untrusted-profile'), {
    channel: 'chrome',
    headless: true,
    proxy: { server: `http://127.0.0.1:${first.engine.state.proxyPort}`, bypass: '<-loopback>' },
  });
  contexts.push(noTrust);
  await assert.rejects(
    () => noTrust.pages()[0].goto(`https://localhost:${tlsPort}/normal`),
    /ERR_CERT_AUTHORITY_INVALID/,
  );
  check('untrusted proxy CA fails TLS verification', true);
  await writeFile(
    join(artifact, 'requests.json'),
    JSON.stringify({ mcp: rows, detail, patchDetail, originCalls }, null, 2),
  );
  await writeFile(
    join(artifact, 'report.json'),
    JSON.stringify(
      {
        results,
        chromium: first.context.browser().version(),
        engine: '12.3.1',
        httpPort: plainPort,
        httpsPort: tlsPort,
        proxyPorts: engines.map((engine) => engine.state.proxyPort),
        source:
          'production EngineManager + SceneController + McpNetworkController + authenticated IPC; real Chromium fetch/XHR',
        tls: 'Private profile trust for proxy CA; engine explicit upstream fixture CA; no TLS bypass',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ artifact, checks: results.length, passed: results.length }, null, 2));
} finally {
  const cleanup = await Promise.allSettled(contexts.map((context) => context.close()));
  for (const session of sessions) await session.stop();
  for (const scene of scenes) scene.dispose();
  for (const engine of engines) await engine.stop();
  for (const server of servers) await closeServer(server);
  await rm(root, { recursive: true, force: true });
  assert.ok(
    cleanup.every((result) => result.status === 'fulfilled'),
    'browser cleanup',
  );
  await writeFile(
    join(artifact, 'cleanup.json'),
    JSON.stringify(
      {
        closedContexts: contexts.length,
        stoppedEngines: engines.length,
        stoppedSessions: sessions.length,
        closedServers: servers.length,
        removedPrivateProfilesAndCA: true,
      },
      null,
      2,
    ),
  );
}

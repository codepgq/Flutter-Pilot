const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { WebSocketServer } = require('ws');

async function missing(file) {
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
}
async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('VM IDE assertion timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

exports.run = async () => {
  const extension = vscode.extensions.getExtension('flutter-pilot.flutter-pilot');
  assert.ok(extension, 'Extension discovered');
  await extension.activate();
  const globalStorage = process.env.FLUTTER_PILOT_TEST_GLOBAL_STORAGE;
  // Tests run inside the same extension host. The open command returns its
  // Workbench; call its internal message handler to exercise the webview route
  // without claiming to click a real webview or publishing a test-only API.
  const workbench = await vscode.commands.executeCommand('flutterPilot.open');
  assert.ok(workbench && typeof workbench.handle === 'function', 'Workbench message route available');
  const storage = workbench.storage;
  const workspace = vscode.workspace.workspaceFolders[0].uri;
  const projectFile = path.join(await fs.realpath(workspace.fsPath), '.flutter-pilot', 'project.json');
  assert.equal(workbench.project.file, projectFile);
  const project = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  assert.match(project.projectId, /^[0-9a-f-]{36}$/i);
  assert.equal(project.name, path.basename(workspace.fsPath));
  assert.equal(project.connection.mode, 'vm');
  assert.equal(
    storage,
    path.join(
      globalStorage,
      'projects',
      project.projectId,
      createHash('sha256').update(workspace.toString()).digest('hex').slice(0, 24),
    ),
  );
  const rulesFile = path.join(workspace.fsPath, '.flutter-pilot', 'scenes.json');
  const readScenes = async () => JSON.parse(await fs.readFile(rulesFile, 'utf8'));
  const writeDomain = async (domain, rules) => {
    const doc = await readScenes();
    doc.scenes[0][domain] = rules;
    await fs.writeFile(rulesFile, JSON.stringify(doc));
  };
  assert.deepEqual((await readScenes()).scenes[0].httpRules, []);
  await fs.access(path.join(storage, 'vm-history.sqlite3'));
  const wsRulesFile = rulesFile;
  await fs.access(path.join(storage, 'ws-history.sqlite3'));
  assert.deepEqual((await readScenes()).scenes[0].wsRules, []);
  const wsRule = {
    id: 'ide-ws-rule',
    name: 'WS IDE fixture',
    enabled: true,
    priority: 0,
    match: { url: 'wss://business.example.test/*', direction: 'inbound', contains: 'original' },
    action: { type: 'replace', text: 'mocked' },
  };
  await workbench.handle({ action: 'ws.rules.save', payload: { rule: wsRule } });
  assert.deepEqual((await readScenes()).scenes[0].wsRules, [wsRule]);
  await writeDomain('wsRules', []);
  await assert.rejects(
    workbench.handle({ action: 'ws.rules.toggle', payload: { id: wsRule.id } }),
    /已被修改/,
  );
  await workbench.handle({ action: 'project.reload', payload: {} });
  await workbench.handle({ action: 'ws.rules.save', payload: { rule: wsRule } });
  await workbench.vm.websocket.store.putConnection({
    id: 'ide-ws',
    isolateId: 'fixture',
    endpoint: 'business.example.test:443',
    status: 'closed',
    capture: 'unsupported',
    openedAt: Date.now(),
    sent: 1,
    received: 0,
  });
  await workbench.vm.websocket.store.putMessage({
    id: 'ide-ws-message',
    connectionId: 'ide-ws',
    timestamp: Date.now(),
    direction: 'inbound',
    kind: 'text',
    original: 'original',
    effective: 'mocked',
    encoding: 'text',
    bytes: 8,
    truncated: false,
    outcome: 'replaced',
    ruleId: wsRule.id,
  });
  await workbench.handle({ action: 'ws.query', payload: { connectionId: 'ide-ws' } });
  assert.equal(workbench.vm.websocket.state.messages.total, 1);
  assert.equal(workbench.vm.websocket.state.messages.items[0].original, undefined, 'summary excludes body');
  await workbench.handle({ action: 'ws.select', payload: { id: 'ide-ws-message' } });
  await assert.rejects(
    workbench.handle({ action: 'ws.push', payload: { connectionId: 'ide-ws', text: 'manual' } }),
    /开启 WS 采集/,
  );
  await missing(path.join(storage, 'ca'));
  await missing(path.join(storage, 'history.sqlite3'));
  await missing(path.join(globalStorage, 'engines'));
  assert.equal(workbench.mode, 'vm');
  assert.equal(workbench.engine.state.status, 'stopped');
  assert.equal(workbench.proxyActive, false);
  assert.equal(workbench.vm.state.status, 'disconnected');
  const request = {
    headers: [],
    body: '',
    bodyEncoding: 'text',
    bodyBytes: 0,
    truncated: false,
    editable: true,
    method: 'GET',
    url: 'https://vm.example.test/api/sample',
  };
  const response = {
    headers: [['content-type', 'application/json']],
    body: '{"ide":"vm-only","ok":true}',
    bodyEncoding: 'text',
    bodyBytes: 27,
    truncated: false,
    editable: true,
    status: 200,
  };
  await workbench.vm.store.put({
    id: 'ide-vm-fixture',
    startedAt: Date.now(),
    duration: 23,
    method: 'GET',
    host: 'vm.example.test',
    path: '/api/sample',
    url: request.url,
    targetUrl: request.url,
    originalRequest: request,
    request,
    originalResponse: response,
    response,
    mocked: false,
    note: '',
    tags: [],
    source: 'vm',
  });
  await workbench.handle({ action: 'history.query', payload: { search: '/api/sample' } });
  assert.equal(workbench.history.total, 1);
  assert.equal(workbench.apis[0].path, '/api/sample');
  await workbench.handle({ action: 'history.select', payload: { id: 'ide-vm-fixture' } });
  assert.equal(workbench.selected.response.body, response.body);
  await workbench.handle({ action: 'history.toRule', payload: { id: 'ide-vm-fixture', kind: 'mock' } });
  const fixtureRule = {
    id: 'ide-project-rule',
    name: 'Project rules fixture',
    enabled: false,
    priority: 0,
    match: { method: 'GET', host: 'vm.example.test', path: '/api/sample' },
    mock: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"mock":true}' },
  };
  await workbench.handle({ action: 'rules.save', payload: { rule: fixtureRule } });
  assert.equal(workbench.lastError, undefined);
  assert.deepEqual((await readScenes()).scenes[0].httpRules, [fixtureRule]);
  const externalRule = { ...fixtureRule, id: 'external-rule', name: 'External edit' };
  await writeDomain('httpRules', [fixtureRule, externalRule]);
  await assert.rejects(
    workbench.handle({ action: 'rules.toggle', payload: { id: fixtureRule.id } }),
    /场景文件已被修改/,
  );
  assert.equal((await readScenes()).scenes[0].httpRules.length, 2);
  await workbench.handle({ action: 'project.reload', payload: {} });
  assert.equal(workbench.lastError, undefined);
  assert.equal(workbench.scenes.selected.httpRules.length, 2);
  await workbench.handle({ action: 'rules.toggle', payload: { id: fixtureRule.id } });
  assert.equal(workbench.lastError, undefined);
  assert.equal((await readScenes()).scenes[0].httpRules[0].enabled, true);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const rpcCalls = [];
  let connections = 0;
  server.on('connection', (socket) => {
    connections++;
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      rpcCalls.push(request.method);
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'getVM' ? { type: 'VM', isolates: [] } : { type: 'Success' },
        }),
      );
    });
  });
  try {
    await workbench.handle({
      action: 'vm.connect',
      payload: { url: `ws://127.0.0.1:${server.address().port}/synthetic-auth-token=/ws` },
    });
    assert.equal(workbench.vm.state.status, 'connected');
    assert.equal(workbench.vm.websocket.state.captureEnabled, false);
    assert.equal(workbench.vm.websocket.state.mockEnabled, false);
    assert.ok(rpcCalls.includes('getVM'));
    assert.equal(workbench.vm.state.endpoint, `127.0.0.1:${server.address().port}`);
    assert.equal(workbench.engine.state.status, 'stopped');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(workbench.vm.state.status, 'connected');
    const reopened = await vscode.commands.executeCommand('flutterPilot.open');
    assert.equal(reopened, workbench);
    assert.equal(reopened.vm.state.status, 'connected');
    const configuration = await fs.readFile(projectFile, 'utf8');
    assert.equal(JSON.parse(configuration).projectId, project.projectId);
    assert.equal(JSON.parse(configuration).connection.mode, 'vm');
    assert.ok(!configuration.includes('synthetic-auth-token'));
    assert.ok(!configuration.includes('ws://'));
    assert.ok(!(await fs.readFile(rulesFile, 'utf8')).includes('synthetic-auth-token'));
    await missing(path.join(storage, 'ca'));
    await missing(path.join(globalStorage, 'engines'));

    // Synthetic discovery inputs intentionally bypass Dart-Code. The selected ID
    // still travels through the production webview message route, coordinator,
    // VM transport, and SQLite history reload. Real Dart discovery is tested separately.
    await workbench.handle({ action: 'vm.disconnect', payload: {} });
    assert.equal(workbench.vm.state.status, 'disconnected');
    const endpoint = `127.0.0.1:${server.address().port}`;
    const candidates = ['synthetic-session-a', 'synthetic-session-b'].map((id) => ({
      id,
      name: `Synthetic Flutter ${id}`,
      device: 'synthetic-ios-simulator',
      endpoint,
      source: 'debug-event',
      url: `ws://${endpoint}/synthetic-discovery-token=/ws`,
    }));
    assert.equal(workbench.vmAuto.snapshot.enabled, true);
    workbench.vmAuto.setCandidates(candidates);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(workbench.vm.state.status, 'disconnected', 'multiple candidates require selection');
    assert.equal(connections, 1, 'no automatic connection to an ambiguous candidate');
    assert.equal(workbench.vmAuto.snapshot.candidates.length, 2);
    assert.ok(!JSON.stringify(workbench.vmAuto.snapshot).includes('synthetic-discovery-token'));
    assert.ok(!JSON.stringify(workbench.vmAuto.snapshot).includes('ws://'));
    await workbench.handle({
      action: 'vm.discovery.connect',
      payload: { id: candidates[0].id },
    });
    assert.equal(workbench.vm.state.status, 'connected');
    assert.equal(workbench.vmAuto.snapshot.connectedSessionId, candidates[0].id);
    assert.equal(connections, 2);
    assert.equal(workbench.vm.state.mockEnabled, false);
    assert.equal(workbench.vm.websocket.state.captureEnabled, false);
    assert.equal(workbench.vm.websocket.state.mockEnabled, false);
    await assert.rejects(
      workbench.handle({ action: 'vm.discovery.connect', payload: { id: candidates[1].id } }),
      /先断开/,
    );
    assert.equal(connections, 2, 'selection cannot replace a connected VM');
    await workbench.handle({ action: 'vm.disconnect', payload: {} });
    assert.equal(workbench.vm.state.status, 'disconnected');
    assert.equal(workbench.vmAuto.snapshot.candidates[0].status, 'paused');
    workbench.vmAuto.setCandidates(candidates);
    workbench.vmAuto.setCandidates([candidates[0]]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(workbench.vm.state.status, 'disconnected', 'manual disconnect suppresses rediscovery');
    assert.equal(connections, 2);
    await workbench.handle({ action: 'vm.discovery.connect', payload: { id: candidates[0].id } });
    assert.equal(workbench.vmAuto.snapshot.connectedSessionId, candidates[0].id);
    assert.equal(connections, 3, 'explicit selection resumes a paused session');
    workbench.vmAuto.setCandidates([]);
    await waitFor(() => workbench.vm.state.status === 'disconnected');
    assert.equal(workbench.vmAuto.snapshot.connectedSessionId, undefined);
    await assert.rejects(
      workbench.handle({ action: 'vm.discovery.connect', payload: { id: candidates[0].id } }),
      /会话已结束/,
    );
    const nextSession = { ...candidates[0], id: 'synthetic-new-session' };
    workbench.vmAuto.setCandidates([nextSession]);
    await waitFor(() => workbench.vmAuto.snapshot.connectedSessionId === nextSession.id);
    assert.equal(connections, 4, 'a new unique session automatically connects');
    assert.ok(!(await fs.readFile(projectFile, 'utf8')).includes('synthetic-discovery-token'));
    assert.ok(!(await fs.readFile(rulesFile, 'utf8')).includes('synthetic-discovery-token'));
    await workbench.dispose();
    await waitFor(() => server.clients.size === 0);
    console.log(
      'IDE_VM_ONLY_PASS: HTTP and WS private SQLite/query/detail, WS project rules save/reload/conflict protection, independent WS capture/Mock default off and offline push rejection, project binding, synthetic VM transport, discovery selection/manual suppression/owner removal/new-session auto-connect routes and disposal',
    );
  } finally {
    await workbench.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
};

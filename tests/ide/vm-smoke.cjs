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
  const extension = vscode.extensions.getExtension('api-mocks.flutter-api-mocks');
  assert.ok(extension, 'Extension discovered');
  await extension.activate();
  const globalStorage = process.env.API_MOCK_TEST_GLOBAL_STORAGE;
  // Tests run inside the same extension host. The open command returns its
  // Workbench; call its internal message handler to exercise the webview route
  // without claiming to click a real webview or publishing a test-only API.
  const workbench = await vscode.commands.executeCommand('flutterApiMocks.open');
  assert.ok(workbench && typeof workbench.handle === 'function', 'Workbench message route available');
  const storage = workbench.storage;
  const workspace = vscode.workspace.workspaceFolders[0].uri;
  const projectFile = path.join(await fs.realpath(workspace.fsPath), '.api-mocks', 'project.json');
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
  const rulesFile = path.join(workspace.fsPath, '.api-mocks', 'rules.json');
  assert.deepEqual(JSON.parse(await fs.readFile(rulesFile, 'utf8')), { version: 1, rules: [] });
  await fs.access(path.join(storage, 'vm-history.sqlite3'));
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
  assert.deepEqual(JSON.parse(await fs.readFile(rulesFile, 'utf8')).rules, [fixtureRule]);
  const externalRule = { ...fixtureRule, id: 'external-rule', name: 'External edit' };
  await fs.writeFile(rulesFile, JSON.stringify({ version: 1, rules: [fixtureRule, externalRule] }));
  await assert.rejects(
    workbench.handle({ action: 'rules.toggle', payload: { id: fixtureRule.id } }),
    /项目规则文件已被修改/,
  );
  assert.equal(JSON.parse(await fs.readFile(rulesFile, 'utf8')).rules.length, 2);
  await workbench.handle({ action: 'project.reload', payload: {} });
  assert.equal(workbench.lastError, undefined);
  assert.equal(workbench.rules.length, 2);
  await workbench.handle({ action: 'rules.toggle', payload: { id: fixtureRule.id } });
  assert.equal(workbench.lastError, undefined);
  assert.equal(JSON.parse(await fs.readFile(rulesFile, 'utf8')).rules[0].enabled, true);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const rpcCalls = [];
  server.on('connection', (socket) =>
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
    }),
  );
  try {
    await workbench.handle({
      action: 'vm.connect',
      payload: { url: `ws://127.0.0.1:${server.address().port}/synthetic-auth-token=/ws` },
    });
    assert.equal(workbench.vm.state.status, 'connected');
    assert.ok(rpcCalls.includes('getVM'));
    assert.equal(workbench.vm.state.endpoint, `127.0.0.1:${server.address().port}`);
    assert.equal(workbench.engine.state.status, 'stopped');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(workbench.vm.state.status, 'connected');
    const reopened = await vscode.commands.executeCommand('flutterApiMocks.open');
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
    await workbench.dispose();
    await waitFor(() => server.clients.size === 0);
    console.log(
      'IDE_VM_ONLY_PASS: project UUID/name/config/rules and isolated storage, rule save/reload/conflict protection, default VM mode, no engine or CA, offline SQLite/catalog, history route, synthetic VM WS, close/reopen, URL not persisted, disposal disconnects',
    );
  } finally {
    await workbench.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
};

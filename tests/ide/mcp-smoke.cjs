const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(40);
  }
  throw new Error('MCP IDE timeout: ' + label);
}
exports.run = async () => {
  const phase = process.env.FLUTTER_PILOT_TEST_PHASE;
  const reportPath = process.env.FLUTTER_PILOT_TEST_MCP_REPORT;
  const bridgeRoot = process.env.FLUTTER_PILOT_MCP_ROOT;
  let report;
  try {
    report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  } catch {
    report = {
      ide: process.env.FLUTTER_PILOT_TEST_IDE,
      ideVersion: vscode.version,
      appVersion: process.env.FLUTTER_PILOT_TEST_IDE_APP_VERSION,
      passed: false,
      assertions: [],
      limits: [
        'Real isolated IDE host and SDK client; no Flutter runtime or native Agent model invocation in this test.',
      ],
    };
  }
  const passed = (label) => {
    report.assertions.push(label);
    console.log('MCP_IDE_ASSERT ' + label);
  };
  let workbench, client;
  try {
    const extension = vscode.extensions.getExtension('flutter-pilot.flutter-pilot');
    assert.ok(extension);
    await extension.activate();
    workbench = await vscode.commands.executeCommand('flutterPilot.open');
    assert.ok(workbench?.handle);
    const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
    if (phase === 'first') {
      assert.equal(workbench.mcpState.enabled, false);
      assert.equal(workbench.mcpState.running, false);
      assert.equal(workbench.mcpState.scope, 'project');
      await workbench.handle({ action: 'mcp.enable', payload: { enabled: true } });
      assert.equal(workbench.mcpState.running, true);
      assert.equal(workbench.vm.state.mockEnabled, false);
      assert.equal(workbench.vm.websocket.state.captureEnabled, false);
      assert.equal(workbench.vm.websocket.state.mockEnabled, false);
      passed('MCP defaults off/project; enable starts bridge without Mock or WS capture');
      await workbench.handle({ action: 'mcp.inspect', payload: { scope: 'project' } });
      await workbench.handle({ action: 'mcp.adapt', payload: { agent: 'codex-cli', scope: 'project' } });
      const config = await fs.readFile(path.join(workspace, '.codex/config.toml'), 'utf8');
      assert.match(config, /flutter-pilot/);
      assert.match(config, /--workspace/);
      assert.ok(config.includes(bridgeRoot));
      assert.ok(workbench.mcpState.notice.includes('自检通过'));
      assert.equal(workbench.mcpState.clients.length, 0, 'self-test does not claim an Agent is connected');
      await assert.rejects(fs.access(path.join(process.env.CODEX_HOME, 'config.toml')), { code: 'ENOENT' });
      passed(
        'project Codex adaptation writes isolated project config and self-tests without touching global config',
      );
    } else {
      assert.equal(workbench.mcpState.enabled, true);
      assert.equal(workbench.mcpState.running, true);
      passed('new IDE process restores enabled MCP from private workspace storage');
    }
    client = new Client({ name: 'codex-cli-ide-smoke', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.env.FLUTTER_PILOT_TEST_NODE,
        args: [
          path.join(bridgeRoot, 'bridge.cjs'),
          '--registry',
          path.join(bridgeRoot, 'sessions'),
          '--workspace',
          workspace,
        ],
        stderr: 'pipe',
      }),
    );
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 23);
    const list = await client.callTool({ name: 'list_sessions', arguments: {} });
    const sessions = list.structuredContent.sessions;
    assert.equal(sessions.length, 1);
    const sessionId = sessions[0].sessionId;
    const call = (name, args = {}) => client.callTool({ name, arguments: { sessionId, ...args } });
    const status = await call('get_network_status');
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.vmConnected, false);
    assert.equal(status.structuredContent.files.scenes, path.join(workspace, '.flutter-pilot/scenes.json'));
    await waitFor(
      () => workbench.mcpState.clients.some((c) => c.name === 'codex-cli-ide-smoke'),
      'client handshake',
    );
    passed(
      phase + ': real SDK stdio discovers tools, workspace session and network status through extension IPC',
    );
    const rulesFile = status.structuredContent.files.scenes;
    const rule = {
      id: 'mcp-ide-rule',
      name: 'Agent file edit',
      enabled: false,
      priority: 0,
      match: { method: 'GET', path: '/mcp-fixture' },
      mock: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"mocked":true}' },
    };
    const doc = JSON.parse(await fs.readFile(rulesFile, 'utf8'));
    doc.scenes[0].httpRules = [rule];
    doc.activeSceneId = doc.scenes[0].id;
    await fs.writeFile(rulesFile, JSON.stringify(doc));
    const reload = await call('reload_rules');
    assert.equal(reload.structuredContent.loaded, true);
    assert.equal(workbench.rules[0].id, rule.id);
    await fs.writeFile(rulesFile, '{invalid');
    const invalid = await call('reload_rules');
    assert.equal(invalid.isError, true);
    assert.equal(workbench.rules[0].id, rule.id, 'last valid rules preserved');
    doc.activeSceneId = null;
    doc.scenes[0].httpRules = [];
    await fs.writeFile(rulesFile, JSON.stringify(doc));
    await call('reload_rules');
    passed(
      phase +
        ': Agent file edits reload through shared rules service; invalid JSON preserves last valid rules',
    );
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => !workbench.panel, 'panel close');
    assert.equal(workbench.mcpState.running, true);
    assert.equal((await call('get_network_status')).isError, undefined);
    const reopened = await vscode.commands.executeCommand('flutterPilot.open');
    assert.equal(reopened, workbench);
    passed(phase + ': closing and reopening workbench keeps MCP session available');
    if (phase === 'first') {
      await workbench.handle({ action: 'mcp.enable', payload: { enabled: false } });
      assert.equal(workbench.mcpState.running, false);
      assert.equal((await call('get_network_status')).isError, true);
      assert.equal((await fs.readdir(path.join(bridgeRoot, 'sessions'))).length, 0);
      assert.match(await fs.readFile(path.join(workspace, '.codex/config.toml'), 'utf8'), /flutter-pilot/);
      await workbench.handle({ action: 'mcp.enable', payload: { enabled: true } });
      assert.equal(workbench.mcpState.running, true);
      passed(
        'disable rejects subsequent calls and preserves configuration; re-enable persists for next IDE process',
      );
    }
    await client.close();
    client = undefined;
    await workbench.dispose();
    assert.equal((await fs.readdir(path.join(bridgeRoot, 'sessions'))).length, 0);
    passed(phase + ': workspace disposal cleans socket registry and session');
    if (phase === 'restore') report.passed = true;
  } catch (error) {
    report.error = String(error?.stack ?? error).replace(/(?:wss?|https?):\/\/[^\s'"<>]+/g, '[redacted URL]');
    console.log('MCP_IDE_ERROR ' + report.error.split('\n')[0]);
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
    await workbench?.dispose().catch(() => undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    // Some desktop builds keep an empty test window alive after the host exits.
    // This command targets only this isolated test window/profile.
    setTimeout(() => void vscode.commands.executeCommand('workbench.action.quit'), 300);
  }
};

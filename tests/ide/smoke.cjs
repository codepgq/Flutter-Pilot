const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const exec = promisify(execFile);
exports.run = async () => {
  const extension = vscode.extensions.getExtension('flutter-pilot.flutter-pilot');
  assert.ok(extension, 'Extension discovered');
  await extension.activate();
  const commands = await vscode.commands.getCommands();
  for (const command of ['open', 'start', 'stop']) assert.ok(commands.includes(`flutterPilot.${command}`));
  const workspace = vscode.workspace.workspaceFolders[0].uri;
  const projectDirectory = path.join(workspace.fsPath, '.flutter-pilot');
  const project = JSON.parse(await fs.readFile(path.join(projectDirectory, 'project.json'), 'utf8'));
  assert.match(project.projectId, /^[0-9a-f-]{36}$/i);
  assert.equal(project.name, path.basename(workspace.fsPath));
  assert.equal(project.connection.mode, 'proxy');
  const legacyStorage = process.env.FLUTTER_PILOT_TEST_LEGACY_STORAGE;
  const storage = path.join(
    path.dirname(path.dirname(legacyStorage)),
    'projects',
    project.projectId,
    createHash('sha256').update(workspace.toString()).digest('hex').slice(0, 24),
  );
  const certificate = path.join(storage, 'ca', 'mitmproxy-ca-cert.pem');
  const database = path.join(storage, 'history.sqlite3');
  const origin = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"discovered":true}');
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const get = async (url) =>
    JSON.parse(
      (
        await exec('/usr/bin/curl', [
          '--silent',
          '--show-error',
          '--max-time',
          '15',
          '--noproxy',
          '',
          '--proxy',
          'http://127.0.0.1:18080',
          '--cacert',
          certificate,
          url,
        ])
      ).stdout,
    );
  const sql = async (query) => (await exec('/usr/bin/sqlite3', [database, query])).stdout.trim();
  try {
    await fs.access(certificate);
    // No workbench or start command: workspace activation must already listen.
    assert.deepEqual(await get('https://ide.flutter-pilot.test/ping'), { ide: true });
    await vscode.commands.executeCommand('flutterPilot.open');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise((resolve) => setTimeout(resolve, 250));
    // The same rule has both breakpoints; with no panel it must never wait.
    assert.deepEqual(await get('https://ide.flutter-pilot.test/ping'), { ide: true });
    // Discovery must also work without any matching mock/modification rule.
    const target = `http://127.0.0.1:${origin.address().port}/unconfigured-api`;
    assert.deepEqual(await get(target), { discovered: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await sql("SELECT calls FROM api_catalog WHERE host='ide.flutter-pilot.test' AND path='/ping'"),
      '2',
    );
    assert.equal(
      await sql("SELECT calls FROM api_catalog WHERE host='127.0.0.1' AND path='/unconfigured-api'"),
      '1',
    );
    assert.equal(await sql('SELECT count(*) FROM history'), '3');
    await vscode.commands.executeCommand('flutterPilot.stop');
    await assert.rejects(
      exec('/usr/bin/curl', [
        '--silent',
        '--show-error',
        '--max-time',
        '2',
        '--noproxy',
        '',
        '--proxy',
        'http://127.0.0.1:18080',
        target,
      ]),
    );
    await vscode.commands.executeCommand('flutterPilot.open');
    await assert.rejects(
      exec('/usr/bin/curl', [
        '--silent',
        '--show-error',
        '--max-time',
        '2',
        '--noproxy',
        '',
        '--proxy',
        'http://127.0.0.1:18080',
        target,
      ]),
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(projectDirectory, 'rules.json'), 'utf8')).rules[0].id,
      'ide-smoke',
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(legacyStorage, 'rules.json'), 'utf8')).rules[0].id,
      'ide-smoke',
      'Migration preserves the legacy source',
    );
    console.log(
      'IDE_AUTO_RECORD_PASS: project UUID/config/rules migration, activation without UI, HTTPS mock, closing UI continues, background skips breakpoints, unconfigured API discovery, persistent SQLite catalog, manual stop preserved after reopen',
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise((resolve) => origin.close(resolve));
  }
};

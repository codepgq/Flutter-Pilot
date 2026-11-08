const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
exports.run = async () => {
  const extension = vscode.extensions.getExtension('api-mocks.flutter-api-mocks');
  assert.ok(extension, 'Extension discovered');
  await extension.activate();
  const commands = await vscode.commands.getCommands();
  for (const command of ['open', 'start', 'stop']) assert.ok(commands.includes(`flutterApiMocks.${command}`));
  const storage = process.env.API_MOCK_TEST_STORAGE;
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
    assert.deepEqual(await get('https://ide.api-mocks.test/ping'), { ide: true });
    await vscode.commands.executeCommand('flutterApiMocks.open');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise((resolve) => setTimeout(resolve, 250));
    // The same rule has both breakpoints; with no panel it must never wait.
    assert.deepEqual(await get('https://ide.api-mocks.test/ping'), { ide: true });
    // Discovery must also work without any matching mock/modification rule.
    const target = `http://127.0.0.1:${origin.address().port}/unconfigured-api`;
    assert.deepEqual(await get(target), { discovered: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await sql("SELECT calls FROM api_catalog WHERE host='ide.api-mocks.test' AND path='/ping'"),
      '2',
    );
    assert.equal(
      await sql("SELECT calls FROM api_catalog WHERE host='127.0.0.1' AND path='/unconfigured-api'"),
      '1',
    );
    assert.equal(await sql('SELECT count(*) FROM history'), '3');
    await vscode.commands.executeCommand('flutterApiMocks.stop');
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
    await vscode.commands.executeCommand('flutterApiMocks.open');
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
      JSON.parse(await fs.readFile(path.join(storage, 'rules.json'), 'utf8')).rules[0].id,
      'ide-smoke',
    );
    console.log(
      'IDE_AUTO_RECORD_PASS: activation without UI, HTTPS mock, closing UI continues, background skips breakpoints, unconfigured API discovery, persistent SQLite catalog, manual stop preserved after reopen',
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise((resolve) => origin.close(resolve));
  }
};

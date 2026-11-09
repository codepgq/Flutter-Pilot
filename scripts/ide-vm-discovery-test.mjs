import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { access, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve('.');
const ide = process.env.API_MOCK_TEST_IDE || 'cursor';
if (!['cursor', 'vscode'].includes(ide)) throw new Error('API_MOCK_TEST_IDE must be cursor or vscode');
const executable =
  ide === 'cursor'
    ? '/Applications/Cursor.app/Contents/MacOS/Cursor'
    : '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const appVersion = JSON.parse(
  await readFile(resolve(executable, '..', '..', 'Resources', 'app', 'package.json'), 'utf8'),
).version;
const flutter = process.env.API_MOCK_TEST_FLUTTER || '/Users/mark.pan/fvm/default/bin/flutter';
const device = process.env.API_MOCK_TEST_DEVICE || '9EB23D45-AF43-4952-BAE8-100CE01EDD46';
const temp = await mkdtemp(join(tmpdir(), `api-mocks-${ide}-discovery-`));
const workspace = join(temp, 'flutter-fixture');
const user = join(temp, 'user');
const extensions = join(temp, 'extensions');
await Promise.all([access(executable), access(flutter), access(join(root, 'dist', 'extension.js'))]);
await cp(join(root, 'examples', 'flutter'), workspace, {
  recursive: true,
  filter: (source) =>
    !source
      .split('/')
      .some((segment) => ['build', '.dart_tool', '.api-mocks', 'Pods', '.symlinks'].includes(segment)),
});
await mkdir(join(user, 'User'), { recursive: true });
await mkdir(extensions, { recursive: true });
for (const name of ['dart-code.dart-code-3.146.0-universal', 'dart-code.flutter-3.146.0-universal']) {
  const source = join('/Users/mark.pan/.cursor/extensions', name);
  await access(source);
  await symlink(source, join(extensions, name));
}
await writeFile(
  join(user, 'User', 'settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    'dart.flutterSdkPath': resolve(flutter, '..', '..'),
    'dart.checkForSdkUpdates': false,
    'dart.showDevToolsOptionsNotification': false,
    'dart.openDevTools': 'never',
    'flutterApiMocks.autoConnectVm': true,
    'flutterApiMocks.enginePath': '',
  }),
);
function command(file, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => {
      output = (output + data).slice(-16000);
    });
    child.stderr.on('data', (data) => {
      output = (output + data).slice(-16000);
    });
    child.once('error', () => reject(new Error('fixture preparation command failed')));
    child.once('exit', (code) =>
      code === 0 ? resolvePromise(output) : reject(new Error('fixture preparation command failed')),
    );
  });
}
const version = JSON.parse(await command(flutter, ['--version', '--machine'], workspace));
await command(flutter, ['pub', 'get'], workspace);
const sourceHash = createHash('sha256')
  .update(await readFile(join(workspace, 'lib', 'main.dart')))
  .digest('hex');
const discoveryBundle = join(temp, 'discovery.cjs');
await build({
  entryPoints: [join(root, 'src', 'vm', 'discovery.ts')],
  outfile: discoveryBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});
const reportPath = join(temp, 'discovery-report.json');
console.log(`IDE_DISCOVERY_START ${ide} Flutter ${version.frameworkVersion} Dart ${version.dartSdkVersion}`);
// test-electron forwards all IDE stdout/stderr. Only emit fixture assertions;
// raw IDE logs may contain authenticated debugger/daemon addresses.
function filterIdeOutput(stream) {
  const write = stream.write.bind(stream);
  let pending = '';
  stream.write = (chunk, encoding, callback) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (/^DISCOVERY_(ASSERT_PASS|SESSION_STARTED) /.test(line))
        write(line.replace(/(?:wss?|https?):\/\/[^\s'"<>]+/g, '[redacted URL]') + '\n');
    }
    if (pending.length > 65536) pending = '';
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  return () => {
    stream.write = write;
  };
}
const restoreStdout = filterIdeOutput(process.stdout);
const restoreStderr = filterIdeOutput(process.stderr);
let succeeded = false;
try {
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'tests', 'ide', 'vm-discovery-smoke.cjs'),
    extensionTestsEnv: {
      API_MOCK_TEST_IDE: ide,
      API_MOCK_TEST_IDE_APP_VERSION: appVersion,
      API_MOCK_TEST_FLUTTER: flutter,
      API_MOCK_TEST_DEVICE: device,
      API_MOCK_TEST_DISCOVERY_BUNDLE: discoveryBundle,
      API_MOCK_TEST_DISCOVERY_REPORT: reportPath,
      API_MOCK_TEST_SOURCE_HASH: sourceHash,
      API_MOCK_TEST_FLUTTER_VERSION: version.frameworkVersion,
      API_MOCK_TEST_DART_VERSION: version.dartSdkVersion,
    },
    launchArgs: [
      workspace,
      '--user-data-dir',
      user,
      '--extensions-dir',
      extensions,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--no-sandbox',
    ],
  });
  succeeded = true;
} catch {
  process.exitCode = 1;
} finally {
  restoreStdout();
  restoreStderr();
}
console.log(`IDE_DISCOVERY_${succeeded ? 'PASS' : 'FAILED'} ${ide} ${reportPath}`);
await mkdir(join(root, 'artifacts'), { recursive: true });
try {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  await writeFile(
    join(root, 'artifacts', `vm-discovery-${ide}-report.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
} catch {
  await writeFile(
    join(root, 'artifacts', `vm-discovery-${ide}-report.json`),
    JSON.stringify(
      { ide, passed: false, error: 'IDE runner failed before producing a report', temp },
      null,
      2,
    ) + '\n',
  );
}

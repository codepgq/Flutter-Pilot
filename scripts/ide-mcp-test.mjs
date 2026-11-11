import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { access, cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const ide = process.env.FLUTTER_PILOT_TEST_IDE || 'vscode';
if (!['cursor', 'vscode'].includes(ide)) throw new Error('FLUTTER_PILOT_TEST_IDE must be cursor or vscode');
if (process.env.FLUTTER_PILOT_RUN_IDE_SMOKE !== '1') {
  console.log(
    'IDE MCP smoke skipped. This test starts an isolated desktop IDE and may trigger macOS keychain prompts; MCP configuration itself does not require keychain access. Set FLUTTER_PILOT_RUN_IDE_SMOKE=1 explicitly to run VS Code.',
  );
  process.exit(0);
}
if (ide === 'cursor' && process.env.FLUTTER_PILOT_RUN_CURSOR_SMOKE !== '1') {
  console.log(
    'Cursor MCP smoke skipped. An isolated Cursor profile may trigger repeated macOS keychain prompts. Set both FLUTTER_PILOT_RUN_IDE_SMOKE=1 and FLUTTER_PILOT_RUN_CURSOR_SMOKE=1 explicitly to run it.',
  );
  process.exit(0);
}
const executable =
  ide === 'cursor'
    ? '/Applications/Cursor.app/Contents/MacOS/Cursor'
    : '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
await access(executable);
const temp = await realpath(await mkdtemp(join(tmpdir(), `flutter-pilot-${ide}-mcp-`)));
const home = join(temp, 'home');
const user = join(temp, 'user');
const workspace = join(temp, 'flutter-workspace');
const extensions = join(temp, 'extensions');
const extensionPath = join(extensions, 'flutter-pilot.flutter-pilot');
const bridgeRoot = join(home, 'mcp');
const reportPath = join(temp, 'mcp-report.json');
await Promise.all(
  [home, workspace, join(user, 'User'), join(extensionPath, 'dist')].map((p) =>
    mkdir(p, { recursive: true }),
  ),
);
await cp(join(root, 'package.json'), join(extensionPath, 'package.json'));
await cp(join(root, 'resources'), join(extensionPath, 'resources'), { recursive: true });
await cp(join(root, 'proxy'), join(extensionPath, 'proxy'), {
  recursive: true,
  filter: (p) => !p.includes('__pycache__'),
});
await Promise.all([
  build({
    entryPoints: [join(root, 'src/extension.ts')],
    outfile: join(extensionPath, 'dist/extension.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
  }),
  build({
    entryPoints: [join(root, 'src/mcp/bridge.ts')],
    outfile: join(extensionPath, 'dist/mcp-bridge.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
  }),
  build({
    entryPoints: [join(root, 'webview/main.tsx')],
    outfile: join(extensionPath, 'dist/webview.js'),
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
]);
await writeFile(
  join(workspace, 'pubspec.yaml'),
  'name: mcp_ide_fixture\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n',
);
await writeFile(
  join(user, 'User', 'settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    'flutterPilot.autoConnectVm': false,
    'flutterPilot.autoStart': false,
  }),
);
const appVersion = JSON.parse(
  await readFile(resolve(executable, '..', '..', 'Resources/app/package.json'), 'utf8'),
).version;
console.log(`IDE_MCP_START ${ide} ${appVersion}`);
function filter(stream) {
  const original = stream.write.bind(stream);
  let pending = '';
  stream.write = (chunk, encoding, callback) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (/^MCP_IDE_(ASSERT|ERROR)/.test(line))
        original(line.replace(/(?:wss?|https?):\/\/[^\s'"<>]+/g, '[redacted URL]') + '\n');
    }
    if (pending.length > 65536) pending = '';
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  return () => {
    stream.write = original;
  };
}
const restoreOut = filter(process.stdout),
  restoreErr = filter(process.stderr);
let succeeded = false;
try {
  for (const phase of ['first', 'restore']) {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: extensionPath,
      extensionTestsPath: join(root, 'tests/ide/mcp-smoke.cjs'),
      extensionTestsEnv: {
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        FLUTTER_PILOT_MCP_ROOT: bridgeRoot,
        FLUTTER_PILOT_TEST_IDE: ide,
        FLUTTER_PILOT_TEST_IDE_APP_VERSION: appVersion,
        FLUTTER_PILOT_TEST_MCP_REPORT: reportPath,
        FLUTTER_PILOT_TEST_PHASE: phase,
        FLUTTER_PILOT_TEST_NODE: process.execPath,
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
        '--disable-extensions',
        '--no-sandbox',
      ],
    });
  }
  succeeded = true;
} catch {
  process.exitCode = 1;
} finally {
  restoreOut();
  restoreErr();
}
await mkdir(join(root, 'artifacts'), { recursive: true });
let report;
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch {
  report = { ide, passed: false, error: 'IDE runner failed before producing report', temp };
}
report.runnerPassed = succeeded;
await writeFile(
  join(root, 'artifacts', `mcp-${ide}-ide-report.json`),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(`IDE_MCP_${succeeded ? 'PASS' : 'FAILED'} ${ide} ${reportPath}`);

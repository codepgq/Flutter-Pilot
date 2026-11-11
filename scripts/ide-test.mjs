import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = resolve('.');
const engine = process.env.FLUTTER_PILOT_TEST_ENGINE;
if (!engine) throw new Error('设置 FLUTTER_PILOT_TEST_ENGINE 为 mitmdump 绝对路径');
const kind = process.env.FLUTTER_PILOT_TEST_IDE || 'vscode';
const executable =
  kind === 'cursor'
    ? '/Applications/Cursor.app/Contents/MacOS/Cursor'
    : '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
await access(executable);
const temp = await mkdtemp(join(tmpdir(), `flutter-pilot-${kind}-test-`));
const user = join(temp, 'user');
const workspace = join(temp, 'flutter-workspace');
await mkdir(join(user, 'User'), { recursive: true });
await mkdir(workspace);
await writeFile(
  join(workspace, 'pubspec.yaml'),
  'name: test_workspace\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.0.0\n',
);
await writeFile(
  join(user, 'User', 'settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'update.mode': 'none',
    'extensions.ignoreRecommendations': true,
    'flutterPilot.enginePath': engine,
    'flutterPilot.proxyPort': 18080,
  }),
);
// Seed only the legacy location: activation must migrate these project files.
const legacyStorage = join(
  user,
  'User',
  'globalStorage',
  'flutter-pilot.flutter-pilot',
  'workspaces',
  createHash('sha256').update(pathToFileURL(workspace).toString()).digest('hex').slice(0, 24),
);
await mkdir(legacyStorage, { recursive: true });
await writeFile(join(legacyStorage, 'connection.json'), JSON.stringify({ mode: 'proxy' }));
await writeFile(
  join(legacyStorage, 'rules.json'),
  JSON.stringify({
    version: 1,
    rules: [
      {
        id: 'ide-smoke',
        name: 'IDE HTTPS smoke',
        enabled: true,
        priority: 10,
        match: { host: 'ide.flutter-pilot.test', path: '/ping' },
        mock: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ide":true}' },
        breakpoint: { request: true, response: true, timeout: 60 },
      },
    ],
  }),
);
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: process.env.FLUTTER_PILOT_TEST_EXTENSION_PATH || root,
  extensionTestsPath: join(root, 'tests', 'ide', 'smoke.cjs'),
  extensionTestsEnv: { FLUTTER_PILOT_TEST_LEGACY_STORAGE: legacyStorage },
  launchArgs: [
    workspace,
    '--user-data-dir',
    user,
    '--extensions-dir',
    join(temp, 'extensions'),
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-updates',
    '--disable-extensions',
    '--no-sandbox',
  ],
});
console.log(`IDE_SMOKE_PASS ${kind} ${temp}`);

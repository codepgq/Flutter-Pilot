import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = resolve('.');
const engine = process.env.API_MOCK_TEST_ENGINE;
if (!engine) throw new Error('设置 API_MOCK_TEST_ENGINE 为 mitmdump 绝对路径');
const kind = process.env.API_MOCK_TEST_IDE || 'vscode';
const executable =
  kind === 'cursor'
    ? '/Applications/Cursor.app/Contents/MacOS/Cursor'
    : '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
await access(executable);
const temp = await mkdtemp(join(tmpdir(), `api-mocks-${kind}-test-`));
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
    'flutterApiMocks.enginePath': engine,
    'flutterApiMocks.proxyPort': 18080,
  }),
);
const storage = join(
  user,
  'User',
  'globalStorage',
  'api-mocks.flutter-api-mocks',
  'workspaces',
  createHash('sha256').update(pathToFileURL(workspace).toString()).digest('hex').slice(0, 24),
);
await mkdir(storage, { recursive: true });
await writeFile(
  join(storage, 'rules.json'),
  JSON.stringify({
    version: 1,
    rules: [
      {
        id: 'ide-smoke',
        name: 'IDE HTTPS smoke',
        enabled: true,
        priority: 10,
        match: { host: 'ide.api-mocks.test', path: '/ping' },
        mock: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ide":true}' },
      },
    ],
  }),
);
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: process.env.API_MOCK_TEST_EXTENSION_PATH || root,
  extensionTestsPath: join(root, 'tests', 'ide', 'smoke.cjs'),
  extensionTestsEnv: { API_MOCK_TEST_STORAGE: storage },
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

import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = resolve('.');
const kind = process.env.API_MOCK_TEST_IDE || 'vscode';
if (!['vscode', 'cursor'].includes(kind)) throw new Error('API_MOCK_TEST_IDE 必须为 vscode 或 cursor');
const executable =
  kind === 'cursor'
    ? '/Applications/Cursor.app/Contents/MacOS/Cursor'
    : '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
await access(executable);
const extensionPath = resolve(process.env.API_MOCK_TEST_EXTENSION_PATH || root);
await access(join(extensionPath, 'dist', 'extension.js'));
const temp = await mkdtemp(join(tmpdir(), `api-mocks-${kind}-vm-test-`));
const user = join(temp, 'user');
const workspace = join(temp, 'flutter-workspace');
await mkdir(join(user, 'User'), { recursive: true });
await mkdir(workspace);
await writeFile(
  join(workspace, 'pubspec.yaml'),
  'name: vm_test_workspace\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.0.0\n',
);
await writeFile(
  join(user, 'User', 'settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'update.mode': 'none',
    'extensions.ignoreRecommendations': true,
    'flutterApiMocks.autoStart': true,
    // No configured or cached engine is available in this isolated user profile.
    'flutterApiMocks.enginePath': '',
  }),
);
const globalStorage = join(user, 'User', 'globalStorage', 'api-mocks.flutter-api-mocks');
const legacyStorage = join(
  globalStorage,
  'workspaces',
  createHash('sha256').update(pathToFileURL(workspace).toString()).digest('hex').slice(0, 24),
);
await mkdir(legacyStorage, { recursive: true });
await writeFile(join(legacyStorage, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: extensionPath,
  extensionTestsPath: join(root, 'tests', 'ide', 'vm-smoke.cjs'),
  extensionTestsEnv: { API_MOCK_TEST_GLOBAL_STORAGE: globalStorage },
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
const report = {
  ide: kind,
  extensionPath,
  passed: true,
  assertions: [
    'new workspace defaults to VM mode',
    'no proxy engine or CA',
    'offline SQLite/API catalog',
    'history query/select and rule draft',
    'synthetic VM WebSocket connect',
    'workbench close retains connection',
    'project UUID/name and project-owned configuration/rules',
    'UUID plus directory isolated private storage',
    'project rule save/reload and external-edit overwrite protection',
    'mode persistence without authentication URL',
    'session disposal disconnects',
  ],
  limits: [
    'Synthetic JSON-RPC server; this does not prove Flutter runtime injection.',
    'IDE internal message handler exercised; real webview pointer interaction is covered separately.',
  ],
};
await writeFile(join(temp, 'vm-ide-report.json'), JSON.stringify(report, null, 2));
console.log(`IDE_VM_SMOKE_PASS ${kind} ${temp}`);

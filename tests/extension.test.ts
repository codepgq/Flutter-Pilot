import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
const fake = vi.hoisted(() => ({
  commands: new Map<string, () => Promise<unknown>>(),
  panels: [] as any[],
  engines: [] as any[],
  runtime: {
    cached: '/fake/mitmdump' as string | undefined,
    download: undefined as Promise<string> | undefined,
  },
  storage: '',
  workspace: '',
  extraWorkspace: '',
  rejectSync: false,
  autoStart: true,
  trusted: true,
  folderPresent: true,
  configurationListener: undefined as any,
  folderListener: undefined as any,
  confirm: undefined as string | undefined,
}));
vi.mock('vscode', async () => {
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const uri = (path: string) => ({
    fsPath: path,
    scheme: 'file',
    toString: () => pathToFileURL(path).toString(),
  });
  return {
    Uri: {
      file: uri,
      joinPath: (base: any, ...parts: string[]) => uri(join(base.fsPath, ...parts)),
      from: (input: any) => ({ ...input, toString: () => `${input.scheme}:${input.path}` }),
    },
    ViewColumn: { One: 1 },
    StatusBarAlignment: { Left: 1 },
    env: {},
    workspace: {
      get isTrusted() {
        return fake.trusted;
      },
      get workspaceFolders() {
        return [
          ...(fake.folderPresent ? [{ name: 'project', uri: uri(fake.workspace) }] : []),
          ...(fake.extraWorkspace ? [{ name: 'second', uri: uri(fake.extraWorkspace) }] : []),
        ];
      },
      getConfiguration: () => ({
        get: (key: string, value: unknown) => (key === 'autoStart' ? fake.autoStart : value),
      }),
      onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
      onDidChangeWorkspaceFolders: (callback: any) => {
        fake.folderListener = callback;
        return { dispose() {} };
      },
      onDidChangeConfiguration: (callback: any) => {
        fake.configurationListener = callback;
        return { dispose() {} };
      },
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      textDocuments: [],
    },
    commands: {
      registerCommand: (name: string, callback: () => Promise<unknown>) => {
        fake.commands.set(name, callback);
        return { dispose() {} };
      },
      executeCommand: async (name: string) => fake.commands.get(name)?.(),
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showErrorMessage: vi.fn(),
      showWarningMessage: async () => fake.confirm,
      createWebviewPanel: () => {
        const panel = {
          webview: {
            html: '',
            cspSource: 'test-src',
            messages: [] as any[],
            postMessage(message: unknown) {
              this.messages.push(message);
              return Promise.resolve(true);
            },
            asWebviewUri: (uri: any) => uri.fsPath,
            onDidReceiveMessage(callback: any) {
              panel.receive = callback;
            },
          },
          receive: undefined as any,
          close: undefined as any,
          onDidDispose(callback: any) {
            panel.close = callback;
          },
          reveal() {},
          dispose() {
            panel.close?.();
          },
        };
        fake.panels.push(panel);
        return panel;
      },
    },
  };
});
vi.mock('../src/runtime', () => ({
  RuntimeManager: class extends EventEmitter {
    findExecutable() {
      return Promise.resolve(fake.runtime.cached);
    }
    ensureExecutable() {
      return fake.runtime.download ?? Promise.resolve('/fake/mitmdump');
    }
  },
}));
vi.mock('../src/devices', () => ({
  discoverConnectionAddresses: () => [{ label: '本机', host: '127.0.0.1' }],
  cleanupAndroidReverses: async () => {},
  discoverDevices: async () => ({ devices: [], diagnostics: [] }),
}));
vi.mock('../src/engine', () => ({
  EngineManager: class extends EventEmitter {
    state = { status: 'stopped', proxyActive: false, proxyPort: 18080 };
    calls: { method: string; params: any }[] = [];
    starts: any[] = [];
    stops = 0;
    constructor() {
      super();
      fake.engines.push(this);
    }
    async start(options: any) {
      this.starts.push(options);
      this.state = { ...this.state, status: 'running', proxyActive: false };
      this.emit('status', this.state);
      return this.state;
    }
    async stop() {
      this.stops++;
      this.state = { ...this.state, status: 'stopped', proxyActive: false };
      this.emit('status', this.state);
    }
    async rpc(method: string, params: any) {
      this.calls.push({ method, params });
      if (method === 'rules.sync' && fake.rejectSync) throw new Error('engine rejected');
      if (method === 'proxy.start') this.state.proxyActive = true;
      if (method === 'proxy.stop') this.state.proxyActive = false;
      if (method === 'history.list') return { items: [], total: 0 };
      if (method === 'history.apis') return { items: [] };
      if (method === 'history.get') return { id: params.id, body: 'large detail' };
      return { ready: true, ...this.state, caCertPath: '/fake/ca.pem' };
    }
  },
}));
import { activate, deactivate } from '../src/extension';
let directory: string;
const rule = {
  id: 'test',
  name: 'test',
  enabled: true,
  priority: 0,
  match: { path: '/test' },
  mock: { status: 200, headers: {}, body: '{}' },
};
async function open() {
  await fake.commands.get('flutterApiMocks.open')?.();
  return fake.panels.at(-1);
}
async function message(action: string, payload: unknown = {}) {
  const panel = fake.panels.at(-1);
  const count = panel.webview.messages.length;
  panel.receive({ action, payload });
  await vi.waitFor(() => expect(panel.webview.messages.length).toBeGreaterThan(count));
  await new Promise((r) => setTimeout(r, 5));
}
function latest() {
  return fake.panels
    .at(-1)
    .webview.messages.filter((m: any) => m.type === 'state')
    .at(-1);
}
async function activateCurrent() {
  await activate({
    subscriptions: [],
    globalStorageUri: { fsPath: fake.storage },
    extensionPath: process.cwd(),
    extensionUri: { fsPath: process.cwd() },
  } as any);
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'api-mocks-extension-'));
  fake.workspace = join(directory, 'project');
  fake.extraWorkspace = '';
  fake.storage = join(directory, 'storage');
  fake.commands.clear();
  fake.panels = [];
  fake.engines = [];
  fake.runtime.cached = '/fake/mitmdump';
  fake.runtime.download = undefined;
  fake.rejectSync = false;
  fake.autoStart = true;
  fake.trusted = true;
  fake.folderPresent = true;
  fake.confirm = undefined;
  await mkdir(fake.workspace, { recursive: true });
  await writeFile(
    join(fake.workspace, 'pubspec.yaml'),
    'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.0.0\n',
  );
  await activate({
    subscriptions: [],
    globalStorageUri: { fsPath: fake.storage },
    extensionPath: process.cwd(),
    extensionUri: { fsPath: process.cwd() },
  } as any);
});
afterEach(async () => {
  await deactivate();
  await rm(directory, { recursive: true, force: true });
});
describe('扩展与工作台整合', () => {
  it('打开Flutter项目后无面板自动启动，手动停止后重开面板不恢复监听', async () => {
    const engine = fake.engines[0];
    expect(fake.panels).toHaveLength(0);
    expect(engine.starts[0].startPaused).toBe(true);
    expect(engine.calls.some((c: any) => c.method === 'proxy.start')).toBe(true);
    await open();
    expect(latest().state.proxyActive).toBe(true);
    await fake.commands.get('flutterApiMocks.start')?.();
    expect(engine.calls.some((c: any) => c.method === 'proxy.start')).toBe(true);
    expect(latest().state.proxyActive).toBe(true);
    await fake.commands.get('flutterApiMocks.stop')?.();
    expect(engine.calls.some((c: any) => c.method === 'proxy.stop')).toBe(true);
    expect(latest().state.proxyActive).toBe(false);
    expect(engine.stops).toBe(0);
    fake.panels[0].close();
    await open();
    expect(latest().state.proxyActive).toBe(false);
    expect(engine.stops).toBe(0);
  });
  it('规则先保存再同步，拒绝非法导入且保留已保存但未生效状态', async () => {
    await open();
    await message('rules.save', { rule: { ...rule, mock: { ...rule.mock, status: 999 } } });
    expect(latest().state.lastError).toContain('状态码');
    expect(fake.engines[0].calls.filter((c: any) => c.method === 'rules.sync')).toHaveLength(1);
    fake.rejectSync = true;
    await message('rules.save', { rule });
    await vi.waitFor(() => expect(latest().state.ruleSyncError).toContain('未生效'));
    const file = fake.engines[0].starts[0].storagePath + '/rules.json';
    expect(JSON.parse(await readFile(file, 'utf8')).rules[0].id).toBe('test');
  });
  it('选中完整历史仅发送一次，后续状态不重复传正文', async () => {
    await open();
    await message('history.select', { id: 'row' });
    expect(latest().selected).toEqual({ id: 'row', body: 'large detail' });
    await message('error.dismiss');
    expect(latest()).not.toHaveProperty('selected');
  });
  it('引擎异常后清理待处理断点并更新代理状态', async () => {
    await open();
    const engine = fake.engines[0];
    engine.emit('event', { event: 'breakpoint', data: { id: 'bp', flowId: 'f' } });
    expect(latest().state.pending).toHaveLength(1);
    engine.emit('status', { status: 'error', proxyActive: false, error: 'crashed' });
    expect(latest().state.pending).toHaveLength(0);
    expect(latest().state.proxyActive).toBe(false);
    expect(latest().state.lastError).toBe('crashed');
  });
  it('安装下载中关闭工作台仍按用户要求后台启动记录', async () => {
    await deactivate();
    fake.runtime.cached = undefined;
    let resolve!: (value: string) => void;
    fake.runtime.download = new Promise((r) => (resolve = r));
    await activate({
      subscriptions: [],
      globalStorageUri: { fsPath: fake.storage },
      extensionPath: process.cwd(),
      extensionUri: { fsPath: process.cwd() },
    } as any);
    const panel = await open();
    panel.receive({ action: 'install', payload: {} });
    await vi.waitFor(() => expect(latest().state.busy).toBe(true));
    panel.close();
    resolve('/fake/downloaded');
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.engines.at(-1).starts).toHaveLength(1);
    expect(fake.engines.at(-1).state.proxyActive).toBe(true);
  });
});

describe('后台采集与独立API目录控制', () => {
  it('关闭面板只关闭人工断点，保留代理；重新打开复用同一进程', async () => {
    await open();
    const engine = fake.engines[0];
    const panel = fake.panels.at(-1);
    panel.close();
    await vi.waitFor(() =>
      expect(engine.calls.at(-1)).toMatchObject({
        method: 'breakpoint.setInteractive',
        params: { enabled: false },
      }),
    );
    expect(engine.stops).toBe(0);
    expect(engine.state.proxyActive).toBe(true);
    await open();
    expect(engine.starts).toHaveLength(1);
    expect(engine.calls.some((c: any) => c.method === 'breakpoint.setInteractive' && c.params.enabled)).toBe(
      true,
    );
  });
  it('autoStart关闭时停止采集，再开启自动恢复', async () => {
    const engine = fake.engines[0];
    fake.autoStart = false;
    fake.configurationListener({ affectsConfiguration: () => true });
    await vi.waitFor(() => expect(engine.state.proxyActive).toBe(false));
    fake.autoStart = true;
    fake.configurationListener({ affectsConfiguration: () => true });
    await vi.waitFor(() => expect(engine.state.proxyActive).toBe(true));
  });
  it('取消目录删除不发RPC，确认只删除目录不删除历史', async () => {
    await open();
    const engine = fake.engines[0];
    const api = { method: 'GET', host: 'api.test', path: '/orders' };
    await message('api.delete', api);
    expect(engine.calls.some((c: any) => c.method === 'api.delete')).toBe(false);
    fake.confirm = '移除 API';
    await message('api.delete', api);
    expect(engine.calls).toContainEqual({ method: 'api.delete', params: api });
    expect(engine.calls.some((c: any) => c.method === 'history.delete' || c.method === 'history.clear')).toBe(
      false,
    );
  });
  it('移除文件夹会退出对应后台引擎', async () => {
    const engine = fake.engines[0];
    fake.folderPresent = false;
    fake.folderListener({
      removed: [{ uri: { toString: () => new URL('file://' + fake.workspace).toString() } }],
      added: [],
    });
    await vi.waitFor(() => expect(engine.stops).toBe(1));
  });
});

describe('自动记录前提与退出保护', () => {
  it('Dart workspace 根下多个Flutter成员仅启动一个根目录后台会话', async () => {
    await deactivate();
    fake.engines = [];
    await writeFile(
      join(fake.workspace, 'pubspec.yaml'),
      'name: monorepo\nworkspace:\n  # Flutter apps\n  - packages/missing\n  - "apps/first" # app\n  - \'apps/second\'\n  - apps/first\ndev_dependencies:\n  melos: ^7.0.0\n',
    );
    for (const name of ['first', 'second']) {
      const member = join(fake.workspace, 'apps', name);
      await mkdir(member, { recursive: true });
      await writeFile(
        join(member, 'pubspec.yaml'),
        `name: ${name}\nresolution: workspace\ndependencies:\n  flutter:\n    sdk: flutter\n`,
      );
    }
    await activateCurrent();
    expect(fake.engines).toHaveLength(1);
    expect(fake.engines[0].state.proxyActive).toBe(true);
    expect(fake.panels).toHaveLength(0);
    const storage = fake.engines[0].starts[0].storagePath;
    await deactivate();
    fake.engines = [];
    await activateCurrent();
    expect(fake.engines).toHaveLength(1);
    expect(fake.engines[0].starts[0].storagePath).toBe(storage);
  });
  it('支持Dart workspace内联列表和未缩进的成员列表', async () => {
    const member = join(fake.workspace, 'apps', 'app');
    await mkdir(member, { recursive: true });
    await writeFile(
      join(member, 'pubspec.yaml'),
      'dependencies:\r\n  flutter: # SDK\r\n    sdk: flutter\r\n',
    );
    for (const content of ['workspace: ["apps/missing", \'apps/app\']\n', 'workspace:\n- apps/app\n']) {
      await deactivate();
      fake.engines = [];
      await writeFile(join(fake.workspace, 'pubspec.yaml'), content);
      await activateCurrent();
      expect(fake.engines).toHaveLength(1);
      expect(fake.engines[0].state.proxyActive).toBe(true);
    }
  });
  it('纯Dart workspace不启动，也不会递归搜索未声明的Flutter应用', async () => {
    await deactivate();
    fake.engines = [];
    await writeFile(
      join(fake.workspace, 'pubspec.yaml'),
      'name: dart_workspace\nworkspace:\n  - packages/plain\n',
    );
    const member = join(fake.workspace, 'packages', 'plain');
    await mkdir(join(member, 'nested'), { recursive: true });
    await writeFile(join(member, 'pubspec.yaml'), 'name: plain\nworkspace: [nested]\n');
    await writeFile(join(member, 'nested', 'pubspec.yaml'), 'dependencies:\n  flutter:\n    sdk: flutter\n');
    await activateCurrent();
    expect(fake.engines).toHaveLength(0);
  });
  it('workspace成员路径越界或符号链接指向根外时不启动', async () => {
    await deactivate();
    fake.engines = [];
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'pubspec.yaml'), 'dependencies:\n  flutter:\n    sdk: flutter\n');
    await symlink(outside, join(fake.workspace, 'linked'));
    await writeFile(
      join(fake.workspace, 'pubspec.yaml'),
      `workspace:\n  - ../outside\n  - "${outside}"\n  - linked\n`,
    );
    await activateCurrent();
    expect(fake.engines).toHaveLength(0);
  });
  it('workspace发现最多检查256个声明成员', async () => {
    await deactivate();
    fake.engines = [];
    const member = join(fake.workspace, 'too-late');
    await mkdir(member);
    await writeFile(join(member, 'pubspec.yaml'), 'dependencies:\n  flutter:\n    sdk: flutter\n');
    const missing = Array.from({ length: 256 }, (_, i) => `  - missing-${i}\n`).join('');
    await writeFile(join(fake.workspace, 'pubspec.yaml'), `workspace:\n${missing}  - too-late\n`);
    await activateCurrent();
    expect(fake.engines).toHaveLength(0);
  });
  it('多根Flutter工作区独立启动和存储，移除一个不影响另一个', async () => {
    await deactivate();
    fake.extraWorkspace = join(directory, 'second');
    await mkdir(fake.extraWorkspace);
    await writeFile(
      join(fake.extraWorkspace, 'pubspec.yaml'),
      'name: second\ndependencies:\n  flutter:\n    sdk: flutter\n',
    );
    fake.engines = [];
    await activateCurrent();
    expect(fake.engines).toHaveLength(2);
    expect(fake.engines.every((engine) => engine.state.proxyActive)).toBe(true);
    const [first, second] = fake.engines;
    expect(first.starts[0].storagePath).not.toBe(second.starts[0].storagePath);
    fake.folderPresent = false;
    fake.folderListener({
      removed: [{ uri: { toString: () => new URL('file://' + fake.workspace).toString() } }],
      added: [],
    });
    await vi.waitFor(() => expect(first.stops).toBe(1));
    expect(second.stops).toBe(0);
    expect(second.state.proxyActive).toBe(true);
    await deactivate();
    expect(second.stops).toBe(1);
  });
  it('首次无引擎不静默下载，也不打开面板', async () => {
    await deactivate();
    fake.runtime.cached = undefined;
    fake.panels = [];
    fake.engines = [];
    await activateCurrent();
    expect(fake.panels).toHaveLength(0);
    expect(fake.engines[0].starts).toHaveLength(0);
  });
  it('默认关闭自动启动的工作区只准备引擎不启动监听', async () => {
    await deactivate();
    fake.autoStart = false;
    fake.engines = [];
    await activateCurrent();
    expect(fake.engines[0].calls.some((c: any) => c.method === 'proxy.start')).toBe(false);
    await open();
    expect(latest().state.proxyActive).toBe(false);
  });
  it('不信任的工作区不创建后台会话', async () => {
    await deactivate();
    fake.trusted = false;
    fake.engines = [];
    await activateCurrent();
    expect(fake.engines).toHaveLength(0);
  });
  it('关闭IDE后完整退出引擎，下次激活恢复默认自动记录', async () => {
    const engine = fake.engines[0];
    await deactivate();
    expect(engine.stops).toBe(1);
    await activateCurrent();
    expect(fake.engines.at(-1).state.proxyActive).toBe(true);
  });
  it('下载中退出IDE不会在异步完成后重新创建引擎', async () => {
    await deactivate();
    fake.runtime.cached = undefined;
    fake.panels = [];
    fake.engines = [];
    let resolve!: (value: string) => void;
    fake.runtime.download = new Promise((r) => (resolve = r));
    await activateCurrent();
    const panel = await open();
    panel.receive({ action: 'install', payload: {} });
    await vi.waitFor(() => expect(latest().state.busy).toBe(true));
    await deactivate();
    resolve('/fake/download');
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.engines[0].starts).toHaveLength(0);
  });
});

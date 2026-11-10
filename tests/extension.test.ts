import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { discoverSessions, requestSession } from '../src/mcp/server';
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
  autoConnectVm: true,
  debugEvents: undefined as any,
  debugStarted: undefined as any,
  debugStopped: undefined as any,
  trusted: true,
  folderPresent: true,
  configurationListener: undefined as any,
  folderListener: undefined as any,
  confirm: undefined as string | undefined,
  selectedWorkspace: '',
  shownDocuments: [] as string[],
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
    debug: {
      onDidReceiveDebugSessionCustomEvent: (callback: any) => {
        fake.debugEvents = callback;
        return { dispose() {} };
      },
      onDidStartDebugSession: (callback: any) => {
        fake.debugStarted = callback;
        return { dispose() {} };
      },
      onDidTerminateDebugSession: (callback: any) => {
        fake.debugStopped = callback;
        return { dispose() {} };
      },
    },
    extensions: { getExtension: () => undefined },
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
        get: (key: string, value: unknown) =>
          key === 'autoStart' ? fake.autoStart : key === 'autoConnectVm' ? fake.autoConnectVm : value,
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
      showQuickPick: async (items: any[]) =>
        items.find((item) => item.folder.uri.fsPath === fake.selectedWorkspace) ?? items[0],
      showTextDocument: async (uri: any) => {
        fake.shownDocuments.push(uri.fsPath);
      },
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
function workspaceHash(workspace: string) {
  return createHash('sha256').update(pathToFileURL(workspace).toString()).digest('hex').slice(0, 24);
}
function legacyStorage(workspace = fake.workspace) {
  return join(fake.storage, 'workspaces', workspaceHash(workspace));
}
function projectFile(workspace = fake.workspace) {
  return join(workspace, '.api-mocks', 'project.json');
}
function rulesFile(workspace = fake.workspace) {
  return join(workspace, '.api-mocks', 'rules.json');
}
async function readProject(workspace = fake.workspace) {
  return JSON.parse(await readFile(projectFile(workspace), 'utf8'));
}
async function writeProject(patch: Record<string, unknown>, workspace = fake.workspace) {
  await writeFile(projectFile(workspace), JSON.stringify({ ...(await readProject(workspace)), ...patch }));
}
async function privateStorage(workspace = fake.workspace) {
  return join(
    fake.storage,
    'projects',
    (await readProject(workspace)).projectId.toLowerCase(),
    workspaceHash(workspace),
  );
}
async function saveProxyConnection(workspace: string) {
  const storage = legacyStorage(workspace);
  await mkdir(storage, { recursive: true });
  await writeFile(join(storage, 'connection.json'), JSON.stringify({ mode: 'proxy' }));
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
  process.env.API_MOCKS_MCP_ROOT = join(directory, 'bridge');
  fake.commands.clear();
  fake.panels = [];
  fake.engines = [];
  fake.runtime.cached = '/fake/mitmdump';
  fake.runtime.download = undefined;
  fake.rejectSync = false;
  fake.autoStart = true;
  fake.autoConnectVm = true;
  fake.trusted = true;
  fake.folderPresent = true;
  fake.confirm = undefined;
  fake.selectedWorkspace = '';
  fake.shownDocuments = [];
  await mkdir(fake.workspace, { recursive: true });
  await writeFile(
    join(fake.workspace, 'pubspec.yaml'),
    'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.0.0\n',
  );
  await saveProxyConnection(fake.workspace);
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
  delete process.env.API_MOCKS_MCP_ROOT;
});
describe('扩展与工作台整合', () => {
  it('MCP defaults off, survives panel close, isolates sessions and cleans up on disable', async () => {
    await open();
    expect(latest().state.mcp).toMatchObject({ enabled: false, running: false });
    await message('mcp.enable', { enabled: true });
    await vi.waitFor(() => expect(latest().state.mcp.running).toBe(true));
    const registry = join(directory, 'bridge', 'sessions');
    const descriptors = await discoverSessions(registry, fake.workspace);
    expect(descriptors).toHaveLength(1);
    const descriptor = descriptors[0];
    const result = (await requestSession(descriptor, {
      kind: 'call',
      tool: 'get_network_status',
      args: { sessionId: descriptor.sessionId },
    })) as any;
    expect(result.files.http).toMatch(/\/project\/\.api-mocks\/rules\.json$/);
    expect(result.http.mockEnabled).toBe(false);
    const panel = fake.panels.at(-1);
    panel.dispose();
    expect(await discoverSessions(registry, fake.workspace)).toHaveLength(1);
    await open();
    await message('mcp.enable', { enabled: false });
    await vi.waitFor(async () => expect(await discoverSessions(registry, fake.workspace)).toHaveLength(0));
  });
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
    const file = rulesFile();
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
    await saveProxyConnection(fake.extraWorkspace);
    await activateCurrent();
    expect(fake.engines).toHaveLength(2);
    expect(fake.engines.every((engine) => engine.state.proxyActive)).toBe(true);
    // Workspace discovery is concurrent; constructor order is not workspace order.
    const firstKey = createHash('sha256')
      .update(pathToFileURL(fake.workspace).toString())
      .digest('hex')
      .slice(0, 24);
    const first = fake.engines.find((engine) => engine.starts[0].storagePath.endsWith(firstKey));
    const second = fake.engines.find((engine) => engine !== first);
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

describe('VM 连接模式扩展整合', () => {
  async function activateVmMode() {
    await deactivate();
    fake.runtime.cached = undefined;
    fake.engines = [];
    await writeProject({ connection: { mode: 'vm' } });
    await activateCurrent();
    return privateStorage();
  }

  async function withDiscoveredVm(test: (emit: (id?: string) => void, server: any) => Promise<void>) {
    const { WebSocketServer } = await import('ws');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as { port: number };
    server.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const request = JSON.parse(raw.toString());
        socket.send(
          JSON.stringify({
            id: request.id,
            result: request.method === 'getVM' ? { type: 'VM', isolates: [] } : { type: 'Success' },
          }),
        );
      }),
    );
    const emit = (id = 'flutter-session') => {
      const session = {
        id,
        name: `Debug ${id}`,
        type: 'dart',
        workspaceFolder: { uri: { toString: () => pathToFileURL(fake.workspace).toString() } },
        configuration: { cwd: fake.workspace },
      };
      fake.debugStarted(session);
      fake.debugEvents({
        session,
        event: 'flutter.appStart',
        body: { mode: 'debug', deviceId: 'ios-simulator' },
      });
      fake.debugEvents({
        session,
        event: 'dart.debuggerUris',
        body: { vmServiceUri: `ws://127.0.0.1:${address.port}/discovery-private-token=/ws` },
      });
    };
    try {
      await test(emit, server);
    } finally {
      await deactivate();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('MCP routes lifecycle to the bound debug session and rejects manual VM ownership', async () => {
    await withDiscoveredVm(async (emit, server) => {
      await activateVmMode();
      await open();
      emit();
      await vi.waitFor(() => expect(latest().state.vm.status).toBe('connected'));
      await message('mcp.enable', { enabled: true });
      await vi.waitFor(() => expect(latest().state.mcp.running).toBe(true));
      const descriptor = (await discoverSessions(join(directory, 'bridge', 'sessions'), fake.workspace))[0];
      const describe = () => requestSession(descriptor, { kind: 'describe' }) as Promise<any>;
      expect((await describe()).capabilities.lifecycle.supported).toBe(true);
      // This VM fixture has no Flutter isolate: the MCP route must reject it before any control request.
      const result = await requestSession(descriptor, {
        kind: 'call',
        tool: 'hot_restart',
        args: { sessionId: descriptor.sessionId },
      });
      expect(result).toMatchObject({ ok: false, submitted: false, code: 'FLUTTER_UNAVAILABLE' });
      await message('vm.disconnect');
      const port = server.address().port;
      await message('vm.connect', { url: `ws://127.0.0.1:${port}/discovery-private-token=/ws` });
      await vi.waitFor(() => expect(latest().state.vm.status).toBe('connected'));
      expect((await describe()).capabilities.lifecycle.supported).toBe(false);
      await expect(
        requestSession(descriptor, {
          kind: 'call',
          tool: 'hot_reload',
          args: { sessionId: descriptor.sessionId },
        }),
      ).rejects.toMatchObject({ code: 'DEBUG_SESSION_UNAVAILABLE' });
    });
  });

  it('调试事件自动连接且独立开关默认关闭，手动断开抑制并可通过消息显式重连', async () => {
    await withDiscoveredVm(async (emit) => {
      await activateVmMode();
      await open();
      emit();
      await vi.waitFor(() => expect(latest().state.vm.status).toBe('connected'));
      expect(latest().state.vmDiscovery.connectedSessionId).toBe('flutter-session');
      expect(latest().state.vm.mockEnabled).toBe(false);
      expect(latest().state.ws.captureEnabled).toBe(false);
      expect(latest().state.ws.mockEnabled).toBe(false);
      expect(JSON.stringify(fake.panels.at(-1).webview.messages)).not.toContain('discovery-private-token');
      expect(await readFile(projectFile(), 'utf8')).not.toContain('discovery-private-token');
      await message('vm.disconnect');
      emit();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(latest().state.vm.status).toBe('disconnected');
      expect(latest().state.vmDiscovery.candidates[0].status).toBe('paused');
      await message('vm.discovery.connect', { id: 'flutter-session' });
      await vi.waitFor(() => expect(latest().state.vm.status).toBe('connected'));
      fake.debugStopped({ id: 'flutter-session' });
      await vi.waitFor(() => expect(latest().state.vm.status).toBe('disconnected'));
    });
  });

  it('项目设置覆盖IDE自动连接，读取后立即应用且不重启当前会话', async () => {
    await withDiscoveredVm(async (emit) => {
      await activateVmMode();
      await writeProject({ settings: { autoConnectVm: false } });
      await deactivate();
      await activateCurrent();
      await open();
      emit();
      await vi.waitFor(() => expect(latest().state.vmDiscovery.candidates).toHaveLength(1));
      expect(latest().state.vm.status).toBe('disconnected');
      fake.configurationListener({ affectsConfiguration: (key: string) => key.endsWith('autoConnectVm') });
      expect(latest().state.vmDiscovery.enabled).toBe(false);
      await writeProject({ settings: { autoConnectVm: true } });
      await message('project.reload');
      await vi.waitFor(() => expect(latest().state.vm.status).toBe('connected'));
      await writeProject({ settings: { autoConnectVm: false } });
      await message('project.reload');
      expect(latest().state.vm.status).toBe('connected');
      expect(latest().state.vmDiscovery.enabled).toBe(false);
    });
  });

  it('代理模式只展示候选，切换VM后自动连接且关闭面板继续记录', async () => {
    await withDiscoveredVm(async (emit) => {
      await open();
      emit();
      await vi.waitFor(() => expect(latest().state.vmDiscovery.candidates).toHaveLength(1));
      expect(latest().state.vm.status).toBe('disconnected');
      await message('connection.mode', { mode: 'vm' });
      await vi.waitFor(() => expect(latest().state.vm.status).toBe('connected'));
      fake.panels.at(-1).dispose();
      await open();
      await vi.waitFor(() => expect(latest().state.vm.status).toBe('connected'));
      await message('connection.mode', { mode: 'proxy' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(latest().state.vm.status).toBe('disconnected');
    });
  });

  it('新工作区默认 VM，即使已有可用代理引擎也不启动代理', async () => {
    await deactivate();
    await rm(join(legacyStorage(), 'connection.json'));
    await rm(join(fake.workspace, '.api-mocks'), { recursive: true });
    fake.engines = [];
    await activateCurrent();
    await open();
    expect(latest().state.mode).toBe('vm');
    expect(fake.engines[0].starts).toHaveLength(0);
    expect(fake.engines[0].calls).toHaveLength(0);
    expect(latest().state.vm.status).toBe('disconnected');
  });

  it('旧版不含 mode 的代理设置继续使用代理，显式 VM 选择优先', async () => {
    await deactivate();
    await rm(join(fake.workspace, '.api-mocks'), { recursive: true });
    await rm(join(legacyStorage(), 'project-binding.json'));
    await writeFile(join(legacyStorage(), 'connection.json'), JSON.stringify({ port: 8080 }));
    fake.engines = [];
    await activateCurrent();
    await open();
    expect(latest().state.mode).toBe('proxy');
    expect(fake.engines[0].starts).toHaveLength(1);
    await message('connection.mode', { mode: 'vm' });
    expect(latest().state.mode).toBe('vm');
  });

  it('持久化 VM 模式启动时不需要已安装代理引擎，也不自动启动或下载', async () => {
    await activateVmMode();
    expect(fake.engines).toHaveLength(1);
    expect(fake.engines[0].starts).toHaveLength(0);
    expect(fake.engines[0].calls).toHaveLength(0);
    expect(fake.panels).toHaveLength(0);
    await open();
    expect(latest().state).toMatchObject({ mode: 'vm', proxyActive: false, vm: { status: 'disconnected' } });
    expect(fake.engines[0].starts).toHaveLength(0);
    expect(fake.engines[0].calls).toHaveLength(0);
  });

  it('工作台切换 VM 模式会持久化，下次激活仍独立于代理引擎', async () => {
    const engine = fake.engines[0];
    await open();
    await message('connection.mode', { mode: 'vm' });
    await vi.waitFor(() => expect(latest().state).toMatchObject({ mode: 'vm', busy: false }));
    const saved = await readProject();
    expect(saved.connection.mode).toBe('vm');
    expect(saved).not.toHaveProperty('url');
    expect(saved).not.toHaveProperty('wsUrl');
    expect(engine.calls).toContainEqual({ method: 'breakpoint.setInteractive', params: { enabled: false } });
    await deactivate();
    fake.engines = [];
    fake.runtime.cached = undefined;
    await activateCurrent();
    await open();
    expect(latest().state.mode).toBe('vm');
    expect(fake.engines[0].starts).toHaveLength(0);
  });

  it('真实 WS 与 SQLite 可在无引擎模式连接、查询离线历史及从历史生成 Mock，退出断开 WS', async () => {
    const { WebSocketServer } = await import('ws');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WS port unavailable');
    const rpcCalls: string[] = [];
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
      const storage = await activateVmMode();
      const { VmHistoryStore } = await import('../src/vm/storage');
      const db = new VmHistoryStore(storage, { retentionDays: 7, maxRecords: 10000 });
      const request = {
        method: 'GET',
        url: 'https://api.example.test/sample',
        headers: [] as [string, string][],
        body: '',
        bodyEncoding: 'text' as const,
        bodyBytes: 0,
        truncated: false,
        editable: true,
      };
      const response = {
        headers: [['content-type', 'application/json']] as [string, string][],
        body: '{"ok":true}',
        bodyEncoding: 'text' as const,
        bodyBytes: 11,
        truncated: false,
        editable: true,
        status: 200,
      };
      await db.init();
      await db.put({
        id: 'vm-fixture',
        startedAt: Date.now(),
        duration: 12,
        method: request.method,
        host: 'api.example.test',
        path: '/sample',
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
      await db.close();
      await open();
      await message('history.query', {});
      await vi.waitFor(() => expect(latest().state.history.total).toBe(1));
      await message('history.select', { id: 'vm-fixture' });
      const selectedMessage = () =>
        fake.panels
          .at(-1)
          .webview.messages.findLast(
            (item: any) => item.type === 'state' && item.selected?.id === 'vm-fixture',
          );
      await vi.waitFor(() => expect(selectedMessage()).toBeDefined());
      expect(selectedMessage().selected.response.body).toBe('{"ok":true}');
      await message('history.toRule', { id: 'vm-fixture', kind: 'mock' });
      await vi.waitFor(() =>
        expect(
          fake.panels
            .at(-1)
            .webview.messages.some(
              (item: any) => item.type === 'editRule' && item.rule.mock.body === '{"ok":true}',
            ),
        ).toBe(true),
      );
      const url = `ws://127.0.0.1:${address.port}/private-auth-token=/ws`;
      await message('vm.connect', { url });
      await vi.waitFor(() => expect(latest().state.vm.status).toBe('connected'));
      expect(latest().state.vm.endpoint).toBe(`127.0.0.1:${address.port}`);
      expect(rpcCalls).toContain('getVM');
      expect(fake.engines[0].starts).toHaveLength(0);
      expect(fake.engines[0].calls).toHaveLength(0);
      expect(await readFile(projectFile(), 'utf8')).not.toContain('private-auth-token');
      expect(await readFile(rulesFile(), 'utf8')).not.toContain('private-auth-token');
      await deactivate();
      await vi.waitFor(() => expect(server.clients.size).toBe(0));
    } finally {
      await deactivate();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('VM 页保存共用规则也同步旧代理，代理重连不重新启用人工断点', async () => {
    const engine = fake.engines[0];
    await open();
    await message('connection.mode', { mode: 'vm' });
    engine.calls.length = 0;
    engine.emit('event', { event: 'control.connected' });
    await vi.waitFor(() =>
      expect(engine.calls).toContainEqual({
        method: 'breakpoint.setInteractive',
        params: { enabled: false },
      }),
    );
    await message('rules.save', { rule: { ...rule, enabled: false } });
    await vi.waitFor(() => {
      const synced = engine.calls.filter((call: any) => call.method === 'rules.sync').at(-1);
      expect(synced?.params.rules).toMatchObject([{ id: 'test', enabled: false }]);
    });
    await message('connection.mode', { mode: 'proxy' });
    expect(latest().state.mode).toBe('proxy');
    expect(engine.calls.filter((call: any) => call.method === 'rules.sync')).toHaveLength(2);
  });
});

describe('项目文件与工作区绑定整合', () => {
  it('首次生成稳定 UUID，工作台展示项目文件路径且重新激活复用身份', async () => {
    await open();
    const config = await readProject();
    expect(config).toMatchObject({ version: 1, name: 'project', connection: { mode: 'proxy' } });
    expect(config.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(latest().state.project).toMatchObject({
      id: config.projectId,
      name: 'project',
      configPath: expect.stringContaining('/.api-mocks/project.json'),
      rulesPath: expect.stringContaining('/.api-mocks/rules.json'),
    });
    expect(fake.engines[0].starts[0].storagePath).toBe(await privateStorage());
    await deactivate();
    await activateCurrent();
    expect((await readProject()).projectId).toBe(config.projectId);
    expect(fake.engines.at(-1).starts[0].storagePath).toBe(await privateStorage());
  });

  it('连接和规则保存至项目文件，本机文件只保存设备信息', async () => {
    await open();
    await message('rules.save', { rule });
    await message('connection.mode', { mode: 'vm' });
    expect(JSON.parse(await readFile(rulesFile(), 'utf8')).rules).toEqual([rule]);
    expect((await readProject()).connection).toMatchObject({ mode: 'vm', connectionHost: '127.0.0.1' });
    expect(JSON.parse(await readFile(join(await privateStorage(), 'connection.json'), 'utf8'))).toEqual({
      androidDevices: [],
    });
    await expect(readFile(join(await privateStorage(), 'rules.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('项目配置和规则入口在编辑器打开对应文件', async () => {
    await open();
    await message('project.open', { kind: 'config' });
    await message('project.open', { kind: 'rules' });
    expect(fake.shownDocuments.map((file) => file.slice(file.indexOf('/.api-mocks/')))).toEqual([
      '/.api-mocks/project.json',
      '/.api-mocks/rules.json',
    ]);
  });

  it('显式读取外部规则后同步引擎，配置变更保持当前会话并提示重载', async () => {
    await open();
    const external = { ...rule, id: 'external', name: 'external' };
    await writeFile(rulesFile(), JSON.stringify({ version: 1, rules: [external] }));
    await writeProject({ connection: { mode: 'vm' }, settings: { autoStart: false } });
    await message('project.reload');
    expect(latest().state.rules).toEqual([external]);
    expect(
      fake.engines[0].calls.filter((call: any) => call.method === 'rules.sync').at(-1).params.rules,
    ).toEqual([external]);
    expect(latest().state.mode).toBe('proxy');
    expect(latest().state.project.notice).toContain('重新加载窗口');
    await deactivate();
    await activateCurrent();
    await open();
    expect(latest().state.mode).toBe('vm');
    expect(fake.engines.at(-1).starts).toHaveLength(0);
  });

  it('外部修改规则后拒绝旧内存覆盖，读取后允许继续编辑', async () => {
    await open();
    const external = { ...rule, id: 'external', name: 'external' };
    await writeFile(rulesFile(), JSON.stringify({ version: 1, rules: [external] }));
    const previousSyncs = fake.engines[0].calls.filter((call: any) => call.method === 'rules.sync').length;
    await message('rules.save', { rule });
    expect(latest().state.lastError).toContain('读取项目文件');
    expect(JSON.parse(await readFile(rulesFile(), 'utf8')).rules).toEqual([external]);
    expect(fake.engines[0].calls.filter((call: any) => call.method === 'rules.sync')).toHaveLength(
      previousSyncs,
    );
    await message('project.reload');
    await message('rules.save', { rule });
    expect(JSON.parse(await readFile(rulesFile(), 'utf8')).rules).toEqual([external, rule]);
  });

  it('项目采集设置优先于 IDE 默认值，未指定参数仍使用默认值', async () => {
    await deactivate();
    await writeProject({
      connection: { mode: 'proxy', configuredPort: 19090 },
      settings: { autoStart: false, retentionDays: 14, maxRecords: 42 },
    });
    fake.engines = [];
    await activateCurrent();
    await open();
    const engine = fake.engines[0];
    expect(engine.starts[0]).toMatchObject({
      preferredPort: 19090,
      settings: { retentionDays: 14, maxRecords: 42, maxBodyBytes: 1048576, breakpointTimeout: 60 },
    });
    expect(engine.calls.some((call: any) => call.method === 'proxy.start')).toBe(false);
    fake.configurationListener({ affectsConfiguration: () => true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.calls.some((call: any) => call.method === 'proxy.start')).toBe(false);
  });

  it('相同 UUID 的多根目录分别读取规则并使用独立历史目录', async () => {
    await deactivate();
    const config = await readProject();
    fake.extraWorkspace = join(directory, 'copy');
    await mkdir(join(fake.extraWorkspace, '.api-mocks'), { recursive: true });
    await writeFile(
      join(fake.extraWorkspace, 'pubspec.yaml'),
      'dependencies:\n  flutter:\n    sdk: flutter\n',
    );
    await writeFile(projectFile(fake.extraWorkspace), JSON.stringify(config));
    const copiedRule = { ...rule, id: 'copied' };
    await writeFile(rulesFile(fake.extraWorkspace), JSON.stringify({ version: 1, rules: [copiedRule] }));
    fake.engines = [];
    await activateCurrent();
    expect(fake.engines).toHaveLength(2);
    const original = fake.engines.find((engine) =>
      engine.starts[0].storagePath.endsWith(workspaceHash(fake.workspace)),
    );
    const copy = fake.engines.find((engine) => engine !== original);
    expect(original.starts[0].storagePath).toBe(await privateStorage());
    expect(copy.starts[0].storagePath).toBe(await privateStorage(fake.extraWorkspace));
    expect(original.starts[0].storagePath).not.toBe(copy.starts[0].storagePath);
    expect(original.calls.find((call: any) => call.method === 'rules.sync').params.rules).toEqual([]);
    expect(copy.calls.find((call: any) => call.method === 'rules.sync').params.rules).toEqual([copiedRule]);
    fake.selectedWorkspace = fake.extraWorkspace;
    await open();
    expect(latest().state.project.id).toBe(config.projectId);
    expect(latest().state.rules).toEqual([copiedRule]);
  });

  it('旧 VM SQLite 迁移后历史备注、标签与独立目录仍可查询且保留源文件', async () => {
    await deactivate();
    await writeProject({ connection: { mode: 'vm' } });
    await rm(await privateStorage(), { recursive: true });
    const { VmHistoryStore } = await import('../src/vm/storage');
    const old = new VmHistoryStore(legacyStorage(), { retentionDays: 7, maxRecords: 10000 });
    const request = {
      method: 'GET',
      url: 'https://example.test/migrated',
      headers: [] as [string, string][],
      body: '',
      bodyEncoding: 'text' as const,
      bodyBytes: 0,
      truncated: false,
      editable: true,
    };
    const response = { ...request, status: 200, body: '{"migrated":true}' };
    await old.init();
    await old.put({
      id: 'migrated',
      startedAt: Date.now(),
      duration: 2,
      method: 'GET',
      host: 'example.test',
      path: '/migrated',
      url: request.url,
      targetUrl: request.url,
      originalRequest: request,
      request,
      originalResponse: response,
      response,
      mocked: false,
      source: 'vm',
      note: '',
      tags: [],
    });
    await old.update('migrated', '迁移备注', ['migration']);
    await old.close();
    fake.engines = [];
    await activateCurrent();
    await open();
    await message('history.query');
    expect(latest().state.history.total).toBe(1);
    expect(latest().state.apis).toMatchObject([
      { method: 'GET', host: 'example.test', path: '/migrated', count: 1 },
    ]);
    await message('history.select', { id: 'migrated' });
    const selected = () =>
      fake.panels
        .at(-1)
        .webview.messages.findLast((item: any) => item.type === 'state' && item.selected?.id === 'migrated')
        ?.selected;
    await vi.waitFor(() => expect(selected()).toBeDefined());
    expect(selected()).toMatchObject({
      id: 'migrated',
      note: '迁移备注',
      tags: ['migration'],
      response: { body: '{"migrated":true}' },
    });
    expect(await readFile(join(legacyStorage(), 'vm-history.sqlite3'))).toBeInstanceOf(Buffer);
    expect(fake.engines[0].starts).toHaveLength(0);
  });
});

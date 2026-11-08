import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  rejectSync: false,
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
      isTrusted: true,
      get workspaceFolders() {
        return [{ name: 'project', uri: uri(fake.workspace) }];
      },
      getConfiguration: () => ({ get: (_key: string, value: unknown) => value }),
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
      showWarningMessage: async () => undefined,
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
  return fake.panels[0];
}
async function message(action: string, payload: unknown = {}) {
  const panel = fake.panels[0];
  const count = panel.webview.messages.length;
  panel.receive({ action, payload });
  await vi.waitFor(() => expect(panel.webview.messages.length).toBeGreaterThan(count));
  await new Promise((r) => setTimeout(r, 5));
}
function latest() {
  return fake.panels[0].webview.messages.filter((m: any) => m.type === 'state').at(-1);
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'api-mocks-extension-'));
  fake.workspace = join(directory, 'project');
  fake.storage = join(directory, 'storage');
  fake.commands.clear();
  fake.panels = [];
  fake.engines = [];
  fake.runtime.cached = '/fake/mitmdump';
  fake.runtime.download = undefined;
  fake.rejectSync = false;
  activate({
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
  it('初始化只启动暂停引擎，显式启动停止时调用流量 RPC', async () => {
    await open();
    const engine = fake.engines[0];
    expect(engine.starts[0].startPaused).toBe(true);
    expect(latest().state.proxyActive).toBe(false);
    await fake.commands.get('flutterApiMocks.start')?.();
    expect(engine.calls.some((c: any) => c.method === 'proxy.start')).toBe(true);
    expect(latest().state.proxyActive).toBe(true);
    await fake.commands.get('flutterApiMocks.stop')?.();
    expect(engine.calls.some((c: any) => c.method === 'proxy.stop')).toBe(true);
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
  it('下载中关闭工作台不会在下载完成后启动遗留引擎', async () => {
    fake.runtime.cached = undefined;
    let resolve!: (value: string) => void;
    fake.runtime.download = new Promise((r) => (resolve = r));
    const panel = await open();
    panel.receive({ action: 'install', payload: {} });
    await vi.waitFor(() => expect(latest().state.busy).toBe(true));
    panel.close();
    resolve('/fake/downloaded');
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.engines[0].starts).toHaveLength(0);
  });
});

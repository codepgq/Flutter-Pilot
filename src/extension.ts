import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineManager } from './engine';
import { RuntimeManager } from './runtime';
import { RuleStore } from './store';
import {
  HistoryEntry,
  HistoryQuery,
  HistoryResult,
  PendingBreakpoint,
  Rule,
  WorkbenchState,
  ruleFromHistory,
  validateRuleDocument,
} from './model';
import * as setup from './setup';
import * as devices from './devices';

let active: Workbench | undefined;
let output: vscode.OutputChannel;
const previewDocuments = new Map<string, string>();
export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Flutter API Mocks');
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('api-mocks-preview', {
      provideTextDocumentContent: (uri) => previewDocuments.get(uri.toString()) ?? '',
    }),
  );
  const open = async () => {
    if (active) {
      active.reveal();
      return active;
    }
    if (process.platform !== 'darwin') throw new Error('首版支持 macOS 本地桌面 IDE。');
    if (vscode.env.remoteName) throw new Error('首版暂不支持远程扩展宿主，请在本机打开 Flutter 项目。');
    if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，再启动调试代理。');
    const folders = vscode.workspace.workspaceFolders?.filter((f) => f.uri.scheme === 'file') ?? [];
    if (!folders.length) throw new Error('请先打开本地 Flutter 项目文件夹。');
    const folder =
      folders.length === 1
        ? folders[0]
        : (
            await vscode.window.showQuickPick(
              folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
              { title: '选择本次 API Mock 工作区' },
            )
          )?.folder;
    if (!folder) return;
    const wb = new Workbench(context, folder, () => {
      if (active === wb) active = undefined;
    });
    active = wb;
    try {
      await wb.initialize();
      return wb;
    } catch (error) {
      wb.report(error);
      return wb;
    }
  };
  const command = (name: string, fn: () => Promise<unknown>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(name, () =>
        fn().catch((error) => vscode.window.showErrorMessage(messageOf(error))),
      ),
    );
  command('flutterApiMocks.open', open);
  command('flutterApiMocks.start', async () => {
    const wb = await open();
    await wb?.start();
  });
  command('flutterApiMocks.stop', async () => {
    if (active) await active.stop();
  });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  status.text = '$(radio-tower) API Mocks';
  status.tooltip = '打开 Flutter API 调试工作台';
  status.command = 'flutterApiMocks.open';
  status.show();
  context.subscriptions.push(status);
  context.subscriptions.push({
    dispose: () => {
      void active?.dispose();
    },
  });
}
export async function deactivate() {
  await active?.dispose();
  await devices.cleanupAndroidReverses().catch(() => undefined);
}
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

class Workbench {
  private readonly engine = new EngineManager();
  private readonly runtime: RuntimeManager;
  private readonly store: RuleStore;
  private readonly panel: vscode.WebviewPanel;
  private readonly storage: string;
  private rules: Rule[] = [];
  private pending = new Map<string, PendingBreakpoint>();
  private history: HistoryResult = { items: [], total: 0 };
  private selected?: HistoryEntry;
  private sentSelected?: HistoryEntry;
  private sentPreview?: setup.SetupPreview;
  private apis: WorkbenchState['apis'] = [];
  private query: HistoryQuery = { limit: 30, offset: 0 };
  private proxyActive = false;
  private lan = false;
  private connectionHost = '127.0.0.1';
  private addresses = devices.discoverConnectionAddresses();
  private discovered: devices.Device[] = [];
  private logs: string[] = [];
  private busy = 0;
  private lastError?: string;
  private ruleSyncError?: string;
  private inspection?: setup.FlutterInspection;
  private preview?: setup.SetupPreview;
  private disposed = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private historyTimer?: ReturnType<typeof setTimeout>;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private ruleRevision = 0;
  private ownedReverses: Array<{ serial: string; port: number }> = [];
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly onDispose: () => void,
  ) {
    this.storage = join(
      context.globalStorageUri.fsPath,
      'workspaces',
      createHash('sha256').update(folder.uri.toString()).digest('hex').slice(0, 24),
    );
    this.store = new RuleStore(this.storage);
    this.runtime = new RuntimeManager(
      context.globalStorageUri.fsPath,
      join(context.extensionPath, 'resources', 'engine-manifest.json'),
    );
    this.panel = vscode.window.createWebviewPanel(
      'flutterApiMocks',
      'Flutter API Mocks',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    );
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      void this.dispose();
    });
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      this.messageQueue = this.messageQueue
        .then(() => this.handle(message as Record<string, unknown>))
        .catch((e) => this.report(e));
    });
    this.runtime.on('progress', (text: string) => {
      this.log(text);
    });
    this.engine.on('log', (text: string) => this.log(text));
    this.engine.on('status', (state) => {
      this.proxyActive = state.proxyActive;
      if (state.status !== 'running') this.pending.clear();
      if (state.error) this.lastError = state.error;
      this.push();
    });
    this.engine.on('event', (event: { event: string; data: unknown }) => this.onEvent(event));
  }
  reveal() {
    this.panel.reveal();
  }
  private config() {
    return vscode.workspace.getConfiguration('flutterApiMocks', this.folder.uri);
  }
  private log(text: string) {
    const clean = String(text).slice(0, 4000);
    output.appendLine(clean);
    this.logs = [...this.logs.slice(-99), clean];
    if (!this.eventTimer)
      this.eventTimer = setTimeout(() => {
        this.eventTimer = undefined;
        this.push();
      }, 100);
  }
  report(error: unknown) {
    this.lastError = messageOf(error);
    this.log(this.lastError);
    this.push();
  }
  private push() {
    if (this.disposed) return;
    const state: WorkbenchState = {
      rules: this.rules,
      history: this.history,
      apis: this.apis,
      pending: [...this.pending.values()],
      engine: this.engine.state,
      proxyActive: this.proxyActive,
      lan: this.lan,
      addresses: this.addresses,
      devices: this.discovered as unknown as WorkbenchState['devices'],
      connectionHost: this.connectionHost,
      workspace: this.folder.uri.fsPath,
      logs: this.logs,
      busy: this.busy > 0,
      lastError: this.lastError,
      setup: this.inspection,
      ruleSyncError: this.ruleSyncError,
    };
    const message: Record<string, unknown> = { type: 'state', state };
    if (this.sentSelected !== this.selected) {
      message.selected = this.selected ?? null;
      this.sentSelected = this.selected;
    }
    if (this.sentPreview !== this.preview) {
      message.preview = this.preview
        ? {
            id: this.preview.id,
            files: this.preview.files.map((f) => ({ path: f.path })),
            manualSnippet: this.preview.manualSnippet,
          }
        : null;
      this.sentPreview = this.preview;
    }
    void this.panel.webview.postMessage(message);
  }
  async initialize() {
    await mkdir(this.storage, { recursive: true, mode: 0o700 });
    this.rules = (await this.store.load()).rules;
    this.push();
    const executable = await this.runtime.findExecutable(
      this.config().get<string>('enginePath') || undefined,
    );
    if (executable) {
      await this.ensureEngine(executable);
      await this.reloadHistory();
    }
    this.push();
  }
  private async ensureEngine(executable?: string) {
    if (this.disposed) throw new Error('工作台已关闭。');
    if (this.engine.state.status === 'running') return;
    const config = this.config();
    const file =
      executable ?? (await this.runtime.ensureExecutable(config.get<string>('enginePath') || undefined));
    if (this.disposed) throw new Error('工作台已关闭，未启动代理引擎。');
    await this.engine.start({
      executable: file,
      addonPath: join(this.context.extensionPath, 'proxy', 'addon.py'),
      storagePath: this.storage,
      listenHost: this.lan ? '0.0.0.0' : '127.0.0.1',
      preferredPort: config.get<number>('proxyPort', 8080),
      settings: {
        retentionDays: config.get<number>('retentionDays', 7),
        maxRecords: config.get<number>('maxRecords', 10000),
        maxBodyBytes: config.get<number>('maxBodyBytes', 1048576),
        breakpointTimeout: config.get<number>('breakpointTimeout', 60),
      },
      startPaused: true,
    });
    if (this.disposed) {
      await this.engine.stop();
      return;
    }
    await this.syncRules();
    await this.health();
  }
  private async health() {
    const h = await this.engine.rpc<{ proxyActive: boolean; caCertPath?: string }>('health', {});
    this.proxyActive = h.proxyActive;
    this.push();
    return h;
  }
  private async syncRules() {
    try {
      await this.engine.rpc('rules.sync', { version: 1, rules: this.rules, revision: ++this.ruleRevision });
      this.ruleSyncError = undefined;
    } catch (e) {
      this.ruleSyncError = `已保存，但未生效：${messageOf(e)}`;
      throw e;
    }
  }
  async start() {
    await this.operation(async () => {
      await this.ensureEngine();
      await this.engine.rpc('proxy.start', {});
      await this.health();
      this.log(`代理已启动：${this.connectionHost}:${this.engine.state.proxyPort}`);
      await this.reloadHistory();
    });
  }
  async stop() {
    await this.operation(async () => {
      if (this.engine.state.status === 'running') {
        await this.engine.rpc('breakpoint.releaseAll', {});
        await this.engine.rpc('proxy.stop', {});
        await this.health();
      }
      await this.cleanupReverses();
      this.pending.clear();
      this.log('代理已停止。设备仍配置代理时，请移除代理配置或不携带 API_MOCK_PROXY 参数重启应用。');
    });
  }
  private async cleanupReverses() {
    const entries = this.ownedReverses.splice(0);
    const results = await Promise.allSettled(
      entries.map((x) => devices.removeAndroidReverse(x.serial, x.port)),
    );
    for (let i = 0; i < results.length; i++)
      if (results[i].status === 'rejected') {
        this.ownedReverses.push(entries[i]);
        this.log(`Android 转发清理失败：${entries[i].serial} tcp:${entries[i].port}`);
      }
  }
  private async operation(fn: () => Promise<void>) {
    this.busy++;
    this.lastError = undefined;
    this.push();
    try {
      await fn();
    } finally {
      this.busy--;
      this.push();
    }
  }
  private requireEngine() {
    if (this.engine.state.status !== 'running')
      throw new Error('请先点击“安装 / 初始化引擎”，也可以在设置中指定本地 mitmdump。');
  }
  private async reloadHistory() {
    if (this.engine.state.status !== 'running') return;
    const [history, apis] = await Promise.all([
      this.engine.rpc<HistoryResult>('history.list', this.query),
      this.engine.rpc<{ items: NonNullable<WorkbenchState['apis']> }>('history.apis', {}),
    ]);
    this.history = history;
    this.apis = apis.items;
    this.push();
  }
  private onEvent(event: { event: string; data: unknown }) {
    const d = event.data as Record<string, unknown> | undefined;
    if (event.event === 'control.disconnected') {
      this.pending.clear();
      this.log('控制连接中断，等待中的断点已释放；引擎将自动重连。');
    }
    if (event.event === 'control.connected') {
      void this.health().catch((e) => this.report(e));
    }
    if (event.event === 'status' && d && typeof d.proxyActive === 'boolean') this.proxyActive = d.proxyActive;
    if (event.event === 'breakpoint' && d?.id)
      this.pending.set(String(d.id), d as unknown as PendingBreakpoint);
    if (event.event === 'breakpoint.resolved' && d?.id) this.pending.delete(String(d.id));
    if (event.event === 'history' || event.event === 'history.updated') {
      if (!this.historyTimer)
        this.historyTimer = setTimeout(() => {
          this.historyTimer = undefined;
          void this.reloadHistory().catch((e) => this.report(e));
        }, 300);
    }
    if (event.event === 'log')
      this.log(typeof event.data === 'string' ? event.data : JSON.stringify(event.data));
    this.push();
  }
  private async saveRules(rules: unknown) {
    const document = validateRuleDocument({ version: 1, rules });
    await this.store.save(document);
    this.rules = document.rules;
    if (this.engine.state.status === 'running') await this.syncRules();
    else this.ruleSyncError = '已保存；初始化引擎后生效。';
    this.push();
  }
  private async handle(message: Record<string, unknown>) {
    if (this.disposed) return;
    const action = String(message.action ?? '');
    const payload = (message.payload ?? {}) as Record<string, unknown>;
    if (action === 'ready') {
      this.sentSelected = undefined;
      this.sentPreview = undefined;
      this.push();
      return;
    }
    if (action === 'start') {
      await this.start();
      return;
    }
    if (action === 'stop') {
      await this.stop();
      return;
    }
    await this.operation(async () => {
      switch (action) {
        case 'install':
          await this.ensureEngine();
          await this.reloadHistory();
          break;
        case 'setLan': {
          const enabled = payload.enabled === true;
          if (enabled === this.lan) break;
          const wasActive = this.proxyActive;
          await this.cleanupReverses();
          await this.engine.stop();
          this.proxyActive = false;
          this.pending.clear();
          this.lan = enabled;
          this.addresses = devices.discoverConnectionAddresses();
          this.connectionHost = enabled
            ? (this.addresses.find((a) => a.host !== '127.0.0.1')?.host ?? '127.0.0.1')
            : '127.0.0.1';
          await this.ensureEngine();
          if (wasActive) {
            await this.engine.rpc('proxy.start', {});
            await this.health();
          }
          break;
        }
        case 'selectHost':
          if (this.addresses.some((a) => a.host === payload.host)) this.connectionHost = String(payload.host);
          break;
        case 'devices': {
          const result = await devices.discoverDevices();
          this.discovered = result.devices;
          result.diagnostics.forEach((x) => this.log(x));
          break;
        }
        case 'connectAndroid': {
          this.requireEngine();
          if (!this.proxyActive) throw new Error('请先启动代理。');
          const id = String(payload.id);
          if (!this.discovered.some((d) => d.id === id && d.platform === 'android' && d.state === 'device'))
            throw new Error('请刷新并选择已授权的 Android 设备。');
          const port = this.engine.state.proxyPort!;
          if (await devices.createAndroidReverse(id, port)) this.ownedReverses.push({ serial: id, port });
          this.connectionHost = '127.0.0.1';
          this.log(`Android USB 已连接。运行 Flutter 时添加 --dart-define=API_MOCK_PROXY=127.0.0.1:${port}`);
          break;
        }
        case 'rules.save': {
          const rule = payload.rule as Rule;
          const index = this.rules.findIndex((r) => r.id === rule?.id);
          await this.saveRules(
            index < 0 ? [...this.rules, rule] : this.rules.map((r, i) => (i === index ? rule : r)),
          );
          break;
        }
        case 'rules.toggle':
          await this.saveRules(
            this.rules.map((r) => (r.id === payload.id ? { ...r, enabled: !r.enabled } : r)),
          );
          break;
        case 'rules.delete':
          await this.saveRules(this.rules.filter((r) => r.id !== payload.id));
          break;
        case 'rules.duplicate': {
          const r = this.rules.find((r) => r.id === payload.id);
          if (r)
            await this.saveRules([
              ...this.rules,
              { ...r, id: randomUUID(), name: `${r.name} 副本`, enabled: false },
            ]);
          break;
        }
        case 'rules.move': {
          const list = [...this.rules];
          const i = list.findIndex((r) => r.id === payload.id);
          const next = i + (payload.direction === 'up' ? -1 : 1);
          if (i >= 0 && next >= 0 && next < list.length) {
            [list[i], list[next]] = [list[next], list[i]];
            await this.saveRules(list);
          }
          break;
        }
        case 'rules.import': {
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'API Mock 规则': ['json'] },
            title: '导入规则（以禁用状态追加，保留现有规则）',
          });
          if (!uris?.[0]) break;
          const document = validateRuleDocument(JSON.parse(await readFile(uris[0].fsPath, 'utf8')));
          await this.saveRules([
            ...this.rules,
            ...document.rules.map((r) => ({ ...r, id: randomUUID(), enabled: false })),
          ]);
          break;
        }
        case 'rules.export': {
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(join(this.folder.uri.fsPath, 'api-mocks.rules.json')),
            filters: { 'API Mock 规则': ['json'] },
          });
          if (uri)
            await writeFile(uri.fsPath, JSON.stringify({ version: 1, rules: this.rules }, null, 2), 'utf8');
          break;
        }
        case 'history.query': {
          this.requireEngine();
          const q = payload as HistoryQuery;
          this.query = {
            host: typeof q.host === 'string' ? q.host : undefined,
            path: typeof q.path === 'string' ? q.path : undefined,
            search: typeof q.search === 'string' ? q.search : undefined,
            method: typeof q.method === 'string' ? q.method : undefined,
            status: typeof q.status === 'number' ? q.status : undefined,
            mocked: typeof q.mocked === 'boolean' ? q.mocked : undefined,
            ruleId: typeof q.ruleId === 'string' ? q.ruleId : undefined,
            from: typeof q.from === 'number' ? q.from : undefined,
            to: typeof q.to === 'number' ? q.to : undefined,
            limit: 30,
            offset: typeof q.offset === 'number' ? Math.max(0, Math.trunc(q.offset)) : 0,
          };
          await this.reloadHistory();
          break;
        }
        case 'history.select':
          this.requireEngine();
          this.selected = await this.engine.rpc<HistoryEntry>('history.get', { id: payload.id });
          break;
        case 'history.update':
          this.requireEngine();
          await this.engine.rpc('history.update', { id: payload.id, note: payload.note, tags: payload.tags });
          if (this.selected?.id === payload.id)
            this.selected = await this.engine.rpc<HistoryEntry>('history.get', { id: payload.id });
          await this.reloadHistory();
          break;
        case 'history.delete':
          this.requireEngine();
          await this.engine.rpc('history.delete', { ids: [payload.id] });
          if (this.selected?.id === payload.id) this.selected = undefined;
          await this.reloadHistory();
          break;
        case 'history.clear': {
          this.requireEngine();
          const answer = await vscode.window.showWarningMessage(
            '清空当前工作区所有请求历史？Mock 规则会保留。',
            { modal: true },
            '清空历史',
          );
          if (answer === '清空历史') {
            await this.engine.rpc('history.clear', {});
            this.selected = undefined;
            await this.reloadHistory();
          }
          break;
        }
        case 'history.toRule': {
          this.requireEngine();
          if (!['mock', 'request', 'response', 'redirect'].includes(String(payload.kind)))
            throw new Error('未知规则模板');
          const record = await this.engine.rpc<HistoryEntry>('history.get', { id: payload.id });
          const rule = ruleFromHistory(record, payload.kind as 'mock', randomUUID());
          void this.panel.webview.postMessage({ type: 'editRule', rule });
          break;
        }
        case 'breakpoint.resolve': {
          this.requireEngine();
          if (!this.pending.has(String(payload.id))) throw new Error('断点已结束或客户端已取消。');
          await this.engine.rpc('breakpoint.resolve', {
            id: payload.id,
            action: payload.action,
            patch: payload.patch,
          });
          break;
        }
        case 'setup.inspect':
          this.inspection = await setup.inspectFlutterProject(this.folder.uri.fsPath);
          break;
        case 'setup.preview': {
          this.requireEngine();
          this.inspection = await setup.inspectFlutterProject(this.folder.uri.fsPath);
          const candidate = this.inspection.candidates.find((c) => c.id === payload.id);
          if (!candidate) throw new Error('初始化位置已变化，请重新检测');
          const h = await this.engine.rpc<{ caCertPath: string }>('health', {});
          const pem = await readFile(h.caCertPath, 'utf8');
          this.preview = await setup.prepareSetup(this.folder.uri.fsPath, candidate, pem);
          for (const file of this.preview.files) {
            const before = vscode.Uri.from({
              scheme: 'api-mocks-preview',
              path: `/${this.preview.id}/before/${file.path.split('/').at(-1)}`,
            });
            const after = vscode.Uri.from({
              scheme: 'api-mocks-preview',
              path: `/${this.preview.id}/after/${file.path.split('/').at(-1)}`,
            });
            previewDocuments.set(before.toString(), file.before ?? '');
            previewDocuments.set(after.toString(), file.after);
            await vscode.commands.executeCommand(
              'vscode.diff',
              before,
              after,
              `API Mocks 接入预览 · ${file.path.split('/').at(-1)}`,
            );
          }
          break;
        }
        case 'setup.apply': {
          if (!this.preview || this.preview.id !== payload.id) throw new Error('预览已过期，请重新生成。');
          const dirty = this.preview.files.find((f) =>
            vscode.workspace.textDocuments.some((d) => d.uri.fsPath === f.path && d.isDirty),
          );
          if (dirty) throw new Error(`请先保存 ${dirty.path}，再重新生成预览。`);
          const result = await setup.applySetup(this.preview);
          this.log(`已应用接入配置：${result.files.join('、')}`);
          this.preview = undefined;
          this.inspection = await setup.inspectFlutterProject(this.folder.uri.fsPath);
          break;
        }
        case 'setup.revert': {
          const result = await setup.revertSetup(this.folder.uri.fsPath);
          this.log(
            `接入撤销：${result.reverted.length} 个文件恢复，${result.preserved.length} 个后续编辑的文件保留。`,
          );
          this.preview = undefined;
          this.inspection = await setup.inspectFlutterProject(this.folder.uri.fsPath);
          break;
        }
        case 'ca.open': {
          this.requireEngine();
          const h = await this.engine.rpc<{ caCertPath: string }>('health', {});
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(h.caCertPath));
          break;
        }
        case 'settings.open':
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            '@ext:api-mocks.flutter-api-mocks',
          );
          break;
        case 'log.clear':
          this.logs = [];
          break;
        case 'error.dismiss':
          this.lastError = undefined;
          break;
        default:
          throw new Error(`未知操作：${action}`);
      }
    });
  }
  private html() {
    const nonce = randomBytes(16).toString('base64');
    const script = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const css = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    );
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src ${this.panel.webview.cspSource};script-src 'nonce-${nonce}';font-src ${this.panel.webview.cspSource};img-src ${this.panel.webview.cspSource} data:;"><link rel="stylesheet" href="${css}"><title>Flutter API Mocks</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.historyTimer) clearTimeout(this.historyTimer);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    await this.engine.stop().catch((e) => output.appendLine(messageOf(e)));
    await this.cleanupReverses();
    previewDocuments.clear();
    this.onDispose();
  }
}

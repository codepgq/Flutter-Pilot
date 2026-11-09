import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineManager } from './engine';
import { RuntimeManager } from './runtime';
import { RuleStore } from './store';
import { isFlutterWorkspace } from './discovery';
import { VmSession } from './vm/session';
import { VmUiController } from './vm/ui';
import { McpSessionServer } from './mcp/server';
import { AgentAdapterManager, detectNodeRuntime } from './mcp/adapters';
import { McpNetworkController } from './mcp/network';
import type { McpAgentId, McpScope, McpWorkbenchState } from './mcp/model';
import { homedir } from 'node:os';
import { copyFile, chmod } from 'node:fs/promises';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VmDiscovery, createVscodeDiscoveryHost } from './vm/discovery';
import { VmAutoConnector } from './vm/autoConnect';
import { isWebSocketHandshake } from './vm/profiler';
import { WsRuleStore, validateWsRuleDocument } from './ws/rules';
import type { WsRule, WsMessageQuery } from './ws/model';
import { openProjectBinding, type ProjectBinding, type ProjectSettings } from './project';
import { prepareProjectStorage } from './projectStorage';
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
let status: vscode.StatusBarItem;
let shuttingDown = false;
let lifecycle = 0;
let vmDiscovery: VmDiscovery | undefined;
const sessions = new Map<string, Workbench>();
const previewDocuments = new Map<string, string>();
function updateStatus() {
  if (!status) return;
  const list = [...sessions.values()];
  const running = list.filter((session) => session.recording);
  status.text = running.length
    ? `$(record) API Mocks · ${running.length} 记录中`
    : '$(radio-tower) API Mocks';
  status.tooltip = running.length
    ? running.map((session) => session.summary).join('\n') + '\n点击打开工作台；关闭工作台仍继续记录。'
    : '打开 Flutter API 工作台；连接当前项目的 Flutter VM WS 开始记录。';
}
export async function activate(context: vscode.ExtensionContext) {
  shuttingDown = false;
  const epoch = ++lifecycle;
  output = vscode.window.createOutputChannel('Flutter API Mocks');
  context.subscriptions.push(output);
  // Register debug listeners before any asynchronous workspace initialization.
  vmDiscovery = new VmDiscovery(createVscodeDiscoveryHost(vscode));
  context.subscriptions.push(
    vmDiscovery.subscribe(() => {
      for (const session of sessions.values()) session.updateVmDiscovery();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('api-mocks-preview', {
      provideTextDocumentContent: (uri) => previewDocuments.get(uri.toString()) ?? '',
    }),
  );
  const creating = new Map<string, Promise<Workbench>>();
  async function sessionFor(folder: vscode.WorkspaceFolder): Promise<Workbench> {
    const key = folder.uri.toString();
    const current = sessions.get(key);
    if (current) return current;
    const pending = creating.get(key);
    if (pending) return pending;
    const task = (async () => {
      const legacy = join(
        context.globalStorageUri.fsPath,
        'workspaces',
        createHash('sha256').update(key).digest('hex').slice(0, 24),
      );
      const project = await openProjectBinding(folder.uri.fsPath, legacy);
      const storage = await prepareProjectStorage(context.globalStorageUri.fsPath, key, project.projectId);
      if (
        shuttingDown ||
        epoch !== lifecycle ||
        !vscode.workspace.workspaceFolders?.some((f) => f.uri.toString() === key)
      )
        throw new Error('工作区已关闭，项目会话未启动。');
      const session = new Workbench(context, folder, updateStatus, project, storage);
      sessions.set(key, session);
      session.updateVmDiscovery();
      return session;
    })();
    creating.set(key, task);
    try {
      return await task;
    } finally {
      if (creating.get(key) === task) creating.delete(key);
    }
  }
  const open = async () => {
    if (process.platform !== 'darwin') throw new Error('首版支持 macOS 本地桌面 IDE。');
    if (vscode.env.remoteName) throw new Error('首版暂不支持远程扩展宿主，请在本机打开 Flutter 项目。');
    if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，再启动调试代理。');
    const folders = vscode.workspace.workspaceFolders?.filter((f) => f.uri.scheme === 'file') ?? [];
    void vmDiscovery?.start();
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
    if (!folder || shuttingDown) return;
    const session = await sessionFor(folder);
    active = session;
    await session.reveal();
    return session;
  };
  const command = (name: string, fn: () => Promise<unknown>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(name, () =>
        fn().catch((error) => vscode.window.showErrorMessage(messageOf(error))),
      ),
    );
  command('flutterApiMocks.open', open);
  command('flutterApiMocks.start', async () => {
    const session = await open();
    await session?.start();
  });
  command('flutterApiMocks.stop', async () => {
    // With no panel, stop every background workspace; a selected panel targets its own workspace.
    if (active?.hasPanel) await active.stop();
    else await Promise.all([...sessions.values()].map((session) => session.stop()));
  });
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  status.command = 'flutterApiMocks.open';
  updateStatus();
  status.show();
  context.subscriptions.push(status);
  const discover = async () => {
    if (shuttingDown || process.platform !== 'darwin' || vscode.env.remoteName || !vscode.workspace.isTrusted)
      return;
    const folders = vscode.workspace.workspaceFolders?.filter((f) => f.uri.scheme === 'file') ?? [];
    void vmDiscovery?.start();
    await Promise.all(
      folders.map(async (folder) => {
        try {
          if (
            !(await isFlutterWorkspace(folder.uri.fsPath)) ||
            shuttingDown ||
            !vscode.workspace.workspaceFolders?.some(
              (current) => current.uri.toString() === folder.uri.toString(),
            )
          )
            return;
          const session = await sessionFor(folder);
          await session.initialize();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            output.appendLine(`${folder.name}: ${messageOf(error)}`);
        }
      }),
    );
  };
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void discover();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.removed) {
        const key = folder.uri.toString();
        const session = sessions.get(key);
        sessions.delete(key);
        if (active === session) active = undefined;
        void session?.dispose();
      }
      void discover();
      updateStatus();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      for (const session of sessions.values())
        if (event.affectsConfiguration('flutterApiMocks.autoStart', session.workspaceUri)) {
          void session.applyAutoStart().catch((error) => session.report(error));
        }
      for (const session of sessions.values())
        if (event.affectsConfiguration('flutterApiMocks.autoConnectVm', session.workspaceUri))
          session.updateVmAutoConnect();
    }),
  );
  context.subscriptions.push({
    dispose: () => {
      void deactivate();
    },
  });
  await discover();
}
export async function deactivate() {
  shuttingDown = true;
  lifecycle++;
  vmDiscovery?.dispose();
  vmDiscovery = undefined;
  const current = [...sessions.values()];
  sessions.clear();
  active = undefined;
  await Promise.allSettled(current.map((session) => session.dispose()));
  previewDocuments.clear();
  await devices.cleanupAndroidReverses().catch(() => undefined);
}
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

class Workbench {
  private mode: 'proxy' | 'vm' = 'vm';
  private readonly vm: VmSession;
  private readonly ui: VmUiController;
  private readonly mcpNetwork: McpNetworkController;
  private mcpServer?: McpSessionServer;
  private readonly mcpSessionId = randomUUID();
  private readonly bridgeRoot =
    process.env.API_MOCKS_MCP_ROOT ?? join(homedir(), '.flutter-api-mocks', 'mcp');
  private mcpGeneration = 0;
  private readonly mcpClients = new Map<
    string,
    { name: string; version?: string; lastSeen: number; scope?: McpScope }
  >();
  private mcpState: McpWorkbenchState = {
    enabled: false,
    running: false,
    scope: 'project',
    agents: [],
    clients: [],
    ui: { supported: false, reason: '尚未探测' },
  };
  private readonly vmAuto: VmAutoConnector;
  private initialized = false;
  private readonly engine = new EngineManager();
  private readonly runtime: RuntimeManager;
  private readonly store: RuleStore;
  private readonly wsRules: WsRuleStore;
  private wsPersistentRules: WsRule[] = [];
  private panel?: vscode.WebviewPanel;
  private initialization?: Promise<void>;
  private connectionDevices: string[] = [];
  private preferredPort?: number;
  private readonly projectSettings: ProjectSettings;
  private readonly configuredPort?: number;
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
  private projectNotice?: string;
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
    private readonly onChange: () => void,
    private readonly project: ProjectBinding,
    private readonly storage: string,
  ) {
    this.projectSettings = { ...project.config.settings };
    this.configuredPort = project.config.connection.configuredPort;
    this.store = new RuleStore(project.rulesDirectory);
    this.wsRules = new WsRuleStore(project.rulesDirectory);
    this.vm = new VmSession(
      this.storage,
      {
        retentionDays: this.config().get<number>('retentionDays', 7),
        maxRecords: this.config().get<number>('maxRecords', 10000),
        maxBodyBytes: this.config().get<number>('maxBodyBytes', 1048576),
      },
      join(this.context.extensionPath, 'resources', 'vm', 'interceptor.dart.txt'),
    );
    this.ui = new VmUiController(this.vm.client, {
      templatePath: join(context.extensionPath, 'resources', 'vm', 'ui.dart.txt'),
    });
    this.mcpNetwork = new McpNetworkController({
      httpRulesPath: this.store.file,
      wsRulesPath: this.wsRules.file,
      readHttpRules: async () => (await this.store.load()).rules,
      readWsRules: async () => (await this.wsRules.load()).rules,
      applyHttpRules: async (rules) => {
        this.rules = rules;
        await this.syncSavedRules();
      },
      applyWsRules: async (rules) => {
        this.wsPersistentRules = rules;
        await this.vm.websocket.updateRules([
          ...rules,
          ...this.vm.websocket.state.rules.filter(
            (r) =>
              !!r.match.connectionId &&
              this.vm.websocket.state.connections.some(
                (c) => c.id === r.match.connectionId && c.status === 'open',
              ),
          ),
        ]);
      },
      status: () => ({
        vmConnected: this.vm.state.status === 'connected',
        http: {
          captureEnabled: !!this.vm.state.captureEnabled,
          mockEnabled: this.vm.state.mockEnabled,
          runtimeApplied: this.vm.state.mockEnabled && this.vm.state.instances > 0,
          rules: this.rules.length,
          syncError: this.ruleSyncError,
        },
        ws: {
          captureEnabled: this.vm.websocket.state.captureEnabled,
          mockEnabled: this.vm.websocket.state.mockEnabled,
          runtimeApplied: this.vm.websocket.state.mockEnabled && this.vm.websocket.state.status === 'active',
          rules: this.vm.websocket.state.rules.length,
          syncError: this.vm.websocket.state.ruleSyncError,
        },
      }),
      listHttp: (query) => this.vm.store.list(query),
      getHttp: (id) => this.vm.store.get(id),
      connections: () => this.vm.websocket.store.connections(),
      messages: async (query) => {
        const { includeBodies, ...filters } = query as typeof query & { includeBodies?: boolean };
        const result = await this.vm.websocket.store.list(filters);
        return includeBodies
          ? {
              ...result,
              items: await Promise.all(
                result.items.map(async (item) => ({
                  ...item,
                  ...(await this.vm.websocket.store.get(item.id)),
                })),
              ),
            }
          : result;
      },
      setCapture: (domain, enabled) =>
        domain === 'http' ? this.vm.setCaptureEnabled(enabled) : this.vm.websocket.setCaptureEnabled(enabled),
      setMock: (domain, enabled) =>
        domain === 'http' ? this.vm.setMockEnabled(enabled) : this.vm.websocket.setMockEnabled(enabled),
    });
    this.vm.client.on('disconnected', () => {
      this.ui.invalidate();
      this.mcpState.ui = { supported: false, reason: 'VM 已断开，请连接后重新探测' };
    });
    this.vmAuto = new VmAutoConnector({
      status: () => this.vm.state.status,
      connect: async (url) => {
        await this.vm.connect(url, this.rules);
        await this.reloadHistory().catch((error) => this.report(error));
      },
      disconnect: () => this.vm.disconnect(),
    });
    this.vmAuto.on('change', () => this.push());
    this.vm.on('change', () => {
      this.vmAuto.connectionChanged();
      this.push();
    });
    this.vm.on('history', () => {
      if (this.mode === 'vm' && this.panel && !this.historyTimer)
        this.historyTimer = setTimeout(() => {
          this.historyTimer = undefined;
          void this.reloadHistory().catch((error) => this.report(error));
        }, 300);
    });
    this.runtime = new RuntimeManager(
      context.globalStorageUri.fsPath,
      join(context.extensionPath, 'resources', 'engine-manifest.json'),
    );
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
  get recording() {
    return this.proxyActive || this.vm.state.status === 'connected';
  }
  get hasPanel() {
    return !!this.panel;
  }
  get workspaceUri() {
    return this.folder.uri;
  }
  get summary() {
    if (this.mode === 'vm')
      return `${this.folder.name} · VM ${this.vm.state.endpoint ?? '未连接'}${this.proxyActive ? ' · 代理仍在运行' : ''}`;
    return `${this.folder.name} · ${this.connectionHost}:${this.engine.state.proxyPort ?? 8080}`;
  }
  async reveal() {
    if (this.disposed) return;
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'flutterApiMocks',
      'Flutter API Mocks',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      },
    );
    this.panel = panel;
    this.sentSelected = undefined;
    this.sentPreview = undefined;
    panel.webview.html = this.html();
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.pending.clear();
      void this.enqueue(async () => {
        if (this.engine.state.status === 'running')
          await this.engine.rpc('breakpoint.setInteractive', {
            enabled: this.mode === 'proxy' && !!this.panel,
          });
      }).catch((error) => this.report(error));
      this.onChange();
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (this.panel !== panel || !message || typeof message !== 'object') return;
      const input = message as { action?: string; payload?: { enabled?: boolean } };
      if (input.action === 'mcp.enable' && input.payload?.enabled === false) {
        ++this.mcpGeneration;
        this.ui.invalidate();
        this.mcpState.enabled = false;
      }
      void this.enqueue(() => this.handle(message as Record<string, unknown>)).catch((error) =>
        this.report(error),
      );
    });
    this.push();
    try {
      await this.initialize();
      await this.enqueue(async () => {
        if (this.disposed || this.panel !== panel) return;
        if (this.mode === 'proxy' && this.engine.state.status === 'running') {
          await this.engine.rpc('breakpoint.setInteractive', { enabled: true });
        }
        await this.reloadHistory();
        this.push();
      });
    } catch (error) {
      this.report(error);
    }
  }
  private enqueue(operation: () => Promise<void>) {
    const next = this.messageQueue.then(async () => {
      if (!this.disposed) await operation();
    });
    this.messageQueue = next.catch(() => undefined);
    return next;
  }
  private config() {
    const base = vscode.workspace.getConfiguration('flutterApiMocks', this.folder.uri);
    return {
      get: <T>(key: string, fallback?: T): T => {
        if (Object.prototype.hasOwnProperty.call(this.projectSettings, key))
          return this.projectSettings[key as keyof ProjectSettings] as T;
        if (key === 'proxyPort' && this.configuredPort !== undefined) return this.configuredPort as T;
        return base.get<T>(key, fallback as T);
      },
    };
  }
  updateVmDiscovery() {
    if (this.disposed || !vmDiscovery) return;
    const snapshot = vmDiscovery.snapshot();
    this.vmAuto.setAvailability(
      snapshot.status === 'starting' ? 'waiting' : snapshot.status,
      snapshot.message,
    );
    this.vmAuto.setCandidates(
      snapshot.candidates
        .filter((candidate) => candidate.workspaceId === this.folder.uri.toString())
        .flatMap((candidate) => {
          const url = vmDiscovery?.address(candidate.id);
          return url ? [{ ...candidate, url }] : [];
        }),
    );
  }
  updateVmAutoConnect() {
    this.vmAuto.setMode(this.mode);
    this.vmAuto.setEnabled(this.initialized && this.config().get<boolean>('autoConnectVm', true));
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
    this.onChange();
    if (this.disposed || !this.panel) return;
    const state: WorkbenchState = {
      mode: this.mode,
      vm: { ...this.vm.state },
      vmDiscovery: this.vmAuto.snapshot,
      ws: { ...this.vm.websocket.state },
      mcp: this.mcpState,
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
      project: {
        id: this.project.projectId,
        name: this.project.config.name,
        configPath: this.project.file,
        rulesPath: this.store.file,
        notice: this.projectNotice,
      },
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
  initialize(): Promise<void> {
    if (!this.initialization)
      this.initialization = this.initializeSession().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    return this.initialization;
  }
  private async initializeSession() {
    await mkdir(this.storage, { recursive: true, mode: 0o700 });
    this.rules = (await this.store.load()).rules;
    this.wsPersistentRules = (await this.wsRules.load()).rules;
    await this.vm.websocket.updateRules(this.wsPersistentRules);
    await this.vm.websocket.init();
    // Existing HTTP facts stay intact; only positively identified upgrade records are projected.
    for (let offset = 0; offset < 100000; offset += 100) {
      const old = await this.vm.store.list({ status: 101, limit: 100, offset }, false);
      for (const entry of old.items) {
        if (entry && isWebSocketHandshake(entry)) await this.vm.websocket.addHandshake(entry);
      }
      if (offset + old.items.length >= old.total) break;
    }
    const connection = this.project.config.connection;
    this.mode = connection.mode;
    this.vmAuto.setMode(this.mode);
    this.lan = connection.lan === true;
    if (connection.connectionHost && this.addresses.some((a) => a.host === connection.connectionHost))
      this.connectionHost = this.lan ? connection.connectionHost : '127.0.0.1';
    this.preferredPort = connection.port;
    try {
      const savedMcp = JSON.parse(await readFile(join(this.storage, 'mcp.json'), 'utf8'));
      if (savedMcp.enabled === true) await this.setMcpEnabled(true, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.log('MCP 设置或服务恢复失败，请在 MCP 页面重新开启。');
    }
    try {
      const saved = JSON.parse(await readFile(join(this.storage, 'connection.json'), 'utf8'));
      if (Array.isArray(saved.androidDevices))
        this.connectionDevices = saved.androidDevices.filter((id: unknown) => typeof id === 'string');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.log(`连接设置读取失败：${messageOf(error)}`);
    }
    this.push();
    if (this.mode === 'vm') {
      await this.vm.store.init();
      await this.reloadHistory();
      this.log(
        'VM 模式已就绪：自动发现本项目的 Flutter Debug 会话，也可手动输入 VM WS。地址仅在本次会话使用。',
      );
      this.initialized = true;
      this.updateVmAutoConnect();
      return;
    }
    const executable = await this.runtime.findExecutable(
      this.config().get<string>('enginePath') || undefined,
    );
    if (executable) {
      await this.ensureEngine(executable);
      if (this.config().get<boolean>('autoStart', true)) await this.startInternal();
      if (this.panel) await this.reloadHistory();
    } else this.log('首次使用请打开工作台安装引擎并完成 Flutter 接入，之后打开项目即可后台自动记录。');
    this.initialized = true;
    this.updateVmAutoConnect();
    this.push();
  }
  async applyAutoStart() {
    await this.initialize();
    if (this.mode === 'vm') return;
    if (!this.config().get<boolean>('autoStart', true)) {
      await this.stop();
      return;
    }
    await this.enqueue(async () => {
      const executable = await this.runtime.findExecutable(
        this.config().get<string>('enginePath') || undefined,
      );
      if (executable) {
        await this.ensureEngine(executable);
        await this.startInternal();
      }
    });
  }
  private async saveConnection() {
    await this.project.saveConnection({
      mode: this.mode,
      lan: this.lan,
      configuredPort: this.config().get<number>('proxyPort', 8080),
      connectionHost: this.connectionHost,
      port: this.engine.state.proxyPort ?? this.preferredPort,
    });
    await mkdir(this.storage, { recursive: true, mode: 0o700 });
    await writeFile(
      join(this.storage, 'connection.json'),
      JSON.stringify(
        {
          androidDevices: this.connectionDevices,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  private async restoreAndroidConnections() {
    if (!this.connectionDevices.length) return;
    const discovered = await devices.discoverDevices();
    this.discovered = discovered.devices;
    for (const serial of this.connectionDevices) {
      if (
        !discovered.devices.some(
          (device) => device.id === serial && device.platform === 'android' && device.state === 'device',
        )
      )
        continue;
      const port = this.engine.state.proxyPort!;
      try {
        if (await devices.createAndroidReverse(serial, port)) this.ownedReverses.push({ serial, port });
      } catch (error) {
        this.log(`Android USB 恢复失败：${messageOf(error)}`);
      }
    }
  }
  private async startInternal() {
    if (this.disposed) return;
    await this.engine.rpc('proxy.start', {});
    await this.health();
    this.preferredPort = this.engine.state.proxyPort;
    await this.saveConnection();
    await this.restoreAndroidConnections();
    this.log(`后台自动记录已启动：${this.connectionHost}:${this.engine.state.proxyPort}`);
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
      preferredPort: this.preferredPort ?? config.get<number>('proxyPort', 8080),
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
    await this.engine.rpc('breakpoint.setInteractive', { enabled: this.mode === 'proxy' && !!this.panel });
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
    await this.initialize();
    if (this.mode === 'vm') throw new Error('VM 模式请在“连接与诊断”输入本次 Flutter VM WS 并点击连接。');
    await this.enqueue(() =>
      this.operation(async () => {
        await this.ensureEngine();
        await this.startInternal();
        if (this.panel) await this.reloadHistory();
      }),
    );
  }
  async stop() {
    await this.initialize();
    await this.enqueue(() =>
      this.operation(async () => {
        await this.vmAuto.manualDisconnect();
        await this.stopInternal();
      }),
    );
  }
  private async stopInternal() {
    if (this.engine.state.status === 'running') {
      await this.engine.rpc('breakpoint.releaseAll', {});
      await this.engine.rpc('proxy.stop', {});
      await this.health();
    }
    await this.cleanupReverses();
    this.pending.clear();
    this.log('代理已停止。设备仍配置代理时，请移除代理配置或不携带 API_MOCK_PROXY 参数重启应用。');
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
  private requireHistory() {
    if (this.mode === 'proxy') this.requireEngine();
  }
  private async historyCall<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.mode === 'proxy') return this.engine.rpc<T>(method, params);
    const db = this.vm.store;
    let result: unknown;
    switch (method) {
      case 'history.list':
        result = await db.list(params as HistoryQuery);
        break;
      case 'history.apis':
        result = { items: await db.apis() };
        break;
      case 'history.get':
        result = await db.get(String(params.id));
        break;
      case 'history.update':
        result = await db.update(String(params.id), String(params.note ?? ''), params.tags as string[]);
        break;
      case 'history.delete':
        result = await db.delete(params.ids as string[]);
        break;
      case 'history.clear':
        result = await db.clear();
        break;
      case 'api.delete':
        result = await db.deleteApi(String(params.method), String(params.host), String(params.path));
        break;
      default:
        throw new Error('VM 模式不支持此操作');
    }
    return result as T;
  }
  private async reloadHistory() {
    if (this.mode === 'proxy' && this.engine.state.status !== 'running') return;
    const [history, apis] = await Promise.all([
      this.historyCall<HistoryResult>('history.list', { ...this.query }),
      this.historyCall<{ items: NonNullable<WorkbenchState['apis']> }>('history.apis', {}),
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
      void this.health()
        .then(async () => {
          if (this.engine.state.status === 'running')
            await this.engine.rpc('breakpoint.setInteractive', {
              enabled: this.mode === 'proxy' && !!this.panel,
            });
        })
        .catch((e) => this.report(e));
    }
    if (event.event === 'status' && d && typeof d.proxyActive === 'boolean') this.proxyActive = d.proxyActive;
    if (event.event === 'breakpoint' && d?.id)
      this.pending.set(String(d.id), d as unknown as PendingBreakpoint);
    if (event.event === 'breakpoint.resolved' && d?.id) this.pending.delete(String(d.id));
    if (
      (event.event === 'history' || event.event === 'history.updated' || event.event === 'api.updated') &&
      this.panel &&
      this.mode === 'proxy'
    ) {
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
    await this.project.reload();
    const disk = await this.store.load();
    if (JSON.stringify(disk.rules) !== JSON.stringify(this.rules))
      throw new Error('项目规则文件已被修改，请先在“连接与诊断”点击“读取项目文件”，再编辑规则。');
    await this.store.save(document);
    this.rules = document.rules;
    await this.syncSavedRules();
  }
  private async saveWsRules(rules: unknown) {
    const document = validateWsRuleDocument({ version: 1, rules });
    for (const rule of document.rules) {
      if (
        rule.match.connectionId &&
        !this.vm.websocket.state.connections.some(
          (connection) =>
            connection.id === rule.match.connectionId &&
            connection.status === 'open' &&
            connection.capture === 'attached',
        )
      )
        throw new Error('临时 WS 规则只能绑定当前已接入的在线连接');
    }
    const persistent = document.rules.filter((rule) => !rule.match.connectionId);
    await this.wsRules.save(persistent, this.wsPersistentRules);
    this.wsPersistentRules = persistent;
    await this.vm.websocket.updateRules(document.rules);
  }
  private async syncSavedRules() {
    if (this.mode === 'vm') {
      try {
        const results = await Promise.allSettled([
          this.vm.updateRules(this.rules),
          ...(this.engine.state.status === 'running' ? [this.syncRules()] : []),
        ]);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        this.ruleSyncError = this.vm.state.mockEnabled
          ? undefined
          : '已保存；连接 VM 并开启实验性 Dio Mock 后生效。';
      } catch (error) {
        this.ruleSyncError = `已保存，但运行中的会话未全部确认生效：${messageOf(error)}`;
        throw error;
      }
    } else if (this.engine.state.status === 'running') await this.syncRules();
    else this.ruleSyncError = '已保存；初始化引擎后生效。';
    this.push();
  }
  private adapters() {
    return new AgentAdapterManager({
      workspace: this.folder.uri.fsPath,
      bridgeRoot: this.bridgeRoot,
      nodePath: this.mcpState.nodePath,
    });
  }
  private async inspectMcp(scope: McpScope = 'project') {
    this.mcpState.nodePath = await detectNodeRuntime(this.mcpState.nodePath);
    const manager = this.adapters();
    const states = await manager.all(scope);
    this.mcpState.scope = scope;
    this.mcpState.agents = states.map((item) => ({
      ...item,
      configPath: item.path,
      connected:
        item.configured &&
        !item.shadowed &&
        this.mcpState.clients.some(
          (client) => client.scope === scope && this.clientMatches(item.agent, client.name),
        ),
    }));
    this.push();
  }
  private clientMatches(agent: McpAgentId, name: string) {
    if (agent === 'claude') return /claude/i.test(name);
    if (agent === 'codex-app') return /^codex[-_ ](?:app|desktop|vscode)$/i.test(name);
    return /^codex[-_ ]cli$/i.test(name);
  }
  private async publishBridge() {
    await mkdir(this.bridgeRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(this.bridgeRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('MCP 私有目录必须为普通目录');
    await chmod(this.bridgeRoot, 0o700);
    const temp = join(this.bridgeRoot, `bridge-${randomUUID()}.tmp`);
    await copyFile(join(this.context.extensionPath, 'dist', 'mcp-bridge.cjs'), temp);
    await chmod(temp, 0o600);
    await rename(temp, join(this.bridgeRoot, 'bridge.cjs'));
  }
  private async verifyBridge() {
    const node = await detectNodeRuntime(this.mcpState.nodePath);
    if (!node) throw new Error('未找到 Node.js 20+，请安装后重新适配');
    this.mcpState.nodePath = node;
    const client = new McpClient({ name: 'flutter-api-mocks-selftest', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: node,
      args: [
        join(this.bridgeRoot, 'bridge.cjs'),
        '--registry',
        join(this.bridgeRoot, 'sessions'),
        '--workspace',
        this.folder.uri.fsPath,
      ],
      stderr: 'pipe',
    });
    try {
      await client.connect(transport, { timeout: 10000 });
      const result = await client.callTool({ name: 'list_sessions', arguments: {} }, undefined, {
        timeout: 10000,
      });
      const sessions = (result.structuredContent as { sessions?: { sessionId?: string }[] } | undefined)
        ?.sessions;
      if (result.isError || !sessions?.some((item) => item.sessionId === this.mcpSessionId))
        throw new Error('MCP 桥接自检失败');
    } finally {
      await client.close();
    }
  }
  private async setMcpEnabled(enabled: boolean, persist = true) {
    ++this.mcpGeneration;
    this.ui.invalidate();
    this.mcpState.error = undefined;
    this.mcpState.enabled = enabled;
    if (this.mcpServer) await this.mcpServer.stop();
    this.mcpServer = undefined;
    this.mcpState.running = false;
    this.mcpClients.clear();
    this.mcpState.clients = [];
    if (enabled) {
      try {
        await this.publishBridge();
        const epoch = this.mcpGeneration;
        this.mcpServer = new McpSessionServer({
          registryRoot: join(this.bridgeRoot, 'sessions'),
          workspace: this.folder.uri.fsPath,
          sessionId: this.mcpSessionId,
          name: this.project.config.name,
          describe: () => ({
            vmConnected: this.vm.state.status === 'connected',
            capabilities: { ui: this.mcpState.ui, network: true },
          }),
          call: async (tool, args, context) => {
            const run = this.messageQueue.then(async () => {
              if (
                this.disposed ||
                context.signal.aborted ||
                epoch !== this.mcpGeneration ||
                !this.mcpState.enabled
              )
                return { ok: false, code: 'SESSION_INVALIDATED', message: 'MCP 会话已关闭，操作未执行。' };
              if (
                [
                  'get_ui_snapshot',
                  'find_widget',
                  'tap',
                  'enter_text',
                  'scroll',
                  'wait_for_widget',
                  'inspect_key_issues',
                ].includes(tool)
              ) {
                const typed = (value: unknown) => ({
                  type: typeof value === 'number' ? 'int' : 'string',
                  value,
                });
                const input = {
                  ...args,
                  ...(args.key !== undefined ? { key: typed(args.key) } : {}),
                  ...(args.ancestorKey !== undefined ? { ancestor: typed(args.ancestorKey) } : {}),
                  ...(args.targetKey !== undefined ? { targetKey: typed(args.targetKey) } : {}),
                };
                const cancel = () => this.ui.invalidate();
                context.signal.addEventListener('abort', cancel, { once: true });
                let result;
                try {
                  result = await this.ui.execute(tool, input);
                } finally {
                  context.signal.removeEventListener('abort', cancel);
                }
                if (result.ok) this.mcpState.ui = { supported: true };
                this.push();
                return result;
              }
              try {
                return await this.mcpNetwork.execute(tool, args);
              } finally {
                this.push();
              }
            });
            this.messageQueue = run.then(
              () => undefined,
              () => undefined,
            );
            return run;
          },
          onClient: (client) => {
            if (epoch !== this.mcpGeneration || /selftest/i.test(client.name)) return;
            if (client.event === 'disconnected') this.mcpClients.delete(client.connectionId);
            else
              this.mcpClients.set(client.connectionId, {
                name: client.name,
                version: client.version,
                scope: client.scope,
                lastSeen: Date.now(),
              });
            this.mcpState.clients = [...this.mcpClients.values()];
            this.mcpState.agents = this.mcpState.agents.map((agent) => ({
              ...agent,
              connected:
                agent.configured &&
                !agent.shadowed &&
                this.mcpState.clients.some(
                  (item) => item.scope === agent.scope && this.clientMatches(agent.agent, item.name),
                ),
            }));
            this.push();
          },
        });
        await this.mcpServer.start();
        this.mcpState.running = true;
      } catch (error) {
        this.mcpState.error = messageOf(error);
        this.mcpState.enabled = false;
        await this.mcpServer?.stop();
        this.mcpServer = undefined;
        throw error;
      } finally {
        this.push();
      }
    }
    if (persist) {
      const temp = join(this.storage, `mcp-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify({ enabled: this.mcpState.enabled }), { mode: 0o600 });
      await rename(temp, join(this.storage, 'mcp.json'));
    }
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
    await this.initialize();
    if (action === 'start') {
      if (this.mode === 'vm') throw new Error('请输入 Flutter VM WS 并点击“连接 VM”。');
      await this.operation(async () => {
        await this.ensureEngine();
        await this.startInternal();
        await this.reloadHistory();
      });
      return;
    }
    if (action === 'stop') {
      await this.operation(() => this.stopInternal());
      return;
    }
    await this.operation(async () => {
      switch (action) {
        case 'mcp.enable':
          await this.setMcpEnabled(payload.enabled === true);
          break;
        case 'mcp.inspect':
          await this.inspectMcp(payload.scope === 'global' ? 'global' : 'project');
          break;
        case 'mcp.probe':
          this.mcpState.ui = await this.ui.probe();
          break;
        case 'mcp.adapt': {
          const agent = String(payload.agent) as McpAgentId;
          if (!['claude', 'codex-cli', 'codex-app'].includes(agent)) throw new Error('未知 Agent');
          const scope = payload.scope === 'global' ? 'global' : 'project';
          if (!this.mcpState.enabled) await this.setMcpEnabled(true);
          const current = await this.adapters().inspect(agent, scope);
          if (current.status === 'conflict' && payload.repair !== true) {
            this.mcpState.notice = current.message;
            await this.inspectMcp(scope);
            break;
          }
          const result = await this.adapters().adapt(agent, scope, payload.repair === true);
          if (result.configured) await this.verifyBridge();
          this.mcpState.notice =
            result.message + (result.configured ? ' 桥接握手自检通过；等待目标客户端实际加载。' : '');
          await this.inspectMcp(scope);
          break;
        }
        case 'mcp.remove': {
          const agent = String(payload.agent) as McpAgentId;
          if (!['claude', 'codex-cli', 'codex-app'].includes(agent)) throw new Error('未知 Agent');
          const scope = payload.scope === 'global' ? 'global' : 'project';
          const result = await this.adapters().remove(agent, scope);
          this.mcpState.notice = result.message;
          await this.inspectMcp(scope);
          break;
        }
        case 'mcp.config.open': {
          const agent = String(payload.agent) as McpAgentId;
          if (!['claude', 'codex-cli', 'codex-app'].includes(agent)) throw new Error('未知 Agent');
          const path = this.adapters().configPath(agent, payload.scope === 'global' ? 'global' : 'project');
          await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
          break;
        }
        case 'ws.capture':
          if (this.mode !== 'vm') throw new Error('WS 采集仅支持 VM 模式');
          await this.vm.websocket.setCaptureEnabled(payload.enabled === true);
          break;
        case 'ws.mock':
          await this.vm.websocket.setMockEnabled(payload.enabled === true);
          break;
        case 'ws.rescan':
          await this.vm.websocket.rescan();
          break;
        case 'ws.query': {
          const query: WsMessageQuery = { limit: 30, offset: Number(payload.offset) || 0 };
          if (typeof payload.connectionId === 'string' && payload.connectionId)
            query.connectionId = payload.connectionId;
          if (payload.direction === 'inbound' || payload.direction === 'outbound')
            query.direction = payload.direction;
          if (typeof payload.search === 'string') query.search = payload.search.slice(0, 1000);
          await this.vm.websocket.refresh(query);
          break;
        }
        case 'ws.select': {
          const selected = await this.vm.websocket.store.get(String(payload.id));
          void this.panel?.webview.postMessage({ type: 'ws.detail', message: selected ?? null });
          break;
        }
        case 'ws.push':
          if (typeof payload.text !== 'string') throw new Error('推送正文必须为文本');
          await this.vm.websocket.push(String(payload.connectionId), payload.text);
          break;
        case 'ws.clear': {
          const confirmed = await vscode.window.showWarningMessage(
            '清空 WS 消息历史？此操作不关闭连接或删除规则。',
            { modal: true },
            '清空',
          );
          if (confirmed === '清空') {
            await this.vm.websocket.store.clear(
              typeof payload.connectionId === 'string' ? payload.connectionId : undefined,
            );
            await this.vm.websocket.refresh();
            void this.panel?.webview.postMessage({ type: 'ws.detail', message: null });
          }
          break;
        }
        case 'ws.rules.open':
          await vscode.window.showTextDocument(vscode.Uri.file(this.wsRules.file), { preview: false });
          break;
        case 'ws.rules.save': {
          const rule = payload.rule as WsRule;
          const current = this.vm.websocket.state.rules;
          await this.saveWsRules(
            current.some((r) => r.id === rule?.id)
              ? current.map((r) => (r.id === rule?.id ? rule : r))
              : [...current, rule],
          );
          break;
        }
        case 'ws.rules.toggle':
          await this.saveWsRules(
            this.vm.websocket.state.rules.map((r) =>
              r.id === payload.id ? { ...r, enabled: !r.enabled } : r,
            ),
          );
          break;
        case 'ws.rules.delete':
          await this.saveWsRules(this.vm.websocket.state.rules.filter((r) => r.id !== payload.id));
          break;
        case 'ws.rules.duplicate': {
          const rule = this.vm.websocket.state.rules.find((r) => r.id === payload.id);
          if (!rule) throw new Error('WS 规则不存在');
          await this.saveWsRules([
            ...this.vm.websocket.state.rules,
            { ...structuredClone(rule), id: randomUUID(), name: `${rule.name}（副本）`, enabled: false },
          ]);
          break;
        }
        case 'ws.rules.move': {
          const rules = [...this.vm.websocket.state.rules].sort((a, b) => b.priority - a.priority);
          const i = rules.findIndex((r) => r.id === payload.id);
          const target = i + (payload.delta === -1 ? -1 : 1);
          if (i >= 0 && target >= 0 && target < rules.length) {
            [rules[i], rules[target]] = [rules[target], rules[i]];
            await this.saveWsRules(rules.map((r, index) => ({ ...r, priority: rules.length - index })));
          }
          break;
        }
        case 'project.open': {
          await this.project.reload();
          const file = payload.kind === 'rules' ? this.store.file : this.project.file;
          await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
          break;
        }
        case 'project.reload': {
          await this.project.reload();
          this.projectSettings.autoConnectVm = this.project.config.settings?.autoConnectVm;
          if (this.projectSettings.autoConnectVm === undefined) delete this.projectSettings.autoConnectVm;
          this.updateVmAutoConnect();
          const reload = await this.mcpNetwork.reload();
          if (!reload.ok) throw new Error('部分规则读取或同步失败，请检查项目规则文件');
          this.projectNotice =
            '项目文件已读取，规则和 VM 自动连接设置已同步；接入方式和采集参数的变更在重新加载窗口后生效。';
          break;
        }
        case 'connection.mode': {
          const mode = payload.mode === 'vm' ? 'vm' : 'proxy';
          if (mode === this.mode) break;
          if (mode === 'proxy') {
            this.vmAuto.setMode('proxy');
            await this.vm.disconnect();
            if (this.engine.state.status === 'running') await this.syncRules();
          }
          if (this.engine.state.status === 'running')
            await this.engine.rpc('breakpoint.setInteractive', { enabled: mode === 'proxy' && !!this.panel });
          this.mode = mode;
          this.updateVmAutoConnect();
          this.selected = undefined;
          this.query = { limit: 30, offset: 0 };
          this.history = { items: [], total: 0 };
          this.apis = [];
          if (mode === 'vm') await this.vm.store.init();
          await this.saveConnection();
          await this.reloadHistory();
          break;
        }
        case 'vm.connect':
          if (this.mode !== 'vm') throw new Error('请先切换到 VM 连接模式');
          if (this.vm.state.status !== 'disconnected')
            throw new Error('VM 已连接或正在连接，请先断开当前连接后再更换地址。');
          await this.vmAuto.manualConnect();
          await this.vm.connect(String(payload.url ?? ''), this.rules);
          await this.reloadHistory();
          break;
        case 'vm.discovery.connect':
          if (this.mode !== 'vm') throw new Error('请先切换到 VM 连接模式');
          await this.vmAuto.select(String(payload.id ?? ''));
          break;
        case 'vm.disconnect':
          await this.vmAuto.manualDisconnect();
          break;
        case 'vm.mock':
          await this.vm.setMockEnabled(payload.enabled === true);
          this.ruleSyncError = this.vm.state.mockEnabled ? undefined : '规则已保存；仅采集模式不执行 Mock。';
          break;
        case 'vm.rescan':
          await this.vm.rescan();
          this.ruleSyncError = undefined;
          break;
        case 'proxy.stop':
          await this.stopInternal();
          break;
        case 'install':
          await this.ensureEngine();
          if (this.config().get<boolean>('autoStart', true)) await this.startInternal();
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
          await this.saveConnection();
          break;
        }
        case 'selectHost':
          if (this.addresses.some((a) => a.host === payload.host)) {
            this.connectionHost = String(payload.host);
            await this.saveConnection();
          }
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
          if (!this.connectionDevices.includes(id)) this.connectionDevices.push(id);
          await this.saveConnection();
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
          this.requireHistory();
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
        case 'api.delete': {
          this.requireHistory();
          const { method, host, path } = payload;
          if ([method, host, path].some((value) => typeof value !== 'string'))
            throw new Error('API 标识无效');
          const answer = await vscode.window.showWarningMessage(
            `从 API 目录移除 ${method} ${host}${path}？请求历史会保留，之后再次调用会重新发现。`,
            { modal: true },
            '移除 API',
          );
          if (answer === '移除 API') {
            await this.historyCall('api.delete', { method, host, path });
            await this.reloadHistory();
          }
          break;
        }
        case 'history.select':
          this.requireHistory();
          this.selected = await this.historyCall<HistoryEntry>('history.get', { id: payload.id });
          break;
        case 'history.update':
          this.requireHistory();
          await this.historyCall('history.update', {
            id: payload.id,
            note: payload.note,
            tags: payload.tags,
          });
          if (this.selected?.id === payload.id)
            this.selected = await this.historyCall<HistoryEntry>('history.get', { id: payload.id });
          await this.reloadHistory();
          break;
        case 'history.delete':
          this.requireHistory();
          await this.historyCall('history.delete', { ids: [payload.id] });
          if (this.selected?.id === payload.id) this.selected = undefined;
          await this.reloadHistory();
          break;
        case 'history.clear': {
          this.requireHistory();
          const answer = await vscode.window.showWarningMessage(
            '清空当前工作区所有请求历史？Mock 规则会保留。',
            { modal: true },
            '清空历史',
          );
          if (answer === '清空历史') {
            await this.historyCall('history.clear', {});
            this.selected = undefined;
            await this.reloadHistory();
          }
          break;
        }
        case 'history.toRule': {
          this.requireHistory();
          if (!['mock', 'request', 'response', 'redirect'].includes(String(payload.kind)))
            throw new Error('未知规则模板');
          const record = await this.historyCall<HistoryEntry>('history.get', { id: payload.id });
          const rule = ruleFromHistory(record, payload.kind as 'mock', randomUUID());
          void this.panel?.webview.postMessage({ type: 'editRule', rule });
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
    const script = this.panel!.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const css = this.panel!.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    );
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src ${this.panel!.webview.cspSource};script-src 'nonce-${nonce}';font-src ${this.panel!.webview.cspSource};img-src ${this.panel!.webview.cspSource} data:;"><link rel="stylesheet" href="${css}"><title>Flutter API Mocks</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.mcpGeneration;
    this.ui.invalidate();
    await this.mcpServer?.stop().catch(() => undefined);
    await this.ui.dispose();
    this.vmAuto.dispose();
    if (this.historyTimer) clearTimeout(this.historyTimer);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    await this.vm.dispose().catch((e) => output.appendLine(messageOf(e)));
    await this.engine.stop().catch((e) => output.appendLine(messageOf(e)));
    await this.cleanupReverses();
    this.panel?.dispose();
    this.panel = undefined;
    this.onChange();
  }
}

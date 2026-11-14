import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Scene, SceneDocument } from '../src/scene-model';
import { discoverSessions, requestSession } from '../src/mcp/server';
const fake = vi.hoisted(() => ({
  commands: new Map<string, () => Promise<unknown>>(),
  executedCommands: [] as string[],
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
  dartApi: undefined as any,
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
    extensions: { getExtension: () => (fake.dartApi ? { activate: async () => fake.dartApi } : undefined) },
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
      executeCommand: async (name: string) => {
        fake.executedCommands.push(name);
        return fake.commands.get(name)?.();
      },
    },
    window: {
      registerTreeDataProvider: () => ({ dispose() {} }),
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showErrorMessage: vi.fn(),
      showWarningMessage: async () => fake.confirm,
      showQuickPick: async (items: any[]) =>
        items.find((item) => item.folder.uri.fsPath === fake.selectedWorkspace) ?? items[0],
      showTextDocument: async (uri: any) => {
        fake.shownDocuments.push(uri.fsPath);
      },
      createWebviewPanel: (_type: string, _title: string, _column: number, options: unknown) => {
        const panel = {
          options,
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
      if (method === 'history.apis') return { items: [], total: 0 };
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
  await fake.commands.get('flutterPilot.open')?.();
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
function latestSelected() {
  return fake.panels
    .at(-1)
    .webview.messages.findLast((message: any) => message.type === 'state' && 'selected' in message)?.selected;
}

describe('Scene 操作与业务测试扩展整合', () => {
  const actionScene: Scene = {
    id: 'operations',
    name: '公共操作',
    httpRules: [],
    wsRules: [],
    targets: { confirm: { key: 'confirm' }, login: { key: 'login' } },
    actions: [
      {
        id: 'submit',
        name: '提交操作',
        inputs: { price: { required: true } },
        steps: [{ id: 'confirm', type: 'tap', target: 'confirm' }],
      },
    ],
  };
  const sceneDocument: SceneDocument = { version: 1, activeSceneId: null, scenes: [actionScene] };
  async function saveScenes(document: SceneDocument = sceneDocument) {
    await writeFile(rulesFile(), JSON.stringify(document));
    await message('project.reload');
  }
  async function enable() {
    await open();
    await message('mcp.enable', { enabled: true });
    return vi.waitFor(async () => {
      const descriptors = await discoverSessions(join(directory, 'bridge', 'sessions'), fake.workspace);
      expect(descriptors).toHaveLength(1);
      return descriptors[0];
    });
  }
  async function call(descriptor: any, tool: string, args: Record<string, unknown> = {}) {
    return (await requestSession(descriptor, {
      kind: 'call',
      tool,
      args: { sessionId: descriptor.sessionId, ...args },
    })) as any;
  }
  it('discovers Scene actions, ignores legacy files, and opens scenes for repair', async () => {
    const descriptor = await enable();
    const legacy = join(fake.workspace, '.flutter-pilot', 'workflows.json');
    await writeFile(legacy, '{legacy must remain untouched');
    const tests = await call(descriptor, 'list_tests');
    expect(tests.tests).toEqual([]);
    const status = await call(descriptor, 'get_network_status');
    expect(status.files).toMatchObject({ scenes: await realpath(rulesFile()), tests: tests.files.tests });
    expect(status.files).not.toHaveProperty('workflows');
    await saveScenes();
    const actions = await call(descriptor, 'list_scene_actions', { sceneId: 'operations' });
    expect(actions.actions).toMatchObject([{ id: 'submit', inputs: { price: { required: true } } }]);
    expect(actions).not.toHaveProperty('httpRules');
    const summaries = await call(descriptor, 'list_scenes');
    expect(JSON.stringify(summaries)).toContain('submit');
    await writeFile(rulesFile(), '{broken');
    await message('project.reload');
    expect((await call(descriptor, 'list_scene_actions', { sceneId: 'operations' })).actions).toHaveLength(1);
    await message('scenes.open');
    expect(fake.shownDocuments).toContain(await realpath(rulesFile()));
    expect(await readFile(rulesFile(), 'utf8')).toBe('{broken');
    expect(await readFile(legacy, 'utf8')).toBe('{legacy must remain untouched');
  });
  it('redacts secret defaults in posted Scene state while preserving the execution snapshot', async () => {
    const { AutomationController } = await import('../src/automation/controller');
    const execute = vi
      .spyOn(AutomationController.prototype, 'executeWorkflow')
      .mockResolvedValue({ ok: true });
    try {
      const descriptor = await enable();
      const secret = 'configured-secret-default';
      const document = structuredClone(sceneDocument);
      document.scenes[0].actions = [
        {
          id: 'login',
          name: '登录',
          inputs: { password: { secret: true, required: true, default: secret } },
          steps: [{ id: 'password', type: 'enter_text', target: 'login', text: '${inputs.password}' }],
        },
      ];
      await saveScenes(document);
      expect(latest().state.scenes.scenes[0].actions[0].inputs.password).toEqual({
        secret: true,
        required: true,
        default: '[REDACTED]',
      });
      expect(JSON.stringify(latest().state)).not.toContain(secret);
      const started = await call(descriptor, 'run_scene_action', {
        sceneId: 'operations',
        actionId: 'login',
      });
      await vi.waitFor(async () =>
        expect((await call(descriptor, 'get_scene_action_run', { runId: started.runId })).run.status).toBe(
          'completed',
        ),
      );
      expect(execute.mock.calls[0][2].text).toBe(secret);
      expect(JSON.stringify(latest().state)).not.toContain(secret);
      expect(
        JSON.parse(await readFile(rulesFile(), 'utf8')).scenes[0].actions[0].inputs.password.default,
      ).toBe(secret);
    } finally {
      execute.mockRestore();
    }
  });
  it('keeps an asynchronously started workflow alive after the start socket closes and cancels without replay', async () => {
    const { AutomationController } = await import('../src/automation/controller');
    const spy = vi
      .spyOn(AutomationController.prototype, 'executeWorkflow')
      .mockImplementation(async (_owner, _tool, _args, signal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { ok: false, code: 'CANCELLED', uncertain: true };
      });
    try {
      const descriptor = await enable();
      await saveScenes();
      const start = await call(descriptor, 'run_scene_action', {
        sceneId: 'operations',
        actionId: 'submit',
        inputs: { price: '1.2300' },
      });
      expect(start.runId).toBeTypeOf('string');
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      expect((await call(descriptor, 'get_scene_action_run', { runId: start.runId })).run.status).toBe(
        'running',
      );
      expect((await call(descriptor, 'tap', { selector: { key: 'other' } })).code).toBe('WORKFLOW_BUSY');
      await message('scenes.actions.cancel', { runId: start.runId });
      await vi.waitFor(async () =>
        expect((await call(descriptor, 'get_scene_action_run', { runId: start.runId })).run.status).toBe(
          'uncertain',
        ),
      );
      expect(latest().state.sceneActions.locked).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('reuses a public action against the current Mock, freezes definitions until reload, and locks mutations', async () => {
    const { AutomationController } = await import('../src/automation/controller');
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const action = vi
      .spyOn(AutomationController.prototype, 'executeWorkflow')
      .mockImplementation(async () => {
        await gate;
        return { ok: true };
      });
    try {
      const descriptor = await enable();
      const doc: SceneDocument = {
        ...sceneDocument,
        scenes: [actionScene, { id: 'business', name: '业务 Mock', httpRules: [], wsRules: [] }],
      };
      await saveScenes(doc);
      await call(descriptor, 'activate_scene', { sceneId: 'business' });
      expect(action).not.toHaveBeenCalled();
      // Saving to disk does not change the loaded action until reload_rules.
      const edited = structuredClone(doc);
      edited.activeSceneId = 'business';
      edited.scenes[0].targets!.confirm.key = 'edited-confirm';
      await writeFile(rulesFile(), JSON.stringify(edited));
      const start = await call(descriptor, 'run_scene_action', {
        sceneId: 'operations',
        actionId: 'submit',
        inputs: { price: '1' },
      });
      await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
      expect(action.mock.calls[0][2].selector).toEqual({ key: 'confirm' });
      expect((await call(descriptor, 'get_scene_action_run', { runId: start.runId })).run).toMatchObject({
        sceneId: 'operations',
        actionId: 'submit',
        mockSceneId: 'business',
      });
      for (const [tool, args] of [
        ['reload_rules', {}],
        ['activate_scene', { sceneId: 'operations' }],
        ['deactivate_scene', {}],
        ['set_capture_enabled', { domain: 'http', enabled: false }],
        ['inject_ws_message', { connectionId: 'socket', text: '{}' }],
        ['send_ws_message', { connectionId: 'socket', text: '{}' }],
      ] as const)
        expect(await call(descriptor, tool, args)).toMatchObject({ ok: false, code: 'WORKFLOW_BUSY' });
      await expect(
        call(descriptor, 'run_scene_action', {
          sceneId: 'operations',
          actionId: 'submit',
          inputs: { price: '1' },
        }),
      ).rejects.toHaveProperty('code', 'WORKFLOW_BUSY');
      const engine = fake.engines[0];
      const starts = engine.calls.filter((item: any) => item.method === 'proxy.start').length;
      for (const event of [
        'project.reload',
        'install',
        'scenes.deactivate',
        'connectAndroid',
        'selectHost',
      ]) {
        await message(event);
        expect(latest().state.lastError).toContain('运行期间');
      }
      await fake.commands.get('flutterPilot.start')?.();
      fake.configurationListener({ affectsConfiguration: () => true });
      await vi.waitFor(() => expect(latest().state.lastError).toContain('运行期间'));
      expect(engine.calls.filter((item: any) => item.method === 'proxy.start')).toHaveLength(starts);
      finish();
      await vi.waitFor(async () =>
        expect((await call(descriptor, 'get_scene_action_run', { runId: start.runId })).run.status).toBe(
          'completed',
        ),
      );
      expect((await call(descriptor, 'list_scenes')).activeSceneId).toBe('business');
      expect((await call(descriptor, 'reload_rules')).loaded).toBe(true);
      expect(action).toHaveBeenCalledTimes(1);
      const next = await call(descriptor, 'run_scene_action', {
        sceneId: 'operations',
        actionId: 'submit',
        inputs: { price: '1' },
      });
      await vi.waitFor(async () =>
        expect((await call(descriptor, 'get_scene_action_run', { runId: next.runId })).run.status).toBe(
          'completed',
        ),
      );
      expect(action.mock.calls[1][2].selector).toEqual({ key: 'edited-confirm' });
      expect((await call(descriptor, 'list_scenes')).activeSceneId).toBe('business');
    } finally {
      finish?.();
      action.mockRestore();
    }
  });
  it('never replays saved actions during activation, reload, reconnection or IDE restoration', async () => {
    const { AutomationController } = await import('../src/automation/controller');
    const action = vi
      .spyOn(AutomationController.prototype, 'executeWorkflow')
      .mockResolvedValue({ ok: true });
    try {
      const descriptor = await enable();
      await saveScenes();
      await call(descriptor, 'activate_scene', { sceneId: 'operations' });
      await call(descriptor, 'reload_rules');
      expect(action).not.toHaveBeenCalled();
      const started = await call(descriptor, 'run_scene_action', {
        sceneId: 'operations',
        actionId: 'submit',
        inputs: { price: '1' },
      });
      await vi.waitFor(async () =>
        expect((await call(descriptor, 'get_scene_action_run', { runId: started.runId })).run.status).toBe(
          'completed',
        ),
      );
      const engine = fake.engines[0];
      engine.emit('event', { event: 'control.disconnected' });
      engine.emit('event', { event: 'ready' });
      await call(descriptor, 'reload_rules');
      await deactivate();
      await activateCurrent();
      await open();
      expect(latest().state.scenes.activeSceneId).toBe('operations');
      expect(latest().state.sceneActions.run).toBeUndefined();
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      action.mockRestore();
    }
  });
  it('fails an offline Test Run before UI execution, preserves the saved Scene and releases its owner', async () => {
    const descriptor = await enable();
    await saveScenes();
    await writeFile(
      join(fake.workspace, '.flutter-pilot', 'tests.json'),
      JSON.stringify({
        version: 2,
        tests: [
          {
            id: 'submit_test',
            name: '提交测试',
            action: { sceneId: 'operations', actionId: 'submit' },
            inputs: { price: '1.2300' },
            expect: { ui: [{ id: 'pending', selector: { key: 'pending' }, state: 'visible' }] },
          },
        ],
      }),
    );
    const before = await readFile(rulesFile(), 'utf8');
    const start = await call(descriptor, 'run_test', { testId: 'submit_test' });
    await vi.waitFor(async () => {
      const { run } = await call(descriptor, 'get_test_run', { runId: start.runId });
      expect(run.status).toBe('error');
      expect(run.failure.code).toBe('TEST_VM_REQUIRED');
      expect(run.steps).toEqual([]);
    });
    expect(latest().state.tests.locked).toBe(false);
    expect(await readFile(rulesFile(), 'utf8')).toBe(before);
  });
  it('locks the test environment while waiting to acquire automation, before temporary Mock setup', async () => {
    const { AutomationController } = await import('../src/automation/controller');
    const originalAcquire = AutomationController.prototype.acquireWorkflow;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const acquire = vi
      .spyOn(AutomationController.prototype, 'acquireWorkflow')
      .mockImplementationOnce(async function (this: any, owner) {
        await gate;
        await originalAcquire.call(this, owner);
      });
    try {
      const descriptor = await enable();
      await saveScenes();
      await writeFile(
        join(fake.workspace, '.flutter-pilot', 'tests.json'),
        JSON.stringify({
          version: 2,
          tests: [
            {
              id: 'waiting',
              name: '等待设备锁',
              action: { sceneId: 'operations', actionId: 'submit' },
              inputs: { price: '1.00' },
              expect: { ui: [{ id: 'visible', selector: { key: 'result' }, state: 'visible' }] },
            },
          ],
        }),
      );
      const before = await readFile(rulesFile(), 'utf8');
      const started = await call(descriptor, 'run_test', { testId: 'waiting' });
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(latest().state.tests).toMatchObject({ running: true, locked: true, cleanupPending: [] });
      for (const [tool, args] of [
        ['activate_scene', { sceneId: 'operations' }],
        ['deactivate_scene', {}],
        ['reload_rules', {}],
        ['set_capture_enabled', { domain: 'http', enabled: true }],
        ['inject_ws_message', { connectionId: 'socket', text: '{}' }],
        ['send_ws_message', { connectionId: 'socket', text: '{}' }],
      ] as const)
        expect(await call(descriptor, tool, args)).toMatchObject({ ok: false, code: 'TEST_BUSY' });
      for (const event of ['scenes.activate', 'project.reload', 'connectAndroid', 'selectHost']) {
        await message(event, { id: 'operations', host: '127.0.0.1' });
        expect(latest().state.lastError).toContain('测试环境尚未释放');
      }
      expect(await readFile(rulesFile(), 'utf8')).toBe(before);
      expect((await call(descriptor, 'list_scenes')).activeSceneId).toBe(null);
      await call(descriptor, 'cancel_test_run', { runId: started.runId });
      resume();
      await vi.waitFor(async () =>
        expect((await call(descriptor, 'get_test_run', { runId: started.runId })).run.status).toBe(
          'cancelled',
        ),
      );
      expect(latest().state.tests.locked).toBe(false);
    } finally {
      resume();
      acquire.mockRestore();
    }
  });
  it.each(['command', 'autoStart'] as const)(
    'rechecks environment ownership when queued %s starts',
    async (source) => {
      const { WorkflowController } = await import('../src/workflows/controller');
      const { AutomationController } = await import('../src/automation/controller');
      const descriptor = await enable();
      await saveScenes();
      await fake.commands.get('flutterPilot.stop')?.();
      const engine = fake.engines[0];
      engine.state.status = 'stopped';
      const starts = engine.starts.length;
      const vscode = await import('vscode');
      vi.mocked(vscode.window.showErrorMessage).mockClear();
      const originalStart = WorkflowController.prototype.start;
      let resumePreflight!: () => void;
      let finishAction!: () => void;
      const preflight = new Promise<void>((resolve) => {
        resumePreflight = resolve;
      });
      const actionGate = new Promise<void>((resolve) => {
        finishAction = resolve;
      });
      const read = vi.spyOn(WorkflowController.prototype, 'start').mockImplementationOnce(async function (
        this: any,
        ...args
      ) {
        await preflight;
        return originalStart.apply(this, args);
      });
      const action = vi
        .spyOn(AutomationController.prototype, 'executeWorkflow')
        .mockImplementation(async () => {
          await actionGate;
          return { ok: true };
        });
      try {
        const pending = call(descriptor, 'run_scene_action', {
          sceneId: 'operations',
          actionId: 'submit',
          inputs: { price: '1.00' },
        });
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        const queued = source === 'command' ? fake.commands.get('flutterPilot.start')?.() : undefined;
        if (source === 'autoStart')
          fake.configurationListener({
            affectsConfiguration: (key: string) => key === 'flutterPilot.autoStart',
          });
        // Let the public entry point complete initialization and enqueue behind preflight.
        await new Promise((resolve) => setTimeout(resolve, 0));
        resumePreflight();
        const started = await pending;
        await queued;
        await vi.waitFor(() => {
          if (source === 'command')
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('运行期间'));
          else expect(latest().state.lastError).toContain('运行期间');
        });
        expect(engine.starts).toHaveLength(starts);
        finishAction();
        await vi.waitFor(async () =>
          expect((await call(descriptor, 'get_scene_action_run', { runId: started.runId })).run.status).toBe(
            'completed',
          ),
        );
      } finally {
        resumePreflight();
        finishAction();
        read.mockRestore();
        action.mockRestore();
      }
    },
  );
  it('retains failed cleanup for a same-run retry without replaying its Workflow', async () => {
    const { VmSession } = await import('../src/vm/session');
    const { AutomationController } = await import('../src/automation/controller');
    const { SceneController } = await import('../src/scene-controller');
    const { TestNetworkObserver } = await import('../src/testing/network');
    const connect = vi.spyOn(VmSession.prototype, 'connect').mockImplementation(async function (this: any) {
      this.state.status = 'connected';
      this.state.isolates = 1;
      this.emit('change');
    });
    const capture = vi.spyOn(VmSession.prototype, 'setCaptureEnabled').mockImplementation(async function (
      this: any,
      enabled,
    ) {
      this.state.captureEnabled = enabled;
    });
    const action = vi
      .spyOn(AutomationController.prototype, 'executeWorkflow')
      .mockResolvedValue({ ok: true });
    const baseline = vi
      .spyOn(TestNetworkObserver.prototype, 'baseline')
      .mockImplementation(async () => ({ at: Date.now(), httpIds: [], wsIds: [] }));
    const restore = SceneController.prototype.endRun;
    const cleanup = vi.spyOn(SceneController.prototype, 'endRun').mockImplementationOnce(async () => {
      throw new Error('temporary cleanup failure');
    });
    try {
      const descriptor = await enable();
      await message('connection.mode', { mode: 'vm' });
      await message('vm.connect', { url: 'ws://127.0.0.1:12345/ws' });
      await saveScenes();
      await writeFile(
        join(fake.workspace, '.flutter-pilot', 'tests.json'),
        JSON.stringify({
          version: 2,
          tests: [
            {
              id: 'cleanup',
              name: '环境恢复',
              action: { sceneId: 'operations', actionId: 'submit' },
              inputs: { price: '1.00' },
              expect: { ui: [{ id: 'visible', selector: { key: 'result' }, state: 'visible' }] },
            },
          ],
        }),
      );
      const start = await call(descriptor, 'run_test', { testId: 'cleanup' });
      await vi.waitFor(async () =>
        expect((await call(descriptor, 'get_test_run', { runId: start.runId })).run.status).toBe('error'),
      );
      const actionsBeforeCleanup = action.mock.calls.length;
      expect(actionsBeforeCleanup).toBeGreaterThan(0);
      expect(latest().state.tests.cleanupPending).toEqual([start.runId]);
      expect((await call(descriptor, 'get_test_run', { runId: start.runId })).run.cleanup.status).toBe(
        'failed',
      );
      const external = vi.spyOn(AutomationController.prototype, 'execute').mockResolvedValue({ ok: true });
      try {
        await expect(call(descriptor, 'tap', { key: 'confirm' })).rejects.toMatchObject({
          code: 'TEST_CLEANUP_REQUIRED',
        });
        expect(external).not.toHaveBeenCalled();
      } finally {
        external.mockRestore();
      }
      cleanup.mockImplementation(restore);
      await call(descriptor, 'cancel_test_run', { runId: start.runId });
      expect(action).toHaveBeenCalledTimes(actionsBeforeCleanup);
      expect(latest().state.tests.cleanupPending).toEqual([]);
      expect((await call(descriptor, 'get_test_run', { runId: start.runId })).run.status).toBe('error');
      expect(capture).toHaveBeenLastCalledWith(false);
    } finally {
      connect.mockRestore();
      capture.mockRestore();
      action.mockRestore();
      baseline.mockRestore();
      cleanup.mockRestore();
    }
  });
  it.each(['workflow', 'test'] as const)(
    'rejects a pending %s launch when MCP is disabled during preflight',
    async (kind) => {
      const { WorkflowController } = await import('../src/workflows/controller');
      const { TestStore } = await import('../src/testing/store');
      const { AutomationController } = await import('../src/automation/controller');
      await enable();
      const document = {
        version: 2,
        tests: [
          {
            id: 'test',
            name: '取消预检',
            action: { sceneId: 'operations', actionId: 'submit' },
            inputs: { price: '1.00' },
            expect: { ui: [{ id: 'visible', selector: { key: 'result' }, state: 'visible' }] },
          },
        ],
      };
      await saveScenes();
      await writeFile(join(fake.workspace, '.flutter-pilot', 'tests.json'), JSON.stringify(document));
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const originalStart = WorkflowController.prototype.start;
      const read =
        kind === 'workflow'
          ? vi.spyOn(WorkflowController.prototype, 'start')
          : vi.spyOn(TestStore.prototype, 'read');
      (read as any).mockImplementationOnce(async function (this: any, ...args: any[]) {
        await gate;
        return kind === 'workflow' ? originalStart.apply(this, args as any) : document;
      });
      const action = vi
        .spyOn(AutomationController.prototype, 'executeWorkflow')
        .mockResolvedValue({ ok: true });
      try {
        const panel = fake.panels.at(-1);
        panel.receive({
          action: kind === 'workflow' ? 'scenes.actions.run' : 'tests.run',
          payload:
            kind === 'workflow'
              ? { sceneId: 'operations', actionId: 'submit', inputs: { price: '1.00' } }
              : { testId: 'test' },
        });
        await vi.waitFor(() => expect(read).toHaveBeenCalled());
        panel.receive({ action: 'mcp.enable', payload: { enabled: false } });
        resume();
        await vi.waitFor(() =>
          expect(latest().state[kind === 'workflow' ? 'sceneActions' : 'tests'].run?.failure?.code).toBe(
            'SESSION_INVALIDATED',
          ),
        );
        expect(action).not.toHaveBeenCalled();
        expect(latest().state[kind === 'workflow' ? 'sceneActions' : 'tests'].locked).toBe(false);
      } finally {
        resume();
        read.mockRestore();
        action.mockRestore();
      }
    },
  );
  it.each(['workflow', 'test'] as const)(
    'does not launch a %s when its MCP request closes during preflight',
    async (kind) => {
      const { WorkflowController } = await import('../src/workflows/controller');
      const { TestStore } = await import('../src/testing/store');
      const { AutomationController } = await import('../src/automation/controller');
      const descriptor = await enable();
      const document = {
        version: 2,
        tests: [
          {
            id: 'test',
            name: '取消预检',
            action: { sceneId: 'operations', actionId: 'submit' },
            inputs: { price: '1.00' },
            expect: { ui: [{ id: 'visible', selector: { key: 'result' }, state: 'visible' }] },
          },
        ],
      };
      await saveScenes();
      await writeFile(join(fake.workspace, '.flutter-pilot', 'tests.json'), JSON.stringify(document));
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const originalStart = WorkflowController.prototype.start;
      const read =
        kind === 'workflow'
          ? vi.spyOn(WorkflowController.prototype, 'start')
          : vi.spyOn(TestStore.prototype, 'read');
      (read as any).mockImplementationOnce(async function (this: any, ...args: any[]) {
        await gate;
        return kind === 'workflow' ? originalStart.apply(this, args as any) : document;
      });
      const acquire = vi.spyOn(AutomationController.prototype, 'acquireWorkflow');
      const action = vi
        .spyOn(AutomationController.prototype, 'executeWorkflow')
        .mockResolvedValue({ ok: true });
      const controller = new AbortController();
      try {
        const pending = requestSession(
          descriptor,
          {
            kind: 'call',
            tool: kind === 'workflow' ? 'run_scene_action' : 'run_test',
            args: {
              sessionId: descriptor.sessionId,
              ...(kind === 'workflow'
                ? { sceneId: 'operations', actionId: 'submit', inputs: { price: '1.00' } }
                : { testId: 'test' }),
            },
          },
          controller.signal,
        );
        const rejected = expect(pending).rejects.toHaveProperty('code', 'CANCELLED');
        await vi.waitFor(() => expect(read).toHaveBeenCalled());
        controller.abort();
        await rejected;
        // Allow the host socket's close event to invalidate the pending request.
        await new Promise((resolve) => setTimeout(resolve, 20));
        resume();
        await vi.waitFor(() =>
          expect(latest().state[kind === 'workflow' ? 'sceneActions' : 'tests'].run?.status).toMatch(
            /failed|error/,
          ),
        );
        expect(latest().state[kind === 'workflow' ? 'sceneActions' : 'tests'].run.failure.code).toBe(
          'SESSION_INVALIDATED',
        );
        expect(acquire).not.toHaveBeenCalled();
        expect(action).not.toHaveBeenCalled();
      } finally {
        resume();
        read.mockRestore();
        acquire.mockRestore();
        action.mockRestore();
      }
    },
  );
  it.each([false, true])('waits for WS after login and activation (socket lost: %s)', async (socketLost) => {
    const { VmSession } = await import('../src/vm/session');
    const { WsSession } = await import('../src/ws/session');
    const { AutomationController } = await import('../src/automation/controller');
    const { TestNetworkObserver } = await import('../src/testing/network');
    const sequence: string[] = [];
    let loginFinished = false;
    const connect = vi.spyOn(VmSession.prototype, 'connect').mockImplementation(async function (this: any) {
      this.state.status = 'connected';
      this.state.isolates = 1;
      this.emit('change');
    });
    const httpCapture = vi.spyOn(VmSession.prototype, 'setCaptureEnabled').mockImplementation(async function (
      this: any,
      enabled,
    ) {
      this.state.captureEnabled = enabled;
    });
    const wsCapture = vi.spyOn(WsSession.prototype, 'setCaptureEnabled').mockImplementation(async function (
      this: any,
      enabled,
    ) {
      this.state.captureEnabled = enabled;
    });
    const wsMock = vi.spyOn(WsSession.prototype, 'setMockEnabled').mockImplementation(async function (
      this: any,
      enabled,
    ) {
      this.state.mockEnabled = enabled;
      if (enabled) {
        sequence.push('enableWS');
        if (socketLost) this.state.connections = [];
      }
    });
    const scan = vi.spyOn(WsSession.prototype, 'rescan').mockImplementation(async function (this: any) {
      expect(loginFinished).toBe(true);
      sequence.push('attachWS');
      this.state.status = 'active';
      this.state.connections = [
        { id: 'socket', status: 'open', capture: 'attached', url: 'wss://example.test/orders' },
      ];
    });
    const action = vi
      .spyOn(AutomationController.prototype, 'executeWorkflow')
      .mockImplementation(async (_owner, tool, args) => {
        if (tool === 'tap' && args.selector?.key === 'login') {
          loginFinished = true;
          sequence.push('login');
        }
        if (tool === 'tap' && args.selector?.key === 'confirm') sequence.push('confirm');
        return { ok: true };
      });
    const baseline = vi
      .spyOn(TestNetworkObserver.prototype, 'baseline')
      .mockImplementation(async () => ({ at: Date.now(), httpIds: [], wsIds: [] }));
    try {
      const descriptor = await enable();
      await message('connection.mode', { mode: 'vm' });
      await message('vm.connect', { url: 'ws://127.0.0.1:12345/ws' });
      await writeFile(
        rulesFile(),
        JSON.stringify({
          version: 1,
          activeSceneId: null,
          scenes: [
            {
              ...actionScene,
              actions: [
                ...(actionScene.actions ?? []),
                { id: 'login', name: '登录', steps: [{ id: 'login', type: 'tap', target: 'login' }] },
              ],
            },
            {
              id: 'ws',
              name: 'WS fixture',
              httpRules: [],
              wsRules: [
                {
                  id: 'ws_rule',
                  name: 'pending rule',
                  enabled: true,
                  priority: 1,
                  match: { url: 'wss://example.test/orders', direction: 'inbound' },
                  action: { type: 'replace', text: '{}' },
                },
              ],
            },
          ],
        }),
      );
      await message('project.reload');
      await writeFile(
        join(fake.workspace, '.flutter-pilot', 'tests.json'),
        JSON.stringify({
          version: 2,
          tests: [
            {
              id: 'setup_ws',
              name: '登录后下单',
              action: { sceneId: 'operations', actionId: 'submit' },
              inputs: { price: '1.00' },
              sceneId: 'ws',
              setup: [{ action: { sceneId: 'operations', actionId: 'login' } }],
              expect: { ui: [{ id: 'result', selector: { key: 'pending' }, state: 'visible' }] },
            },
          ],
        }),
      );
      const start = await call(descriptor, 'run_test', { testId: 'setup_ws' });
      await vi.waitFor(async () =>
        expect((await call(descriptor, 'get_test_run', { runId: start.runId })).run.status).toBe('passed'),
      );
      expect(sequence).toEqual([
        'login',
        'attachWS',
        'enableWS',
        ...(socketLost ? ['attachWS'] : []),
        'confirm',
      ]);
    } finally {
      connect.mockRestore();
      httpCapture.mockRestore();
      wsCapture.mockRestore();
      wsMock.mockRestore();
      scan.mockRestore();
      action.mockRestore();
      baseline.mockRestore();
    }
  });
});
function workspaceHash(workspace: string) {
  return createHash('sha256').update(pathToFileURL(workspace).toString()).digest('hex').slice(0, 24);
}
function legacyStorage(workspace = fake.workspace) {
  return join(fake.storage, 'workspaces', workspaceHash(workspace));
}
function projectFile(workspace = fake.workspace) {
  return join(workspace, '.flutter-pilot', 'project.json');
}
function rulesFile(workspace = fake.workspace) {
  return join(workspace, '.flutter-pilot', 'scenes.json');
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
  directory = await mkdtemp(join(tmpdir(), 'flutter-pilot-extension-'));
  fake.workspace = join(directory, 'project');
  fake.extraWorkspace = '';
  fake.storage = join(directory, 'storage');
  process.env.FLUTTER_PILOT_MCP_ROOT = join(directory, 'bridge');
  fake.commands.clear();
  fake.executedCommands = [];
  fake.panels = [];
  fake.engines = [];
  fake.runtime.cached = '/fake/mitmdump';
  fake.runtime.download = undefined;
  fake.rejectSync = false;
  fake.autoStart = true;
  fake.autoConnectVm = true;
  fake.dartApi = undefined;
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
  delete process.env.FLUTTER_PILOT_MCP_ROOT;
});
describe('扩展与工作台整合', () => {
  it('侧栏与工作台截图共用连接校验，未连接时显示明确提示', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
    expect(manifest.contributes.viewsWelcome[0].contents).toContain('command:flutterPilot.screenshot');
    expect(
      manifest.contributes.commands.some((item: any) => item.command === 'flutterPilot.screenshot'),
    ).toBe(true);
    expect(fake.commands.has('flutterPilot.screenshot')).toBe(true);
    await open();
    await message('screenshot.capture');
    expect(latest().state.lastError).toContain('Flutter Debug VM');
    const vscode = await import('vscode');
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    await fake.commands.get('flutterPilot.screenshot')?.();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Flutter Debug VM'));
  });
  it('仅放行原生设置链接，旧设置消息不能再触发编辑器返回值的跨进程序列化', async () => {
    const panel = await open();
    expect(panel.options.enableCommandUris).toEqual(['workbench.action.openSettings']);
    await message('settings.open');
    expect(fake.executedCommands).not.toContain('workbench.action.openSettings');
  });
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
    expect(result.files.scenes).toMatch(/\/project\/\.flutter-pilot\/scenes\.json$/);
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
    await fake.commands.get('flutterPilot.start')?.();
    expect(engine.calls.some((c: any) => c.method === 'proxy.start')).toBe(true);
    expect(latest().state.proxyActive).toBe(true);
    await fake.commands.get('flutterPilot.stop')?.();
    expect(engine.calls.some((c: any) => c.method === 'proxy.stop')).toBe(true);
    expect(latest().state.proxyActive).toBe(false);
    expect(engine.stops).toBe(0);
    fake.panels[0].close();
    await open();
    expect(latest().state.proxyActive).toBe(false);
    expect(engine.stops).toBe(0);
  });
  it('场景规则保存后才激活，同步失败明确显示而不回退旧规则', async () => {
    await open();
    await message('rules.save', { rule: { ...rule, mock: { ...rule.mock, status: 999 } } });
    expect(latest().state.lastError).toContain('状态码');
    await message('rules.save', { rule });
    expect(JSON.parse(await readFile(rulesFile(), 'utf8')).scenes[0].httpRules[0].id).toBe('test');
    expect(latest().state.rules).toEqual([]);
    const id = latest().state.scenes.scenes[0].id;
    fake.rejectSync = true;
    await message('scenes.activate', { id });
    expect(latest().state.scenes.activeSceneId).toBe(id);
    expect(latest().state.sceneRuntime.http.status).toBe('error');
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
  it('目录查询失败时历史仍可刷新，目录查询携带独立筛选及分页', async () => {
    await open();
    const engine = fake.engines[0];
    const original = engine.rpc.bind(engine);
    vi.spyOn(engine, 'rpc').mockImplementation(async (...args: unknown[]) => {
      const [method, params] = args as [string, any];
      if (method === 'history.list') return { items: [{ id: 'updated' }], total: 1 };
      if (method === 'history.apis') {
        engine.calls.push({ method, params });
        throw new Error('目录查询失败');
      }
      return original(method, params);
    });
    await message('api.query', { search: 'orders', method: 'GET', offset: 30 });
    await vi.waitFor(() => expect(latest().state.history).toEqual({ items: [{ id: 'updated' }], total: 1 }));
    expect(engine.calls).toContainEqual({
      method: 'history.apis',
      params: { search: 'orders', method: 'GET', offset: 30, limit: 30 },
    });
    expect(latest().state.lastError).toContain('目录查询失败');
  });
  it('点击 API 读取最新完整请求，不改变历史列表及其筛选和分页', async () => {
    await open();
    const engine = fake.engines[0];
    const api = { method: 'POST', host: 'api.test', path: '/orders' };
    const filtered = { items: [{ id: 'filtered-history' }], total: 61 };
    const detail = { id: 'latest-api-history', response: { status: 201, body: '{"created":true}' } };
    const original = engine.rpc.bind(engine);
    vi.spyOn(engine, 'rpc').mockImplementation(async (...args: unknown[]) => {
      const [method, params] = args as [string, any];
      if (method === 'history.list') {
        engine.calls.push({ method, params });
        return params.limit === 1 ? { items: [{ id: detail.id }], total: 100 } : filtered;
      }
      if (method === 'history.get') {
        engine.calls.push({ method, params });
        return detail;
      }
      return original(method, params);
    });
    await message('history.query', { search: 'pending', status: 503, offset: 30 });
    await vi.waitFor(() => expect(latest().state.history).toEqual(filtered));
    const before = engine.calls.length;
    await message('api.select', api);
    await vi.waitFor(() => expect(latestSelected()).toEqual(detail));
    expect(engine.calls.slice(before)).toEqual([
      { method: 'history.list', params: { ...api, limit: 1, offset: 0 } },
      { method: 'history.get', params: { id: detail.id } },
    ]);
    expect(latest().state.history).toEqual(filtered);
    fake.confirm = '移除 API';
    await message('api.delete', api);
    expect(engine.calls.filter((call: any) => call.method === 'history.list').at(-1).params).toMatchObject({
      search: 'pending',
      status: 503,
      offset: 30,
      limit: 30,
    });
  });
  it('新请求到达时更新已选 API 的最终响应，历史详情仍固定在选中记录', async () => {
    await open();
    const engine = fake.engines[0];
    const api = { method: 'POST', host: 'api.test', path: '/user/info' };
    let detail = { ...api, id: 'before-mock', response: { status: 200, body: '{"userType":"INDIVIDUAL"}' } };
    const original = engine.rpc.bind(engine);
    vi.spyOn(engine, 'rpc').mockImplementation(async (...args: unknown[]) => {
      const [method, params] = args as [string, any];
      if (method === 'history.list' && params.limit === 1) return { items: [{ id: detail.id }], total: 2 };
      if (method === 'history.get' && params.id === detail.id) return detail;
      return original(method, params);
    });
    await message('api.select', api);
    expect(latestSelected()).toEqual(detail);
    detail = { ...api, id: 'after-mock', response: { status: 200, body: '{"userType":"MARKET_MAKER"}' } };
    engine.emit('event', { event: 'history', data: { id: detail.id } });
    await vi.waitFor(() => expect(latestSelected()).toEqual(detail));
    detail = { ...detail, response: { status: 200, body: '{"userType":"MARKET_MAKER","updated":true}' } };
    engine.emit('event', { event: 'history.updated', data: { id: detail.id } });
    await vi.waitFor(() => expect(latestSelected()).toEqual(detail));
    await message('history.select', { id: 'pinned-history' });
    const pinned = latestSelected();
    detail = { ...detail, id: 'later-request' };
    engine.emit('event', { event: 'history', data: { id: detail.id } });
    await vi.waitFor(() => expect(latest().state.busy).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(latestSelected()).toEqual(pinned);
  });

  it('API 自动详情刷新在等待正文时切换到历史，不覆盖新选择', async () => {
    await open();
    const engine = fake.engines[0];
    const api = { method: 'POST', host: 'api.test', path: '/user/info' };
    let id = 'original';
    let release!: (value: unknown) => void;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let fetching = false;
    const original = engine.rpc.bind(engine);
    vi.spyOn(engine, 'rpc').mockImplementation(async (...args: unknown[]) => {
      const [method, params] = args as [string, any];
      if (method === 'history.list' && params.limit === 1) return { items: [{ id }], total: 2 };
      if (method === 'history.get' && params.id === 'new-request') {
        fetching = true;
        return blocked;
      }
      return original(method, params);
    });
    await message('api.select', api);
    id = 'new-request';
    engine.emit('event', { event: 'history', data: { id } });
    await vi.waitFor(() => expect(fetching).toBe(true));
    await message('history.select', { id: 'pinned-history' });
    const pinned = latestSelected();
    release({ ...api, id: 'new-request' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(latestSelected()).toEqual(pinned);
  });

  it('API 没有历史时清除旧详情，不额外读取完整请求', async () => {
    await open();
    const engine = fake.engines[0];
    await message('history.select', { id: 'previous-history' });
    const before = engine.calls.length;
    await message('api.select', { method: 'GET', host: 'api.test', path: '/empty' });
    await vi.waitFor(() => expect(latestSelected()).toBeNull());
    expect(engine.calls.slice(before)).toEqual([
      {
        method: 'history.list',
        params: { method: 'GET', host: 'api.test', path: '/empty', limit: 1, offset: 0 },
      },
    ]);
  });
  it.each([
    { host: 'api.test', path: '/orders' },
    { method: 'GET', host: 123, path: '/orders' },
    { method: 'GET', host: 'api.test', path: null },
  ])('API 标识不是完整字符串时拒绝读取历史：%j', async (api) => {
    await open();
    const engine = fake.engines[0];
    const before = engine.calls.length;
    await message('api.select', api);
    await vi.waitFor(() => expect(latest().state.lastError).toBe('API 标识无效'));
    expect(engine.calls.slice(before)).toEqual([]);
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
  it('取消清空不删除，确认后清空全部历史并清除详情，保留目录与规则', async () => {
    await open();
    const engine = fake.engines[0];
    const selected = () =>
      fake.panels
        .at(-1)
        .webview.messages.filter((m: any) => m.type === 'state' && 'selected' in m)
        .at(-1)?.selected;
    await message('history.select', { id: 'selected-history' });
    expect(selected()?.id).toBe('selected-history');
    await message('history.clear');
    expect(engine.calls.some((c: any) => c.method === 'history.clear')).toBe(false);
    expect(selected()?.id).toBe('selected-history');
    const rules = latest().state.rules;
    await message('history.query', { search: 'filtered', offset: 30 });
    fake.confirm = '清空历史';
    const before = engine.calls.length;
    await message('history.clear');
    expect(engine.calls.slice(before)).toContainEqual({ method: 'history.clear', params: {} });
    expect(selected()).toBeNull();
    expect(latest().state.rules).toEqual(rules);
    expect(
      engine.calls.slice(before).some((c: any) => c.method === 'api.clear' || c.method === 'api.delete'),
    ).toBe(false);
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

  it('VM 离线 API 点击按准确标识读取最新完整详情，保留历史筛选结果', async () => {
    const storage = await activateVmMode();
    const { VmHistoryStore } = await import('../src/vm/storage');
    const db = new VmHistoryStore(storage, { retentionDays: 7, maxRecords: 10000 });
    const api = { method: 'GET', host: 'api.test', path: '/orders' };
    const request = {
      method: api.method,
      url: 'https://api.test/orders',
      headers: [] as [string, string][],
      body: '',
      bodyEncoding: 'text' as const,
      bodyBytes: 0,
      truncated: false,
      editable: true,
    };
    const response = { ...request, status: 200, body: '{"latest":true}', bodyBytes: 15 };
    const now = Date.now();
    for (const [i, id] of ['older-api', 'latest-api', 'different-host', 'different-path'].entries()) {
      await db.put({
        ...api,
        host: id === 'different-host' ? 'other.test' : api.host,
        path: id === 'different-path' ? '/other' : api.path,
        id,
        startedAt: now + i * 1000,
        duration: 12,
        url: request.url,
        targetUrl: request.url,
        originalRequest: request,
        request,
        response,
        mocked: false,
        note: '',
        tags: [],
      });
    }
    await db.close();
    await open();
    await message('history.query', { search: 'missing-record', offset: 30 });
    await vi.waitFor(() => expect(latest().state.history.total).toBe(0));
    await message('api.select', api);
    await vi.waitFor(() => expect(latestSelected()?.id).toBe('latest-api'));
    expect(latestSelected().response.body).toBe(response.body);
    expect(latest().state.history).toEqual({ items: [], total: 0 });
    await message('api.select', { ...api, path: '/no-history' });
    await vi.waitFor(() => expect(latestSelected()).toBeNull());
    expect(fake.engines[0].calls).toEqual([]);
  });

  it('启动补查失败后，打开工作台重新发现并连接已运行的 Flutter，无需新调试事件', async () => {
    const { WebSocketServer } = await import('ws');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    let queries = 0;
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const request = JSON.parse(raw.toString());
        if (request.method === 'Editor.getDebugSessions') {
          queries++;
          socket.send(
            JSON.stringify(
              queries === 1
                ? { id: request.id, error: { code: -32601, message: 'Editor not ready' } }
                : {
                    id: request.id,
                    result: {
                      debugSessions: [
                        {
                          id: 'already-running',
                          name: 'Already running Flutter',
                          debuggerType: 'Flutter',
                          flutterMode: 'debug',
                          projectRootPath: fake.workspace,
                          vmServiceUri: `ws://127.0.0.1:${port}/private-vm=/ws`,
                        },
                      ],
                    },
                  },
            ),
          );
        } else {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: request.method === 'getVM' ? { type: 'VM', isolates: [] } : { type: 'Success' },
            }),
          );
        }
      });
    });
    try {
      fake.dartApi = {
        version: 3,
        dtdUri: `ws://127.0.0.1:${port}/private-dtd=/ws`,
        onDtdUriChanged: () => ({ dispose() {} }),
      };
      await activateVmMode();
      await vi.waitFor(() => expect(queries).toBe(1));
      // No Flutter start/URI events or DTD ServiceRegistered notification are emitted.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await open();
      await vi.waitFor(() => {
        expect(latest().state.vm.status).toBe('connected');
        expect(latest().state.vmDiscovery.connectedSessionId).toBe('already-running');
      });
      expect(latest().state.vm.mockEnabled).toBe(false);
      expect(latest().state.ws.captureEnabled).toBe(false);
      expect(latest().state.ws.mockEnabled).toBe(false);
      expect(JSON.stringify(latest())).not.toMatch(/private-vm|private-dtd/);
    } finally {
      await deactivate();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

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
    await rm(join(fake.workspace, '.flutter-pilot'), { recursive: true });
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
    await rm(join(fake.workspace, '.flutter-pilot'), { recursive: true });
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

  it('编辑未激活场景不会同步旧代理，代理重连不重新启用人工断点', async () => {
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
    expect(latest().state.scenes.scenes[0].httpRules).toMatchObject([{ id: 'test', enabled: false }]);
    expect(latest().state.rules).toEqual([]);
    await message('connection.mode', { mode: 'proxy' });
    expect(latest().state.mode).toBe('proxy');
    expect(
      engine.calls
        .filter((call: any) => call.method === 'rules.sync')
        .every((call: any) => call.params.rules.length === 0),
    ).toBe(true);
  });
});

describe('项目文件与工作区绑定整合', () => {
  it('代理控制连接断开时拒绝切换模式，重连后才允许切换', async () => {
    await open();
    await message('rules.save', { rule });
    const id = latest().state.scenes.scenes[0].id;
    await message('scenes.activate', { id });
    const engine = fake.engines[0];
    engine.state = { ...engine.state, status: 'error' };
    engine.emit('status', engine.state);
    engine.emit('event', { event: 'control.disconnected' });
    await message('connection.mode', { mode: 'vm' });
    expect(latest().state.mode).toBe('proxy');
    expect(latest().state.lastError).toContain('旧规则可能仍在生效');
    expect((await readProject()).connection.mode).toBe('proxy');
    engine.state = { ...engine.state, status: 'running' };
    engine.emit('status', engine.state);
    await message('connection.mode', { mode: 'vm' });
    expect(latest().state.mode).toBe('vm');
    expect(engine.calls.filter((call: any) => call.method === 'rules.sync').at(-1).params.rules).toEqual([]);
  });
  it('代理控制连接快速重连后重新同步场景且同步前不显示已应用', async () => {
    await open();
    await message('rules.save', { rule });
    const id = latest().state.scenes.scenes[0].id;
    await message('scenes.activate', { id });
    const engine = fake.engines[0];
    const previousSyncs = engine.calls.filter((call: any) => call.method === 'rules.sync').length;
    engine.state = { ...engine.state, status: 'error' };
    engine.emit('status', engine.state);
    engine.emit('event', { event: 'control.disconnected' });
    engine.state = { ...engine.state, status: 'running' };
    engine.emit('status', engine.state);
    expect(latest().state.sceneRuntime.http.status).toBe('pending');
    engine.emit('event', { event: 'control.connected' });
    await vi.waitFor(
      () => {
        const syncs = engine.calls.filter((call: any) => call.method === 'rules.sync');
        expect(syncs.length).toBeGreaterThan(previousSyncs + 1);
        expect(syncs.at(-2).params.rules).toEqual([]);
        expect(syncs.at(-1).params.rules).toEqual([rule]);
        expect(latest().state.sceneRuntime.http.status).toBe('applied');
      },
      { timeout: 3000 },
    );
  });
  it('代理引擎快速重启后重新应用激活场景', async () => {
    await open();
    await message('rules.save', { rule });
    const id = latest().state.scenes.scenes[0].id;
    await message('scenes.activate', { id });
    const engine = fake.engines[0];
    const previousSyncs = engine.calls.filter((call: any) => call.method === 'rules.sync').length;
    await message('setLan', { enabled: true });
    await vi.waitFor(() => {
      const syncs = engine.calls.filter((call: any) => call.method === 'rules.sync');
      expect(syncs.length).toBeGreaterThan(previousSyncs);
      expect(syncs.at(-1).params.rules).toEqual([rule]);
    });
  });
  it('MCP returns proxy capture and Mock status with scene summaries', async () => {
    await open();
    await message('rules.save', { rule });
    const id = latest().state.scenes.scenes[0].id;
    await message('scenes.activate', { id });
    await message('mcp.enable', { enabled: true });
    const [descriptor] = await discoverSessions(join(directory, 'bridge', 'sessions'), fake.workspace);
    const status = (await requestSession(descriptor, {
      kind: 'call',
      tool: 'get_network_status',
      args: { sessionId: descriptor.sessionId },
    })) as any;
    expect(status.http).toMatchObject({ captureEnabled: true, mockEnabled: true, runtimeApplied: true });
    const summary = (await requestSession(descriptor, {
      kind: 'call',
      tool: 'list_scenes',
      args: { sessionId: descriptor.sessionId },
    })) as any;
    expect(summary.scenes[0]).toMatchObject({ id, httpRuleCount: 1 });
    expect(summary.scenes[0].httpRules).toBeUndefined();
  });
  it('首次生成稳定 UUID，工作台展示项目文件路径且重新激活复用身份', async () => {
    await open();
    const config = await readProject();
    expect(config).toMatchObject({ version: 1, name: 'project', connection: { mode: 'proxy' } });
    expect(config.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(latest().state.project).toMatchObject({
      id: config.projectId,
      name: 'project',
      configPath: expect.stringContaining('/.flutter-pilot/project.json'),
      rulesPath: expect.stringContaining('/.flutter-pilot/scenes.json'),
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
    expect(JSON.parse(await readFile(rulesFile(), 'utf8')).scenes[0].httpRules).toEqual([rule]);
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
    expect(fake.shownDocuments.map((file) => file.slice(file.indexOf('/.flutter-pilot/')))).toEqual([
      '/.flutter-pilot/project.json',
      '/.flutter-pilot/scenes.json',
    ]);
  });

  it('显式读取外部规则后同步引擎，配置变更保持当前会话并提示重载', async () => {
    await open();
    const external = { ...rule, id: 'external', name: 'external' };
    const doc = JSON.parse(await readFile(rulesFile(), 'utf8'));
    doc.scenes[0].httpRules = [external];
    doc.activeSceneId = doc.scenes[0].id;
    await writeFile(rulesFile(), JSON.stringify(doc));
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
    const doc = JSON.parse(await readFile(rulesFile(), 'utf8'));
    doc.scenes[0].httpRules = [external];
    doc.activeSceneId = doc.scenes[0].id;
    await writeFile(rulesFile(), JSON.stringify(doc));
    const previousSyncs = fake.engines[0].calls.filter((call: any) => call.method === 'rules.sync').length;
    await message('rules.save', { rule });
    expect(latest().state.lastError).toContain('读取项目文件');
    expect(JSON.parse(await readFile(rulesFile(), 'utf8')).scenes[0].httpRules).toEqual([external]);
    expect(fake.engines[0].calls.filter((call: any) => call.method === 'rules.sync')).toHaveLength(
      previousSyncs,
    );
    await message('project.reload');
    await message('rules.save', { rule });
    expect(JSON.parse(await readFile(rulesFile(), 'utf8')).scenes[0].httpRules).toEqual([external, rule]);
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
    await mkdir(join(fake.extraWorkspace, '.flutter-pilot'), { recursive: true });
    await writeFile(
      join(fake.extraWorkspace, 'pubspec.yaml'),
      'dependencies:\n  flutter:\n    sdk: flutter\n',
    );
    await writeFile(projectFile(fake.extraWorkspace), JSON.stringify(config));
    const copiedRule = { ...rule, id: 'copied' };
    await writeFile(
      rulesFile(fake.extraWorkspace),
      JSON.stringify({
        version: 1,
        activeSceneId: 'copy-scene',
        scenes: [{ id: 'copy-scene', name: '副本', httpRules: [copiedRule], wsRules: [] }],
      }),
    );
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
    await vi.waitFor(() =>
      expect(copy.calls.filter((call: any) => call.method === 'rules.sync').at(-1).params.rules).toEqual([
        copiedRule,
      ]),
    );
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

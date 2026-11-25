import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { RuntimeProjectRef, RuntimeTarget } from '../runtime/targets';
import type { HistoryEntry, HistoryQuery, HistoryResult, Rule } from '../model';
import { SceneStore } from '../scenes';
import { SceneController } from '../scene-controller';
import { McpNetworkController } from '../mcp/network';
import { BrowserWorkerClient } from './client';
import { BrowserDependencies } from './dependencies';
import { BrowserError, browserUrl, type BrowserContextState, type BrowserTarget } from './protocol';
import { browserPageSchema } from './protocol';
import { webUiTools, validateWebAction } from './ui-schema';
import { WorkflowController } from '../workflows/controller';
import type { WsRule } from '../ws/model';
import { TestController } from '../testing/controller';
import { TestStore } from '../testing/store';
import { TestNetworkObserver } from '../testing/network';
import { compileTestMock } from '../testing/mock-model';
import type { WsConnection } from '../ws/model';
import { pause } from '../automation/model';
interface ManagedContext {
  state: BrowserContextState;
  store: SceneStore;
  scenes: SceneController;
  network: McpNetworkController;
  rules: Rule[];
  capture: boolean;
  mock: boolean;
  wsRules: WsRule[];
  wsCapture: boolean;
  wsMock: boolean;
  busy?: string;
  workflows: WorkflowController;
  workflowTarget?: Record<string, any>;
  runTargets: Map<string, Record<string, any>>;
  tests: TestController;
  observer: TestNetworkObserver;
  testTarget?: Record<string, any>;
  environments: Map<string, { http: boolean; ws: boolean; needsWs: boolean }>;
}
export interface BrowserControllerOptions {
  project: RuntimeProjectRef;
  rulesDirectory: string;
  storage: string;
  resources: string;
  workerPath: string;
}
export class BrowserController extends EventEmitter {
  readonly dependencies: BrowserDependencies;
  readonly worker: BrowserWorkerClient;
  private contexts = new Map<string, ManagedContext>();
  private archivedRuns = new Map<string, { tool: string; target: Record<string, any>; result: any }>();
  constructor(readonly options: BrowserControllerOptions) {
    super();
    this.dependencies = new BrowserDependencies(join(options.storage, 'browser-runtime'), options.resources);
    this.worker = new BrowserWorkerClient(options.workerPath);
    this.dependencies.on('progress', (message) => this.emit('log', message));
    this.worker.on('log', (message) => this.emit('log', message));
    this.worker.on('pages', ({ runtimeId, state }) => {
      const c = this.contexts.get(runtimeId);
      if (c) {
        c.state = state;
        this.emit('changed');
      }
    });
    this.worker.on('http', (event) => this.emit('http', event));
    this.worker.on('ws', (event) => this.emit('ws', event));
    this.worker.on('disconnected', () => {
      for (const c of this.contexts.values()) {
        c.scenes.dispose();
        void Promise.all([c.workflows.dispose(), c.tests.dispose()]).then(() => this.archiveRuns(c));
        c.observer?.close();
      }
      this.contexts.clear();
      this.emit('loss');
      this.emit('changed');
    });
  }
  targets(): RuntimeTarget[] {
    return [...this.contexts.values()].map((c) => ({
      ...this.options.project,
      runtimeId: c.state.runtimeId,
      generation: c.state.generation,
      kind: 'browser',
      connected: this.worker.running,
      executionScope: c.state.runtimeId,
      capabilities: {
        'http.history': { supported: true },
        'http.capture': { supported: true },
        'http.mock': { supported: true },
        'ui.actions': { supported: true },
        'ui.screenshot': { supported: true },
        ...Object.fromEntries(
          ['ws.history', 'ws.capture', 'ws.mock', 'ws.send', 'ws.inject'].map((name) => [
            name,
            { supported: true },
          ]),
        ),
      },
    }));
  }
  snapshot() {
    return {
      running: this.worker.running,
      archivedRuns: [...this.archivedRuns.values()].map(({ tool, target, result }) => ({
        tool,
        target,
        runId: result.run.runId,
        status: result.run.status,
      })),
      contexts: [...this.contexts.values()].map((c) => ({
        ...c.state,
        busy: c.busy,
        scene: c.scenes.summary(),
        runtime: c.scenes.runtime,
        actions: c.workflows?.snapshot,
        wsCapture: c.wsCapture,
        wsMock: c.wsMock,
        tests: c.tests?.snapshot,
        cleanupPending: [...(c.environments?.keys() ?? [])],
      })),
      limitations: [
        'managed Chromium only',
        'Service Workers blocked',
        'routing disables HTTP cache',
        'direct interception only; no stacked proxy Mock',
        'no SSR capture',
      ],
    };
  }
  async status() {
    return { ...this.snapshot(), dependencies: await this.dependencies.status() };
  }
  private context(target: BrowserTarget) {
    const c = this.contexts.get(target.runtimeId);
    if (!c || !this.worker.running)
      throw new BrowserError('TARGET_DISCONNECTED', 'Browser target is closed or disconnected.');
    if (c.state.generation !== target.generation)
      throw new BrowserError('TARGET_STALE', 'Browser target generation expired.');
    return c;
  }
  private async exclusive<T>(c: ManagedContext, operation: () => Promise<T>, readOnly = false) {
    if (c.busy) throw new BrowserError('WORKFLOW_BUSY', 'This Context is already running an operation.');
    c.busy = 'operation';
    this.emit('changed');
    try {
      return await operation();
    } catch (error) {
      if (!readOnly && error instanceof BrowserError && error.uncertain) c.busy = 'uncertain';
      throw error;
    } finally {
      if (c.busy === 'operation') c.busy = undefined;
      this.emit('changed');
    }
  }
  private async sync(c: ManagedContext) {
    return this.worker.request('configure', {
      target: c.state,
      rules: c.rules,
      capture: c.capture,
      mock: c.mock,
      wsRules: c.wsRules,
      wsCapture: c.wsCapture,
      wsMock: c.wsMock,
    });
  }
  async execute(tool: string, args: Record<string, any>, signal?: AbortSignal): Promise<any> {
    if (tool === 'get_browser_status') return this.status();
    if (tool === 'prepare_browser') return this.dependencies.prepare(signal);
    if (tool === 'list_browser_pages') return this.snapshot();
    if (tool === 'create_browser_context') {
      const status = await this.dependencies.status();
      if (!status.prepared || !status.executable)
        throw new BrowserError('BROWSER_NOT_PREPARED', 'Explicitly call prepare_browser first.');
      await this.worker.start(this.dependencies.root, status.executable);
      const state = await this.worker.request<BrowserContextState>(
        'create',
        { headless: args.headless, trustedCertificates: args.trustedCertificates },
        signal,
      );
      await mkdir(join(this.options.storage, 'browser-targets'), { recursive: true, mode: 0o700 });
      const store = new SceneStore(
        this.options.rulesDirectory,
        join(this.options.storage, 'browser-targets', state.runtimeId),
      );
      const c = {
        state,
        store,
        rules: [],
        capture: true,
        mock: false,
        wsRules: [],
        wsCapture: false,
        wsMock: false,
      } as unknown as ManagedContext;
      c.scenes = new SceneController(store, {
        snapshot: () => ({
          key: `${state.runtimeId}:${state.generation}:${c.capture}`,
          targetKey: `${state.runtimeId}:${state.generation}:${this.worker.running}`,
          mode: 'vm',
          connected: this.contexts.has(state.runtimeId) && this.worker.running,
          httpApplied: c.capture && c.mock,
          wsApplied: c.wsCapture && c.wsMock,
        }),
        disable: async (domain) => {
          if (domain === 'http') c.mock = false;
          else c.wsMock = false;
          await this.sync(c);
        },
        project: async (rules, ws) => {
          const previous = { rules: c.rules, wsRules: c.wsRules };
          c.rules = rules;
          c.wsRules = ws;
          try {
            await this.sync(c);
          } catch (error) {
            Object.assign(c, previous);
            throw error;
          }
        },
        enable: async (domain) => {
          if (domain === 'http') {
            c.capture = true;
            c.mock = true;
          } else {
            c.wsCapture = true;
            c.wsMock = true;
          }
          await this.sync(c);
        },
        capture: async (domain, enabled) => {
          if (domain === 'http') c.capture = enabled;
          else c.wsCapture = enabled;
          await this.sync(c);
        },
        changed: () => this.emit('changed'),
      });
      c.network = new McpNetworkController({
        scenesPath: store.file,
        listScenes: (query) => c.scenes.summary(query),
        activateScene: (id) => c.scenes.activate(id),
        reloadScenes: () => c.scenes.reload(),
        status: () => ({
          target: this.targets().find((t) => t.runtimeId === state.runtimeId),
          http: {
            captureEnabled: c.capture,
            mockEnabled: c.mock,
            runtimeApplied: c.scenes.runtime.http.status === 'applied',
          },
          ws: {
            supported: true,
            captureEnabled: c.wsCapture,
            mockEnabled: c.wsMock,
            coverage: 'Connections created after Page routing only; HMR excluded; binary/oversize read-only.',
          },
          scene: c.scenes.summary(),
          browser: c.state,
        }),
        listHttp: (query) => this.worker.request<HistoryResult>('history.list', { target: state, query }),
        getHttp: (id) => this.worker.request<HistoryEntry>('history.get', { target: state, id }),
        clearHttp: () => this.worker.request('history.clear', { target: state }),
        clearWs: () => this.worker.request('ws.clear', { target: state }),
        setCapture: (domain, enabled) => c.scenes.setCapture(domain, enabled),
        connections: () => this.worker.request('ws.connections', { target: state }),
        messages: (query) => this.worker.request('ws.messages', { target: state, query }),
        injectWs: async (connectionId, text, signal) => {
          await this.worker.request('ws.inject', { target: state, connectionId, text }, signal);
        },
        sendWs: async (connectionId, text, signal) => {
          await this.worker.request('ws.send', { target: state, connectionId, text }, signal);
        },
      });
      this.contexts.set(state.runtimeId, c);
      c.runTargets = new Map();
      c.workflows = new WorkflowController(
        {
          read: (sceneId, actionId) =>
            store.prepareSnapshot(sceneId && actionId ? [{ sceneId, actionId }] : [], c.scenes.activeSceneId),
          list: async (sceneId) => ({
            ok: true,
            ...store.getScene(sceneId),
            ...c.workflows.snapshot,
            mockSceneId: c.scenes.activeSceneId,
          }),
        },
        {
          preflight: (compiled) => {
            for (const item of compiled.steps)
              if (!validateWebAction(item.tool, item.args))
                throw new BrowserError(
                  'TARGET_UNSUPPORTED',
                  `Unsupported Web step: ${item.path}. No action was dispatched.`,
                );
          },
          acquire: async (owner) => {
            if (c.busy !== 'starting') throw new BrowserError('WORKFLOW_BUSY', 'Context is busy.');
            c.busy = owner;
          },
          release: async (owner) => {
            if (c.busy === owner) c.busy = undefined;
          },
          execute: async (owner, tool, args, signal) => {
            if (c.busy !== owner) throw new BrowserError('WORKFLOW_BUSY', 'Context ownership expired.');
            try {
              return await this.worker.request('ui', { target: c.workflowTarget, tool, args }, signal);
            } catch (error) {
              if (
                error instanceof BrowserError &&
                error.uncertain &&
                !['wait_for_widget', 'get_ui_snapshot', 'find_widget'].includes(tool)
              )
                c.busy = 'uncertain';
              throw error;
            }
          },
          mockSceneId: () => c.scenes.activeSceneId,
          changed: () => this.emit('changed'),
        },
      );
      this.initializeTests(c);
      try {
        await c.scenes.initialize();
      } catch (error) {
        this.contexts.delete(state.runtimeId);
        await this.worker.request('close', { target: state });
        throw error;
      }
      this.emit('changed');
      return state;
    }
    if (['get_test_run', 'get_scene_action_run'].includes(tool)) {
      const archived = this.archivedRuns.get(this.runKey(args.target, args.runId));
      if (archived?.tool === tool) return structuredClone(archived.result);
    }
    const c = this.context(args.target);
    if (tool === 'list_tests') return c.tests.list();
    if (tool === 'get_test_run')
      return {
        ...c.tests.get(args.runId),
        target: c.runTargets.get(args.runId),
        cleanupPending: c.environments.has(args.runId),
      };
    if (tool === 'cancel_test_run') {
      const result = c.tests.cancel(args.runId);
      if (result.status !== 'running' && c.environments.has(args.runId)) {
        await this.cleanupTest(c, args.runId);
        if (c.busy === 'cleanup') c.busy = undefined;
        return { ...result, cleanupRecovered: true };
      }
      return result;
    }
    if (tool === 'run_test') {
      if (c.busy || c.environments.size)
        throw new BrowserError(
          'WORKFLOW_BUSY',
          'Context is busy or cleanup is pending; cancel_test_run retries cleanup only.',
        );
      const target = browserPageSchema.parse(args.target);
      if (!c.state.pages.some((p) => p.pageId === target.pageId))
        throw new BrowserError('PAGE_STALE', 'Test Page is closed.');
      c.busy = 'starting';
      c.testTarget = target;
      try {
        const result = await c.tests.start(args.testId, args.inputs, args.backend);
        c.runTargets.set(result.runId, target);
        this.trimTargets(c);
        return { ...result, target };
      } finally {
        if (c.busy === 'starting') c.busy = undefined;
      }
    }
    if (tool === 'get_browser_ws_message')
      return this.worker.request('ws.message', { target: args.target, id: args.id });
    if (tool === 'list_scene_actions') return c.workflows.list(args.sceneId);
    if (tool === 'get_scene_action_run')
      return { ...c.workflows.get(args.runId), target: c.runTargets.get(args.runId) };
    if (tool === 'cancel_scene_action_run') return c.workflows.cancel(args.runId);
    if (tool === 'run_scene_action') {
      const target = browserPageSchema.parse(args.target);
      if (!c.state.pages.some((page) => page.pageId === target.pageId))
        throw new BrowserError('PAGE_STALE', 'Scene action Page is closed.');
      if (c.busy) throw new BrowserError('WORKFLOW_BUSY', 'Context is busy.');
      c.busy = 'starting';
      c.workflowTarget = structuredClone(target);
      try {
        const result = await c.workflows.start(args.sceneId, args.actionId, args.inputs, args.backend);
        c.runTargets.set(result.runId, target);
        this.trimTargets(c);
        return { ...result, target };
      } finally {
        if (c.busy === 'starting') c.busy = undefined;
      }
    }
    if (Object.hasOwn(webUiTools, tool)) {
      const parsed = webUiTools[tool as keyof typeof webUiTools].schema.parse(args);
      return this.exclusive(
        c,
        () => this.worker.request('ui', { target: parsed.target, tool, args: parsed }, signal),
        ['wait_for_widget', 'get_ui_snapshot', 'find_widget', 'take_screenshot'].includes(tool),
      );
    }
    if (tool === 'close_browser_context' && c.busy === 'uncertain') c.busy = undefined;
    const network = [
      'get_network_status',
      'get_requests',
      'get_request',
      'clear_network_history',
      'list_scenes',
      'reload_rules',
      'activate_scene',
      'deactivate_scene',
      'set_capture_enabled',
      'get_ws_connections',
      'get_ws_messages',
      'send_ws_message',
      'inject_ws_message',
    ];
    if (network.includes(tool)) {
      const read = [
        'get_network_status',
        'get_requests',
        'get_request',
        'list_scenes',
        'get_ws_connections',
        'get_ws_messages',
      ].includes(tool);
      return read
        ? c.network.execute(tool, args, signal)
        : this.exclusive(c, () => c.network.execute(tool, args, signal));
    }
    return this.exclusive(c, async () => {
      const method = (
        {
          open_browser_page: 'open',
          navigate_browser_page: 'navigate',
          reload_browser_page: 'reload',
          close_browser_page: 'page.close',
          close_browser_context: 'close',
        } as Record<string, string>
      )[tool];
      if (!method)
        throw new BrowserError('TARGET_UNSUPPORTED', 'This operation is unsupported by the browser target.');
      const result = await this.worker.request(
        method,
        { target: args.target, ...(args.url ? { url: browserUrl(args.url) } : {}) },
        signal,
      );
      if (method === 'close') {
        await c.tests.dispose();
        c.observer.close();
        await c.workflows.dispose();
        this.archiveRuns(c);
        c.scenes.dispose();
        this.contexts.delete(c.state.runtimeId);
      } else c.state = result;
      this.emit('changed');
      return result;
    });
  }
  async dispose() {
    await this.dependencies.dispose();
    for (const c of this.contexts.values()) c.scenes.dispose();
    await Promise.all([...this.contexts.values()].map((c) => c.workflows.dispose()));
    await Promise.all([...this.contexts.values()].map((c) => c.tests.dispose()));
    this.contexts.clear();
    await this.worker.stop();
  }
  private runKey(target: Record<string, any>, runId: string) {
    return JSON.stringify([target.runtimeId, target.generation, runId]);
  }
  private trimTargets(c: ManagedContext) {
    while (c.runTargets.size > 100) c.runTargets.delete(c.runTargets.keys().next().value!);
  }
  private archiveRuns(c: ManagedContext) {
    for (const [tool, controller] of [
      ['get_test_run', c.tests],
      ['get_scene_action_run', c.workflows],
    ] as const) {
      for (const run of controller.snapshot.recentRuns) {
        const target = c.runTargets.get(run.runId);
        if (!target) continue;
        const result = { ...controller.get(run.runId), target, disconnected: true, cleanupPending: false };
        this.archivedRuns.set(this.runKey(target, run.runId), { tool, target, result });
      }
    }
    while (this.archivedRuns.size > 100) this.archivedRuns.delete(this.archivedRuns.keys().next().value!);
    this.emit('changed');
  }
  private initializeTests(c: ManagedContext) {
    c.environments = new Map();
    const target = () => c.testTarget!;
    c.observer = new TestNetworkObserver({
      clock: () => this.worker.request('clock'),
      connections: () => this.worker.request('ws.connections', { target: c.state }),
      subscribe: (callbacks) => {
        const http = (event: any) => {
          if (event.runtimeId === c.state.runtimeId && event.pageId === target().pageId)
            callbacks.http(event.entry);
        };
        const ws = (event: any) => {
          if (event.runtimeId === c.state.runtimeId && event.pageId === target().pageId)
            callbacks.ws(event.message);
        };
        const loss = () => callbacks.loss();
        this.on('http', http);
        this.on('ws', ws);
        this.on('loss', loss);
        return () => {
          this.off('http', http);
          this.off('ws', ws);
          this.off('loss', loss);
        };
      },
    });
    c.tests = new TestController(new TestStore(this.options.rulesDirectory), {
      uiSource: 'web',
      mockSceneId: () => c.scenes.activeSceneId,
      preflight: (compiled) => {
        for (const step of compiled.steps)
          if (!validateWebAction(step.tool, step.args))
            throw new BrowserError('TARGET_UNSUPPORTED', `Unsupported test step ${step.path}`);
      },
      acquire: async (owner) => {
        if (c.busy !== 'starting') throw new BrowserError('WORKFLOW_BUSY', 'Context is busy.');
        c.busy = owner;
      },
      release: async (owner) => {
        if (c.environments.size) c.busy = 'cleanup';
        else if (c.busy === owner) c.busy = undefined;
      },
      execute: async (owner, tool, args, signal) => {
        if (c.busy !== owner) throw new BrowserError('WORKFLOW_BUSY', 'Test ownership invalidated.');
        try {
          return await this.worker.request('ui', { target: target(), tool, args }, signal);
        } catch (error) {
          if (
            error instanceof BrowserError &&
            error.uncertain &&
            tool !== 'wait_for_widget' &&
            tool !== 'get_ui_snapshot'
          )
            c.busy = 'uncertain';
          throw error;
        }
      },
      changed: () => this.emit('changed'),
      loadScenes: async (test, resolve) => {
        if (!test) throw new BrowserError('INVALID_TEST', 'Test reference required.');
        return c.store.prepareSnapshot(
          [test.action, ...(test.setup ?? []).map((s) => s.action)],
          null,
          (doc) => resolve?.(doc) ?? c.scenes.activeSceneId,
        );
      },
      prepare: async (runId, sceneId, mock, requirements, snapshot) => {
        const source = snapshot?.scenes.find((scene) => scene.id === (sceneId ?? snapshot.activeSceneId));
        c.environments.set(runId, {
          http: c.capture,
          ws: c.wsCapture,
          needsWs: requirements.ws || !!source?.wsRules.some((rule) => rule.enabled),
        });
        if (requirements.http) c.capture = true;
        await this.sync(c);
        await c.scenes.beginRun(runId, sceneId, mock ? compileTestMock(mock, runId) : [], {
          deferWs: true,
          snapshot,
        });
        if (c.scenes.runtime.http.status === 'error')
          throw new BrowserError('TEST_MOCK_NOT_READY', 'HTTP test rules failed.');
      },
      ready: async (runId, signal) => {
        if (!c.environments.get(runId)?.needsWs) return;
        c.wsCapture = true;
        await this.sync(c);
        const end = performance.now() + 10000;
        while (true) {
          signal.throwIfAborted();
          const connections = await this.worker.request<Array<WsConnection & { pageId: string }>>(
            'ws.connections',
            { target: c.state },
          );
          if (connections.some((v) => v.status === 'open' && v.pageId === target().pageId)) {
            await c.scenes.activateRunWs(runId);
            return;
          }
          if (performance.now() >= end)
            throw new BrowserError(
              'WS_CONNECTION_NOT_READY',
              'Setup did not create a WebSocket on the selected Page.',
            );
          await pause(50, signal);
        }
      },
      cleanup: (runId) => this.cleanupTest(c, runId),
      baseline: () => c.observer.baseline(),
      http: (b) => c.observer.http(b),
      ws: (b) => c.observer.ws(b),
      injectWs: async (url, text, signal) => {
        const matches = (
          await this.worker.request<Array<WsConnection & { pageId: string }>>('ws.connections', {
            target: c.state,
          })
        ).filter((v) => v.status === 'open' && v.pageId === target().pageId && v.url === url);
        if (matches.length !== 1)
          throw new BrowserError(
            matches.length ? 'AMBIGUOUS_WS_CONNECTION' : 'WS_CONNECTION_NOT_READY',
            'Expected exactly one matching WebSocket on the selected Page.',
          );
        await this.worker.request(
          'ws.inject',
          { target: c.state, connectionId: matches[0].id, text },
          signal,
        );
        return { connectionId: matches[0].id };
      },
    });
  }
  private async cleanupTest(c: ManagedContext, runId: string) {
    c.observer.close();
    const saved = c.environments.get(runId);
    if (!saved) return;
    this.context(c.state);
    await c.scenes.endRun(runId);
    c.capture = saved.http;
    c.wsCapture = saved.ws;
    await this.sync(c);
    c.environments.delete(runId);
  }
}

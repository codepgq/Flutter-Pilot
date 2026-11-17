import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWebMcpFixture } from './web-mcp-fixture.mjs';
import { until } from './web-test-support.mjs';

// Uses the caller's disposable real Flutter App, never a discovered user session.
export async function verifyCoexistence({ vm, ui, store, scenes, network, directory }) {
  const f = await createWebMcpFixture({ rulesDirectory: directory });
  const {
    WorkflowController,
    TestController,
    TestStore,
    TestNetworkObserver,
    compileTestMock,
    readVmClock,
    McpSessionServer,
    AutomationController,
    AutomationRuntime,
  } = f.host;
  await f.ipc.stop();
  const artifact = resolve(
    'artifacts/web-flutter-runtime/phase-07',
    new Date().toISOString().replace(/[:.]/g, '-') + '-coexistence',
  );
  await mkdir(artifact, { recursive: true });
  const checks = [],
    reports = [];
  const check = (name, value) => {
    assert.ok(value, name);
    checks.push(name);
  };
  const nativeRule = (marker) => ({
    id: 'flutter-value',
    name: 'Flutter value',
    enabled: true,
    priority: 1,
    match: { path: '/value' },
    mock: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ marker }) },
  });
  await f.store.importPackage(
    {
      version: 2,
      scenes: [
        {
          id: 'native',
          name: 'Native',
          httpRules: [nativeRule('flutter-only')],
          wsRules: [],
          targets: { fetch: { source: 'flutter', key: 'fetch' }, echo: { source: 'flutter', key: 'echo' } },
          actions: [
            {
              id: 'fetch',
              name: 'Fetch native value',
              steps: [{ id: 'fetch', type: 'tap', target: 'fetch' }],
            },
          ],
        },
      ],
    },
    false,
  );
  const testsPath = join(directory, 'tests.json');
  const defs = JSON.parse(await readFile(testsPath, 'utf8'));
  defs.tests.push({
    id: 'native-success',
    name: 'Native success',
    action: { sceneId: 'native', actionId: 'fetch' },
    timeoutMs: 15000,
    mock: { initialState: 'ready', states: [{ id: 'ready', httpRules: [nativeRule('flutter-test')] }] },
    expect: {
      http: [
        {
          id: 'value',
          match: { path: '/value' },
          status: 200,
          mocked: true,
          responseJson: { '/marker': 'flutter-test' },
        },
      ],
      ui: [
        {
          id: 'echo',
          selector: { source: 'flutter', key: 'echo' },
          state: 'text_equals',
          text: 'flutter-test',
        },
      ],
    },
  });
  await writeFile(testsPath, JSON.stringify(defs));
  await scenes.reload();
  let owner;
  const automation = new AutomationController(
    new AutomationRuntime({ root: join(f.root, 'automation'), resources: resolve('resources/automation') }),
    {
      vmExecute: (tool, args) => ui.execute(tool, args),
      vmInvalidate: () => ui.invalidate(),
      vmConnected: () => vm.state.status === 'connected',
      vmIdentity: () => ({ generation: '1', deviceId: process.env.VM_FLUTTER_DEVICE }),
      changed: () => {},
    },
    join(f.root, 'leases'),
  );
  const execute = (runOwner, tool, args, signal) =>
    runOwner
      ? automation.executeWorkflow(runOwner, tool, args, signal)
      : automation.execute(tool, args, signal);
  const workflowHost = {
    mockSceneId: () => scenes.activeSceneId,
    acquire: async (id) => {
      assert.ok(!owner);
      owner = id;
      await automation.acquireWorkflow(id);
    },
    release: async (id) => {
      await automation.releaseWorkflow(id);
      if (owner === id) owner = undefined;
    },
    execute,
    changed: () => {},
  };
  const workflows = new WorkflowController(
    {
      read: (sceneId, actionId) => store.prepareSnapshot([{ sceneId, actionId }], scenes.activeSceneId),
      list: async (sceneId) => store.getScene(sceneId),
    },
    workflowHost,
  );
  const observer = new TestNetworkObserver({
    clock: () => readVmClock(vm.client),
    connections: () => vm.websocket.store.connections(),
    subscribe: (callbacks) => {
      const http = (e) => callbacks.http(e),
        loss = () => callbacks.loss();
      vm.on('observation.http', http);
      vm.on('observation.loss', loss);
      return () => {
        vm.off('observation.http', http);
        vm.off('observation.loss', loss);
      };
    },
  });
  const tests = new TestController(new TestStore(directory), {
    ...workflowHost,
    loadScenes: (test, resolveMock) =>
      store.prepareSnapshot(
        [test.action, ...(test.setup ?? []).map((v) => v.action)],
        null,
        (doc) => resolveMock?.(doc) ?? scenes.activeSceneId,
      ),
    prepare: async (runId, sceneId, mock, _requirements, snapshot) =>
      scenes.beginRun(runId, sceneId, mock ? compileTestMock(mock, runId) : [], { snapshot }),
    cleanup: async (runId) => {
      observer.close();
      await scenes.endRun(runId);
    },
    baseline: () => observer.baseline(),
    http: (b) => observer.http(b),
    ws: (b) => observer.ws(b),
    injectWs: async () => {
      throw new Error('native fixture has no WS');
    },
  });
  const nativeTarget = { runtimeId: 'fixture:vm', generation: 1 };
  const ipc = new McpSessionServer({
    registryRoot: f.registry,
    workspace: f.root,
    sessionId: f.sessionId,
    name: 'Flutter and Web production adapters',
    describe: () => ({
      runtimeTargets: [
        { ...nativeTarget, kind: 'flutter', connected: vm.state.status === 'connected' },
        ...f.browser.targets(),
      ],
    }),
    call: async (tool, args, context) => {
      if (args.target?.runtimeId !== nativeTarget.runtimeId) {
        if (
          !args.target &&
          !['create_browser_context', 'get_browser_status', 'list_browser_pages', 'prepare_browser'].includes(
            tool,
          )
        )
          throw Object.assign(new Error('Choose explicit target'), { code: 'TARGET_AMBIGUOUS' });
        return f.browser.execute(tool, args, context.signal);
      }
      if (args.target.generation !== 1)
        throw Object.assign(new Error('Stale target'), { code: 'TARGET_STALE' });
      if (tool === 'run_scene_action') return workflows.start(args.sceneId, args.actionId, args.inputs);
      if (tool === 'get_scene_action_run') return workflows.get(args.runId);
      if (tool === 'run_test') return tests.start(args.testId, args.inputs);
      if (tool === 'get_test_run') return tests.get(args.runId);
      if (['tap', 'find_widget', 'get_ui_snapshot', 'wait_for_widget'].includes(tool))
        return execute(owner, tool, args);
      return network.execute(tool, args);
    },
  });
  const client = new Client({ name: 'real-dual-runtime-client', version: '1.0.0' });
  try {
    await ipc.start();
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('dist/mcp-bridge.cjs'), '--registry', f.registry, '--workspace', f.root],
        stderr: 'pipe',
      }),
    );
    const call = async (name, args = {}) => {
      const r = await client.callTool({
        name,
        arguments: { ...(name === 'list_sessions' ? {} : { sessionId: f.sessionId }), ...args },
      });
      assert.ok(!r.isError, JSON.stringify(r));
      return r.structuredContent;
    };
    const context = await call('create_browser_context'),
      web = { runtimeId: context.runtimeId, generation: context.generation };
    const page = await call('open_browser_page', { target: web, url: f.url + '/html' }),
      target = { ...web, pageId: page.pageId };
    const discovered = await call('list_sessions');
    check(
      'one stdio service discovers both actual runtimes',
      JSON.stringify(discovered).includes('fixture:vm') && JSON.stringify(discovered).includes(web.runtimeId),
    );
    await call('activate_scene', { target: nativeTarget, sceneId: 'native' });
    await call('activate_scene', { target: web, sceneId: 'web' });
    const waiting = await call('run_scene_action', { target, sceneId: 'web', actionId: 'waiting' });
    const nativeAction = await call('run_scene_action', {
      target: nativeTarget,
      sceneId: 'native',
      actionId: 'fetch',
    });
    await until(
      async () =>
        (await call('get_scene_action_run', { target: nativeTarget, runId: nativeAction.runId })).run
          .status !== 'running',
      'native action',
    );
    await until(
      async () =>
        (await call('find_widget', { target: nativeTarget, key: 'echo' })).widget?.text === 'flutter-only',
      'native mock UI',
    );
    check(
      'Flutter executes while browser Context locked',
      (await call('get_scene_action_run', { target: web, runId: waiting.runId })).run.status === 'running',
    );
    await call('cancel_scene_action_run', { target: web, runId: waiting.runId });
    await until(
      async () =>
        (await call('get_scene_action_run', { target: web, runId: waiting.runId })).run.status !== 'running',
      'cancel Web wait',
    );
    const webAction = await call('run_scene_action', { target, sceneId: 'web', actionId: 'fetch' });
    await until(
      async () =>
        (await call('get_scene_action_run', { target: web, runId: webAction.runId })).run.status !==
        'running',
      'Web action',
    );
    for (const [selected, expected] of [
      [nativeTarget, 'flutter-only'],
      [web, 'web-only'],
    ]) {
      const history = await call('get_requests', { target: selected, path: '/value' });
      const details = await Promise.all(
        history.items.map((v) => call('get_request', { target: selected, id: v.id })),
      );
      check(
        expected + ' history isolated',
        details.some((v) => JSON.parse(v.response.body).marker === expected) &&
          !details.some((v) =>
            v.response?.body?.includes(expected === 'web-only' ? 'flutter-only' : 'web-only'),
          ),
      );
    }
    const [nativeTest, webTest] = await Promise.all([
      call('run_test', { target: nativeTarget, testId: 'native-success' }),
      call('run_test', { target, testId: 'order-success' }),
    ]);
    for (const [selected, started] of [
      [nativeTarget, nativeTest],
      [web, webTest],
    ]) {
      let report;
      await until(
        async () => {
          report = await call('get_test_run', { target: selected, runId: started.runId });
          return report.run.status !== 'running';
        },
        'dual business test',
        25000,
      );
      reports.push(report);
      await writeFile(join(artifact, 'partial-runs.json'), JSON.stringify(reports, null, 2));
      check(selected.runtimeId + ' real business test passed', report.run.status === 'passed');
    }
    const crash = await call('run_scene_action', { target, sceneId: 'web', actionId: 'waiting' });
    const disconnected = new Promise((done) => f.browser.worker.once('disconnected', done));
    f.browser.worker.child.kill('SIGKILL');
    await disconnected;
    await until(
      () => f.browser.snapshot().archivedRuns.some((r) => r.runId === crash.runId),
      'crash archived',
    );
    check(
      'Web crash terminal is queryable and noncompleted',
      (await call('get_scene_action_run', { target: web, runId: crash.runId })).run.status !== 'completed',
    );
    await call('tap', { target: nativeTarget, key: 'fetch' });
    await until(
      async () =>
        (await call('find_widget', { target: nativeTarget, key: 'echo' })).widget?.text === 'flutter-only',
      'Flutter survives Worker crash',
    );
    check('Flutter stays connected after Web Worker crash', vm.state.status === 'connected');
    const fresh = await call('create_browser_context');
    check(
      'new Worker does not revive old Context or run',
      fresh.runtimeId !== web.runtimeId &&
        f.browser.snapshot().contexts.length === 1 &&
        f.browser.snapshot().contexts[0].actions.recentRuns.length === 0,
    );
    check(
      'new Worker does not reactivate previous Mock',
      !f.browser.snapshot().contexts[0].scene.activeSceneId,
    );
    await call('close_browser_context', {
      target: { runtimeId: fresh.runtimeId, generation: fresh.generation },
    });
    await writeFile(
      join(artifact, 'report.json'),
      JSON.stringify({ checks, passed: checks.length, reports, discovered }, null, 2),
    );
    console.log(JSON.stringify({ coexistenceArtifact: artifact, passed: checks.length }));
  } finally {
    await tests.dispose();
    observer.close();
    await workflows.dispose();
    await automation.dispose();
    await client.close();
    await ipc.stop();
    await f.dispose();
  }
}

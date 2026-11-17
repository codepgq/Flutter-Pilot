import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { productionHost, listen, closeServer, until } from './web-test-support.mjs';
const { BrowserController, SceneStore, parseTool, McpSessionServer } = await productionHost();
const root = await mkdtemp(join(tmpdir(), 'pilot-web-ui-')),
  artifact = resolve(
    'artifacts/web-flutter-runtime/phase-04',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
await mkdir(artifact, { recursive: true });
const scripts = {};
for (const kind of ['react', 'vue'])
  scripts[kind] = (
    await build({
      entryPoints: [`tests/fixtures/web/app/${kind}.${kind === 'react' ? 'jsx' : 'js'}`],
      bundle: true,
      write: false,
      format: 'iife',
    })
  ).outputFiles[0].text;
const events = [],
  checks = [],
  runs = [];
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
};
const plain = `<input data-testid="entry"><button data-testid="submit">Submit</button><p data-testid="result"></p><script>document.querySelector('[data-testid=entry]').addEventListener('input',()=>fetch('/event?kind=input'));document.querySelector('[data-testid=submit]').onclick=()=>{let value=document.querySelector('input').value;document.querySelector('[data-testid=result]').textContent='Submitted '+value;fetch('/submit?value='+encodeURIComponent(value))}</script>`;
const extras = `<button data-testid="disabled" disabled>Disabled</button><div style="position:relative;width:120px;height:40px"><button data-testid="covered">Covered</button><div style="position:absolute;inset:0;background:#ccc"></div></div><button data-testid="duplicate">A</button><button data-testid="duplicate">B</button><iframe data-testid="frame" src="/frame"></iframe><div data-testid="outer" style="height:120px;overflow:auto"><div data-testid="inner" style="height:100px;overflow:auto"><div style="height:500px">inner</div></div><div style="height:500px">outer</div></div><div style="height:1000px"></div><p data-testid="bottom">BOTTOM END</p>`;
const scrollReport =
  "<script>for(const id of ['inner','outer'])document.querySelector('[data-testid='+id+']').addEventListener('scroll',e=>fetch('/scroll?region='+id+'&position='+e.target.scrollTop));</script>";
const server = http.createServer((req, res) => {
  events.push(req.url);
  res.setHeader('content-type', 'text/html');
  if (req.url === '/frame') return res.end('<button data-testid="inside">Frame button</button>');
  if (req.url === '/huge') return res.end('<div style="height:20000px">too tall</div>');
  const kind = req.url.slice(1);
  if (['html', 'react', 'vue'].includes(kind))
    return res.end(
      `<!doctype html><meta charset="utf-8"><h1>TOP START ${kind}</h1><div id="app">${kind === 'html' ? plain : ''}</div>${extras}${scrollReport}${scripts[kind] ? '<script>' + scripts[kind] + '</script>' : ''}`,
    );
  res.end('ok');
});
const url = `http://127.0.0.1:${await listen(server)}`;
const controller = new BrowserController({
  project: { projectId: 'ui-fixture', workspacePath: root },
  rulesDirectory: join(root, '.flutter-pilot'),
  storage: resolve('artifacts/web-flutter-runtime/browser-validation'),
  resources: resolve('resources/browser'),
  workerPath: resolve('dist/browser-worker.cjs'),
});
const invoke = (tool, args = {}, signal) =>
  controller.execute(
    tool,
    parseTool(tool, {
      sessionId: 'fixture',
      ...args,
      ...(args.target
        ? {
            target: {
              runtimeId: args.target.runtimeId,
              generation: args.target.generation,
              ...(args.target.pageId ? { pageId: args.target.pageId } : {}),
            },
          }
        : {}),
    }),
    signal,
  );
const selector = (testId) => ({ source: 'web', testId });
try {
  const store = new SceneStore(join(root, '.flutter-pilot'));
  await store.load();
  await store.importPackage(
    {
      version: 2,
      scenes: [
        {
          id: 'shared',
          name: 'Shared',
          httpRules: [],
          wsRules: [],
          targets: { entry: selector('entry') },
          actions: [
            {
              id: 'fill',
              name: 'Fill',
              inputs: { value: { required: true, secret: true } },
              steps: [{ id: 'input', type: 'enter_text', target: 'entry', text: '${inputs.value}' }],
            },
          ],
        },
        {
          id: 'flow',
          name: 'Flow',
          httpRules: [],
          wsRules: [],
          targets: { submit: selector('submit'), result: selector('result'), missing: selector('missing') },
          actions: [
            {
              id: 'submit',
              name: 'Submit',
              inputs: { value: { required: true, secret: true } },
              steps: [
                {
                  id: 'fill',
                  type: 'call',
                  sceneId: 'shared',
                  actionId: 'fill',
                  inputs: { value: '${inputs.value}' },
                },
                { id: 'click', type: 'tap', target: 'submit' },
                {
                  id: 'done',
                  type: 'wait_for_widget',
                  target: 'result',
                  state: 'text_contains',
                  text: 'Submitted',
                },
              ],
            },
            {
              id: 'unsupported',
              name: 'Unsupported',
              steps: [
                { id: 'click', type: 'tap', target: 'submit' },
                { id: 'keyboard', type: 'hide_keyboard' },
              ],
            },
            {
              id: 'wait',
              name: 'Wait',
              steps: [
                { id: 'wait', type: 'wait_for_widget', target: 'missing', timeoutMs: 30000 },
                { id: 'click', type: 'tap', target: 'submit' },
              ],
            },
          ],
        },
      ],
    },
    false,
  );
  for (const kind of ['html', 'react', 'vue']) {
    const c = await invoke('create_browser_context'),
      p = await invoke('open_browser_page', { target: c, url: url + '/' + kind }),
      target = { runtimeId: c.runtimeId, generation: c.generation, pageId: p.pageId };
    const ready = await invoke('wait_for_widget', { target, selector: selector('entry'), state: 'visible' });
    check(kind + ' rendered', ready.ok);
    for (const state of ['present', 'visible', 'enabled', 'actionable'])
      check(
        kind + ' wait ' + state,
        (await invoke('wait_for_widget', { target, selector: selector('submit'), state })).ok,
      );
    check(
      kind + ' absent state',
      (await invoke('wait_for_widget', { target, selector: selector('missing'), state: 'absent' })).ok,
    );
    check(
      kind + ' text change',
      (
        await invoke('wait_for_widget', {
          target,
          selector: selector('result'),
          state: 'text_changed',
          text: 'old value',
        })
      ).ok,
    );
    check(
      kind + ' explicit role/name',
      (await invoke('find_widget', { target, selector: { source: 'web', role: 'button', name: 'Submit' } }))
        .present,
    );
    check(
      kind + ' frame target',
      (
        await invoke('find_widget', {
          target,
          selector: { ...selector('inside'), frame: { testId: 'frame' } },
        })
      ).present,
    );
    for (const [sel, code] of [
      [selector('duplicate'), 'AMBIGUOUS_TARGET'],
      [selector('missing'), 'NOT_FOUND'],
      [{ ...selector('inside'), frame: { testId: 'missing' } }, 'FRAME_NOT_FOUND'],
    ]) {
      await assert.rejects(
        () => invoke('find_widget', { target, selector: sel }),
        (e) => e.code === code,
      );
      check(kind + ' ' + code, true);
    }
    for (const testId of ['disabled', 'covered']) {
      await assert.rejects(
        () => invoke('tap', { target, selector: selector(testId), timeoutMs: 150 }),
        (e) => e.code === 'NOT_ACTIONABLE',
      );
      check(kind + ' rejects ' + testId, true);
    }
    const before = events.filter((p) => p.startsWith('/submit')).length;
    await assert.rejects(
      () => invoke('run_scene_action', { target, sceneId: 'flow', actionId: 'unsupported' }),
      (e) => e.code === 'TARGET_UNSUPPORTED',
    );
    check(kind + ' full action preflight', events.filter((p) => p.startsWith('/submit')).length === before);
    const secret = 'fixture-secret-' + kind;
    const started = await invoke('run_scene_action', {
      target,
      sceneId: 'flow',
      actionId: 'submit',
      inputs: { value: secret },
    });
    await until(async () => {
      const { run } = await invoke('get_scene_action_run', { target, runId: started.runId });
      return run.status !== 'running';
    }, 'Scene completion');
    const completed = await invoke('get_scene_action_run', { target, runId: started.runId });
    runs.push(completed);
    check(
      kind + ' production Scene completed',
      completed.run.status === 'completed' && completed.run.steps.length === 3,
    );
    check(kind + ' secret redacted', !JSON.stringify(completed).includes(secret));
    await until(() => events.filter((p) => p.startsWith('/submit')).length === before + 1, 'one submit');
    check(
      kind + ' actual input event',
      events.some((p) => p.startsWith('/event')),
    );
    check(
      kind + ' final UI',
      (
        await invoke('wait_for_widget', {
          target,
          selector: selector('result'),
          state: 'text_equals',
          text: 'Submitted ' + secret,
        })
      ).ok,
    );
    const wait = await invoke('wait_for_widget', {
      target,
      selector: selector('missing'),
      state: 'present',
      timeoutMs: 100,
    });
    check(kind + ' wait diagnostics', !wait.ok && wait.diagnostics.lastObservation.code === 'NOT_FOUND');
    const cancellation = new AbortController();
    const pendingWait = invoke(
      'wait_for_widget',
      {
        target,
        selector: selector('missing'),
        timeoutMs: 30000,
      },
      cancellation.signal,
    );
    const cancelledWait = assert.rejects(pendingWait, (error) => error.code === 'CANCELLED');
    await until(
      () =>
        controller.snapshot().contexts.find((item) => item.runtimeId === c.runtimeId)?.busy === 'operation',
      'direct wait owns Context',
    );
    cancellation.abort();
    await cancelledWait;
    check(
      kind + ' cancelled direct wait releases Context',
      (await invoke('find_widget', { target, selector: selector('submit') })).ok,
    );
    const current = await invoke('run_scene_action', { target, sceneId: 'flow', actionId: 'wait' });
    await assert.rejects(
      () => invoke('reload_rules', { target: c }),
      (e) => e.code === 'WORKFLOW_BUSY',
    );
    await assert.rejects(
      () => invoke('tap', { target, selector: selector('submit') }),
      (e) => e.code === 'WORKFLOW_BUSY',
    );
    await invoke('cancel_scene_action_run', { target, runId: current.runId });
    await until(
      async () =>
        (await invoke('get_scene_action_run', { target, runId: current.runId })).run.status !== 'running',
      'cancel',
    );
    check(
      kind + ' cancel blocks next submit',
      events.filter((p) => p.startsWith('/submit')).length === before + 1,
    );
    await invoke('close_browser_context', { target: c });
  }
  const c = await invoke('create_browser_context'),
    p = await invoke('open_browser_page', { target: c, url: url + '/html' }),
    target = { runtimeId: c.runtimeId, generation: c.generation, pageId: p.pageId };
  await invoke('scroll', { target, selector: selector('inner'), distance: 120 });
  await until(() => events.some((p) => p.startsWith('/scroll?region=inner')), 'inner scroll event');
  check(
    'wheel scroll stays in selected nested region',
    !events.some((p) => p.startsWith('/scroll?region=outer')),
  );
  await invoke('scroll', { target, selector: selector('inner'), distance: 2000 });
  await assert.rejects(
    () => invoke('scroll', { target, selector: selector('inner'), distance: 2000 }),
    (e) => e.code === 'SCROLL_BOUNDARY',
  );
  check(
    'scroll boundary does not chain to parent',
    !events.some((p) => p.startsWith('/scroll?region=outer')),
  );
  await invoke('navigate_browser_page', { target, url: url + '/html' });
  for (const mode of ['screen', 'full_page']) {
    const shot = await invoke('take_screenshot', { target, source: 'web', mode });
    const png = Buffer.from(shot.image.data, 'base64');
    await writeFile(join(artifact, mode + '.png'), png);
    check(
      mode + ' PNG dimensions',
      png.readUInt32BE(16) === shot.width && png.readUInt32BE(20) === shot.height,
    );
  }
  const registryRoot = join(root, 'sessions');
  const session = new McpSessionServer({
    registryRoot,
    workspace: root,
    name: 'Web UI',
    sessionId: 'fixture',
    describe: () => ({ runtimeTargets: controller.targets() }),
    call: (tool, args, context) => controller.execute(tool, args, context.signal),
  });
  await session.start();
  const client = new Client({ name: 'web-ui-sdk', version: '1.0.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('dist/mcp-bridge.cjs'), '--registry', registryRoot, '--workspace', root],
        stderr: 'pipe',
      }),
    );
    const shot = await client.callTool({
      name: 'take_screenshot',
      arguments: { sessionId: 'fixture', target, source: 'web', mode: 'screen' },
    });
    const image = shot.content.find((item) => item.type === 'image');
    check(
      'built MCP stdio returns actual Web PNG',
      !shot.isError &&
        image?.mimeType === 'image/png' &&
        Buffer.from(image.data, 'base64').subarray(1, 4).toString() === 'PNG',
    );
  } finally {
    await client.close();
    await session.stop();
  }
  await invoke('navigate_browser_page', { target, url: url + '/huge' });
  await assert.rejects(
    () => invoke('take_screenshot', { target, source: 'web', mode: 'full_page' }),
    (e) => e.code === 'SCREENSHOT_LIMIT',
  );
  check('screenshot limit rejects full page', true);
  await invoke('navigate_browser_page', { target, url: url + '/html' });
  const waiting = await invoke('run_scene_action', { target, sceneId: 'flow', actionId: 'wait' });
  const independent = await invoke('create_browser_context');
  check(
    'independent Context not serialized by another run',
    !!(await invoke('open_browser_page', { target: independent, url: url + '/html' })).pageId,
  );
  const submitCount = events.filter((v) => v.startsWith('/submit')).length;
  await controller.worker.request('page.close', { target });
  await until(
    async () =>
      (await invoke('get_scene_action_run', { target, runId: waiting.runId })).run.status !== 'running',
    'page closure terminal',
  );
  check(
    'page closure stops following submit',
    events.filter((v) => v.startsWith('/submit')).length === submitCount &&
      (await invoke('get_scene_action_run', { target, runId: waiting.runId })).run.status !== 'completed',
  );
  await writeFile(
    join(artifact, 'report.json'),
    JSON.stringify({ checks, passed: checks.length, runs, events }, null, 2),
  );
  console.log(JSON.stringify({ artifact, passed: checks.length }));
} finally {
  await controller.dispose();
  await closeServer(server);
  await rm(root, { recursive: true, force: true });
}

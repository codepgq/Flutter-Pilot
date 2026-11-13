import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRuleDocument, type Rule } from '../src/model';
import { compileTestMock, validateTestMock, type TestMock } from '../src/testing/mock-model';
import { SceneController, type SceneHost } from '../src/scene-controller';
import { SceneStore } from '../src/scenes';
import type { WsRule } from '../src/ws/model';

const rule = (id = 'list', body = '[]'): Rule => ({
  id,
  name: id,
  enabled: true,
  priority: 0,
  match: { method: 'GET', path: '/orders' },
  mock: { status: 200, headers: {}, body },
});
const fixtureMock = (): TestMock => ({
  initialState: 'empty',
  states: [
    {
      id: 'empty',
      httpRules: [
        rule(),
        {
          ...rule('submit', '{"orderId":"new"}'),
          match: { method: 'POST', path: '/orders' },
          nextState: 'pending',
        },
      ],
    },
    { id: 'pending', httpRules: [rule('list', '[{"orderId":"new","status":"pending"}]')] },
  ],
});

describe('test mock fixtures', () => {
  it('compiles each state into bounded unique run rules without mutating authored IDs', () => {
    const mock = fixtureMock();
    const compiled = compileTestMock(mock, 'run-one');
    expect(compiled).toHaveLength(3);
    expect(new Set(compiled.map((item) => item.id)).size).toBe(3);
    expect(compiled.every((item) => item.id.length <= 128 && !('nextState' in item))).toBe(true);
    expect(compiled[1].scenario).toEqual({ id: 'run-one', initial: 'empty', when: 'empty', next: 'pending' });
    expect(compiled[2].scenario?.when).toBe('pending');
    expect(compileTestMock(mock, 'run-two')[0].id).not.toBe(compiled[0].id);
    compiled[0].mock!.body = 'changed';
    expect(mock.states[0].httpRules[0].mock!.body).toBe('[]');
    expect(compileTestMock(mock, 'r'.repeat(128))[0].id.length).toBeLessThanOrEqual(128);
  });
  it('uses only explicit transitions, including explicit business-rejection fixtures', () => {
    const mock = fixtureMock();
    const submit = mock.states[0].httpRules[1];
    delete submit.nextState;
    expect(compileTestMock(mock, 'run')[1].scenario?.next).toBeUndefined();
    submit.mock = { status: 400, headers: {}, body: '{"code":"denied"}' };
    submit.nextState = 'pending';
    expect(compileTestMock(mock, 'run')[1].scenario?.next).toBe('pending');
  });
  it.each([
    (mock: any) => {
      mock.extra = true;
    },
    (mock: any) => {
      mock.states = [];
    },
    (mock: any) => {
      mock.states = Array.from({ length: 65 }, (_, i) => ({ id: String(i), httpRules: [] }));
    },
    (mock: any) => {
      mock.initialState = 'missing';
    },
    (mock: any) => {
      mock.states[1].id = 'empty';
    },
    (mock: any) => {
      mock.states[0].extra = true;
    },
    (mock: any) => {
      mock.states[0].httpRules[1].nextState = 'missing';
    },
    (mock: any) => {
      mock.states[0].httpRules[1].nextState = null;
    },
    (mock: any) => {
      mock.states[0].httpRules[0].scenario = { id: 'foreign', initial: 'a', when: 'a' };
    },
    (mock: any) => {
      mock.states[0].httpRules[0].response = { body: 'changed' };
    },
    (mock: any) => {
      mock.states[0].httpRules[0].request = { body: 'changed' };
    },
    (mock: any) => {
      mock.states[0].httpRules[0].breakpoint = { request: true };
    },
    (mock: any) => {
      mock.states[0].httpRules[0].redirect = { url: '/other' };
    },
    (mock: any) => {
      delete mock.states[0].httpRules[0].mock;
    },
    (mock: any) => {
      mock.states[0].httpRules = Array.from({ length: 1001 }, (_, i) => rule(String(i)));
    },
  ])('rejects invalid fixture structure and unsafe mixed actions %s', (mutate) => {
    const mock = fixtureMock();
    mutate(mock);
    expect(() => validateTestMock(mock)).toThrow();
  });
  it('validates scenario schema in ordinary runtime rules too', () => {
    const compiled = compileTestMock(fixtureMock(), 'run');
    for (const scenario of [
      {},
      { ...compiled[0].scenario, extra: true },
      { ...compiled[0].scenario, id: '' },
      { ...compiled[0].scenario, next: '\n' },
    ]) {
      expect(() => validateRuleDocument({ version: 1, rules: [{ ...compiled[0], scenario }] })).toThrow(
        'scenario',
      );
    }
    expect(() =>
      validateRuleDocument({
        version: 1,
        rules: [compiled[0], { ...compiled[1], scenario: { ...compiled[1].scenario, initial: 'other' } }],
      }),
    ).toThrow('initial');
    expect(() =>
      validateRuleDocument({ version: 1, rules: [{ ...compiled[0], response: { body: 'unsafe' } }] }),
    ).toThrow('直接');
  });
});

const temporary: WsRule = {
  id: 'temp',
  name: 'connection',
  enabled: true,
  priority: 0,
  match: { connectionId: 'socket-1' },
  action: { type: 'drop' },
};
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const remove of cleanup.splice(0)) await remove();
});
async function sceneFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-test-scenes-'));
  const store = new SceneStore(directory);
  await writeFile(
    store.file,
    JSON.stringify({
      version: 1,
      activeSceneId: 'base',
      scenes: [
        {
          id: 'base',
          name: 'Base',
          httpRules: [
            { ...rule('base-low'), priority: -10 },
            { ...rule('base-high'), priority: Number.MAX_SAFE_INTEGER },
          ],
          wsRules: [],
        },
        { id: 'other', name: 'Other', httpRules: [rule('other')], wsRules: [] },
      ],
    }),
  );
  const state = {
    key: 'vm-1',
    mode: 'vm' as 'vm' | 'proxy',
    connected: true,
    proxyRulesUnreachable: false,
    httpApplied: false,
    wsApplied: false,
  };
  let projected = { http: [] as Rule[], ws: [] as WsRule[] };
  const calls: string[] = [];
  const host: SceneHost = {
    snapshot: () => ({ ...state }),
    disable: vi.fn(async (domain: 'http' | 'ws') => {
      calls.push(`off:${domain}`);
      state[`${domain}Applied`] = false;
    }),
    project: vi.fn(async (http, ws) => {
      calls.push('project');
      projected = { http, ws };
    }),
    enable: vi.fn(async (domain: 'http' | 'ws') => {
      calls.push(`on:${domain}`);
      state[`${domain}Applied`] = true;
    }),
    capture: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  const controller = new SceneController(store, host);
  await controller.initialize();
  calls.length = 0;
  cleanup.push(async () => {
    controller.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { controller, store, host, state, calls, projected: () => projected };
}

describe('ephemeral test scenes', () => {
  it('applies scoped overrides above extreme base priorities, then restores without writing disk', async () => {
    const { controller, store, projected, calls } = await sceneFixture();
    const before = await readFile(store.file, 'utf8');
    const document = structuredClone(controller.document);
    await controller.beginRun('run', undefined, [
      { ...rule('override-low'), priority: -100 },
      { ...rule('override-high'), priority: 20 },
    ]);
    expect(projected().http.map((item) => item.id)).toEqual([
      'override-high',
      'override-low',
      'base-high',
      'base-low',
    ]);
    expect(projected().http.every((item) => Number.isSafeInteger(item.priority))).toBe(true);
    expect(calls).toEqual(['off:http', 'off:ws', 'project', 'on:http']);
    expect(controller.summary().runtimeRunId).toBe('run');
    expect(controller.document).toEqual(document);
    expect(await readFile(store.file, 'utf8')).toBe(before);
    await controller.endRun('run');
    expect(controller.summary().runtimeRunId).toBeUndefined();
    expect(projected().http).toEqual(document.scenes[0].httpRules);
    expect(await readFile(store.file, 'utf8')).toBe(before);
    await controller.endRun('run');
  });
  it('uses an explicitly selected scene while keeping persisted activation and browsing independent', async () => {
    const { controller } = await sceneFixture();
    await controller.beginRun('run', 'other');
    controller.select('base');
    expect(controller.active?.id).toBe('other');
    expect(controller.selected?.id).toBe('base');
    expect(controller.document.activeSceneId).toBe('base');
    await controller.endRun('run');
    expect(controller.active?.id).toBe('base');
  });
  it('defers WS until setup and resumes it without detaching or reprojecting HTTP fixtures', async () => {
    const { controller, host, calls, state } = await sceneFixture();
    await controller.saveWs([{ ...temporary, id: 'url-rule', match: { url: 'wss://api.test/orders' } }]);
    await controller.setCapture('ws', false);
    const http = compileTestMock(fixtureMock(), 'run');
    await controller.beginRun('run', undefined, http, { deferWs: true });
    expect(controller.runtime.http.status).toBe('applied');
    expect(controller.runtime.ws.status).toBe('paused');
    const counts = {
      disable: vi.mocked(host.disable).mock.calls.length,
      project: vi.mocked(host.project).mock.calls.length,
    };
    calls.length = 0;
    await controller.activateRunWs('run');
    expect(calls).toEqual(['on:ws']);
    expect(controller.runtime.ws.status).toBe('applied');
    expect(state.httpApplied).toBe(true);
    await controller.reconcile();
    expect(host.disable).toHaveBeenCalledTimes(counts.disable);
    expect(host.project).toHaveBeenCalledTimes(counts.project);
    await controller.activateRunWs('run');
    expect(calls).toEqual(['on:ws']);
    await controller.endRun('run');
    expect(controller.runtime.ws.status).toBe('paused');
  });
  it('keeps WS readiness failures owned and restores temporary state without retrying activation', async () => {
    const { controller, host, calls } = await sceneFixture();
    await controller.saveWs([{ ...temporary, id: 'url-rule', match: { url: 'wss://api.test/orders' } }]);
    await controller.beginRun('run', undefined, [], { deferWs: true });
    const projects = vi.mocked(host.project).mock.calls.length;
    vi.mocked(host.enable).mockRejectedValueOnce(new Error('socket not attached'));
    await expect(controller.activateRunWs('run')).rejects.toThrow('socket not attached');
    expect(controller.runtime.ws.status).toBe('error');
    expect(controller.summary().runtimeRunId).toBe('run');
    expect(host.project).toHaveBeenCalledTimes(projects);
    await expect(controller.activateRunWs('foreign')).rejects.toThrow('持有');
    await controller.endRun('run');
    expect(controller.summary().runtimeRunId).toBeUndefined();
    expect(controller.runtime.ws.status).toBe('applied');
    expect(calls.filter((call) => call === 'on:ws')).toHaveLength(2);
  });
  it('rejects WS activation after an environment generation change without hiding HTTP staleness', async () => {
    const { controller, host, state } = await sceneFixture();
    await controller.beginRun('run', undefined, [], { deferWs: true });
    const enabled = vi.mocked(host.enable).mock.calls.length;
    state.key = 'vm-2';
    await expect(controller.activateRunWs('run')).rejects.toThrow('发生变化');
    expect(host.enable).toHaveBeenCalledTimes(enabled);
    expect(controller.runtime.http.status).toBe('pending');
    await controller.endRun('run');
  });
  it('does not mark the run ready if HTTP attachment was lost during setup', async () => {
    const { controller, state } = await sceneFixture();
    await controller.beginRun('run', undefined, [], { deferWs: true });
    state.httpApplied = false;
    await expect(controller.activateRunWs('run')).rejects.toThrow('HTTP 环境尚未实际接入');
    expect(controller.runtime.http.status).toBe('pending');
    state.httpApplied = true;
    await controller.endRun('run');
  });
  it('prevents outside scene and capture mutations, overlapping starts and wrong-owner cleanup', async () => {
    const { controller } = await sceneFixture();
    await controller.beginRun('run');
    for (const operation of [
      () => controller.activate('other'),
      () => controller.reload(),
      () => controller.saveHttp([]),
      () => controller.saveWs([]),
      () => controller.create('new'),
      () => controller.setCapture('http', false),
      () => controller.beginRun('foreign'),
      () =>
        controller.change((doc) => {
          doc.scenes = [];
        }),
    ])
      await expect(operation()).rejects.toThrow('测试运行');
    await expect(controller.endRun('foreign')).rejects.toThrow('其他');
    expect(controller.summary().runtimeRunId).toBe('run');
    await controller.endRun('run');
    await controller.beginRun('next');
    await expect(controller.endRun('run')).rejects.toThrow('其他');
    expect(controller.summary().runtimeRunId).toBe('next');
    await controller.endRun('next');
  });
  it('restores paused domains and temporary WS rules, excluding connections that expired during a run', async () => {
    const { controller, projected } = await sceneFixture();
    await controller.saveWs([temporary], 'base');
    await controller.setCapture('http', false);
    expect(controller.runtime.http.status).toBe('paused');
    await controller.beginRun('run', 'other');
    expect(controller.runtime.http.status).toBe('applied');
    expect(projected().ws).toEqual([]);
    await controller.endRun('run');
    expect(controller.runtime.http.status).toBe('paused');
    expect(projected().ws).toEqual([temporary]);
    await controller.beginRun('run-two');
    controller.expireTemporary([]);
    await controller.endRun('run-two');
    expect(projected().ws).toEqual([]);
  });
  it('restores a pending capture intent instead of replaying it in the test environment', async () => {
    const { controller, host } = await sceneFixture();
    vi.mocked(host.capture).mockRejectedValueOnce(new Error('capture failed'));
    await expect(controller.setCapture('http', false)).rejects.toThrow('capture failed');
    const before = vi.mocked(host.capture).mock.calls.length;
    await controller.beginRun('run');
    await controller.reconcile();
    expect(vi.mocked(host.capture).mock.calls).toHaveLength(before);
    await controller.endRun('run');
    await controller.reconcile();
    expect(host.capture).toHaveBeenLastCalledWith('http', false);
    expect(controller.runtime.http.status).toBe('paused');
  });
  it('keeps failed setup owned and cleanable, with retryable cleanup failures', async () => {
    const { controller, host, projected } = await sceneFixture();
    vi.mocked(host.project).mockRejectedValueOnce(new Error('projection failed'));
    await expect(controller.beginRun('run', 'other')).rejects.toThrow('projection failed');
    expect(controller.summary().runtimeRunId).toBe('run');
    vi.mocked(host.disable).mockRejectedValueOnce(new Error('detach failed'));
    await expect(controller.endRun('run')).rejects.toThrow('detach failed');
    expect(controller.summary().runtimeRunId).toBe('run');
    expect(controller.active?.id).toBe('base');
    await controller.endRun('run');
    expect(projected().http.map((item) => item.id)).toEqual(['base-low', 'base-high']);
    expect(controller.summary().runtimeRunId).toBeUndefined();
  });
  it('rejects disconnected setup and invalid fixtures before changing runtime or persistent scenes', async () => {
    const { controller, host, state } = await sceneFixture();
    state.connected = false;
    await expect(controller.beginRun('run')).rejects.toThrow('未连接');
    expect(controller.summary().runtimeRunId).toBeUndefined();
    await controller.endRun('run');
    state.connected = true;
    await expect(controller.beginRun('run', 'missing')).rejects.toThrow('不存在');
    await expect(controller.beginRun('run', undefined, [rule('base-low')])).rejects.toThrow('重复');
    expect(host.project).toHaveBeenCalledTimes(1);
    expect(controller.active?.id).toBe('base');
  });
  it('retains cleanup ownership while proxy rules are unreachable and stops a serving proxy when supported', async () => {
    const { controller, host, state } = await sceneFixture();
    await controller.beginRun('run');
    state.proxyRulesUnreachable = true;
    await expect(controller.endRun('run')).rejects.toThrow('无法确认');
    expect(controller.summary().runtimeRunId).toBe('run');
    host.stopUnreachableProxy = vi.fn(async () => {
      state.proxyRulesUnreachable = false;
      state.connected = false;
    });
    await controller.endRun('run');
    expect(host.stopUnreachableProxy).toHaveBeenCalledOnce();
    expect(controller.summary().runtimeRunId).toBeUndefined();
    expect(controller.active?.id).toBe('base');
  });
});

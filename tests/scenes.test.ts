import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneStore } from '../src/scenes';
import { validateSceneDocument, type SceneDocument } from '../src/scene-model';
import { SceneController, type SceneHost } from '../src/scene-controller';
import type { Rule } from '../src/model';
import type { WsRule } from '../src/ws/model';
import { sceneExample } from '../src/mcp/guide';

const http: Rule = {
  id: 'http-1',
  name: '订单',
  enabled: true,
  priority: 10,
  match: { path: '/orders' },
  mock: { status: 200, headers: {}, body: 'one' },
};
const ws: WsRule = {
  id: 'ws-1',
  name: '订单消息',
  enabled: true,
  priority: 10,
  match: { url: 'wss://example.test/orders' },
  action: { type: 'drop' },
};
let directory: string;
let store: SceneStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pilot-scenes-'));
  store = new SceneStore(directory);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const document = (): SceneDocument => ({
  version: 1,
  activeSceneId: null,
  scenes: [
    { id: 'one', name: '成功', httpRules: [structuredClone(http)], wsRules: [structuredClone(ws)] },
    {
      id: 'two',
      name: '失败',
      httpRules: [{ ...http, id: 'http-2', mock: { ...http.mock!, body: 'two' } }],
      wsRules: [],
    },
  ],
});
async function fixture(connected = true) {
  await writeFile(store.file, JSON.stringify(document()));
  let state = {
    key: 'connection-1',
    mode: 'vm' as 'vm' | 'proxy',
    connected,
    httpApplied: false,
    wsApplied: false,
  };
  const events: string[] = [];
  let projected: { http: Rule[]; ws: WsRule[] } = { http: [], ws: [] };
  const host: SceneHost = {
    snapshot: () => ({ ...state }),
    disable: vi.fn(async (domain: 'http' | 'ws') => {
      events.push(`off:${domain}`);
      state[`${domain}Applied`] = false;
    }),
    project: vi.fn(async (http, ws) => {
      events.push(`project:${http[0]?.id ?? ''}:${ws[0]?.id ?? ''}`);
      projected = { http, ws };
    }),
    enable: vi.fn(async (domain: 'http' | 'ws') => {
      events.push(`on:${domain}`);
      state[`${domain}Applied`] = true;
    }),
    capture: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  const controller = new SceneController(store, host);
  await controller.initialize();
  events.length = 0;
  return { controller, host, events, state, projected: () => projected };
}

describe('scene documents and project store', () => {
  it('ships valid complete scene examples in the guide and resource', async () => {
    expect(validateSceneDocument(sceneExample).activeSceneId).toBeNull();
    const example = JSON.parse(await readFile(join(process.cwd(), 'resources/example.scenes.json'), 'utf8'));
    expect(validateSceneDocument(example).scenes.length).toBeGreaterThan(0);
  });
  it('imports both legacy domains once, preserving IDs, order and enabled states', async () => {
    await writeFile(join(directory, 'rules.json'), JSON.stringify({ version: 1, rules: [http] }));
    await writeFile(join(directory, 'ws-rules.json'), JSON.stringify({ version: 1, rules: [ws] }));
    const loaded = await store.load();
    expect(loaded).toMatchObject({
      activeSceneId: null,
      scenes: [{ name: '默认场景', httpRules: [http], wsRules: [ws] }],
    });
    await writeFile(join(directory, 'rules.json'), 'invalid old file');
    expect(await store.load()).toEqual(loaded);
    expect(await readFile(join(directory, 'ws-rules.json'), 'utf8')).toContain(ws.id);
  });
  it('concurrent initialization creates one empty default scene', async () => {
    const docs = await Promise.all([store.load(), new SceneStore(directory).load(), store.load()]);
    expect(docs[0]).toEqual(docs[1]);
    expect(docs[1]).toEqual(docs[2]);
    expect(docs[0].scenes).toHaveLength(1);
    expect(docs[0].scenes[0]).toMatchObject({ name: '默认场景', httpRules: [], wsRules: [] });
  });
  it('rejects broken imports without creating the scene document', async () => {
    await writeFile(join(directory, 'rules.json'), '{secret-invalid');
    await expect(store.load()).rejects.toThrow('有效 JSON');
    await expect(readFile(store.file)).rejects.toThrow();
    expect(await readFile(join(directory, 'rules.json'), 'utf8')).toBe('{secret-invalid');
  });
  it('detects external edits and refuses to overwrite invalid or changed files', async () => {
    const before = await store.load();
    const changed = structuredClone(before);
    changed.scenes[0].name = '外部编辑';
    await writeFile(store.file, JSON.stringify(changed));
    await expect(store.save(before, before)).rejects.toThrow('已被修改');
    expect(await store.load()).toEqual(changed);
    await writeFile(store.file, 'bad');
    await expect(store.save(before, before)).rejects.toThrow();
    expect(await readFile(store.file, 'utf8')).toBe('bad');
  });
  it('does not reimport legacy files when an initialized document is removed during reload', async () => {
    await store.load();
    await rm(store.file);
    await writeFile(join(directory, 'rules.json'), JSON.stringify({ version: 1, rules: [http] }));
    await expect(store.read()).rejects.toThrow('已移除');
    await expect(readFile(store.file)).rejects.toThrow();
  });
  it('rejects duplicate rule IDs across scenes, invalid references and persistent connection rules', () => {
    const doc = document();
    doc.scenes[1].httpRules[0].id = http.id;
    expect(() => validateSceneDocument(doc)).toThrow('重复');
    expect(() => validateSceneDocument({ ...document(), activeSceneId: 'missing' })).toThrow('activeSceneId');
    const temporary = document();
    temporary.scenes[0].wsRules[0].match = { connectionId: 'old' };
    expect(() => validateSceneDocument(temporary)).toThrow('本次会话');
  });
  it('never follows a scene symlink', async () => {
    const target = join(directory, 'external.json');
    await writeFile(target, JSON.stringify(document()));
    await symlink(target, store.file);
    await expect(store.load()).rejects.toThrow('符号链接');
  });
});

describe('scene activation lifecycle', () => {
  it('replaces both protocols before enabling, then removes WS when moving to HTTP-only scene', async () => {
    const { controller, events, projected } = await fixture();
    await controller.activate('one');
    expect(events).toEqual(['off:http', 'off:ws', 'project:http-1:ws-1', 'on:http', 'on:ws']);
    expect(controller.runtime).toMatchObject({ http: { status: 'applied' }, ws: { status: 'applied' } });
    events.length = 0;
    await controller.activate('two');
    expect(events).toEqual(['off:http', 'off:ws', 'project:http-2:', 'on:http']);
    expect(projected().ws).toEqual([]);
  });
  it('keeps browsing and editing an inactive scene separate from runtime', async () => {
    const { controller, events, projected } = await fixture();
    await controller.activate('one');
    events.length = 0;
    controller.select('two');
    await controller.saveHttp([{ ...http, id: 'http-2', name: 'edited' }]);
    expect(events).toEqual([]);
    expect(projected().http[0].id).toBe('http-1');
    controller.select('one');
    await controller.saveHttp([{ ...http, name: 'active edited' }]);
    expect(events).toContain('on:http');
    expect(projected().http[0].name).toBe('active edited');
  });
  it('reloads inactive edits without uninstalling or renewing the active scene', async () => {
    const { controller, events } = await fixture();
    await controller.activate('one');
    events.length = 0;
    const doc = await store.read();
    doc.scenes[1].httpRules[0].name = 'external inactive edit';
    await writeFile(store.file, JSON.stringify(doc));
    await controller.reload();
    expect(events).toEqual([]);
    expect(controller.active?.id).toBe('one');
  });
  it('file-based activation resets capture pauses just like explicit activation', async () => {
    const { controller } = await fixture();
    await controller.activate('one');
    await controller.setCapture('http', false);
    const doc = await store.read();
    doc.activeSceneId = 'two';
    await writeFile(store.file, JSON.stringify(doc));
    await controller.reload();
    expect(controller.runtime.http.status).toBe('applied');
  });
  it('returns bounded MCP scene summaries without rule bodies', async () => {
    const { controller } = await fixture(false);
    await controller.saveHttp(
      [{ ...http, mock: { ...http.mock!, body: 'x'.repeat(5 * 1024 * 1024) } }],
      'one',
    );
    await controller.activate('one');
    const summary = controller.summary();
    expect(summary.scenes[0]).toMatchObject({ httpRuleCount: 1, enabledHttpRuleCount: 1, wsRuleCount: 1 });
    expect(JSON.stringify(summary).length).toBeLessThan(4096);
  });
  it('copies scenes with fresh rule IDs and independent contents without changing activation', async () => {
    const { controller } = await fixture();
    await controller.activate('one');
    await controller.create('副本', controller.active);
    const copy = controller.selected!;
    expect(copy.id).not.toBe('one');
    expect(copy.httpRules[0].id).not.toBe(http.id);
    expect(copy.wsRules[0].id).not.toBe(ws.id);
    await controller.saveHttp([{ ...copy.httpRules[0], name: 'copy edited' }]);
    expect(controller.active?.httpRules[0].name).toBe(http.name);
    expect(controller.document.activeSceneId).toBe('one');
  });
  it('persists offline selection, restores after reconnection and IDE reopen', async () => {
    const { controller, host, state } = await fixture(false);
    await controller.activate('one');
    expect(controller.runtime.http.status).toBe('pending');
    expect(host.enable).not.toHaveBeenCalled();
    state.connected = true;
    state.key = 'connection-2';
    await controller.reconcile();
    expect(controller.runtime.http.status).toBe('applied');
    state.connected = false;
    state.key = 'disconnected';
    await controller.reconcile();
    state.connected = true;
    state.key = 'connection-3';
    const reopened = new SceneController(store, host);
    await reopened.initialize();
    expect(reopened.active?.id).toBe('one');
    expect(reopened.runtime.ws.status).toBe('applied');
  });
  it('pauses only the requested protocol and re-enables it from the active scene', async () => {
    const { controller, host } = await fixture();
    await controller.activate('one');
    await controller.setCapture('ws', false);
    expect(host.capture).toHaveBeenLastCalledWith('ws', false);
    expect(controller.runtime).toMatchObject({ http: { status: 'applied' }, ws: { status: 'paused' } });
    await controller.setCapture('ws', true);
    expect(controller.runtime.ws.status).toBe('applied');
  });
  it('deactivation and active scene deletion clear persisted intent without disabling capture', async () => {
    const { controller, host, projected } = await fixture();
    await controller.activate('one');
    await controller.change((doc) => {
      doc.scenes = doc.scenes.filter((scene) => scene.id !== 'one');
      doc.activeSceneId = null;
    });
    expect((await store.load()).activeSceneId).toBeNull();
    expect(projected()).toEqual({ http: [], ws: [] });
    expect(host.capture).not.toHaveBeenCalled();
  });
  it('does not report success or restore old scene after partial synchronization failure', async () => {
    const { controller, host, projected } = await fixture();
    await controller.activate('one');
    vi.mocked(host.enable).mockRejectedValueOnce(new Error('sync failed'));
    await controller.activate('two');
    expect(controller.active?.id).toBe('two');
    expect(projected().http[0].id).toBe('http-2');
    expect(controller.runtime.http).toMatchObject({ status: 'error', message: 'sync failed' });
    await controller.activate('two');
    expect(controller.runtime.http.status).toBe('applied');
  });
  it('shows capture stop failures instead of claiming the domain is paused', async () => {
    const { controller, host } = await fixture();
    await controller.activate('one');
    vi.mocked(host.disable).mockRejectedValueOnce(new Error('旧租约尚未到期'));
    await expect(controller.setCapture('http', false)).rejects.toThrow('租约');
    expect(host.capture).toHaveBeenLastCalledWith('http', false);
    await controller.reconcile();
    expect(controller.runtime.http).toMatchObject({ status: 'error', message: '旧租约尚未到期' });
    await controller.setCapture('http', false);
    expect(controller.runtime.http.status).toBe('paused');
  });
  it('does not mark capture paused if the capture switch itself failed', async () => {
    const { controller, host } = await fixture();
    await controller.activate('one');
    vi.mocked(host.capture).mockRejectedValueOnce(new Error('capture failed'));
    await expect(controller.setCapture('http', false)).rejects.toThrow('capture failed');
    expect(controller.runtime.http.status).toBe('error');
    vi.mocked(host.capture).mockRejectedValueOnce(new Error('capture failed'));
    await controller.reconcile();
    expect(controller.runtime.http.status).toBe('error');
    await controller.activate('one');
    expect(controller.runtime.http.status).toBe('applied');
  });
  it('retries a paused domain resume after lease expiry without losing the requested capture state', async () => {
    const { controller, host } = await fixture();
    await controller.activate('one');
    await controller.setCapture('ws', false);
    vi.useFakeTimers();
    try {
      vi.mocked(host.capture).mockRejectedValueOnce(new Error('旧租约尚未到期，请等待16秒'));
      await expect(controller.setCapture('ws', true)).rejects.toThrow('租约');
      expect(controller.runtime.ws.status).toBe('error');
      await vi.advanceTimersByTimeAsync(16100);
      await controller.reconcile();
      expect(host.capture).toHaveBeenLastCalledWith('ws', true);
      expect(controller.runtime.ws.status).toBe('applied');
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
  it('keeps the new scene selected while waiting for old leases and retries after expiry', async () => {
    const { controller, host, events } = await fixture();
    await controller.activate('one');
    vi.useFakeTimers();
    try {
      vi.mocked(host.disable).mockRejectedValueOnce(new Error('旧租约尚未到期，请等待16秒'));
      await controller.activate('two');
      expect(controller.active?.id).toBe('two');
      expect(controller.runtime.http.status).toBe('error');
      events.length = 0;
      await vi.advanceTimersByTimeAsync(16100);
      await controller.reconcile();
      expect(controller.runtime.http.status).toBe('applied');
      expect(events).toEqual(['off:http', 'off:ws', 'project:http-2:', 'on:http']);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
  it('waits for runtime objects and marks proxy WS unsupported', async () => {
    const { controller, host, state } = await fixture();
    vi.mocked(host.enable).mockResolvedValue(undefined);
    await controller.activate('one');
    expect(controller.runtime.http.status).toBe('pending');
    state.mode = 'proxy';
    state.key = 'proxy';
    await controller.reconcile();
    expect(controller.runtime.ws.status).toBe('unsupported');
  });
  it('serializes rapid switches and ignores stale asynchronous results from an old connection', async () => {
    const { controller, host, state, events } = await fixture();
    let release!: () => void;
    vi.mocked(host.project).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const one = controller.activate('one');
    await vi.waitFor(() => expect(release).toBeDefined());
    const two = controller.activate('two');
    state.key = 'new-connection';
    release();
    await Promise.all([one, two]);
    expect(events.filter((event) => event.startsWith('on:'))).toEqual(['on:http']);
    expect(controller.active?.id).toBe('two');
  });
  it('temporary WS rules belong only to the active scene, expire and never reach disk', async () => {
    const { controller, projected } = await fixture();
    await controller.activate('one');
    const temp: WsRule = { ...ws, id: 'temp', match: { connectionId: 'current' } };
    await controller.saveWs([ws, temp], 'one');
    expect(projected().ws).toHaveLength(2);
    expect((await store.load()).scenes[0].wsRules).toHaveLength(1);
    controller.expireTemporary([]);
    await controller.reconcile();
    expect(projected().ws).toHaveLength(1);
    await controller.saveWs([ws, temp], 'one');
    await controller.activate('two');
    expect(projected().ws).toEqual([]);
    await expect(controller.saveWs([temp], 'one')).rejects.toThrow('激活场景');
  });
  it('reload validates the entire document before replacing the last good scene', async () => {
    const { controller } = await fixture();
    await controller.activate('one');
    await writeFile(store.file, 'invalid');
    await expect(controller.reload()).rejects.toThrow();
    expect(controller.active?.id).toBe('one');
  });
});

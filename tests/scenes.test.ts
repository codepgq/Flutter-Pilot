import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile, lstat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { SceneStore, cloneScenes } from '../src/scenes';
import { SceneController, type SceneHost } from '../src/scene-controller';
import { migrateScenes } from '../src/scene-migration';
import { hash, json, SceneFiles } from '../src/scene-files';
import { compileSceneAction } from '../src/workflows/model';
import type { Scene, SceneDocument } from '../src/scene-model';
import type { Rule } from '../src/model';
import { build } from 'esbuild';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';

let directory: string;
let store: SceneStore;
const rule: Rule = {
  id: '中文/特殊 ID',
  name: '订单',
  enabled: true,
  priority: 1,
  match: { path: '/orders' },
  mock: { status: 200, headers: {}, body: '\uFEFF中文\r\n\u0000特殊正文 😀\n' },
};
const scenes = (): Scene[] => [
  {
    id: '入口 / 中文',
    name: '入口',
    httpRules: [structuredClone(rule)],
    wsRules: [
      {
        id: 'ws',
        name: '消息',
        enabled: true,
        priority: 1,
        match: { url: '*' },
        action: { type: 'replace', text: '' },
      },
    ],
    actions: [
      {
        id: 'start',
        name: '入口操作',
        inputs: { password: { secret: true, required: true } },
        steps: [
          {
            id: 'call',
            type: 'call',
            sceneId: 'common',
            actionId: 'fill',
            inputs: { password: '${inputs.password}' },
          },
        ],
      },
    ],
  },
  {
    id: 'common',
    name: '公共操作',
    httpRules: [],
    wsRules: [],
    targets: { input: { source: 'flutter', key: 'password' } },
    actions: [
      {
        id: 'fill',
        name: '填表',
        inputs: { password: { secret: true, required: true } },
        steps: [
          { id: 'fill', type: 'enter_text', target: 'input', text: '${inputs.password}' },
          { id: 'hide', type: 'hide_keyboard' },
        ],
      },
    ],
  },
  {
    id: 'unrelated',
    name: '无关',
    httpRules: [{ ...rule, id: 'other', mock: { status: 200, headers: {}, body: 'untouched' } }],
    wsRules: [],
    actions: [{ id: 'idle', name: '无关操作', steps: [{ id: 'hide', type: 'hide_keyboard' }] }],
  },
];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pilot-scene-v2-'));
  store = new SceneStore(directory);
  await store.load();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  await store.importPackage({ version: 2, scenes: scenes() }, false);
}
async function bodyFile() {
  const file = store.getScene('入口 / 中文').http[0].file;
  return join(dirname(dirname(file)), JSON.parse(await readFile(file, 'utf8')).mock.bodyFile);
}
async function controllerFixture() {
  await fixture();
  const state = {
    key: 'vm',
    mode: 'vm' as 'vm' | 'proxy',
    connected: true,
    httpApplied: false,
    wsApplied: false,
    proxyRulesUnreachable: false,
  };
  const host: SceneHost = {
    snapshot: () => state,
    disable: vi.fn(async (domain: 'http' | 'ws') => {
      state[`${domain}Applied`] = false;
    }),
    project: vi.fn(async () => {}),
    enable: vi.fn(async (domain: 'http' | 'ws') => {
      state[`${domain}Applied`] = true;
    }),
    capture: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  const controller = new SceneController(store, host);
  await controller.initialize();
  return { controller, host, state };
}
describe('directory Scene repository', () => {
  it('reports stale disk configuration when body preview detects corruption in an applied Scene', async () => {
    const { controller, host } = await controllerFixture();
    await controller.activate('入口 / 中文');
    const applied = vi.mocked(host.project).mock.calls.length;
    await writeFile(await bodyFile(), Buffer.from([0xff]));
    await expect(store.getRule('入口 / 中文', 'http', rule.id)).rejects.toThrow();
    expect(controller.runtime.stale).toBeTruthy();
    expect(controller.active!.httpRules).toEqual([rule]);
    expect(host.project).toHaveBeenCalledTimes(applied);
    controller.dispose();
  });

  it('preserves unused targets and whitespace in names through migration and export', async () => {
    await rm(join(directory, 'scenes'), { recursive: true });
    const source = {
      version: 1,
      activeSceneId: null,
      scenes: [
        {
          id: 'targets-only',
          name: '  中文 名称  ',
          httpRules: [],
          wsRules: [],
          targets: { button: { source: 'flutter', key: 'button' } },
        },
      ],
    };
    await writeFile(join(directory, 'scenes.json'), json(source));
    await migrateScenes(directory, true);
    await store.reload();
    const exported = await store.exportPackage();
    expect(exported.scenes[0].name).toBe(source.scenes[0].name);
    expect(exported.scenes[0].targets).toEqual(source.scenes[0].targets);
  });
  it('rejects inconsistent scenario saves without publishing invalid source', async () => {
    await fixture();
    const first = await store.getRule('入口 / 中文', 'http', rule.id);
    await store.saveResource(
      first.address,
      { ...first.value, scenario: { id: 'group', initial: 'a', when: 'a' } },
      first.hash,
    );
    const before = await readFile(store.getScene('入口 / 中文').file, 'utf8');
    await expect(
      store.saveResource(
        { sceneId: '入口 / 中文', kind: 'http', id: 'second' },
        { ...rule, id: 'second', scenario: { id: 'group', initial: 'b', when: 'b' } },
        null,
      ),
    ).rejects.toThrow('initial');
    expect(await readFile(store.getScene('入口 / 中文').file, 'utf8')).toBe(before);
    expect(store.getScene('入口 / 中文').health).toBe('valid');
  });

  it('rejects inconsistent scenario groups before activation and retains the applied snapshot', async () => {
    const { controller, host } = await controllerFixture();
    await controller.activate('入口 / 中文');
    const previousCalls = vi.mocked(host.project).mock.calls.length;
    const source = store.getScene('入口 / 中文').http[0].file;
    const first = JSON.parse(await readFile(source, 'utf8'));
    first.scenario = { id: 'group', initial: 'a', when: 'a' };
    await writeFile(source, json(first));
    const secondFile = join(dirname(source), 'second.json');
    await writeFile(
      secondFile,
      json({ ...first, id: 'second', scenario: { id: 'group', initial: 'b', when: 'b' } }),
    );
    const manifestFile = store.getScene('入口 / 中文').file;
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.http.push({ id: 'second', file: 'second.json' });
    await writeFile(manifestFile, json(manifest));
    await expect(controller.reload()).rejects.toThrow('initial');
    expect(store.getScene('入口 / 中文').health).toBe('error');
    await expect(store.prepareSnapshot([], '入口 / 中文')).rejects.toThrow('initial');
    expect(controller.active!.httpRules).toEqual([rule]);
    expect(vi.mocked(host.project).mock.calls).toHaveLength(previousCalls);
    expect(controller.runtime.stale).toContain('initial');
    controller.dispose();
  });

  it('isolates corrupt private activation and rebuilds tampered derived caches', async () => {
    await fixture();
    await writeFile(join(store.privateDirectory, 'scene-active.json'), '{');
    const mapping = JSON.parse(await readFile(store.file, 'utf8')).scenes[0];
    const shard = join(store.privateDirectory, 'scene-cache', `${mapping.directory}.json`);
    const cached = JSON.parse(await readFile(shard, 'utf8'));
    const manifest = cached.entries.find(([path]: [string]) => path.endsWith('/scene.json'));
    delete manifest[1].value.http;
    await writeFile(shard, json(cached));
    const reopened = new SceneStore(directory);
    await reopened.load();
    expect(reopened.activeSceneId).toBeNull();
    expect(reopened.listScenes().warning).toContain('激活记录');
    expect(reopened.getScene('入口 / 中文').health).toBe('valid');
    expect(reopened.getScene('入口 / 中文').http).toHaveLength(1);
    expect(await readFile(join(store.privateDirectory, 'scene-active.json'), 'utf8')).toBe('{');
    await reopened.activate('unrelated');
    expect(reopened.listScenes().warning).toBeUndefined();
  });
  it('keeps healthy Scene writes available beside a corrupt manifest and detects repaired duplicate IDs', async () => {
    await fixture();
    const brokenFile = store.getScene('unrelated').file;
    const original = JSON.parse(await readFile(brokenFile, 'utf8'));
    await writeFile(brokenFile, '{');
    await store.reload();
    await store.saveResource(
      { sceneId: 'common', kind: 'http', id: 'new-rule' },
      { ...rule, id: 'new-rule' },
      null,
    );
    expect(store.getScene('common').health).toBe('valid');
    expect(store.getScene('unrelated').health).toBe('error');
    original.http[0].id = 'new-rule';
    await writeFile(brokenFile, json(original));
    await store.reload();
    expect(store.getScene('common').health).toBe('error');
    expect(store.getScene('unrelated').errors.join()).toContain('重复');
  });
  it('refuses imported global rule collisions before changing the root', async () => {
    await fixture();
    const root = await readFile(store.file, 'utf8');
    await expect(
      store.importPackage(
        { version: 2, scenes: [{ id: 'incoming', name: 'import', httpRules: [{ ...rule }], wsRules: [] }] },
        false,
      ),
    ).rejects.toThrow('重复');
    expect(await readFile(store.file, 'utf8')).toBe(root);
    expect(store.getScene('入口 / 中文').health).toBe('valid');
  });
  it('validates manually supplied body references before committing a save', async () => {
    await fixture();
    const current = await store.getRule('入口 / 中文', 'http', rule.id);
    const source = await readFile(current.file, 'utf8');
    const stored = JSON.parse(source);
    stored.mock.bodyFile = 'bodies/missing.txt';
    await expect(store.saveResource(current.address, stored, current.hash)).rejects.toThrow('缺失');
    expect(await readFile(current.file, 'utf8')).toBe(source);
    expect((await store.getRule('入口 / 中文', 'http', rule.id)).value).toEqual(rule);
  });
  it('refuses reorder and deletion against an externally changed root mapping', async () => {
    await fixture();
    const first = await store.getRule('入口 / 中文', 'http', rule.id);
    const root = JSON.parse(await readFile(store.file, 'utf8'));
    root.scenes.reverse();
    await writeFile(store.file, json(root));
    const source = await readFile(first.file, 'utf8');
    await expect(store.reorderRules('入口 / 中文', 'http', rule.id, rule.id, first, first)).rejects.toThrow(
      '冲突',
    );
    await expect(store.deleteResource(first.address, first.hash)).rejects.toThrow('冲突');
    expect(await readFile(first.file, 'utf8')).toBe(source);
  });
  it('exports under one lock and rejects external body changes between Scene reads', async () => {
    await fixture();
    const locked = vi.spyOn(store.files, 'locked');
    const original = (store as any).collectSnapshot.bind(store);
    let calls = 0;
    vi.spyOn(store as any, 'collectSnapshot').mockImplementation(async (...args: any[]) => {
      if (++calls === 2) await writeFile(await bodyFile(), 'external mutation');
      return original(...args);
    });
    await expect(store.exportPackage(['入口 / 中文', 'unrelated'])).rejects.toThrow('冲突');
    expect(locked).toHaveBeenCalledTimes(1);
  });

  it('resolves the Mock from action inputs under the same immutable snapshot lock', async () => {
    await fixture();
    const snapshot = await store.prepareSnapshot(
      [{ sceneId: '入口 / 中文', actionId: 'start' }],
      null,
      (actions) => {
        expect(actions.scenes.every((s) => s.httpRules.length === 0)).toBe(true);
        return compileSceneAction(actions, '入口 / 中文', 'start', { password: 'fixture' }).sceneId;
      },
    );
    expect(snapshot.activeSceneId).toBe('入口 / 中文');
    expect(snapshot.scenes[0].httpRules).toEqual([rule]);
    expect(Object.isFrozen(snapshot.scenes[0].httpRules[0].mock)).toBe(true);
  });
  it('keeps activation and the applied snapshot intact when deleting with a stale hash', async () => {
    const { controller, host } = await controllerFixture();
    await controller.activate('入口 / 中文');
    const applied = vi.mocked(host.project).mock.calls.length;
    await expect(controller.remove('入口 / 中文', 'stale')).rejects.toThrow('冲突');
    expect(controller.activeSceneId).toBe('入口 / 中文');
    expect(controller.active!.httpRules).toEqual([rule]);
    expect(host.project).toHaveBeenCalledTimes(applied);
    controller.dispose();
  });
  it('marks invalid UTF-8 bodies unhealthy only when read and keeps other Scenes usable', async () => {
    await fixture();
    await writeFile(await bodyFile(), Buffer.from([0xff, 0xfe]));
    await store.reload();

    expect(store.getScene('入口 / 中文').health).toBe('valid');
    await expect(store.getRule('入口 / 中文', 'http', rule.id)).rejects.toThrow();
    expect(store.getScene('入口 / 中文').health).toBe('error');
    await expect(store.prepareSnapshot([{ sceneId: 'unrelated', actionId: 'idle' }])).resolves.toBeDefined();
  });
  it('migrates IDs, order, UTF-8 bytes, empty bodies, selectors, calls and secrets without activation', async () => {
    await rm(join(directory, 'scenes'), { recursive: true });
    const source: SceneDocument = { version: 1, activeSceneId: '入口 / 中文', scenes: scenes() };
    await writeFile(join(directory, 'scenes.json'), json(source));
    expect(await migrateScenes(directory)).toMatchObject({
      mode: 'preflight',
      verified: true,
      previousActiveSceneId: '入口 / 中文',
    });
    await expect(lstat(store.file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await migrateScenes(directory, true)).toMatchObject({
      activeSceneId: null,
      bodyBytes: expect.any(Number),
    });
    await store.reload();
    expect((await store.exportPackage()).scenes.map((s) => s.id)).toEqual(source.scenes.map((s) => s.id));
    expect(await readFile(await bodyFile())).toEqual(Buffer.from(rule.mock!.body));
    expect(await readFile(join(directory, 'scenes.json'), 'utf8')).toBe(json(source));
    expect(store.activeSceneId).toBeNull();
    await expect(migrateScenes(directory, true)).rejects.toThrow();
  });
  it('requires explicit migration and never hides legacy data behind an empty v2 config', async () => {
    await rm(join(directory, 'scenes'), { recursive: true });
    await writeFile(
      join(directory, 'scenes.json'),
      json({ version: 1, activeSceneId: null, scenes: scenes() }),
    );
    await expect(new SceneStore(directory).load()).rejects.toThrow('迁移');
    await expect(lstat(store.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('lists and searches without bodies and loads only the action closure', async () => {
    await fixture();
    const before = store.metrics.bodyReads;
    expect(store.listScenes({ search: '填表', limit: 500 }).scenes.map((s) => s.id)).toEqual(['common']);
    expect(store.listScenes({ limit: 500 }).limit).toBe(200);
    expect(store.getScene('common').actions[0]).not.toHaveProperty('steps');
    const spy = vi.spyOn(store as any, 'text');
    const doc = await store.prepareSnapshot([{ sceneId: '入口 / 中文', actionId: 'start' }]);
    expect(doc.scenes.map((s) => s.id)).toEqual(['入口 / 中文', 'common']);
    expect(store.metrics.bodyReads).toBe(before);
    expect(
      spy.mock.calls.some(([path]) => String(path).includes('/http/') || String(path).includes('/ws/')),
    ).toBe(false);
    expect(compileSceneAction(doc, '入口 / 中文', 'start', { password: 'secret' }).secrets).toEqual([
      'secret',
    ]);
    expect(Object.isFrozen(doc.scenes[0].actions![0].steps)).toBe(true);
  });
  it('keeps selected resource edits incremental and refuses external rule or body edits', async () => {
    await fixture();
    const resource = await store.getRule('入口 / 中文', 'http', rule.id),
      other = store.getScene('unrelated').http[0].file;
    const unrelated = await lstat(other),
      root = await readFile(store.file),
      manifest = await readFile(store.getScene('入口 / 中文').file);
    await store.saveResource(resource.address, { ...resource.value, name: '更名' }, resource.hash);
    expect(await readFile(store.file)).toEqual(root);
    expect(await readFile(store.getScene('入口 / 中文').file)).toEqual(manifest);
    expect((await lstat(other)).mtimeMs).toBe(unrelated.mtimeMs);
    await expect(store.saveResource(resource.address, resource.value, resource.hash)).rejects.toThrow('冲突');
    const latest = await store.getRule('入口 / 中文', 'http', rule.id);
    await writeFile(await bodyFile(), 'human edit');
    await expect(store.saveResource(latest.address, latest.value, latest.hash)).rejects.toThrow('冲突');
    expect(await readFile(await bodyFile(), 'utf8')).toBe('human edit');
  });
  it('rejects traversal, symlink bodies and mutually specified inline/file bodies', async () => {
    await fixture();
    const file = store.getScene('入口 / 中文').http[0].file;
    const stored = JSON.parse(await readFile(file, 'utf8'));
    for (const bodyFile of ['../outside', 'bodies/../outside', '/tmp/outside', 'bodies/sub/file']) {
      await writeFile(file, json({ ...stored, mock: { ...stored.mock, bodyFile } }));
      await store.reload();
      expect(store.listScenes().scenes[0].health).toBe('error');
    }
    await writeFile(file, json({ ...stored, mock: { ...stored.mock, body: 'ambiguous' } }));
    await store.reload();
    expect(store.getScene('入口 / 中文').errors.join(' ')).toContain('互斥');
    await writeFile(file, json(stored));
    await store.reload();
    const body = await bodyFile();
    await rm(body);
    await symlink(store.file, body);
    await expect(store.getRule('入口 / 中文', 'http', rule.id)).rejects.toThrow('符号链接');
  });
  it('isolates corrupt scenes, detects all global ID owners and blocks callers', async () => {
    await fixture();
    await writeFile(store.getScene('common').actions[0].file, '{broken');
    await store.reload();
    expect(store.getScene('common').health).toBe('error');
    expect(store.getScene('入口 / 中文').actions[0].blocked).toContain('依赖不可用');
    expect(await store.prepareSnapshot([{ sceneId: 'unrelated', actionId: 'idle' }])).toHaveProperty(
      'scenes',
    );
    const other = store.getScene('unrelated'),
      manifest = JSON.parse(await readFile(other.file, 'utf8'));
    manifest.http[0].id = rule.id;
    await writeFile(other.file, json(manifest));
    await store.reload();
    expect(store.getScene('入口 / 中文').health).toBe('error');
    expect(store.getScene('unrelated').health).toBe('error');
  });
  it('rejects missing calls, cycles and parameter errors before execution', async () => {
    await fixture();
    const file = store.getScene('common').actions[0].file,
      original = JSON.parse(await readFile(file, 'utf8'));
    for (const steps of [
      [{ id: 'call', type: 'call', sceneId: 'missing', actionId: 'a' }],
      [
        {
          id: 'call',
          type: 'call',
          sceneId: '入口 / 中文',
          actionId: 'start',
          inputs: { password: '${inputs.password}' },
        },
      ],
      [{ id: 'bad', type: 'enter_text', target: 'missing', text: '${inputs.password}' }],
    ]) {
      await writeFile(file, json({ ...original, steps }));
      await store.reload();
      await expect(store.prepareSnapshot([{ sceneId: '入口 / 中文', actionId: 'start' }])).rejects.toThrow();
    }
  });
  it('retains the last directory snapshot when the root is corrupt', async () => {
    await fixture();
    const old = store.listScenes().scenes;
    await writeFile(store.file, '{');
    await expect(store.reload()).rejects.toThrow();
    expect(store.listScenes().scenes).toEqual(old);
    expect(store.listScenes().error).toBeTruthy();
    await expect(store.prepareSnapshot([], '入口 / 中文')).rejects.toThrow();
    const reopened = new SceneStore(directory);
    await reopened.load();
    expect(reopened.listScenes().scenes).toEqual(old);
    expect(reopened.listScenes().error).toContain('有效 JSON');
    await expect(reopened.getAction('common', 'fill')).rejects.toThrow('有效 JSON');
    const recovered = new SceneController(reopened, {
      snapshot: () => ({ key: 'off', mode: 'vm', connected: false, httpApplied: false, wsApplied: false }),
      disable: async () => {},
      project: async () => {},
      enable: async () => {},
      capture: async () => {},
      changed: () => {},
    });
    await recovered.initialize();
    expect(recovered.summary().error).toContain('有效 JSON');
    recovered.dispose();
    await rm(store.file);
    const missingRoot = new SceneStore(directory);
    await missingRoot.load();
    expect(missingRoot.listScenes().scenes).toEqual(old);
    expect(missingRoot.listScenes().error).toContain('缺失');
    await expect(lstat(store.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('uses private workspace activation and immutable Mock snapshots', async () => {
    const { controller, host } = await controllerFixture();
    const root = await readFile(store.file);
    await controller.activate('入口 / 中文');
    expect(await readFile(store.file)).toEqual(root);
    expect(host.project).toHaveBeenLastCalledWith([rule], expect.any(Array));
    const snapshot = await store.prepareSnapshot(
      [{ sceneId: '入口 / 中文', actionId: 'start' }],
      '入口 / 中文',
    );
    await writeFile(await bodyFile(), 'new disk body');
    expect(snapshot.scenes[0].httpRules[0].mock!.body).toBe(rule.mock!.body);
    await controller.beginRun('run', undefined, [], { snapshot });
    expect(controller.active!.httpRules[0].mock!.body).toBe(rule.mock!.body);
    await expect(controller.activate(null)).rejects.toThrow('测试运行');
    await controller.endRun('run');
    const reopened = new SceneStore(directory);
    await reopened.load();
    expect(reopened.activeSceneId).toBe('入口 / 中文');
    const isolated = new SceneStore(directory, join(directory, 'other-private'));
    await isolated.load();
    expect(isolated.activeSceneId).toBeNull();
    controller.dispose();
  });
  it('keeps last valid applied rules with a stale warning after body loss', async () => {
    const { controller, host } = await controllerFixture();
    await controller.activate('入口 / 中文');
    const calls = vi.mocked(host.project).mock.calls.length;
    await rm(await bodyFile());
    await expect(controller.reload()).rejects.toThrow('缺失');
    expect(controller.runtime.stale).toContain('缺失');
    expect(controller.active!.httpRules).toEqual([rule]);
    expect(host.project).toHaveBeenCalledTimes(calls);
    await expect(controller.activate('入口 / 中文')).rejects.toThrow('缺失');
    controller.dispose();
  });
  it('appends a self-contained package with rewritten group calls and no activation changes', async () => {
    await fixture();
    await store.activate('unrelated');
    const pkg = await store.exportPackage(['入口 / 中文']);
    expect(pkg.scenes.map((s) => s.id)).toEqual(['入口 / 中文', 'common']);
    const ids = await store.importPackage(pkg);
    expect(store.activeSceneId).toBe('unrelated');
    const action = (await store.getAction(ids[0], 'start')).value;
    expect(action.steps[0]).toMatchObject({ sceneId: ids[1], actionId: 'fill' });
    expect(cloneScenes(pkg.scenes)[0].id).not.toBe(pkg.scenes[0].id);
  });
});

describe('real process write coordination', () => {
  async function worker(contents: string) {
    const file = join(directory, 'worker.cjs');
    await build({
      stdin: {
        contents: `import { SceneStore } from ${JSON.stringify(resolve('src/scenes.ts'))};\n${contents}`,
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      outfile: file,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    return file;
  }
  it('serializes two processes and rejects the loser without overwriting the winner', async () => {
    await fixture();
    const file = await worker(
      `
      const store = new SceneStore(process.argv[2]);
      await store.load();
      const resource = await store.getRule('入口 / 中文', 'http', '中文/特殊 ID');
      process.on('message', async () => {
        try { await store.saveResource(resource.address, { ...resource.value, name: process.argv[3] }, resource.hash); process.send({ ok: true }); }
        catch (e) { process.send({ ok: false, error: e.message }); }
        process.disconnect();
      });
      process.send({ ready: true });
    `.replace('const store =', '(async () => { const store =') + '\n})();',
    );
    const children = ['one', 'two'].map((name) =>
      fork(file, [directory, name], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }),
    );
    try {
      const outcomes = children.map(
        (child) =>
          new Promise<any>((resolve, reject) => {
            child.on('message', (m: any) => {
              if (!m.ready) resolve(m);
            });
            child.on('error', reject);
          }),
      );
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once('message', () => resolve());
              child.once('error', reject);
              child.once('exit', (code) => {
                if (code) reject(new Error(`worker exited ${code}`));
              });
            }),
        ),
      );
      for (const child of children) child.send('save');
      const results = await Promise.all(outcomes);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok).error).toContain('冲突');
      await store.reload();
      expect(['one', 'two']).toContain((await store.getRule('入口 / 中文', 'http', rule.id)).value.name);
    } finally {
      for (const child of children) child.kill();
    }
  });
  it('recovers the durable transaction after a writer process exits at journal publication', async () => {
    await fixture();
    const file = await worker(`(async () => {
      const store = new SceneStore(process.argv[2], undefined, phase => { if (phase === 'journal') process.exit(42); });
      await store.load();
      const resource = await store.getRule('入口 / 中文', 'http', '中文/特殊 ID');
      await store.saveResource(resource.address, { ...resource.value, name: 'recovered process' }, resource.hash);
    })();`);
    const child = fork(file, [directory], { stdio: 'ignore' });
    expect(await new Promise((resolve) => child.once('exit', resolve))).toBe(42);
    const reopened = new SceneStore(directory);
    await reopened.load();
    expect((await reopened.getRule('入口 / 中文', 'http', rule.id)).value.name).toBe('recovered process');
    await expect(lstat(join(directory, '.scene-transaction.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
describe('project writes and recovery', () => {
  it('serializes independent stores and rejects a stale writer', async () => {
    await fixture();
    const second = new SceneStore(directory);
    await second.load();
    const a = await store.getRule('入口 / 中文', 'http', rule.id),
      b = await second.getRule('入口 / 中文', 'http', rule.id);
    const results = await Promise.allSettled([
      store.saveResource(a.address, { ...a.value, name: 'a' }, a.hash),
      second.saveResource(b.address, { ...b.value, name: 'b' }, b.hash),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  for (const phase of ['journal', 'replace'])
    it(`recovers interruption after ${phase}`, async () => {
      const files = new SceneFiles(directory, (actual, index) => {
        if (actual === phase && index === 0) throw new Error('interrupted');
      });
      const changes = ['a', 'b'].map((name) => ({ path: `scenes/${name}.txt`, expected: null, text: name }));
      await expect(files.locked(() => files.commit(changes))).rejects.toThrow('interrupted');
      await new SceneFiles(directory).locked(async () => {});
      expect(await readFile(join(directory, 'scenes/a.txt'), 'utf8')).toBe('a');
      expect(await readFile(join(directory, 'scenes/b.txt'), 'utf8')).toBe('b');
      await expect(lstat(join(directory, '.scene-transaction.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  it('stops recovery before any additional replace when a human changed a transaction file', async () => {
    const files = new SceneFiles(directory, (phase) => {
      if (phase === 'journal') throw new Error('crash');
    });
    await expect(
      files.locked(() =>
        files.commit([
          { path: 'scenes/a', expected: null, text: 'agent' },
          { path: 'scenes/b', expected: null, text: 'agent' },
        ]),
      ),
    ).rejects.toThrow();
    await writeFile(join(directory, 'scenes/b'), 'human');
    await expect(new SceneFiles(directory).locked(async () => {})).rejects.toThrow('冲突');
    expect(await readFile(join(directory, 'scenes/b'), 'utf8')).toBe('human');
    await expect(lstat(join(directory, 'scenes/a'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, '.scene-transaction.json'), 'utf8')).toContain('scenes/a');
  });
});

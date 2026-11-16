import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, lstat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SceneStore } from '../src/scenes';
import { json } from '../src/scene-files';

it('indexes 1000 Scenes / 20000 rules / 5000 actions with >64 MiB external bodies and records measured timings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-scale-'));
  try {
    const index = {
      version: 2,
      scenes: Array.from({ length: 1000 }, (_, i) => ({ id: `scene-${i}`, directory: `directory-${i}` })),
    };
    await mkdir(join(root, 'scenes'));
    await writeFile(join(root, 'scenes/index.json'), json(index));
    const body = '中文数据'.repeat(350);
    for (let start = 0; start < 1000; start += 20)
      await Promise.all(
        index.scenes.slice(start, start + 20).map(async (scene, offset) => {
          const i = start + offset,
            base = join(root, 'scenes', scene.directory);
          await Promise.all(
            ['http', 'ws', 'actions', 'bodies'].map((dir) => mkdir(join(base, dir), { recursive: true })),
          );
          const http = Array.from({ length: 20 }, (_, r) => ({ id: `rule-${i}-${r}`, file: `${r}.json` }));
          const actions = Array.from({ length: 5 }, (_, a) => ({ id: `action-${a}`, file: `${a}.json` }));
          await writeFile(
            join(base, 'scene.json'),
            json({ id: scene.id, name: `场景 ${i}`, http, ws: [], actions }),
          );
          await writeFile(join(base, 'targets.json'), '{}');
          await Promise.all(
            http.map(async (r, n) => {
              await writeFile(
                join(base, 'http', r.file),
                json({
                  id: r.id,
                  name: `规则 ${n}`,
                  enabled: true,
                  priority: n,
                  match: { path: `/api/${i}/${n}` },
                  mock: { status: 200, headers: {}, bodyFile: `bodies/${n}.txt` },
                }),
              );
              await writeFile(join(base, 'bodies', `${n}.txt`), body);
            }),
          );
          await Promise.all(
            actions.map(async (a) =>
              writeFile(
                join(base, 'actions', a.file),
                json({
                  id: a.id,
                  name: `操作 ${a.id}`,
                  steps:
                    i === 0 && a.id === 'action-0'
                      ? [{ id: 'call', type: 'call', sceneId: 'scene-1', actionId: 'action-0' }]
                      : [{ id: 'hide', type: 'hide_keyboard' }],
                }),
              ),
            ),
          );
        }),
      );
    const store = new SceneStore(root),
      coldStart = performance.now();
    await store.load();
    const coldMs = performance.now() - coldStart;
    expect(store.metrics.bodyReads).toBe(0);
    expect(store.listScenes().scenes).toHaveLength(50);
    expect(store.listScenes().total).toBe(1000);
    const searchStart = performance.now();
    expect(store.listScenes({ search: '场景 999' }).scenes).toHaveLength(1);
    const searchMs = performance.now() - searchStart;
    const warm = new SceneStore(root),
      warmStart = performance.now();
    await warm.load();
    const warmMs = performance.now() - warmStart;
    expect(warm.metrics.bodyReads).toBe(0);
    const readBefore = warm.metrics.reads,
      snapshot = await warm.prepareSnapshot([{ sceneId: 'scene-0', actionId: 'action-0' }]);
    expect(snapshot.scenes.map((s) => s.id)).toEqual(['scene-0', 'scene-1']);
    expect(warm.metrics.bodyReads).toBe(0);
    expect(warm.metrics.reads - readBefore).toBeLessThan(20);
    const editReadsBefore = store.metrics.reads;
    const unrelated = store.getScene('scene-999').http[19].file,
      before = await lstat(unrelated);
    const rootBefore = await readFile(store.file),
      resource = await store.getRule('scene-0', 'http', 'rule-0-0');
    await store.saveResource(resource.address, { ...resource.value, name: '修改单项' }, resource.hash);
    expect((await lstat(unrelated)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(store.file)).toEqual(rootBefore);
    const report = {
      sceneCount: 1000,
      ruleCount: 20000,
      actionCount: 5000,
      bodyBytes: Buffer.byteLength(body) * 20000,
      coldMs,
      warmMs,
      searchMs,
      coldReads: editReadsBefore,
      singleEditReads: store.metrics.reads - editReadsBefore,
      warmReads: warm.metrics.reads,
      listBodyReads: 0,
      pageBytes: Buffer.byteLength(JSON.stringify(warm.listScenes())),
      closureSceneCount: snapshot.scenes.length,
    };
    expect(report.bodyBytes).toBeGreaterThan(64 * 1024 * 1024);
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/scene-storage-scale.json', json(report));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

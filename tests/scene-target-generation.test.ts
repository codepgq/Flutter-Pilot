import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneStore } from '../src/scenes';
import { SceneController, type SceneHost } from '../src/scene-controller';

const directories: string[] = [];
const controllers: SceneController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-scene-target-'));
  directories.push(directory);
  const store = new SceneStore(directory);
  await store.load();
  await store.importPackage(
    {
      version: 2,
      scenes: [
        {
          id: 'scene',
          name: 'scene',
          wsRules: [],
          httpRules: [
            {
              id: 'rule',
              name: 'rule',
              enabled: true,
              priority: 0,
              match: { path: '/sentinel' },
              mock: { status: 200, headers: {}, body: 'sentinel' },
            },
          ],
        },
      ],
    },
    false,
  );
  const state = {
    key: 'runtime-state',
    targetKey: 'runtime:g1',
    mode: 'vm' as const,
    connected: true,
    httpApplied: true,
    wsApplied: false,
  };
  const host: SceneHost = {
    snapshot: () => state,
    disable: vi.fn(async () => {}),
    project: vi.fn(async () => {}),
    enable: vi.fn(async () => {}),
    capture: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  const controller = new SceneController(store, host);
  controllers.push(controller);
  await controller.initialize();
  vi.clearAllMocks();
  return { controller, store, host, state };
}

describe('Scene target generations', () => {
  it('rejects a queued old-generation activation before reading or mutating its target', async () => {
    const { controller, host, state, store } = await fixture();
    const read = vi.spyOn(store, 'prepareSnapshot');
    const operation = controller.activate('scene');
    state.targetKey = 'runtime:g2';
    await expect(operation).rejects.toMatchObject({ code: 'TARGET_STALE' });
    expect(read).not.toHaveBeenCalled();
    expect(host.disable).not.toHaveBeenCalled();
    expect(store.activeSceneId).toBeNull();
  });

  it('does not persist activation when snapshot loading finishes on a newer generation', async () => {
    const { controller, host, state, store } = await fixture();
    const entered = deferred(),
      release = deferred();
    const prepare = store.prepareSnapshot.bind(store);
    vi.spyOn(store, 'prepareSnapshot').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return prepare(...args);
    });
    const operation = controller.activate('scene');
    const result = expect(operation).rejects.toMatchObject({ code: 'TARGET_STALE' });
    await entered.promise;
    state.targetKey = 'runtime:g2';
    release.resolve();
    await result;
    expect(store.activeSceneId).toBeNull();
    expect(host.disable).not.toHaveBeenCalled();
  });

  it.each(['disable', 'project', 'enable'] as const)(
    'stops after a late %s result without continuing side effects or marking the successor applied',
    async (step) => {
      const { controller, host, state } = await fixture();
      const entered = deferred(),
        release = deferred();
      vi.mocked(host[step]).mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      const operation = controller.activate('scene');
      const result = expect(operation).rejects.toMatchObject({ code: 'TARGET_STALE' });
      await entered.promise;
      state.targetKey = 'runtime:g2';
      release.resolve();
      await result;
      if (step === 'disable') {
        expect(host.disable).toHaveBeenCalledTimes(1);
        expect(host.project).not.toHaveBeenCalled();
      }
      if (step !== 'enable') expect(host.enable).not.toHaveBeenCalled();
      expect(controller.runtime.http.status).toBe('pending');
    },
  );

  it('does not replay a capture change after its in-flight target disappears', async () => {
    const { controller, host, state } = await fixture();
    const entered = deferred(),
      release = deferred();
    vi.mocked(host.capture).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const operation = controller.setCapture('http', true);
    const result = expect(operation).rejects.toMatchObject({ code: 'TARGET_STALE' });
    await entered.promise;
    state.targetKey = 'runtime:g2';
    release.resolve();
    await result;
    expect(host.project).not.toHaveBeenCalled();
    await controller.reconcile();
    expect(host.capture).toHaveBeenCalledTimes(1);
  });

  it('does not create a temporary run after preflight snapshot loading changes generation', async () => {
    const { controller, host, state, store } = await fixture();
    const entered = deferred(),
      release = deferred();
    const prepare = store.prepareSnapshot.bind(store);
    vi.spyOn(store, 'prepareSnapshot').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return prepare(...args);
    });
    const operation = controller.beginRun('run', 'scene');
    const result = expect(operation).rejects.toMatchObject({ code: 'TARGET_STALE' });
    await entered.promise;
    state.targetKey = 'runtime:g2';
    release.resolve();
    await result;
    expect(controller.summary().runtimeRunId).toBeUndefined();
    expect(host.disable).not.toHaveBeenCalled();
  });

  it('does not apply or restore an earlier temporary run onto a replacement target', async () => {
    const { controller, host, state } = await fixture();
    await controller.beginRun('run', 'scene');
    vi.clearAllMocks();
    state.targetKey = 'runtime:g2';
    await expect(controller.reconcile()).rejects.toMatchObject({ code: 'TARGET_STALE' });
    await expect(controller.endRun('run')).rejects.toMatchObject({ code: 'TARGET_STALE' });
    expect(host.disable).not.toHaveBeenCalled();
    expect(host.project).not.toHaveBeenCalled();
    expect(host.enable).not.toHaveBeenCalled();
    expect(controller.runtime.http.status).not.toBe('applied');
    expect(controller.abandonInvalidatedRun('another-run')).toBe(false);
    expect(controller.abandonInvalidatedRun('run')).toBe(true);
    expect(controller.summary().runtimeRunId).toBeUndefined();
    expect(host.project).not.toHaveBeenCalled();
    await controller.activate('scene');
    expect(host.project).toHaveBeenCalledTimes(1);
  });
});

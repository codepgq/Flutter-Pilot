import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneStore } from '../src/scenes';
import { SceneController, type SceneHost } from '../src/scene-controller';

let directory: string;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'pilot-runtime-review-'));
  const store = new SceneStore(directory);
  await store.load();
  await store.importPackage(
    {
      version: 2,
      scenes: [
        {
          id: 'a',
          name: 'a',
          httpRules: [
            {
              id: 'r',
              name: 'r',
              priority: 1,
              enabled: true,
              match: { path: '/' },
              mock: { status: 200, headers: {}, body: 'body' },
            },
          ],
          wsRules: [],
        },
      ],
    },
    false,
  );
  const state = {
    key: 'proxy',
    mode: 'proxy' as const,
    connected: true,
    proxyRulesUnreachable: false,
    httpApplied: true,
    wsApplied: false,
  };
  const host: SceneHost = {
    snapshot: () => state,
    project: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    enable: vi.fn(async () => {}),
    capture: vi.fn(async () => {}),
    changed: vi.fn(),
    stopUnreachableProxy: vi.fn(async () => {
      state.proxyRulesUnreachable = false;
      state.connected = false;
    }),
  };
  const controller = new SceneController(store, host);
  await controller.initialize();
  await controller.activate('a');
  return { store, controller, state, host };
}
describe('reviewed runtime failure handling', () => {
  it.each(['scene', 'rule'] as const)(
    'stops an unreachable proxy after committing %s deletion',
    async (kind) => {
      const { store, controller, state, host } = await fixture();
      const original = (kind === 'scene' ? store.deleteScene : store.deleteResource).bind(store) as any;
      vi.spyOn(store, kind === 'scene' ? 'deleteScene' : 'deleteResource').mockImplementation(
        async (...args: any[]) => {
          await original(...args);
          state.proxyRulesUnreachable = true;
        },
      );
      if (kind === 'scene') await controller.remove('a', store.getScene('a').hash);
      else {
        const rule = await store.getRule('a', 'http', 'r');
        await controller.deleteResource(rule.address, rule.hash);
      }
      expect(host.stopUnreachableProxy).toHaveBeenCalledTimes(1);
      expect(controller.active?.httpRules ?? []).toEqual([]);
      expect(controller.runtime.http.status).toBe('unneeded');
      controller.dispose();
    },
  );
  it('retains last applied snapshot when the proxy stop cannot be confirmed, and recovers after stop', async () => {
    const { store, controller, state, host } = await fixture();
    const original = store.deleteScene.bind(store);
    vi.spyOn(store, 'deleteScene').mockImplementation(async (...args) => {
      await original(...args);
      state.proxyRulesUnreachable = true;
    });
    vi.mocked(host.stopUnreachableProxy!).mockResolvedValue();
    await expect(controller.remove('a', store.getScene('a').hash)).rejects.toThrow('无法确认');
    expect(controller.active?.httpRules[0].id).toBe('r');
    expect(controller.runtime.stale).toContain('无法确认');
    expect(controller.summary().activeScene).toEqual({ id: 'a', name: 'a' });
    expect(controller.runtime.http.status).toBe('error');
    expect(controller.runtime.http.status).not.toBe('unneeded');
    state.proxyRulesUnreachable = false;
    await controller.reload();
    expect(controller.active).toBeUndefined();
    expect(controller.runtime.stale).toBeUndefined();
    controller.dispose();
  });
  it('rejects malformed temporary rules and inactive targets without changing the snapshot', async () => {
    const { controller } = await fixture();
    const temporary = {
      id: 'temp',
      name: 'temp',
      enabled: true,
      priority: 1,
      match: { connectionId: 'socket' },
      action: { type: 'replace' as const, text: 'replacement' },
    };
    await expect(controller.saveTemporary([temporary], 'other')).rejects.toThrow('当前激活');
    await expect(
      controller.saveTemporary([{ ...temporary, action: { type: 'drop', text: 'invalid' } }]),
    ).rejects.toThrow('不接受');
    expect(controller.wsRules()).toEqual([]);
    await controller.saveTemporary([temporary], 'a');
    expect(controller.wsRules()).toEqual([temporary]);
    controller.dispose();
  });
});

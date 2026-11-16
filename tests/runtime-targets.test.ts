import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeTargetRegistry,
  runtimeExecutionKey,
  runtimeGenerationKey,
  runtimeProjectKey,
  runtimeTargetKey,
  type RuntimeTarget,
} from '../src/runtime/targets';

function flutter(runtimeId = 'flutter-1', overrides: Partial<RuntimeTarget> = {}) {
  return {
    projectId: 'project',
    workspacePath: '/workspace',
    runtimeId,
    kind: 'flutter' as const,
    sessionId: runtimeId,
    capabilities: { 'http.history': { supported: true as const } },
    ...overrides,
  };
}

describe('明确运行目标与代次', () => {
  it('唯一连接兼容默认选择和旧 Flutter sessionId，多候选必须明确选择', () => {
    const registry = new RuntimeTargetRegistry();
    const first = registry.register(flutter());
    expect(registry.resolve()).toEqual(first);
    expect(registry.resolve({ sessionId: first.sessionId })).toEqual(first);
    const second = registry.register(flutter('flutter-2'));
    expect(() => registry.resolve()).toThrowError(expect.objectContaining({ code: 'TARGET_AMBIGUOUS' }));
    expect(registry.resolve({ runtimeId: second.runtimeId })).toEqual(second);
    expect(() => registry.resolve({ sessionId: 'missing' })).toThrowError(
      expect.objectContaining({ code: 'TARGET_NOT_FOUND' }),
    );
  });

  it('不把旧 sessionId 解析到代理或浏览器，不因能力筛选静默更换目标', () => {
    const registry = new RuntimeTargetRegistry();
    registry.register(flutter('flutter'));
    registry.register(flutter('proxy', { kind: 'proxy', sessionId: 'old-session' }));
    expect(() => registry.resolve({ sessionId: 'old-session' })).toThrowError(
      expect.objectContaining({ code: 'TARGET_NOT_FOUND' }),
    );
    expect(() => registry.resolve({}, 'ui.actions')).toThrowError(
      expect.objectContaining({ code: 'TARGET_AMBIGUOUS' }),
    );
  });

  it('同 UUID 不同工作区、同项目多个运行时拥有独立状态键', () => {
    const registry = new RuntimeTargetRegistry();
    const first = registry.register(flutter('same'));
    const other = registry.register(flutter('same', { workspacePath: '/other' }));
    expect(runtimeProjectKey(first)).not.toBe(runtimeProjectKey(other));
    expect(runtimeTargetKey(first)).not.toBe(runtimeTargetKey(other));
    expect(runtimeGenerationKey(first)).not.toBe(runtimeGenerationKey(other));
    expect(() => registry.resolve({ runtimeId: 'same' })).toThrowError(
      expect.objectContaining({ code: 'TARGET_AMBIGUOUS' }),
    );
    registry.invalidate(first);
    expect(registry.resolve({ workspacePath: '/other' })).toEqual(other);
    const second = registry.register(flutter('second'));
    expect(runtimeGenerationKey(first)).not.toBe(runtimeGenerationKey(second));
  });

  it('断线、失效代次与不支持能力在调用适配器前拒绝', async () => {
    const registry = new RuntimeTargetRegistry();
    const first = registry.register(flutter());
    const operation = vi.fn(async () => 'sent');
    await expect(registry.run(first, 'ui.actions', operation)).rejects.toMatchObject({
      code: 'TARGET_UNSUPPORTED',
    });
    registry.invalidate(first);
    expect(() => registry.resolve({ runtimeId: first.runtimeId })).toThrowError(
      expect.objectContaining({ code: 'TARGET_DISCONNECTED' }),
    );
    await expect(registry.run(first, 'http.history', operation)).rejects.toMatchObject({
      code: 'TARGET_DISCONNECTED',
    });
    registry.register(flutter());
    await expect(registry.run(first, 'http.history', operation)).rejects.toMatchObject({
      code: 'TARGET_STALE',
    });
    expect(operation).not.toHaveBeenCalled();
    expect(() => registry.resolve({ runtimeId: first.runtimeId, generation: first.generation })).toThrowError(
      expect.objectContaining({ code: 'TARGET_STALE' }),
    );
  });

  it('迟到响应与旧连接断线不复活、不失效新代次，不重放操作', async () => {
    const registry = new RuntimeTargetRegistry();
    const first = registry.register(flutter());
    let complete!: (value: string) => void;
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = registry.run(first, 'http.history', operation);
    const second = registry.register(flutter());
    expect(registry.invalidate(first)).toBe(false);
    complete('old response');
    await expect(pending).rejects.toMatchObject({ code: 'TARGET_STALE' });
    expect(registry.resolve({ runtimeId: second.runtimeId })).toEqual(second);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('已启动操作固定原目标，其他目标切换或断开不会重定向结果', async () => {
    const registry = new RuntimeTargetRegistry();
    const first = registry.register(flutter());
    let complete!: (value: string) => void;
    const pending = registry.run(first, 'http.history', async (target) => {
      expect(target).toEqual(first);
      return new Promise<string>((resolve) => {
        complete = resolve;
      });
    });
    const second = registry.register(flutter('second'));
    registry.resolve({ runtimeId: second.runtimeId });
    registry.invalidate(second);
    complete('original target');
    await expect(pending).resolves.toBe('original target');
  });

  it('页面共享 Context 执行锁但保留各自身份，不同 Context 与工作区独立', () => {
    const registry = new RuntimeTargetRegistry();
    const page = registry.register(flutter('page-1', { kind: 'browser', executionScope: 'context-1' }));
    const sibling = registry.register(flutter('page-2', { kind: 'browser', executionScope: 'context-1' }));
    const other = registry.register(flutter('page-3', { kind: 'browser', executionScope: 'context-2' }));
    expect(runtimeExecutionKey(page)).toBe(runtimeExecutionKey(sibling));
    expect(runtimeTargetKey(page)).not.toBe(runtimeTargetKey(sibling));
    expect(runtimeExecutionKey(page)).not.toBe(runtimeExecutionKey(other));
    expect(runtimeExecutionKey(page)).not.toBe(runtimeExecutionKey({ ...page, workspacePath: '/other' }));
  });

  it('能力覆盖范围与注册结果为快照，不允许调用方改变目标身份和代次', () => {
    const registry = new RuntimeTargetRegistry();
    const coverage = ['text/json'];
    const input = flutter('first', { capabilities: { 'http.history': { supported: true, coverage } } });
    const target = registry.register(input);
    coverage.push('binary');
    expect(target.capabilities['http.history']).toEqual({ supported: true, coverage: ['text/json'] });
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.capabilities)).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VmAutoConnector, type VmDiscoveredCandidate } from '../src/vm/autoConnect';

const candidate = (id = 'one', url = 'ws://127.0.0.1:1234/secret=/ws'): VmDiscoveredCandidate => ({
  id,
  name: `Flutter ${id}`,
  device: 'iPhone Simulator',
  endpoint: '127.0.0.1:1234',
  source: 'debug-event',
  url,
});
const connectors: VmAutoConnector[] = [];
function fixture() {
  let status: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  let connectHook: (() => Promise<void>) | undefined;
  const connection = {
    status: () => status,
    connect: vi.fn(async (_url: string) => {
      status = 'connecting';
      connector.connectionChanged();
      try {
        await connectHook?.();
        status = 'connected';
      } catch (error) {
        status = 'disconnected';
        throw error;
      } finally {
        connector.connectionChanged();
      }
    }),
    disconnect: vi.fn(async () => {
      status = 'disconnected';
      connector.connectionChanged();
    }),
  };
  const connector = new VmAutoConnector(connection);
  connectors.push(connector);
  return {
    connector,
    connection,
    hook: (hook: () => Promise<void>) => (connectHook = hook),
    setStatus: (next: typeof status) => {
      status = next;
      connector.connectionChanged();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const connector of connectors.splice(0)) connector.dispose();
  vi.useRealTimers();
});

describe('VM 自动连接调度', () => {
  it('初始化完成并启用后才连接唯一会话，摘要不泄漏认证 URL', async () => {
    const { connector, connection } = fixture();
    connector.setCandidates([candidate()]);
    await flush();
    expect(connection.connect).not.toHaveBeenCalled();
    connector.setAvailability('ready');
    connector.setEnabled(true);
    await flush();
    expect(connection.connect).toHaveBeenCalledExactlyOnceWith(candidate().url);
    expect(connector.snapshot.candidates[0].status).toBe('connected');
    expect(connector.snapshot.connectedSessionId).toBe('one');
    expect(JSON.stringify(connector.snapshot)).not.toContain('secret=');
    expect(JSON.stringify(connector.snapshot)).not.toContain('"url"');
  });

  it('多个会话等待选择，重复候选和连接通知不重复连接', async () => {
    const { connector, connection } = fixture();
    connector.setCandidates([candidate(), candidate('two')]);
    connector.setEnabled(true);
    await flush();
    expect(connection.connect).not.toHaveBeenCalled();
    await connector.select('two');
    connector.setCandidates([candidate(), candidate('two')]);
    connector.connectionChanged();
    await flush();
    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(connector.snapshot.connectedSessionId).toBe('two');
    await expect(connector.select('one')).rejects.toThrow('先断开');
  });

  it('手动连接优先；发现会话和会话停止不会触碰手动连接', async () => {
    const { connector, connection, setStatus } = fixture();
    connector.setEnabled(true);
    await connector.manualConnect();
    setStatus('connected');
    connector.setCandidates([candidate()]);
    connector.setCandidates([]);
    await flush();
    expect(connection.connect).not.toHaveBeenCalled();
    expect(connection.disconnect).not.toHaveBeenCalled();
  });

  it('手动断开暂停当前所有会话，新会话可自动连接，显式选择可恢复', async () => {
    const { connector, connection } = fixture();
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    await connector.manualDisconnect();
    connector.setCandidates([candidate()]);
    await flush();
    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(connector.snapshot.candidates[0].status).toBe('paused');
    await connector.select('one');
    expect(connection.connect).toHaveBeenCalledTimes(2);
    await connector.manualDisconnect();
    connector.setCandidates([]);
    connector.setCandidates([candidate('two')]);
    await flush();
    expect(connection.connect).toHaveBeenCalledTimes(3);
  });

  it('失败按 1 秒、3 秒间隔重试，三次耗尽后不被重复事件重置', async () => {
    const { connector, connection, hook } = fixture();
    hook(async () => {
      throw new Error('ws://127.0.0.1/secret=/ws');
    });
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    expect(connection.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(connection.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(connection.connect).toHaveBeenCalledTimes(3);
    connector.setCandidates([candidate()]);
    connector.connectionChanged();
    await vi.advanceTimersByTimeAsync(10000);
    expect(connection.connect).toHaveBeenCalledTimes(3);
    expect(connector.snapshot.candidates[0].status).toBe('failed');
    expect(JSON.stringify(connector.snapshot)).not.toContain('secret=');
    hook(async () => undefined);
    await connector.select('one');
    expect(connection.connect).toHaveBeenCalledTimes(4);
    expect(connector.snapshot.candidates[0].status).toBe('connected');
  });

  it('异常断线重连也受同一预算约束，URL 更新后才使用新预算', async () => {
    const { connector, connection, setStatus } = fixture();
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(1000);
    setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(3000);
    setStatus('disconnected');
    await vi.advanceTimersByTimeAsync(10000);
    expect(connection.connect).toHaveBeenCalledTimes(3);
    connector.setCandidates([candidate('one', 'ws://127.0.0.1:5555/new=/ws')]);
    await flush();
    expect(connection.connect).toHaveBeenCalledTimes(4);
  });

  it('当前连接仍在线时端点更新不会抢占，失效后连接新端点', async () => {
    const { connector, connection, setStatus } = fixture();
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    const next = candidate('one', 'ws://127.0.0.1:5555/new=/ws');
    connector.setCandidates([next]);
    await flush();
    expect(connection.connect).toHaveBeenCalledTimes(1);
    setStatus('disconnected');
    await flush();
    expect(connection.connect).toHaveBeenLastCalledWith(next.url);
  });

  it('会话停止取消正在连接的任务，过期成功结果会被断开', async () => {
    const { connector, connection, hook } = fixture();
    let finish!: () => void;
    hook(() => new Promise<void>((resolve) => (finish = resolve)));
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    connector.setCandidates([]);
    finish();
    await flush();
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(connector.snapshot.connectedSessionId).toBeUndefined();
    expect(connector.snapshot.candidates).toEqual([]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(connection.connect).toHaveBeenCalledTimes(1);
  });

  it('手动连接接管等待过期自动连接清理完毕', async () => {
    const { connector, connection, hook } = fixture();
    let finish!: () => void;
    hook(() => new Promise<void>((resolve) => (finish = resolve)));
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    const manual = connector.manualConnect();
    let settled = false;
    void manual.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    finish();
    await manual;
    expect(settled).toBe(true);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(connection.status()).toBe('disconnected');
    connector.setCandidates([candidate()]);
    await flush();
    expect(connection.connect).toHaveBeenCalledTimes(1);
  });

  it('所属会话停止会断开；移除其他会话不影响已有连接', async () => {
    const { connector, connection } = fixture();
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    connector.setCandidates([candidate(), candidate('two')]);
    connector.setCandidates([candidate()]);
    await flush();
    expect(connection.disconnect).not.toHaveBeenCalled();
    connector.setCandidates([]);
    await flush();
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it('关闭自动设置保留已连接会话，代理模式与 dispose 取消待办', async () => {
    const { connector, connection, hook } = fixture();
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    connector.setEnabled(false);
    expect(connection.disconnect).not.toHaveBeenCalled();
    await connector.manualDisconnect();
    connector.setCandidates([candidate('two')]);
    connector.setMode('proxy');
    connector.setEnabled(true);
    await flush();
    expect(connection.connect).toHaveBeenCalledTimes(1);
    hook(async () => {
      throw new Error('failure');
    });
    connector.setMode('vm');
    await flush();
    expect(connection.connect).toHaveBeenCalledTimes(2);
    connector.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(connection.connect).toHaveBeenCalledTimes(2);
  });

  it('自动关闭时仍允许显式选择，但过期选择拒绝执行', async () => {
    const { connector, connection } = fixture();
    connector.setCandidates([candidate()]);
    await connector.select('one');
    expect(connection.connect).toHaveBeenCalledTimes(1);
    await connector.manualDisconnect();
    connector.setCandidates([]);
    await expect(connector.select('one')).rejects.toThrow('已结束');
    expect(connection.connect).toHaveBeenCalledTimes(1);
  });

  it('自动重试等待期间出现多个候选会取消选择，显式选择仍可执行', async () => {
    const { connector, connection, hook } = fixture();
    hook(async () => {
      throw new Error('failure');
    });
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    connector.setCandidates([candidate(), candidate('two')]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(connection.connect).toHaveBeenCalledTimes(1);
    hook(async () => undefined);
    await connector.select('two');
    expect(connector.snapshot.connectedSessionId).toBe('two');
  });

  it('关闭设置取消待重试，重新开启按剩余预算继续', async () => {
    const { connector, connection, hook } = fixture();
    hook(async () => {
      throw new Error('failure');
    });
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    connector.setEnabled(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(connection.connect).toHaveBeenCalledTimes(1);
    connector.setEnabled(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(connection.connect).toHaveBeenCalledTimes(3);
  });

  it('代理模式取消连接中任务，迟到结果不会恢复 VM', async () => {
    const { connector, connection, hook } = fixture();
    let finish!: () => void;
    hook(() => new Promise<void>((resolve) => (finish = resolve)));
    connector.setCandidates([candidate()]);
    connector.setEnabled(true);
    await flush();
    connector.setMode('proxy');
    finish();
    await flush();
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(connection.status()).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(10000);
    expect(connection.connect).toHaveBeenCalledTimes(1);
  });
});

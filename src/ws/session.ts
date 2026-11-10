import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { HistoryEntry } from '../model';
import type { VmRpc } from '../vm/client';
import { WsVmInjector } from '../vm/websocket';
import { WsHistoryStore } from './storage';
import { validateWsRuleDocument } from './rules';
import type { VmHistorySettings } from '../vm/storage';
import type { WsState, WsMessageQuery, WsMessage, WsRule, WsHandshake, WsConnection } from './model';

/** WS interception has its own lifecycle and never enables Dio Mock. */
export class WsSession extends EventEmitter {
  readonly store: WsHistoryStore;
  readonly state: WsState = {
    captureEnabled: false,
    mockEnabled: false,
    status: 'off',
    connections: [],
    messages: { items: [], total: 0 },
    rules: [],
    omitted: 0,
    warnings: [],
  };
  private readonly injector: WsVmInjector;
  private online = false;
  private disposed = false;
  private epoch = 0;
  private cooldownUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private tail: Promise<unknown> = Promise.resolve();
  private handshakes: WsHandshake[] = [];
  private query: WsMessageQuery = { limit: 30, offset: 0 };
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private initialization?: Promise<void>;
  private queuedWrites = 0;
  private refreshRevision = 0;
  private acceptingEvents = false;
  private readonly savedConnections = new Map<string, string>();

  constructor(
    private readonly rpc: VmRpc,
    folder: string,
    settings: VmHistorySettings,
    templatePath?: string,
    private readonly profiling?: (enabled: boolean) => Promise<void>,
  ) {
    super();
    this.store = new WsHistoryStore(folder, settings);
    this.injector = new WsVmInjector(rpc, {
      templatePath,
      maxBodyBytes: Math.min(settings.maxBodyBytes ?? 1048576, 262144),
    });
    this.injector.on('warning', (message: string) => this.warn(message));
    this.injector.on('omitted', (count: number) => {
      this.state.omitted += count;
      this.changed();
    });
    this.injector.on('message', (message: WsMessage) => {
      if (!this.online || !this.acceptingEvents) return;
      if (this.queuedWrites >= 100) {
        this.state.omitted++;
        this.scheduleRefresh();
        return;
      }
      this.queuedWrites++;
      void this.store
        .putMessage(message)
        .then(() => this.scheduleRefresh())
        .catch(() => {
          this.state.omitted++;
          this.warn('WS 历史队列或存储不可用，部分消息未保存；业务消息继续传递。');
        })
        .finally(() => {
          this.queuedWrites--;
        });
    });
  }
  private changed() {
    if (!this.disposed) this.emit('change');
  }
  private warn(message: string) {
    this.state.warnings = [...new Set([...this.state.warnings, message])].slice(-8);
    this.changed();
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  init(): Promise<void> {
    this.initialization ??= (async () => {
      await this.store.init();
      await this.store.disconnectAll();
      await this.refresh();
    })();
    return this.initialization;
  }
  connected() {
    this.online = true;
    this.state.error = undefined;
    this.changed();
  }
  /** Called synchronously before awaiting cleanup so late events cannot revive a connection. */
  invalidate() {
    this.online = false;
    this.acceptingEvents = false;
    ++this.epoch;
    if (this.state.captureEnabled) this.cooldownUntil = Date.now() + 16000;
    this.state.captureEnabled = false;
    this.state.mockEnabled = false;
    this.state.status = 'off';
    this.state.rules = this.state.rules.filter((r) => !r.match.connectionId);
    this.state.connections = this.state.connections.map((c) =>
      c.status === 'open' ? { ...c, status: 'disconnected', closedAt: Date.now() } : c,
    );
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.changed();
  }
  private scheduleRefresh() {
    if (this.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch(() => this.warn('WS 历史读取失败，请重试。'));
    }, 300);
    this.refreshTimer.unref?.();
  }
  async refresh(query?: WsMessageQuery) {
    if (query) this.query = { ...query, limit: 30, offset: Math.max(0, Number(query.offset) || 0) };
    const epoch = this.epoch;
    const revision = ++this.refreshRevision;
    const [connections, messages] = await Promise.all([
      this.store.connections(),
      this.store.list(this.query),
    ]);
    if (epoch !== this.epoch || revision !== this.refreshRevision || this.disposed) return;
    this.state.connections = connections.map((connection) =>
      (!this.online || !this.state.captureEnabled) && connection.status === 'open'
        ? { ...connection, status: 'disconnected', closedAt: Date.now() }
        : connection,
    );
    this.state.messages = messages;
    this.changed();
  }
  async historical(entries: HistoryEntry[]) {
    await this.init();
    for (const entry of entries) await this.addHandshake(entry);
  }
  async addHandshake(entry: HistoryEntry, handshake?: WsHandshake) {
    await this.init();
    if (handshake && this.online && this.state.captureEnabled) {
      this.handshakes = [...this.handshakes.filter((h) => h.entry?.id !== entry.id), handshake].slice(-512);
    }
    const url = new URL(entry.url);
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
    const connection: WsConnection = {
      id: `handshake:${entry.id}`,
      isolateId: handshake?.isolateId ?? 'history',
      endpoint: url.host,
      url: url.toString(),
      status: 'closed',
      capture: 'unsupported',
      openedAt: entry.startedAt,
      closedAt: entry.startedAt + entry.duration,
      sent: 0,
      received: 0,
      handshake: entry,
      warning: '仅握手记录；接入前消息不可回溯，当前在线连接以运行时发现结果为准。',
    };
    const signature = this.connectionSignature(connection);
    if (this.savedConnections.get(connection.id) === signature) return;
    await this.store.putConnection(connection);
    this.rememberConnection(connection.id, signature);
    this.scheduleRefresh();
  }
  private async scanInternal() {
    if (!this.online || !this.state.captureEnabled) return;
    const epoch = this.epoch;
    const vm = await this.rpc.call<{ isolates?: { id: string; isSystemIsolate?: boolean }[] }>('getVM');
    const ids = (vm.isolates ?? []).filter((i) => !i.isSystemIsolate).map((i) => i.id);
    const connections = await this.injector.scan(
      ids,
      this.state.rules,
      this.state.mockEnabled,
      this.handshakes,
    );
    if (epoch !== this.epoch || !this.online || !this.state.captureEnabled) return;
    for (const connection of connections) {
      const signature = this.connectionSignature(connection);
      if (this.savedConnections.get(connection.id) === signature) continue;
      await this.store.putConnection(connection);
      if (epoch !== this.epoch || !this.online || !this.state.captureEnabled) return;
      this.rememberConnection(connection.id, signature);
      if (connection.handshake) await this.store.deleteConnection(`handshake:${connection.handshake.id}`);
      if (epoch !== this.epoch || !this.online || !this.state.captureEnabled) return;
    }
    this.state.rules = this.state.rules.filter(
      (rule) =>
        !rule.match.connectionId ||
        connections.some(
          (connection) =>
            connection.id === rule.match.connectionId &&
            connection.status === 'open' &&
            connection.capture === 'attached',
        ),
    );
    const attached = connections.filter((c) => c.capture === 'attached' && c.status === 'open');
    this.state.status =
      connections.length && !attached.length && connections.every((c) => c.capture === 'unsupported')
        ? 'unsupported'
        : 'active';
    if (this.state.status === 'unsupported') this.state.mockEnabled = false;
    this.state.error = undefined;
    await this.refresh();
  }
  private rememberConnection(id: string, signature: string) {
    this.savedConnections.delete(id);
    this.savedConnections.set(id, signature);
    if (this.savedConnections.size > 10000)
      this.savedConnections.delete(this.savedConnections.keys().next().value!);
  }
  private connectionSignature(connection: WsConnection) {
    return createHash('sha256').update(JSON.stringify(connection)).digest('hex');
  }
  private schedule() {
    if (!this.online || !this.state.captureEnabled || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(async () => {
        try {
          await this.scanInternal();
        } catch {
          this.state.mockEnabled = false;
          this.state.status = 'error';
          this.state.error =
            'WS 续约或扫描失败，未续约的处理器会在 15 秒租约到期后旁路。请关闭采集后重新开启。';
          // Stop renewing any remaining old rules after a failed operation.
          await this.stopInternal();
        }
        this.schedule();
      }).catch(() => this.warn('WS 后台清理失败，请检查存储；旧处理器将在租约到期后旁路。'));
    }, 4000);
    this.timer.unref?.();
  }
  setCaptureEnabled(enabled: boolean) {
    return this.enqueue(async () => {
      await this.init();
      if (!enabled) {
        await this.stopInternal();
        return;
      }
      if (!this.online) throw new Error('请先连接 Flutter Debug VM');
      if (Date.now() < this.cooldownUntil)
        throw new Error('旧 WS 处理器租约尚未到期，请等待最多 16 秒后重新开启采集。');
      if (this.state.captureEnabled) return;
      this.state.captureEnabled = true;
      this.acceptingEvents = true;
      this.state.mockEnabled = false;
      this.state.error = undefined;
      this.state.warnings = [
        '实验功能：仅支持探测通过的 Dart Debug/JIT WS；新连接扫描前的消息不可补抓或 Mock。',
        'URL 关联会开启 SDK 网络 profiling；App 内 HTTP 缓存可能增长，本地历史上限不限制 SDK 缓存。关闭采集时恢复本插件拥有的开关，不清空其他工具数据。',
      ];
      try {
        await this.profiling?.(true);
        await this.scanInternal();
        this.schedule();
      } catch {
        await this.stopInternal();
        this.state.status = 'unsupported';
        this.state.error = 'WS 运行时接入失败或不兼容；应用连接保持原样，请检查 SDK 兼容性。';
        this.changed();
        throw new Error(this.state.error);
      }
      this.changed();
    });
  }
  setMockEnabled(enabled: boolean) {
    return this.enqueue(async () => {
      if (enabled && (!this.online || !this.state.captureEnabled || this.state.status !== 'active'))
        throw new Error('请先开启受支持的 WS 采集');
      this.state.mockEnabled = enabled;
      try {
        await this.scanInternal();
      } catch {
        this.state.mockEnabled = false;
        await this.stopInternal();
        throw new Error('WS Mock 状态同步失败，采集已停止；请等待旧租约到期后重试。');
      }
      this.changed();
    });
  }
  updateRules(rules: WsRule[]) {
    return this.enqueue(async () => {
      this.state.rules = validateWsRuleDocument({ version: 1, rules }).rules;
      try {
        await this.scanInternal();
        this.state.ruleSyncError = undefined;
      } catch {
        this.state.ruleSyncError = '规则已保存，运行时同步失败；采集已停止，旧规则最多 15 秒后旁路。';
        await this.stopInternal();
        throw new Error(this.state.ruleSyncError);
      }
      this.changed();
    });
  }
  rescan() {
    return this.enqueue(async () => {
      if (!this.online || !this.state.captureEnabled) throw new Error('请先开启 WS 采集');
      try {
        await this.scanInternal();
      } catch {
        this.state.status = 'error';
        this.state.error = 'WS 扫描或同步失败；采集已停止，旧处理器最多 15 秒后旁路。';
        await this.stopInternal();
        throw new Error(this.state.error);
      }
    });
  }
  push(connectionId: string, text: string, signal?: AbortSignal) {
    return this.dispatch('push', connectionId, text, signal);
  }
  send(connectionId: string, text: string, signal?: AbortSignal) {
    return this.dispatch('send', connectionId, text, signal);
  }
  private dispatch(action: 'push' | 'send', connectionId: string, text: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      if (signal?.aborted) throw new Error('WS 消息操作已取消，未执行发送');
      if (!this.online || !this.state.captureEnabled || !this.state.mockEnabled)
        throw new Error('请先连接 VM 并开启 WS Mock');
      const connection = this.state.connections.find((c) => c.id === connectionId);
      if (!connection || connection.status !== 'open' || connection.capture !== 'attached')
        throw new Error('所选 WS 连接已失效，不能向旧连接或同址新连接发送消息');
      const epoch = this.epoch;
      await this.injector[action](connectionId, text, signal);
      if (epoch !== this.epoch || !this.online || signal?.aborted)
        throw new Error('WS 会话已失效，消息结果未确认；动作可能已执行，请勿自动重试');
    });
  }
  private async stopInternal() {
    ++this.epoch;
    this.state.captureEnabled = false;
    this.state.mockEnabled = false;
    if (this.state.status !== 'error') this.state.status = 'off';
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.state.rules = this.state.rules.filter((r) => !r.match.connectionId);
    try {
      await this.injector.detach();
      this.cooldownUntil = 0;
    } catch {
      this.cooldownUntil = Date.now() + 16000;
      this.warn('WS 卸载未确认；处理器最多 15 秒后自动旁路，请等待旧租约到期。');
    }
    this.acceptingEvents = false;
    this.handshakes = [];
    await this.profiling?.(false).catch(() => undefined);
    await this.store.disconnectAll();
    await this.refresh();
  }
  disconnect(reachable = true) {
    this.invalidate();
    return this.enqueue(async () => {
      if (!this.initialization) {
        this.handshakes = [];
        return;
      }
      if (reachable) await this.stopInternal();
      else {
        this.injector.abandon();
        await this.store.disconnectAll();
        await this.refresh();
      }
      this.handshakes = [];
    });
  }
  async dispose() {
    await this.disconnect(this.online);
    await this.injector.dispose();
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.store.close();
    this.removeAllListeners();
  }
}

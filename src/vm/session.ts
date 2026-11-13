import { EventEmitter } from 'node:events';
import { VmConnectionError, VmRpcError, VmServiceClient, validateVmUrl } from './client';
import { VmNetworkProfiler } from './profiler';
import { DioVmInjector } from './injection';
import { VmHistoryStore, type VmHistorySettings } from './storage';
import type { HistoryEntry, Rule, WorkbenchState } from '../model';
import { WsSession } from '../ws/session';
import type { WsHandshake } from '../ws/model';

/** Keeps VM connections independent of the panel and the proxy engine. */
export class VmSession extends EventEmitter {
  readonly store: VmHistoryStore;
  readonly client = new VmServiceClient();
  readonly websocket: WsSession;
  private readonly profiler: VmNetworkProfiler;
  private readonly injector: DioVmInjector;
  private isolateIds: string[] = [];
  private rules: Rule[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private syncing = false;
  private tickPending = false;
  private lastDiscovery = 0;
  private mockResumeAfter = 0;
  private closed = false;
  private generation = 0;
  private operations: Promise<unknown> = Promise.resolve();
  private intentionalDisconnect = false;
  private readonly stored = new Set<string>();
  state: NonNullable<WorkbenchState['vm']> = {
    captureEnabled: false,
    status: 'disconnected',
    isolates: 0,
    recorded: 0,
    instances: 0,
    mockEnabled: false,
    warnings: [],
  };

  constructor(folder: string, settings: VmHistorySettings, templatePath?: string) {
    super();
    this.store = new VmHistoryStore(folder, settings);
    this.profiler = new VmNetworkProfiler(this.client, {
      maxBodyBytes: settings.maxBodyBytes,
      pollIntervalMs: 1000,
    });
    this.websocket = new WsSession(
      this.client,
      folder,
      settings,
      templatePath?.replace(/interceptor\.dart\.txt$/, 'websocket.dart.txt'),
      (enabled) => this.profiler.setHandshakeCaptureEnabled(enabled),
    );
    this.websocket.on('change', () => this.changed());
    this.profiler.on('websocket', (entry: HistoryEntry, handshake?: WsHandshake) => {
      void this.websocket
        .addHandshake(entry, handshake)
        .catch(() => this.warn('WS 握手历史保存失败，请检查本机存储。'));
    });
    this.injector = new DioVmInjector(this.client, { templatePath });
    this.profiler.on('history', (entry: HistoryEntry) => {
      if (!this.state.mockEnabled || !this.state.instances) this.record(entry, 'vm');
    });
    this.injector.on('history', (entry: HistoryEntry) => {
      if (this.state.mockEnabled) this.record(entry, 'vm-dio');
    });
    this.injector.on('observation.http', (entry: HistoryEntry) => {
      if (this.state.mockEnabled) this.observe(entry, 'vm-dio');
    });
    this.profiler.on('isolates', (ids: string[]) => {
      if (this.state.status === 'disconnected') return;
      this.isolateIds = ids;
      this.state.isolates = ids.length;
      // Counts from the previous isolate must not advertise a live attachment.
      this.state.instances = 0;
      this.lastDiscovery = 0;
      this.changed();
      if (this.state.mockEnabled) {
        const generation = this.generation;
        void this.enqueue(async () => {
          if (generation !== this.generation || this.state.status !== 'connected' || !this.state.mockEnabled)
            return;
          await this.profiler.setCaptureEnabled(this.state.captureEnabled !== false);
          await this.injector.heartbeat();
          await this.syncInternal();
        }).catch(() => this.warn('应用 Isolate 已变化，Mock 尚未确认重新接入；请重新发现并同步。'));
      }
    });
    this.profiler.on('observation.loss', () => this.emit('observation.loss'));
    this.profiler.on('warning', (message: string) => this.warn(message));
    this.client.on('disconnected', () => {
      if (this.intentionalDisconnect || this.closed) return;
      if (this.state.status === 'disconnected') return;
      ++this.generation;
      this.websocket.invalidate();
      const wasMockEnabled = this.state.mockEnabled;
      this.state.status = 'disconnected';
      this.state.captureEnabled = false;
      this.state.endpoint = undefined;
      this.state.instances = 0;
      this.state.isolates = 0;
      this.state.mockEnabled = false;
      this.state.error = 'VM 连接已断开，请使用当前运行应用的 VM WS 重新连接。';
      this.isolateIds = [];
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      if (wasMockEnabled) {
        this.mockResumeAfter = Date.now() + 16000;
        this.warn(
          'VM 已断开；应用中的 Mock 租约到期后自动旁路（最长约 15 秒）。重新连接后需等旧租约到期再开启 Mock。',
        );
      }
      this.changed();
      const generation = this.generation;
      void this.enqueue(async () => {
        if (generation === this.generation && this.state.status === 'disconnected')
          await this.disconnectInternal(false);
      }).catch(() => undefined);
    });
  }

  private changed() {
    this.emit('change');
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => undefined);
    return result;
  }
  private warn(message: string) {
    this.state.warnings = [...new Set([...this.state.warnings, message])].slice(-8);
    this.changed();
  }
  private observe(entry: HistoryEntry, source: 'vm' | 'vm-dio') {
    if (this.closed || this.state.status !== 'connected' || this.state.captureEnabled === false) return;
    // Prefix source IDs so observation and injection sessions never overwrite facts.
    const item = { ...entry, id: `${source}:${entry.id}`, source };
    // Test observation owns a separate bounded window before SQLite retention
    // and disk queues, so pruning cannot hide a duplicate submission.
    this.emit('observation.http', item);
    return item;
  }
  private record(entry: HistoryEntry, source: 'vm' | 'vm-dio') {
    const item = this.observe(entry, source);
    if (!item) return;
    void this.store
      .put(item)
      .then(() => {
        if (!this.stored.has(item.id)) {
          this.stored.add(item.id);
          this.state.recorded++;
          if (this.stored.size > 12000) this.stored.delete(this.stored.values().next().value!);
        }
        this.emit('history', item.id);
      })
      .catch(() => this.warn('VM 历史保存失败，请检查存储容量或降低采集频率。'));
  }

  connect(url: string, rules: Rule[]): Promise<void> {
    if (this.state.status !== 'disconnected')
      return Promise.reject(new Error('VM 已连接或正在连接，请先断开当前连接后再更换地址。'));
    const validated = validateVmUrl(url);
    return this.enqueue(() => this.connectInternal(validated, rules));
  }
  private async connectInternal(validated: string, rules: Rule[]) {
    if (this.closed) throw new Error('VM 会话已关闭');
    if (this.state.status !== 'disconnected')
      throw new Error('VM 已连接或正在连接，请先断开当前连接后再更换地址。');
    await this.disconnectInternal();
    const generation = ++this.generation;
    this.rules = rules;
    this.state = {
      ...this.state,
      status: 'connecting',
      endpoint: undefined,
      mockEnabled: false,
      error: undefined,
      warnings: [],
      instances: 0,
      isolates: 0,
    };
    this.changed();
    try {
      await this.store.init();
      await this.client.connect(validated);
      if (
        this.closed ||
        generation !== this.generation ||
        !this.client.connected ||
        this.state.status !== 'connecting'
      )
        throw new VmConnectionError('cancelled', 'VM 连接在初始化完成前已断开，请重新连接当前应用。');
      await this.profiler.start();
      if (
        this.closed ||
        generation !== this.generation ||
        !this.client.connected ||
        this.state.status !== 'connecting'
      )
        throw new VmConnectionError('cancelled', 'VM 连接在初始化完成前已断开，请重新连接当前应用。');
      const endpoint = new URL(validated);
      this.state.endpoint = this.client.endpoint ?? endpoint.host;
      this.state.status = 'connected';
      this.state.captureEnabled = true;
      this.websocket.connected();
      this.timer = setInterval(() => void this.tick(), 4000);
      this.changed();
    } catch (error) {
      await this.profiler.stop().catch(() => undefined);
      await this.client.disconnect();
      this.isolateIds = [];
      this.state = {
        ...this.state,
        status: 'disconnected',
        endpoint: undefined,
        mockEnabled: false,
        instances: 0,
        isolates: 0,
        error:
          error instanceof VmConnectionError || error instanceof VmRpcError
            ? error.message
            : '无法连接或初始化 VM；请检查 Debug 应用、WS 地址和设备端口转发。',
      };
      this.changed();
      throw new Error(this.state.error);
    }
  }

  setMockEnabled(enabled: boolean): Promise<void> {
    return this.enqueue(() => this.setMockInternal(enabled));
  }
  setCaptureEnabled(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (this.state.status !== 'connected') throw new Error('请先连接 Flutter Debug VM');
      await this.profiler.setCaptureEnabled(enabled && (!this.state.mockEnabled || !this.state.instances));
      this.state.captureEnabled = enabled;
      this.changed();
    });
  }
  private async setMockInternal(enabled: boolean) {
    if (enabled && this.state.status !== 'connected') throw new Error('请先连接运行中的 Flutter Debug VM');
    if (enabled && Date.now() < this.mockResumeAfter) {
      throw new Error(
        `上次 VM 连接异常中断，请再等待 ${Math.ceil((this.mockResumeAfter - Date.now()) / 1000)} 秒后开启 Mock，避免旧租约与新规则重叠。`,
      );
    }
    if (enabled === this.state.mockEnabled) return;
    if (!enabled) {
      let failure: Error | undefined;
      try {
        await this.injector.detach();
      } catch {
        this.mockResumeAfter = Date.now() + 16000;
        failure = new Error('未能立即卸载 Mock，旧规则最长约 15 秒后旁路；再次开启前请等待旧租约到期。');
        this.warn(failure.message);
      }
      this.state.mockEnabled = false;
      this.state.instances = 0;
      await this.profiler.setCaptureEnabled(this.state.captureEnabled !== false);
      this.changed();
      if (failure) throw failure;
    } else {
      this.state.mockEnabled = true;
      try {
        await this.syncInternal();
      } catch (error) {
        await this.injector.detach().catch(() => {
          this.mockResumeAfter = Date.now() + 16000;
          this.warn('部分 Mock 未确认卸载，请等待旧租约到期再重试，或 Hot Restart。');
        });
        this.state.mockEnabled = false;
        this.state.instances = 0;
        await this.profiler.setCaptureEnabled(this.state.captureEnabled !== false);
        this.changed();
        throw error;
      }
    }
    this.changed();
  }

  updateRules(rules: Rule[]): Promise<void> {
    return this.enqueue(async () => {
      this.rules = rules;
      if (this.state.mockEnabled) await this.syncInternal();
    });
  }
  private async syncInternal() {
    this.syncing = true;
    const generation = this.generation;
    const isolateIds = [...this.isolateIds];
    try {
      let instances = 0;
      const warnings: string[] = [];
      for (const id of isolateIds) {
        const result = await this.injector.sync(id, this.rules);
        instances += result.instances;
        warnings.push(...result.warnings);
      }
      if (generation !== this.generation || isolateIds.join(',') !== this.isolateIds.join(','))
        throw new Error('VM Isolate 已变化，等待重新同步 Mock');
      this.state.instances = instances;
      await this.profiler.setCaptureEnabled(this.state.captureEnabled !== false && instances === 0);
      for (const warning of warnings) this.warn(warning);
      this.lastDiscovery = Date.now();
      if (!instances) this.warn('尚未找到可接入的 Dio 实例；请先让应用创建 Dio，再点击“重新发现并同步”。');
    } catch (error) {
      this.state.instances = 0;
      this.lastDiscovery = 0;
      await this.profiler.setCaptureEnabled(this.state.captureEnabled !== false).catch(() => undefined);
      throw error;
    } finally {
      this.syncing = false;
      this.changed();
    }
  }
  rescan(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.state.mockEnabled) throw new Error('请先开启实验性 Dio Mock');
      await this.syncInternal();
    });
  }
  /** Re-discovers new isolates and reapplies only controls that are still explicitly enabled. */
  refreshAfterLifecycle(signal: AbortSignal): Promise<void> {
    const generation = this.generation;
    return this.enqueue(async () => {
      const check = () => {
        signal.throwIfAborted();
        if (generation !== this.generation || this.state.status !== 'connected')
          throw new Error('VM 会话已失效');
      };
      check();
      this.state.instances = 0;
      await this.profiler.rediscover();
      check();
      if (this.state.mockEnabled) {
        await this.injector.heartbeat();
        check();
        await this.syncInternal();
        check();
      }
      if (this.websocket.state.captureEnabled) await this.websocket.rescan();
      check();
      this.changed();
    });
  }
  private async tick() {
    if (this.tickPending || !this.state.mockEnabled || this.state.status !== 'connected' || this.syncing)
      return;
    this.tickPending = true;
    try {
      await this.enqueue(async () => {
        if (!this.state.mockEnabled || this.state.status !== 'connected') return;
        await this.injector.heartbeat();
        if (Date.now() - this.lastDiscovery >= 6000) await this.syncInternal();
      });
    } catch {
      this.state.instances = 0;
      this.lastDiscovery = 0;
      await this.profiler.setCaptureEnabled(this.state.captureEnabled !== false).catch(() => undefined);
      this.warn('VM Mock 心跳或同步失败；未续约的规则将自动旁路，请重新连接检查。');
    } finally {
      this.tickPending = false;
    }
  }
  disconnect(): Promise<void> {
    return this.enqueue(() => this.disconnectInternal());
  }
  private async disconnectInternal(clearError = true) {
    ++this.generation;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.intentionalDisconnect = true;
    await this.websocket
      .disconnect(this.client.connected)
      .catch(() => this.warn('WS 会话清理失败，旧处理器将在租约到期后旁路。'));
    await this.injector.detach().catch(() => {
      if (this.state.mockEnabled) {
        this.mockResumeAfter = Date.now() + 16000;
        this.warn('未能立即卸载 Mock，应用将于租约到期后旁路；Hot Restart 可清除运行时注入。');
      }
    });
    await this.profiler.stop().catch(() => undefined);
    await this.client.disconnect();
    this.intentionalDisconnect = false;
    this.isolateIds = [];
    this.state = {
      ...this.state,
      status: 'disconnected',
      captureEnabled: false,
      endpoint: undefined,
      error: clearError ? undefined : this.state.error,
      mockEnabled: false,
      instances: 0,
      isolates: 0,
    };
    this.changed();
  }
  async dispose() {
    this.closed = true;
    ++this.generation;
    await this.disconnect();
    await this.injector.dispose();
    await this.websocket.dispose();
    await this.store.close();
    this.removeAllListeners();
  }
}

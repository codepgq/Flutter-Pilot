import { EventEmitter } from 'node:events';
import type { WorkbenchState } from '../model';

/** Authenticated addresses stay in the extension host, never in the public snapshot. */
export interface VmDiscoveredCandidate {
  id: string;
  name: string;
  device?: string;
  endpoint: string;
  source: 'debug-event' | 'dtd';
  url: string;
}
interface ConnectionCallbacks {
  status(): 'disconnected' | 'connecting' | 'connected';
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
}
interface Attempt {
  token: number;
  candidate: VmDiscoveredCandidate;
  explicit: boolean;
  promise: Promise<void>;
}
const connectionError = '自动连接 VM 失败，请确认 Flutter Debug 会话仍在运行后重试。';

/** Coordinates discovery without replacing manual or already established connections. */
export class VmAutoConnector extends EventEmitter {
  private candidates = new Map<string, VmDiscoveredCandidate>();
  private enabled = false;
  private mode: 'vm' | 'proxy' = 'vm';
  private availability: 'waiting' | 'ready' | 'unavailable' = 'waiting';
  private message?: string;
  private owner?: VmDiscoveredCandidate;
  private paused = new Set<string>();
  private manual = false;
  private attempts = new Map<string, { url: string; count: number; error?: string }>();
  private task?: Attempt;
  private cleanup?: Promise<void>;
  private epoch = 0;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: (ready: boolean) => void;

  constructor(private readonly connection: ConnectionCallbacks) {
    super();
  }

  owns(id: string, url: string): boolean {
    return this.connection.status() === 'connected' && this.owner?.id === id && this.owner.url === url;
  }

  get snapshot(): NonNullable<WorkbenchState['vmDiscovery']> {
    const connectionStatus = this.connection.status();
    return {
      enabled: this.enabled,
      status: this.availability,
      message: this.message,
      connectedSessionId: connectionStatus === 'connected' ? this.owner?.id : undefined,
      candidates: [...this.candidates.values()].map((candidate) => {
        const history = this.attempts.get(candidate.id);
        const error = history?.url === candidate.url ? history.error : undefined;
        return {
          id: candidate.id,
          name: candidate.name,
          device: candidate.device,
          endpoint: candidate.endpoint,
          source: candidate.source,
          status:
            this.owner?.id === candidate.id && connectionStatus === 'connected'
              ? 'connected'
              : this.task?.candidate.id === candidate.id && this.task.token === this.epoch
                ? 'connecting'
                : this.paused.has(candidate.id)
                  ? 'paused'
                  : error
                    ? 'failed'
                    : 'available',
          error,
        };
      }),
    };
  }

  setCandidates(candidates: VmDiscoveredCandidate[]): void {
    if (this.closed) return;
    const next = new Map(candidates.map((candidate) => [candidate.id, { ...candidate }]));
    const removedOwner = this.owner && !next.has(this.owner.id);
    this.candidates = next;
    for (const id of this.paused) if (!next.has(id)) this.paused.delete(id);
    for (const id of this.attempts.keys()) if (!next.has(id)) this.attempts.delete(id);
    if (
      this.task &&
      (!next.has(this.task.candidate.id) ||
        next.get(this.task.candidate.id)?.url !== this.task.candidate.url ||
        (!this.owner && !this.task.explicit && next.size !== 1))
    )
      this.cancel();
    if (removedOwner) {
      this.owner = undefined;
      this.cancel();
      this.disconnectOwned();
    }
    this.changed();
    this.reconcile();
  }

  setAvailability(status: 'waiting' | 'ready' | 'unavailable', message?: string): void {
    if (this.closed) return;
    this.availability = status;
    this.message = message;
    this.changed();
  }

  setEnabled(enabled: boolean): void {
    if (this.closed) return;
    this.enabled = enabled;
    if (!enabled) this.cancel();
    this.changed();
    this.reconcile();
  }

  setMode(mode: 'vm' | 'proxy'): void {
    if (this.closed) return;
    this.mode = mode;
    if (mode !== 'vm') {
      this.cancel();
      this.owner = undefined;
    }
    this.changed();
    this.reconcile();
  }

  connectionChanged(): void {
    if (this.closed) return;
    this.changed();
    this.reconcile();
  }

  /** Call and await this before starting a manually entered address. */
  async manualConnect(): Promise<void> {
    this.manual = true;
    this.owner = undefined;
    this.cancel();
    this.changed();
    await this.settled();
  }

  async manualDisconnect(): Promise<void> {
    for (const id of this.candidates.keys()) this.paused.add(id);
    this.manual = true;
    this.owner = undefined;
    this.cancel();
    this.changed();
    try {
      await this.settled();
      if (this.closed) return;
      await this.connection.disconnect();
    } finally {
      this.manual = false;
      this.changed();
      this.reconcile();
    }
  }

  async select(id: string): Promise<void> {
    if (this.closed || this.mode !== 'vm') throw new Error('请先切换到 VM 连接模式');
    if (!this.candidates.has(id)) throw new Error('调试会话已结束，请选择当前可用会话');
    if (this.connection.status() !== 'disconnected') throw new Error('VM 已连接或正在连接，请先断开当前连接');
    // Explicit selection also works when automatic connection is disabled.
    this.manual = true;
    this.cancel();
    await this.settled();
    const candidate = this.candidates.get(id);
    if (this.closed || this.mode !== 'vm' || !candidate)
      throw new Error('调试会话已结束，请选择当前可用会话');
    if (this.connection.status() !== 'disconnected') throw new Error('VM 已连接或正在连接，请先断开当前连接');
    this.paused.delete(id);
    this.attempts.delete(id);
    this.manual = false;
    await this.start(candidate, true);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    this.candidates.clear();
    this.attempts.clear();
    this.paused.clear();
    this.owner = undefined;
    this.removeAllListeners();
  }

  private changed(): void {
    if (!this.closed) this.emit('change');
  }

  private cancel(): void {
    ++this.epoch;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wake?.(false);
    this.wake = undefined;
  }

  private async settled(): Promise<void> {
    await this.task?.promise;
    await this.cleanup;
  }

  private disconnectOwned(): void {
    if (this.cleanup) return;
    // Wait for a cancelled in-flight attempt to clean up before disconnecting its owner.
    const cleanup = Promise.resolve().then(async () => {
      await this.task?.promise;
      if (this.connection.status() !== 'disconnected')
        await this.connection.disconnect().catch(() => undefined);
    });
    this.cleanup = cleanup;
    void cleanup.finally(() => {
      if (this.cleanup === cleanup) this.cleanup = undefined;
      this.changed();
      this.reconcile();
    });
  }

  private reconcile(): void {
    if (
      this.closed ||
      !this.enabled ||
      this.mode !== 'vm' ||
      this.manual ||
      this.task ||
      this.cleanup ||
      this.connection.status() !== 'disconnected'
    )
      return;
    const available = [...this.candidates.values()];
    const candidate = this.owner
      ? this.candidates.get(this.owner.id)
      : available.length === 1
        ? available[0]
        : undefined;
    if (!candidate || this.paused.has(candidate.id)) return;
    const history = this.attempts.get(candidate.id);
    if (history?.url === candidate.url && history.count >= 3) {
      if (!history.error) {
        history.error = '自动重连次数已用尽，请点击重新连接。';
        this.changed();
      }
      return;
    }
    void this.start(candidate, false);
  }

  private start(candidate: VmDiscoveredCandidate, explicit: boolean): Promise<void> {
    const token = ++this.epoch;
    const task: Attempt = { token, candidate, explicit, promise: Promise.resolve() };
    this.task = task;
    task.promise = Promise.resolve()
      .then(() => this.run(task, explicit))
      .finally(() => {
        if (this.task === task) this.task = undefined;
        this.changed();
        this.reconcile();
      });
    this.changed();
    return task.promise;
  }

  private current(task: Attempt, explicit: boolean): boolean {
    return (
      !this.closed &&
      task.token === this.epoch &&
      this.mode === 'vm' &&
      (explicit || this.enabled) &&
      this.candidates.get(task.candidate.id)?.url === task.candidate.url &&
      !this.paused.has(task.candidate.id)
    );
  }

  private delay(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.wake = undefined;
        resolve(true);
      }, ms);
    });
  }

  private async run(task: Attempt, explicit: boolean): Promise<void> {
    const candidate = task.candidate;
    let history = this.attempts.get(candidate.id);
    if (history?.url !== candidate.url) {
      history = { url: candidate.url, count: 0 };
      this.attempts.set(candidate.id, history);
    }
    while (this.current(task, explicit) && history.count < 3) {
      if (history.count && !(await this.delay(history.count === 1 ? 1000 : 3000))) return;
      if (!this.current(task, explicit) || this.connection.status() !== 'disconnected') return;
      history.count++;
      history.error = undefined;
      this.changed();
      try {
        await this.connection.connect(candidate.url);
        if (!this.current(task, explicit)) {
          // Manual handoff waits for this cleanup before it can start its own connection.
          await this.connection.disconnect().catch(() => undefined);
          return;
        }
        if (this.connection.status() !== 'connected') throw new Error(connectionError);
        this.owner = candidate;
        this.changed();
        return;
      } catch {
        if (!this.current(task, explicit)) return;
        history.error = connectionError;
        this.changed();
      }
    }
  }
}

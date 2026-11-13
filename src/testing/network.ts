import type { HistoryEntry } from '../model';
import type { WsConnection, WsMessage } from '../ws/model';

export interface NetworkBaseline {
  at: number;
  httpIds: string[];
  wsIds: string[];
}
export interface NetworkObserverCallbacks {
  http(entry: HistoryEntry): void;
  ws(message: WsMessage): void;
  loss(reason?: string): void;
}
export interface NetworkObservationHost {
  /** Read the App process clock used by HTTP/WS capture, never the IDE wall clock. */
  clock(): Promise<number>;
  /** Passive capture before retention, disk writes, or write-queue dropping. */
  subscribe(callbacks: NetworkObserverCallbacks): () => void;
  connections(): Promise<WsConnection[]>;
}
interface Window {
  epoch: number;
  at: number;
  http: Map<string, HistoryEntry>;
  ws: Map<string, WsMessage>;
  sizes: Map<string, number>;
  bytes: number;
  error?: Error;
  baseline?: NetworkBaseline;
  unsubscribe?: () => void;
}

/** A dedicated bounded run window, independent from user history retention. */
export class TestNetworkObserver {
  private epoch = 0;
  private window?: Window;
  constructor(
    private readonly host: NetworkObservationHost,
    private readonly maximum = 10000,
    private readonly maxBytes = 32 * 1024 * 1024,
  ) {}

  /** Release passive listeners and captured bodies; this never dispatches an App action. */
  close() {
    const current = this.window;
    this.window = undefined;
    ++this.epoch;
    current?.unsubscribe?.();
    current?.http.clear();
    current?.ws.clear();
    current?.sizes.clear();
  }

  private accept(current: Window, domain: 'http' | 'ws', entry: HistoryEntry | WsMessage) {
    if (this.window !== current || current.error) return;
    try {
      const timestamp =
        domain === 'http' ? (entry as HistoryEntry).startedAt : (entry as WsMessage).timestamp;
      if (!Number.isFinite(timestamp)) throw new Error('网络捕获时间无效，无法证明本轮记录完整。');
      if (timestamp < current.at) return;
      const key = `${domain}:${entry.id}`;
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      const nextBytes = current.bytes - (current.sizes.get(key) ?? 0) + bytes;
      if ((!current.sizes.has(key) && current.sizes.size >= this.maximum) || nextBytes > this.maxBytes)
        throw new Error('本轮网络观察超过记录或容量上限，无法验证完整记录。');
      const copy = structuredClone(entry);
      current.sizes.set(key, bytes);
      current.bytes = nextBytes;
      if (domain === 'http') current.http.set(entry.id, copy as HistoryEntry);
      else current.ws.set(entry.id, copy as WsMessage);
    } catch (error) {
      current.error = error instanceof Error ? error : new Error('本轮网络捕获不完整。');
    }
  }

  async baseline(): Promise<NetworkBaseline> {
    this.close();
    const current: Window = {
      epoch: this.epoch,
      at: -Infinity,
      http: new Map(),
      ws: new Map(),
      sizes: new Map(),
      bytes: 0,
    };
    this.window = current;
    try {
      current.unsubscribe = this.host.subscribe({
        http: (entry) => this.accept(current, 'http', entry),
        ws: (entry) => this.accept(current, 'ws', entry),
        loss: () => {
          if (this.window === current) current.error = new Error('本轮网络采集出现遗漏，无法验证完整记录。');
        },
      });
      const first = await this.host.clock();
      if (!Number.isFinite(first) || first <= 0) throw new Error('无法建立 App 时钟观察边界。');
      // Dio starts are integer milliseconds, while SDK/WS captures can contain
      // fractions. Advance beyond the whole source-clock millisecond in which
      // arming began, so pre-existing in-flight work cannot fall on the fence.
      const at = Math.ceil(first) + 1;
      const deadline = performance.now() + 2000;
      let sampled = first;
      while (sampled < at) {
        if (performance.now() >= deadline) throw new Error('App 时钟未前进，无法建立测试观察边界。');
        await new Promise((resolve) => setTimeout(resolve, 1));
        sampled = await this.host.clock();
        if (!Number.isFinite(sampled) || sampled < first)
          throw new Error('App 时钟发生变化，无法建立测试观察边界。');
      }
      if (this.window !== current) throw new Error('测试网络观察已取消。');
      if (current.error) throw current.error;
      // All records already delivered during arming are baseline facts, including
      // fractional WS timestamps. Retain only IDs and discard their bodies.
      const baseline = { at, httpIds: [...current.http.keys()], wsIds: [...current.ws.keys()] };
      current.at = at;
      current.http.clear();
      current.ws.clear();
      current.sizes.clear();
      current.bytes = 0;
      current.baseline = baseline;
      return structuredClone(baseline);
    } catch (error) {
      if (this.window === current) this.close();
      throw error;
    }
  }

  private active(baseline: NetworkBaseline): Window {
    const current = this.window;
    if (
      !current?.baseline ||
      current.baseline.at !== baseline.at ||
      JSON.stringify(current.baseline.httpIds) !== JSON.stringify(baseline.httpIds) ||
      JSON.stringify(current.baseline.wsIds) !== JSON.stringify(baseline.wsIds)
    )
      throw new Error('测试网络观察已释放或不属于本轮。');
    if (current.error) throw current.error;
    return current;
  }

  async http(baseline: NetworkBaseline): Promise<HistoryEntry[]> {
    const current = this.active(baseline),
      old = new Set(baseline.httpIds);
    return structuredClone(
      [...current.http.values()].filter((entry) => entry.startedAt >= baseline.at && !old.has(entry.id)),
    );
  }

  async ws(baseline: NetworkBaseline): Promise<Array<WsMessage & { url?: string }>> {
    const current = this.active(baseline),
      old = new Set(baseline.wsIds);
    const urls = new Map(
      (await this.host.connections()).map((connection) => [connection.id, connection.url]),
    );
    this.active(baseline);
    return structuredClone(
      [...current.ws.values()]
        .filter((entry) => entry.timestamp >= baseline.at && !old.has(entry.id))
        .map((entry) => ({ ...entry, url: urls.get(entry.connectionId) })),
    );
  }
}

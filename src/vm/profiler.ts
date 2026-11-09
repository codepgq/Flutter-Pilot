import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { BodySnapshot, HistoryEntry } from '../model';
import { type VmRpc, VmServiceClient } from './client';
import type { WsHandshake } from '../ws/model';

type ObjectMap = Record<string, any>;
export function isWebSocketHandshake(entry: HistoryEntry): boolean {
  return (
    /^wss?:/i.test(entry.url) ||
    [...entry.request.headers, ...(entry.response?.headers ?? [])].some(
      ([key, value]) => key.toLowerCase() === 'upgrade' && value.toLowerCase().trim() === 'websocket',
    )
  );
}

export function websocketHandshake(
  profile: ObjectMap,
  entry: HistoryEntry,
  isolateId: string,
): WsHandshake | undefined {
  if (!isWebSocketHandshake(entry) || entry.response?.status !== 101) return;
  const info = profile.response?.connectionInfo ?? profile.request?.connectionInfo;
  if (
    !info ||
    !Number.isInteger(info.localPort) ||
    !Number.isInteger(info.remotePort) ||
    typeof info.remoteAddress !== 'string'
  )
    return;
  const url = new URL(entry.url);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  return {
    isolateId,
    url: url.toString(),
    localPort: info.localPort,
    remotePort: info.remotePort,
    remoteAddress: info.remoteAddress,
    timestamp: entry.startedAt,
    entry,
  };
}
interface IsolateState {
  id: string;
  enabledByUs: boolean;
  vmIdentity?: string;
  cursor?: number;
}
export interface VmProfilerOptions {
  intervalMs?: number;
  pollIntervalMs?: number;
  maxBodyBytes?: number;
  maxDetailsPerPoll?: number;
  sessionId?: string;
}
function headers(value: unknown): [string, string][] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, values]) =>
    (Array.isArray(values) ? values : [values]).map((v) => [key, String(v)] as [string, string]),
  );
}

function body(value: unknown, headerList: [string, string][], maxBytes: number): BodySnapshot {
  const bytes = Array.isArray(value)
    ? Buffer.from(value)
    : typeof value === 'string'
      ? Buffer.from(value, 'base64')
      : Buffer.alloc(0);
  const prefix = bytes.subarray(0, maxBytes);
  const truncated = bytes.length > maxBytes;
  const kind =
    headerList
      .find(([key]) => key.toLowerCase() === 'content-type')?.[1]
      .split(';', 1)[0]
      .toLowerCase() ?? '';
  const textual =
    !kind || kind.startsWith('text/') || /(?:json|xml|javascript|x-www-form-urlencoded)$/.test(kind);
  let text: string | undefined;
  if (textual) {
    try {
      text = new TextDecoder('utf-8', { fatal: !truncated }).decode(prefix);
    } catch {
      /* Preserve undecodable bytes. */
    }
  }
  const limitation = truncated
    ? '正文超过记录上限，已截断'
    : text === undefined
      ? '二进制正文仅以 Base64 查看'
      : undefined;
  return {
    headers: headerList,
    body: text ?? prefix.toString('base64'),
    bodyEncoding: text === undefined ? 'base64' : 'text',
    bodyBytes: bytes.length,
    truncated,
    editable: !limitation,
    ...(limitation ? { limitation } : {}),
  };
}

/** Convert the SDK HTTP profile schema, whose timestamps are Unix microseconds. */
export function normalizeHttpProfile(
  profile: ObjectMap,
  sessionId: string,
  isolateId: string,
  maxBodyBytes = 1024 * 1024,
): HistoryEntry | undefined {
  let url: URL;
  try {
    url = new URL(profile.uri);
  } catch {
    return;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return;
  const method = String(profile.method ?? profile.request?.method ?? 'GET').toUpperCase();
  const request = {
    ...body(profile.requestBody, headers(profile.request?.headers), maxBodyBytes),
    method,
    url: url.toString(),
  };
  const startedAt = Number(profile.startTime) / 1000;
  if (!Number.isFinite(startedAt)) return;
  const responseInfo = profile.response;
  const response =
    responseInfo && Number.isInteger(responseInfo.statusCode)
      ? {
          ...body(profile.responseBody, headers(responseInfo.headers), maxBodyBytes),
          status: responseInfo.statusCode,
        }
      : undefined;
  const endedAt = Number(responseInfo?.endTime ?? profile.endTime ?? profile.startTime) / 1000;
  const errorValue = responseInfo?.error ?? profile.request?.error;
  const error =
    typeof errorValue === 'string'
      ? errorValue
      : errorValue?.message
        ? String(errorValue.message)
        : undefined;
  return {
    id: `vm:${sessionId}:${isolateId}:${profile.id}`,
    startedAt,
    duration: Math.max(0, endedAt - startedAt),
    method,
    host: url.hostname,
    path: url.pathname || '/',
    url: url.toString(),
    targetUrl: url.toString(),
    originalRequest: request,
    automaticRequest: request,
    request,
    originalResponse: response,
    automaticResponse: response,
    response,
    mocked: false,
    error,
    note: '',
    tags: [],
  };
}

/** Read-only network collection. It never changes adapters, TLS trust or requests. */
export class VmNetworkProfiler extends EventEmitter {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private work?: Promise<void>;
  private states = new Map<string, IsolateState>();
  private completed = new Set<string>();
  private lastDiscovery = 0;
  private recorded = 0;
  private captureEnabled = true;
  private handshakeCaptureEnabled = false;
  private flagWork: Promise<void> = Promise.resolve();
  private subscribed: string[] = [];
  private readonly intervalMs: number;
  private readonly maxBodyBytes: number;
  private readonly maxDetailsPerPoll: number;
  private readonly sessionId: string;
  private warningKinds = new Set<string>();
  // A broken socket cannot restore App-side flags. Keep ownership in memory
  // until the very same VM and Isolate can be reached again, never by URL alone.
  private pendingRestores = new Map<string, Set<string>>();

  constructor(
    private readonly rpc: VmRpc,
    options: VmProfilerOptions = {},
  ) {
    super();
    this.intervalMs = Math.max(100, options.pollIntervalMs ?? options.intervalMs ?? 1000);
    this.maxBodyBytes = Math.max(1024, options.maxBodyBytes ?? 1024 * 1024);
    this.maxDetailsPerPoll = Math.max(1, options.maxDetailsPerPoll ?? 100);
    this.sessionId = options.sessionId ?? randomUUID();
  }

  get isolateIds(): string[] {
    return [...this.states.keys()];
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.captureEnabled = true;
    this.lastDiscovery = 0;
    this.warningKinds.clear();
    if (this.rpc instanceof VmServiceClient) this.rpc.on('notification', this.notification);
    try {
      for (const streamId of ['Isolate', 'Extension']) {
        try {
          await this.rpc.call('streamListen', { streamId });
          this.subscribed.push(streamId);
        } catch {
          /* Another consumer on this connection may own it. */
        }
      }
      await this.pollNow();
      this.schedule();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private notification = (message: any): void => {
    if (message.method !== 'streamNotify') return;
    if (message.params?.streamId === 'Isolate') this.lastDiscovery = 0;
  };

  private warn(kind: string, message: string): void {
    if (this.warningKinds.has(kind)) return;
    this.warningKinds.add(kind);
    this.emit('warning', message);
  }

  private async discover(): Promise<void> {
    const vm = await this.rpc.call<ObjectMap>('getVM');
    const vmIdentity =
      Number.isInteger(vm.pid) && Number.isFinite(vm.startTime)
        ? JSON.stringify([vm.pid, vm.startTime])
        : undefined;
    const isolates: { id: string; isSystemIsolate?: boolean }[] = vm.isolates ?? [];
    const live = new Set(isolates.filter((i) => !i.isSystemIsolate).map((i) => i.id));
    const before = this.isolateIds.join(',');
    for (const id of this.states.keys()) if (!live.has(id)) this.states.delete(id);
    for (const id of live) {
      if (!this.running) return;
      if (this.states.has(id)) continue;
      try {
        const isolate = await this.rpc.call<ObjectMap>('getIsolate', { isolateId: id });
        if (!(isolate.extensionRPCs ?? []).includes('ext.dart.io.getHttpProfile')) continue;
        const old = await this.rpc.call<ObjectMap>('ext.dart.io.httpEnableTimelineLogging', {
          isolateId: id,
        });
        const restoreOwned =
          vmIdentity !== undefined && this.pendingRestores.get(vmIdentity)?.has(id) === true;
        if ((this.captureEnabled || this.handshakeCaptureEnabled) && old.enabled !== true)
          await this.rpc.call('ext.dart.io.httpEnableTimelineLogging', { isolateId: id, enabled: true });
        this.states.set(id, {
          id,
          vmIdentity,
          enabledByUs:
            restoreOwned || ((this.captureEnabled || this.handshakeCaptureEnabled) && old.enabled !== true),
        });
        if (restoreOwned) this.forgetPendingRestore(vmIdentity!, id);
      } catch {
        this.warn(`isolate:${id}`, '部分 Isolate 暂不可采集，将在后续连接检查中重试');
      }
    }
    this.lastDiscovery = Date.now();
    const after = this.isolateIds.join(',');
    if (after !== before) this.emit('isolates', this.isolateIds);
    if (!this.states.size)
      this.warn(
        'unsupported',
        '当前 Isolate 尚未提供 HTTP profiling；请使用支持 dart:io 的 Flutter 调试应用',
      );
  }

  private forgetPendingRestore(vmIdentity: string | undefined, id: string): void {
    if (!vmIdentity) return;
    const pending = this.pendingRestores.get(vmIdentity);
    pending?.delete(id);
    if (!pending?.size) this.pendingRestores.delete(vmIdentity);
  }

  /** Public for deterministic testing and an explicit UI refresh; concurrent calls share a poll. */
  pollNow(): Promise<void> {
    if (this.work) return this.work;
    this.work = this.poll().finally(() => {
      this.work = undefined;
    });
    return this.work;
  }

  /** Injection emits its own snapshots; stop redundant SDK body collection then. */
  async setCaptureEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.captureEnabled) return;
    this.captureEnabled = enabled;
    await this.updateCaptureFlags();
  }

  async setHandshakeCaptureEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.handshakeCaptureEnabled) return;
    this.handshakeCaptureEnabled = enabled;
    await this.updateCaptureFlags();
  }

  private updateCaptureFlags(): Promise<void> {
    const work = this.flagWork.then(() => this.applyCaptureFlags());
    this.flagWork = work.catch(() => undefined);
    return work;
  }

  private async applyCaptureFlags(): Promise<void> {
    await this.work?.catch(() => {});
    const enabled = this.captureEnabled || this.handshakeCaptureEnabled;
    for (const state of this.states.values()) {
      try {
        if (!enabled && state.enabledByUs) {
          await this.rpc.call('ext.dart.io.httpEnableTimelineLogging', {
            isolateId: state.id,
            enabled: false,
          });
          state.enabledByUs = false;
          this.forgetPendingRestore(state.vmIdentity, state.id);
        } else if (enabled) {
          const current = await this.rpc.call<ObjectMap>('ext.dart.io.httpEnableTimelineLogging', {
            isolateId: state.id,
          });
          if (current.enabled !== true) {
            await this.rpc.call('ext.dart.io.httpEnableTimelineLogging', {
              isolateId: state.id,
              enabled: true,
            });
            state.enabledByUs = true;
          }
        }
      } catch {
        this.warn(`capture:${state.id}`, '调整 VM 网络采集状态失败，请检查调试连接');
      }
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    if (Date.now() - this.lastDiscovery > 3000) await this.discover();
    let remaining = this.maxDetailsPerPoll;
    for (const state of this.states.values()) {
      if (!this.running) break;
      if (!this.captureEnabled && !this.handshakeCaptureEnabled) continue;
      try {
        const profile = await this.rpc.call<ObjectMap>('ext.dart.io.getHttpProfile', {
          isolateId: state.id,
          ...(state.cursor !== undefined ? { updatedSince: state.cursor } : {}),
        });
        const references: ObjectMap[] = Array.isArray(profile.requests) ? profile.requests : [];
        let exhausted = false;
        for (const reference of references) {
          if (!this.running) break;
          const key = `${state.id}:${reference.id}`;
          if (this.completed.has(key)) continue;
          const complete = reference.response?.endTime != null || reference.request?.error != null;
          if (!complete) continue;
          if (remaining <= 0) {
            exhausted = true;
            break;
          }
          remaining--;
          const details = await this.rpc.call<ObjectMap>('ext.dart.io.getHttpProfileRequest', {
            isolateId: state.id,
            id: reference.id,
          });
          if (!this.running) break;
          const entry = normalizeHttpProfile(details, this.sessionId, state.id, this.maxBodyBytes);
          this.completed.add(key);
          // A bounded identity cache avoids plugin-side unbounded growth. The
          // updatedSince cursor means old completed requests need not be retained.
          if (this.completed.size > 20000) this.completed.delete(this.completed.values().next().value!);
          if (entry) {
            if (isWebSocketHandshake(entry)) {
              this.emit('websocket', entry, websocketHandshake(details, entry, state.id));
            } else if (this.captureEnabled) {
              this.recorded++;
              this.emit('history', entry);
            }
          }
        }
        if (!exhausted && Number.isFinite(profile.timestamp))
          state.cursor = Math.max(state.cursor ?? 0, profile.timestamp - 1);
      } catch {
        this.warn(`poll:${state.id}`, '读取 VM 网络记录失败；应用可能已重启，正在等待重新发现');
        this.lastDiscovery = 0;
      }
    }
    this.emit('status', { isolates: this.states.size, recorded: this.recorded });
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.pollNow();
      } catch {
        this.warn('connection', 'VM 网络采集暂时不可用，请检查调试连接');
      }
      this.schedule();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.rpc instanceof VmServiceClient) this.rpc.off('notification', this.notification);
    await this.work?.catch(() => {});
    await this.flagWork.catch(() => undefined);
    for (const state of this.states.values()) {
      if (!state.enabledByUs) continue;
      try {
        await this.rpc.call('ext.dart.io.httpEnableTimelineLogging', { isolateId: state.id, enabled: false });
        this.forgetPendingRestore(state.vmIdentity, state.id);
      } catch {
        if (state.vmIdentity) {
          const pending = this.pendingRestores.get(state.vmIdentity) ?? new Set<string>();
          pending.add(state.id);
          this.pendingRestores.set(state.vmIdentity, pending);
        }
        this.warn(
          'restore',
          '无法确认恢复 SDK 网络采集开关，应用可能继续采集并占用内存；连接已断开时无法立即关闭。请重新连接同一应用后再断开，或 Hot Restart 恢复；无法识别 VM 身份时请使用 Hot Restart。不会自动清空 DevTools 网络缓存。',
        );
      }
    }
    for (const streamId of this.subscribed) {
      try {
        await this.rpc.call('streamCancel', { streamId });
      } catch {
        /* Disconnected. */
      }
    }
    this.subscribed = [];
    this.states.clear();
    this.handshakeCaptureEnabled = false;
  }
}

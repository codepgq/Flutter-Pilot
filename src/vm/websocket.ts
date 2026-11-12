import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dartLiteral } from './injection';
import { VmServiceClient, type VmRpc } from './client';
import type { WsConnection, WsHandshake, WsMessage, WsRule } from '../ws/model';
import { validateWsRuleDocument } from '../ws/rules';

type ObjectMap = Record<string, any>;
interface Anchor {
  isolateId: string;
  libraryId: string;
  stateId: string;
  zoneId: string;
}
interface SocketIdentity {
  serviceId: number;
  localPort: number;
  remotePort: number;
  remoteAddress: string;
}

/** A URL is known only when an unambiguous HTTP upgrade identifies this exact socket. */
export function matchWsHandshake(
  isolateId: string,
  socket: SocketIdentity,
  handshakes: WsHandshake[],
): WsHandshake | undefined {
  const candidates = handshakes.filter(
    (item) =>
      item.isolateId === isolateId &&
      item.localPort === socket.localPort &&
      item.remotePort === socket.remotePort &&
      normalizeAddress(item.remoteAddress) === normalizeAddress(socket.remoteAddress),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
/** Prevents a reused TCP port from assigning an old handshake to another WS object. */
export class WsHandshakeOwnership {
  private readonly owners = new Map<string, number>();
  private readonly sockets = new Map<string, WsHandshake>();
  claim(isolateId: string, socket: SocketIdentity, handshakes: WsHandshake[]): WsHandshake | undefined {
    const socketKey = `${isolateId}:${socket.serviceId}`;
    const existing = this.sockets.get(socketKey);
    if (existing) return existing;
    const candidate = matchWsHandshake(isolateId, socket, handshakes);
    if (!candidate || this.owners.size >= 10000 || this.sockets.size >= 10000) return;
    const key = JSON.stringify([
      candidate.isolateId,
      candidate.localPort,
      candidate.remotePort,
      normalizeAddress(candidate.remoteAddress),
      candidate.timestamp,
      candidate.entry?.id ?? candidate.url,
    ]);
    const owner = this.owners.get(key);
    if (owner !== undefined && owner !== socket.serviceId) return;
    this.owners.set(key, socket.serviceId);
    this.sockets.set(socketKey, candidate);
    return candidate;
  }
  get limited(): boolean {
    return this.owners.size >= 10000 || this.sockets.size >= 10000;
  }
  clear(): void {
    this.owners.clear();
    this.sockets.clear();
  }
}

const urlRegex = (pattern: string) =>
  '^' +
  [...pattern]
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&')))
    .join('') +
  '$';
const normalizeAddress = (value: string) => value.replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '');

/** Experimental Debug/JIT WebSocket interception. Network callbacks never wait for IDE RPC. */
export class WsVmInjector extends EventEmitter {
  private session = randomUUID();
  private readonly anchors = new Map<string, Anchor>();
  private readonly connections = new Map<string, WsConnection>();
  private operation: Promise<unknown> = Promise.resolve();
  private template?: string;
  private unsafeUntil = 0;
  private disposed = false;
  private generation = 0;
  private readonly handshakes = new WsHandshakeOwnership();
  readonly maxBodyBytes: number;
  private readonly listener: (notification: any) => void;

  constructor(
    private readonly rpc: VmRpc,
    private readonly options: { templatePath?: string; maxBodyBytes?: number } = {},
  ) {
    super();
    this.maxBodyBytes = Math.max(1, Math.min(256 * 1024, options.maxBodyBytes ?? 256 * 1024));
    this.listener = (notification: any) => {
      const event = notification?.params?.event;
      const data = event?.extensionData;
      if (event?.extensionKind !== 'flutter_pilot.vm.ws' || data?.session !== this.session) return;
      if (Number.isSafeInteger(data.omitted) && data.omitted > 0) this.emit('omitted', data.omitted);
      if (!Array.isArray(data.messages)) return;
      for (const item of data.messages.slice(0, 100)) {
        if (
          typeof item?.id !== 'string' ||
          typeof item.connectionId !== 'string' ||
          !item.connectionId.startsWith(`${this.session}:`) ||
          !Number.isFinite(item.timestamp) ||
          !['inbound', 'outbound'].includes(item.direction) ||
          !['text', 'binary'].includes(item.kind) ||
          !['text', 'base64'].includes(item.encoding) ||
          !['original', 'replaced', 'dropped', 'synthetic'].includes(item.outcome) ||
          typeof item.original !== 'string' ||
          typeof item.truncated !== 'boolean' ||
          !Number.isSafeInteger(item.bytes) ||
          item.bytes < 0 ||
          Buffer.byteLength(item.original, 'utf8') > this.maxBodyBytes * 2 + 16 ||
          (item.effective !== undefined &&
            (typeof item.effective !== 'string' ||
              Buffer.byteLength(item.effective, 'utf8') > this.maxBodyBytes))
        ) {
          this.emit('omitted', 1);
          continue;
        }
        this.emit('message', item as WsMessage);
      }
    };
    (rpc as VmRpc & { on?: (event: string, listener: (value: any) => void) => void }).on?.(
      'notification',
      this.listener,
    );
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work);
    this.operation = result.catch(() => undefined);
    return result;
  }

  private async evaluate(
    isolateId: string,
    targetId: string,
    expression: string,
    scope: Record<string, string> = {},
    idZoneId?: string,
  ): Promise<ObjectMap> {
    const value = await this.rpc.call<ObjectMap>('evaluate', {
      isolateId,
      targetId,
      expression,
      scope,
      disableBreakpoints: true,
      ...(idZoneId ? { idZoneId } : {}),
    });
    if (['@Error', 'Error', 'Sentinel'].includes(value.type))
      throw new Error('当前 VM 的 WebSocket 运行时结构不支持此操作（仅支持兼容的 Debug / JIT）');
    if (value.valueAsStringIsTruncated && value.id)
      return this.rpc.call<ObjectMap>('getObject', { isolateId, objectId: value.id });
    return value;
  }

  private async loadTemplate(): Promise<string> {
    if (!this.template) {
      try {
        this.template = await readFile(
          this.options.templatePath ?? join(__dirname, '../resources/vm/websocket.dart.txt'),
          'utf8',
        );
      } catch (error) {
        if (this.options.templatePath) throw error;
        this.template = await readFile(join(__dirname, '../../resources/vm/websocket.dart.txt'), 'utf8');
      }
    }
    return this.template;
  }

  scan(
    isolateIds: string[],
    rules: WsRule[],
    mockEnabled: boolean,
    handshakes: WsHandshake[] = [],
  ): Promise<WsConnection[]> {
    return this.enqueue(() => this.scanNow(isolateIds, rules, mockEnabled, handshakes));
  }

  private async scanNow(
    isolateIds: string[],
    rules: WsRule[],
    mockEnabled: boolean,
    handshakes: WsHandshake[],
  ): Promise<WsConnection[]> {
    if (this.disposed) throw new Error('WS 采集会话已关闭');
    if (Date.now() < this.unsafeUntil)
      throw new Error('上次 WS 接入未确认卸载，请等待旧处理器 15 秒租约到期后重试');
    validateWsRuleDocument({ version: 1, rules });
    for (const rule of rules)
      if (
        rule.action.type === 'replace' &&
        Buffer.byteLength(rule.action.text ?? '', 'utf8') > this.maxBodyBytes
      )
        throw new Error(`WS 替换消息不能超过 ${this.maxBodyBytes} 字节`);
    const serialized = JSON.stringify(
      rules
        .filter((rule) => rule.enabled)
        .map((rule, index) => ({
          ...rule,
          _index: index,
          ...(rule.match.url ? { _urlRegex: urlRegex(rule.match.url) } : {}),
        }))
        .sort((a, b) => b.priority - a.priority || a._index - b._index),
    );
    if (Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024)
      throw new Error('WS 已启用规则总大小超过 2 MiB，请减少规则或正文');
    const generation = this.generation;
    const live = new Set(isolateIds);
    for (const [id] of this.anchors) if (!live.has(id)) this.anchors.delete(id);
    for (const connection of this.connections.values())
      if (!live.has(connection.isolateId) && connection.status === 'open') {
        connection.status = 'closed';
        connection.closedAt = Date.now();
      }
    let succeeded = 0;
    let failed = false;
    for (const isolateId of live) {
      try {
        const isolate = await this.rpc.call<ObjectMap>('getIsolate', { isolateId });
        if (isolate.isSystemIsolate === true) continue;
        const library = isolate.libraries?.find((item: ObjectMap) => item.uri === 'dart:_http');
        const asyncLibrary = isolate.libraries?.find((item: ObjectMap) => item.uri === 'dart:async');
        const developer = isolate.libraries?.find((item: ObjectMap) => item.uri === 'dart:developer');
        if (!library || !asyncLibrary || !developer) {
          this.emit('warning', '部分 Isolate 未提供兼容的 dart:io WebSocket 结构');
          continue;
        }
        const metadata = await this.evaluate(
          isolateId,
          library.id,
          `jsonEncode(_WebSocketImpl._webSockets.values.where((s) => !s._serverSide && s.readyState == WebSocket.open).take(128).map((s) => {'serviceId': s._serviceId, 'localPort': s._socket.port, 'remotePort': s._socket.remotePort, 'remoteAddress': s._socket.remoteAddress.address}).toList())`,
        );
        const sockets: SocketIdentity[] = JSON.parse(metadata.valueAsString);
        const config: ObjectMap = {};
        const linked = new Map<string, WsHandshake>();
        for (const socket of sockets) {
          const handshake = this.handshakes.claim(isolateId, socket, handshakes);
          const controlPort =
            this.rpc instanceof VmServiceClient ? Number(this.rpc.endpoint?.split(':').at(-1)) : undefined;
          const isLoopback = ['127.0.0.1', '::1'].includes(normalizeAddress(socket.remoteAddress));
          const excluded = isLoopback && controlPort !== undefined && socket.remotePort === controlPort;
          config[String(socket.serviceId)] = { excluded, ...(handshake ? { url: handshake.url } : {}) };
          if (handshake) linked.set(String(socket.serviceId), handshake);
        }
        let anchor = this.anchors.get(isolateId);
        if (!anchor) {
          const tools = await this.evaluate(
            isolateId,
            asyncLibrary.id,
            `{'subscription': (dynamic controller) => controller._subscription, 'get': (dynamic sub) => sub._onData, 'set': (dynamic sub, dynamic handler) { sub.onData(handler); return sub._onData; }, 'owns': (dynamic sub, dynamic handler) => identical(sub._onData, handler), 'restore': (dynamic sub, dynamic handler, dynamic old) { if (identical(sub._onData, handler)) sub._onData = old; }}`,
          );
          const emitEvent = await this.evaluate(isolateId, developer.id, 'postEvent');
          const zone = await this.rpc.call<ObjectMap>('createIdZone', {
            isolateId,
            backingBufferKind: 'Ring',
            idAssignmentPolicy: 'AlwaysAllocate',
            capacity: 1,
          });
          try {
            const replacements: Record<string, string> = {
              __SESSION__: dartLiteral(this.session),
              __ISOLATE__: dartLiteral(isolateId),
              __LIMIT__: String(this.maxBodyBytes),
            };
            const expression = (await this.loadTemplate())
              .split(/\r?\n/)
              .filter((line) => !line.trimStart().startsWith('//'))
              .join(' ')
              .replace(/__SESSION__|__ISOLATE__|__LIMIT__/g, (marker) => replacements[marker]);
            const state = await this.evaluate(
              isolateId,
              library.id,
              expression,
              { tools: tools.id, emitEvent: emitEvent.id },
              zone.id,
            );
            if (generation !== this.generation) {
              await this.evaluate(isolateId, library.id, `state['detach']()`, { state: state.id }).catch(
                () => undefined,
              );
              throw new Error('WS 采集操作已失效');
            }
            anchor = { isolateId, libraryId: library.id, stateId: state.id, zoneId: zone.id };
            this.anchors.set(isolateId, anchor);
          } catch (error) {
            this.unsafeUntil = Date.now() + 16000;
            await this.rpc.call('deleteIdZone', { isolateId, idZoneId: zone.id }).catch(() => undefined);
            throw error;
          }
        }
        if (generation !== this.generation) throw new Error('WS 采集操作已失效');
        const result = await this.evaluate(
          isolateId,
          anchor.libraryId,
          `(() { if (state['enabled'] != true) throw StateError('expired'); state['rules'] = jsonDecode(${dartLiteral(serialized)}); state['config'] = jsonDecode(${dartLiteral(JSON.stringify(config))}); state['mock'] = ${mockEnabled}; state['expiresAt'] = DateTime.now().millisecondsSinceEpoch + 15000; return state['scan'](); })()`,
          { state: anchor.stateId },
        );
        const decoded = JSON.parse(result.valueAsString);
        if (decoded.limited)
          this.emit('warning', '每个 Isolate 最多接入 128 个业务 WebSocket，其余连接未保证覆盖');
        for (const connection of decoded.connections as WsConnection[]) {
          const serviceId = connection.id.split(':').at(-1)!;
          const handshake = linked.get(serviceId);
          if (handshake?.entry) connection.handshake = handshake.entry;
          this.connections.set(connection.id, connection);
        }
        succeeded++;
      } catch {
        failed = true;
        this.emit('warning', '部分 Isolate 的 WS 接入失败或不兼容；未接入连接保持原样，可重新扫描');
      }
    }
    if (this.handshakes.limited)
      this.emit('warning', '本次 WS 会话的 URL 关联缓存已达上限，新连接将显示 URL 未知；重新开启采集可重置');
    if (failed) throw new Error('WS 运行时扫描或规则同步未全部确认成功；请停止采集并等待旧租约到期后重试');
    if (live.size && !succeeded && !this.anchors.size)
      throw new Error('当前 VM 未提供兼容的业务 WebSocket 接入能力，请检查 Flutter Debug / Dart SDK');
    const result = [...this.connections.values()];
    if (result.length > 10000) {
      for (const connection of result
        .filter((item) => item.status !== 'open')
        .slice(0, result.length - 10000))
        this.connections.delete(connection.id);
    }
    return [...this.connections.values()].map((item) => ({ ...item }));
  }

  push(connectionId: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.dispatch('push', connectionId, text, signal);
  }

  send(connectionId: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.dispatch('send', connectionId, text, signal);
  }

  private dispatch(
    action: 'push' | 'send',
    connectionId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (signal?.aborted) throw new Error('WS 消息操作已取消，未执行发送');
      if (this.disposed) throw new Error('WS 采集会话已关闭');
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > this.maxBodyBytes)
        throw new Error(`手动 WS 消息不能超过 ${this.maxBodyBytes} 字节`);
      const connection = this.connections.get(connectionId);
      if (!connection || connection.status !== 'open' || connection.capture !== 'attached')
        throw new Error('所选 WS 连接未接入或已经关闭，请重新选择在线连接');
      const anchor = this.anchors.get(connection.isolateId);
      if (!anchor) throw new Error('WS 采集已断开，请重新开启采集');
      const generation = this.generation;
      try {
        if (signal?.aborted) throw new Error('cancelled');
        await this.evaluate(
          anchor.isolateId,
          anchor.libraryId,
          `state['${action}'](${dartLiteral(connectionId)}, ${dartLiteral(text)})`,
          { state: anchor.stateId },
        );
        if (generation !== this.generation || signal?.aborted) throw new Error('invalidated');
      } catch {
        throw new Error(
          `${action === 'push' ? '模拟推送' : '向服务端发送'}未确认：请检查 WS 采集、当前连接及消息记录；动作可能已执行，请勿自动重试`,
        );
      }
    });
  }

  detach(): Promise<void> {
    return this.enqueue(async () => {
      let failed = false;
      for (const anchor of this.anchors.values()) {
        try {
          await this.evaluate(anchor.isolateId, anchor.libraryId, `state['detach']()`, {
            state: anchor.stateId,
          });
          await this.rpc.call('deleteIdZone', { isolateId: anchor.isolateId, idZoneId: anchor.zoneId });
        } catch {
          failed = true;
        }
      }
      this.anchors.clear();
      this.connections.clear();
      this.handshakes.clear();
      this.session = randomUUID();
      if (failed) {
        this.unsafeUntil = Date.now() + 16000;
        throw new Error('WS 处理器未全部确认卸载，旧处理器最长约 15 秒后自动旁路，请等待后重试');
      }
    });
  }

  abandon(): void {
    ++this.generation;
    if (this.anchors.size) this.unsafeUntil = Date.now() + 16000;
    this.anchors.clear();
    this.connections.clear();
    this.handshakes.clear();
    this.session = randomUUID();
  }

  async dispose(): Promise<void> {
    await this.detach().catch(() => undefined);
    this.disposed = true;
    (this.rpc as VmRpc & { off?: (event: string, listener: (value: any) => void) => void }).off?.(
      'notification',
      this.listener,
    );
    this.removeAllListeners();
  }
}

import { randomUUID } from 'node:crypto';
import type { Page, WebSocketRoute } from 'playwright';
import {
  wsUrlMatches,
  type WsConnection,
  type WsMessage,
  type WsRule,
  type WsMessageQuery,
} from '../ws/model';
import { BrowserError } from './protocol';
const limit = 256 * 1024;
export class BrowserSockets {
  capture = false;
  mock = false;
  rules: WsRule[] = [];
  private connections = new Map<
    string,
    { info: WsConnection & pageIdentity; page: WebSocketRoute; server: WebSocketRoute }
  >();
  private messages: Array<WsMessage & pageIdentity> = [];
  private bytes = 0;
  constructor(private emit: (event: Record<string, unknown>) => void) {}
  async install(page: Page, pageId: string, runtimeId: string, generation: number) {
    await page.routeWebSocket('**/*', (socket) => {
      const server = socket.connectToServer();
      // Development transport must never be interpreted as application messages.
      if (
        socket.protocols().some((p) => /vite-hmr|webpack|hot-reload/i.test(p)) ||
        /\/(?:_next\/webpack-hmr|sockjs-node|__vite_ping|@vite)(?:[/?]|$)/.test(
          new URL(socket.url()).pathname,
        )
      )
        return;
      const id = randomUUID(),
        identity = { pageId, runtimeId, generation };
      const info: WsConnection & pageIdentity = {
        ...identity,
        id,
        isolateId: pageId,
        endpoint: socket.url(),
        url: socket.url(),
        status: 'open',
        capture: 'attached',
        openedAt: performance.timeOrigin + performance.now(),
        sent: 0,
        received: 0,
      };
      const connection = { info, page: socket, server };
      this.connections.set(id, connection);
      const transfer = (message: string | Buffer, direction: 'inbound' | 'outbound', synthetic = false) => {
        const text = typeof message === 'string',
          bytes = Buffer.byteLength(message),
          original = text ? message : message.toString('base64');
        const rule =
          this.capture && this.mock && text && bytes <= limit && !synthetic
            ? this.rules
                .filter(
                  (r) =>
                    r.enabled &&
                    (!r.match.direction || r.match.direction === direction) &&
                    (r.match.connectionId
                      ? r.match.connectionId === id
                      : wsUrlMatches(r.match.url!, info.url)) &&
                    (r.match.contains === undefined || message.includes(r.match.contains)),
                )
                .sort((a, b) => b.priority - a.priority)[0]
            : undefined;
        const dropped = rule?.action.type === 'drop',
          effective = rule?.action.type === 'replace' ? rule.action.text! : message;
        if (!dropped) (direction === 'inbound' ? socket : server).send(effective);
        if (direction === 'inbound') info.received++;
        else info.sent++;
        if (this.capture) {
          const record: WsMessage & pageIdentity = {
            ...identity,
            id: randomUUID(),
            connectionId: id,
            timestamp: performance.timeOrigin + performance.now(),
            direction,
            kind: text ? 'text' : 'binary',
            original: original.slice(0, limit),
            effective: dropped
              ? undefined
              : (typeof effective === 'string' ? effective : effective.toString('base64')).slice(0, limit),
            encoding: text ? 'text' : 'base64',
            bytes,
            truncated: bytes > limit,
            outcome: synthetic ? 'synthetic' : dropped ? 'dropped' : rule ? 'replaced' : 'original',
            ...(rule ? { ruleId: rule.id } : {}),
          };
          this.messages.unshift(record);
          this.bytes += Buffer.byteLength(JSON.stringify(record));
          while (this.messages.length > 1000 || this.bytes > 16 * 1024 * 1024) {
            const removed = this.messages.pop();
            if (removed) this.bytes -= Buffer.byteLength(JSON.stringify(removed));
            else break;
          }
          this.emit({ event: 'ws', message: record, ...identity });
        }
      };
      socket.onMessage((message) => transfer(message, 'outbound'));
      server.onMessage((message) => transfer(message, 'inbound'));
      const closed = (other: WebSocketRoute, code?: number, reason?: string) => {
        info.status = 'closed';
        info.closedAt = performance.timeOrigin + performance.now();
        void other.close({ ...(code && code !== 1006 ? { code } : {}), reason });
      };
      socket.onClose((code, reason) => closed(server, code, reason));
      server.onClose((code, reason) => closed(socket, code, reason));
      Object.assign(connection, { transfer });
      page.once('close', () => {
        info.status = 'closed';
        info.closedAt = performance.timeOrigin + performance.now();
      });
    });
  }
  list() {
    return [...this.connections.values()].map((v) => ({
      ...v.info,
      capture: this.capture ? 'attached' : 'unsupported',
    }));
  }
  clearHistory() {
    const cleared = this.messages.length;
    this.messages = [];
    this.bytes = 0;
    for (const [id, connection] of this.connections)
      if (connection.info.status !== 'open') this.connections.delete(id);
    return { ok: true, cleared };
  }
  history(query: WsMessageQuery) {
    const rows = this.messages.filter(
      (r) =>
        (!query.connectionId || r.connectionId === query.connectionId) &&
        (!query.direction || r.direction === query.direction) &&
        (!query.search || r.original.includes(query.search)),
    );
    const result = {
      items: rows
        .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50))
        .map(({ original, effective, ...rest }) => ({
          ...rest,
          preview: (effective ?? original).slice(0, 512),
          ...((query as WsMessageQuery & { includeBodies?: boolean }).includeBodies
            ? { original, effective }
            : {}),
        })),
      total: rows.length,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 3 * 1024 * 1024)
      throw new BrowserError('RESULT_TOO_LARGE', 'Reduce limit or query one message by id.');
    return result;
  }
  get(id: string) {
    const row = this.messages.find((v) => v.id === id);
    if (!row) throw new BrowserError('NOT_FOUND', 'WS message does not belong to this Context.');
    return row;
  }
  deliver(id: string, text: string, direction: 'inbound' | 'outbound') {
    if (!this.capture) throw new BrowserError('CAPTURE_DISABLED', 'WS capture must be enabled.');
    if (Buffer.byteLength(text) > limit)
      throw new BrowserError('INVALID_ARGUMENTS', 'WS message exceeds 256 KiB.');
    const c = this.connections.get(id) as (typeof this.connections extends Map<string, infer T>
      ? T
      : never) & {
      transfer: (message: string, direction: 'inbound' | 'outbound', synthetic: boolean) => void;
    };
    if (!c || c.info.status !== 'open')
      throw new BrowserError('CONNECTION_STALE', 'Connection is closed or belongs to another Context.');
    c.transfer(text, direction, direction === 'inbound');
    return {
      ok: true,
      submitted: true,
      connectionId: id,
      direction,
      synthetic: direction === 'inbound',
      confirmed: false,
    };
  }
}
interface pageIdentity {
  pageId: string;
  runtimeId: string;
  generation: number;
}

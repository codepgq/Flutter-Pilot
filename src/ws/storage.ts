import { spawn } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WsConnection, WsMessage, WsMessageQuery, WsMessageResult, WsMessageSummary } from './model';

export interface WsHistorySettings {
  retentionDays: number;
  maxRecords: number;
  maxBodyBytes?: number;
}
const sqlText = (value: string) => `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
function number(value: number): string {
  if (!Number.isFinite(value)) throw new Error('WS 历史数值无效');
  return String(value);
}
function prefixText(value: string, bytes: number): string {
  const prefix = Buffer.from(value).subarray(0, bytes);
  for (let end = prefix.length; end >= Math.max(0, prefix.length - 3); end--) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, end));
    } catch {
      // An incomplete code point at the record boundary is omitted.
    }
  }
  return '';
}
function summary(value: WsMessage): WsMessageSummary {
  const { original, effective, ...metadata } = value;
  return { ...metadata, preview: (effective ?? original).slice(0, 160) };
}

/** Bounded, private WS history independent from HTTP storage and proxy engines. */
export class WsHistoryStore {
  readonly file: string;
  private readonly settings: Required<WsHistorySettings>;
  private tail: Promise<unknown> = Promise.resolve();
  private initializing?: Promise<void>;
  private closed = false;
  private queued = 0;
  constructor(
    readonly folder: string,
    settings: WsHistorySettings,
  ) {
    if (
      !Number.isInteger(settings.retentionDays) ||
      settings.retentionDays < 1 ||
      settings.retentionDays > 365 ||
      !Number.isInteger(settings.maxRecords) ||
      settings.maxRecords < 1 ||
      settings.maxRecords > 100000 ||
      (settings.maxBodyBytes !== undefined &&
        (!Number.isInteger(settings.maxBodyBytes) ||
          settings.maxBodyBytes < 1 ||
          settings.maxBodyBytes > 10 * 1024 * 1024))
    )
      throw new Error('WS 历史保留配置无效');
    this.file = join(folder, 'ws-history.sqlite3');
    this.settings = { ...settings, maxBodyBytes: Math.min(settings.maxBodyBytes ?? 1024 * 1024, 256 * 1024) };
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('WS 历史存储已关闭'));
    if (this.queued >= 200) return Promise.reject(new Error('WS 历史队列已满，部分消息未记录'));
    this.queued++;
    const task = this.tail.then(work);
    this.tail = task
      .catch(() => undefined)
      .finally(() => {
        this.queued--;
      });
    return task;
  }
  private sql<T extends Record<string, unknown>>(query: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sqlite3', ['-batch', '-bail', '-json', this.file], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      const output: Buffer[] = [];
      let bytes = 0;
      let failure: string | undefined;
      const timer = setTimeout(() => {
        failure = 'WS 历史操作超时';
        child.kill('SIGKILL');
      }, 15000);
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('无法启动系统 SQLite'));
      });
      // SQLite errors may quote SQL containing authentication or business content.
      child.stderr.resume();
      child.stdin.on('error', () => {
        failure ??= 'WS 历史无法接收数据';
      });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          failure = 'WS 历史查询过大，请缩小范围';
          child.kill('SIGKILL');
        } else output.push(chunk);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure || code !== 0) return reject(new Error(failure ?? 'WS 历史存储操作失败'));
        try {
          const text = Buffer.concat(output).toString('utf8').trim();
          resolve(text ? (JSON.parse(text) as T[]) : []);
        } catch {
          reject(new Error('WS 历史存储返回了无效数据'));
        }
      });
      child.stdin.end(`.timeout 5000\n${query}\n`);
    });
  }
  init(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('WS 历史存储已关闭'));
    this.initializing ??= this.enqueue(async () => {
      await mkdir(this.folder, { recursive: true, mode: 0o700 });
      await chmod(this.folder, 0o700);
      await this.sql(`
        CREATE TABLE IF NOT EXISTS ws_connections (id TEXT PRIMARY KEY, opened REAL NOT NULL, updated REAL NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ws_messages (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, timestamp REAL NOT NULL, direction TEXT NOT NULL, original TEXT NOT NULL, effective TEXT, summary TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ws_messages_timestamp ON ws_messages(timestamp DESC,id DESC);
        CREATE INDEX IF NOT EXISTS ws_messages_connection ON ws_messages(connection_id,timestamp DESC,id DESC);
        ${this.pruneSql()}
      `);
      await chmod(this.file, 0o600);
    });
    return this.initializing;
  }
  private pruneSql(): string {
    const cutoff = Date.now() - this.settings.retentionDays * 86400000;
    return `DELETE FROM ws_messages WHERE timestamp<${number(cutoff)};
      DELETE FROM ws_messages WHERE id IN (SELECT id FROM ws_messages ORDER BY timestamp DESC,id DESC LIMIT -1 OFFSET ${this.settings.maxRecords});
      DELETE FROM ws_connections WHERE updated<${number(cutoff)} AND json_extract(payload,'$.status')!='open';
      DELETE FROM ws_connections WHERE id IN (SELECT id FROM ws_connections WHERE json_extract(payload,'$.status')!='open' ORDER BY updated DESC,id DESC LIMIT -1 OFFSET ${this.settings.maxRecords});`;
  }
  async putConnection(connection: WsConnection): Promise<void> {
    if (!connection.id || !Number.isFinite(connection.openedAt) || !connection.isolateId)
      throw new Error('WS 连接记录无效');
    const copy = JSON.parse(JSON.stringify(connection)) as WsConnection;
    // Handshakes contain metadata; do not propagate HTTP body snapshots on every WS list update.
    if (copy.handshake) {
      for (const key of [
        'originalRequest',
        'request',
        'automaticRequest',
        'originalResponse',
        'response',
        'automaticResponse',
      ] as const) {
        const snapshot = copy.handshake[key];
        if (snapshot) {
          snapshot.body = '';
          snapshot.bodyBytes = 0;
          snapshot.editable = false;
        }
      }
    }
    if (Buffer.byteLength(JSON.stringify(copy)) > 64 * 1024) throw new Error('WS 连接元数据超过上限');
    await this.init();
    await this.enqueue(async () => {
      await this
        .sql(`INSERT INTO ws_connections(id,opened,updated,payload) VALUES(${sqlText(copy.id)},${number(copy.openedAt)},${number(copy.closedAt ?? copy.openedAt)},${sqlText(JSON.stringify(copy))})
        ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,payload=excluded.payload; ${this.pruneSql()}`);
    });
  }
  async connections(): Promise<WsConnection[]> {
    await this.init();
    return this.enqueue(async () => {
      const rows = await this.sql<{ payload: string }>(
        `SELECT payload FROM ws_connections ORDER BY opened DESC,id DESC LIMIT 256;`,
      );
      return rows.map((row) => JSON.parse(row.payload) as WsConnection);
    });
  }
  private bounded(value: WsMessage): WsMessage {
    if (
      !value.id ||
      !value.connectionId ||
      !Number.isFinite(value.timestamp) ||
      typeof value.original !== 'string' ||
      !['text', 'base64'].includes(value.encoding)
    )
      throw new Error('WS 消息记录无效');
    const copy = { ...value };
    let truncated = copy.truncated;
    for (const key of ['original', 'effective'] as const) {
      const text = copy[key];
      if (text === undefined) continue;
      const raw = Buffer.from(text, copy.encoding === 'base64' ? 'base64' : 'utf8');
      if (key === 'original') copy.bytes = Math.max(Number.isFinite(copy.bytes) ? copy.bytes : 0, raw.length);
      if (raw.length <= this.settings.maxBodyBytes) continue;
      copy[key] =
        copy.encoding === 'base64'
          ? raw.subarray(0, this.settings.maxBodyBytes).toString('base64')
          : prefixText(text, this.settings.maxBodyBytes);
      truncated = true;
    }
    copy.truncated = truncated;
    return copy;
  }
  async putMessage(message: WsMessage): Promise<void> {
    const copy = this.bounded(message);
    await this.init();
    await this.enqueue(async () => {
      await this.sql(
        `INSERT OR IGNORE INTO ws_messages(id,connection_id,timestamp,direction,original,effective,summary,payload) VALUES(${sqlText(copy.id)},${sqlText(copy.connectionId)},${number(copy.timestamp)},${sqlText(copy.direction)},${sqlText(copy.original)},${copy.effective === undefined ? 'NULL' : sqlText(copy.effective)},${sqlText(JSON.stringify(summary(copy)))},${sqlText(JSON.stringify(copy))}); ${this.pruneSql()}`,
      );
    });
  }
  async get(id: string): Promise<WsMessage> {
    await this.init();
    return this.enqueue(async () => {
      const rows = await this.sql<{ payload: string }>(
        `SELECT payload FROM ws_messages WHERE id=${sqlText(id)};`,
      );
      if (!rows.length) throw new Error('WS 消息不存在或已被清理');
      return JSON.parse(rows[0].payload) as WsMessage;
    });
  }
  async list(query: WsMessageQuery = {}): Promise<WsMessageResult> {
    await this.init();
    const predicates: string[] = [];
    if (query.connectionId) predicates.push(`connection_id=${sqlText(query.connectionId)}`);
    if (query.direction) {
      if (!['inbound', 'outbound'].includes(query.direction)) throw new Error('WS 消息方向无效');
      predicates.push(`direction=${sqlText(query.direction)}`);
    }
    if (query.search) {
      if (query.search.length > 16384) throw new Error('WS 搜索内容过长');
      const escaped = sqlText(`%${query.search.replace(/[\\%_]/g, '\\$&')}%`);
      predicates.push(`(original LIKE ${escaped} ESCAPE '\\' OR effective LIKE ${escaped} ESCAPE '\\')`);
    }
    const where = predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '';
    const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(200, Math.trunc(query.limit!))) : 50;
    const offset = Number.isFinite(query.offset) ? Math.max(0, Math.trunc(query.offset!)) : 0;
    return this.enqueue(async () => {
      await this.sql(this.pruneSql());
      const rows = await this.sql<{ result: string }>(
        `SELECT json_object('total',(SELECT count(*) FROM ws_messages${where}),'items',json((SELECT coalesce(json_group_array(json(summary)),'[]') FROM (SELECT summary FROM ws_messages${where} ORDER BY timestamp DESC,id DESC LIMIT ${limit} OFFSET ${offset})))) AS result;`,
      );
      return JSON.parse(rows[0].result) as WsMessageResult;
    });
  }
  async clear(connectionId?: string): Promise<void> {
    await this.init();
    await this.enqueue(async () => {
      await this.sql(
        `DELETE FROM ws_messages${connectionId ? ` WHERE connection_id=${sqlText(connectionId)}` : ''};`,
      );
    });
  }
  async deleteConnection(id: string): Promise<void> {
    await this.init();
    await this.enqueue(async () => {
      await this.sql(`DELETE FROM ws_connections WHERE id=${sqlText(id)};`);
    });
  }
  async disconnectAll(): Promise<void> {
    await this.init();
    await this.enqueue(async () => {
      await this.sql(
        `UPDATE ws_connections SET updated=${number(Date.now())},payload=json_set(payload,'$.status','disconnected','$.closedAt',${number(Date.now())}) WHERE json_extract(payload,'$.status')='open';`,
      );
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}

import { spawn } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ApiCatalogEntry,
  ApiCatalogQuery,
  ApiCatalogResult,
  BodySnapshot,
  HistoryEntry,
  HistoryQuery,
  HistoryResult,
} from '../model';

export interface VmHistorySettings {
  retentionDays: number;
  maxRecords: number;
  maxBodyBytes?: number;
}

// All text is a hex literal, including JSON. Besides SQL quotes this protects
// sqlite's line-oriented CLI from user content beginning with a dot command.
const sqlText = (value: string): string => `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('VM 历史数值无效');
  return String(value);
}
const optionalText = (value?: string): string => (value === undefined ? 'NULL' : sqlText(value));
const escapedLike = (value: string): string => sqlText(`%${value.replace(/[\\%_]/g, '\\$&')}%`);

/** Workspace-private VM history; no proxy engine or user Python is required. */
export class VmHistoryStore {
  readonly file: string;
  private readonly settings: Required<VmHistorySettings>;
  private tail: Promise<unknown> = Promise.resolve();
  private initializing?: Promise<void>;
  private closed = false;
  private queued = 0;
  private readonly maxOutput = 128 * 1024 * 1024;

  constructor(
    readonly folder: string,
    settings: VmHistorySettings,
  ) {
    this.file = join(folder, 'vm-history.sqlite3');
    this.settings = { ...settings, maxBodyBytes: settings.maxBodyBytes ?? 1024 * 1024 };
    if (
      !Number.isInteger(settings.retentionDays) ||
      settings.retentionDays < 1 ||
      settings.retentionDays > 365 ||
      !Number.isInteger(settings.maxRecords) ||
      settings.maxRecords < 1 ||
      settings.maxRecords > 100000 ||
      !Number.isInteger(this.settings.maxBodyBytes) ||
      this.settings.maxBodyBytes < 1 ||
      this.settings.maxBodyBytes > 10 * 1024 * 1024
    )
      throw new Error('VM 历史保留配置无效');
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('VM 历史存储已关闭'));
    if (this.queued >= 200) return Promise.reject(new Error('VM 历史写入队列已满，请稍后重试'));
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
        failure = 'VM 历史存储操作超时';
        child.kill('SIGKILL');
      }, 15000);
      const finishError = (message: string) => {
        clearTimeout(timer);
        reject(new Error(message));
      };
      child.on('error', () => finishError('无法启动系统 SQLite，请确认 macOS 的 /usr/bin/sqlite3 可用'));
      // SQL parser errors can quote input including credentials. Never surface
      // stderr, query text or a raw child-process error to the UI/log.
      child.stderr.resume();
      child.stdin.on('error', () => {
        failure ??= 'VM 历史存储无法接收数据';
      });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.maxOutput) {
          failure = 'VM 历史查询结果过大，请缩小查询范围';
          child.kill('SIGKILL');
        } else output.push(chunk);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure || code !== 0) return finishError(failure ?? 'VM 历史存储操作失败');
        try {
          const text = Buffer.concat(output).toString('utf8').trim();
          resolve(text ? (JSON.parse(text) as T[]) : []);
        } catch {
          finishError('VM 历史存储返回了无效数据');
        }
      });
      child.stdin.end(`.timeout 5000\n${query}\n`);
    });
  }

  init(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('VM 历史存储已关闭'));
    this.initializing ??= this.enqueue(async () => {
      await mkdir(this.folder, { recursive: true, mode: 0o700 });
      await chmod(this.folder, 0o700);
      await this.sql(`
        CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, started REAL NOT NULL, method TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, status INTEGER, mocked INTEGER NOT NULL, request_rule TEXT, response_rule TEXT, note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS history_started ON history(started DESC);
        CREATE INDEX IF NOT EXISTS history_api ON history(method,host,path);
        CREATE TABLE IF NOT EXISTS api_catalog (method TEXT NOT NULL,host TEXT NOT NULL,path TEXT NOT NULL,calls INTEGER NOT NULL,first_at REAL NOT NULL,last_at REAL NOT NULL,PRIMARY KEY(method,host,path));
        CREATE INDEX IF NOT EXISTS api_catalog_last ON api_catalog(last_at DESC);
        ${this.pruneSql()}
      `);
      await chmod(this.file, 0o600);
    });
    return this.initializing;
  }

  private pruneSql(): string {
    return `DELETE FROM history WHERE started < ${sqlNumber(Date.now() - this.settings.retentionDays * 86400000)};
      DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY started DESC,id DESC LIMIT -1 OFFSET ${this.settings.maxRecords});`;
  }

  private bounded(entry: HistoryEntry): HistoryEntry {
    const copy = JSON.parse(JSON.stringify(entry)) as HistoryEntry;
    for (const key of [
      'originalRequest',
      'automaticRequest',
      'request',
      'originalResponse',
      'automaticResponse',
      'response',
    ] as const) {
      const snapshot: BodySnapshot | undefined = copy[key];
      if (!snapshot) continue;
      const raw = Buffer.from(snapshot.body, snapshot.bodyEncoding === 'base64' ? 'base64' : 'utf8');
      if (raw.length <= this.settings.maxBodyBytes) continue;
      const prefix = raw.subarray(0, this.settings.maxBodyBytes);
      snapshot.body = prefix.toString(snapshot.bodyEncoding === 'base64' ? 'base64' : 'utf8');
      snapshot.bodyBytes = Math.max(snapshot.bodyBytes, raw.length);
      snapshot.truncated = true;
      snapshot.editable = false;
      snapshot.limitation = '正文超过记录上限，已截断；不影响实际网络请求';
    }
    return copy;
  }

  async put(entry: HistoryEntry): Promise<void> {
    await this.init();
    const bounded = this.bounded(entry);
    const status = bounded.response?.status;
    const payload = sqlText(JSON.stringify(bounded));
    await this.enqueue(async () => {
      await this.sql(`BEGIN IMMEDIATE;
      INSERT INTO api_catalog (method,host,path,calls,first_at,last_at)
      SELECT ${sqlText(bounded.method)},${sqlText(bounded.host)},${sqlText(bounded.path)},1,${sqlNumber(bounded.startedAt)},${sqlNumber(bounded.startedAt)}
      WHERE NOT EXISTS (SELECT 1 FROM history WHERE id=${sqlText(bounded.id)})
      ON CONFLICT(method,host,path) DO UPDATE SET calls=calls+1,first_at=min(first_at,excluded.first_at),last_at=max(last_at,excluded.last_at);
      INSERT INTO history (id,started,method,host,path,status,mocked,request_rule,response_rule,note,tags,payload)
      VALUES (${sqlText(bounded.id)},${sqlNumber(bounded.startedAt)},${sqlText(bounded.method)},${sqlText(bounded.host)},${sqlText(bounded.path)},${status === undefined ? 'NULL' : sqlNumber(status)},${bounded.mocked ? 1 : 0},${optionalText(bounded.requestRuleId)},${optionalText(bounded.responseRuleId)},${sqlText(bounded.note ?? '')},${sqlText(JSON.stringify(bounded.tags ?? []))},${payload})
      ON CONFLICT(id) DO UPDATE SET started=excluded.started,method=excluded.method,host=excluded.host,path=excluded.path,status=excluded.status,mocked=excluded.mocked,request_rule=excluded.request_rule,response_rule=excluded.response_rule,
        payload=json_set(excluded.payload,'$.note',history.note,'$.tags',json(history.tags));
      ${this.pruneSql()}
      COMMIT;`);
    });
  }

  async get(id: string): Promise<HistoryEntry> {
    await this.init();
    return this.enqueue(async () => {
      const rows = await this.sql<{ payload: string }>(
        `SELECT payload FROM history WHERE id=${sqlText(id)};`,
      );
      if (!rows.length) throw new Error('历史记录不存在或已被清理');
      return JSON.parse(rows[0].payload) as HistoryEntry;
    });
  }

  async list(query: HistoryQuery = {}, summary = true): Promise<HistoryResult> {
    await this.init();
    const where: string[] = [];
    if (query.search) {
      const like = escapedLike(query.search);
      where.push(
        `(host LIKE ${like} ESCAPE '\\' OR path LIKE ${like} ESCAPE '\\' OR note LIKE ${like} ESCAPE '\\' OR json_extract(payload,'$.url') LIKE ${like} ESCAPE '\\' OR json_extract(payload,'$.targetUrl') LIKE ${like} ESCAPE '\\' OR tags LIKE ${like} ESCAPE '\\')`,
      );
    }
    for (const key of ['method', 'host', 'path'] as const) {
      if (query[key])
        where.push(`${key}=${sqlText(key === 'method' ? query[key]!.toUpperCase() : query[key]!)}`);
    }
    if (query.status !== undefined) where.push(`status=${sqlNumber(query.status)}`);
    if (query.mocked !== undefined) where.push(`mocked=${query.mocked ? 1 : 0}`);
    if (query.ruleId)
      where.push(`(request_rule=${sqlText(query.ruleId)} OR response_rule=${sqlText(query.ruleId)})`);
    if (query.from !== undefined) where.push(`started>=${sqlNumber(query.from)}`);
    if (query.to !== undefined) where.push(`started<=${sqlNumber(query.to)}`);
    const condition = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(200, Math.trunc(query.limit!))) : 50;
    const offset = Number.isFinite(query.offset) ? Math.max(0, Math.trunc(query.offset!)) : 0;
    const projection = summary
      ? "json_set(json_remove(payload,'$.originalRequest','$.automaticRequest','$.request','$.originalResponse','$.automaticResponse','$.response'),'$.status',status)"
      : 'payload';
    return this.enqueue(async () => {
      const rows = await this.sql<{ result: string }>(
        `SELECT json_object('total',(SELECT count(*) FROM history${condition}),'items',json((SELECT coalesce(json_group_array(json(item)),'[]') FROM (SELECT ${projection} AS item FROM history${condition} ORDER BY started DESC,id DESC LIMIT ${limit} OFFSET ${offset})))) AS result;`,
      );
      return JSON.parse(rows[0].result) as HistoryResult;
    });
  }

  async apis(query: ApiCatalogQuery = {}): Promise<ApiCatalogEntry[]> {
    return (await this.apiPage(query)).items;
  }

  async apiPage(query: ApiCatalogQuery = {}): Promise<ApiCatalogResult> {
    await this.init();
    const where: string[] = [];
    if (query.method) where.push(`method=${sqlText(query.method.toUpperCase())}`);
    const condition = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(200, Math.trunc(query.limit!))) : 30;
    const offset = Number.isFinite(query.offset) ? Math.max(0, Math.trunc(query.offset!)) : 0;
    return this.enqueue(async () => {
      if (query.search) {
        // SQLite LIKE only folds ASCII. Scan bounded batches with JavaScript's
        // Unicode lowercase semantics, preserving the workbench's search behavior.
        const search = query.search.toLowerCase();
        const items: ApiCatalogEntry[] = [];
        let total = 0;
        let cursor: ApiCatalogEntry | undefined;
        while (true) {
          const after = cursor
            ? `${condition ? ' AND ' : ' WHERE '}(last_at < ${sqlNumber(cursor.lastAt)} OR (last_at = ${sqlNumber(cursor.lastAt)} AND (method,host,path) > (${sqlText(cursor.method)},${sqlText(cursor.host)},${sqlText(cursor.path)})))`
            : '';
          const batch = await this.sql<ApiCatalogEntry & Record<string, unknown>>(
            `SELECT method,host,path,calls AS count,first_at AS firstAt,last_at AS lastAt FROM api_catalog${condition}${after} ORDER BY last_at DESC,method,host,path LIMIT 200;`,
          );
          for (const item of batch) {
            if (`${item.method} ${item.host}${item.path}`.toLowerCase().includes(search)) {
              if (total >= offset && total < offset + limit) items.push(item);
              total++;
            }
          }
          if (batch.length < 200) break;
          cursor = batch[batch.length - 1];
        }
        return { items, total };
      }
      const rows = await this.sql<{ result: string }>(
        `SELECT json_object('total',(SELECT count(*) FROM api_catalog${condition}),'items',json((SELECT coalesce(json_group_array(json(item)),'[]') FROM (SELECT json_object('method',method,'host',host,'path',path,'count',calls,'firstAt',first_at,'lastAt',last_at) AS item FROM api_catalog${condition} ORDER BY last_at DESC,method,host,path LIMIT ${limit} OFFSET ${offset})))) AS result;`,
      );
      return JSON.parse(rows[0].result) as ApiCatalogResult;
    });
  }

  async delete(ids: string[]): Promise<{ deleted: number }> {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
      throw new Error('历史 ID 必须为字符串数组');
    await this.init();
    if (!ids.length) return { deleted: 0 };
    return this.enqueue(async () => {
      const rows = await this.sql<{ deleted: number }>(
        `DELETE FROM history WHERE id IN (${ids.map(sqlText).join(',')}); SELECT changes() AS deleted;`,
      );
      return rows[0];
    });
  }

  async clear(): Promise<{ ok: true }> {
    await this.init();
    await this.enqueue(async () => {
      await this.sql('DELETE FROM history;');
    });
    return { ok: true };
  }

  async update(id: string, note: string, tags: string[]): Promise<HistoryEntry> {
    if (typeof note !== 'string' || note.length > 20000) throw new Error('备注必须为字符串，最多 20000 字符');
    if (
      !Array.isArray(tags) ||
      tags.length > 100 ||
      tags.some((tag) => typeof tag !== 'string' || tag.length > 200)
    )
      throw new Error('标签必须为字符串数组');
    await this.init();
    return this.enqueue(async () => {
      const rows = await this.sql<{ payload: string }>(
        `UPDATE history SET note=${sqlText(note)},tags=${sqlText(JSON.stringify(tags))},payload=json_set(payload,'$.note',${sqlText(note)},'$.tags',json(${sqlText(JSON.stringify(tags))})) WHERE id=${sqlText(id)}; SELECT payload FROM history WHERE id=${sqlText(id)};`,
      );
      if (!rows.length) throw new Error('历史记录不存在或已被清理');
      return JSON.parse(rows[0].payload) as HistoryEntry;
    });
  }

  async deleteApi(method: string, host: string, path: string): Promise<{ deleted: number }> {
    if ([method, host, path].some((value) => typeof value !== 'string' || !value))
      throw new Error('API method、host、path 必须为非空字符串');
    await this.init();
    return this.enqueue(async () => {
      const rows = await this.sql<{ deleted: number }>(
        `DELETE FROM api_catalog WHERE method=${sqlText(method)} AND host=${sqlText(host)} AND path=${sqlText(path)}; SELECT changes() AS deleted;`,
      );
      return rows[0];
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}

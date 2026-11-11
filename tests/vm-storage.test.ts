import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VmHistoryStore } from '../src/vm/storage';
import type { HistoryEntry, RequestSnapshot, ResponseSnapshot } from '../src/model';

const now = Date.now();
function entry(id: string, changes: Partial<HistoryEntry> = {}): HistoryEntry {
  const request: RequestSnapshot = {
    method: 'GET',
    url: 'https://api.test/v1/orders',
    headers: [],
    body: '',
    bodyBytes: 0,
    bodyEncoding: 'text',
    truncated: false,
    editable: true,
  };
  const response: ResponseSnapshot = {
    status: 200,
    headers: [['content-type', 'application/json']],
    body: '{"ok":true}',
    bodyBytes: 11,
    bodyEncoding: 'text',
    truncated: false,
    editable: true,
  };
  return {
    id,
    startedAt: now,
    duration: 12,
    method: 'GET',
    host: 'api.test',
    path: '/v1/orders',
    url: request.url,
    targetUrl: request.url,
    originalRequest: request,
    automaticRequest: request,
    request,
    originalResponse: response,
    automaticResponse: response,
    response,
    mocked: false,
    note: '',
    tags: [],
    ...changes,
  };
}

describe('VM history using the real system SQLite CLI', () => {
  let folder: string;
  let store: VmHistoryStore;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'flutter-pilot-vm-storage-'));
    store = new VmHistoryStore(folder, { retentionDays: 7, maxRecords: 3 });
    await store.init();
  });
  afterEach(async () => {
    await store.close();
    await rm(folder, { recursive: true, force: true });
  });

  it('stores all snapshots but sends body-free summaries in newest-first pages', async () => {
    await Promise.all([
      store.put(entry('older', { startedAt: now - 1000 })),
      store.put(entry('newer', { startedAt: now + 1000 })),
    ]);
    const full = await store.get('newer');
    expect(full.originalResponse?.body).toBe('{"ok":true}');
    const result = await store.list({ limit: 1 });
    expect(result.total).toBe(2);
    expect(result.items[0].id).toBe('newer');
    expect(result.items[0]).toHaveProperty('status', 200);
    expect(result.items[0]).not.toHaveProperty('request');
    expect(result.items[0]).not.toHaveProperty('originalResponse');
    expect((await store.list({ limit: 1, offset: 1 }, false)).items[0].request).toBeDefined();
    expect(
      (
        await store.list({
          method: 'get',
          host: 'api.test',
          path: '/v1/orders',
          status: 200,
          mocked: false,
          from: now,
          to: now + 2000,
        })
      ).total,
    ).toBe(1);
  });

  it('preserves annotations across network updates without increasing API calls', async () => {
    const first = entry('one', { requestRuleId: 'rule-a' });
    await store.put(first);
    const edited = await store.update('one', '响应已检查', ['Android', '测试']);
    expect(edited.request).toEqual(first.request);
    await store.put({ ...first, duration: 34, response: { ...first.response!, status: 503 } });
    const updated = await store.get('one');
    expect(updated.note).toBe('响应已检查');
    expect(updated.tags).toEqual(['Android', '测试']);
    expect(updated.response?.status).toBe(503);
    expect((await store.apis())[0].count).toBe(1);
    expect((await store.list({ ruleId: 'rule-a', status: 503, search: 'Android' })).total).toBe(1);
  });

  it('prunes retained history while keeping API discovery through deletes, clear and restart', async () => {
    await store.put(entry('expired', { path: '/old', startedAt: now - 8 * 86400000 }));
    expect((await store.list({})).total).toBe(0);
    for (let i = 0; i < 5; i++) await store.put(entry(String(i), { startedAt: now + i }));
    expect((await store.list({})).items.map((item) => item.id)).toEqual(['4', '3', '2']);
    await expect(store.get('0')).rejects.toThrow('历史记录不存在');
    expect(await store.delete(['4', 'missing'])).toEqual({ deleted: 1 });
    await store.clear();
    await store.close();
    store = new VmHistoryStore(folder, { retentionDays: 7, maxRecords: 3 });
    await store.init();
    const apis = await store.apis();
    expect(apis.map((api) => api.path)).toEqual(['/v1/orders', '/old']);
    expect(apis[0].count).toBe(5);
    expect(apis[0].firstAt).toBe(now);
    expect(apis[0].lastAt).toBe(now + 4);
    expect((await store.list({})).total).toBe(0);
  });

  it('deletes only the catalog and rediscovers it only on future calls', async () => {
    await store.put(entry('one'));
    expect(await store.deleteApi('GET', 'api.test', '/v1/orders')).toEqual({ deleted: 1 });
    expect(await store.apis()).toEqual([]);
    expect((await store.list({})).total).toBe(1);
    await store.put(entry('one'));
    expect(await store.apis()).toEqual([]);
    await store.put(entry('two'));
    expect((await store.apis())[0].count).toBe(1);
  });

  it('treats quotes, SQL, CLI commands, shell substitutions and LIKE wildcards as data', async () => {
    const malicious =
      "a'\n.shell touch /tmp/flutter-pilot-should-never-exist\n$(touch unexpected); DROP TABLE history;--_100%\\中文";
    await store.put(
      entry('quoted', {
        path: malicious,
        note: malicious,
        tags: [malicious],
        url: `https://api.test/?q=${malicious}`,
      }),
    );
    await store.put(entry('normal', { path: '/normal' }));
    expect((await store.get('quoted')).path).toBe(malicious);
    expect((await store.list({ search: malicious })).items.map((item) => item.id)).toEqual(['quoted']);
    expect((await store.list({ search: '_100%' })).total).toBe(1);
    expect((await store.list({ search: 'not-present' })).total).toBe(0);
    await store.update('quoted', malicious + '\u0000end', ['tag']);
    expect((await store.get('quoted')).note).toBe(malicious + '\u0000end');
    expect((await store.list({})).total).toBe(2);
  });

  it('caps text and binary snapshots without modifying the caller or upstream facts', async () => {
    await store.close();
    store = new VmHistoryStore(folder, { retentionDays: 7, maxRecords: 3, maxBodyBytes: 4 });
    const original = entry('large');
    original.response = { ...original.response!, body: 'abcdefghi', bodyBytes: 9 };
    original.originalResponse = {
      ...original.response,
      bodyEncoding: 'base64',
      body: Buffer.from('123456789').toString('base64'),
    };
    await store.put(original);
    const recorded = await store.get('large');
    expect(recorded.response).toMatchObject({ body: 'abcd', bodyBytes: 9, truncated: true, editable: false });
    expect(Buffer.from(recorded.originalResponse!.body, 'base64').toString()).toBe('1234');
    expect(original.response.body).toBe('abcdefghi');
  });

  it('uses private permissions and an independent database, and closes cleanly', async () => {
    const proxyFile = join(folder, 'history.sqlite3');
    await writeFile(proxyFile, 'unchanged proxy database');
    await store.put(entry('one'));
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(proxyFile, 'utf8')).toBe('unchanged proxy database');
    await store.close();
    await expect(store.list({})).rejects.toThrow('已关闭');
  });

  it('validates user annotations and recovers its operation queue after rejected data', async () => {
    await expect(store.update('missing', 'a', [])).rejects.toThrow('历史记录不存在');
    await expect(store.update('missing', 'x'.repeat(20001), [])).rejects.toThrow('备注');
    await expect(store.update('missing', 'ok', ['x'.repeat(201)])).rejects.toThrow('标签');
    await expect(store.put(entry('invalid', { startedAt: NaN }))).rejects.toThrow();
    await store.put(entry('good'));
    expect((await store.list({})).total).toBe(1);
    expect(await store.delete([])).toEqual({ deleted: 0 });
  });
});

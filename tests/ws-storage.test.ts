import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WsHistoryStore } from '../src/ws/storage';
import type { WsConnection, WsMessage } from '../src/ws/model';
const now = Date.now();
const message = (id: string, changes: Partial<WsMessage> = {}): WsMessage => ({
  id,
  connectionId: 'socket-1',
  timestamp: now,
  direction: 'inbound',
  kind: 'text',
  original: '{"price":1}',
  effective: '{"price":789}',
  encoding: 'text',
  bytes: 11,
  truncated: false,
  outcome: 'replaced',
  ruleId: 'price',
  ...changes,
});
const connection = (id: string, changes: Partial<WsConnection> = {}): WsConnection => ({
  id,
  isolateId: 'main',
  endpoint: '127.0.0.1:8080',
  status: 'open',
  capture: 'attached',
  openedAt: now,
  sent: 2,
  received: 3,
  ...changes,
});

describe('WS history using private system SQLite', () => {
  let folder: string;
  let store: WsHistoryStore;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'ws-storage-'));
    store = new WsHistoryStore(folder, { retentionDays: 7, maxRecords: 3, maxBodyBytes: 20 });
    await store.init();
  });
  afterEach(async () => {
    await store.close();
    await rm(folder, { recursive: true, force: true });
  });
  it('stores immutable full messages and body-free ordered summaries', async () => {
    await store.putMessage(message('old', { timestamp: now - 100 }));
    await store.putMessage(message('new', { timestamp: now + 100, direction: 'outbound' }));
    await store.putMessage(message('new', { original: 'overwritten' }));
    expect((await store.get('new')).original).toBe('{"price":1}');
    const result = await store.list({ limit: 1 });
    expect(result.total).toBe(2);
    expect(result.items[0].id).toBe('new');
    expect(result.items[0]).not.toHaveProperty('original');
    expect(result.items[0]).not.toHaveProperty('effective');
    expect(result.items[0].preview).toBe('{"price":789}');
    expect((await store.list({ offset: 1, limit: 1 })).items[0].id).toBe('old');
    expect((await store.list({ direction: 'inbound' })).items.map((row) => row.id)).toEqual(['old']);
  });
  it('filters by connection and literal search without SQL or LIKE interpolation', async () => {
    const dangerous = "a'\n.shell touch unexpected\n$(touch surprise);%_\\";
    await store.putMessage(
      message(dangerous, {
        connectionId: dangerous,
        original: 'literal%_',
        effective: undefined,
        outcome: 'original',
      }),
    );
    await store.putMessage(
      message('other', { connectionId: 'other', original: 'literal12', effective: undefined }),
    );
    expect((await store.list({ connectionId: dangerous, search: '%_' })).items.map((row) => row.id)).toEqual([
      dangerous,
    ]);
    expect((await store.get(dangerous)).connectionId).toBe(dangerous);
  });
  it('enforces retention and count limits without changing timestamps', async () => {
    await store.putMessage(message('expired', { timestamp: now - 8 * 86400000 }));
    for (let index = 0; index < 4; index++)
      await store.putMessage(message(String(index), { timestamp: now + index }));
    expect((await store.list()).items.map((row) => row.id)).toEqual(['3', '2', '1']);
    await expect(store.get('expired')).rejects.toThrow('被清理');
    expect((await store.get('1')).timestamp).toBe(now + 1);
  });
  it('bounds UTF8 and binary records while preserving original byte counts and caller values', async () => {
    const input = message('utf8', { original: '中'.repeat(20), effective: '文'.repeat(20), bytes: 60 });
    await store.putMessage(input);
    const result = await store.get('utf8');
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(60);
    expect(result.original).toBe('中'.repeat(6));
    expect(input.original).toBe('中'.repeat(20));
    await store.putMessage(
      message('binary', {
        kind: 'binary',
        encoding: 'base64',
        original: Buffer.alloc(30, 255).toString('base64'),
        effective: undefined,
        bytes: 30,
        outcome: 'original',
      }),
    );
    expect(Buffer.from((await store.get('binary')).original, 'base64')).toHaveLength(20);
  });
  it('tracks separate connection identities and disconnects stale sessions without rewriting messages', async () => {
    await store.putConnection(connection('first'));
    await store.putConnection(connection('second', { openedAt: now + 1, url: 'wss://same.test/feed' }));
    await store.putMessage(message('first-msg', { connectionId: 'first' }));
    expect((await store.connections()).map((row) => row.id)).toEqual(['second', 'first']);
    await store.disconnectAll();
    expect((await store.connections()).every((row) => row.status === 'disconnected')).toBe(true);
    await store.deleteConnection('second');
    expect((await store.connections()).map((row) => row.id)).toEqual(['first']);
    expect((await store.get('first-msg')).connectionId).toBe('first');
  });
  it('clears selected connection messages without clearing other connections or counters', async () => {
    await store.putConnection(connection('socket-1'));
    await store.putMessage(message('a'));
    await store.putMessage(message('b', { connectionId: 'socket-2' }));
    await store.clear('socket-1');
    expect((await store.list()).items.map((row) => row.id)).toEqual(['b']);
    expect((await store.connections())[0].received).toBe(3);
  });
  it('uses private permissions and a separate database', async () => {
    const other = join(folder, 'vm-history.sqlite3');
    await writeFile(other, 'untouched');
    await store.putMessage(message('saved'));
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(await readFile(other, 'utf8')).toBe('untouched');
    await store.close();
    await expect(store.list()).rejects.toThrow('已关闭');
  });
  it('bounds queued writes and reports overflow without blocking accepted messages', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 205 }, (_, index) => store.putMessage(message('burst-' + index))),
    );
    expect(results.filter((row) => row.status === 'rejected').length).toBeGreaterThan(0);
    expect((await store.list()).total).toBe(3);
  });
});

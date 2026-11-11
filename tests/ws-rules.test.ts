import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WsRuleStore } from '../src/ws/rules';
import type { WsRule } from '../src/ws/model';
const rule: WsRule = {
  id: 'r',
  name: '替换',
  enabled: false,
  priority: 1,
  match: { url: 'wss://example.test/*' },
  action: { type: 'replace', text: 'hello' },
};

describe('project WS rules persistence', () => {
  let root: string;
  let store: WsRuleStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ws-rules-'));
    store = new WsRuleStore(join(root, '.flutter-pilot'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('creates a missing ordinary file once and atomically saves validated rules', async () => {
    expect(await store.load()).toEqual({ version: 1, rules: [] });
    await store.save([rule], []);
    expect((await store.load()).rules).toEqual([rule]);
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect((await readFile(store.file, 'utf8')).endsWith('\n')).toBe(true);
  });
  it('does not overwrite external edits and accepts saving after a fresh load', async () => {
    await store.load();
    await writeFile(store.file, JSON.stringify({ version: 1, rules: [rule] }));
    await expect(store.save([], [])).rejects.toThrow('已被修改');
    expect((await store.load()).rules).toEqual([rule]);
    const updated = { ...rule, name: '新名称' };
    await store.save([updated], [rule]);
    expect((await store.load()).rules[0].name).toBe('新名称');
  });
  it('does not persist a connection-scoped rule', async () => {
    await store.load();
    await expect(async () => store.save([{ ...rule, match: { connectionId: 'live' } }], [])).rejects.toThrow(
      '本次会话',
    );
    expect((await store.load()).rules).toEqual([]);
  });
  it('preserves malformed external content for repair', async () => {
    await store.load();
    await writeFile(store.file, '{"secret": unexpected');
    await expect(store.load()).rejects.toThrow('不是有效 JSON');
    expect(await readFile(store.file, 'utf8')).toBe('{"secret": unexpected');
  });
  it('rejects symlink files and directories without writing through them', async () => {
    const outside = join(root, 'outside.json');
    await writeFile(outside, 'untouched');
    await store.load();
    await rm(store.file);
    await symlink(outside, store.file);
    await expect(store.load()).rejects.toThrow('符号链接');
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    await rm(join(root, '.flutter-pilot'), { recursive: true });
    await symlink(root, join(root, '.flutter-pilot'));
    await expect(store.load()).rejects.toThrow('普通目录');
  });
  it('serializes competing saves and rejects a stale second writer', async () => {
    await store.load();
    const writes = await Promise.allSettled([
      store.save([rule], []),
      store.save([{ ...rule, name: 'other' }], []),
    ]);
    expect(writes.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((await store.load()).rules[0].name).toBe('替换');
  });
});

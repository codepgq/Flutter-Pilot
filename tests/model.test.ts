import { describe, it, expect } from 'vitest';
import { validateRuleDocument, ruleFromHistory, Rule, HistoryEntry, headerChanges } from '../src/model';
import { RuleStore } from '../src/store';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const rule = (): Rule => ({
  id: 'a',
  name: '订单',
  enabled: true,
  priority: 0,
  match: { method: 'GET', host: 'api.example.test', path: '/orders/*' },
  mock: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"orders":[]}' },
});
describe('规则文件与历史草稿', () => {
  it('验证完整文件且不保留调用方对象引用', () => {
    const r = rule();
    const d = validateRuleDocument({ version: 1, rules: [r] });
    r.name = 'changed';
    expect(d.rules[0].name).toBe('订单');
  });
  it.each([
    { version: 2, rules: [] },
    { version: 1, rules: [rule(), rule()] },
    { version: 1, rules: [{ ...rule(), redirect: { url: 'https://other.test' } }] },
    { version: 1, rules: [{ ...rule(), mock: { status: 200, headers: { x: 'a\r\nb' }, body: '' } }] },
    { version: 1, rules: [{ ...rule(), breakpoint: { timeout: 1 } }] },
    { version: 1, rules: [{ ...rule(), request: { url: 'file:///etc/passwd' } }] },
  ])('拒绝不可安全执行的导入 %#', (input) => expect(() => validateRuleDocument(input)).toThrow());
  it('从历史建立默认禁用的规则并移除凭证和传输头', () => {
    const entry = {
      method: 'GET',
      host: 'api.test',
      path: '/v1/a',
      response: {
        status: 201,
        headers: [
          ['set-cookie', 'secret'],
          ['content-length', '23'],
          ['content-type', 'application/json'],
        ],
        editable: true,
        body: '{"ok":true}',
      },
    } as HistoryEntry;
    const result = ruleFromHistory(entry, 'mock', 'new');
    expect(result.enabled).toBe(false);
    expect(result.mock?.headers).toEqual({ 'content-type': 'application/json' });
    expect(result.mock?.body).toContain('true');
  });
});
describe('规则持久化', () => {
  it('原子保存可重读，错误文件不能静默抹掉', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flutter-pilot-store-'));
    try {
      const store = new RuleStore(dir);
      expect((await store.load()).rules).toEqual([]);
      await store.save({ version: 1, rules: [rule()] });
      expect((await new RuleStore(dir).load()).rules).toHaveLength(1);
      await writeFile(store.file, 'broken');
      await expect(store.load()).rejects.toThrow('无法读取规则文件');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('断点头部差异', () => {
  it('保留未修改的重复 Set-Cookie', () =>
    expect(
      headerChanges(
        [
          ['Set-Cookie', 'a=1'],
          ['Set-Cookie', 'b=2'],
          ['Content-Type', 'text/plain'],
        ],
        { 'Set-Cookie': 'b=2', 'Content-Type': 'text/plain' },
      ),
    ).toEqual({}));
  it('键大小写变化不算修改，删除与改写只传对应字段', () =>
    expect(
      headerChanges(
        [
          ['X-Token', 'old'],
          ['X-Drop', 'yes'],
          ['Content-Type', 'text/plain'],
        ],
        { 'x-token': 'new', 'content-type': 'text/plain', 'X-Add': '1' },
      ),
    ).toEqual({ 'x-token': 'new', 'X-Drop': null, 'X-Add': '1' }));
});

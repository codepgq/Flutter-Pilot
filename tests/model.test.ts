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
  const redirectDocument = (url: unknown) => {
    const { mock: _mock, ...base } = rule();
    return { version: 1, rules: [{ ...base, redirect: { url } }] };
  };
  it.each([
    '/',
    '/api/private/new',
    '/api/a%2Fb?tag=one&tag=two&value=a%2Bb',
    '/api/private/new?',
    'https://api.example.test/api/private/new',
    'http://localhost:8080/new?x=1',
    'https://[::1]:8443/new',
    'https://api.example.test?email=a@b',
  ])('接受路径或完整重定向地址且原样保留：%s', (target) => {
    expect(validateRuleDocument(redirectDocument(target)).rules[0].redirect?.url).toBe(target);
  });
  it.each([
    '',
    null,
    1,
    'relative/path',
    '?x=1',
    '//other.test/path',
    '/\\other.test/path',
    '/path#fragment',
    '/path#',
    '/path with space',
    '/path\nnext',
    '/path\u0000',
    '/path\u007f',
    'https://other.test/path#fragment',
    'https://other.test/\\path',
    'https://user:secret@other.test/path',
    'https://@other.test/path',
    'https:///other.test/path',
    'https://',
    'https://other.test:99999/path',
    'file:///etc/passwd',
  ])('拒绝无效重定向地址：%j', (target) => {
    expect(() => validateRuleDocument(redirectDocument(target))).toThrow();
  });
  it('request.url 仍要求完整地址', () => {
    expect(() =>
      validateRuleDocument({ version: 1, rules: [{ ...rule(), request: { url: '/new' } }] }),
    ).toThrow();
  });
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

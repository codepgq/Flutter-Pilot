import { describe, expect, it } from 'vitest';
import type { Rule } from '../src/model';
import { apiRuleTags } from '../webview/api-rules';

const api = { method: 'GET', host: 'api.example.test', path: '/v1/orders', count: 1, lastAt: 1 };
const mock: Rule = {
  id: 'mock',
  name: '订单 Mock',
  enabled: true,
  priority: 10,
  match: { method: 'get', host: 'API.EXAMPLE.TEST', path: '/v1/*' },
  mock: { status: 200, headers: {}, body: '{}' },
};

describe('API catalog rule configuration', () => {
  it('matches enabled configuration independently of request history and excludes other APIs', () => {
    expect(apiRuleTags(api, [mock]).map((tag) => tag.label)).toEqual(['Mock']);
    for (const rule of [
      { ...mock, enabled: false },
      { ...mock, match: { method: 'POST' } },
      { ...mock, match: { host: 'other.test' } },
      { ...mock, match: { path: '/v1/order' } },
      { ...mock, match: { path: '/v1/orders/*' } },
    ])
      expect(apiRuleTags(api, [rule])).toEqual([]);
    expect(apiRuleTags(api, [{ ...mock, match: { method: '*', host: '*' } }])).toHaveLength(1);
    expect(apiRuleTags(api, [])).toEqual([]);
  });

  it('uses runtime fnmatch syntax for paths, including character classes and literal regex characters', () => {
    for (const path of ['/v1/order?', '/v1/[op]rders', '/v1/[!x]rders', '/v1/**'])
      expect(apiRuleTags(api, [{ ...mock, match: { path } }])).toHaveLength(1);
    for (const path of ['/v1/[!o]rders', '/v1/(orders)', '/v1/['])
      expect(apiRuleTags(api, [{ ...mock, match: { path } }])).toEqual([]);
  });

  it('shows all configured operations and merges names by type in stable priority order', () => {
    const rules: Rule[] = [
      mock,
      { ...mock, id: 'second', name: '备用 Mock', priority: 0 },
      {
        ...mock,
        id: 'redirect',
        name: '转发及修改',
        priority: 20,
        mock: undefined,
        redirect: { url: '/alternate' },
        request: { headers: { 'x-test': '1' } },
        response: { status: 201 },
        breakpoint: { request: true },
      },
    ];
    const tags = apiRuleTags(api, rules);
    expect(tags.map((tag) => tag.label)).toEqual(['转发', '修改请求', '修改响应', '断点', 'Mock']);
    expect(tags[4].title).toContain('实际命中按每阶段优先级决定');
    expect(tags[4].title.indexOf('订单 Mock')).toBeLessThan(tags[4].title.indexOf('备用 Mock'));
    expect(rules.map((rule) => rule.id)).toEqual(['mock', 'second', 'redirect']);
  });

  it('marks query and header predicates as conditional without exposing header values', () => {
    const tags = apiRuleTags(api, [
      mock,
      {
        ...mock,
        id: 'conditional',
        name: '特定用户',
        match: { ...mock.match, query: { page: '1' }, headers: { Authorization: 'secret-token' } },
      },
    ]);
    expect(tags.map((tag) => tag.label)).toEqual(['Mock', 'Mock · 条件']);
    expect(tags[1]).toMatchObject({ conditional: true });
    expect(tags[1].title).toContain('查询参数：page；请求头：Authorization');
    expect(tags[1].title).not.toContain('secret-token');
    expect(apiRuleTags(api, [{ ...mock, match: { query: {}, headers: {} } }])[0].conditional).toBe(false);
  });
});

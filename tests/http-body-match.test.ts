import { describe, expect, it } from 'vitest';
import { bodySnapshot, matchesHttp, patchRequest, selectHttp } from '../src/browser/http';
import { validateRuleDocument, type Rule } from '../src/model';
import { apiRuleTags } from '../webview/api-rules';

const login: Rule = {
  id: 'admin-login',
  name: '测试账号登录',
  enabled: true,
  priority: 10,
  match: {
    method: 'POST',
    path: '/login',
    bodyJson: { email: 'aaaa@example.test', profile: { codes: [1, true], alias: null } },
    bodyRegex: { password: 'Demo[0-9]{3}|Other' },
  },
  mock: { status: 200, headers: {}, body: '{"role":"ADMIN"}' },
};
const fallback: Rule = {
  ...login,
  id: 'invalid-login',
  priority: 1,
  match: { method: 'POST', path: '/login' },
  mock: { status: 401, headers: {}, body: '{}' },
};
const payload = {
  email: 'aaaa@example.test',
  password: 'Demo123',
  profile: { alias: null, codes: [1, true] },
  rememberMe: true,
};
const request = (body: string, mime = 'Application/Vnd.Test+Json; charset=utf-8') => ({
  ...bodySnapshot([['Content-Type', mime]], Buffer.from(body)),
  method: 'POST',
  url: 'https://api.example.test/login',
});
const matches = (body: string) => matchesHttp(login, request(body), new Map());

describe('HTTP JSON request body predicates', () => {
  it('selects the highest priority matching account and falls back for a wrong password', () => {
    const rules = validateRuleDocument({ version: 1, rules: [fallback, login] }).rules;
    const select = (password: string) =>
      selectHttp(rules, request(JSON.stringify({ ...payload, password })), 'request', new Map());
    expect(select('Demo123')?.id).toBe('admin-login');
    expect(select('Other')?.id).toBe('admin-login');
    for (const password of ['demo123', 'Demo1234', 'prefixOther', 'Demo123\n'])
      expect(select(password)?.id).toBe('invalid-login');
  });

  it('requires typed top-level fields and exact nested objects and arrays', () => {
    expect(matches(JSON.stringify(payload, null, 2))).toBe(true);
    for (const body of [
      { ...payload, email: 'other@example.test' },
      { ...payload, password: 123 },
      { ...payload, profile: { codes: [1, true] } },
      { ...payload, profile: { alias: null, codes: [true, 1] } },
      { ...payload, profile: { alias: null, codes: [1, 1] } },
      { ...payload, profile: { ...payload.profile, extra: true } },
      [payload],
    ])
      expect(matches(JSON.stringify(body))).toBe(false);
  });

  it('only matches original, complete, readable JSON and preserves existing rules', () => {
    const source = request(JSON.stringify(payload));
    const effective = patchRequest(source, { ...fallback, request: { body: '{}' } });
    const responseRule = { ...login, response: { status: 202 } };
    expect(selectHttp([responseRule], source, 'response', new Map())?.id).toBe(login.id);
    expect(selectHttp([responseRule], effective, 'response', new Map())).toBeUndefined();
    for (const unavailable of [
      { ...source, editable: false },
      { ...source, truncated: true },
      { ...source, bodyEncoding: 'base64' as const },
      request('{' + source.body),
      request(source.body, 'text/plain'),
    ]) {
      expect(matchesHttp(login, unavailable, new Map())).toBe(false);
      expect(matchesHttp(fallback, unavailable, new Map())).toBe(true);
    }
  });

  it('rejects invalid or empty predicates before activation', () => {
    for (const match of [
      { bodyJson: {} },
      { bodyJson: [] },
      { bodyJson: { value: Infinity } },
      { bodyRegex: {} },
      { bodyRegex: { value: 123 } },
      { bodyRegex: { value: '[' } },
      { bodyRegex: { value: ')(?:' } },
    ])
      expect(() => validateRuleDocument({ version: 1, rules: [{ ...login, match }] })).toThrow(/body/);
  });

  it('labels predicates in the catalog without exposing their credentials', () => {
    const [tag] = apiRuleTags(
      { method: 'POST', host: 'api.example.test', path: '/login', count: 1, lastAt: 1 },
      [login],
    );
    expect(tag.conditional).toBe(true);
    expect(tag.title).toContain('请求体完全匹配：email、profile');
    expect(tag.title).toContain('请求体正则匹配：password');
    expect(tag.title).not.toMatch(/aaaa@example\.test|Demo/);
  });
});

import { describe, expect, it } from 'vitest';
import { validateWsRuleDocument, wsUrlMatches } from '../src/ws/rules';
import type { WsRule } from '../src/ws/model';

export function wsRule(changes: Partial<WsRule> = {}): WsRule {
  return {
    id: 'one',
    name: '行情',
    enabled: true,
    priority: 0,
    match: { url: 'wss://example.test/feed*', direction: 'inbound', contains: 'price' },
    action: { type: 'replace', text: '{"price":789}' },
    ...changes,
  };
}
const document = (rules: unknown[]) => ({ version: 1, rules });

describe('WS rule validation and URL matching', () => {
  it('accepts persistent URL rules and makes a detached validated snapshot', () => {
    const rule = wsRule();
    const result = validateWsRuleDocument(document([rule]));
    rule.action.text = 'changed';
    expect(result.rules[0].action.text).toBe('{"price":789}');
    expect(validateWsRuleDocument(document([wsRule({ action: { type: 'drop' } })]))).toBeDefined();
  });
  it('allows session connection rules only when explicitly supported', () => {
    const value = document([wsRule({ match: { connectionId: 'vm:session:socket' } })]);
    expect(validateWsRuleDocument(value).rules[0].match.connectionId).toBe('vm:session:socket');
    expect(() => validateWsRuleDocument(value, false)).toThrow('本次会话');
    expect(() =>
      validateWsRuleDocument(document([wsRule({ match: { url: '*', connectionId: 'one' } })])),
    ).toThrow('只能');
    expect(() => validateWsRuleDocument(document([wsRule({ match: {} })]))).toThrow('只能');
  });
  it.each([
    ['unknown root', { ...document([]), extra: true }],
    ['future version', { version: 2, rules: [] }],
    ['duplicate ids', document([wsRule(), wsRule()])],
    ['unknown field', document([{ ...wsRule(), script: 'danger' }])],
    ['unknown match', document([wsRule({ match: { url: '*', host: 'x' } as WsRule['match'] })])],
    ['unknown action', document([wsRule({ action: { type: 'drop', extra: 1 } as WsRule['action'] })])],
    ['wrong direction', document([wsRule({ match: { url: '*', direction: 'both' as never } })])],
    ['http url', document([wsRule({ match: { url: 'https://example.test/' } })])],
    ['credential url', document([wsRule({ match: { url: 'wss://user:secret@example.test/' } })])],
    ['drop text', document([wsRule({ action: { type: 'drop', text: 'ignored' } })])],
    ['missing replacement', document([wsRule({ action: { type: 'replace' } })])],
    ['wrong priority', document([wsRule({ priority: 0.5 })])],
  ])('rejects %s', (_name, value) => {
    expect(() => validateWsRuleDocument(value)).toThrow();
  });
  it('rejects array and object values that stringify to valid enum members', () => {
    expect(() =>
      validateWsRuleDocument(document([wsRule({ match: { url: '*', direction: ['inbound'] as never } })])),
    ).toThrow('方向');
    expect(() => validateWsRuleDocument(document([wsRule({ action: { type: ['drop'] as never } })]))).toThrow(
      '动作',
    );
  });
  it('bounds replacement bytes and total document resources', () => {
    expect(() =>
      validateWsRuleDocument(document([wsRule({ action: { type: 'replace', text: '中'.repeat(90000) } })])),
    ).toThrow('256 KiB');
    expect(() =>
      validateWsRuleDocument(
        document(
          Array.from({ length: 9 }, (_, index) =>
            wsRule({ id: String(index), action: { type: 'replace', text: 'x'.repeat(256 * 1024) } }),
          ),
        ),
      ),
    ).toThrow('2 MiB');
    expect(() =>
      validateWsRuleDocument(
        document(Array.from({ length: 1001 }, (_, index) => wsRule({ id: String(index) }))),
      ),
    ).toThrow('1000');
  });
  it('anchors URL wildcards and never matches unknown URLs, even with all wildcard', () => {
    expect(wsUrlMatches('wss://example.test/feed*', 'wss://example.test/feed?token=1')).toBe(true);
    expect(wsUrlMatches('wss://example.test/feed', 'wss://exampleXtest/feed')).toBe(false);
    expect(wsUrlMatches('wss://example.test/f?ed', 'wss://example.test/feed')).toBe(true);
    expect(wsUrlMatches('*', undefined)).toBe(false);
    expect(wsUrlMatches('wss://example.test/feed', 'wss://example.test/feed/extra')).toBe(false);
  });
});

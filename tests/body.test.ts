import { describe, expect, it } from 'vitest';
import { inspectJson } from '../webview/body';

describe('history JSON inspection', () => {
  it('formats nested values without changing financial numbers, duplicate keys or string escapes', () => {
    const body =
      '{"id":9007199254740993,"price":1.2300000000000001,"id":2,"text":"a, b: \\"x\\"","items":[true,null,{}]}';
    const result = inspectJson(body);
    expect(result.formatted).toContain('9007199254740993');
    expect(result.formatted).toContain('1.2300000000000001');
    expect(result.formatted?.match(/"id":/g)).toHaveLength(2);
    expect(JSON.parse(result.formatted!)).toEqual(JSON.parse(body));
  });
  it.each(['null', 'true', '123', '"hello"', '[]', '{}'])(
    'accepts JSON scalar or empty container %s',
    (body) => {
      expect(inspectJson(body).formatted).toBe(body);
    },
  );
  it('falls back for HTML, malformed or truncated JSON and distinguishes empty bodies', () => {
    for (const body of ['<html>bad gateway</html>', '{"data":', '{"a":1,}']) {
      expect(inspectJson(body)).toEqual({ hint: '无法解析为 JSON，已显示原文' });
    }
    expect(inspectJson('  ')).toEqual({});
  });
  it('bounds large and deeply nested formatting', () => {
    expect(inspectJson(' '.repeat(1024 * 1024) + '1')).toHaveProperty('hint');
    const result = inspectJson('['.repeat(300) + '0' + ']'.repeat(300));
    expect(result.formatted?.length).toBeLessThan(32000);
    expect(JSON.parse(result.formatted!)).toEqual(JSON.parse('['.repeat(300) + '0' + ']'.repeat(300)));
  });
});

import { describe, expect, it } from 'vitest';
import { DynamicHttp } from '../src/browser/dynamic-http';
import { bodySnapshot } from '../src/browser/http';
import { validateRuleDocument, type Rule } from '../src/model';

const request = {
  ...bodySnapshot([['content-type', 'application/json']], Buffer.from('{"increment":2}')),
  method: 'POST',
  url: 'http://127.0.0.1/increment',
};
const rule: Rule = {
  id: 'increment',
  name: 'Increment counter',
  enabled: true,
  priority: 10,
  match: { host: '127.0.0.1', path: '/increment' },
  dynamic: {
    store: 'counter',
    initial: '{"count":0}',
    library: '$next := state.count + request.body.increment',
    expression: '{"status":200,"body":{"count":$next},"state":{"count":$next}}',
  },
};
const read = (engine: DynamicHttp) => engine.run(rule.id, request, async (result) => JSON.parse(result.body));

describe('dynamic HTTP Mock', () => {
  it('serializes requests across tabs, survives reconfiguration and isolates Contexts', async () => {
    const engine = new DynamicHttp();
    engine.configure([rule]);
    expect(await Promise.all([read(engine), read(engine), read(engine)])).toEqual([
      { count: 2 },
      { count: 4 },
      { count: 6 },
    ]);
    engine.configure([structuredClone(rule)]);
    expect(await read(engine)).toEqual({ count: 8 });
    const other = new DynamicHttp();
    other.configure([rule]);
    expect(await read(other)).toEqual({ count: 2 });
    engine.configure([]);
    engine.configure([rule]);
    expect(await read(engine)).toEqual({ count: 2 });
  });

  it('does not commit when interception delivery fails or a program returns an invalid response', async () => {
    const engine = new DynamicHttp();
    engine.configure([rule]);
    await expect(
      engine.run(rule.id, request, async () => {
        throw new Error('Invalid InterceptionId');
      }),
    ).rejects.toThrow('Invalid InterceptionId');
    const bad = structuredClone(rule);
    bad.dynamic!.expression = '{"status":700,"body":{},"state":{"count":100}}';
    engine.configure([bad]);
    await expect(read(engine)).rejects.toThrow('rule increment failed');
    engine.configure([rule]);
    expect(await read(engine)).toEqual({ count: 2 });
  });

  it('rejects invalid expressions atomically and scopes the action to explicit loopback hosts', async () => {
    const engine = new DynamicHttp();
    engine.configure([rule]);
    const bad = structuredClone(rule);
    bad.dynamic!.expression = '(';
    expect(() => engine.configure([bad])).toThrow('Invalid dynamic HTTP Mock expression');
    expect(await read(engine)).toEqual({ count: 2 });
    expect(() =>
      validateRuleDocument({ version: 1, rules: [{ ...rule, match: { host: 'example.test' } }] }),
    ).toThrow('loopback');
  });
});

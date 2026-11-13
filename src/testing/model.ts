import { z } from 'zod';
import { uiSelectorSchema } from '../automation/tools';
import { validateTestMock, type TestMock } from './mock-model';

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const variable = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const text = z.string().max(16384);
const pointer = z
  .string()
  .max(1024)
  .refine((v) => v === '' || /^\/(?:[^~]|~[01])*$/.test(v));
const duration = z.number().int().min(100).max(300000).optional();
const json: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(16384),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(json).max(1000),
    z.record(z.string().max(1024), json),
  ]),
);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const fields = z.record(pointer, json).refine((v) => Object.keys(v).length <= 100);
const stableSelector = uiSelectorSchema.superRefine((value, ctx) => {
  if (value.ref !== undefined || value.ancestor?.ref !== undefined)
    ctx.addIssue({ code: 'custom', message: '测试必须使用稳定选择器。' });
});
const http = z
  .object({
    id: name,
    match: z
      .object({
        method: z
          .string()
          .regex(/^[A-Za-z]+$/)
          .optional(),
        host: text.min(1).optional(),
        path: text.min(1).optional(),
      })
      .strict()
      .refine((v) => Object.values(v).some((x) => x !== undefined)),
    requestJson: fields.optional(),
    responseJson: fields.optional(),
    status: z.number().int().min(100).max(599).optional(),
    mocked: z.boolean().optional(),
    extract: z.record(variable, pointer).optional(),
    timeoutMs: duration,
  })
  .strict();
const ws = z
  .object({
    id: name,
    url: text.optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    json: fields.optional(),
    contains: text.optional(),
    outcome: z.enum(['original', 'replaced', 'dropped', 'synthetic']).optional(),
    timeoutMs: duration,
  })
  .strict()
  .refine(
    (v) => v.url !== undefined || v.json !== undefined || v.contains !== undefined,
    'WS 断言须指定 URL、JSON 或文字条件。',
  );
const ui = z
  .object({
    id: name,
    selector: stableSelector,
    state: z.enum(['present', 'absent', 'visible', 'enabled', 'actionable', 'text_equals', 'text_contains']),
    text: text.optional(),
    timeoutMs: duration,
    stableForMs: z.number().int().min(100).max(30000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.state.startsWith('text_') && v.text === undefined)
      ctx.addIssue({ code: 'custom', message: '文字断言需要 text。' });
    if (v.stableForMs !== undefined && v.stableForMs > (v.timeoutMs ?? 30000))
      ctx.addIssue({ code: 'custom', message: '稳定观察时间不能超过断言超时。' });
  });
const test = z
  .object({
    id: name,
    name: z.string().trim().min(1).max(256),
    workflowId: name,
    inputs: z.record(variable, text).optional(),
    setup: z
      .array(z.object({ workflowId: name, inputs: z.record(variable, text).optional() }).strict())
      .max(20)
      .optional(),
    sceneId: name.optional(),
    mock: z.unknown().optional(),
    timeoutMs: duration,
    expect: z
      .object({
        http: z.array(http).max(100).optional(),
        ws: z.array(ws).max(100).optional(),
        ui: z.array(ui).max(100).optional(),
      })
      .strict(),
    events: z
      .array(z.object({ id: name, after: name, url: text, text: z.string().max(256 * 1024) }).strict())
      .max(100)
      .optional(),
  })
  .strict();
export type HttpExpectation = z.infer<typeof http>;
export type WsExpectation = z.infer<typeof ws>;
export type UiExpectation = z.infer<typeof ui>;
export type TestCase = Omit<z.infer<typeof test>, 'mock'> & { mock?: TestMock };
export interface TestDocument {
  version: 1;
  tests: TestCase[];
}
export class TestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
const invalid = (message: string): never => {
  throw new TestError('INVALID_TEST', message);
};
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Deliberately small template language: no evaluation, expressions, or recursive expansion. */
export function validateTemplates(
  value: unknown,
  inputs: Set<string>,
  vars: Set<string>,
  allowVars = true,
): void {
  if (typeof value === 'string') {
    if (value.replace(/\$\{[^}]*\}/g, '').includes('${')) invalid('测试模板缺少结束符。');
    for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
      const expression = match[1];
      if (expression === 'run.id') continue;
      const part = /^(inputs|vars)\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(expression);
      if (!part || (part[1] === 'inputs' ? !inputs.has(part[2]) : !allowVars || !vars.has(part[2])))
        invalid('测试模板引用了未知变量或不支持的表达式。');
    }
  } else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (key.includes('${')) invalid('测试模板只能用于字段值，不能用于字段名称或 JSON Pointer。');
      validateTemplates(item, inputs, vars, allowVars);
    }
}
export function bindTemplates<T>(
  value: T,
  inputs: Record<string, string>,
  runId: string,
  vars: Record<string, JsonValue> = {},
): T {
  if (typeof value === 'string')
    return value.replace(/\$\{([^}]*)\}/g, (_whole, expression: string) => {
      if (expression === 'run.id') return runId;
      const part = /^(inputs|vars)\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(expression);
      const source = part?.[1] === 'inputs' ? inputs : vars;
      if (!part || !own(source, part[2]))
        throw new TestError('TEST_VARIABLE_UNAVAILABLE', '测试依赖的变量尚不可用。');
      const item = source[part[2]];
      return typeof item === 'string' ? item : JSON.stringify(item);
    }) as T;
  if (Array.isArray(value)) return value.map((v) => bindTemplates(v, inputs, runId, vars)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key.includes('${')) invalid('测试模板只能用于字段值。');
        return [key, bindTemplates(item, inputs, runId, vars)];
      }),
    ) as T;
  return value;
}
export function parseJsonTemplate(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return invalid('Mock 正文及事件模板必须为有效 JSON，模板应放在 JSON 字符串值内。');
  }
}
/** Parse before substitution so quotes and backslashes in input stay JSON data. */
export function bindJsonTemplate(
  text: string,
  inputs: Record<string, string>,
  runId: string,
  vars: Record<string, JsonValue> = {},
): string {
  return JSON.stringify(bindTemplates(parseJsonTemplate(text), inputs, runId, vars));
}
export function bindTestMock(
  mock: TestMock | undefined,
  inputs: Record<string, string>,
  runId: string,
): TestMock | undefined {
  if (!mock) return undefined;
  const copy = structuredClone(mock);
  const bodies = copy.states.map((state) =>
    state.httpRules.map((rule) => {
      const body = rule.mock!.body;
      rule.mock!.body = '';
      return body;
    }),
  );
  const bound = bindTemplates(copy, inputs, runId);
  bound.states.forEach((state, stateIndex) =>
    state.httpRules.forEach((rule, ruleIndex) => {
      const original = bodies[stateIndex][ruleIndex];
      rule.mock!.body = original.includes('${') ? bindJsonTemplate(original, inputs, runId) : original;
    }),
  );
  return validateTestMock(bound);
}
export function validateTestDocument(value: unknown): TestDocument {
  const parsed = z
    .object({ version: z.literal(1), tests: z.array(test).max(200) })
    .strict()
    .safeParse(value);
  if (!parsed.success)
    return invalid(`测试配置格式无效（${parsed.error.issues[0]?.path.join('.') || 'document'}）。`);
  const ids = new Set<string>();
  const tests = parsed.data.tests.map((item): TestCase => {
    if (ids.has(item.id)) invalid(`测试 ID 重复：${item.id}`);
    ids.add(item.id);
    const result: TestCase = {
      ...item,
      mock: item.mock === undefined ? undefined : validateTestMock(item.mock),
    };
    const assertions = [...(item.expect.http ?? []), ...(item.expect.ws ?? []), ...(item.expect.ui ?? [])];
    if (!assertions.length) invalid('Test Case 至少需要一项业务断言。');
    const assertionIds = new Set<string>();
    for (const assertion of assertions) {
      if (assertionIds.has(assertion.id)) invalid('测试断言 ID 重复。');
      assertionIds.add(assertion.id);
    }
    const variables = new Set<string>();
    for (const expectation of item.expect.http ?? [])
      for (const key of Object.keys(expectation.extract ?? {})) {
        if (variables.has(key)) invalid('提取变量名称重复。');
        variables.add(key);
      }
    const eventIds = new Set<string>();
    for (const event of item.events ?? []) {
      if (eventIds.has(event.id)) invalid('事件 ID 重复。');
      eventIds.add(event.id);
      if (!(item.expect.http ?? []).some((entry) => entry.id === event.after))
        invalid('事件须关联一个 HTTP 断言。');
      parseJsonTemplate(event.text);
    }
    return result;
  });
  return { version: 1, tests };
}

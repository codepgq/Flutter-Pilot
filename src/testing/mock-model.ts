import { createHash } from 'node:crypto';
import { validateRuleDocument, type Rule } from '../model';

/** Explicit fixture transitions; an HTTP status alone never implies business success. */
export interface TestMock {
  initialState: string;
  states: Array<{
    id: string;
    httpRules: Array<Rule & { nextState?: string }>;
  }>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function fields(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) check(allowed.includes(key), `${label} 包含未知字段 ${key}`);
}
function identifier(value: unknown, label: string): asserts value is string {
  check(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= 128 &&
      !/[\x00-\x1f\x7f]/.test(value),
    `${label} 必须为非空字符串，最多 128 字符且不能包含控制字符`,
  );
}

export function validateTestMock(value: unknown): TestMock {
  check(object(value), 'test.mock 必须为对象');
  fields(value, ['initialState', 'states'], 'test.mock');
  identifier(value.initialState, 'initialState');
  check(
    Array.isArray(value.states) && value.states.length > 0 && value.states.length <= 64,
    'mock.states 必须包含 1–64 个状态',
  );
  const states = new Set<string>();
  const transitions: string[] = [];
  let count = 0;
  for (const state of value.states) {
    check(object(state), 'Mock 状态必须为对象');
    fields(state, ['id', 'httpRules'], 'Mock 状态');
    identifier(state.id, '状态 ID');
    check(!states.has(state.id), 'Mock 状态 ID 重复');
    states.add(state.id);
    check(Array.isArray(state.httpRules), 'httpRules 必须为数组');
    count += state.httpRules.length;
    check(count <= 1000, 'Test Mock 规则总数最多 1000 条');
    const rules = state.httpRules.map((rule: unknown) => {
      check(object(rule), 'Mock 规则必须为对象');
      check(
        rule.scenario === undefined && !Object.hasOwn(rule, 'scenario'),
        'Test Mock 不能自行提供 scenario',
      );
      const { nextState, ...base } = rule;
      check(
        base.mock !== undefined &&
          base.request === undefined &&
          base.redirect === undefined &&
          base.response === undefined &&
          base.breakpoint === undefined,
        'Test Mock 仅支持直接 HTTP Mock',
      );
      if (Object.hasOwn(rule, 'nextState')) {
        identifier(nextState, 'nextState');
        transitions.push(nextState);
      }
      return base;
    });
    validateRuleDocument({ version: 1, rules });
  }
  check(states.has(value.initialState), 'initialState 必须引用已有状态');
  for (const target of transitions) check(states.has(target), `nextState 引用了不存在的状态 ${target}`);
  return structuredClone(value) as unknown as TestMock;
}

export function compileTestMock(mock: TestMock, runId: string): Rule[] {
  const checked = validateTestMock(mock);
  identifier(runId, 'runId');
  const prefix = `run-${createHash('sha256').update(runId).digest('hex').slice(0, 24)}`;
  const rules = checked.states.flatMap((state, stateIndex) =>
    state.httpRules.map(({ nextState, ...rule }, ruleIndex) => ({
      ...rule,
      id: `${prefix}-${stateIndex}-${ruleIndex}`,
      scenario: {
        id: runId,
        initial: checked.initialState,
        when: state.id,
        ...(nextState === undefined ? {} : { next: nextState }),
      },
    })),
  );
  return validateRuleDocument({ version: 1, rules }).rules;
}

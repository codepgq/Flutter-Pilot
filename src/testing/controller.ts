import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Backend } from '../automation/model';
import { automationMcpTools } from '../automation/tools';
import type { HistoryEntry, BodySnapshot } from '../model';
import type { WsMessage } from '../ws/model';
import { wsUrlMatches } from '../ws/model';
import {
  WorkflowController,
  type WorkflowHost,
  type WorkflowStepResult,
  type WorkflowFailure,
} from '../workflows/controller';
import { compileSceneAction, validateSceneActions, type ActionReference } from '../workflows/model';
import type { SceneDocument } from '../scene-model';
import { TestStore } from './store';
import {
  TestError,
  bindTemplates,
  bindJsonTemplate,
  bindTestMock,
  parseJsonTemplate,
  validateTemplates,
  type JsonValue,
  type TestCase,
  type HttpExpectation,
  type WsExpectation,
  type UiExpectation,
} from './model';
import type { TestMock } from './mock-model';

export interface NetworkBaseline {
  at: number;
  httpIds: string[];
  wsIds: string[];
}
export interface TestHost extends WorkflowHost {
  loadScenes(): Promise<SceneDocument>;
  prepare(
    runId: string,
    sceneId: string | undefined,
    mock: TestMock | undefined,
    requirements: { http: boolean; ws: boolean },
  ): Promise<void>;
  /** Resolve connections created by setup before the main observation window. */
  ready?(runId: string, signal: AbortSignal): Promise<void>;
  cleanup(runId: string): Promise<void>;
  baseline(): Promise<NetworkBaseline>;
  http(baseline: NetworkBaseline): Promise<HistoryEntry[]>;
  ws(baseline: NetworkBaseline): Promise<Array<WsMessage & { url?: string }>>;
  injectWs(url: string, text: string, signal: AbortSignal): Promise<{ connectionId: string }>;
}
export interface TestAssertionResult {
  id: string;
  kind: 'http' | 'ws' | 'ui';
  status: 'pending' | 'passed' | 'failed';
  message?: string;
  evidence?: { httpId?: string; wsId?: string; connectionId?: string };
}
export interface TestRun {
  kind: 'test';
  testId: string;
  action: ActionReference;
  sceneId?: string;
  mockSceneId: string | null;
  runId: string;
  name: string;
  status: 'running' | 'passed' | 'failed' | 'error' | 'cancelled' | 'uncertain';
  steps: WorkflowStepResult[];
  assertions: TestAssertionResult[];
  events: Array<{
    id: string;
    status: 'pending' | 'dispatching' | 'sent' | 'uncertain' | 'skipped';
    connectionId?: string;
  }>;
  inputs: Record<string, string>;
  vars: Record<string, JsonValue>;
  definitionHash: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  cancelRequested: boolean;
  cleanup: { status: 'pending' | 'completed' | 'failed' | 'skipped'; message?: string };
  failure?: WorkflowFailure;
  message: string;
  evidence?: { ui: Array<Record<string, unknown>> };
}
interface Prepared {
  test: TestCase;
  scenes: SceneDocument;
  inputs: Record<string, string>;
  secrets: string[];
  mock?: TestMock;
  backend: Backend;
  hash: string;
}
interface Active {
  run: TestRun;
  controller: AbortController;
  completion: Promise<void>;
  inner?: WorkflowController;
  mutationDispatched: boolean;
  actionUncertain: boolean;
  flowFinished: boolean;
  assertionsFinished: boolean;
  vars: Record<string, JsonValue>;
  clean: (value: string) => string;
}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const sensitive = (key: string) => /password|secret|token|authorization|cookie/i.test(key);
const errorMessage = (value: unknown) =>
  typeof (value as { message?: unknown })?.message === 'string'
    ? (value as { message: string }).message
    : '测试执行异常，请检查连接与当前状态。';
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
function check(active: Active) {
  if (active.controller.signal.aborted) throw active.controller.signal.reason;
}
function sanitize(value: JsonValue, clean: (value: string) => string): JsonValue {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && sensitive(value[0]))
      return [clean(value[0]), '[REDACTED]'];
    return value.map((item) => sanitize(item, clean));
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitive(key) ? '[REDACTED]' : sanitize(item, clean),
      ]),
    );
  return value;
}
function collectSecrets(value: JsonValue, secrets: string[], isSecret = false): void {
  if (typeof value === 'string') {
    if (isSecret && value) secrets.push(value);
  } else if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && sensitive(value[0]))
      collectSecrets(value[1], secrets, true);
    else for (const item of value) collectSecrets(item, secrets, isSecret);
  } else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value))
      collectSecrets(item, secrets, isSecret || sensitive(key));
  else if (isSecret && typeof value === 'number') secrets.push(String(value));
}
function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  let current = value;
  for (const key of path
    .slice(1)
    .split('/')
    .map((v) => v.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!current || typeof current !== 'object' || !own(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function body(snapshot: BodySnapshot | undefined): JsonValue | undefined {
  if (!snapshot || snapshot.truncated || snapshot.bodyEncoding !== 'text') return undefined;
  try {
    return JSON.parse(snapshot.body) as JsonValue;
  } catch {
    return undefined;
  }
}
function assertJson(actual: unknown, expected: Record<string, JsonValue> | undefined, label: string) {
  for (const [path, value] of Object.entries(expected ?? {}))
    if (!isDeepStrictEqual(pointer(actual, path), value))
      throw new TestError('ASSERTION_FAILED', `${label} JSON 字段 ${path || '/'} 不符合预期。`);
}
function matchesHttp(entry: HistoryEntry, expectation: HttpExpectation) {
  let url: URL;
  try {
    url = new URL(entry.originalRequest.url);
  } catch {
    return false;
  }
  const match = expectation.match;
  return (
    (!match.method || entry.originalRequest.method.toUpperCase() === match.method.toUpperCase()) &&
    (!match.host || wsUrlMatches(match.host, url.host)) &&
    (!match.path || wsUrlMatches(match.path, url.pathname))
  );
}
function matchesWs(entry: WsMessage & { url?: string }, expectation: WsExpectation) {
  if (
    (expectation.url && !wsUrlMatches(expectation.url, entry.url)) ||
    (expectation.direction && entry.direction !== expectation.direction) ||
    (expectation.outcome && entry.outcome !== expectation.outcome) ||
    entry.truncated ||
    entry.encoding !== 'text'
  )
    return false;
  const text = entry.effective ?? entry.original;
  if (expectation.contains !== undefined && !text.includes(expectation.contains)) return false;
  if (expectation.json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    try {
      assertJson(parsed, expectation.json, 'WS');
    } catch {
      return false;
    }
  }
  return true;
}

/** Test runs own their complete lifetime, including observation and temporary Mock cleanup. */
export class TestController {
  private active?: Active;
  private starting = false;
  private disposed = false;
  private readonly runs = new Map<string, TestRun>();
  constructor(
    readonly store: TestStore,
    private readonly host: TestHost,
  ) {}
  private changed() {
    try {
      this.host.changed();
    } catch {
      /* Observers cannot interrupt test cleanup. */
    }
  }
  get snapshot() {
    return {
      ...(this.active ? { activeRunId: this.active.run.runId } : {}),
      recentRuns: [...this.runs.values()]
        .reverse()
        .map(({ runId, testId, name, status, startedAt, finishedAt, durationMs }) => ({
          runId,
          testId,
          name,
          status,
          startedAt,
          finishedAt,
          durationMs,
        })),
    };
  }
  async list() {
    const doc = await this.store.read();
    return {
      ok: true,
      files: { tests: this.store.file },
      tests: doc.tests.map((test) => ({
        id: test.id,
        name: test.name,
        action: structuredClone(test.action),
        sceneId: test.sceneId,
        assertionCount:
          (test.expect.http?.length ?? 0) + (test.expect.ws?.length ?? 0) + (test.expect.ui?.length ?? 0),
      })),
      ...this.snapshot,
    };
  }
  get(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new TestError('TEST_RUN_NOT_FOUND', '测试运行不存在或已过期。');
    return { ok: true, run: structuredClone(run) };
  }
  cancel(runId: string) {
    const run = this.get(runId).run;
    if (this.active?.run.runId === runId) {
      this.active.run.cancelRequested = true;
      this.abort(this.active, new TestError('CANCELLED', '测试已取消，已执行的业务操作不会自动回滚。'));
      this.changed();
      return { ok: true, runId, status: 'running', cancelRequested: true };
    }
    return { ok: true, runId, status: run.status, cancelRequested: run.cancelRequested };
  }
  private abort(active: Active, error: unknown) {
    if (!active.controller.signal.aborted) active.controller.abort(error);
    const id = active.inner?.snapshot.activeRunId;
    if (id) active.inner!.cancel(id);
  }
  private async preflight(
    testId: string,
    overrides: Record<string, string>,
    runId: string,
    backend: Backend,
  ): Promise<Prepared> {
    const [document, scenes] = await Promise.all([this.store.read(), this.host.loadScenes()]);
    const test = document.tests.find((item) => item.id === testId);
    if (!test) throw new TestError('TEST_NOT_FOUND', '指定测试不存在，请先调用 list_tests。');
    validateSceneActions(scenes);
    const root = scenes.scenes
      .find((scene) => scene.id === test.action.sceneId)
      ?.actions?.find((item) => item.id === test.action.actionId);
    if (!root) throw new TestError('INVALID_TEST', '测试引用的 Scene 操作不存在。');
    const inputNames = new Set(Object.keys(root.inputs ?? {}));
    for (const value of Object.values(overrides))
      if (typeof value !== 'string' || value.length > 16384)
        throw new TestError('INVALID_TEST', '测试参数必须为字符串。');
    validateTemplates(test.inputs, inputNames, new Set(), false);
    const resolved: Record<string, string> = Object.create(null),
      resolving = new Set<string>();
    const resolveInput = (key: string): string => {
      if (own(resolved, key)) return resolved[key];
      if (own(overrides, key)) return (resolved[key] = overrides[key]);
      if (resolving.has(key) || resolving.size >= 64)
        throw new TestError('INVALID_TEST', '测试输入模板存在循环或依赖层数过多。');
      if (!own(test.inputs ?? {}, key)) {
        const value = root.inputs?.[key]?.default;
        if (value === undefined) throw new TestError('INVALID_TEST', '测试输入模板引用了未提供值的参数。');
        return (resolved[key] = value);
      }
      resolving.add(key);
      const value = test.inputs![key].replace(/\$\{([^}]*)\}/g, (_whole, expression: string) =>
        expression === 'run.id' ? runId : resolveInput(expression.slice('inputs.'.length)),
      );
      resolving.delete(key);
      return (resolved[key] = value);
    };
    const bound = Object.fromEntries(Object.keys(test.inputs ?? {}).map((key) => [key, resolveInput(key)]));
    const main = compileSceneAction(
      scenes,
      test.action.sceneId,
      test.action.actionId,
      { ...bound, ...overrides },
      backend,
    );
    const inputs = main.inputs,
      secrets = [...main.secrets];
    for (const [key, value] of Object.entries(inputs)) if (sensitive(key) && value) secrets.push(value);
    const availableInputs = new Set(Object.keys(inputs));
    const vars = new Set<string>();
    validateTemplates(test.setup, availableInputs, vars, false);
    validateTemplates(test.sceneId, availableInputs, vars, false);
    validateTemplates(test.mock, availableInputs, vars, false);
    for (const setup of test.setup ?? []) {
      const child = compileSceneAction(
        scenes,
        setup.action.sceneId,
        setup.action.actionId,
        bindTemplates(setup.inputs ?? {}, inputs, runId),
        backend,
      );
      secrets.push(...child.secrets);
    }
    for (const expectation of test.expect.http ?? []) {
      validateTemplates(expectation, availableInputs, vars);
      for (const key of Object.keys(expectation.extract ?? {})) vars.add(key);
      for (const event of test.events ?? [])
        if (event.after === expectation.id) {
          validateTemplates(event.url, availableInputs, vars);
          validateTemplates(parseJsonTemplate(event.text), availableInputs, vars);
          const url = bindTemplates(
            event.url,
            inputs,
            runId,
            Object.fromEntries([...vars].map((key) => [key, 'preflight'])),
          );
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            throw new TestError('INVALID_TEST', '测试事件需要有效 WS URL。');
          }
          if (
            !['ws:', 'wss:'].includes(parsed.protocol) ||
            /\s/.test(url) ||
            parsed.username ||
            parsed.password ||
            parsed.hash
          )
            throw new TestError('INVALID_TEST', '测试事件需要有效 WS URL。');
        }
    }
    validateTemplates(test.expect.ws, availableInputs, vars);
    validateTemplates(test.expect.ui, availableInputs, vars);
    const dummyVars = Object.fromEntries([...vars].map((key) => [key, 'preflight']));
    for (const assertion of test.expect.ui ?? []) {
      const value = bindTemplates(assertion, inputs, runId, dummyVars);
      if (
        !automationMcpTools.wait_for_widget.schema.safeParse({
          sessionId: 'test',
          backend,
          selector: value.selector,
          state: value.state,
          text: value.text,
          timeoutMs: 100,
        }).success
      )
        throw new TestError('INVALID_TEST', 'UI 断言选择器与后端不兼容。');
    }
    let mock: TestMock | undefined;
    try {
      mock = bindTestMock(test.mock, inputs, runId);
    } catch (error) {
      const message = secrets
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .reduce((text, secret) => text.split(secret).join('[REDACTED]'), errorMessage(error));
      throw new TestError('INVALID_TEST', message);
    }
    return {
      test: structuredClone(test),
      scenes: structuredClone(scenes),
      inputs,
      secrets,
      mock,
      backend,
      hash: createHash('sha256').update(JSON.stringify({ test, scenes })).digest('hex'),
    };
  }
  async start(testId: string, overrides: Record<string, string> = {}, backend: Backend = 'auto') {
    if (this.disposed) throw new TestError('SESSION_INVALIDATED', '测试会话已关闭。');
    if (this.starting || this.active) throw new TestError('TEST_BUSY', '已有测试正在执行。');
    this.starting = true;
    try {
      const runId = randomUUID(),
        prepared = await this.preflight(testId, overrides, runId, backend);
      if (this.disposed) throw new TestError('SESSION_INVALIDATED', '测试会话已关闭。');
      const { test, inputs, secrets } = prepared;
      const clean = (value: string) =>
        [...new Set(secrets)]
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)
          .reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
      const run: TestRun = {
        kind: 'test',
        testId,
        action: structuredClone(test.action),
        mockSceneId: null,
        ...(test.sceneId ? { sceneId: test.sceneId } : {}),
        runId,
        name: clean(test.name),
        status: 'running',
        steps: [],
        assertions: [
          ...(test.expect.http ?? []).map((v) => ({
            id: v.id,
            kind: 'http' as const,
            status: 'pending' as const,
          })),
          ...(test.expect.ws ?? []).map((v) => ({
            id: v.id,
            kind: 'ws' as const,
            status: 'pending' as const,
          })),
          ...(test.expect.ui ?? []).map((v) => ({
            id: v.id,
            kind: 'ui' as const,
            status: 'pending' as const,
          })),
        ],
        events: (test.events ?? []).map((v) => ({ id: v.id, status: 'pending' })),
        inputs: Object.fromEntries(
          Object.entries(inputs).map(([key, value]) => [key, sensitive(key) ? '[REDACTED]' : clean(value)]),
        ),
        vars: {},
        definitionHash: prepared.hash,
        startedAt: Date.now(),
        cancelRequested: false,
        cleanup: { status: 'pending' },
        message: '正在执行操作与业务断言。',
      };
      const active: Active = {
        run,
        controller: new AbortController(),
        completion: Promise.resolve(),
        mutationDispatched: false,
        actionUncertain: false,
        flowFinished: false,
        assertionsFinished: false,
        vars: Object.create(null),
        clean,
      };
      this.runs.set(runId, run);
      while (this.runs.size > 50) this.runs.delete(this.runs.keys().next().value!);
      this.active = active;
      let acquisition: Promise<void>;
      try {
        acquisition = this.host.acquire(runId);
      } catch (error) {
        acquisition = Promise.reject(error);
      }
      active.completion = this.perform(active, prepared, acquisition);
      this.changed();
      return { ok: true, runId, status: run.status };
    } finally {
      this.starting = false;
    }
  }
  private async workflow(
    active: Active,
    prepared: Prepared,
    action: ActionReference,
    inputs: Record<string, string>,
    prefix: string,
  ) {
    check(active);
    const offset = active.run.steps.length;
    const inner = new WorkflowController(
      { read: async () => prepared.scenes },
      {
        acquire: async () => {},
        release: async () => {},
        mockSceneId: () => active.run.mockSceneId,
        execute: async (_owner, tool, args, signal) => {
          check(active);
          if (tool !== 'wait_for_widget') active.mutationDispatched = true;
          return this.host.execute(
            active.run.runId,
            tool,
            args,
            AbortSignal.any([signal, active.controller.signal]),
          );
        },
        changed: () => {
          const id = inner.snapshot.activeRunId ?? inner.snapshot.recentRuns[0]?.runId;
          if (id) {
            const run = inner.get(id).run;
            active.run.steps.splice(
              offset,
              active.run.steps.length - offset,
              ...run.steps.map((step) => ({
                ...step,
                path: `${prefix}/${active.clean(step.path)}`,
                ...(step.failure
                  ? { failure: { ...step.failure, message: active.clean(step.failure.message) } }
                  : {}),
              })),
            );
          }
          this.changed();
        },
      },
    );
    active.inner = inner;
    try {
      const result = await inner.start(action.sceneId, action.actionId, inputs, prepared.backend);
      if (active.controller.signal.aborted) inner.cancel(result.runId);
      await inner.waitForIdle();
      const run = inner.get(result.runId).run;
      active.actionUncertain ||= run.status === 'uncertain';
      check(active);
      if (run.status !== 'completed')
        throw new TestError(
          run.failure?.code ?? 'WORKFLOW_FAILED',
          run.failure?.message ?? '测试操作未完成。',
          run.status === 'uncertain',
        );
    } finally {
      await inner.dispose();
      if (active.inner === inner) active.inner = undefined;
    }
  }
  private assertion(active: Active, id: string) {
    return active.run.assertions.find((item) => item.id === id)!;
  }
  private async observe(active: Active, prepared: Prepared, baseline: NetworkBaseline) {
    const { test, inputs } = prepared;
    const httpIds = new Set(baseline.httpIds),
      wsIds = new Set(baseline.wsIds);
    const started = Date.now();
    const httpSeen = new Map<string, string>();
    for (;;) {
      check(active);
      const [http, ws] = await Promise.all([
        test.expect.http?.length ? this.host.http(baseline) : [],
        test.expect.ws?.length ? this.host.ws(baseline) : [],
      ]);
      check(active);
      const freshHttp = http.filter((entry) => !httpIds.has(entry.id) && entry.startedAt >= baseline.at);
      const freshWs = ws.filter((entry) => !wsIds.has(entry.id) && entry.timestamp >= baseline.at);
      let previousDone = true;
      for (const raw of test.expect.http ?? []) {
        if (!previousDone) break;
        const expectation = bindTemplates(raw, inputs, active.run.runId, active.vars);
        const record = this.assertion(active, raw.id),
          matches = freshHttp.filter((entry) => matchesHttp(entry, expectation));
        try {
          if (matches.length > 1)
            throw new TestError('AMBIGUOUS_HTTP', '本轮有多个请求符合 HTTP 观察条件，请缩小匹配范围。');
          if (record.status === 'passed') {
            if (matches.length && matches[0].id !== httpSeen.get(raw.id))
              throw new TestError('AMBIGUOUS_HTTP', 'HTTP 观察记录发生歧义。');
            continue;
          }
          const entry = matches[0];
          if (!entry) {
            if (Date.now() - started >= (raw.timeoutMs ?? 30000))
              throw new TestError('ASSERTION_TIMEOUT', '未在超时前观察到本轮 HTTP 请求。');
            previousDone = false;
            break;
          }
          record.evidence = { httpId: active.clean(entry.id) };
          assertJson(body(entry.originalRequest), expectation.requestJson, '原始请求');
          if (!entry.response) {
            if (entry.error) throw new TestError('ASSERTION_FAILED', '本轮 HTTP 请求未取得响应。');
            if (Date.now() - started >= (raw.timeoutMs ?? 30000))
              throw new TestError('ASSERTION_TIMEOUT', '本轮 HTTP 响应未确认。');
            previousDone = false;
            break;
          }
          if (expectation.status !== undefined && entry.response.status !== expectation.status)
            throw new TestError('ASSERTION_FAILED', 'HTTP 响应状态码不符合预期。');
          if (expectation.mocked !== undefined && entry.mocked !== expectation.mocked)
            throw new TestError('ASSERTION_FAILED', 'HTTP Mock 来源不符合预期。');
          assertJson(body(entry.response), expectation.responseJson, '响应');
          const unified = {
            request: { ...entry.originalRequest, body: body(entry.originalRequest) },
            response: { status: entry.response.status, body: body(entry.response) },
            mocked: entry.mocked,
            requestRuleId: entry.requestRuleId,
          };
          for (const [key, path] of Object.entries(expectation.extract ?? {})) {
            const value = pointer(unified, path);
            if (value === undefined)
              throw new TestError('EXTRACTION_FAILED', 'HTTP 响应缺少需要提取的变量。');
            if (JSON.stringify(value).length > 16384)
              throw new TestError('EXTRACTION_FAILED', 'HTTP 提取变量超过大小限制。');
            active.vars[key] = value as JsonValue;
            collectSecrets(value as JsonValue, prepared.secrets, sensitive(key));
          }
          active.run.vars = Object.fromEntries(
            Object.entries(active.vars).map(([key, value]) => [
              key,
              sensitive(key) ? '[REDACTED]' : sanitize(value, active.clean),
            ]),
          );
          record.status = 'passed';
          record.evidence = { httpId: active.clean(entry.id) };
          httpSeen.set(raw.id, entry.id);
          for (const event of test.events ?? [])
            if (event.after === raw.id) {
              check(active);
              const eventRecord = active.run.events.find((item) => item.id === event.id)!;
              if (eventRecord.status !== 'pending') continue;
              const url = bindTemplates(event.url, inputs, active.run.runId, active.vars);
              const text = bindJsonTemplate(event.text, inputs, active.run.runId, active.vars);
              eventRecord.status = 'dispatching';
              active.mutationDispatched = true;
              this.changed();
              try {
                const result = await this.host.injectWs(url, text, active.controller.signal);
                check(active);
                eventRecord.status = 'sent';
                eventRecord.connectionId = active.clean(result.connectionId);
              } catch (error) {
                eventRecord.status = 'uncertain';
                throw new TestError('WS_INJECTION_UNCONFIRMED', 'WS 事件投递结果未确认，不自动重试。', true);
              }
            }
          this.changed();
        } catch (error) {
          record.status = 'failed';
          record.message = active.clean(errorMessage(error)).slice(0, 1024);
          throw error;
        }
      }
      if (previousDone) {
        for (const raw of test.expect.ws ?? []) {
          const record = this.assertion(active, raw.id);
          const expectation = bindTemplates(raw, inputs, active.run.runId, active.vars);
          const matches = freshWs.filter((entry) => matchesWs(entry, expectation));
          if (matches.length > 1) {
            record.status = 'failed';
            throw new TestError('AMBIGUOUS_WS', '本轮有多条 WS 消息符合条件，请关联唯一订单标识。');
          }
          if (record.status === 'passed') continue;
          if (matches.length === 1) {
            record.status = 'passed';
            record.evidence = {
              wsId: active.clean(matches[0].id),
              connectionId: active.clean(matches[0].connectionId),
            };
            this.changed();
          } else if (Date.now() - started >= (raw.timeoutMs ?? 30000)) {
            record.status = 'failed';
            throw new TestError('ASSERTION_TIMEOUT', '未观察到本轮关联的 WS 消息。');
          }
        }
      }
      if (
        active.flowFinished &&
        active.assertionsFinished &&
        active.run.assertions.filter((item) => item.kind !== 'ui').every((item) => item.status === 'passed')
      )
        return;
      await sleep(40, active.controller.signal);
    }
  }
  private async ui(active: Active, prepared: Prepared, raw: UiExpectation) {
    const record = this.assertion(active, raw.id);
    const expectation = bindTemplates(raw, prepared.inputs, active.run.runId, active.vars);
    const deadline = Date.now() + (expectation.timeoutMs ?? 30000);
    const stable = expectation.stableForMs ?? (expectation.state === 'absent' ? 500 : 0);
    let stableSince: number | undefined;
    try {
      do {
        check(active);
        const result = await this.host.execute(
          active.run.runId,
          'wait_for_widget',
          {
            selector: expectation.selector,
            state: expectation.state,
            text: expectation.text,
            backend: prepared.backend,
            timeoutMs: Math.max(100, Math.min(stable ? 250 : 30000, deadline - Date.now())),
          },
          active.controller.signal,
        );
        check(active);
        if (result.ok) {
          stableSince ??= Date.now();
          if (Date.now() - stableSince >= stable) {
            record.status = 'passed';
            this.changed();
            return;
          }
        } else {
          stableSince = undefined;
          if (result.code !== 'TIMEOUT' && result.code !== 'WAIT_TIMEOUT')
            throw new TestError('ASSERTION_FAILED', 'UI 断言定位失败或目标不唯一。');
        }
        await sleep(Math.min(50, Math.max(1, deadline - Date.now())), active.controller.signal);
      } while (Date.now() < deadline);
      throw new TestError('ASSERTION_TIMEOUT', 'UI 状态未在观察窗口内满足预期。');
    } catch (error) {
      record.status = 'failed';
      record.message = active.clean(errorMessage(error)).slice(0, 1024);
      throw error;
    }
  }
  private async captureFailure(active: Active, prepared: Prepared) {
    if (!active.run.steps.length) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const result = await this.host.execute(
        active.run.runId,
        'get_ui_snapshot',
        {
          source: prepared.backend === 'device' ? 'device' : 'flutter',
          maxNodes: 20,
        },
        controller.signal,
      );
      if (result.ok && Array.isArray(result.widgets)) {
        const fields = ['ref', 'type', 'text', 'semantics', 'key', 'enabled', 'visible', 'actionable'];
        active.run.evidence = {
          ui: result.widgets.slice(0, 20).flatMap((widget: unknown) => {
            if (!widget || typeof widget !== 'object') return [];
            return [
              Object.fromEntries(
                fields.flatMap<[string, string | number | boolean]>((key) => {
                  const value = (widget as Record<string, unknown>)[key];
                  if (typeof value === 'string') return [[key, active.clean(value).slice(0, 512)]];
                  return typeof value === 'boolean' || typeof value === 'number' ? [[key, value]] : [];
                }),
              ),
            ];
          }),
        };
      }
    } catch {
      /* Evidence collection cannot replace the primary failure. */
    } finally {
      clearTimeout(timeout);
    }
  }
  private async perform(active: Active, prepared: Prepared, acquisition: Promise<void>) {
    let acquired = false,
      preparedAttempted = false;
    let observation: Promise<unknown> | undefined;
    const timeout = setTimeout(
      () => this.abort(active, new TestError('TEST_TIMEOUT', '测试超过总超时时间，操作结果需要检查。')),
      prepared.test.timeoutMs ?? 120000,
    );
    const { run } = active;
    try {
      await acquisition;
      acquired = true;
      check(active);
      preparedAttempted = true;
      await this.host.prepare(
        run.runId,
        bindTemplates(prepared.test.sceneId, prepared.inputs, run.runId),
        prepared.mock,
        {
          http: !!prepared.test.expect.http?.length,
          ws: !!(prepared.test.expect.ws?.length || prepared.test.events?.length),
        },
      );
      run.mockSceneId =
        this.host.mockSceneId?.() ?? bindTemplates(prepared.test.sceneId, prepared.inputs, run.runId) ?? null;
      check(active);
      for (const [index, setup] of (prepared.test.setup ?? []).entries())
        await this.workflow(
          active,
          prepared,
          setup.action,
          bindTemplates(setup.inputs ?? {}, prepared.inputs, run.runId),
          `setup${index + 1}`,
        );
      check(active);
      await this.host.ready?.(run.runId, active.controller.signal);
      check(active);
      const baseline = structuredClone(await this.host.baseline());
      check(active);
      observation = this.observe(active, prepared, baseline).then(
        () => undefined,
        (error: unknown) => {
          this.abort(active, error);
          return error;
        },
      );
      await this.workflow(active, prepared, prepared.test.action, prepared.inputs, 'main');
      active.flowFinished = true;
      while (!run.assertions.filter((item) => item.kind !== 'ui').every((item) => item.status === 'passed')) {
        check(active);
        await sleep(40, active.controller.signal);
      }
      for (const expectation of prepared.test.expect.ui ?? []) await this.ui(active, prepared, expectation);
      active.assertionsFinished = true;
      const error = await observation;
      if (error) throw error;
      check(active);
      run.status = 'passed';
    } catch (error) {
      this.abort(active, error);
      await active.inner?.waitForIdle();
      await observation;
      const primary = active.controller.signal.reason ?? error;
      const value = primary as { code?: unknown; message?: unknown; uncertain?: unknown };
      const code = typeof value?.code === 'string' ? value.code : 'TEST_FAILED';
      const uncertain =
        active.actionUncertain ||
        value?.uncertain === true ||
        (['CANCELLED', 'TEST_TIMEOUT', 'SESSION_INVALIDATED'].includes(code) && active.mutationDispatched);
      run.status = uncertain
        ? 'uncertain'
        : code === 'CANCELLED'
          ? 'cancelled'
          : code.startsWith('ASSERTION') || code.startsWith('AMBIGUOUS') || code === 'EXTRACTION_FAILED'
            ? 'failed'
            : 'error';
      run.failure = {
        code: code.slice(0, 128),
        message: active
          .clean(typeof value?.message === 'string' ? value.message : '测试执行失败。')
          .slice(0, 2048),
        uncertain,
      };
      await this.captureFailure(active, prepared);
    } finally {
      clearTimeout(timeout);
      let terminal = run.status;
      run.status = 'running';
      for (const event of run.events) if (event.status === 'pending') event.status = 'skipped';
      try {
        if (preparedAttempted) {
          await this.host.cleanup(run.runId);
          run.cleanup.status = 'completed';
        } else run.cleanup.status = 'skipped';
      } catch {
        run.cleanup = { status: 'failed', message: '测试临时 Mock 状态清理失败。' };
        terminal = terminal === 'uncertain' ? 'uncertain' : 'error';
        run.failure ??= {
          code: 'TEST_CLEANUP_FAILED',
          message: '测试临时 Mock 状态清理失败，请检查连接。',
          uncertain: false,
        };
        if (run.failure.code !== 'TEST_CLEANUP_FAILED') run.failure.message += '；临时 Mock 清理失败。';
      }
      try {
        if (acquired) await this.host.release(run.runId);
      } catch {
        terminal = 'uncertain';
        run.failure = { code: 'TEST_RELEASE_FAILED', message: '测试运行资源释放未确认。', uncertain: true };
      }
      run.status = terminal;
      run.finishedAt = Date.now();
      run.durationMs = run.finishedAt - run.startedAt;
      run.message =
        terminal === 'passed'
          ? '测试通过，操作与全部业务断言已完成。'
          : terminal === 'uncertain'
            ? '操作结果未确认，不自动重试。'
            : terminal === 'cancelled'
              ? '测试已取消，已执行的业务操作不会自动回滚。'
              : '测试未通过，请检查失败步骤与断言。';
      if (this.active === active) this.active = undefined;
      this.changed();
    }
  }
  async waitForIdle() {
    await this.active?.completion;
  }
  async dispose() {
    this.disposed = true;
    const active = this.active;
    if (active) {
      active.run.cancelRequested = true;
      this.abort(active, new TestError('CANCELLED', '测试会话已关闭。'));
      await active.completion;
    }
  }
}

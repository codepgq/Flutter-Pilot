import { createHash, randomUUID } from 'node:crypto';
import type { Backend } from '../automation/model';
import type { UiResult } from '../vm/ui';
import { compileWorkflow, WorkflowError, type CompiledWorkflow, type CompiledWorkflowStep } from './model';
import { WorkflowStore } from './store';

export interface WorkflowHost {
  acquire(owner: string): Promise<void>;
  execute(owner: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<UiResult>;
  release(owner: string): Promise<void>;
  changed(): void;
}
export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export interface WorkflowFailure {
  code: string;
  message: string;
  uncertain: boolean;
}
export interface WorkflowStepResult {
  id: string;
  path: string;
  workflowId: string;
  target: string;
  tool: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain' | 'skipped';
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  timings?: Record<string, number>;
  backend?: string;
  inputMethod?: string;
  failure?: WorkflowFailure;
}
export interface WorkflowRun {
  runId: string;
  workflowId: string;
  name: string;
  definitionHash: string;
  inputs: Record<string, string>;
  backend: Backend;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  currentStep?: string;
  cancelRequested: boolean;
  steps: WorkflowStepResult[];
  metrics: {
    totalMs: number;
    actionMs: number;
    waitMs: number;
    resolveMs: number;
    inputMs: number;
    stepsCompleted: number;
  };
  failure?: WorkflowFailure;
  message: string;
}
interface ActiveRun {
  run: WorkflowRun;
  controller: AbortController;
  completion: Promise<void>;
}
const mutates = (tool: string) => tool !== 'wait_for_widget';
const bounded = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Explicit, single-run orchestration. Scene restoration never invokes this controller. */
export class WorkflowController {
  private active?: ActiveRun;
  private starting = false;
  private disposed = false;
  private readonly runs = new Map<string, WorkflowRun>();
  constructor(
    readonly store: WorkflowStore,
    private readonly host: WorkflowHost,
  ) {}
  private changed() {
    try {
      this.host.changed();
    } catch {
      /* UI observers cannot interrupt an owned run. */
    }
  }

  get snapshot() {
    return {
      ...(this.active ? { activeRunId: this.active.run.runId } : {}),
      recentRuns: [...this.runs.values()].reverse().map((run) => ({
        runId: run.runId,
        workflowId: run.workflowId,
        name: run.name,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        currentStep: run.currentStep,
        durationMs: run.durationMs,
      })),
    };
  }
  async list() {
    const doc = await this.store.read();
    return {
      ok: true,
      files: { workflows: this.store.file },
      workflows: doc.workflows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        stepCount: flow.steps.length,
        inputs: Object.fromEntries(
          Object.entries(flow.inputs ?? {}).map(([key, spec]) => [
            key,
            {
              ...spec,
              ...(spec.secret && spec.default !== undefined ? { default: '[REDACTED]' } : {}),
            },
          ]),
        ),
      })),
      ...this.snapshot,
    };
  }
  async start(workflowId: string, inputs: Record<string, string> = {}, backend: Backend = 'auto') {
    if (this.disposed) throw new WorkflowError('SESSION_INVALIDATED', '工作流会话已关闭。');
    if (this.starting || this.active)
      throw new WorkflowError('WORKFLOW_BUSY', '已有工作流正在执行，请先查询或取消该运行。');
    this.starting = true;
    try {
      const doc = await this.store.read();
      const compiled = compileWorkflow(doc, workflowId, inputs, backend);
      if (this.disposed) throw new WorkflowError('SESSION_INVALIDATED', '工作流会话已关闭。');
      const owner = randomUUID();
      const secrets = compiled.secrets.sort((a, b) => b.length - a.length);
      const clean = (value: string) =>
        secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
      const run: WorkflowRun = {
        runId: owner,
        workflowId: compiled.workflow.id,
        name: compiled.workflow.name,
        definitionHash: createHash('sha256').update(JSON.stringify(doc)).digest('hex'),
        inputs: Object.fromEntries(
          Object.entries(compiled.inputs).map(([key, value]) => [
            key,
            compiled.workflow.inputs?.[key]?.secret ? '[REDACTED]' : clean(value),
          ]),
        ),
        backend,
        status: 'running',
        startedAt: Date.now(),
        cancelRequested: false,
        steps: compiled.steps.map((item) => ({
          id: item.id,
          path: item.path,
          workflowId: item.workflowId,
          target: item.target,
          tool: item.tool,
          status: 'pending',
        })),
        metrics: { totalMs: 0, actionMs: 0, waitMs: 0, resolveMs: 0, inputMs: 0, stepsCompleted: 0 },
        message: '工作流正在执行；操作完成不等同业务测试通过。',
      };
      this.runs.set(run.runId, run);
      while (this.runs.size > 50) this.runs.delete(this.runs.keys().next().value!);
      const active: ActiveRun = { run, controller: new AbortController(), completion: Promise.resolve() };
      this.active = active;
      let acquisition: Promise<void>;
      try {
        acquisition = this.host.acquire(owner);
      } catch (error) {
        acquisition = Promise.reject(error);
      }
      // The run owns its lifetime. Closing the short-lived start MCP socket must not cancel it.
      active.completion = this.perform(active, compiled, clean, acquisition);
      this.changed();
      return { ok: true, runId: run.runId, status: run.status, stepCount: run.steps.length };
    } finally {
      this.starting = false;
    }
  }
  get(runId: string) {
    const run = this.runs.get(runId);
    if (!run)
      throw new WorkflowError(
        'WORKFLOW_RUN_NOT_FOUND',
        '运行记录不存在或已过期，请调用 list_workflows 查询最近运行。',
      );
    return { ok: true, run: structuredClone(run) };
  }
  cancel(runId: string) {
    const result = this.get(runId);
    if (this.active?.run.runId === runId) {
      this.active.run.cancelRequested = true;
      this.active.controller.abort();
      this.changed();
      return { ok: true, runId, cancelRequested: true, status: this.active.run.status };
    }
    return { ok: true, runId, cancelRequested: result.run.cancelRequested, status: result.run.status };
  }
  private failure(
    result: UiResult,
    item: CompiledWorkflowStep,
    clean: (value: string) => string,
  ): WorkflowFailure {
    const code = typeof result.code === 'string' ? result.code.slice(0, 128) : 'WORKFLOW_STEP_FAILED';
    const uncertain =
      result.uncertain === true || (mutates(item.tool) && ['TIMEOUT', 'SESSION_INVALIDATED'].includes(code));
    return {
      code,
      message: clean(
        typeof result.message === 'string' ? result.message : '步骤执行失败，请检查目标和自动化连接。',
      ).slice(0, 2048),
      uncertain,
    };
  }
  private async perform(
    active: ActiveRun,
    compiled: CompiledWorkflow,
    clean: (value: string) => string,
    acquisition: Promise<void>,
  ) {
    const { run, controller } = active;
    let acquired = false;
    try {
      await acquisition;
      acquired = true;
      for (let index = 0; index < compiled.steps.length; index++) {
        if (controller.signal.aborted) {
          run.status = 'cancelled';
          run.failure = {
            code: 'CANCELLED',
            message: '工作流已取消，已执行的操作不会自动回滚。',
            uncertain: false,
          };
          break;
        }
        const item = compiled.steps[index],
          record = run.steps[index];
        record.status = 'running';
        record.startedAt = Date.now();
        run.currentStep = item.path;
        this.changed();
        let result: UiResult;
        try {
          result = await this.host.execute(
            run.runId,
            item.tool,
            structuredClone(item.args),
            controller.signal,
          );
        } catch (error) {
          const value = error as { code?: unknown; uncertain?: unknown };
          result = {
            ok: false,
            code: typeof value?.code === 'string' ? value.code : 'AUTOMATION_FAILED',
            message: '步骤执行异常，请检查连接与自动化状态。',
            uncertain: value?.uncertain === true || mutates(item.tool),
          };
        }
        record.finishedAt = Date.now();
        record.durationMs = record.finishedAt - record.startedAt;
        if (typeof result.backend === 'string') record.backend = result.backend.slice(0, 64);
        if (typeof result.inputMethod === 'string') record.inputMethod = result.inputMethod.slice(0, 64);
        const timings = result.timings;
        if (timings && typeof timings === 'object' && !Array.isArray(timings)) {
          record.timings = Object.fromEntries(
            ['resolveMs', 'inputMs', 'waitMs', 'totalMs'].flatMap((key) => {
              const value = bounded((timings as Record<string, unknown>)[key]);
              return value === undefined ? [] : [[key, value]];
            }),
          );
          run.metrics.resolveMs += record.timings.resolveMs ?? 0;
          run.metrics.inputMs += record.timings.inputMs ?? 0;
        }
        if (item.tool === 'wait_for_widget') run.metrics.waitMs += record.durationMs;
        else run.metrics.actionMs += record.durationMs;
        if (!result.ok || controller.signal.aborted) {
          const failure = this.failure(
            result.ok
              ? {
                  ok: false,
                  code: 'CANCELLED',
                  message: '操作后收到取消，结果未确认；请检查当前界面，不自动重试。',
                  uncertain: mutates(item.tool),
                }
              : result,
            item,
            clean,
          );
          run.status = failure.uncertain ? 'uncertain' : controller.signal.aborted ? 'cancelled' : 'failed';
          record.status = run.status;
          record.failure = failure;
          run.failure = failure;
          break;
        }
        record.status = 'completed';
        run.metrics.stepsCompleted++;
        this.changed();
      }
      if (run.status === 'running') run.status = 'completed';
    } catch (error) {
      const value = error as { code?: unknown; message?: unknown };
      run.status = 'failed';
      run.failure = {
        code: typeof value?.code === 'string' ? value.code.slice(0, 128) : 'WORKFLOW_FAILED',
        message:
          !acquired && typeof value?.message === 'string'
            ? clean(value.message).slice(0, 2048)
            : '工作流执行失败，请检查运行记录。',
        uncertain: false,
      };
      for (const record of run.steps)
        if (record.status === 'running') {
          record.status = 'failed';
          record.failure = run.failure;
        }
    } finally {
      let terminalStatus = run.status;
      // A terminal result also means the run has relinquished its operation ownership.
      run.status = 'running';
      for (const record of run.steps) if (record.status === 'pending') record.status = 'skipped';
      try {
        if (acquired) await this.host.release(run.runId);
      } catch {
        terminalStatus = 'uncertain';
        run.failure = {
          code: 'WORKFLOW_RELEASE_FAILED',
          message: '运行资源释放未确认，请检查设备状态。',
          uncertain: true,
        };
      }
      run.status = terminalStatus;
      run.finishedAt = Date.now();
      run.durationMs = run.finishedAt - run.startedAt;
      run.metrics.totalMs = run.durationMs;
      run.message =
        run.status === 'completed'
          ? '工作流操作完成；尚未执行业务断言，不代表测试通过。'
          : run.status === 'uncertain'
            ? '操作结果未确认；请检查当前状态，不自动重试。'
            : run.status === 'cancelled'
              ? '工作流已取消，已执行的操作不会自动回滚。'
              : '工作流已在失败步骤停止。';
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
      active.controller.abort();
      await active.completion;
    }
  }
}

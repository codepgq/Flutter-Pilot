import React, { useEffect, useState } from 'react';
import type { WorkbenchState } from '../src/model';
import type { Scene } from '../src/scene-model';
import type { WorkflowStep } from '../src/workflows/model';
import type { WorkflowStepResult } from '../src/workflows/controller';
import type { WaitDiagnostics } from '../src/automation/model';

const statuses: Record<string, string> = {
  running: '运行中',
  completed: '操作完成',
  failed: '执行失败',
  cancelled: '已取消',
  uncertain: '结果未确认',
  pending: '等待执行',
  skipped: '未执行',
};

type Send = (action: string, payload?: unknown) => void;

const toolLabels: Record<string, string> = {
  tap: '点击',
  enter_text: '输入文本',
  hide_keyboard: '收起键盘',
  wait_for_widget: '等待控件',
  scroll: '滚动',
};
const stateLabels: Record<string, string> = {
  present: '存在',
  absent: '消失',
  visible: '可见',
  enabled: '已启用',
  actionable: '可操作',
  text_equals: '文字等于指定值',
  text_contains: '文字包含指定值',
  text_changed: '文字发生变化',
};
const milliseconds = (value: number) => `${Math.round(value)} ms`;
const runStepSummary = (step: WorkflowStepResult) =>
  `${toolLabels[step.tool] ?? step.tool}${step.target !== undefined ? ` · ${step.target}` : ''}`;

function RunStepLocator({ step }: { step: WorkflowStepResult }) {
  const diagnostics = step.failure?.diagnostics;
  if (!diagnostics) return null;
  const source = diagnostics.selector.source ?? step.backend;
  return (
    <>
      <small className="muted scene-run-locator">
        {diagnostics.selector.key !== undefined ? (
          <>
            Widget Key：<code>{diagnostics.selector.key}</code>
          </>
        ) : (
          '使用其他选择器（详见场景配置）'
        )}
        {source && ` · 来源：${source === 'flutter' ? 'Flutter VM' : source === 'device' ? '设备' : source}`}
      </small>
      {step.tool === 'wait_for_widget' && (
        <small className="muted scene-run-locator">
          期望状态：{stateLabels[diagnostics.condition] ?? diagnostics.condition}
          {` · 超时：${milliseconds(diagnostics.timeoutMs)}`}
        </small>
      )}
    </>
  );
}

function WaitObservation({ diagnostics }: { diagnostics: WaitDiagnostics }) {
  const last = diagnostics.lastObservation;
  const facts = [
    last.code === 'FOUND' ? '已找到目标' : last.code === 'NOT_FOUND' ? '未找到目标' : '定位未确认',
    ...(
      [
        ['visible', '可见', '不可见'],
        ['enabled', '已启用', '未启用'],
        ['actionable', '可操作', '不可操作'],
        ['textMatches', '文字条件满足', '文字条件未满足'],
      ] as const
    ).flatMap(([key, yes, no]) => (typeof last[key] === 'boolean' ? [last[key] ? yes : no] : [])),
  ];
  return (
    <>
      <p>
        最后观测：{facts.join(' · ')}（已检查 {diagnostics.attempts} 次）。
      </p>
      <p>
        定位结果：{last.code}
        {last.message ? ` · ${last.message}` : ''}
      </p>
    </>
  );
}

function sceneName(state: WorkbenchState, id: string | null | undefined) {
  return id ? (state.scenes?.scenes.find((scene) => scene.id === id)?.name ?? id) : '未激活 Mock';
}

function stepSummary(step: WorkflowStep, scene: Scene, state: WorkbenchState) {
  if (step.type === 'hide_keyboard') return '收起键盘';
  if (step.type === 'call') {
    const source = state.scenes?.scenes.find((item) => item.id === (step.sceneId ?? scene.id));
    const action = source?.actions?.find((item) => item.id === step.actionId);
    return `调用操作 · ${source?.name ?? step.sceneId ?? scene.name} / ${action?.name ?? step.actionId}`;
  }
  const labels = {
    tap: '点击',
    enter_text: '输入文本',
    wait_for_widget: '等待控件',
    scroll: '滚动',
  };
  return `${labels[step.type]} · ${step.target}${step.type === 'scroll' && step.untilTarget ? ` → ${step.untilTarget}` : ''}`;
}

function TargetLocator({ target, scene }: { target: string; scene: Scene }) {
  const selector = scene.targets?.[target];
  const source =
    selector?.source === 'flutter' ? 'Flutter VM' : selector?.source === 'device' ? '设备' : '跟随操作通道';
  return (
    <small className="muted">
      {target} →{' '}
      {selector?.key !== undefined ? (
        <>
          Widget Key：<code>{selector.key}</code>
        </>
      ) : (
        '其他选择器（详见场景配置）'
      )}{' '}
      · 来源：{source}
    </small>
  );
}

export function SceneActionsPanel({
  scene,
  state,
  send,
}: {
  scene: Scene;
  state: WorkbenchState;
  send: Send;
}) {
  const data = state.sceneActions;
  const actions = scene.actions ?? [];
  const [selected, setSelected] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [backend, setBackend] = useState('auto');
  const action = actions.find((item) => item.id === selected);
  const actionInputsKey = JSON.stringify([scene.id, selected, action?.inputs]);
  const locked = state.busy || data?.locked || state.tests?.locked;
  useEffect(() => {
    if (selected && !actions.some((item) => item.id === selected)) {
      setSelected('');
      setInputs({});
    }
  }, [actions, selected]);
  useEffect(() => {
    setInputs(
      Object.fromEntries(
        Object.entries(action?.inputs ?? {}).flatMap(([key, spec]) =>
          spec.default !== undefined && !spec.secret ? [[key, spec.default]] : [],
        ),
      ),
    );
  }, [actionInputsKey]);
  const missing =
    action &&
    Object.entries(action.inputs ?? {}).some(
      ([key, spec]) => spec.required && spec.default === undefined && !inputs[key],
    );
  return (
    <section className="card scene-operation-panel" aria-label="场景辅助操作">
      <div className="mcp-heading">
        <h3>UI 操作（Workflow）</h3>
        <span className="badge">
          {actions.length} 个操作 · {Object.keys(scene.targets ?? {}).length} 个目标
        </span>
      </div>
      <p className="muted">
        操作来源：{scene.name} · 当前 Mock：{sceneName(state, state.scenes?.activeSceneId)}
      </p>
      <p className="muted">
        选择已保存的操作，填写参数后手动运行；Agent 也可执行同一操作。执行时保留当前 Mock。
      </p>
      <div className="scene-operation-toolbar">
        <button onClick={() => send('scenes.open')}>打开场景配置</button>
        <button disabled={locked} onClick={() => send('project.reload')}>
          重新加载场景配置
        </button>
      </div>
      {data?.error && <p role="alert">{data.error}</p>}
      {!actions.length && (
        <div className="scene-operation-empty">
          <strong>尚未配置 UI 操作</strong>
          <p>
            当前场景只有 Mock 或目标定义。在 scenes.json 中为此场景添加 targets 和 actions，保存后重新加载，
            即可在这里选择并运行登录、填表等多步操作。
          </p>
          <small className="muted">
            操作由手动或 Agent 显式运行；激活场景、重连和重新加载均不会自动执行。
          </small>
        </div>
      )}
      {!!actions.length && (
        <>
          <div className="workflow-fields">
            <label>
              选择操作
              <select
                aria-label="选择场景操作"
                value={selected}
                disabled={locked}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">请选择操作</option>
                {actions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.steps.length} 个步骤
                  </option>
                ))}
              </select>
            </label>
            <label>
              操作通道
              <select
                aria-label="场景操作通道"
                value={backend}
                disabled={locked}
                onChange={(event) => setBackend(event.target.value)}
              >
                <option value="auto">自动选择</option>
                <option value="flutter">Flutter VM</option>
                <option value="device">设备输入</option>
              </select>
            </label>
            {action &&
              Object.entries(action.inputs ?? {}).map(([key, spec]) => (
                <label key={`${action.id}:${key}`}>
                  {key}
                  {spec.required && spec.default === undefined ? '（必填）' : ''}
                  <input
                    aria-label={`操作参数 ${key}`}
                    type={spec.secret ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={locked}
                    value={inputs[key] ?? ''}
                    placeholder={spec.secret && spec.default !== undefined ? '留空使用已配置的默认值' : ''}
                    onChange={(event) => setInputs((old) => ({ ...old, [key]: event.target.value }))}
                  />
                </label>
              ))}
          </div>
          {action?.description && <p>{action.description}</p>}
          {action && (
            <details className="scene-operation-preview">
              <summary>查看操作步骤（{action.steps.length}）</summary>
              <p className="muted">
                步骤通过 target 引用本场景 targets；以下显示已配置的 Widget Key 与定位来源。
              </p>
              <ol className="workflow-steps" aria-label="操作步骤预览">
                {action.steps.map((step) => (
                  <li key={step.id}>
                    <strong>{stepSummary(step, scene, state)}</strong>
                    {'target' in step && <TargetLocator target={step.target} scene={scene} />}
                    {step.type === 'scroll' && step.untilTarget && (
                      <TargetLocator target={step.untilTarget} scene={scene} />
                    )}
                    <small className="muted">{step.id}</small>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {state.mode !== 'proxy' && state.vm?.status !== 'connected' && (
            <p className="muted">运行前请启动并连接 Flutter Debug App，或连接设备输入通道。</p>
          )}
          <button
            className="primary"
            disabled={!action || missing || locked}
            onClick={() => {
              const values = Object.fromEntries(
                Object.entries(inputs).filter(
                  ([key, value]) =>
                    Object.hasOwn(action?.inputs ?? {}, key) &&
                    (value !== '' ||
                      !action?.inputs?.[key]?.secret ||
                      action.inputs[key].default === undefined),
                ),
              );
              send('scenes.actions.run', { sceneId: scene.id, actionId: selected, inputs: values, backend });
              setInputs((old) =>
                Object.fromEntries(Object.entries(old).filter(([key]) => !action?.inputs?.[key]?.secret)),
              );
            }}
          >
            运行操作
          </button>
        </>
      )}
    </section>
  );
}

export function SceneActionRunPanel({ state, send }: { state: WorkbenchState; send: Send }) {
  const data = state.sceneActions;
  const run = data?.run;
  if (!run) return null;
  const failedStepIndex = run.steps.findIndex((step) => step.failure);
  const failedStep = run.steps[failedStepIndex];
  return (
    <section className="card scene-operation-panel" aria-label="场景操作运行结果" aria-live="polite">
      <div className="mcp-heading">
        <h3>{run.name}</h3>
        <span className="badge">{statuses[run.status] ?? run.status}</span>
      </div>
      <p className="muted">
        操作来源：{sceneName(state, run.sceneId)} · 本轮 Mock：{sceneName(state, run.mockSceneId)}
      </p>
      <p>{run.message}</p>
      {data?.running && (
        <button
          disabled={run.cancelRequested}
          onClick={() => send('scenes.actions.cancel', { runId: run.runId })}
        >
          {run.cancelRequested ? '正在取消…' : '取消操作'}
        </button>
      )}
      <p className="muted">
        已完成 {run.metrics.stepsCompleted}/{run.steps.length} 步 · 总耗时 {milliseconds(run.metrics.totalMs)}{' '}
        · 定位 {milliseconds(run.metrics.resolveMs)} · 输入 {milliseconds(run.metrics.inputMs)} ·
        等待（含定位） {milliseconds(run.metrics.waitMs)}
      </p>
      {run.failure && (
        <div role="alert" className="scene-run-failure">
          {failedStep && (
            <strong>
              第 {failedStepIndex + 1} 步
              {failedStep.status === 'uncertain'
                ? '结果未确认'
                : failedStep.status === 'cancelled'
                  ? '已取消'
                  : '失败'}
              ：{runStepSummary(failedStep)}
            </strong>
          )}
          <p>
            {run.failure.code} · {run.failure.message}
          </p>
          {failedStep && <RunStepLocator step={failedStep} />}
          {run.failure.diagnostics && <WaitObservation diagnostics={run.failure.diagnostics} />}
          {run.failure.code === 'WAIT_TIMEOUT' && (
            <p>检查当前页面是否满足操作前提，并核对目标 Key 和等待状态；确认后再决定是否重新运行。</p>
          )}
          <button onClick={() => send('scenes.open')}>打开场景配置</button>
        </div>
      )}
      {run.status === 'uncertain' && (
        <p className="notice">操作可能已经发生。请先检查页面和网络记录，再决定下一步。</p>
      )}
      <ol className="workflow-steps" aria-label="运行步骤">
        {run.steps.map((step) => (
          <li key={step.path}>
            <div>
              <strong>{runStepSummary(step)}</strong>
              <span>
                {statuses[step.status] ?? step.status}
                {step.durationMs !== undefined ? ` · ${milliseconds(step.durationMs)}` : ''}
              </span>
            </div>
            <RunStepLocator step={step} />
            <details className="scene-run-path">
              <summary>步骤：{step.id}</summary>
              <small className="muted">调用路径：{step.path}</small>
            </details>
            {step.failure && (
              <p>
                {step.failure.code} · {step.failure.message}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

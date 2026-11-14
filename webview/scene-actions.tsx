import React, { useEffect, useState } from 'react';
import type { WorkbenchState } from '../src/model';
import type { Scene } from '../src/scene-model';

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

function sceneName(state: WorkbenchState, id: string | null | undefined) {
  return id ? (state.scenes?.scenes.find((scene) => scene.id === id)?.name ?? id) : '未激活 Mock';
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
        <h3>辅助操作</h3>
        <span className="badge">
          {actions.length} 个操作 · {Object.keys(scene.targets ?? {}).length} 个目标
        </span>
      </div>
      <p className="muted">
        操作来源：{scene.name} · 当前 Mock：{sceneName(state, state.scenes?.activeSceneId)}
      </p>
      <p className="muted">按需执行已保存的定位和步骤。执行操作会保留当前 Mock，激活场景不会自动运行操作。</p>
      <button onClick={() => send('scenes.open')}>打开场景配置</button>
      {data?.error && <p role="alert">{data.error}</p>}
      {!actions.length && <p>此场景没有固定操作，可手动操作 App，或在场景配置中保存 targets 和 actions。</p>}
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
        已完成 {run.metrics.stepsCompleted}/{run.steps.length} 步 · 总耗时 {run.metrics.totalMs} ms · 定位{' '}
        {run.metrics.resolveMs} ms · 输入 {run.metrics.inputMs} ms · 等待 {run.metrics.waitMs} ms
      </p>
      {run.failure && (
        <p role="alert">
          {run.failure.code} · {run.failure.message}
        </p>
      )}
      {run.status === 'uncertain' && (
        <p className="notice">操作可能已经发生。请先检查页面和网络记录，再决定下一步。</p>
      )}
      <ol className="workflow-steps">
        {run.steps.map((step) => (
          <li key={step.path}>
            <div>
              <strong>{step.path}</strong>
              <span>
                {statuses[step.status] ?? step.status}
                {step.durationMs !== undefined ? ` · ${step.durationMs} ms` : ''}
              </span>
            </div>
            <small className="muted">
              {step.tool} · {step.target}
            </small>
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

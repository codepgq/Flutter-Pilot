import React, { useEffect, useState } from 'react';
import type { WorkbenchState } from '../src/model';

const labels: Record<string, string> = {
  running: '运行中',
  passed: '测试通过',
  failed: '断言失败',
  error: '执行错误',
  cancelled: '已取消',
  uncertain: '结果未确认',
  pending: '等待验证',
  sent: '已注入',
  dispatching: '正在注入',
  skipped: '未执行',
  completed: '操作完成',
};

export function TestPanel({
  state,
  send,
}: {
  state: WorkbenchState;
  send: (action: string, payload?: unknown) => void;
}) {
  const data = state.tests;
  const tests = data?.catalogue?.tests ?? [];
  const [selected, setSelected] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const test = tests.find((item) => item.id === selected);
  const actionScene = state.scenes?.scenes.find((scene) => scene.id === test?.action.sceneId);
  const action = actionScene?.actions?.find((item) => item.id === test?.action.actionId);
  const actionInputsKey = JSON.stringify([test?.action, action?.inputs]);
  const run = data?.run;
  useEffect(() => {
    send('tests.refresh');
  }, []);
  useEffect(() => {
    if (selected && !tests.some((item) => item.id === selected)) {
      setSelected('');
      setInputs({});
    }
  }, [tests, selected]);
  useEffect(() => {
    setInputs({});
  }, [actionInputsKey]);
  return (
    <div className="workflows-page">
      <section className="card" aria-label="业务测试">
        <div className="mcp-heading">
          <h2>业务测试</h2>
          <span className="badge">{tests.length} 个测试</span>
        </div>
        <p className="muted">
          组合临时场景、场景操作与本轮 HTTP / WS / UI 断言。使用当前 Debug App，结束后恢复临时环境并保留页面。
        </p>
        <div className="mcp-actions">
          <button onClick={() => send('tests.refresh')} disabled={state.busy}>
            读取测试文件
          </button>
          <button onClick={() => send('tests.open')} disabled={state.busy}>
            打开测试配置
          </button>
        </div>
        {data?.error && <p role="alert">{data.error}</p>}
        {!!data?.cleanupPending?.length && (
          <p role="alert">
            上次测试环境未完整恢复。连接恢复后可重试清理。
            <button onClick={() => send('tests.cleanup')} disabled={data.running || state.busy}>
              恢复测试环境
            </button>
          </p>
        )}
        {!tests.length && !data?.error && (
          <p>暂无测试。让 Agent 引用 Scene 中已保存的操作，补充本轮请求与业务结果断言。</p>
        )}
        {!!tests.length && (
          <>
            {test && (
              <p className="muted">
                操作来源：{actionScene?.name ?? test.action.sceneId} / {action?.name ?? test.action.actionId}
              </p>
            )}
            {test && !action && <p role="alert">测试引用的场景操作不存在，请检查配置并重新加载场景。</p>}
            <div className="workflow-fields">
              <label>
                选择测试
                <select
                  aria-label="选择测试"
                  value={selected}
                  disabled={data?.locked}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    setInputs({});
                  }}
                >
                  <option value="">请选择测试</option>
                  {tests.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.assertionCount} 项断言
                    </option>
                  ))}
                </select>
              </label>
              {action &&
                Object.entries(action.inputs ?? {}).map(([key, spec]) => (
                  <label key={`${test?.id}:${key}`}>
                    {key}（覆盖参数）
                    <input
                      aria-label={`测试参数 ${key}`}
                      type={spec.secret ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={data?.locked}
                      placeholder="留空沿用测试配置"
                      value={inputs[key] ?? ''}
                      onChange={(event) => setInputs((old) => ({ ...old, [key]: event.target.value }))}
                    />
                  </label>
                ))}
            </div>
            <button
              className="primary"
              disabled={!test || !action || data?.locked || state.busy}
              onClick={() => {
                send('tests.run', {
                  testId: selected,
                  inputs: Object.fromEntries(
                    Object.entries(inputs).filter(
                      ([key, value]) => Object.hasOwn(action?.inputs ?? {}, key) && value !== '',
                    ),
                  ),
                });
                setInputs((old) =>
                  Object.fromEntries(Object.entries(old).filter(([key]) => !action?.inputs?.[key]?.secret)),
                );
              }}
            >
              运行测试
            </button>
          </>
        )}
      </section>
      {run && (
        <section className="card" aria-label="测试运行结果" aria-live="polite">
          <div className="mcp-heading">
            <h2>{run.name}</h2>
            <span className="badge">{labels[run.status]}</span>
          </div>
          <p>{run.message}</p>
          {data?.running && (
            <button disabled={run.cancelRequested} onClick={() => send('tests.cancel', { runId: run.runId })}>
              {run.cancelRequested ? '正在取消…' : '取消测试'}
            </button>
          )}
          <p className="muted">
            运行 {run.runId} · {run.durationMs ?? 0} ms ·{' '}
            {run.assertions.filter((item) => item.status === 'passed').length}/{run.assertions.length}{' '}
            项断言通过
          </p>
          {run.failure && (
            <p role="alert">
              {run.failure.code} · {run.failure.message}
            </p>
          )}
          {run.status === 'uncertain' && (
            <p className="notice">操作可能已经发生。请检查页面与本轮网络记录后再决定下一步。</p>
          )}
          <ol className="workflow-steps">
            {run.steps.map((step) => (
              <li key={step.path}>
                <div>
                  <strong>{step.path}</strong>
                  <span>
                    {labels[step.status] ?? step.status} · {step.durationMs ?? 0} ms
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
          <h3>业务断言</h3>
          <ul className="workflow-steps">
            {run.assertions.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>
                    {item.kind.toUpperCase()} · {item.id}
                  </strong>
                  <span>{labels[item.status]}</span>
                </div>
                {item.message && <p>{item.message}</p>}
                {item.evidence && (
                  <small className="muted">证据 {Object.values(item.evidence).join(' · ')}</small>
                )}
              </li>
            ))}
          </ul>
          {!!run.events.length && (
            <>
              <h3>关联事件</h3>
              <ul className="workflow-steps">
                {run.events.map((event) => (
                  <li key={event.id}>
                    {event.id} · {labels[event.status]}
                    {event.connectionId && ` · ${event.connectionId}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}

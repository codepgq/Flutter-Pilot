import React, { useEffect, useState } from 'react';
import type { WorkbenchState } from '../src/model';

const statuses: Record<string, string> = {
  running: '运行中',
  completed: '操作完成',
  failed: '执行失败',
  cancelled: '已取消',
  uncertain: '结果未确认',
  pending: '等待执行',
  skipped: '未执行',
};

export function WorkflowPanel({
  state,
  send,
}: {
  state: WorkbenchState;
  send: (action: string, payload?: unknown) => void;
}) {
  const data = state.workflows;
  const flows = data?.catalogue?.workflows ?? [];
  const [selected, setSelected] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [backend, setBackend] = useState('auto');
  const flow = flows.find((item) => item.id === selected);
  const run = data?.run;
  useEffect(() => {
    send('workflows.refresh');
  }, []);
  useEffect(() => {
    if (selected && !flows.some((item) => item.id === selected)) {
      setSelected('');
      setInputs({});
    }
  }, [flows, selected]);
  const select = (id: string) => {
    setSelected(id);
    const item = flows.find((candidate) => candidate.id === id);
    setInputs(
      Object.fromEntries(
        Object.entries(item?.inputs ?? {}).flatMap(([key, spec]) =>
          spec.default !== undefined && !spec.secret ? [[key, spec.default]] : [],
        ),
      ),
    );
  };
  const missing =
    flow &&
    Object.entries(flow.inputs).some(
      ([key, spec]) => spec.required && spec.default === undefined && !inputs[key],
    );
  return (
    <div className="workflows-page">
      <section className="card" aria-label="可复用流程">
        <div className="mcp-heading">
          <h2>可复用流程</h2>
          <span className="badge">{data?.running ? '流程运行中' : `${flows.length} 个流程`}</span>
        </div>
        <p className="muted">
          由 Agent 首次探索并保存，后续传入参数即可运行。流程独立于 Mock 场景，需要时先激活对应场景。
        </p>
        <div className="mcp-actions">
          <button onClick={() => send('workflows.refresh')} disabled={state.busy}>
            读取流程文件
          </button>
          <button onClick={() => send('workflows.open')} disabled={state.busy}>
            打开流程配置
          </button>
        </div>
        {data?.error && <p role="alert">{data.error}</p>}
        {!flows.length && !data?.error && (
          <p>暂无流程。打开配置后，让 Agent 保存已验证的登录、下单等操作。</p>
        )}
        {!!flows.length && (
          <>
            <div className="workflow-fields">
              <label>
                选择流程
                <select
                  aria-label="选择流程"
                  value={selected}
                  disabled={data?.locked}
                  onChange={(event) => select(event.target.value)}
                >
                  <option value="">请选择流程</option>
                  {flows.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.stepCount} 个步骤
                    </option>
                  ))}
                </select>
              </label>
              <label>
                操作通道
                <select
                  aria-label="流程操作通道"
                  value={backend}
                  disabled={data?.locked}
                  onChange={(event) => setBackend(event.target.value)}
                >
                  <option value="auto">自动选择</option>
                  <option value="flutter">Flutter VM</option>
                  <option value="device">设备输入</option>
                </select>
              </label>
              {flow &&
                Object.entries(flow.inputs).map(([key, spec]) => (
                  <label key={`${flow.id}:${key}`}>
                    {key}
                    {spec.required && spec.default === undefined ? '（必填）' : ''}
                    <input
                      aria-label={`流程参数 ${key}`}
                      type={spec.secret ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={data?.locked}
                      value={inputs[key] ?? ''}
                      placeholder={spec.secret && spec.default !== undefined ? '留空使用已配置的默认值' : ''}
                      onChange={(event) =>
                        setInputs((previous) => ({ ...previous, [key]: event.target.value }))
                      }
                    />
                  </label>
                ))}
            </div>
            <button
              className="primary"
              disabled={!flow || missing || data?.locked || state.busy}
              onClick={() => {
                const values = Object.fromEntries(
                  Object.entries(inputs).filter(
                    ([key, value]) =>
                      value !== '' || !flow?.inputs[key]?.secret || flow.inputs[key].default === undefined,
                  ),
                );
                send('workflows.run', { workflowId: selected, inputs: values, backend });
                setInputs((previous) =>
                  Object.fromEntries(Object.entries(previous).filter(([key]) => !flow?.inputs[key]?.secret)),
                );
              }}
            >
              运行流程
            </button>
          </>
        )}
      </section>
      {run && (
        <section className="card" aria-label="流程运行结果" aria-live="polite">
          <div className="mcp-heading">
            <h2>{run.name}</h2>
            <span className="badge">{statuses[run.status] ?? run.status}</span>
          </div>
          <p>{run.message}</p>
          {data?.running && (
            <button
              disabled={run.cancelRequested}
              onClick={() => send('workflows.cancel', { runId: run.runId })}
            >
              {run.cancelRequested ? '正在取消…' : '取消流程'}
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
      )}
    </div>
  );
}

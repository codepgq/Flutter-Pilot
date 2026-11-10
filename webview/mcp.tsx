import React, { useEffect, useState } from 'react';
import type { WorkbenchState } from '../src/model';
import type { McpAgentId, McpScope } from '../src/mcp/model';

const agents: { id: McpAgentId; label: string }[] = [
  { id: 'claude', label: 'Claude Code CLI' },
  { id: 'codex-cli', label: 'Codex CLI' },
  { id: 'codex-app', label: 'Codex App' },
];
const statuses: Record<string, string> = {
  unavailable: '未检测到客户端',
  'not-configured': '未配置',
  configured: '已配置，待客户端连接',
  conflict: '同名配置冲突',
  invalid: '配置文件无效',
};

export function McpPanel({
  state,
  send,
}: {
  state: WorkbenchState;
  send: (action: string, payload?: unknown) => void;
}) {
  const mcp = state.mcp;
  const [scope, setScope] = useState<McpScope>('project');
  useEffect(() => {
    send('mcp.inspect', { scope });
  }, [scope]);
  return (
    <div className="mcp-page">
      <section className="card" aria-label="MCP 服务">
        <div className="mcp-heading">
          <div>
            <h2>MCP 服务</h2>
            <span className="muted">
              {mcp?.running ? '桥接运行中' : '桥接未开启'} · VM{' '}
              {state.vm?.status === 'connected' ? '已连接' : '未连接'}
            </span>
          </div>
          <button
            className="rule-switch"
            type="button"
            role="switch"
            aria-label="开启 MCP"
            aria-checked={mcp?.enabled ?? false}
            disabled={state.busy}
            onClick={() => send('mcp.enable', { enabled: !mcp?.enabled })}
          >
            <span className="rule-switch-track">
              <span className="rule-switch-thumb" />
            </span>
          </button>
        </div>
        <details className="secondary-details">
          <summary>服务诊断与 UI 探测</summary>
          <dl className="mcp-facts">
            <div>
              <dt>桥接服务</dt>
              <dd>{mcp?.running ? '运行中' : '未开启'}</dd>
            </div>
            <div>
              <dt>Dart VM</dt>
              <dd>{state.vm?.status === 'connected' ? '已连接' : '未连接'}</dd>
            </div>
            <div>
              <dt>UI 能力</dt>
              <dd>{mcp?.ui.supported ? '运行时探测通过 · 实验性' : (mcp?.ui.reason ?? '尚未探测')}</dd>
            </div>
            <div>
              <dt>Node.js</dt>
              <dd>{mcp?.nodePath ?? '适配时检测 Node.js 20+'}</dd>
            </div>
          </dl>
          <p className="muted">
            开启 MCP 后继续由插件维护 VM 连接。关闭工作台可继续使用；采集与 Mock 开关独立控制。
          </p>
          <button
            disabled={state.busy || !mcp?.running || state.vm?.status !== 'connected'}
            onClick={() => send('mcp.probe')}
          >
            探测 UI 能力
          </button>
        </details>
        {mcp?.error && (
          <p className="mcp-error" role="alert">
            {mcp.error}
          </p>
        )}
        {mcp?.notice && <p role="status">{mcp.notice}</p>}
      </section>
      <section aria-label="Agent 适配" className="mcp-agents">
        <div className="mcp-heading">
          <h2>Agent 适配</h2>
          <label>
            适配范围{' '}
            <select
              aria-label="适配范围"
              value={scope}
              disabled={state.busy}
              onChange={(e) => setScope(e.target.value as McpScope)}
            >
              <option value="project">当前项目</option>
              <option value="global">全局</option>
            </select>
          </label>
        </div>
        <p className="muted">
          {scope === 'project'
            ? '仅绑定当前项目，推荐用于日常开发。'
            : '全局客户端可发现本机已开启 MCP 的项目，操作时必须指定会话。'}
        </p>
        {agents.map(({ id, label }) => {
          const item = mcp?.scope === scope ? mcp.agents.find((a) => a.agent === id) : undefined;
          const payload = { agent: id, scope };
          return (
            <article key={id} className="card" aria-label={label}>
              <div className="mcp-heading">
                <h3>{label}</h3>
                <span className="badge">
                  {item?.connected ? '已连接 · MCP 握手通过' : (statuses[item?.status ?? ''] ?? '待检测')}
                </span>
              </div>
              {item?.message && <p>{item.message}</p>}
              {item?.difference && item.status === 'conflict' && (
                <p className="muted">
                  配置差异：启动程序{item.difference.commandMatches ? '一致' : '不同'}，启动参数
                  {item.difference.argumentsMatch ? '一致' : '不同'}。
                </p>
              )}
              <div className="mcp-actions">
                {!item?.configured && item?.status !== 'conflict' && (
                  <button
                    disabled={state.busy || item?.status === 'invalid'}
                    onClick={() => send('mcp.adapt', payload)}
                  >
                    一键适配
                  </button>
                )}
                {item?.status === 'conflict' && (
                  <button
                    disabled={state.busy}
                    onClick={() => send('mcp.adapt', { ...payload, repair: true })}
                  >
                    修复本插件配置
                  </button>
                )}
                <details className="secondary-details mcp-config-details">
                  <summary>配置与维护</summary>
                  {item?.configPath && <code className="mcp-path">{item.configPath}</code>}
                  {!!item?.shared && <p className="muted">Codex CLI 与 App 共用此配置，适配一次即可。</p>}
                  {item?.effectiveMessage && <p className="muted">{item.effectiveMessage}</p>}
                  <div className="mcp-actions">
                    <button disabled={state.busy} onClick={() => send('mcp.inspect', { scope })}>
                      重新检测
                    </button>
                    {item?.configured && (
                      <button disabled={state.busy} onClick={() => send('mcp.remove', payload)}>
                        移除适配
                      </button>
                    )}
                    {item?.configPath && (
                      <button disabled={state.busy} onClick={() => send('mcp.config.open', payload)}>
                        查看配置
                      </button>
                    )}
                  </div>
                </details>
              </div>
            </article>
          );
        })}
      </section>
      <details className="card secondary-details" aria-label="MCP 使用说明">
        <summary>使用说明与 Agent 工作流程</summary>
        <p>
          Agent 连接后会收到能力与使用场景说明；需要 Mock、排查网络或操作 Flutter UI 时，先调用{' '}
          <code>get_usage_guide</code> 读取对应指南。
        </p>
        <ul>
          <li>
            <code>topic: http</code>：rules.json 字段、JSON 正文及请求／响应修改示例。
          </li>
          <li>
            <code>topic: ws</code>：ws-rules.json 的 URL、方向、文本替换／丢弃与消息验证。
          </li>
          <li>
            <code>topic: ui</code>：快照发现 Key、父范围定位、点击、输入、滚动及 Key 问题处理。
          </li>
          <li>
            <code>topic: workflow</code>：规则编辑、重载、开关、UI 操作与结果验证的完整流程。
          </li>
        </ul>
        <p className="muted">
          不传 topic 默认读取 overview。指南也通过 MCP 资源提供，无需在线 IDE 或会话；运行时操作仍需项目已开启
          MCP 并连接 VM。
        </p>
        <p>
          编辑 <code>.api-mocks/rules.json</code> 或 <code>.api-mocks/ws-rules.json</code> → 调用{' '}
          <code>reload_rules</code> → 显式开启 Mock → 按 Key 操作 UI → 查询网络记录。
        </p>
        <p>缺少稳定 Key 时由 MCP 返回诊断，由编码 Agent 修复源码。正式交互不会回退到文本定位。</p>
        <p className="muted">
          项目配置写入后，客户端可能仍需批准 MCP、重新连接或打开新会话；本页不会把配置成功当作客户端已加载。
        </p>
        {mcp?.clients.length ? (
          <ul>
            {mcp.clients.map((c) => (
              <li key={`${c.name}-${c.scope ?? ''}`}>
                {c.name} {c.version} · 最近握手 {new Date(c.lastSeen).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </div>
  );
}

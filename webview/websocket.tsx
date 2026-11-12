import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WsConnection, WsDirection, WsMessage, WsRule, WsState } from '../src/ws/model';
import type { Scene } from '../src/scene-model';
import { inspectJson } from './body';

const emptyState: WsState = {
  captureEnabled: false,
  mockEnabled: false,
  status: 'off',
  connections: [],
  messages: { items: [], total: 0 },
  rules: [],
  omitted: 0,
  warnings: [],
};
const directions = { outbound: 'App → 服务端', inbound: '服务端 → App' };
const outcomes = { original: '原始', replaced: '已替换', dropped: '已丢弃', synthetic: '模拟推送' };
const connectionStates = { open: '在线', closed: '已关闭', disconnected: '已断开' };
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const byteSize = (value: string) => new TextEncoder().encode(value).byteLength;
const PAGE_SIZE = 30;
type Send = (action: string, payload?: unknown) => void;

function Content({ value, binary, label }: { value: string; binary: boolean; label: string }) {
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState('');
  const json = useMemo(() => (binary ? {} : inspectJson(value)), [value, binary]);
  const displayed = !raw && json.formatted ? json.formatted : value;
  useEffect(() => {
    setCopied('');
  }, [value, raw]);
  return (
    <section className="ws-body" aria-label={label}>
      <div className="ws-body-toolbar">
        <strong>{label}</strong>
        <span className="tag">{binary ? 'Base64 · 只读' : !raw && json.formatted ? 'JSON' : '原文'}</span>
        <div className="ws-inline-actions">
          {json.formatted && <button onClick={() => setRaw(!raw)}>{raw ? 'JSON 格式化' : '显示原文'}</button>}
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(displayed);
                setCopied('已复制');
              } catch {
                setCopied('复制失败，请选中文本复制');
              }
            }}
          >
            复制{label}
          </button>
        </div>
      </div>
      {copied && <small role="status">{copied}</small>}
      {!raw && json.hint && <small>{json.hint}</small>}
      <pre tabIndex={0}>{displayed || '（空消息）'}</pre>
    </section>
  );
}

export function WebSocketPanel({
  state = emptyState,
  connected,
  vmMode,
  busy,
  send,
  rulesOnly = false,
  openScenes,
  createInScene,
  initialDraft,
  onDraftClosed,
  scenes = [],
  sceneId,
}: {
  scenes?: Scene[];
  sceneId?: string;
  initialDraft?: WsRule;
  onDraftClosed?: () => void;
  rulesOnly?: boolean;
  openScenes?: () => void;
  createInScene?: (rule: WsRule) => void;
  state?: WsState;
  connected: boolean;
  vmMode: boolean;
  busy: boolean;
  send: Send;
}) {
  const [section, setSection] = useState<'messages' | 'rules'>(rulesOnly ? 'rules' : 'messages');
  const [connectionId, setConnectionId] = useState<string>();
  const [direction, setDirection] = useState<WsDirection | ''>('');
  const [search, setSearch] = useState('');
  const [querySearch, setQuerySearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<WsMessage>();
  const selectedId = useRef<string | undefined>(undefined);
  const [pushText, setPushText] = useState('');
  const [draft, setDraft] = useState<WsRule | undefined>(initialDraft);
  const pendingRule = useRef<WsRule | undefined>(undefined);
  const sortedRules = useMemo(() => [...state.rules].sort((a, b) => b.priority - a.priority), [state.rules]);
  const [pushError, setPushError] = useState('');
  const connection = state.connections.find((item) => item.id === connectionId);
  const canCapture = vmMode && connected;
  const canPush =
    canCapture && state.captureEnabled && connection?.status === 'open' && connection.capture === 'attached';

  useEffect(() => {
    if (rulesOnly) return;
    const timer = setTimeout(() => {
      setQuerySearch(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (rulesOnly) return;
    selectedId.current = undefined;
    setDetail(undefined);
    send('ws.query', {
      connectionId,
      direction: direction || undefined,
      search: querySearch,
      limit: PAGE_SIZE,
      offset,
    });
  }, [connectionId, direction, querySearch, offset, send]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== 'ws.detail') return;
      const message = event.data.message as WsMessage | null;
      if (!message || message.id === selectedId.current) setDetail(message ?? undefined);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  useEffect(() => {
    const pending = pendingRule.current;
    if (
      pending &&
      [...state.rules, ...scenes.flatMap((scene) => scene.wsRules)].some(
        (rule) => JSON.stringify(rule) === JSON.stringify(pending),
      )
    ) {
      pendingRule.current = undefined;
      setDraft(undefined);
      onDraftClosed?.();
    }
  }, [state.rules, scenes, onDraftClosed]);

  const newRule = () => {
    pendingRule.current = undefined;
    const rule: WsRule = {
      id: crypto.randomUUID(),
      name: '',
      enabled: true,
      priority: 0,
      match:
        connection?.status === 'open' && connection.capture === 'attached' && !connection.url
          ? { connectionId: connection.id }
          : { url: connection?.url ?? '' },
      action: { type: 'replace', text: '' },
    };
    if (createInScene) {
      createInScene(rule);
      return;
    }
    setDraft(rule);
    setSection('rules');
  };
  const changeConnection = (id?: string) => {
    setConnectionId(id);
    setOffset(0);
    setPushText('');
    setPushError('');
  };
  return (
    <div className="ws-page">
      {!rulesOnly && (
        <section className="card ws-controls" aria-label="WebSocket 采集控制">
          <div className="ws-control-actions">
            <h2>WebSocket</h2>
            <span className={`status-pill ${state.captureEnabled && connected ? 'online' : ''}`}>
              <i />
              {state.status === 'unsupported'
                ? '当前运行时不支持'
                : state.captureEnabled && connected
                  ? 'WS 采集中'
                  : 'WS 采集未开启'}
            </span>
            <button
              className={state.captureEnabled ? '' : 'primary'}
              disabled={busy || (!state.captureEnabled && !canCapture)}
              onClick={() => send('ws.capture', { enabled: !state.captureEnabled })}
            >
              {state.captureEnabled ? '关闭 WS 采集' : '开启 WS 采集'}
            </button>
            <span className="tag">{state.mockEnabled ? '场景 WS Mock 已开启' : '场景 WS Mock 未开启'}</span>
            <button onClick={openScenes}>管理 Mock 场景</button>
            <details className="secondary-details ws-capture-details">
              <summary>采集设置与说明</summary>
              <div className="secondary-content">
                <button
                  disabled={busy || !canCapture || !state.captureEnabled}
                  onClick={() => send('ws.rescan')}
                >
                  重新发现连接
                </button>
                <p>
                  采集会安装实验性运行时处理器，无需改源码。WS Mock 由激活场景控制，关闭工作台后继续运行。
                </p>
                <small>
                  仅接入受支持的 dart:io 客户端连接；新连接在扫描后接入，接入前消息无法补抓或修改。
                </small>
              </div>
            </details>
          </div>
          {(!vmMode || !connected) && (
            <p>
              {!vmMode
                ? 'WS 消息功能需要 VM 接入，请先在“连接与诊断”切换到 VM 模式。'
                : '先在“连接与诊断”连接运行中的 Flutter Debug VM，再手动开启 WS 采集。'}
            </p>
          )}
        </section>
      )}
      {(state.error || state.ruleSyncError) && (
        <div className="notice" role="alert">
          {state.error || state.ruleSyncError}
        </div>
      )}
      {state.warnings.map((warning, i) => (
        <div className="notice" key={`${i}:${warning}`}>
          {warning}
        </div>
      ))}
      {state.omitted > 0 && (
        <div className="notice" role="status">
          采集负载过高，已遗漏 {state.omitted} 条记录；业务消息继续传递。
        </div>
      )}
      {!rulesOnly && (
        <div className="ws-section-tabs" aria-label="WebSocket 页面">
          <button
            className={section === 'messages' ? 'active' : ''}
            aria-pressed={section === 'messages'}
            onClick={() => setSection('messages')}
          >
            消息 <span className="count">{state.messages.total}</span>
          </button>
          <button
            className={section === 'rules' ? 'active' : ''}
            aria-pressed={section === 'rules'}
            onClick={() => openScenes?.()}
          >
            WS 规则 <span className="count">{state.rules.length}</span>
          </button>
        </div>
      )}
      {section === 'messages' ? (
        <>
          <div className="ws-workspace">
            <aside className="ws-connections" aria-label="WebSocket 连接">
              <div className="ws-section-heading">
                <h3>业务连接</h3>
                <span className="count">{state.connections.length}</span>
              </div>
              <button
                className={`ws-connection ${!connectionId ? 'selected' : ''}`}
                onClick={() => changeConnection()}
              >
                全部连接
              </button>
              {state.connections.map((item) => (
                <button
                  key={item.id}
                  className={`ws-connection ${connectionId === item.id ? 'selected' : ''}`}
                  aria-pressed={connectionId === item.id}
                  aria-label={item.url ?? item.endpoint}
                  title={item.url ?? item.endpoint}
                  onClick={() => changeConnection(item.id)}
                >
                  <span className="ws-connection-top">
                    <span className={`ws-dot ${item.status === 'open' ? 'online' : ''}`} />
                    <strong>{item.url ?? item.endpoint}</strong>
                  </span>
                  <small>
                    {connectionStates[item.status]} · {item.capture === 'attached' ? '已接入' : '不支持'}
                  </small>
                  {!item.url && <small>URL 未知 · 无法匹配 URL 规则</small>}
                  <small>
                    ↑ {item.sent}　↓ {item.received}
                  </small>
                  {item.warning && <small>{item.warning}</small>}
                </button>
              ))}
              {!state.connections.length && (
                <p className="ws-empty">
                  {state.captureEnabled
                    ? '等待发现业务连接；请在 App 中触发 WebSocket 功能。'
                    : '开启采集后，业务连接将在此显示。'}
                </p>
              )}
            </aside>
            <section className="ws-message-pane" aria-label="WebSocket 消息">
              <div className="ws-message-filter">
                <input
                  aria-label="搜索 WS 消息"
                  placeholder="搜索消息内容"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  aria-label="WS 消息方向"
                  value={direction}
                  onChange={(e) => {
                    setDirection(e.target.value as WsDirection | '');
                    setOffset(0);
                  }}
                >
                  <option value="">双向消息</option>
                  <option value="outbound">App → 服务端</option>
                  <option value="inbound">服务端 → App</option>
                </select>
                <button
                  disabled={busy || !state.messages.total}
                  onClick={() => send('ws.clear', { connectionId })}
                >
                  清空{connectionId ? '当前连接' : '全部'}历史
                </button>
              </div>
              {connection && (
                <div className="ws-connection-summary">
                  <strong>{connection.url ?? connection.endpoint}</strong>
                  <small>
                    {connectionStates[connection.status]} ·{' '}
                    {connection.capture === 'attached' ? '已接入' : '不支持'} · {connection.endpoint}
                  </small>
                  {connection.handshake && (
                    <details>
                      <summary>HTTP 握手信息</summary>
                      <pre>
                        {JSON.stringify(
                          {
                            url: connection.handshake.url,
                            status: connection.handshake.response?.status,
                            requestHeaders: connection.handshake.request.headers,
                            responseHeaders: connection.handshake.response?.headers,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  )}
                </div>
              )}
              <div className="ws-message-list">
                {state.messages.items.map((item) => (
                  <button
                    key={item.id}
                    className={`ws-message-row ${selectedId.current === item.id ? 'selected' : ''}`}
                    aria-label={`${directions[item.direction]} ${outcomes[item.outcome]} ${time(item.timestamp)}`}
                    onClick={() => {
                      selectedId.current = item.id;
                      setDetail(undefined);
                      send('ws.select', { id: item.id });
                    }}
                  >
                    <span className="ws-message-meta">
                      <time>{time(item.timestamp)}</time>
                      <span className={`ws-direction ${item.direction}`}>{directions[item.direction]}</span>
                      <span className={`ws-outcome ${item.outcome}`}>{outcomes[item.outcome]}</span>
                      <span>
                        {item.bytes} B{item.kind === 'binary' ? ' · 二进制' : ''}
                        {item.truncated ? ' · 已截断' : ''}
                      </span>
                    </span>
                    <code>{item.preview || '（空消息）'}</code>
                  </button>
                ))}
                {!state.messages.items.length && (
                  <div className="ws-empty">
                    <h3>等待下一条消息</h3>
                    <p>
                      {search || direction || connectionId
                        ? '当前筛选下没有记录，可调整筛选或在 App 中触发消息。'
                        : '开启采集后，收发消息会出现在这里。'}
                    </p>
                  </div>
                )}
              </div>
              <div className="ws-pagination">
                <span>
                  {state.messages.total
                    ? `${Math.min(offset + 1, state.messages.total)}–${Math.min(offset + PAGE_SIZE, state.messages.total)} / ${state.messages.total}`
                    : '0 条消息'}
                </span>
                <button
                  disabled={offset === 0 || busy}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  上一页
                </button>
                <button
                  disabled={offset + PAGE_SIZE >= state.messages.total || busy}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  下一页
                </button>
              </div>
            </section>
          </div>
          <div className="ws-lower-grid">
            <section className="card ws-detail" aria-label="WS 消息详情">
              <div className="ws-section-heading">
                <h3>消息详情</h3>
                {detail && <span className={`ws-outcome ${detail.outcome}`}>{outcomes[detail.outcome]}</span>}
              </div>
              {detail ? (
                <>
                  <p>
                    {directions[detail.direction]} ·{' '}
                    {new Date(detail.timestamp).toLocaleString('zh-CN', { hour12: false })} · {detail.bytes} B
                  </p>
                  <small className="ws-id">
                    连接 {detail.connectionId}
                    {detail.ruleId
                      ? ` · 命中规则 ${state.rules.find((r) => r.id === detail.ruleId)?.name ?? detail.ruleId}`
                      : ''}
                  </small>
                  {detail.truncated && (
                    <div className="notice">消息超过记录上限，已截断；只读展示，业务消息保持完整。</div>
                  )}
                  {detail.outcome === 'synthetic' && (
                    <div className="notice">模拟消息只进入 App 接收链路，未发送给真实服务器。</div>
                  )}
                  <Content
                    key={`${detail.id}:original`}
                    label={detail.outcome === 'synthetic' ? '模拟内容' : '原始内容'}
                    value={detail.original}
                    binary={detail.encoding === 'base64'}
                  />
                  {detail.outcome === 'replaced' && (
                    <Content
                      key={`${detail.id}:effective`}
                      label="生效内容"
                      value={detail.effective ?? ''}
                      binary={detail.encoding === 'base64'}
                    />
                  )}
                  {detail.outcome === 'dropped' && (
                    <p className="ws-dropped-hint">这条消息已丢弃，未交给接收方。</p>
                  )}
                </>
              ) : (
                <p className="ws-empty">选择一条消息，查看原始内容和处理结果。</p>
              )}
            </section>
            <section className="card ws-push" aria-label="模拟服务端推送">
              <div className="ws-section-heading">
                <h3>模拟服务端推送</h3>
                <span className="tag">仅进入 App</span>
              </div>
              <p>
                {connection
                  ? `目标：${connection.url ?? connection.endpoint}`
                  : '先选择一个已接入的在线业务连接。'}
              </p>
              <textarea
                aria-label="模拟推送内容"
                placeholder={'输入文本或 JSON，例如 {"type":"update","value":123}'}
                value={pushText}
                disabled={busy || !canPush}
                onChange={(e) => {
                  setPushText(e.target.value);
                  setPushError('');
                }}
              />
              <small>手动注入一条消息，不经过自动修改规则，不发送给真实服务器。</small>
              {pushError && <div role="alert">{pushError}</div>}
              <div className="ws-inline-actions">
                <button
                  className="primary"
                  disabled={busy || !canPush}
                  onClick={() => {
                    if (byteSize(pushText) > 256 * 1024) {
                      setPushError('推送内容不能超过 256 KiB');
                      return;
                    }
                    send('ws.push', { connectionId, text: pushText });
                  }}
                >
                  推送到 App
                </button>
                <button disabled={!connection || busy} onClick={newRule}>
                  为此连接新建规则
                </button>
              </div>
              <small>连接已接入且采集开启即可推送。断线后不会自动重发。</small>
            </section>
          </div>
        </>
      ) : (
        <section className="ws-rules">
          <div className="ws-section-heading">
            <div>
              <h3>WS 消息规则</h3>
              <p>按原始文本匹配，执行最高优先级的首条规则；同优先级按列表顺序。</p>
            </div>
            <div className="ws-inline-actions">
              <button onClick={() => send('ws.rules.open')}>打开 WS 规则文件</button>
              <button className="primary" disabled={busy} onClick={newRule}>
                新建 WS 规则
              </button>
            </div>
          </div>
          {!state.mockEnabled && (
            <div className="notice">规则可独立保存；激活所属场景后执行。二进制与控制帧保持直通。</div>
          )}
          {draft && (
            <RuleEditor
              key={draft.id}
              rule={draft}
              scenes={scenes}
              sceneId={sceneId}
              connections={state.connections}
              busy={busy}
              save={(rule, targetSceneId) => {
                pendingRule.current = rule;
                send('ws.rules.save', { rule, targetSceneId });
              }}
              cancel={() => {
                pendingRule.current = undefined;
                setDraft(undefined);
                onDraftClosed?.();
              }}
            />
          )}
          {!state.rules.length && !draft && (
            <div className="card ws-empty">
              <h3>为双向消息准备测试场景</h3>
              <p>按连接 URL、消息方向和包含文本，替换整条消息或将其丢弃。</p>
            </div>
          )}
          {sortedRules.map((rule, index) => (
            <article className="card ws-rule" key={rule.id}>
              <div className="ws-rule-header">
                <button
                  role="switch"
                  aria-label={`启用 WS 规则 ${rule.name}`}
                  aria-checked={rule.enabled}
                  title={rule.enabled ? '点击停用' : '点击启用'}
                  className={`ws-rule-switch ${rule.enabled ? 'on' : ''}`}
                  disabled={busy}
                  onClick={() => send('ws.rules.toggle', { id: rule.id })}
                >
                  <span className="ws-switch-track">
                    <span />
                  </span>
                </button>
                <h3>{rule.name}</h3>
                <span className="tag">{rule.action.type === 'drop' ? '丢弃' : '整条替换'}</span>
                {rule.match.connectionId && <span className="tag">本次连接 · 临时</span>}
                <span className="ws-priority">优先级 {rule.priority}</span>
              </div>
              <code>
                {rule.match.url ??
                  state.connections.find((c) => c.id === rule.match.connectionId)?.endpoint ??
                  rule.match.connectionId}
              </code>
              <p>
                {rule.match.direction ? directions[rule.match.direction] : '双向消息'} ·{' '}
                {rule.match.contains ? `包含「${rule.match.contains}」` : '匹配全部文本消息'}
              </p>
              <div className="ws-rule-actions">
                <button disabled={busy} onClick={() => setDraft(JSON.parse(JSON.stringify(rule)))}>
                  编辑
                </button>
                <button disabled={busy} onClick={() => send('ws.rules.duplicate', { id: rule.id })}>
                  复制
                </button>
                <button
                  aria-label={`上移 WS 规则 ${rule.name}`}
                  disabled={busy || index === 0}
                  onClick={() => send('ws.rules.move', { id: rule.id, delta: -1 })}
                >
                  ↑
                </button>
                <button
                  aria-label={`下移 WS 规则 ${rule.name}`}
                  disabled={busy || index === state.rules.length - 1}
                  onClick={() => send('ws.rules.move', { id: rule.id, delta: 1 })}
                >
                  ↓
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => send('ws.rules.delete', { id: rule.id })}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function RuleEditor({
  rule,
  connections,
  busy,
  save,
  cancel,
  scenes = [],
  sceneId,
}: {
  scenes?: Scene[];
  sceneId?: string;
  rule: WsRule;
  connections: WsConnection[];
  busy: boolean;
  save: (rule: WsRule, targetSceneId?: string) => void;
  cancel: () => void;
}) {
  const [name, setName] = useState(rule.name);
  const [targetSceneId, setTargetSceneId] = useState(sceneId);
  const existingRule = scenes.some((scene) => scene.wsRules.some((item) => item.id === rule.id));
  const [priority, setPriority] = useState(String(rule.priority));
  const [scope, setScope] = useState(rule.match.connectionId ? 'connection' : 'url');
  const [url, setUrl] = useState(rule.match.url ?? '');
  const [connectionId, setConnectionId] = useState(
    rule.match.connectionId ??
      connections.find((c) => c.status === 'open' && c.capture === 'attached')?.id ??
      '',
  );
  const [direction, setDirection] = useState(rule.match.direction ?? '');
  const [contains, setContains] = useState(rule.match.contains ?? '');
  const [action, setAction] = useState(rule.action.type);
  const [text, setText] = useState(rule.action.text ?? '');
  const [error, setError] = useState('');
  const available = connections.filter((c) => c.status === 'open' && c.capture === 'attached');
  return (
    <form
      className="card ws-rule-editor"
      aria-label="WS 规则编辑"
      onChange={() => setError('')}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) {
          setError('规则名称不能为空');
          return;
        }
        if (!Number.isSafeInteger(Number(priority))) {
          setError('优先级必须是整数');
          return;
        }
        if (scope === 'url' && url !== '*' && !/^wss?:\/\/\S+$/.test(url)) {
          setError('请输入完整 ws:// 或 wss:// URL，可使用 * 通配符');
          return;
        }
        if (scope === 'connection' && !available.some((c) => c.id === connectionId)) {
          setError('请选择已接入的在线连接');
          return;
        }
        if (action === 'replace' && byteSize(text) > 256 * 1024) {
          setError('替换文本不能超过 256 KiB');
          return;
        }
        save(
          {
            ...rule,
            name: name.trim(),
            priority: Number(priority),
            match: {
              ...(scope === 'url' ? { url } : { connectionId }),
              ...(direction ? { direction: direction as WsDirection } : {}),
              ...(contains ? { contains } : {}),
            },
            action: action === 'drop' ? { type: 'drop' } : { type: 'replace', text },
          },
          targetSceneId,
        );
      }}
    >
      <div className="ws-section-heading">
        <h3>{rule.name ? '编辑 WS 规则' : '新建 WS 规则'}</h3>
        <button type="button" onClick={cancel}>
          取消编辑
        </button>
      </div>
      <div className="ws-form-grid">
        {!existingRule && scenes.length > 0 && (
          <label>
            目标场景
            <select
              aria-label="WS 保存到场景"
              value={targetSceneId ?? ''}
              onChange={(event) => setTargetSceneId(event.target.value)}
            >
              {scenes.map((scene) => (
                <option key={scene.id} value={scene.id}>
                  {scene.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          规则名称
          <input aria-label="WS 规则名称" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          优先级
          <input
            aria-label="WS 规则优先级"
            type="number"
            step="1"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </label>
        <label>
          匹配范围
          <select aria-label="WS 匹配范围" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="url">连接 URL · 持久规则</option>
            <option value="connection">本次连接 · 临时规则</option>
          </select>
        </label>
        {scope === 'url' ? (
          <label>
            连接 URL 通配模式
            <input
              aria-label="WS 连接 URL"
              placeholder="wss://example.test/socket*"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
        ) : (
          <label>
            当前连接
            <select
              aria-label="WS 临时连接"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              <option value="">请选择在线连接</option>
              {available.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.url ?? c.endpoint}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          消息方向
          <select
            aria-label="WS 规则方向"
            value={direction}
            onChange={(e) => setDirection(e.target.value as WsDirection | '')}
          >
            <option value="">双向消息</option>
            <option value="outbound">App → 服务端</option>
            <option value="inbound">服务端 → App</option>
          </select>
        </label>
        <label>
          包含文本（可选）
          <input
            aria-label="WS 包含文本"
            value={contains}
            onChange={(e) => setContains(e.target.value)}
            placeholder="留空匹配全部文本消息"
          />
        </label>
        <label>
          动作
          <select
            aria-label="WS 规则动作"
            value={action}
            onChange={(e) => setAction(e.target.value as 'replace' | 'drop')}
          >
            <option value="replace">整条替换</option>
            <option value="drop">丢弃消息</option>
          </select>
        </label>
      </div>
      {scope === 'connection' && (
        <p>临时规则只适用于本次连接，不写入项目规则文件；连接重建后不会自动沿用。</p>
      )}
      {action === 'replace' && (
        <label>
          替换文本 / JSON
          <textarea aria-label="WS 替换文本" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      <div className="ws-inline-actions">
        <button type="submit" className="primary" disabled={busy}>
          保存 WS 规则
        </button>
        <button type="button" onClick={cancel}>
          取消
        </button>
      </div>
    </form>
  );
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  HistoryEntry,
  HistoryQuery,
  PendingBreakpoint,
  RequestSnapshot,
  ResponseSnapshot,
  Rule,
  WorkbenchState,
  validateRuleDocument,
  headerChanges,
} from '../src/model';
import './style.css';
import { inspectJson } from './body';
import { WebSocketPanel } from './websocket';
import { McpPanel } from './mcp';

declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage: (message: unknown) => void;
      getState?: () => { catalogCollapsed?: boolean } | undefined;
      setState?: (state: { catalogCollapsed?: boolean }) => void;
    };
    __FLUTTER_PILOT_TEST__?: boolean;
  }
}
const vscode = window.acquireVsCodeApi?.();
let viewPreferences = vscode?.getState?.() ?? {};
function send(action: string, payload: unknown = {}) {
  vscode?.postMessage({ action, payload });
}
const settingsHref = `command:workbench.action.openSettings?${encodeURIComponent(JSON.stringify(['@ext:flutter-pilot.flutter-pilot']))}`;
const initial: WorkbenchState = {
  mode: 'vm',
  rules: [],
  history: { items: [], total: 0 },
  pending: [],
  engine: { status: 'stopped' },
  proxyActive: false,
  lan: false,
  addresses: [{ label: '本机', host: '127.0.0.1' }],
  devices: [],
  connectionHost: '127.0.0.1',
  workspace: '',
  logs: [],
  busy: false,
};
type Tab = 'history' | 'rules' | 'breakpoints' | 'connection' | 'websocket' | 'mcp';
type Snapshot = RequestSnapshot | ResponseSnapshot;
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    radar: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1" />
        <path d="m12 12 6-6" />
      </>
    ),
    history: (
      <>
        <path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    rules: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    plug: (
      <>
        <path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="m9 5 7 7-7 7" />,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    external: (
      <>
        <path d="M14 3h7v7m0-7L11 13M10 4H4v16h16v-6" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    box: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9" />
      </>
    ),
    arrowRight: <path d="M4 12h16m-6-6 6 6-6 6" />,
    sidebar: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.box}
    </svg>
  );
}
function Button({
  children,
  action,
  onClick,
  primary = false,
  danger = false,
  disabled = false,
  title,
  className = '',
}: {
  children: React.ReactNode;
  action?: string;
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      className={`${primary ? 'primary' : ''} ${danger ? 'danger' : ''} ${className}`}
      onClick={onClick ?? (() => action && send(action))}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
function Empty({
  icon = 'box',
  title,
  description,
  children,
}: {
  icon?: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={30} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
function Method({ method }: { method: string }) {
  return <span className={`method method-${method.toLowerCase()}`}>{method}</span>;
}
function BodyEditor({
  value,
  onChange,
  label = '正文',
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const [error, setError] = useState('');
  return (
    <div className="code-editor">
      <div className="code-toolbar">
        <span>{label}</span>
        <button
          disabled={disabled}
          type="button"
          onClick={() => {
            try {
              onChange(JSON.stringify(JSON.parse(value), null, 2));
              setError('');
            } catch {
              setError('当前内容不是有效 JSON，也可作为纯文本保存');
            }
          }}
        >
          格式化 JSON
        </button>
      </div>
      <textarea
        aria-label={label}
        spellCheck={false}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setError('');
        }}
        disabled={disabled}
      />
      {error && <div className="field-hint">{error}</div>}
    </div>
  );
}
function SnapshotView({ snapshot, label }: { snapshot?: Snapshot; label: string }) {
  const [mode, setMode] = useState<'json' | 'raw'>('json');
  const [copyState, setCopyState] = useState('');
  const json = useMemo(
    () => (snapshot?.bodyEncoding === 'text' ? inspectJson(snapshot.body) : {}),
    [snapshot?.body, snapshot?.bodyEncoding],
  );
  useEffect(() => {
    setMode('json');
    setCopyState('');
  }, [snapshot]);
  if (!snapshot)
    return (
      <section aria-label={label} className="snapshot empty-snapshot">
        <strong>{label} · 无响应数据</strong>
        <p>未收到 HTTP 响应，或请求已终止。可查看上方错误信息与耗时。</p>
      </section>
    );
  const head = 'status' in snapshot ? `HTTP ${snapshot.status}` : `${snapshot.method} ${snapshot.url}`;
  const formatted = mode === 'json' && json.formatted !== undefined;
  const displayBody = formatted ? json.formatted! : snapshot.body;
  async function copyBody() {
    try {
      await navigator.clipboard.writeText(displayBody);
      setCopyState('已复制');
    } catch {
      setCopyState('复制失败，请选中正文复制');
    }
  }
  return (
    <section className="snapshot" aria-label={label}>
      <div className="section-caption">{label}</div>
      <pre className="request-line">{head}</pre>
      <details className="snapshot-headers">
        <summary>
          Headers <span className="count">{snapshot.headers.length}</span>
        </summary>
        <pre>{snapshot.headers.map(([k, v]) => `${k}: ${v}`).join('\n') || '无'}</pre>
      </details>
      {(!snapshot.editable || snapshot.truncated) && (
        <div className="notice">
          {snapshot.limitation ??
            (snapshot.truncated ? '正文超出保存上限，已截断' : '该正文仅查看，不支持编辑')}
        </div>
      )}
      <div className="body-toolbar">
        <div className="body-caption">
          <strong>{snapshot.bodyEncoding === 'base64' ? '二进制 · Base64' : 'Body'}</strong>
          <span>{snapshot.bodyBytes?.toLocaleString() ?? 0} bytes</span>
          {snapshot.truncated && <span className="tag warm">已截断</span>}
        </div>
        <div className="body-tools">
          {snapshot.bodyEncoding === 'text' && snapshot.body.trim() && (
            <div className="view-toggle" aria-label={`${label}正文格式`}>
              <button
                aria-pressed={formatted}
                disabled={json.formatted === undefined}
                title={json.hint ?? '尝试解析并格式化 JSON，保留原始数字精度'}
                onClick={() => setMode('json')}
              >
                JSON
              </button>
              <button aria-pressed={!formatted} onClick={() => setMode('raw')}>
                原文
              </button>
            </div>
          )}
          <button disabled={!snapshot.body} onClick={() => void copyBody()}>
            复制正文
          </button>
        </div>
      </div>
      {json.hint && <p className="field-hint">{json.hint}</p>}
      {copyState && (
        <span role="status" className="field-hint">
          {copyState}
        </span>
      )}
      <pre
        className={`body-content ${formatted ? 'json-content' : ''}`}
        tabIndex={0}
        aria-label={`${label}正文`}
      >
        {displayBody || '（空正文）'}
      </pre>
    </section>
  );
}
function App() {
  const [state, setState] = useState(initial);
  const [tab, setTab] = useState<Tab>('connection');
  const [selected, setSelected] = useState<HistoryEntry>();
  const [edit, setEdit] = useState<Rule>();
  const [preview, setPreview] = useState<{
    id: string;
    files: { path: string; before: string | null; after: string }[];
    manualSnippet?: string;
  }>();
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const m = event.data;
      if (m.type === 'state') {
        setState(m.state);
        if ('selected' in m) setSelected(m.selected ?? undefined);
        if ('preview' in m) setPreview(m.preview ?? undefined);
      }
      if (m.type === 'editRule') {
        setEdit(m.rule);
        setTab('rules');
      }
    };
    window.addEventListener('message', listener);
    send('ready');
    return () => window.removeEventListener('message', listener);
  }, []);
  const nav: { id: Tab; label: string; icon: string; count?: number }[] = [
    { id: 'connection', label: '连接与诊断', icon: 'plug' },
    { id: 'history', label: 'API 与历史', icon: 'history', count: state.history.total },
    { id: 'websocket', label: 'WebSocket', icon: 'radar', count: state.ws?.messages.total ?? 0 },
    { id: 'rules', label: 'Mock 规则', icon: 'rules', count: state.rules.length },
    { id: 'breakpoints', label: '断点队列', icon: 'pause', count: state.pending.length },
    { id: 'mcp', label: 'MCP', icon: 'plug' },
  ];
  const enabled = state.rules.filter((r) => r.enabled).length;
  const vmMode = state.mode !== 'proxy';
  const running = vmMode ? state.vm?.status === 'connected' : state.proxyActive;
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <Icon name="radar" size={18} />
          <div>
            <h1>Flutter Pilot</h1>
          </div>
        </div>
        <span className="header-project" title={state.workspace}>
          {state.project?.name || state.workspace.split('/').filter(Boolean).at(-1) || '当前工作区'}
        </span>
        <div className="header-actions">
          <span className={`status-pill ${running ? 'online' : ''}`}>
            <i />
            {vmMode
              ? running
                ? 'VM 记录中'
                : state.vm?.status === 'connecting'
                  ? 'VM 连接中'
                  : 'VM 未连接'
              : state.engine.status === 'starting'
                ? '引擎启动中'
                : running
                  ? '自动记录中'
                  : state.engine.status === 'running'
                    ? '引擎已就绪'
                    : '代理未启动'}
          </span>
          <details className="workspace-menu">
            <summary>工作区与连接</summary>
            <div className="workspace-menu-panel">
              <strong>
                {state.project?.name || state.workspace.split('/').filter(Boolean).at(-1) || '当前工作区'}
              </strong>
              <span className="mono">
                {vmMode
                  ? `VM · ${running ? (state.vm?.endpoint ?? '已连接') : state.vm?.status === 'connecting' ? '连接中' : '未连接'}`
                  : `${state.connectionHost}:${state.engine.proxyPort ?? 8080}`}
              </span>
              <span>
                {enabled} 条规则启用 · {state.pending.length} 个等待断点
              </span>
              <Button
                action={vmMode ? (running ? 'vm.disconnect' : undefined) : running ? 'stop' : 'start'}
                onClick={vmMode && !running ? () => setTab('connection') : undefined}
                primary={!running}
                disabled={state.busy || (vmMode && state.vm?.status === 'connecting')}
              >
                <Icon name={running ? 'stop' : 'play'} size={14} />
                {vmMode
                  ? running
                    ? '断开 VM'
                    : state.vm?.status === 'connecting'
                      ? '连接中…'
                      : '连接 VM'
                  : running
                    ? '停止代理'
                    : '启动代理'}
              </Button>
              <span>{running ? '后台记录中 · 关闭工作台继续记录' : '本地存储 · 仅用于开发调试'}</span>
              <a className="button-link" href={settingsHref}>
                设置 <Icon name="external" size={12} />
              </a>
            </div>
          </details>
        </div>
      </header>
      <nav className="nav-tabs">
        {nav.map((n) => (
          <button key={n.id} className={tab === n.id ? 'active' : ''} onClick={() => setTab(n.id)}>
            <Icon name={n.icon} size={16} />
            {n.label}
            {n.count !== undefined && (
              <span className={`count ${n.id === 'breakpoints' && n.count ? 'accent' : ''}`}>{n.count}</span>
            )}
          </button>
        ))}
      </nav>
      {state.lastError && (
        <div className="error-banner" role="alert">
          <span>{state.lastError}</span>
          <button onClick={() => send('error.dismiss')} aria-label="关闭错误">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {state.ruleSyncError && (
        <details className="global-notice">
          <summary title={state.ruleSyncError}>规则状态 · {state.ruleSyncError}</summary>
          <div className="notice">{state.ruleSyncError}</div>
        </details>
      )}
      <main>
        {tab === 'connection' && (
          <>
            <Connection state={state} preview={preview} />
            {state.project && (
              <section className="project-binding" aria-label="当前绑定项目">
                <details className="compact-disclosure">
                  <summary>项目配置与规则文件</summary>
                  <div className="project-binding-heading">
                    <strong>{state.project.name}</strong>
                    <span className="tag">当前项目</span>
                    <div className="card-actions">
                      <Button onClick={() => send('project.open', { kind: 'config' })} disabled={state.busy}>
                        项目配置
                      </Button>
                      <Button onClick={() => send('project.open', { kind: 'rules' })} disabled={state.busy}>
                        规则文件
                      </Button>
                      <Button action="project.reload" disabled={state.busy}>
                        读取项目文件
                      </Button>
                    </div>
                  </div>
                  <code className="project-uuid" title={state.project.id}>
                    UUID · {state.project.id}
                  </code>
                </details>
                {state.project.notice && <small role="status">{state.project.notice}</small>}
              </section>
            )}
          </>
        )}
        {tab === 'mcp' && <McpPanel state={state} send={send} />}
        {tab === 'history' && <History key={state.mode ?? 'vm'} state={state} selected={selected} />}
        {tab === 'websocket' && (
          <WebSocketPanel
            state={state.ws}
            connected={state.vm?.status === 'connected'}
            vmMode={vmMode}
            busy={state.busy}
            send={send}
          />
        )}
        {tab === 'rules' && <Rules state={state} edit={edit} setEdit={setEdit} />}
        {tab === 'breakpoints' && (
          <>
            {vmMode && (
              <details className="compact-disclosure breakpoint-help">
                <summary>VM 模式 · 手动断点需使用代理</summary>
                <p>
                  VM 模式暂不支持手动断点。自动 Mock 和双向修改请开启实验性 Dio
                  Mock；手动暂停请使用代理模式。工作台关闭后自动跳过人工暂停，继续后台记录和自动规则。
                </p>
              </details>
            )}
            <Breakpoints pending={state.pending} />
          </>
        )}
      </main>
    </div>
  );
}
function ConnectionMode({ state }: { state: WorkbenchState }) {
  return (
    <div className="connection-modes" aria-label="接入方式">
      <button
        aria-pressed={state.mode !== 'proxy'}
        disabled={state.busy}
        onClick={() => send('connection.mode', { mode: 'vm' })}
      >
        <Icon name="plug" />
        VM 连接 <span className="tag">推荐 · 无需证书</span>
      </button>
      <button
        aria-pressed={state.mode === 'proxy'}
        disabled={state.busy}
        onClick={() => send('connection.mode', { mode: 'proxy' })}
      >
        <Icon name="radar" />
        代理连接 <span className="tag">备用方案</span>
      </button>
    </div>
  );
}
function VmDiscovery({ state }: { state: WorkbenchState }) {
  const discovery = state.vmDiscovery;
  if (!discovery) return null;
  const active = state.vm?.status === 'connected' || state.vm?.status === 'connecting';
  const statusLabels = {
    available: '可连接',
    connecting: '连接中',
    connected: '已连接',
    paused: '已暂停自动连接',
    failed: '连接失败',
  };
  return (
    <section className="vm-discovery" aria-label="已发现的 Flutter 调试会话">
      <div className="vm-discovery-heading">
        <strong>自动发现调试会话</strong>
        <span className="tag">{discovery.enabled ? '自动连接已开启' : '自动连接已关闭'}</span>
      </div>
      <p className="muted">
        {discovery.enabled
          ? '当前项目只有一个可用会话时自动连接；多个会话请选择。'
          : '可选择已发现的会话连接，或在项目配置 / IDE 设置中开启 autoConnectVm。'}
        Dio Mock、WS 采集与 WS Mock 仍需手动开启。
      </p>
      {discovery.message && (
        <div className="notice" role="status">
          {discovery.message}
        </div>
      )}
      {discovery.candidates.length ? (
        <ul className="vm-discovery-list">
          {discovery.candidates.map((candidate) => (
            <li key={candidate.id} className="vm-discovery-candidate">
              <div className="vm-discovery-info">
                <strong>{candidate.name}</strong>
                <span className="muted">
                  {candidate.device ? `${candidate.device} · ` : ''}
                  {candidate.source === 'dtd' ? '已有调试会话' : '调试事件'} · {candidate.endpoint}
                </span>
                <span className={`small-status ${candidate.status === 'connected' ? 'online' : ''}`}>
                  {statusLabels[candidate.status]}
                </span>
                {candidate.error && (
                  <span className="vm-discovery-error" role="alert">
                    {candidate.error}
                  </span>
                )}
              </div>
              <button
                disabled={
                  state.busy ||
                  active ||
                  candidate.status === 'connecting' ||
                  candidate.status === 'connected'
                }
                aria-label={`${candidate.status === 'failed' ? '重试连接' : candidate.status === 'paused' ? '重新连接' : '连接'} ${candidate.name}`}
                onClick={() => send('vm.discovery.connect', { id: candidate.id })}
              >
                {candidate.status === 'connected'
                  ? '已连接'
                  : candidate.status === 'connecting'
                    ? '连接中'
                    : candidate.status === 'failed'
                      ? '重试连接'
                      : candidate.status === 'paused'
                        ? '重新连接'
                        : '连接此会话'}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          {discovery.status === 'unavailable'
            ? '已有调试会话暂时无法补查，可重新启动 Flutter 调试，或手动填写本次 VM 地址。'
            : '等待当前项目的 Flutter Debug 调试会话。'}
        </p>
      )}
    </section>
  );
}
function VmConnection({ state }: { state: WorkbenchState }) {
  const [url, setUrl] = useState('');
  const vm = state.vm;
  const connected = vm?.status === 'connected';
  const connecting = vm?.status === 'connecting';
  return (
    <>
      <section className="card vm-card">
        <div className="card-heading">
          <span className="step">01</span>
          <h3>连接 Dart VM Service</h3>
          <span className={`small-status ${connected ? 'online' : ''}`}>
            {connected ? '已连接' : connecting ? '连接中' : '未连接'}
          </span>
        </div>
        {connected && (
          <div className="vm-active-connection" role="status" aria-label="VM 已连接">
            <Icon name="plug" size={18} />
            <strong>已连接 · {vm.endpoint ?? 'Dart VM Service'}</strong>
            <span>后台记录中</span>
            <Button action="vm.disconnect" disabled={state.busy}>
              断开连接
            </Button>
          </div>
        )}
        <details className="compact-disclosure" open={!connected}>
          <summary>调试会话与手动地址</summary>
          <VmDiscovery state={state} />
          <label>
            VM WebSocket 地址
            <input
              aria-label="VM WebSocket 地址"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={connected ? '已连接，断开后可输入新的地址' : 'ws://127.0.0.1:端口/认证路径/ws'}
              value={url}
              disabled={state.busy || connected || connecting}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          {!connected && (
            <div className="card-actions">
              <Button
                primary
                disabled={state.busy || connecting || !url.trim()}
                onClick={() => {
                  send('vm.connect', { url: url.trim() });
                  setUrl('');
                }}
              >
                {connecting ? '连接中…' : '连接并记录'}
              </Button>
            </div>
          )}
          <small className="muted">
            使用原 Flutter Debug 启动项运行或附加应用，无需修改代码、安装 CA
            或启动代理。地址含调试凭证，仅用于本次连接；端口变化后请重新连接。
          </small>
        </details>
        <div className="vm-statistics">
          <span>
            <b>{vm?.isolates ?? 0}</b> 个可采集 Isolate
          </span>
          <span>
            <b>{vm?.recorded ?? 0}</b> 条本会话记录
          </span>
          <span>
            <b>{vm?.instances ?? 0}</b> 个已接入 Dio
          </span>
        </div>
        {vm?.error && (
          <div className="notice" role="alert">
            {vm.error}
          </div>
        )}
      </section>
      <section className="card vm-card vm-mock-card" aria-labelledby="dio-mock-title">
        <div className="card-heading">
          <h3 id="dio-mock-title">
            Dio Mock <span className="tag warm">实验性</span>
          </h3>
          <button
            type="button"
            className="rule-switch"
            role="switch"
            aria-label="开启运行时 Dio Mock"
            aria-checked={vm?.mockEnabled ?? false}
            aria-describedby="dio-mock-description"
            title={!connected ? '请先连接 VM' : vm?.mockEnabled ? '关闭 Dio Mock' : '开启 Dio Mock'}
            disabled={state.busy || !connected}
            onClick={() => send('vm.mock', { enabled: !vm?.mockEnabled })}
          >
            <span className="rule-switch-track" aria-hidden="true">
              <span className="rule-switch-thumb" />
            </span>
          </button>
        </div>
        <p id="dio-mock-description">开启后执行已启用的 Mock 规则，关闭后恢复仅采集。需先连接 VM。</p>
        {vm?.mockEnabled && (
          <div className="card-actions">
            <Button action="vm.rescan" disabled={state.busy || !connected}>
              重新发现并同步
            </Button>
          </div>
        )}
      </section>
      {state.proxyActive && (
        <div className="notice">
          旧代理仍在运行。要验证纯 VM 接入，请先用不含 FLUTTER_PILOT_PROXY 的原启动项重新运行
          App，再停止旧代理。 规则共用，保存改动也会同步到仍在运行的代理；关闭运行时 Dio Mock 只移除 VM
          拦截器。
          <div className="card-actions">
            <Button action="proxy.stop">停止旧代理</Button>
          </div>
        </div>
      )}
      {vm?.warnings.map((warning) => (
        <div className="notice" key={warning}>
          {warning}
        </div>
      ))}
      <details className="compact-disclosure">
        <summary>VM 采集范围与使用说明</summary>
        <p>
          VM 与代理历史分开保存，规则共用。VM 内置采集覆盖受支持的 dart:io HTTP
          请求；原生插件、WebView、自定义网络适配器和 Release 不在覆盖承诺内。Mock 在 Dio
          数据层执行，其他拦截器仍可能继续处理结果。
        </p>
      </details>
    </>
  );
}
function Connection({
  state,
  preview,
}: {
  state: WorkbenchState;
  preview?: { id: string; files: { path: string }[]; manualSnippet?: string };
}) {
  const inspection = state.setup as
    | {
        supported: boolean;
        dioVersion?: string;
        diagnostics: string[];
        candidates: { id: string; file: string; variable: string; automatic: boolean; reason?: string }[];
      }
    | undefined;
  const port = state.engine.proxyPort ?? 8080;
  const command = `flutter run --dart-define=FLUTTER_PILOT_PROXY=${state.connectionHost}:${port}`;
  if (state.mode !== 'proxy')
    return (
      <div className="connection-page">
        <div className="page-title">
          <div>
            <h2>连接与诊断</h2>
          </div>
        </div>
        <ConnectionMode state={state} />
        <VmConnection state={state} />
      </div>
    );
  return (
    <div className="connection-page">
      <div className="page-title">
        <div>
          <h2>连接与诊断</h2>
        </div>
        <span className="platform-badge">macOS · Android / iOS</span>
      </div>
      <ConnectionMode state={state} />
      <div className="setup-grid">
        <section className="card engine-card">
          <div className="card-heading">
            <span className="step">01</span>
            <h3>准备代理引擎</h3>
            <span className={`small-status ${state.engine.status === 'running' ? 'online' : ''}`}>
              {state.engine.status === 'running' ? '已就绪' : '待初始化'}
            </span>
          </div>
          <p>插件管理 mitmproxy，提供 HTTPS 解密、请求修改和本地 Mock，无需安装 Python。</p>
          <div className="engine-meta">
            <span>流量监听地址</span>
            <code>
              {state.lan ? '0.0.0.0' : '127.0.0.1'}:{port}
            </code>
          </div>
          <label className="switch-row">
            <span>
              <strong>允许局域网真机连接</strong>
              <small>iOS 真机等 Wi-Fi 设备需开启，并选择电脑的局域网 IP</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={state.lan}
              disabled={state.busy}
              onChange={(e) => send('setLan', { enabled: e.target.checked })}
            />
          </label>
          <div className="card-actions">
            <Button action="install" primary disabled={state.busy}>
              <Icon name="box" size={15} />
              {state.engine.status === 'running' ? '检查引擎' : '安装 / 初始化引擎'}
            </Button>
            <a className="button-link" href={settingsHref}>
              选择本地引擎
            </a>
          </div>
        </section>
        <section className="card">
          <div className="card-heading">
            <span className="step">02</span>
            <h3>选择调试设备</h3>
            <button className="text-button" disabled={state.busy} onClick={() => send('devices')}>
              刷新设备
            </button>
          </div>
          <p>Android 推荐 USB 连接；iOS 模拟器使用本机地址，真机使用同一局域网。</p>
          <label>
            设备可访问的电脑地址
            <select
              value={state.connectionHost}
              disabled={!state.lan}
              onChange={(e) => send('selectHost', { host: e.target.value })}
            >
              {state.addresses.map((a) => (
                <option key={a.host} value={a.host}>
                  {a.host} · {a.label}
                </option>
              ))}
            </select>
          </label>
          <div className="device-list">
            {state.devices.length ? (
              state.devices.map((d) => (
                <div className="device-row" key={String(d.id)}>
                  <div className="device-icon">
                    <Icon name="plug" />
                  </div>
                  <div>
                    <strong>{String(d.name)}</strong>
                    <small>
                      {String(d.platform)} · {String(d.kind)} · {String(d.state)}
                    </small>
                  </div>
                  {d.platform === 'android' && (
                    <Button
                      onClick={() => send('connectAndroid', { id: d.id })}
                      disabled={state.busy || !state.proxyActive || d.state !== 'device'}
                    >
                      连接 USB
                    </Button>
                  )}
                </div>
              ))
            ) : (
              <div className="subtle-empty">点击“刷新设备”检测 USB 手机和 iOS 模拟器</div>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-heading">
            <span className="step">03</span>
            <h3>信任 HTTPS 证书</h3>
            <span className="tag">开发环境</span>
          </div>
          <p>设备系统代理需要安装并信任调试 CA。若 Dio 不使用系统信任库，使用右侧辅助代码接入。</p>
          <div className="instruction">
            <strong>Android</strong>
            <span>
              Wi-Fi 代理填写电脑 IP 和代理端口，安装 CA 后验证应用是否信任用户证书。USB 辅助接入使用
              127.0.0.1。
            </span>
          </div>
          <div className="instruction">
            <strong>iOS</strong>
            <span>
              Wi-Fi HTTP 代理设为手动，安装 CA 描述文件，并在“关于本机 → 证书信任设置”中启用完全信任。
            </span>
          </div>
          <div className="card-actions">
            <Button action="ca.open" disabled={state.engine.status !== 'running'}>
              <Icon name="external" size={14} />
              打开 CA 证书位置
            </Button>
          </div>
          <small className="muted">只安装公钥证书；私钥始终保存在插件私有目录。</small>
        </section>
        <section className="card">
          <div className="card-heading">
            <span className="step">04</span>
            <h3>Dio 最小接入</h3>
            <span className="tag">按需使用</span>
          </div>
          <p>检测 Dio 初始化位置，生成仅在 Debug 且显式传参时生效的配置。修改前可逐行审阅。</p>
          <div className="card-actions">
            <Button action="setup.inspect" primary disabled={state.busy}>
              检测 Flutter 项目
            </Button>
            <Button action="setup.revert" disabled={state.busy}>
              撤销接入
            </Button>
          </div>
          {inspection && (
            <div className="inspection">
              <p className={inspection.supported ? 'success-text' : 'warning-text'}>
                {inspection.dioVersion ? `Dio ${inspection.dioVersion}` : '未检测到受支持的 Dio 依赖'}
              </p>
              {inspection.diagnostics.map((d, i) => (
                <small key={i}>{d}</small>
              ))}
              {inspection.candidates.map((c) => (
                <div className="candidate" key={c.id}>
                  <div>
                    <code>{c.variable}</code>
                    <small>{c.file.split('/').slice(-3).join('/')}</small>
                    {c.reason && <small>{c.reason}</small>}
                  </div>
                  <Button
                    onClick={() => send('setup.preview', { id: c.id })}
                    disabled={state.busy || state.engine.status !== 'running'}
                  >
                    {c.automatic ? '预览补丁' : '生成手动片段'}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {preview && (
            <div className="preview-box">
              <strong>接入预览已生成</strong>
              {preview.files.map((f) => (
                <small key={f.path}>{f.path.split('/').at(-1)}</small>
              ))}
              {preview.manualSnippet && <pre>{preview.manualSnippet}</pre>}
              <Button primary onClick={() => send('setup.apply', { id: preview.id })} disabled={state.busy}>
                应用当前预览
              </Button>
            </div>
          )}
        </section>
      </div>
      <section className="card run-card">
        <div>
          <div className="section-caption">运行与验证</div>
          <h3>带调试参数启动应用，再发起一次请求</h3>
          <p>辅助代码接入后，历史列表出现 HTTP 和 HTTPS 请求且无证书错误，才表示链路验证通过。</p>
        </div>
        <pre>{command}</pre>
        <div className="notice">
          不携带参数重启应用即可关闭辅助代理。停止引擎后，系统代理配置需要在设备设置中手动移除。文件上传、二进制和流式正文保持直通。
        </div>
      </section>
      <details className="logs">
        <summary>
          诊断日志 <span className="count">{state.logs.length}</span>
        </summary>
        <pre>{state.logs.join('\n') || '暂无日志'}</pre>
        <Button action="log.clear">清空日志</Button>
      </details>
    </div>
  );
}
function History({ state, selected }: { state: WorkbenchState; selected?: HistoryEntry }) {
  const [query, setQuery] = useState<HistoryQuery>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [group, setGroup] = useState('');
  const [detailTab, setDetailTab] = useState<'request' | 'response' | 'diff' | 'info'>('response');
  const [offset, setOffset] = useState(0);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [catalogCollapsed, setCatalogCollapsed] = useState(viewPreferences.catalogCollapsed ?? false);
  const [detailFocused, setDetailFocused] = useState(false);
  const detailRef = useRef<HTMLElement>(null);
  const [catalogSearch, setCatalogSearch] = useState('');
  useEffect(() => {
    setDetailTab('response');
    if (selected && window.innerWidth <= 600) detailRef.current?.scrollIntoView({ block: 'start' });
  }, [selected?.id]);
  useEffect(() => {
    setNote(selected?.note ?? '');
    setTags(selected?.tags.join(', ') ?? '');
  }, [selected?.id, selected?.note, selected?.tags.join(',')]);
  useEffect(() => {
    if (state.mode !== 'vm' && state.engine.status !== 'running') return;
    const t = setTimeout(() => send('history.query', { ...query, offset }), 250);
    return () => clearTimeout(t);
  }, [query, offset, state.engine.status, state.mode]);
  const groups = useMemo(() => [...(state.apis ?? [])].sort((a, b) => b.lastAt - a.lastAt), [state.apis]);
  const records = useMemo(
    () => [...state.history.items].sort((a, b) => b.startedAt - a.startedAt),
    [state.history.items],
  );
  const visibleGroups = groups.filter((g) =>
    `${g.method} ${g.host}${g.path}`.toLowerCase().includes(catalogSearch.toLowerCase()),
  );
  const catalogKeys = JSON.stringify(groups.map((g) => `${g.method} ${g.host}${g.path}`));
  useEffect(() => {
    if (group && !(JSON.parse(catalogKeys) as string[]).includes(group)) {
      setGroup('');
      setQuery((q) => ({ ...q, host: undefined, path: undefined, method: undefined }));
      setOffset(0);
    }
  }, [group, catalogKeys]);
  function update(p: Partial<HistoryQuery>) {
    setQuery((q) => ({ ...q, ...p }));
    setOffset(0);
  }
  return (
    <div className="history-page">
      <div className="history-toolbar">
        <div className="search-field">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索请求"
            placeholder="搜索 URL、API 或备注…"
            value={query.search ?? ''}
            onChange={(e) => update({ search: e.target.value })}
          />
        </div>
        <select
          aria-label="筛选请求方法"
          value={query.method ?? ''}
          onChange={(e) => update({ method: e.target.value || undefined })}
        >
          <option value="">所有方法</option>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button
          aria-expanded={filtersOpen}
          aria-controls="history-filters"
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <Icon name="rules" size={14} />
          筛选
          {[query.status, query.mocked, query.ruleId, query.from, query.to].filter((v) => v !== undefined)
            .length > 0 && (
            <span className="count accent">
              {
                [query.status, query.mocked, query.ruleId, query.from, query.to].filter(
                  (v) => v !== undefined,
                ).length
              }
            </span>
          )}
        </button>
      </div>
      <div className="advanced-filters" id="history-filters" hidden={!filtersOpen}>
        <input
          className="status-filter"
          aria-label="筛选状态码"
          type="number"
          placeholder="状态码"
          value={query.status ?? ''}
          onChange={(e) => update({ status: e.target.value ? Number(e.target.value) : undefined })}
        />
        <select
          aria-label="筛选 Mock"
          value={query.mocked === undefined ? '' : String(query.mocked)}
          onChange={(e) => update({ mocked: e.target.value === '' ? undefined : e.target.value === 'true' })}
        >
          <option value="">全部流量</option>
          <option value="true">仅 Mock</option>
          <option value="false">真实请求</option>
        </select>
        <select
          aria-label="筛选命中规则"
          value={query.ruleId ?? ''}
          onChange={(e) => update({ ruleId: e.target.value || undefined })}
        >
          <option value="">全部规则</option>
          {state.rules.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <label>
          开始
          <input
            type="datetime-local"
            aria-label="开始时间"
            onChange={(e) =>
              update({ from: e.target.value ? new Date(e.target.value).getTime() : undefined })
            }
          />
        </label>
        <label>
          结束
          <input
            type="datetime-local"
            aria-label="结束时间"
            onChange={(e) => update({ to: e.target.value ? new Date(e.target.value).getTime() : undefined })}
          />
        </label>
      </div>
      <div className="history-viewbar">
        <button
          aria-expanded={!catalogCollapsed}
          aria-controls="api-catalog"
          aria-label={catalogCollapsed ? '展开 API 目录' : '收起 API 目录'}
          onClick={() => {
            const next = !catalogCollapsed;
            setCatalogCollapsed(next);
            viewPreferences = { ...viewPreferences, catalogCollapsed: next };
            vscode?.setState?.(viewPreferences);
            setDetailFocused(false);
          }}
        >
          <Icon name="sidebar" size={15} />
          {catalogCollapsed ? '展开目录' : '收起目录'}
          <span className="count">{groups.length}</span>
        </button>
        {group && (
          <button
            className="active-api-filter"
            title={`清除 API 筛选：${group}`}
            onClick={() => {
              setGroup('');
              update({ host: undefined, path: undefined, method: undefined });
            }}
          >
            <span>{group}</span>
            <Icon name="close" size={12} />
          </button>
        )}
        <div className="history-view-actions">
          <Button
            action="history.clear"
            danger
            disabled={state.busy}
            title="清空当前项目的全部 HTTP 请求历史（包含筛选外记录），保留 API 目录和 Mock 规则"
          >
            清空记录
          </Button>
          <span className="sort-indicator">最新在前 · 按请求时间倒序</span>
        </div>
      </div>
      <div
        className={`history-layout ${catalogCollapsed ? 'catalog-collapsed' : ''} ${detailFocused ? 'detail-focused' : ''}`}
      >
        <aside className="api-sidebar" id="api-catalog" aria-label="API 目录" hidden={catalogCollapsed}>
          <div className="pane-heading">
            API 目录 <span>最近调用优先</span>
          </div>
          <div className="catalog-search">
            <input
              aria-label="搜索 API 目录"
              placeholder="筛选 API 目录…"
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
            />
          </div>
          <button
            className={`api-all ${!group ? 'selected' : ''}`}
            onClick={() => {
              setGroup('');
              update({ host: undefined, path: undefined, method: undefined });
            }}
          >
            全部 API <span>{groups.length} 个</span>
          </button>
          {visibleGroups.map((g) => {
            const id = `${g.method} ${g.host}${g.path}`;
            return (
              <div className={`api-entry ${group === id ? 'selected' : ''}`} key={id}>
                <button
                  className="api-group"
                  aria-label={`查看 API ${g.method} ${g.host}${g.path}`}
                  aria-pressed={group === id}
                  title={`${g.method} ${g.host}${g.path}\n累计调用 ${g.count} 次${g.firstAt ? `\n首次发现：${new Date(g.firstAt).toLocaleString('zh-CN')}` : ''}\n最近调用：${new Date(g.lastAt).toLocaleString('zh-CN')}`}
                  onClick={() => {
                    setGroup(id);
                    update({ method: g.method, host: g.host, path: g.path });
                  }}
                >
                  <span>
                    <Method method={g.method} />
                    <b>{g.count} 次</b>
                  </span>
                  <strong>{g.path}</strong>
                  <small>{g.host}</small>
                  <small className="api-last-seen">
                    最近{' '}
                    {new Date(g.lastAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </small>
                </button>
                <button
                  className="api-delete"
                  aria-label={`删除 API ${g.method} ${g.host}${g.path}`}
                  title="只删除目录项，保留请求历史；下次请求会重新发现"
                  disabled={state.busy}
                  onClick={() => send('api.delete', { method: g.method, host: g.host, path: g.path })}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            );
          })}
          {groups.length > 0 && !visibleGroups.length && <p className="sidebar-hint">没有匹配的 API</p>}
          <p className="sidebar-hint">
            {groups.length
              ? '目录独立保存；清空或过期请求历史不会移除已发现的 API。'
              : '完成接入后自动发现 API，按方法、主机和路径独立保存。'}
          </p>
        </aside>
        <section className="request-list">
          <div className="pane-heading">
            请求记录 <span>{state.history.total} 条</span>
          </div>
          {records.length ? (
            records.map((h) => (
              <button
                className={`request-row ${selected?.id === h.id ? 'selected' : ''}`}
                key={h.id}
                aria-pressed={selected?.id === h.id}
                onClick={() => send('history.select', { id: h.id })}
              >
                <div className="request-summary">
                  <Method method={h.method} />
                  <strong title={h.url}>{h.path}</strong>
                  <span
                    className={`http-status ${h.error || (h.response?.status ?? (h as unknown as { status?: number }).status ?? 0) >= 400 ? 'failed' : ''}`}
                  >
                    {h.response?.status ??
                      (h as unknown as { status?: number }).status ??
                      (h.error ? 'ERR' : '—')}
                  </span>
                  {h.mocked && <span className="mock-badge">MOCK</span>}
                </div>
                <small title={h.host}>{h.host}</small>
                <div className="request-meta">
                  <time
                    dateTime={new Date(h.startedAt).toISOString()}
                    title={new Date(h.startedAt).toLocaleString('zh-CN')}
                  >
                    {new Date(h.startedAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      hour12: false,
                    })}
                  </time>
                  <span>{Math.round(h.duration)} ms</span>
                  {(h.requestRuleId || h.responseRuleId) && <span className="rule-hit">规则命中</span>}
                </div>
              </button>
            ))
          ) : (
            <Empty
              icon="history"
              title={group ? '该 API 暂无请求历史' : '暂无请求历史'}
              description={
                groups.length
                  ? '已发现的 API 保留在目录中。请求历史可能已清理，新的请求会继续记录。'
                  : '完成设备接入后，在应用中触发请求；代理会自动记录，并建立 API 目录。'
              }
            />
          )}
          <div className="pagination">
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>
              上一页
            </Button>
            <span>
              {state.history.total
                ? `${offset + 1}–${Math.min(offset + 30, state.history.total)} / ${state.history.total}`
                : '0 条'}
            </span>
            <Button disabled={offset + 30 >= state.history.total} onClick={() => setOffset(offset + 30)}>
              下一页
            </Button>
          </div>
        </section>
        <section className="request-detail" ref={detailRef} aria-label="请求详情">
          {selected ? (
            <>
              <div className="detail-heading">
                <div>
                  <Method method={selected.method} />
                  <strong title={selected.path}>{selected.path}</strong>
                  <button
                    className="detail-focus-button"
                    aria-label={detailFocused ? '返回列表' : '放大详情'}
                    title={detailFocused ? '返回列表' : '放大详情'}
                    onClick={() => setDetailFocused(!detailFocused)}
                  >
                    <Icon name="expand" size={14} />
                    {detailFocused ? '返回列表' : '放大'}
                  </button>
                </div>
                <code>{selected.url}</code>
                <div className="detail-summary">
                  <span
                    className={`status-summary ${selected.error || (selected.response?.status ?? 0) >= 400 ? 'failed' : ''}`}
                  >
                    {selected.response ? `HTTP ${selected.response.status}` : '未收到响应'}
                  </span>
                  <span>{Math.round(selected.duration).toLocaleString()} ms</span>
                  <time>{new Date(selected.startedAt).toLocaleString('zh-CN', { hour12: false })}</time>
                  {selected.mocked && <span className="mock-badge">MOCK</span>}
                </div>
                <div className="detail-actions">
                  <Button onClick={() => send('history.toRule', { id: selected.id, kind: 'mock' })} primary>
                    <Icon name="plus" size={14} />
                    生成 Mock
                  </Button>
                  <select
                    aria-label="从请求生成规则"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) send('history.toRule', { id: selected.id, kind: e.target.value });
                    }}
                  >
                    <option value="">更多规则…</option>
                    <option value="request">修改请求</option>
                    <option value="response">修改响应</option>
                    <option value="redirect">转发地址</option>
                  </select>
                  <Button danger onClick={() => send('history.delete', { id: selected.id })}>
                    删除记录
                  </Button>
                </div>
              </div>
              <div className="detail-tabs">
                {(['response', 'request', 'diff', 'info'] as const).map((t, i) => (
                  <button
                    aria-pressed={t === detailTab}
                    title={
                      t === 'response'
                        ? 'Response · 最终响应'
                        : t === 'request'
                          ? 'Request · 最终请求'
                          : undefined
                    }
                    className={t === detailTab ? 'active' : ''}
                    key={t}
                    onClick={() => setDetailTab(t)}
                  >
                    {['响应', '请求', '修改对比', '备注与信息'][i]}
                  </button>
                ))}
              </div>
              <div className="detail-body">
                {selected.error && (
                  <div className="notice request-error">
                    <strong>请求未正常完成</strong>
                    <div>{selected.error}</div>
                    {!selected.response && <p>没有收到 HTTP 响应；此记录不能视为服务端返回的业务错误。</p>}
                  </div>
                )}
                {detailTab === 'request' && (
                  <SnapshotView key={`${selected.id}-request`} snapshot={selected.request} label="最终请求" />
                )}
                {detailTab === 'response' && (
                  <SnapshotView
                    key={`${selected.id}-response`}
                    snapshot={selected.response}
                    label="最终响应"
                  />
                )}
                {detailTab === 'diff' && (
                  <>
                    <div className="diff-label">请求 · 原始 → 自动规则 → 最终</div>
                    <div className="snapshot-grid">
                      <SnapshotView snapshot={selected.originalRequest} label="原始" />
                      <SnapshotView
                        snapshot={selected.automaticRequest ?? selected.request}
                        label="自动规则后"
                      />
                      <SnapshotView snapshot={selected.request} label="最终" />
                    </div>
                    <div className="diff-label">响应 · 原始 → 自动规则 → 最终</div>
                    <div className="snapshot-grid">
                      <SnapshotView snapshot={selected.originalResponse} label="原始" />
                      <SnapshotView
                        snapshot={selected.automaticResponse ?? selected.response}
                        label="自动规则后"
                      />
                      <SnapshotView snapshot={selected.response} label="最终" />
                    </div>
                  </>
                )}
                {detailTab === 'info' && (
                  <div className="info-form">
                    <dl>
                      <dt>目标地址</dt>
                      <dd>{selected.targetUrl}</dd>
                      <dt>耗时</dt>
                      <dd>{selected.duration} ms</dd>
                      <dt>请求规则</dt>
                      <dd>
                        {state.rules.find((r) => r.id === selected.requestRuleId)?.name ??
                          selected.requestRuleId ??
                          '未命中'}
                      </dd>
                      <dt>响应规则</dt>
                      <dd>
                        {state.rules.find((r) => r.id === selected.responseRuleId)?.name ??
                          selected.responseRuleId ??
                          '未命中'}
                      </dd>
                    </dl>
                    <label>
                      备注
                      <textarea
                        aria-label="历史备注"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </label>
                    <label>
                      标签（英文逗号分隔）
                      <input aria-label="历史标签" value={tags} onChange={(e) => setTags(e.target.value)} />
                    </label>
                    <Button
                      primary
                      onClick={() =>
                        send('history.update', {
                          id: selected.id,
                          note,
                          tags: tags
                            .split(',')
                            .map((t) => t.trim())
                            .filter(Boolean),
                        })
                      }
                    >
                      保存备注
                    </Button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <Empty
              icon="radar"
              title="每次请求，都有迹可循"
              description="选择一条记录，查看请求与响应、修改对比，或一键生成 Mock 规则。"
            />
          )}
        </section>
      </div>
    </div>
  );
}
function newRule(kind: string): Rule {
  const rule: Rule = {
    id: crypto.randomUUID(),
    name: '',
    enabled: true,
    priority: 0,
    match: { method: 'GET', host: '', path: '/' },
  };
  if (kind === 'mock')
    rule.mock = { status: 200, headers: { 'content-type': 'application/json' }, body: '{\n  "data": {}\n}' };
  if (kind === 'request') rule.request = { headers: {} };
  if (kind === 'response') rule.response = { headers: {} };
  if (kind === 'redirect') rule.redirect = { url: 'http://127.0.0.1:3000/' };
  if (kind === 'breakpoint') rule.breakpoint = { request: true, response: false, timeout: 60 };
  return rule;
}
function kindOf(rule: Rule) {
  return rule.mock
    ? 'mock'
    : rule.redirect
      ? 'redirect'
      : rule.request
        ? 'request'
        : rule.response
          ? 'response'
          : 'breakpoint';
}
const kindLabels: Record<string, string> = {
  mock: '直接 Mock',
  request: '修改请求',
  response: '修改响应',
  redirect: '转发地址',
  breakpoint: '手动断点',
};
function Rules({
  state,
  edit,
  setEdit,
}: {
  state: WorkbenchState;
  edit?: Rule;
  setEdit: (r: Rule | undefined) => void;
}) {
  const [search, setSearch] = useState('');
  return (
    <div className="rules-page">
      <div className="page-title compact">
        <div>
          <h2>
            Mock 规则 <span className="count">{state.rules.length}</span>
          </h2>
        </div>
        <div className="toolbar-actions">
          <details className="workspace-menu">
            <summary>更多操作</summary>
            <div className="workspace-menu-panel">
              <Button action="rules.import">导入</Button>
              <Button action="rules.export">导出</Button>
            </div>
          </details>
          <Button primary onClick={() => setEdit(newRule('mock'))}>
            <Icon name="plus" size={15} />
            新建规则
          </Button>
        </div>
      </div>
      <details className="compact-disclosure rule-presets">
        <summary>规则模板与说明</summary>
        <p>按原始请求匹配，每阶段执行优先级最高的首条规则。</p>
        <div className="rule-templates">
          {Object.entries(kindLabels).map(([kind, label]) => (
            <button key={kind} onClick={() => setEdit(newRule(kind))}>
              <Icon
                name={
                  kind === 'mock'
                    ? 'box'
                    : kind === 'breakpoint'
                      ? 'pause'
                      : kind === 'redirect'
                        ? 'arrowRight'
                        : 'rules'
                }
                size={18}
              />
              <span>{label}</span>
              <Icon name="plus" size={14} />
            </button>
          ))}
        </div>
      </details>
      <div className="search-field rule-search">
        <Icon name="search" size={16} />
        <input
          aria-label="搜索规则"
          placeholder="查找规则名称或 API 路径…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {state.rules.length ? (
        <div className="rule-list">
          {state.rules
            .filter((r) =>
              `${r.name} ${r.match.path} ${r.match.host}`.toLowerCase().includes(search.toLowerCase()),
            )
            .map((r, i) => (
              <div className={`rule-card ${r.enabled ? 'enabled' : 'inactive'}`} key={r.id}>
                <button
                  type="button"
                  className="rule-switch"
                  role="switch"
                  aria-checked={r.enabled}
                  aria-label={`启用 ${r.name}`}
                  title={r.enabled ? '点击停用此规则' : '点击启用此规则'}
                  disabled={state.busy}
                  onClick={() => send('rules.toggle', { id: r.id })}
                >
                  <span className="rule-switch-track" aria-hidden="true">
                    <span className="rule-switch-thumb" />
                  </span>
                </button>
                <div className="rule-card-content">
                  <div>
                    <strong title={r.name}>{r.name}</strong>
                    <span className="tag">{kindLabels[kindOf(r)]}</span>
                    <span className="priority">优先级 {r.priority}</span>
                    {r.breakpoint && (r.breakpoint.request || r.breakpoint.response) && (
                      <span className="tag warm">断点</span>
                    )}
                  </div>
                  <code title={`${r.match.method || 'ANY'} ${r.match.host || '*'}${r.match.path || '/*'}`}>
                    <Method method={r.match.method || 'ANY'} /> {r.match.host || '*'}
                    {r.match.path || '/*'}
                  </code>
                </div>
                <div className="rule-card-actions">
                  <Button
                    disabled={i === 0}
                    title="同优先级时提前"
                    onClick={() => send('rules.move', { id: r.id, direction: 'up' })}
                  >
                    ↑
                  </Button>
                  <Button onClick={() => send('rules.move', { id: r.id, direction: 'down' })}>↓</Button>
                  <Button onClick={() => setEdit(JSON.parse(JSON.stringify(r)))}>编辑</Button>
                  <Button onClick={() => send('rules.duplicate', { id: r.id })}>复制</Button>
                  <Button danger onClick={() => send('rules.delete', { id: r.id })}>
                    删除
                  </Button>
                </div>
              </div>
            ))}
        </div>
      ) : (
        <Empty
          icon="rules"
          title="为每个场景，准备一条规则"
          description="模拟空数据、异常状态、边界情况，或将线上接口转发到本地。也可从请求历史生成规则。"
        >
          <Button primary onClick={() => setEdit(newRule('mock'))}>
            <Icon name="plus" size={15} />
            创建第一条 Mock
          </Button>
        </Empty>
      )}
      {edit && <RuleEditor key={edit.id} rule={edit} onClose={() => setEdit(undefined)} busy={state.busy} />}
    </div>
  );
}
function parseMap(text: string, nullable = true): Record<string, string | null> {
  const value = JSON.parse(text || '{}');
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== 'string' && !(nullable && v === null))
  )
    throw new Error('键值配置必须为 JSON 对象，值使用字符串，删除使用 null');
  return value;
}
function RuleEditor({ rule, onClose, busy }: { rule: Rule; onClose: () => void; busy: boolean }) {
  const [draft, setDraft] = useState<Rule>(rule);
  const [kind, setKind] = useState(kindOf(rule));
  const [advanced, setAdvanced] = useState(false);
  const [raw, setRaw] = useState(JSON.stringify(rule, null, 2));
  const [headers, setHeaders] = useState(
    JSON.stringify(rule.mock?.headers ?? rule.request?.headers ?? rule.response?.headers ?? {}, null, 2),
  );
  const [query, setQuery] = useState(JSON.stringify(rule.request?.query ?? {}, null, 2));
  const [matchHeaders, setMatchHeaders] = useState(JSON.stringify(rule.match.headers ?? {}, null, 2));
  const [matchQuery, setMatchQuery] = useState(JSON.stringify(rule.match.query ?? {}, null, 2));
  const [error, setError] = useState('');
  const change = (p: Partial<Rule>) => setDraft((d) => ({ ...d, ...p }));
  const body = draft.mock?.body ?? draft.request?.body ?? draft.response?.body ?? '';
  function assembled() {
    if (advanced) return JSON.parse(raw) as Rule;
    const d = JSON.parse(JSON.stringify(draft)) as Rule;
    if (d.breakpoint && !d.breakpoint.request && !d.breakpoint.response) delete d.breakpoint;
    d.match.headers = parseMap(matchHeaders, false) as Record<string, string>;
    d.match.query = parseMap(matchQuery, false) as Record<string, string>;
    const h = parseMap(headers, kind !== 'mock');
    if (kind === 'mock') d.mock = { ...d.mock!, headers: h as Record<string, string> };
    if (kind === 'request') d.request = { ...d.request, headers: h, query: parseMap(query) };
    if (kind === 'response') d.response = { ...d.response, headers: h };
    return d;
  }
  function switchKind(next: string) {
    const fresh = newRule(next);
    setDraft((d) => ({
      ...d,
      request: fresh.request,
      response: fresh.response,
      mock: fresh.mock,
      redirect: fresh.redirect,
      breakpoint: fresh.breakpoint ?? d.breakpoint,
    }));
    setHeaders(JSON.stringify(fresh.mock?.headers ?? {}, null, 2));
    setKind(next);
  }
  return (
    <div className="modal-backdrop">
      <section className="rule-editor modal" role="dialog" aria-modal="true" aria-label="规则编辑器">
        <div className="modal-heading">
          <div>
            <span className="eyebrow">RULE EDITOR</span>
            <h3>{rule.name ? '编辑规则' : '新建规则'}</h3>
          </div>
          <button className="icon-button" aria-label="关闭编辑器" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="editor-toggle">
          <button
            className={!advanced ? 'active' : ''}
            onClick={() => {
              if (advanced) {
                try {
                  const d = validateRuleDocument({ version: 1, rules: [JSON.parse(raw)] }).rules[0];
                  setDraft(d);
                  setKind(kindOf(d));
                  setHeaders(
                    JSON.stringify(
                      d.mock?.headers ?? d.request?.headers ?? d.response?.headers ?? {},
                      null,
                      2,
                    ),
                  );
                  setQuery(JSON.stringify(d.request?.query ?? {}, null, 2));
                  setMatchHeaders(JSON.stringify(d.match.headers ?? {}, null, 2));
                  setMatchQuery(JSON.stringify(d.match.query ?? {}, null, 2));
                  setAdvanced(false);
                  setError('');
                } catch (e) {
                  setError((e as Error).message);
                }
              }
            }}
          >
            表单编辑
          </button>
          <button
            className={advanced ? 'active' : ''}
            onClick={() => {
              try {
                setRaw(JSON.stringify(assembled(), null, 2));
                setAdvanced(true);
                setError('');
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            完整 JSON
          </button>
          <span>JSON 可组合多个阶段动作</span>
        </div>
        <div className="modal-scroll">
          {advanced ? (
            <BodyEditor label="规则 JSON" value={raw} onChange={setRaw} />
          ) : (
            <>
              <div className="form-grid">
                <label className="span-two">
                  规则名称
                  <input
                    aria-label="规则名称"
                    autoFocus
                    placeholder="例如：订单列表 · 空数据"
                    value={draft.name}
                    onChange={(e) => change({ name: e.target.value })}
                  />
                </label>
                <label>
                  规则动作
                  <select aria-label="规则动作" value={kind} onChange={(e) => switchKind(e.target.value)}>
                    {Object.entries(kindLabels).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  优先级
                  <input
                    type="number"
                    aria-label="规则优先级"
                    value={draft.priority}
                    onChange={(e) => change({ priority: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="form-section-title">
                匹配请求 <span>基于修改前的请求</span>
              </div>
              <div className="form-grid match-grid">
                <label>
                  方法
                  <select
                    value={draft.match.method ?? ''}
                    onChange={(e) => change({ match: { ...draft.match, method: e.target.value } })}
                  >
                    <option value="">ANY</option>
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </label>
                <label>
                  主机
                  <input
                    aria-label="匹配主机"
                    placeholder="api.example.com，可留空"
                    value={draft.match.host ?? ''}
                    onChange={(e) => change({ match: { ...draft.match, host: e.target.value } })}
                  />
                </label>
                <label className="span-two">
                  路径
                  <input
                    aria-label="匹配路径"
                    placeholder="/api/orders/*"
                    value={draft.match.path ?? ''}
                    onChange={(e) => change({ match: { ...draft.match, path: e.target.value } })}
                  />
                </label>
              </div>
              <div className="match-example">
                匹配示例：
                <code>
                  {draft.match.method || 'ANY'} https://{draft.match.host || '任意主机'}
                  {draft.match.path || '/*'}
                </code>{' '}
                · * 匹配任意字符
              </div>
              <details className="advanced-fields">
                <summary>更多匹配条件</summary>
                <BodyEditor label="匹配查询参数 JSON" value={matchQuery} onChange={setMatchQuery} />
                <BodyEditor label="匹配请求头 JSON" value={matchHeaders} onChange={setMatchHeaders} />
              </details>
              <div className="form-section-title">{kindLabels[kind]}</div>
              {kind === 'response' && (
                <label className="inline-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.response?.status !== undefined}
                    onChange={(e) => {
                      const response = { ...draft.response };
                      if (e.target.checked) response.status = 200;
                      else delete response.status;
                      change({ response });
                    }}
                  />
                  修改响应状态码
                </label>
              )}
              {(kind === 'mock' || (kind === 'response' && draft.response?.status !== undefined)) && (
                <label>
                  响应状态码
                  <input
                    aria-label="响应状态码"
                    type="number"
                    min="200"
                    max="599"
                    value={draft.mock?.status ?? draft.response?.status ?? 200}
                    onChange={(e) =>
                      kind === 'mock'
                        ? change({ mock: { ...draft.mock!, status: Number(e.target.value) } })
                        : change({ response: { ...draft.response, status: Number(e.target.value) } })
                    }
                  />
                </label>
              )}
              {kind === 'request' && (
                <div className="form-grid">
                  <label>
                    改写方法（可留空）
                    <input
                      placeholder="POST"
                      value={draft.request?.method ?? ''}
                      onChange={(e) =>
                        change({ request: { ...draft.request, method: e.target.value || undefined } })
                      }
                    />
                  </label>
                  <label>
                    完整请求地址（可留空）
                    <input
                      placeholder="https://api.example.com/new"
                      value={draft.request?.url ?? ''}
                      onChange={(e) =>
                        change({ request: { ...draft.request, url: e.target.value || undefined } })
                      }
                    />
                  </label>
                </div>
              )}
              {kind === 'redirect' && (
                <>
                  <label>
                    目标路径或完整地址
                    <input
                      aria-label="目标地址"
                      placeholder="/api/orders 或 https://api.example.com/api/orders"
                      value={draft.redirect?.url ?? ''}
                      onChange={(e) => change({ redirect: { url: e.target.value } })}
                    />
                  </label>
                  <div className="notice">
                    输入 /path 只替换路径，保留原查询参数；带 ? 时替换查询参数。完整 URL 替换整个地址。
                    发送真实请求，保留方法、正文及 Authorization、Cookie 等请求头；Host 随目标更新。
                  </div>
                </>
              )}
              {['mock', 'request', 'response'].includes(kind) && (
                <>
                  <BodyEditor label="Headers JSON" value={headers} onChange={setHeaders} />
                  {kind === 'request' && (
                    <BodyEditor label="查询参数修改 JSON" value={query} onChange={setQuery} />
                  )}
                  {kind !== 'mock' && (
                    <label className="inline-checkbox">
                      <input
                        type="checkbox"
                        checked={
                          kind === 'request'
                            ? draft.request?.body !== undefined
                            : draft.response?.body !== undefined
                        }
                        onChange={(e) => {
                          if (kind === 'request') {
                            const request = { ...draft.request };
                            if (e.target.checked) request.body = '';
                            else delete request.body;
                            change({ request });
                          } else {
                            const response = { ...draft.response };
                            if (e.target.checked) response.body = '';
                            else delete response.body;
                            change({ response });
                          }
                        }}
                      />
                      替换正文（关闭时保留原正文）
                    </label>
                  )}
                  <BodyEditor
                    label="Body · JSON / 文本"
                    disabled={
                      kind === 'request'
                        ? draft.request?.body === undefined
                        : kind === 'response'
                          ? draft.response?.body === undefined
                          : false
                    }
                    value={body}
                    onChange={(value) =>
                      kind === 'mock'
                        ? change({ mock: { ...draft.mock!, body: value } })
                        : kind === 'request'
                          ? change({ request: { ...draft.request, body: value } })
                          : change({ response: { ...draft.response, body: value } })
                    }
                  />
                  <small className="muted">
                    正文完整替换；Headers 和查询参数使用键值对象，null 表示删除。文件与流式正文不编辑。
                  </small>
                </>
              )}
              <div className="form-section-title">断点与启用</div>
              <div className="breakpoint-settings">
                <label>
                  <input
                    type="checkbox"
                    checked={draft.breakpoint?.request ?? false}
                    onChange={(e) =>
                      change({ breakpoint: { ...draft.breakpoint, request: e.target.checked } })
                    }
                  />
                  请求发送前暂停
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.breakpoint?.response ?? false}
                    onChange={(e) =>
                      change({ breakpoint: { ...draft.breakpoint, response: e.target.checked } })
                    }
                  />
                  响应返回前暂停
                </label>
                <label>
                  等待秒数
                  <input
                    aria-label="断点等待秒数"
                    type="number"
                    min="10"
                    max="300"
                    value={draft.breakpoint?.timeout ?? 60}
                    onChange={(e) =>
                      change({ breakpoint: { ...draft.breakpoint, timeout: Number(e.target.value) } })
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => change({ enabled: e.target.checked })}
                  />
                  保存后启用
                </label>
              </div>
            </>
          )}
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <span>保存后由引擎确认生效</span>
          <Button onClick={onClose}>取消</Button>
          <Button
            primary
            disabled={busy}
            onClick={() => {
              try {
                const r = validateRuleDocument({ version: 1, rules: [assembled()] }).rules[0];
                send('rules.save', { rule: r });
                onClose();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            保存规则
          </Button>
        </div>
      </section>
    </div>
  );
}
function Breakpoints({ pending }: { pending: PendingBreakpoint[] }) {
  const [selected, setSelected] = useState<string>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const current = pending.find((p) => p.id === selected) ?? pending[0];
  return (
    <div className="breakpoints-page">
      <div className="page-title compact">
        <div>
          <h2>断点队列</h2>
        </div>
        <span className="tag warm">{pending.length} 个等待处理</span>
      </div>
      <details className="compact-disclosure breakpoint-instructions">
        <summary>断点使用说明</summary>
        <p>工作台打开时可处理手动断点；关闭后自动跳过人工暂停，继续后台记录和自动规则。</p>
      </details>
      {pending.length ? (
        <div className="breakpoint-layout">
          <aside>
            {pending.map((p) => (
              <button
                className={`breakpoint-item ${current?.id === p.id ? 'selected' : ''}`}
                key={p.id}
                onClick={() => setSelected(p.id)}
              >
                <span className="tag warm">{p.stage === 'request' ? '请求' : '响应'}</span>
                <strong>{'url' in p.current ? p.current.url : p.flowId.slice(0, 12)}</strong>
                <small>{Math.max(0, Math.ceil((p.expiresAt - now) / 1000))} 秒后自动放行</small>
              </button>
            ))}
          </aside>
          {current && <BreakpointEditor key={current.id} item={current} now={now} />}
        </div>
      ) : (
        <Empty
          icon="pause"
          title="请求会在这里等你"
          description="在规则中开启请求或响应断点。命中后，你可以编辑数据、放行或终止该次请求。"
        />
      )}
    </div>
  );
}
function BreakpointEditor({ item, now }: { item: PendingBreakpoint; now: number }) {
  const [headers, setHeaders] = useState(JSON.stringify(Object.fromEntries(item.current.headers), null, 2));
  const [body, setBody] = useState(item.current.body);
  const [url, setUrl] = useState('url' in item.current ? item.current.url : '');
  const [method, setMethod] = useState('method' in item.current ? item.current.method : 'GET');
  const [status, setStatus] = useState('status' in item.current ? item.current.status : 200);
  const [error, setError] = useState('');
  const seconds = Math.max(0, Math.ceil((item.expiresAt - now) / 1000));
  return (
    <section className="card breakpoint-editor">
      <div className="card-heading">
        <h3>{item.stage === 'request' ? '请求发送前' : '响应返回前'}</h3>
        <span className={`countdown ${seconds < 10 ? 'urgent' : ''}`}>{seconds}s</span>
      </div>
      <div className="breakpoint-content">
        <details>
          <summary>查看修改前原始数据</summary>
          <SnapshotView snapshot={item.original} label="原始" />
        </details>
        {item.stage === 'request' ? (
          <div className="form-grid">
            <label>
              方法
              <input aria-label="断点请求方法" value={method} onChange={(e) => setMethod(e.target.value)} />
            </label>
            <label>
              URL
              <input aria-label="断点请求 URL" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
          </div>
        ) : (
          <label>
            状态码
            <input
              type="number"
              min="200"
              max="599"
              aria-label="断点响应状态码"
              value={status}
              onChange={(e) => setStatus(Number(e.target.value))}
            />
          </label>
        )}
        <BodyEditor label="断点 Headers JSON" value={headers} onChange={setHeaders} />
        <BodyEditor label="断点 Body" value={body} onChange={setBody} disabled={!item.current.editable} />
        {!item.current.editable && (
          <div className="notice">{item.current.limitation ?? '正文仅查看，不支持编辑'}</div>
        )}
        {error && <div className="inline-error">{error}</div>}
      </div>
      <div className="breakpoint-actions">
        <Button danger onClick={() => send('breakpoint.resolve', { id: item.id, action: 'abort' })}>
          终止请求
        </Button>
        <div>
          <Button onClick={() => send('breakpoint.resolve', { id: item.id, action: 'resume' })}>
            直接放行
          </Button>
          <Button
            primary
            disabled={seconds === 0}
            onClick={() => {
              try {
                const h = headerChanges(item.current.headers, parseMap(headers));
                const patch = {
                  headers: h,
                  ...(item.current.editable && body !== item.current.body ? { body } : {}),
                  ...(item.stage === 'request' ? { url, method } : { status }),
                };
                send('breakpoint.resolve', { id: item.id, action: 'resume', patch });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <Icon name="play" size={14} />
            编辑后放行
          </Button>
        </div>
      </div>
    </section>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

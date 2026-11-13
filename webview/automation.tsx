import React, { useState } from 'react';
import type { WorkbenchState } from '../src/model';

export function AutomationPanel({
  state,
  send,
}: {
  state: WorkbenchState;
  send: (action: string, payload?: unknown) => void;
}) {
  const automation = state.automation;
  const [deviceId, setDeviceId] = useState('');
  const [appId, setAppId] = useState('');
  const [wdaPath, setWdaPath] = useState('');
  const [wdaBundleId, setWdaBundleId] = useState('');
  const [confirmVm, setConfirmVm] = useState(false);
  const selected = automation?.devices.find((device) => device.id === deviceId);
  const connected = automation?.status === 'connected';
  const working = state.busy || ['installing', 'connecting'].includes(automation?.status ?? '');
  return (
    <section className="card automation-panel" aria-label="设备自动化">
      <div className="mcp-heading">
        <h2>设备自动化</h2>
        <span className="badge">
          {connected ? '已连接' : automation?.installed ? '环境已准备' : '尚未准备'}
        </span>
      </div>
      <p className="muted">
        连接 Android 或 iOS，操作权限弹窗、系统键盘和原生页面。Flutter VM 可继续独立使用。
      </p>
      <div className="mcp-actions">
        <button onClick={() => send('automation.inspect')}>刷新设备与诊断</button>
        {working && <button onClick={() => send('automation.cancel')}>取消当前自动化操作</button>}
        <button disabled={working || connected} onClick={() => send('automation.setup')}>
          {automation?.installed ? '检查自动化环境' : '准备自动化环境'}
        </button>
        {connected && (
          <button disabled={working} onClick={() => send('automation.disconnect')}>
            断开设备自动化
          </button>
        )}
      </div>
      {automation?.progress && <p role="status">{automation.progress}</p>}
      {automation?.binding && (
        <p>
          设备：{automation.binding.deviceId} · App：{automation.binding.appId}
        </p>
      )}
      {!connected && (
        <div className="automation-fields">
          <label>
            自动化设备
            <select
              aria-label="自动化设备"
              value={deviceId}
              disabled={working}
              onChange={(event) => setDeviceId(event.target.value)}
            >
              <option value="">请选择设备</option>
              {automation?.devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} · {device.platform} · {device.state}
                </option>
              ))}
            </select>
          </label>
          <label>
            App 包名 / Bundle ID
            <input
              aria-label="App 包名 / Bundle ID"
              value={appId}
              disabled={working}
              onChange={(event) => setAppId(event.target.value)}
              placeholder="com.example.app"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmVm}
              disabled={working}
              onChange={(event) => setConfirmVm(event.target.checked)}
            />
            手动连接 VM 时，确认当前 VM 来自所选设备
          </label>
          {selected?.platform === 'ios' && selected.kind === 'physical' && (
            <>
              <label>
                已签名 WDA 路径
                <input
                  aria-label="已签名 WDA 路径"
                  value={wdaPath}
                  disabled={working}
                  onChange={(event) => setWdaPath(event.target.value)}
                  placeholder="/path/WebDriverAgentRunner-Runner.app"
                />
              </label>
              <label>
                WDA Bundle ID
                <input
                  aria-label="WDA Bundle ID"
                  value={wdaBundleId}
                  disabled={working}
                  onChange={(event) => setWdaBundleId(event.target.value)}
                />
              </label>
              <p className="muted">请先完成开发者模式、设备配对和 WDA 签名。</p>
            </>
          )}
          <button
            disabled={
              working ||
              !automation?.installed ||
              !deviceId ||
              !appId ||
              (selected?.platform === 'ios' && selected.kind === 'physical' && (!wdaPath || !wdaBundleId))
            }
            onClick={() =>
              send('automation.connect', {
                deviceId,
                appId,
                ...(confirmVm ? { vmDeviceId: deviceId } : {}),
                ...(wdaPath ? { wdaPath, wdaBundleId } : {}),
              })
            }
          >
            连接设备自动化
          </button>
        </div>
      )}
      {!!automation?.diagnostics.length && (
        <details className="secondary-details">
          <summary>设备自动化诊断</summary>
          <ul>
            {automation.diagnostics.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </details>
      )}
      {automation?.capabilities && (
        <details className="secondary-details">
          <summary>当前设备分项能力</summary>
          <dl className="mcp-facts">
            {Object.entries(automation.capabilities).map(([name, capability]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>
                  {capability.supported
                    ? `可用${capability.reason ? ` · ${capability.reason}` : ''}`
                    : (capability.reason ?? '不支持')}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </section>
  );
}

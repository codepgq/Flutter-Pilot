import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ProjectLaunchProfile, ProjectLaunchSnapshot } from './project-launch';

export interface LauncherProfile {
  id: string;
  name: string;
  type: 'web' | 'flutter';
  detail: string;
}

export interface LauncherSession {
  folder: string;
  name: string;
  recording: boolean;
  mode: 'vm' | 'proxy';
  connection: string;
  launch: {
    profiles: LauncherProfile[];
    selectedProfileId?: string;
    status: ProjectLaunchSnapshot['status'];
    activeProfileId?: string;
    url?: string;
    error?: string;
  };
}

export function launcherSessionFrom(input: {
  folder: string;
  name: string;
  recording: boolean;
  mode: 'vm' | 'proxy';
  connection: string;
  launch: ProjectLaunchSnapshot;
}): LauncherSession {
  return {
    folder: input.folder,
    name: input.name,
    recording: input.recording,
    mode: input.mode,
    connection: input.connection,
    launch: {
      profiles: input.launch.profiles.map(profileDetail),
      ...(input.launch.selectedProfileId ? { selectedProfileId: input.launch.selectedProfileId } : {}),
      status: input.launch.status,
      ...(input.launch.activeProfileId ? { activeProfileId: input.launch.activeProfileId } : {}),
      ...(input.launch.url ? { url: input.launch.url } : {}),
      ...(input.launch.error ? { error: input.launch.error } : {}),
    },
  };
}

function profileDetail(profile: ProjectLaunchProfile): LauncherProfile {
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    detail:
      profile.type === 'web'
        ? `${profile.packageManager} run ${profile.script} · ${profile.url}`
        : `Debug 配置：${profile.configuration ?? '自动选择唯一配置'}`,
  };
}

export interface LauncherActions {
  sessions: () => LauncherSession[];
  open: () => Promise<unknown>;
  screenshot: () => Promise<unknown>;
  start: (folder: string, profileId: string) => Promise<void>;
  stop: (folder: string) => Promise<void>;
  reload: (folder: string) => Promise<void>;
  edit: (folder: string) => Promise<void>;
}

/** Sidebar status and project launch. Opening this view does not open the workbench. */
export class LauncherView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private actionError?: string;

  constructor(private readonly actions: LauncherActions) {}

  register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('flutterPilot.launcher', this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = launcherHtml(webviewView.webview.cspSource);
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.onMessage(message);
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
    this.refresh();
  }

  refresh() {
    void this.view?.webview.postMessage({
      type: 'launcher',
      sessions: this.actions.sessions(),
      ...(this.actionError ? { actionError: this.actionError } : {}),
    });
  }

  private async onMessage(message: unknown) {
    const command = readCommand(message);
    if (!command || command.action === 'ready') {
      this.refresh();
      return;
    }
    try {
      this.actionError = undefined;
      if (command.action === 'open') await this.actions.open();
      else if (command.action === 'screenshot') await this.actions.screenshot();
      else if (command.action === 'launch.start')
        await this.actions.start(requireFolder(command), requireProfile(command));
      else if (command.action === 'launch.stop') await this.actions.stop(requireFolder(command));
      else if (command.action === 'launch.reload') await this.actions.reload(requireFolder(command));
      else if (command.action === 'launch.edit') await this.actions.edit(requireFolder(command));
      else return;
    } catch (error) {
      this.actionError = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(this.actionError);
    }
    this.refresh();
  }
}

function requireFolder(command: LauncherCommand) {
  if (!command.folder) throw new Error('缺少项目路径');
  return command.folder;
}

function requireProfile(command: LauncherCommand) {
  if (!command.profileId) throw new Error('请选择启动项');
  return command.profileId;
}

interface LauncherCommand {
  action: string;
  folder?: string;
  profileId?: string;
}

function readCommand(message: unknown): LauncherCommand | undefined {
  if (!message || typeof message !== 'object') return;
  const value = message as Record<string, unknown>;
  if (typeof value.action !== 'string' || value.action.length > 64) return;
  const folder = typeof value.folder === 'string' && value.folder.length <= 4096 ? value.folder : undefined;
  const profileId =
    typeof value.profileId === 'string' && value.profileId.length <= 64 ? value.profileId : undefined;
  return { action: value.action, ...(folder ? { folder } : {}), ...(profileId ? { profileId } : {}) };
}

function launcherHtml(cspSource: string) {
  const nonce = randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { margin: 0; padding: 12px 16px 20px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45; }
  p { margin: 0 0 8px; }
  .lead { margin-bottom: 12px; }
  .card { margin: 0 0 12px; }
  h2 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
  .status, .note, .detail { color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  label { display: block; margin: 0 0 8px; }
  select, button { box-sizing: border-box; font: inherit; }
  select { width: 100%; margin-top: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; }
  button { border: 0; border-radius: 2px; padding: 6px 10px; cursor: pointer; }
  button:disabled { opacity: 0.55; cursor: default; }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.block { display: block; width: 100%; margin: 0 0 8px; }
  .row { display: flex; gap: 8px; margin: 0 0 8px; }
  .row button { flex: 1; }
  .tag { display: inline-block; margin-right: 4px; padding: 0 4px; border: 1px solid var(--vscode-descriptionForeground); font-size: 11px; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const chosen = new Map();
  const statusText = { idle: '未启动', starting: '启动中', running: '运行中', stopping: '停止中', failed: '失败' };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, className, disabled, onClick) => {
    const node = el('button', className, label);
    node.type = 'button';
    node.disabled = disabled;
    node.addEventListener('click', onClick);
    return node;
  };
  const render = (data) => {
    if (!data || data.type !== 'launcher') return;
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const nodes = [el('p', 'lead', 'Flutter 运行时调试与 Agent 联调工作台。')];
    if (!sessions.length) nodes.push(el('p', 'status', '尚未读取到项目会话。打开受信任的本地 Flutter 或 Web 工作区后，这里会显示连接状态和启动项。'));
    if (data.actionError) nodes.push(el('p', 'error', data.actionError));
    for (const session of sessions) {
      const card = el('section', 'card');
      card.append(el('h2', '', session.name || '项目'));
      const launch = session.launch || { profiles: [], status: 'idle' };
      const status = el('p', 'status', (session.recording ? '记录中' : '未记录') + ' · ' + (session.connection || '未连接') + ' · 启动' + (statusText[launch.status] || '未读取'));
      status.setAttribute('role', 'status');
      card.append(status);
      const profiles = Array.isArray(launch.profiles) ? launch.profiles : [];
      const running = launch.status === 'starting' || launch.status === 'running' || launch.status === 'stopping';
      let select;
      if (!profiles.length) {
        card.append(el('p', 'detail', '尚未配置启动项。编辑 launch.json，添加 web 或 flutter 类型 profile 后重新读取。'));
      } else {
        const saved = chosen.get(session.folder);
        const current = profiles.some((item) => item.id === saved) ? saved
          : profiles.some((item) => item.id === launch.activeProfileId) ? launch.activeProfileId
          : profiles.some((item) => item.id === launch.selectedProfileId) ? launch.selectedProfileId
          : profiles[0].id;
        chosen.set(session.folder, current);
        const label = el('label', '', '启动项');
        select = document.createElement('select');
        select.setAttribute('aria-label', (session.name || '项目') + ' 启动项');
        for (const profile of profiles) {
          const option = el('option', '', profile.name);
          option.value = profile.id;
          select.append(option);
        }
        select.value = current;
        select.disabled = running;
        select.addEventListener('change', () => chosen.set(session.folder, select.value));
        label.append(select);
        card.append(label);
        const profile = profiles.find((item) => item.id === current);
        if (profile) {
          const detail = el('p', 'detail');
          detail.append(el('span', 'tag', profile.type === 'web' ? 'WEB' : 'FLUTTER'), document.createTextNode(' ' + (profile.detail || '')));
          card.append(detail);
        }
      }
      if (launch.url && (launch.status === 'running' || launch.status === 'starting')) card.append(el('p', 'detail', launch.url));
      if (launch.error) card.append(el('p', 'error', launch.error));
      const actions = el('div', 'row');
      actions.append(
        button('启动项目', 'primary', !select || running, () => { if (select) vscode.postMessage({ action: 'launch.start', folder: session.folder, profileId: select.value }); }),
        button('停止', 'secondary', !running, () => vscode.postMessage({ action: 'launch.stop', folder: session.folder })),
      );
      card.append(actions);
      const files = el('div', 'row');
      files.append(
        button('重新读取', 'secondary', running, () => vscode.postMessage({ action: 'launch.reload', folder: session.folder })),
        button('编辑 launch.json', 'secondary', false, () => vscode.postMessage({ action: 'launch.edit', folder: session.folder })),
      );
      card.append(files);
      nodes.push(card);
    }
    nodes.push(button('打开工作台', 'primary block', false, () => vscode.postMessage({ action: 'open' })));
    nodes.push(button('截取 App / 长截图', 'primary block', false, () => vscode.postMessage({ action: 'screenshot' })));
    nodes.push(el('p', 'note', '请在受信任的本地 Flutter 工作区中使用。'));
    root.replaceChildren(...nodes);
  };
  window.addEventListener('message', (event) => render(event.data));
  vscode.postMessage({ action: 'ready' });
</script>
</body>
</html>`;
}

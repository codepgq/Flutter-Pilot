import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type * as vscode from 'vscode';
import { validateVmUrl } from './client';
import { DtdClient } from './dtd';

interface Disposable {
  dispose(): void;
}
export interface VmDebugSession {
  id: string;
  name: string;
  type: string;
  workspaceId?: string;
  configuration: Record<string, unknown>;
  customRequest?(command: string, args: Record<string, unknown>): PromiseLike<unknown>;
}
export interface VmDiscoveryHost {
  getWorkspaceRoots(): readonly { id: string; path: string }[];
  onCustomEvent(
    listener: (event: { session: VmDebugSession; event: string; body?: unknown }) => void,
  ): Disposable;
  onSessionStarted(listener: (session: VmDebugSession) => void): Disposable;
  onSessionStopped(listener: (session: VmDebugSession) => void): Disposable;
  onWorkspaceChanged(listener: () => void): Disposable;
  getDartApi(): Promise<unknown>;
}
export interface VmDiscoveredSession {
  id: string;
  workspaceId: string;
  name: string;
  device?: string;
  endpoint: string;
  source: 'debug-event' | 'dtd';
}
export interface VmDiscoverySnapshot {
  status: 'starting' | 'ready' | 'unavailable';
  message?: string;
  candidates: VmDiscoveredSession[];
}
interface SessionInput {
  id: string;
  name: string;
  workspaceId?: string;
  projectRootPath?: string;
  debuggerType?: unknown;
  flutterMode?: unknown;
  noDebug?: unknown;
  device?: unknown;
  address?: unknown;
  source: 'debug-event' | 'dtd';
}
interface StoredSession {
  summary: VmDiscoveredSession;
  address: string;
  input: SessionInput;
}
interface DartApi {
  version: number;
  dtdUri?: string;
  onDtdUriChanged?: (listener: (uri: string | undefined) => void) => Disposable;
}
const unavailableMessage = '无法补查已有调试会话；可重新启动 Flutter 调试或手动连接。';
const nativeFlutter = (input: SessionInput) =>
  input.debuggerType === 'Flutter' &&
  (input.flutterMode === undefined || input.flutterMode === 'debug') &&
  input.noDebug !== true &&
  !(
    typeof input.device === 'string' && /^(chrome|edge|web-server)$|\bweb[- ]javascript\b/i.test(input.device)
  );
function address(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    if (!url.pathname.endsWith('/ws')) url.pathname = url.pathname.replace(/\/?$/, '/ws');
    return validateVmUrl(url.toString());
  } catch {
    return;
  }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Discovers addresses in the extension host; snapshots are safe to send to a webview. */
export class VmDiscovery {
  private readonly disposables: Disposable[] = [];
  private readonly listeners = new Set<(snapshot: VmDiscoverySnapshot) => void>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly inputs = new Map<string, SessionInput>();
  private readonly revisions = new Map<string, number>();
  private readonly stopped = new Set<string>();
  private readonly controls = new Map<string, VmDebugSession>();
  private revision = 0;
  private disposed = false;
  private started = false;
  private generation = 0;
  private daemon?: DtdClient;
  private daemonUri?: string;
  private query?: Promise<void>;
  private queryAgain = false;
  private status: VmDiscoverySnapshot['status'] = 'starting';
  private message?: string;
  private publishPaused = 0;
  private visibleCandidates: VmDiscoveredSession[] = [];

  constructor(
    private readonly host: VmDiscoveryHost,
    private readonly options: { timeoutMs?: number } = {},
  ) {
    this.disposables.push(
      host.onSessionStarted((session) => {
        this.controls.set(session.id, session);
        this.stopped.delete(session.id);
        this.changed(session.id);
      }),
      host.onSessionStopped((session) => this.stop(session.id)),
      host.onCustomEvent((event) => this.handleEvent(event)),
      host.onWorkspaceChanged(() => {
        void this.refresh();
      }),
    );
  }

  snapshot(): VmDiscoverySnapshot {
    return {
      status: this.status,
      ...(this.message ? { message: this.message } : {}),
      candidates: this.visibleCandidates.map((candidate) => ({ ...candidate })),
    };
  }
  subscribe(listener: (snapshot: VmDiscoverySnapshot) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  address(id: string): string | undefined {
    return this.sessions.get(id)?.address;
  }

  /** Targets exactly one discovered Flutter session, including pre-existing DTD sessions. */
  async control(id: string, action: 'hot_reload' | 'hot_restart'): Promise<void> {
    if (this.disposed || !this.sessions.has(id) || this.stopped.has(id))
      throw new Error('Flutter 调试会话已结束。');
    const command = action === 'hot_reload' ? 'hotReload' : 'hotRestart';
    const session = this.controls.get(id);
    if (session?.customRequest) await session.customRequest(command, { reason: 'manual' });
    else if (this.daemon) await this.daemon.call(`Editor.${command}`, { debugSessionId: id }, 30000);
    else throw new Error('无法控制此 IDE 调试会话，请重新启动或附加 Flutter Debug。');
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      const candidate = await this.host.getDartApi();
      if (this.disposed) return;
      const api = candidate as DartApi | undefined;
      if (!api || api.version < 3 || typeof api.onDtdUriChanged !== 'function') {
        this.setStatus('unavailable', unavailableMessage);
        return;
      }
      this.disposables.push(
        api.onDtdUriChanged((uri) => {
          void this.useDaemon(uri);
        }),
      );
      await this.useDaemon(api.dtdUri);
    } catch {
      if (!this.disposed) this.setStatus('unavailable', unavailableMessage);
    }
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const inputs = [...this.inputs.values()];
    await Promise.all(inputs.map((input) => this.accept(input)));
    await this.querySessions();
  }

  private changed(id: string): number {
    const revision = ++this.revision;
    this.revisions.set(id, revision);
    return revision;
  }
  private stop(id: string): void {
    this.controls.delete(id);
    this.stopped.add(id);
    this.changed(id);
    this.inputs.delete(id);
    if (this.sessions.delete(id)) this.publish();
  }
  private handleEvent(event: { session: VmDebugSession; event: string; body?: unknown }): void {
    if (this.disposed || event.session.type !== 'dart' || this.stopped.has(event.session.id)) return;
    this.controls.set(event.session.id, event.session);
    if (!['dart.debuggerUris', 'flutter.appStart'].includes(event.event)) return;
    const config = event.session.configuration;
    const body = record(event.body);
    const old = this.inputs.get(event.session.id);
    const input: SessionInput = {
      ...old,
      id: event.session.id,
      name: event.session.name,
      workspaceId: event.session.workspaceId,
      projectRootPath: typeof config.cwd === 'string' ? config.cwd : old?.projectRootPath,
      debuggerType:
        event.event === 'flutter.appStart' ? 'Flutter' : (old?.debuggerType ?? config.debuggerType),
      flutterMode:
        event.event === 'flutter.appStart'
          ? (body.mode ?? old?.flutterMode)
          : (old?.flutterMode ?? config.flutterMode),
      noDebug: config.noDebug,
      device:
        event.event === 'flutter.appStart'
          ? (body.deviceId ?? config.deviceId)
          : (old?.device ?? config.deviceId),
      address: event.event === 'dart.debuggerUris' ? body.vmServiceUri : old?.address,
      source: 'debug-event',
    };
    void this.accept(input);
  }

  private async accept(input: SessionInput, current: () => boolean = () => true): Promise<void> {
    if (this.disposed || this.stopped.has(input.id) || !current()) return;
    const revision = this.changed(input.id);
    this.inputs.set(input.id, input);
    const uri = address(input.address);
    if (!nativeFlutter(input) || !uri) {
      if (this.sessions.delete(input.id)) this.publish();
      return;
    }
    const roots = this.host.getWorkspaceRoots();
    const selectedRoot = roots.find((root) => root.id === input.workspaceId);
    const path = input.projectRootPath ?? selectedRoot?.path;
    let workspaceId: string | undefined;
    if (path && isAbsolute(path)) {
      try {
        const canonical = await realpath(path);
        const matches = (
          await Promise.all(
            roots.map(async (root) => {
              try {
                const rootPath = await realpath(root.path);
                const suffix = relative(rootPath, canonical);
                return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'))
                  ? { ...root, rootPath }
                  : undefined;
              } catch {
                return undefined;
              }
            }),
          )
        )
          .filter((value) => value !== undefined)
          .sort((a, b) => b.rootPath.length - a.rootPath.length);
        workspaceId = matches[0]?.id;
        if (input.workspaceId && workspaceId !== input.workspaceId) workspaceId = undefined;
      } catch {
        /* A removed or unresolved workspace cannot own a VM. */
      }
    }
    if (
      this.disposed ||
      this.stopped.has(input.id) ||
      this.revisions.get(input.id) !== revision ||
      !current()
    )
      return;
    if (!workspaceId || !this.host.getWorkspaceRoots().some((root) => root.id === workspaceId)) {
      if (this.sessions.delete(input.id)) this.publish();
      return;
    }
    const summary: VmDiscoveredSession = {
      id: input.id,
      workspaceId,
      name: input.name,
      ...(typeof input.device === 'string' ? { device: input.device } : {}),
      endpoint: new URL(uri).host,
      source: input.source,
    };
    const old = this.sessions.get(input.id);
    this.sessions.set(input.id, { summary, address: uri, input });
    if (!old || old.address !== uri || JSON.stringify(old.summary) !== JSON.stringify(summary))
      this.publish();
  }

  private async useDaemon(uri: string | undefined): Promise<void> {
    if (this.disposed) return;
    if (uri && uri === this.daemonUri && this.daemon) return;
    const generation = ++this.generation;
    this.daemon?.dispose();
    this.daemon = undefined;
    this.daemonUri = undefined;
    this.query = undefined;
    this.queryAgain = false;
    if (!uri) {
      this.setStatus('unavailable', unavailableMessage);
      return;
    }
    const daemon = new DtdClient(this.options.timeoutMs);
    this.daemon = daemon;
    this.daemonUri = uri;
    daemon.on('disconnected', () => {
      if (this.disposed || generation !== this.generation) return;
      this.setStatus('unavailable', unavailableMessage);
      this.daemon = undefined;
      this.daemonUri = undefined;
      daemon.dispose();
    });
    daemon.on('notification', (params: unknown) => {
      if (this.disposed || generation !== this.generation) return;
      const notification = record(params);
      const data = record(notification.eventData);
      if (
        notification.streamId === 'Service' &&
        notification.eventKind === 'ServiceRegistered' &&
        data.service === 'Editor' &&
        data.method === 'getDebugSessions'
      )
        void this.querySessions();
      if (notification.streamId === 'Editor') {
        if (notification.eventKind === 'debugSessionStopped' && typeof data.debugSessionId === 'string')
          this.stop(data.debugSessionId);
        else if (['debugSessionStarted', 'debugSessionChanged'].includes(String(notification.eventKind))) {
          const session = record(data.debugSession);
          // IDs are unique for each IDE debug session. A delayed DTD start must
          // never revive an ID already terminated by the VS Code event stream.
          void this.acceptDtd(session, () => generation === this.generation);
        }
      }
    });
    try {
      await daemon.connect(uri);
      if (this.disposed || generation !== this.generation) return;
      await Promise.all([
        daemon.call('streamListen', { streamId: 'Service' }),
        daemon.call('streamListen', { streamId: 'Editor' }),
      ]);
      if (this.disposed || generation !== this.generation) return;
      await this.querySessions();
    } catch {
      if (!this.disposed && generation === this.generation) this.setStatus('unavailable', unavailableMessage);
    }
  }

  private async acceptDtd(
    session: Record<string, unknown>,
    current: () => boolean = () => true,
  ): Promise<void> {
    if (typeof session.id !== 'string' || typeof session.name !== 'string') return;
    const old = this.inputs.get(session.id);
    await this.accept(
      {
        ...old,
        id: session.id,
        name: session.name,
        projectRootPath:
          typeof session.projectRootPath === 'string' ? session.projectRootPath : old?.projectRootPath,
        debuggerType: session.debuggerType,
        flutterMode: session.flutterMode ?? old?.flutterMode,
        device: session.flutterDeviceId ?? old?.device,
        address: session.vmServiceUri ?? old?.address,
        source: old?.source === 'debug-event' ? 'debug-event' : 'dtd',
      },
      current,
    );
  }

  private async querySessions(): Promise<void> {
    if (!this.daemon || this.disposed) return;
    if (this.query) {
      this.queryAgain = true;
      return this.query;
    }
    const daemon = this.daemon;
    const generation = this.generation;
    const before = this.revision;
    const query = (async () => {
      try {
        const result = record(await daemon.call('Editor.getDebugSessions'));
        if (this.disposed || generation !== this.generation) return;
        if (!Array.isArray(result.debugSessions)) throw new Error('Invalid DTD session result');
        this.publishPaused++;
        try {
          const ids = new Set<string>();
          await Promise.all(
            result.debugSessions.map(async (value) => {
              const session = record(value);
              if (typeof session.id !== 'string') return;
              ids.add(session.id);
              if ((this.revisions.get(session.id) ?? 0) > before || this.stopped.has(session.id)) return;
              await this.acceptDtd(session, () => generation === this.generation && daemon === this.daemon);
            }),
          );
          if (this.disposed || generation !== this.generation) return;
          for (const [id, stored] of this.sessions) {
            if (stored.summary.source === 'dtd' && !ids.has(id) && (this.revisions.get(id) ?? 0) <= before)
              this.stop(id);
          }
        } finally {
          this.publishPaused--;
        }
        if (this.disposed || generation !== this.generation) return;
        this.setStatus('ready');
      } catch {
        if (!this.disposed && generation === this.generation)
          this.setStatus('unavailable', unavailableMessage);
      }
    })();
    this.query = query;
    await query;
    if (this.query === query) {
      this.query = undefined;
      if (this.queryAgain) {
        this.queryAgain = false;
        await this.querySessions();
      }
    }
  }

  private setStatus(status: VmDiscoverySnapshot['status'], message?: string): void {
    this.status = status;
    this.message = message;
    this.publish();
  }
  private publish(): void {
    if (this.disposed || this.publishPaused > 0) return;
    this.visibleCandidates = [...this.sessions.values()].map((session) => ({ ...session.summary }));
    for (const listener of this.listeners) listener(this.snapshot());
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.daemon?.dispose();
    this.daemon = undefined;
    this.daemonUri = undefined;
    this.visibleCandidates = [];
    this.sessions.clear();
    this.inputs.clear();
    this.listeners.clear();
    this.stopped.clear();
    this.controls.clear();
    this.revisions.clear();
  }
}

/** Public VS Code/Dart APIs only; injectable so discovery can be tested without an IDE. */
export function createVscodeDiscoveryHost(api: typeof vscode): VmDiscoveryHost {
  const session = (value: vscode.DebugSession): VmDebugSession => ({
    id: value.id,
    name: value.name,
    type: value.type,
    workspaceId: value.workspaceFolder?.uri.toString(),
    configuration: value.configuration,
    customRequest: (command, args) => value.customRequest(command, args),
  });
  return {
    getWorkspaceRoots: () =>
      !api.workspace.isTrusted || api.env.remoteName || process.platform !== 'darwin'
        ? []
        : (api.workspace.workspaceFolders ?? [])
            .filter((folder) => folder.uri.scheme === 'file')
            .map((folder) => ({ id: folder.uri.toString(), path: folder.uri.fsPath })),
    onCustomEvent: (listener) =>
      api.debug.onDidReceiveDebugSessionCustomEvent((event) =>
        listener({ ...event, session: session(event.session) }),
      ),
    onSessionStarted: (listener) => api.debug.onDidStartDebugSession((value) => listener(session(value))),
    onSessionStopped: (listener) => api.debug.onDidTerminateDebugSession((value) => listener(session(value))),
    onWorkspaceChanged: (listener) => api.workspace.onDidChangeWorkspaceFolders(listener),
    getDartApi: async () => api.extensions.getExtension('Dart-Code.dart-code')?.activate(),
  };
}

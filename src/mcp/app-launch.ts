import { isAbsolute, relative, resolve } from 'node:path';
import { McpToolError } from './tools';

interface DebugTarget {
  id: string;
  name: string;
  configurationName?: string;
  deviceId?: string;
}
interface SessionEvent {
  kind: 'started' | 'stopped';
  session: DebugTarget;
}
export interface AppLaunchState {
  mode: 'vm' | 'proxy';
  connected: boolean;
  connectedSessionId?: string;
  sessions: DebugTarget[];
  candidates: DebugTarget[];
}
export interface AppLaunchHost {
  workspace: string;
  configurations(): unknown;
  state(): AppLaunchState;
  assertMutable(): void;
  lifecycleBusy(): boolean;
  start(name: string, deviceId?: string): Promise<boolean>;
  subscribeSessions(listener: (event: SessionEvent) => void): { dispose(): void };
  connect(id: string): Promise<void>;
  networkStatus(): Record<string, unknown>;
  changed?(): void;
}

export const validLaunchDeviceId = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) && !/^(chrome|edge|web-server)$/i.test(value);

// Dart Code decorates configuration.name itself with the selected device label.
// Keep the saved identity in a separate field on our submitted clone.
export const appLaunchConfigurationNameKey = '__flutterPilotConfigurationName';

/** Publish names only: launch configurations may contain environment secrets. */
export function appLaunchConfigurations(value: unknown, workspace: string): { name: string }[] {
  if (!Array.isArray(value)) return [];
  const counts = new Map<string, number>();
  for (const item of value)
    if (item && typeof item === 'object' && typeof item.name === 'string')
      counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  const eligible = value.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const config = item as Record<string, unknown>;
    if (
      typeof config.name !== 'string' ||
      !config.name.trim() ||
      config.name.length > 256 ||
      config.type !== 'dart' ||
      config.request !== 'launch' ||
      config.noDebug === true ||
      (config.flutterMode !== undefined && config.flutterMode !== 'debug') ||
      (typeof config.deviceId === 'string' && /^(chrome|edge|web-server)$/i.test(config.deviceId)) ||
      (Array.isArray(config.toolArgs) &&
        config.toolArgs.some((arg) => typeof arg === 'string' && /^--(?:release|profile)(?:=|$)/.test(arg)))
    )
      return false;
    const cwd = config.cwd ?? workspace;
    if (typeof cwd !== 'string') return false;
    const path = cwd.replace(/\$\{workspaceFolder\}/g, workspace);
    if (path.includes('${')) return false;
    const child = relative(workspace, resolve(workspace, path));
    if (isAbsolute(child) || child === '..' || child.startsWith('../')) return false;
    if (config.program !== undefined) {
      if (typeof config.program !== 'string') return false;
      const program = config.program.replace(/\$\{workspaceFolder\}/g, workspace);
      if (program.includes('${') || !program.endsWith('.dart')) return false;
      const file = relative(workspace, resolve(workspace, path, program));
      if (isAbsolute(file) || file === '..' || file.startsWith('../')) return false;
    }
    return true;
  }) as { name: string }[];
  return eligible.filter((config) => counts.get(config.name) === 1).map(({ name }) => ({ name }));
}

/** Resolve a validated existing configuration without allowing arbitrary launch arguments. */
export function appLaunchConfiguration(
  value: unknown,
  workspace: string,
  name: string,
  deviceId?: string,
): Record<string, unknown> {
  if (
    (deviceId !== undefined && !validLaunchDeviceId(deviceId)) ||
    !appLaunchConfigurations(value, workspace).some((item) => item.name === name)
  )
    throw new Error('Invalid launch configuration or device');
  const config = (value as Record<string, unknown>[]).find((item) => item.name === name)!;
  return structuredClone({
    ...config,
    [appLaunchConfigurationNameKey]: name,
    ...(deviceId !== undefined ? { deviceId } : {}),
  });
}

/** Recover only a unique saved launch identity, never an arbitrary display-name prefix. */
export function appLaunchConfigurationName(
  value: unknown,
  workspace: string,
  runtime: Record<string, unknown>,
): string | undefined {
  const allowed = new Set(appLaunchConfigurations(value, workspace).map((item) => item.name));
  if (
    !Array.isArray(value) ||
    runtime.type !== 'dart' ||
    runtime.request !== 'launch' ||
    runtime.noDebug === true ||
    (runtime.flutterMode !== undefined && runtime.flutterMode !== 'debug')
  )
    return;
  const path = (part: unknown, base: string): string | undefined => {
    if (typeof part !== 'string') return;
    const expanded = part.replace(/\$\{workspaceFolder\}/g, workspace);
    return expanded.includes('${') ? undefined : resolve(base, expanded);
  };
  const actualCwd = path(runtime.cwd ?? workspace, workspace);
  if (!actualCwd) return;
  const marker = runtime[appLaunchConfigurationNameKey];
  const names = new Set<unknown>([runtime.name]);
  // Dart Code exposes deviceName as "label (platform)". Only remove that
  // independently confirmed suffix; parentheses may be part of a saved name.
  if (typeof runtime.deviceName === 'string' && typeof runtime.name === 'string') {
    const label = /^(.*) \([^()]+\)$/.exec(runtime.deviceName)?.[1];
    const suffix = label ? ` (${label})` : undefined;
    if (suffix && runtime.name.endsWith(suffix)) names.add(runtime.name.slice(0, -suffix.length));
  }
  const matches = (value as Record<string, unknown>[]).filter((config) => {
    if (!config || typeof config !== 'object') return false;
    if (!allowed.has(config.name as string)) return false;
    if (marker !== undefined ? config.name !== marker : !names.has(config.name)) return false;
    if (path(config.cwd ?? workspace, workspace) !== actualCwd) return false;
    if (config.program !== undefined && path(config.program, actualCwd) !== path(runtime.program, actualCwd))
      return false;
    return true;
  });
  return matches.length === 1 ? (matches[0].name as string) : undefined;
}

interface LaunchAttempt {
  name: string;
  ended: boolean;
  stopped(): void;
}

/** Explicit IDE launch; a timed-out submission remains guarded against duplicate starts. */
export class McpAppLaunchController {
  private active?: LaunchAttempt;
  private pending?: LaunchAttempt;
  private readonly subscription: { dispose(): void };
  constructor(private readonly host: AppLaunchHost) {
    this.subscription = host.subscribeSessions((event) => {
      // IDE events can start and end between polling ticks, including after a timeout.
      for (const attempt of new Set([this.active, this.pending])) {
        if (!attempt || event.session.configurationName !== attempt.name) continue;
        if (this.pending === attempt) this.pending = undefined;
        if (event.kind === 'stopped') {
          attempt.ended = true;
          if (this.active === attempt) this.active = undefined;
          attempt.stopped();
        }
      }
      this.host.changed?.();
    });
  }

  dispose() {
    this.subscription.dispose();
    this.active?.stopped();
    this.active = undefined;
    this.pending = undefined;
  }

  status() {
    const configurations = appLaunchConfigurations(this.host.configurations(), this.host.workspace);
    const state = this.host.state();
    if (this.pending && state.sessions.some((session) => session.configurationName === this.pending?.name))
      this.pending = undefined;
    const supported = state.mode === 'vm' && configurations.length > 0;
    return {
      supported,
      busy: !!this.active,
      configurations,
      sessions: state.sessions.map(({ id, name, configurationName, deviceId }) => ({
        id,
        name,
        ...(configurationName ? { configurationName } : {}),
        ...(deviceId ? { deviceId } : {}),
      })),
      ...(this.pending
        ? {
            pendingConfiguration: this.pending.name,
            pendingMessage:
              'IDE 启动结果未确认；请检查调试控制台和会话，勿重复启动。启动或结束事件会解除待确认状态；若 IDE 没有产生会话，请重新加载当前 IDE 窗口。其他工作台功能仍可在启动等待结束后使用。',
          }
        : {}),
      ...(!supported ? { reason: '需要 VM 模式和当前工作区内命名且唯一的 Dart Debug launch 配置。' } : {}),
    };
  }

  async execute(
    configurationName: string,
    timeoutMs = 30000,
    signal?: AbortSignal,
    isCurrent = () => true,
    deviceId?: string,
  ) {
    const capability = this.status();
    if (capability.busy || this.host.lifecycleBusy())
      throw new McpToolError('BUSY', '应用启动或热更新仍未结束，请先检查当前调试会话，勿重复启动。');
    if (this.pending) throw new McpToolError('APP_LAUNCH_UNCONFIRMED', capability.pendingMessage!);
    this.host.assertMutable();
    if (!capability.supported) throw new McpToolError('APP_LAUNCH_UNAVAILABLE', capability.reason!);
    if (!capability.configurations.some((item) => item.name === configurationName))
      throw new McpToolError(
        'INVALID_LAUNCH_CONFIGURATION',
        '请从 capabilities.appLaunch.configurations 选择配置名称。',
      );
    if (deviceId !== undefined && !validLaunchDeviceId(deviceId))
      throw new McpToolError('INVALID_DEVICE_ID', 'deviceId 必须为原生 Flutter 设备标识，不能包含启动参数。');
    const initial = this.host.state();
    if (initial.sessions.length > 1)
      throw new McpToolError(
        'AMBIGUOUS_DEBUG_SESSION',
        '当前项目有多个调试会话，请先明确并保留要使用的会话。',
      );
    const existing = initial.sessions[0];
    if (existing && !existing.configurationName)
      throw new McpToolError(
        'APP_SESSION_UNCONFIRMED',
        '现有调试会话缺少可验证的配置名称，请在 IDE 选中该会话后重新打开工作台；不根据显示名称猜测或重复启动。',
      );
    if ((existing && existing.configurationName !== configurationName) || (initial.connected && !existing))
      throw new McpToolError('APP_ALREADY_RUNNING', '当前项目已有其他或手动连接的 VM，不替换现有应用。');
    if (existing && deviceId !== undefined && existing.deviceId !== deviceId)
      throw new McpToolError(
        'APP_DEVICE_MISMATCH',
        '现有同名调试会话的设备不同或无法确认；请检查当前会话，不替换或重启应用。',
      );
    if (signal?.aborted || !isCurrent()) throw new McpToolError('CANCELLED', '启动已取消，未发送 IDE 请求。');
    const controller = new AbortController();
    const attempt: LaunchAttempt = {
      name: configurationName,
      ended: false,
      stopped: () => controller.abort(),
    };
    this.active = attempt;
    this.host.changed?.();
    let timedOut = false;
    let submitted = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
    const check = () => {
      if (attempt.ended) throw new McpToolError('APP_EXITED', '目标调试会话已结束，请检查 IDE 调试控制台。');
      if (controller.signal.aborted)
        throw new McpToolError(
          timedOut ? 'TIMEOUT' : 'CANCELLED',
          '应用启动结果尚未确认，请检查调试会话与 list_sessions，勿自动重试。',
        );
      if (!isCurrent()) throw new McpToolError('SESSION_INVALIDATED', '项目会话已失效，请检查当前应用。');
    };
    const work = (async () => {
      try {
        check();
        if (!existing) {
          submitted = true;
          this.pending = attempt;
          let accepted: boolean;
          try {
            accepted = await this.host.start(configurationName, deviceId);
          } catch {
            if (this.pending === attempt) this.pending = undefined;
            throw new McpToolError('APP_LAUNCH_FAILED', 'IDE 启动请求失败，请检查调试控制台，勿自动重试。');
          }
          if (!accepted) {
            if (this.pending === attempt) this.pending = undefined;
            throw new McpToolError('APP_LAUNCH_REJECTED', 'IDE 未启动应用，请检查 launch 配置及设备选择。');
          }
        }
        let selected: string | undefined;
        for (;;) {
          check();
          const state = this.host.state();
          if (state.sessions.length > 1)
            throw new McpToolError(
              'AMBIGUOUS_DEBUG_SESSION',
              '启动期间出现多个调试会话，未选择或替换任何应用。',
            );
          const target = state.sessions[0];
          if (target) {
            if (!target.configurationName)
              throw new McpToolError(
                'APP_SESSION_UNCONFIRMED',
                '启动会话缺少可验证的配置名称，请检查 capabilities.appLaunch.sessions 与 IDE，不重复启动。',
              );
            if (target.configurationName !== configurationName)
              throw new McpToolError('APP_ALREADY_RUNNING', '启动期间出现其他配置的调试会话，未替换连接。');
            if (this.pending === attempt) this.pending = undefined;
            if (deviceId !== undefined && target.deviceId !== deviceId)
              throw new McpToolError(
                'APP_DEVICE_MISMATCH',
                '目标调试会话的设备不同或无法确认，未连接或替换任何应用。',
              );
            if (state.connected) {
              if (state.connectedSessionId !== target.id)
                throw new McpToolError('APP_ALREADY_RUNNING', 'VM 已连接到其他会话，未替换连接。');
              return {
                ok: true,
                action: 'start_app',
                configurationName,
                ...(deviceId ? { deviceId } : {}),
                submitted,
                reused: !!existing,
                completed: true,
                debugSessionId: target.id,
                network: this.host.networkStatus(),
                message: '当前项目 Debug App 已连接。请检查 Mock 分域状态，再显式运行 Scene 操作并验证主页。',
              };
            }
            if (!selected && state.candidates.some((item) => item.id === target.id)) {
              selected = target.id;
              await this.host.connect(target.id);
              continue;
            }
          }
          await new Promise<void>((resolve) => {
            const wake = () => {
              clearTimeout(pause);
              resolve();
            };
            const pause = setTimeout(() => {
              controller.signal.removeEventListener('abort', wake);
              resolve();
            }, 100);
            controller.signal.addEventListener('abort', wake, { once: true });
          });
        }
      } catch (error) {
        const known = error instanceof McpToolError ? error : undefined;
        return {
          ok: false,
          action: 'start_app',
          configurationName,
          ...(deviceId ? { deviceId } : {}),
          submitted,
          completed: false,
          code: known?.code ?? 'APP_LAUNCH_FAILED',
          message: known?.message ?? '启动或 VM 连接未确认，请检查 IDE 与 list_sessions，勿自动重试。',
        };
      } finally {
        if (this.active === attempt) this.active = undefined;
        this.host.changed?.();
      }
    })();
    const failure = () => ({
      ok: false,
      action: 'start_app',
      configurationName,
      ...(deviceId ? { deviceId } : {}),
      submitted,
      completed: false,
      code: attempt.ended ? 'APP_EXITED' : timedOut ? 'TIMEOUT' : 'CANCELLED',
      message: attempt.ended
        ? '目标调试会话已结束，请检查 IDE 调试控制台。'
        : '等待已结束，IDE 可能仍在编译或运行。请查询 list_sessions 与调试控制台，勿重复启动。',
    });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<ReturnType<typeof failure>>((resolve) => {
      onAbort = () => resolve(failure());
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (this.active === attempt) {
        this.active = undefined;
        this.host.changed?.();
      }
    }
  }
}

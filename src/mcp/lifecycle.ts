import type { VmServiceClient } from '../vm/client';
import { McpToolError } from './tools';

export type LifecycleAction = 'hot_reload' | 'hot_restart';
export interface LifecycleTarget {
  debugSessionId: string;
}
export interface LifecycleHost {
  target(): LifecycleTarget | undefined;
  connected(): boolean;
  rpc: Pick<VmServiceClient, 'call' | 'on' | 'off'>;
  control(target: LifecycleTarget, action: LifecycleAction): Promise<void>;
  invalidateUi(): void;
  refresh(signal: AbortSignal): Promise<void>;
  networkStatus(): Record<string, unknown>;
}

/** Serial workbench dispatch plus this in-flight guard also covers timed-out DAP requests. */
export class McpLifecycleController {
  private running = false;
  constructor(private readonly host: LifecycleHost) {}

  status() {
    const supported = this.host.connected() && !!this.host.target();
    return {
      supported,
      busy: this.running,
      ...(!supported
        ? {
            reason:
              '需要连接由当前 Cursor/VS Code 启动或附加的 Flutter Debug 会话；手动 VM 地址无法绑定时不支持。',
          }
        : {}),
    };
  }

  async execute(action: LifecycleAction, timeoutMs = 30000, signal?: AbortSignal, isCurrent = () => true) {
    if (this.running) throw new McpToolError('BUSY', '前一次热重载或热重启仍在执行，请先检查结果。');
    if (!this.host.connected()) throw new McpToolError('VM_DISCONNECTED', '请先连接 Flutter Debug VM。');
    const target = this.host.target();
    if (!target) throw new McpToolError('DEBUG_SESSION_UNAVAILABLE', this.status().reason!);
    if (signal?.aborted) throw new McpToolError('CANCELLED', '操作已取消，未发送调试请求。');
    this.running = true;
    const controller = new AbortController();
    let submitted = false;
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
    const check = () => {
      if (controller.signal.aborted)
        throw new McpToolError(
          timedOut ? 'TIMEOUT' : 'CANCELLED',
          '操作结束但执行结果未确认，请勿自动重试。',
        );
      if (
        !isCurrent() ||
        !this.host.connected() ||
        this.host.target()?.debugSessionId !== target.debugSessionId
      )
        throw new McpToolError('SESSION_INVALIDATED', 'VM 或目标调试会话已失效，请检查当前应用。');
    };
    const work = (async () => {
      let reloadObserved = false;
      let reloadFailed = false;
      let before: string[] = [];
      let beforeGroups: string[] = [];
      const notification = (message: any) => {
        const event = message?.params?.event;
        if (
          event?.kind !== 'IsolateReload' ||
          !(before.includes(event?.isolate?.id) || beforeGroups.includes(event?.isolateGroup?.id))
        )
          return;
        // Failure text may contain user source or credentials; expose only a fixed diagnostic.
        if (event.reloadFailureReason || String(event.status).toLowerCase() === 'failure')
          reloadFailed = true;
        else if (String(event.status).toLowerCase() === 'success') reloadObserved = true;
      };
      this.host.rpc.on('notification', notification);
      try {
        const initial = await this.flutterIsolates();
        before = initial.map((item) => item.id);
        beforeGroups = initial.flatMap((item) => (item.groupId ? [item.groupId] : []));
        check();
        if (!before.length)
          throw new McpToolError('FLUTTER_UNAVAILABLE', '当前 VM 未发现可热更新的 Flutter Isolate。');
        this.host.invalidateUi();
        submitted = true;
        try {
          await this.host.control(target, action);
        } catch {
          throw new McpToolError(
            'DEBUG_CONTROL_FAILED',
            'IDE 调试请求失败；应用可能已发生变化，请先检查结果，勿自动重试。',
          );
        }
        check();
        let after: string[] = [];
        for (;;) {
          if (reloadFailed)
            throw new McpToolError(
              'HOT_RELOAD_FAILED',
              'Flutter 拒绝热重载，请检查 IDE 编译诊断并修复源码。',
            );
          try {
            after = (await this.flutterIsolates()).map((item) => item.id);
          } catch {
            // Restart can remove an isolate between getVM and getIsolate.
            after = [];
          }
          check();
          const completed =
            action === 'hot_reload'
              ? reloadObserved && before.some((id) => after.includes(id))
              : after.some((id) => !before.includes(id)) && before.every((id) => !after.includes(id));
          if (completed) break;
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
          check();
        }
        let refreshError: string | undefined;
        try {
          await this.host.refresh(controller.signal);
        } catch {
          refreshError = '运行时采集/Mock 尚未确认恢复；请检查 get_network_status 后再触发业务请求。';
        }
        check();
        return {
          ok: true,
          action,
          submitted,
          completed: true,
          debugSessionId: target.debugSessionId,
          statePreserved: action === 'hot_reload',
          network: this.host.networkStatus(),
          ...(refreshError ? { warning: refreshError } : {}),
          message:
            '热更新已确认；请重新读取 UI，查询本次新网络记录验证场景。启动首请求可能早于 Mock 注入，不能仅凭重启成功判断业务结果。',
        };
      } finally {
        this.host.rpc.off('notification', notification);
        this.running = false;
      }
    })();
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () =>
        reject(
          new McpToolError(
            timedOut ? 'TIMEOUT' : 'CANCELLED',
            '热更新等待结束，执行结果未确认；请查询界面及网络结果，勿自动重试。',
          ),
        );
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      return await Promise.race([work, aborted]);
    } catch (error) {
      const known = error instanceof McpToolError ? error : undefined;
      return {
        ok: false,
        action,
        submitted,
        completed: false,
        code: known?.code ?? 'LIFECYCLE_FAILED',
        message: known?.message ?? '热更新状态查询失败，请检查当前应用；勿自动重试。',
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
  }

  private async flutterIsolates(): Promise<{ id: string; groupId?: string }[]> {
    const vm = await this.host.rpc.call<{ isolates?: { id: string; isSystemIsolate?: boolean }[] }>('getVM');
    const result: { id: string; groupId?: string }[] = [];
    for (const ref of vm.isolates ?? []) {
      if (ref.isSystemIsolate) continue;
      const isolate = await this.host.rpc.call<{ extensionRPCs?: string[]; isolateGroupId?: string }>(
        'getIsolate',
        {
          isolateId: ref.id,
        },
      );
      if (isolate.extensionRPCs?.includes('ext.flutter.reassemble'))
        result.push({ id: ref.id, groupId: isolate.isolateGroupId });
    }
    return result;
  }
}

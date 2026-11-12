import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { VmRpc } from './client';
import { dartLiteral } from './injection';

export interface UiResult {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}
export interface UiKey {
  type: 'string' | 'int';
  value: string | number;
}
export interface VmUiOptions {
  templatePath?: string;
  timeoutMs?: number;
}
type EventRpc = VmRpc & {
  on?: (name: string, listener: (event: any) => void) => void;
  off?: (name: string, listener: (event: any) => void) => void;
};
const tools = new Set([
  'probe',
  'get_ui_snapshot',
  'find_widget',
  'tap',
  'enter_text',
  'scroll',
  'wait_for_widget',
  'inspect_key_issues',
  'screenshot_targets',
  'take_screenshot',
]);
const failure = (code: string, message: string): UiResult => ({ ok: false, code, message });

/** Trusted, bounded Flutter UI operations over the existing Debug VM connection. */
export class VmUiController {
  private readonly tag = randomUUID();
  private generation = 0;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private anchor?: { isolateId: string; libraryId: string; stateId: string; zoneId: string };
  private readonly pending = new Map<
    string,
    { resolve: (value: UiResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private template?: string;
  private readonly listener = (notification: any) => {
    const event = notification?.params?.event;
    if (event?.kind === 'IsolateExit' && event?.isolate?.id === this.anchor?.isolateId) {
      this.invalidate();
      return;
    }
    const data = event?.extensionData;
    if (event?.extensionKind !== 'flutter_pilot.vm.ui' || data?.session !== this.tag) return;
    const item = this.pending.get(data.operationId);
    if (!item) return;
    this.pending.delete(data.operationId);
    clearTimeout(item.timer);
    item.resolve(
      data.result && typeof data.result.ok === 'boolean'
        ? data.result
        : failure('INVALID_RESULT', 'Flutter UI 返回无效结果。'),
    );
  };

  constructor(
    private readonly rpc: EventRpc,
    private readonly options: VmUiOptions = {},
  ) {
    rpc.on?.('notification', this.listener);
  }

  async probe(): Promise<{ supported: boolean; reason?: string; isolateId?: string }> {
    const result = await this.execute('probe', {});
    return result.ok
      ? { supported: true, isolateId: this.anchor?.isolateId }
      : { supported: false, reason: result.message };
  }

  execute(tool: string, args: Record<string, unknown> = {}): Promise<UiResult> {
    const generation = this.generation;
    const operation = this.queue.then(async () => {
      if (this.disposed || generation !== this.generation)
        return failure('SESSION_INVALIDATED', 'UI 会话已失效，请重新定位后再操作。');
      const invalid = this.validate(tool, args);
      if (invalid) return invalid;
      try {
        await this.ensureAnchor(generation);
        if (generation !== this.generation || this.disposed)
          return failure('SESSION_INVALIDATED', 'UI 会话已失效，请重新定位后再操作。');
        return await this.dispatch(tool, args, generation);
      } catch {
        // VM exceptions may contain expressions, authentication URLs or input text.
        return failure('UI_UNAVAILABLE', '无法执行 Flutter UI 操作，请检查 Debug VM 连接及 Flutter 兼容性。');
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private validate(tool: string, args: Record<string, unknown>): UiResult | undefined {
    if (!tools.has(tool)) return failure('UNKNOWN_TOOL', '不支持此 UI 工具。');
    if (
      tool === 'take_screenshot' &&
      ((args.mode !== 'screen' && args.mode !== 'long') ||
        (args.mode === 'long' && typeof args.targetId !== 'string'))
    )
      return failure('INVALID_ARGUMENT', '请选择截图模式和长图滚动区域。');
    const validKey = (key: unknown): key is UiKey => {
      if (!key || typeof key !== 'object') return false;
      const item = key as UiKey;
      return (
        (item.type === 'string' && typeof item.value === 'string' && item.value.length <= 512) ||
        (item.type === 'int' && typeof item.value === 'number' && Number.isSafeInteger(item.value))
      );
    };
    if (
      (['find_widget', 'tap', 'enter_text', 'scroll', 'wait_for_widget'].includes(tool) &&
        !validKey(args.key)) ||
      (args.ancestor !== undefined && !validKey(args.ancestor))
    )
      return failure('INVALID_ARGUMENT', '请提供字符串或安全整数类型的稳定 ValueKey。');
    if (tool === 'enter_text' && (typeof args.text !== 'string' || args.text.length > 16384))
      return failure('INVALID_ARGUMENT', '输入文本必须为字符串，且不超过 16384 个字符。');
    if (
      tool === 'scroll' &&
      (!['up', 'down', 'left', 'right'].includes(String(args.direction ?? 'down')) ||
        (args.distance !== undefined &&
          (typeof args.distance !== 'number' ||
            !Number.isFinite(args.distance) ||
            args.distance <= 0 ||
            args.distance > 2000)))
    )
      return failure('INVALID_ARGUMENT', '滚动方向或距离无效。');
    if (
      args.timeoutMs !== undefined &&
      (typeof args.timeoutMs !== 'number' ||
        !Number.isFinite(args.timeoutMs) ||
        args.timeoutMs < 1 ||
        args.timeoutMs > 30000)
    )
      return failure('INVALID_ARGUMENT', '等待时间需介于 1 与 30000 毫秒。');
    if (
      tool === 'wait_for_widget' &&
      !['present', 'absent', 'visible', 'enabled', 'actionable'].includes(
        String(args.condition ?? args.state ?? 'present'),
      )
    )
      return failure('INVALID_ARGUMENT', '不支持此等待条件。');
    if (
      args.limit !== undefined &&
      (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500)
    )
      return failure('INVALID_ARGUMENT', '结果数量需介于 1 与 500。');
    if (args.targetKey !== undefined && !validKey(args.targetKey))
      return failure('INVALID_ARGUMENT', '滚动目标必须提供稳定 ValueKey。');
    if (
      args.maxSteps !== undefined &&
      (typeof args.maxSteps !== 'number' ||
        !Number.isInteger(args.maxSteps) ||
        args.maxSteps < 1 ||
        args.maxSteps > 30)
    )
      return failure('INVALID_ARGUMENT', '滚动步数需介于 1 与 30。');
    if (
      args.maxNodes !== undefined &&
      (typeof args.maxNodes !== 'number' ||
        !Number.isInteger(args.maxNodes) ||
        args.maxNodes < 1 ||
        args.maxNodes > 1000)
    )
      return failure('INVALID_ARGUMENT', '快照节点数需介于 1 与 1000。');
    return undefined;
  }

  private async evaluate(
    isolateId: string,
    libraryId: string,
    expression: string,
    scope: Record<string, string> = {},
    zoneId?: string,
  ) {
    const result = await this.rpc.call<any>('evaluate', {
      isolateId,
      targetId: libraryId,
      expression,
      scope,
      disableBreakpoints: true,
      ...(zoneId ? { idZoneId: zoneId } : {}),
    });
    if (result.type === 'Error' || result.type === '@Error' || result.type === 'Sentinel')
      throw new Error('Flutter UI evaluate failed');
    return result;
  }

  private async ensureAnchor(generation: number) {
    const vm = await this.rpc.call<any>('getVM');
    const isolates = (vm.isolates ?? []).filter((item: any) => !item.isSystemIsolate);
    if (this.anchor && isolates.some((item: any) => item.id === this.anchor!.isolateId)) return;
    if (this.anchor) this.invalidate();
    if (generation !== this.generation) throw new Error('generation changed');
    for (const isolate of isolates) {
      const info = await this.rpc.call<any>('getIsolate', { isolateId: isolate.id });
      const library = info.libraries?.find(
        (item: any) => item.uri === 'package:flutter/src/widgets/editable_text.dart',
      );
      const developer = info.libraries?.find((item: any) => item.uri === 'dart:developer');
      const convert = info.libraries?.find((item: any) => item.uri === 'dart:convert');
      if (!library || !developer || !convert) continue;
      const emitter = await this.evaluate(isolate.id, developer.id, 'postEvent');
      const decoder = await this.evaluate(isolate.id, convert.id, 'jsonDecode');
      const encoder = await this.evaluate(isolate.id, convert.id, 'base64Encode');
      const inspector = info.libraries?.find(
        (item: any) => item.uri === 'package:flutter/src/widgets/widget_inspector.dart',
      );
      const location = inspector
        ? await this.evaluate(
            isolate.id,
            inspector.id,
            '((dynamic element) { try { return _getCreationLocation(element)?.toJsonMap(); } catch (_) { return null; } })',
          ).catch(() => undefined)
        : undefined;
      const zone = await this.rpc.call<any>('createIdZone', {
        isolateId: isolate.id,
        backingBufferKind: 'Ring',
        idAssignmentPolicy: 'AlwaysAllocate',
        capacity: 1,
      });
      try {
        if (!this.template) {
          this.template = await readFile(
            this.options.templatePath ?? join(__dirname, '../../resources/vm/ui.dart.txt'),
            'utf8',
          );
        }
        const screenshotTemplate = await readFile(
          join(
            this.options.templatePath
              ? dirname(this.options.templatePath)
              : join(__dirname, '../../resources/vm'),
            'screenshot.dart.txt',
          ),
          'utf8',
        );
        const template = this.template
          .replace('__SCREENSHOT__', screenshotTemplate)
          .split(/\r?\n/)
          .filter((line) => !line.trimStart().startsWith('//'))
          .join(' ')
          .replaceAll('__SESSION__', dartLiteral(this.tag))
          .replaceAll('__LOCATION__', location ? 'creationLocation' : '((dynamic e) => null)');
        const result = await this.evaluate(
          isolate.id,
          library.id,
          template,
          {
            emitEvent: emitter.id,
            decodeArgs: decoder.id,
            encodeBytes: encoder.id,
            ...(location ? { creationLocation: location.id } : {}),
          },
          zone.id,
        );
        if (generation !== this.generation || this.disposed) throw new Error('generation changed');
        this.anchor = {
          isolateId: isolate.id,
          libraryId: library.id,
          stateId: result.id,
          zoneId: zone.id,
        };
        return;
      } catch (error) {
        await this.rpc.call('deleteIdZone', { isolateId: isolate.id, idZoneId: zone.id }).catch(() => {});
        throw error;
      }
    }
    throw new Error('No supported Flutter UI isolate');
  }

  private async dispatch(tool: string, args: Record<string, unknown>, generation: number): Promise<UiResult> {
    const anchor = this.anchor!;
    const operationId = randomUUID();
    const timeout =
      this.options.timeoutMs ??
      (tool === 'take_screenshot' ? 65000 : Math.max(20000, Number(args.timeoutMs ?? 0) + 2000));
    const result = new Promise<UiResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(operationId);
        // A timed-out click may already have executed. Never retry it automatically.
        this.invalidate();
        resolve(failure('TIMEOUT', 'UI 操作超时，结果未知；请先检查界面，避免重复操作。'));
      }, timeout);
      this.pending.set(operationId, { resolve, timer });
    });
    try {
      await this.evaluate(
        anchor.isolateId,
        anchor.libraryId,
        `state['launch'](${dartLiteral(operationId)}, ${dartLiteral(tool)}, ${dartLiteral(JSON.stringify(args))})`,
        { state: anchor.stateId },
      );
    } catch {
      const pending = this.pending.get(operationId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(operationId);
        pending.resolve(failure('UI_UNAVAILABLE', 'Flutter UI 操作未能确认完成。'));
      }
    }
    const value = await result;
    return generation === this.generation || value.code === 'TIMEOUT'
      ? value
      : failure('SESSION_INVALIDATED', 'UI 会话已失效，请重新定位后再操作。');
  }

  invalidate(): void {
    ++this.generation;
    const anchor = this.anchor;
    this.anchor = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(failure('SESSION_INVALIDATED', 'UI 会话已失效，请重新定位后再操作。'));
    }
    this.pending.clear();
    if (anchor)
      void this.evaluate(anchor.isolateId, anchor.libraryId, "state['active'] = false", {
        state: anchor.stateId,
      })
        .catch(() => {})
        .finally(() =>
          this.rpc
            .call('deleteIdZone', { isolateId: anchor.isolateId, idZoneId: anchor.zoneId })
            .catch(() => {}),
        );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    this.rpc.off?.('notification', this.listener);
  }
}

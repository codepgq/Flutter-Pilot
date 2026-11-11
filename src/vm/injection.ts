import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryEntry, Rule } from '../model';
import { validateRuleDocument } from '../model';
import type { VmRpc } from './client';

export interface InjectionResult {
  instances: number;
  warnings: string[];
}
interface Anchor {
  isolateId: string;
  libraryId: string;
  stateId: string;
  zoneId: string;
  rules: string;
}

/** Dart expression string literals must also escape interpolation, unlike JSON. */
export const dartLiteral = (value: string): string => JSON.stringify(value).replace(/\$/g, '\\$');

/** Translate the existing fnmatch path syntax; other matching remains in Dart. */
export function globRegex(pattern: string): string {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i];
    if (character === '*') {
      if (pattern[i - 1] !== '*') result += '.*';
    } else if (character === '?') result += '.';
    else if (character === '[') {
      let end = i + 1;
      if (pattern[end] === '!') end++;
      if (pattern[end] === ']') end++;
      while (end < pattern.length && pattern[end] !== ']') end++;
      if (end >= pattern.length) result += '\\[';
      else {
        let content = pattern.slice(i + 1, end);
        const negate = content.startsWith('!');
        if (negate) content = content.slice(1);
        content = content.replace(/\\/g, '\\\\');
        if (content.startsWith('^') || content.startsWith(']')) content = '\\' + content;
        const characterClass = '[' + (negate ? '^' : '') + content + ']';
        try {
          new RegExp(characterClass);
          result += characterClass;
        } catch {
          result += '(?!)';
        }
        i = end;
      }
    } else result += character.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return result + '$';
}

/** Debug-only, lease-bound Dio 5 interception without changing application files. */
export class DioVmInjector extends EventEmitter {
  private readonly session = randomUUID();
  private readonly anchors = new Map<string, Anchor>();
  private template?: string;
  private disposed = false;
  private unsafeUntil = 0;
  private operation: Promise<unknown> = Promise.resolve();

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private readonly listener: (notification: any) => void;

  constructor(
    private readonly rpc: VmRpc,
    private readonly options: { templatePath?: string } = {},
  ) {
    super();
    this.listener = (notification: any) => {
      const event = notification?.params?.event;
      if (event?.extensionKind !== 'flutter_pilot.vm.flow' || event.extensionData?.session !== this.session)
        return;
      const entry = event.extensionData.entry as HistoryEntry;
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        typeof entry.startedAt !== 'number' ||
        !entry.originalRequest ||
        !entry.request
      )
        return;
      this.emit('history', entry);
    };
    (rpc as VmRpc & { on?: (event: string, listener: (value: any) => void) => void }).on?.(
      'notification',
      this.listener,
    );
  }

  private async evaluate(
    isolateId: string,
    targetId: string,
    expression: string,
    scope: Record<string, string> = {},
    idZoneId?: string,
  ): Promise<any> {
    const value = await this.rpc.call<any>('evaluate', {
      isolateId,
      targetId,
      expression,
      scope,
      disableBreakpoints: true,
      ...(idZoneId ? { idZoneId } : {}),
    });
    if (value.type === '@Error' || value.type === 'Error' || value.type === 'Sentinel') {
      // Never include expressions or user rule bodies in diagnostics.
      throw new Error(`VM 无法安装 Dio 拦截：${value.kind ?? value.type}（仅支持 Debug / JIT）`);
    }
    return value;
  }

  private async discover(
    isolateId: string,
  ): Promise<{ libraryId?: string; instances: { id: string }[]; total: number }> {
    const isolate = await this.rpc.call<any>('getIsolate', { isolateId });
    const library = isolate.libraries?.find((item: any) => item.uri === 'package:dio/src/dio_mixin.dart');
    if (!library) return { instances: [], total: 0 };
    const classes = await this.rpc.call<any>('getClassList', { isolateId });
    const dio = classes.classes?.find(
      (item: any) => item.name === 'Dio' && item.library?.uri === 'package:dio/src/dio.dart',
    );
    if (!dio) return { libraryId: library.id, instances: [], total: 0 };
    const result = await this.rpc.call<any>('getInstances', {
      isolateId,
      objectId: dio.id,
      limit: 128,
      includeSubclasses: true,
      includeImplementers: true,
    });
    return { libraryId: library.id, instances: result.instances ?? [], total: result.totalCount ?? 0 };
  }

  sync(isolateId: string, rules: Rule[]): Promise<InjectionResult> {
    return this.enqueue(() => this.syncNow(isolateId, rules));
  }

  private async syncNow(isolateId: string, rules: Rule[]): Promise<InjectionResult> {
    if (this.disposed) throw new Error('VM 拦截会话已关闭');
    if (Date.now() < this.unsafeUntil)
      throw new Error('上次 VM 拦截安装或卸载未确认，请等待旧规则 15 秒租约到期后重试');
    validateRuleDocument({ version: 1, rules });
    const warnings = ['实验功能：仅 Debug / Dio 5；新 Dio 实例在下一次扫描后接入；不支持手动断点。'];
    if (rules.some((rule) => rule.enabled && (rule.breakpoint?.request || rule.breakpoint?.response)))
      warnings.push('已启用规则中的手动断点在 VM 模式下不会暂停请求。');
    const serialized = JSON.stringify(
      rules
        .filter((rule) => rule.enabled)
        .map((rule, index) => ({
          ...rule,
          _index: index,
          ...(rule.match.path ? { _pathRegex: globRegex(rule.match.path) } : {}),
        }))
        .sort((a, b) => b.priority - a.priority || a._index - b._index),
    );
    if (Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024)
      throw new Error('VM 模式已启用规则的总快照超过 2 MiB，请减少规则或正文');
    const found = await this.discover(isolateId);
    if (!found.libraryId)
      return {
        instances: 0,
        warnings: [...warnings, '此 Isolate 未加载受支持的 Dio 5；可使用 VM 观察模式。'],
      };
    if (!found.instances.length)
      return { instances: 0, warnings: [...warnings, '尚未创建 Dio 实例，等待下一次扫描。'] };
    if (found.total > 128) warnings.push('当前只接入前 128 个 Dio 实例；其余实例未保证覆盖。');
    const scope = Object.fromEntries(found.instances.map((item, index) => [`client${index}`, item.id]));
    const list = `[${found.instances.map((_, index) => `client${index}`).join(',')}]`;
    const anchor = this.anchors.get(isolateId);
    if (anchor) {
      const update =
        anchor.rules === serialized ? '' : `state['rules'] = jsonDecode(${dartLiteral(serialized)});`;
      const updated = await this.evaluate(
        isolateId,
        found.libraryId,
        `(() { ${update} state['enabled'] = true; state['expiresAt'] = DateTime.now().millisecondsSinceEpoch + 15000; state['installed'] = 0; for (final client in ${list}) { if (state['install'](client)) state['installed']++; } return state['installed']; })()`,
        { ...scope, state: anchor.stateId },
      );
      anchor.rules = serialized;
      const count =
        updated.valueAsString === undefined ? found.instances.length : Number(updated.valueAsString);
      if (count < found.instances.length) warnings.push('部分自定义 Dio 实例无法添加拦截器，已保持原样。');
      return { instances: count, warnings };
    }
    const isolate = await this.rpc.call<any>('getIsolate', { isolateId });
    const developer = isolate.libraries?.find((item: any) => item.uri === 'dart:developer');
    if (!developer) throw new Error('VM 缺少 dart:developer 事件通道');
    const emitEvent = await this.evaluate(isolateId, developer.id, 'postEvent');
    const zone = await this.rpc.call<any>('createIdZone', {
      isolateId,
      backingBufferKind: 'Ring',
      idAssignmentPolicy: 'AlwaysAllocate',
      capacity: 1,
    });
    try {
      if (!this.template) {
        try {
          this.template = await readFile(
            this.options.templatePath ?? join(__dirname, '../resources/vm/interceptor.dart.txt'),
            'utf8',
          );
        } catch (error) {
          if (this.options.templatePath) throw error;
          this.template = await readFile(join(__dirname, '../../resources/vm/interceptor.dart.txt'), 'utf8');
        }
      }
      const replacements: Record<string, string> = {
        __RULES__: dartLiteral(serialized),
        __TAG__: dartLiteral(this.session),
        __CLIENTS__: list,
      };
      const trustedTemplate = this.template
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('//'))
        .join(' ');
      const expression = trustedTemplate.replace(
        /__RULES__|__TAG__|__CLIENTS__/g,
        (marker) => replacements[marker],
      );
      const result = await this.evaluate(
        isolateId,
        found.libraryId,
        expression,
        { ...scope, emitEvent: emitEvent.id },
        zone.id,
      );
      this.anchors.set(isolateId, {
        isolateId,
        libraryId: found.libraryId,
        stateId: result.id,
        zoneId: zone.id,
        rules: serialized,
      });
      const installed = await this.evaluate(isolateId, found.libraryId, `state['installed']`, {
        state: result.id,
      });
      const count =
        installed.valueAsString === undefined ? found.instances.length : Number(installed.valueAsString);
      if (count < found.instances.length) warnings.push('部分自定义 Dio 实例无法添加拦截器，已保持原样。');
      return { instances: count, warnings };
    } catch (error) {
      if (!this.anchors.has(isolateId)) {
        this.unsafeUntil = Date.now() + 16000;
        await this.rpc.call('deleteIdZone', { isolateId, idZoneId: zone.id }).catch(() => undefined);
      }
      throw error;
    }
  }

  heartbeat(): Promise<void> {
    return this.enqueue(() => this.heartbeatNow());
  }

  private async heartbeatNow(): Promise<void> {
    if (!this.anchors.size || this.disposed) return;
    const vm = await this.rpc.call<any>('getVM');
    const active = new Set((vm.isolates ?? []).map((isolate: any) => isolate.id));
    let failure: unknown;
    for (const anchor of this.anchors.values()) {
      if (!active.has(anchor.isolateId)) {
        this.anchors.delete(anchor.isolateId);
        continue;
      }
      try {
        await this.evaluate(
          anchor.isolateId,
          anchor.libraryId,
          `(() { if (state['enabled'] == true) state['expiresAt'] = DateTime.now().millisecondsSinceEpoch + 15000; return null; })()`,
          { state: anchor.stateId },
        );
      } catch (error) {
        failure = error; // Keep live anchors: a transient RPC error must not install duplicate hooks.
      }
    }
    if (failure) throw failure;
  }

  detach(): Promise<void> {
    return this.enqueue(() => this.detachNow());
  }

  private async detachNow(): Promise<void> {
    let failed = false;
    for (const anchor of this.anchors.values()) {
      try {
        await this.evaluate(
          anchor.isolateId,
          anchor.libraryId,
          `(() { state['enabled'] = false; state['expiresAt'] = 0; return null; })()`,
          { state: anchor.stateId },
        );
        const found = await this.discover(anchor.isolateId);
        for (const client of found.instances)
          await this.evaluate(anchor.isolateId, anchor.libraryId, `state['remove'](client)`, {
            state: anchor.stateId,
            client: client.id,
          });
      } catch {
        failed = true; // Runtime effects may remain until the lease expires.
      }
      await this.rpc
        .call('deleteIdZone', { isolateId: anchor.isolateId, idZoneId: anchor.zoneId })
        .catch(() => undefined);
    }
    this.anchors.clear();
    if (failed) {
      this.unsafeUntil = Date.now() + 16000;
      throw new Error('VM 拦截未能完整卸载，旧规则将在最后一次续约后 15 秒内失效');
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    try {
      await this.detach();
    } finally {
      (this.rpc as VmRpc & { off?: (event: string, listener: (value: any) => void) => void }).off?.(
        'notification',
        this.listener,
      );
    }
  }
}

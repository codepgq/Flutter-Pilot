import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { VmUiController } from '../src/vm/ui';

class UiRpc extends EventEmitter {
  calls: { method: string; params: Record<string, any> }[] = [];
  events: { session: string; operationId: string }[] = [];
  autoComplete = true;
  failEvaluate = false;
  noFlutter = false;
  session = '';
  async call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'getVM') return { isolates: [{ id: 'isolates/ui' }] } as T;
    if (method === 'getIsolate')
      return {
        libraries: this.noFlutter
          ? []
          : [
              { id: 'libraries/ui', uri: 'package:flutter/src/widgets/editable_text.dart' },
              { id: 'libraries/developer', uri: 'dart:developer' },
              { id: 'libraries/convert', uri: 'dart:convert' },
              { id: 'libraries/inspector', uri: 'package:flutter/src/widgets/widget_inspector.dart' },
            ],
      } as T;
    if (method === 'createIdZone') return { id: 'zones/ui' } as T;
    if (method === 'evaluate') {
      if (this.failEvaluate) throw new Error('secret ws://localhost/token text private');
      if (params.idZoneId) {
        this.session = /'session':\s*"([^"]+)"/.exec(params.expression)?.[1] ?? '';
      }
      if (params.expression.startsWith("state['launch'](")) {
        const operationId = /state\['launch'\]\("([^"]+)"/.exec(params.expression)![1];
        const event = { session: this.session, operationId };
        this.events.push(event);
        if (this.autoComplete) setTimeout(() => this.complete(event), 2);
      }
      return { id: 'objects/ui', type: '@Instance', kind: 'Map' } as T;
    }
    return { type: 'Success' } as T;
  }
  complete(event = this.events.at(-1)!, result = { ok: true }) {
    this.emit('notification', {
      params: { event: { extensionKind: 'flutter_pilot.vm.ui', extensionData: { ...event, result } } },
    });
  }
}
const key = { type: 'string', value: 'submit' };
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 15));
};

describe('Flutter VM UI controller', () => {
  it('probes a loaded Flutter runtime and anchors the trusted template once', async () => {
    const rpc = new UiRpc();
    const ui = new VmUiController(rpc);
    expect(await ui.probe()).toEqual({ supported: true, isolateId: 'isolates/ui' });
    expect((await ui.execute('find_widget', { key })).ok).toBe(true);
    expect(rpc.calls.filter((call) => call.params.idZoneId)).toHaveLength(1);
    await ui.dispose();
    expect(rpc.listenerCount('notification')).toBe(0);
  });
  it('does not claim support for a non-Flutter isolate and redacts VM failures', async () => {
    const rpc = new UiRpc();
    const ui = new VmUiController(rpc);
    rpc.noFlutter = true;
    expect((await ui.probe()).supported).toBe(false);
    rpc.noFlutter = false;
    rpc.failEvaluate = true;
    const result = await ui.execute('find_widget', { key });
    expect(result.code).toBe('UI_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('ws://');
    await ui.dispose();
  });
  it('rejects text selectors, unsafe integers and unbounded arguments before any RPC', async () => {
    const rpc = new UiRpc();
    const ui = new VmUiController(rpc);
    for (const [tool, args] of [
      ['find_widget', { text: 'Submit' }],
      ['find_widget', { key: { type: 'int', value: Number.MAX_SAFE_INTEGER + 1 } }],
      ['tap', { key, ancestor: 'page' }],
      ['enter_text', { key, text: 'x'.repeat(16385) }],
      ['scroll', { key, distance: Infinity }],
      ['scroll', { key, maxSteps: 31 }],
      ['scroll', { key, targetKey: 'target' }],
      ['wait_for_widget', { key, timeoutMs: 30001 }],
      ['wait_for_widget', { key, state: 'unbounded' }],
      ['get_ui_snapshot', { maxNodes: 1001 }],
      ['evaluate', { expression: 'print(1)' }],
    ] as const)
      expect((await ui.execute(tool, args)).ok).toBe(false);
    expect(rpc.calls).toHaveLength(0);
    await ui.dispose();
  });
  it('escapes interpolation and never concatenates text as executable Dart', async () => {
    const rpc = new UiRpc();
    const ui = new VmUiController(rpc);
    await ui.execute('enter_text', { key, text: '$HOME ${throw 1} "中文"' });
    const expression = rpc.calls.find((call) => call.params.expression?.startsWith("state['launch']("))!
      .params.expression;
    expect(expression).toContain('\\$HOME');
    expect(expression).toContain('\\${throw 1}');
    await ui.dispose();
  });
  it('serializes concurrent writes and waits for correlated extension completion', async () => {
    const rpc = new UiRpc();
    rpc.autoComplete = false;
    const ui = new VmUiController(rpc);
    const first = ui.execute('tap', { key });
    const second = ui.execute('tap', { key });
    await flush();
    expect(rpc.events).toHaveLength(1);
    rpc.complete({ session: 'wrong', operationId: rpc.events[0].operationId });
    await flush();
    expect(rpc.events).toHaveLength(1);
    rpc.complete(rpc.events[0]);
    expect((await first).ok).toBe(true);
    await flush();
    expect(rpc.events).toHaveLength(2);
    rpc.complete(rpc.events[1]);
    expect((await second).ok).toBe(true);
    await ui.dispose();
  });
  it('invalidates active and queued operations and ignores delayed results', async () => {
    const rpc = new UiRpc();
    rpc.autoComplete = false;
    const ui = new VmUiController(rpc);
    const active = ui.execute('wait_for_widget', { key });
    const queued = ui.execute('tap', { key });
    await flush();
    const old = rpc.events[0];
    ui.invalidate();
    expect((await active).code).toBe('SESSION_INVALIDATED');
    expect((await queued).code).toBe('SESSION_INVALIDATED');
    expect(rpc.events).toHaveLength(1);
    rpc.complete(old);
    rpc.autoComplete = true;
    expect((await ui.probe()).supported).toBe(true);
    expect(rpc.calls.filter((call) => call.method === 'createIdZone')).toHaveLength(2);
    await ui.dispose();
  });
  it('returns timeout uncertainty without replaying a possibly completed action', async () => {
    const rpc = new UiRpc();
    rpc.autoComplete = false;
    const ui = new VmUiController(rpc, { timeoutMs: 30 });
    const first = ui.execute('tap', { key });
    const queued = ui.execute('tap', { key });
    expect((await first).code).toBe('TIMEOUT');
    expect((await queued).code).toBe('SESSION_INVALIDATED');
    expect(rpc.events).toHaveLength(1);
    rpc.complete();
    await ui.dispose();
  });
  it('automatically drops an exited isolate and probes its replacement', async () => {
    const rpc = new UiRpc();
    const ui = new VmUiController(rpc);
    expect((await ui.probe()).supported).toBe(true);
    rpc.emit('notification', { params: { event: { kind: 'IsolateExit', isolate: { id: 'isolates/ui' } } } });
    expect((await ui.probe()).supported).toBe(true);
    expect(rpc.calls.filter((call) => call.method === 'createIdZone')).toHaveLength(2);
    await ui.dispose();
  });
});

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DioVmInjector, dartLiteral, globRegex } from '../src/vm/injection';
import type { Rule } from '../src/model';

const rules: Rule[] = [
  {
    id: 'mock',
    name: 'mock',
    enabled: true,
    priority: 0,
    match: { path: '/mock' },
    mock: { status: 200, headers: {}, body: '{"text":"$HOME ${1 + 1}"}' },
  },
];
class FakeRpc extends EventEmitter {
  calls: { method: string; params: Record<string, any> }[] = [];
  activeIsolates = ['isolates/1'];
  gate?: Promise<void>;
  failEvaluate = false;
  totalCount = 2;
  installed?: number;
  async call<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'getVM') return { isolates: this.activeIsolates.map((id) => ({ id })) } as T;
    if (method === 'getIsolate') {
      if (this.gate) {
        const wait = this.gate;
        this.gate = undefined;
        await wait;
      }
      return {
        libraries: [
          { id: 'libraries/dio', uri: 'package:dio/src/dio_mixin.dart' },
          { id: 'libraries/developer', uri: 'dart:developer' },
        ],
      } as T;
    }
    if (method === 'getClassList')
      return {
        classes: [{ id: 'classes/Dio', name: 'Dio', library: { uri: 'package:dio/src/dio.dart' } }],
      } as T;
    if (method === 'getInstances')
      return {
        totalCount: this.totalCount,
        instances: [{ id: 'objects/client1' }, { id: 'objects/client2' }],
      } as T;
    if (method === 'createIdZone') return { id: 'zones/anchor' } as T;
    if (method === 'evaluate' && this.failEvaluate) throw new Error('temporary evaluate failure');
    if (method === 'evaluate')
      return {
        type: '@Instance',
        id: params.idZoneId ? 'objects/anchor' : 'objects/result',
        kind: 'Map',
        ...(this.installed === undefined ? {} : { valueAsString: String(this.installed) }),
      } as T;
    return { type: 'Success' } as T;
  }
}

describe('VM Dio injection lifecycle', () => {
  it('rejects known partial coverage for stateful tests while retaining ordinary Mock warning behavior', async () => {
    const rpc = new FakeRpc();
    const injector = new DioVmInjector(rpc);
    const stateful = [{ ...rules[0], scenario: { id: 'run', initial: 'empty', when: 'empty' } }];
    rpc.totalCount = 129;
    await expect(injector.sync('isolates/1', stateful)).rejects.toThrow('全部 Dio');
    expect(rpc.calls.some((call) => call.method === 'createIdZone')).toBe(false);
    const ordinary = await injector.sync('isolates/1', rules);
    expect(ordinary.warnings.join(' ')).toContain('128');
    rpc.totalCount = 2;
    rpc.installed = 1;
    await expect(injector.sync('isolates/1', stateful)).rejects.toThrow('未接入全部 Dio');
    expect((await injector.sync('isolates/1', rules)).warnings.join(' ')).toContain('部分自定义 Dio');
    await injector.dispose();
  });
  it('rejects an incomplete first stateful installation so its owning session can roll it back', async () => {
    const rpc = new FakeRpc();
    rpc.installed = 1;
    const injector = new DioVmInjector(rpc);
    await expect(
      injector.sync('isolates/1', [
        { ...rules[0], scenario: { id: 'run', initial: 'empty', when: 'empty' } },
      ]),
    ).rejects.toThrow('未接入全部 Dio');
    await injector.detach();
    expect(rpc.calls.some((call) => call.method === 'deleteIdZone')).toBe(true);
    await injector.dispose();
  });
  it('escapes Dart interpolation and fnmatch characters without interpreting rule text as code', () => {
    expect(dartLiteral('$HOME ${1+1}')).toBe('"\\$HOME \\${1+1}"');
    for (const [pattern, path, expected] of [
      ['/v1/*', '/v1/a/b', true],
      ['/v1/?', '/v1/ab', false],
      ['/v1/[!a]', '/v1/b', true],
      ['/v1/[!a]', '/v1/a', false],
      ['/v1/[^a]', '/v1/^', true],
      ['/v1/[^a]', '/v1/\\', false],
      ['/v1/[]a]', '/v1/]', true],
      ['/v1/[', '/v1/[', true],
      ['/v1/a.b', '/v1/axb', false],
      ['/v1/[z-a]', '/v1/z', false],
    ] as const)
      expect(new RegExp(globRegex(pattern)).test(path)).toBe(expected);
  });
  it('installs once, updates only rule data, then detaches and can install again', async () => {
    const rpc = new FakeRpc();
    const injector = new DioVmInjector(rpc);
    const result = await injector.sync('isolates/1', rules);
    expect(result.instances).toBe(2);
    const installs = () => rpc.calls.filter((x) => x.method === 'evaluate' && x.params.idZoneId);
    expect(installs()).toHaveLength(1);
    expect(installs()[0].params.expression).toContain('\\$HOME');
    expect(installs()[0].params.expression).not.toContain('\n');
    await injector.sync('isolates/1', rules);
    expect(installs()).toHaveLength(1);
    await injector.sync('isolates/1', [{ ...rules[0], enabled: false }]);
    expect(rpc.calls.at(-1)?.params.expression).toContain("state['rules'] = jsonDecode(");
    await injector.detach();
    expect(
      rpc.calls.some(
        (x) => x.method === 'evaluate' && x.params.expression.includes("state['enabled'] = false"),
      ),
    ).toBe(true);
    expect(rpc.calls.some((x) => x.method === 'deleteIdZone')).toBe(true);
    await injector.sync('isolates/1', rules);
    expect(installs()).toHaveLength(2);
    await injector.dispose();
    expect(rpc.listenerCount('notification')).toBe(0);
    await expect(injector.sync('isolates/1', rules)).rejects.toThrow('已关闭');
  });
  it('serializes detach with an in-flight discovery so no interceptors survive completed detach', async () => {
    const rpc = new FakeRpc();
    const injector = new DioVmInjector(rpc);
    let release!: () => void;
    rpc.gate = new Promise((r) => (release = r));
    const installing = injector.sync('isolates/1', rules);
    await new Promise((r) => setTimeout(r, 0));
    const stopping = injector.detach();
    release();
    await installing;
    await stopping;
    const installIndex = rpc.calls.findIndex((x) => x.method === 'evaluate' && x.params.idZoneId);
    const disableIndex = rpc.calls.findIndex(
      (x) => x.method === 'evaluate' && x.params.expression.includes("state['enabled'] = false"),
    );
    expect(installIndex).toBeGreaterThan(-1);
    expect(disableIndex).toBeGreaterThan(installIndex);
    await injector.dispose();
  });
  it('removes expired-isolate anchors before renewing leases for live isolates', async () => {
    const rpc = new FakeRpc();
    const injector = new DioVmInjector(rpc);
    await injector.sync('isolates/old', rules);
    await injector.sync('isolates/1', rules);
    rpc.calls = [];
    await injector.heartbeat();
    const renewals = rpc.calls.filter((x) => x.method === 'evaluate');
    expect(renewals).toHaveLength(1);
    expect(renewals[0].params.isolateId).toBe('isolates/1');
    await injector.dispose();
  });
  it('retains live anchors after transient heartbeat failure instead of installing duplicate hooks', async () => {
    const rpc = new FakeRpc();
    const injector = new DioVmInjector(rpc);
    await injector.sync('isolates/1', rules);
    rpc.failEvaluate = true;
    await expect(injector.heartbeat()).rejects.toThrow('temporary');
    rpc.failEvaluate = false;
    await injector.sync('isolates/1', rules);
    expect(rpc.calls.filter((x) => x.method === 'createIdZone')).toHaveLength(1);
    await injector.dispose();
  });
  it('reports incomplete detach, blocks immediate reinjection and still releases its listener', async () => {
    const rpc = new FakeRpc();
    const injector = new DioVmInjector(rpc);
    await injector.sync('isolates/1', rules);
    rpc.failEvaluate = true;
    await expect(injector.detach()).rejects.toThrow('未能完整卸载');
    rpc.failEvaluate = false;
    await expect(injector.sync('isolates/1', rules)).rejects.toThrow('租约到期');
    await injector.dispose();
    expect(rpc.listenerCount('notification')).toBe(0);
  });
  it('bounds enabled rule snapshots without rejecting large disabled drafts', async () => {
    const rpc = new FakeRpc();
    const injector = new DioVmInjector(rpc);
    const large = { ...rules[0], mock: { ...rules[0].mock!, body: 'x'.repeat(2 * 1024 * 1024) } };
    await expect(injector.sync('isolates/1', [large])).rejects.toThrow('2 MiB');
    expect(rpc.calls).toHaveLength(0);
    await injector.sync('isolates/1', [{ ...large, enabled: false }]);
    await injector.dispose();
  });
  it('accepts only its own structured history events and warns for unsupported breakpoints', async () => {
    const rpc = new FakeRpc();
    const injector = new DioVmInjector(rpc);
    const received: unknown[] = [];
    injector.on('history', (entry) => received.push(entry));
    const result = await injector.sync('isolates/1', [{ ...rules[0], breakpoint: { request: true } }]);
    expect(result.warnings.join(' ')).toContain('不会暂停');
    const expression = rpc.calls.find((x) => x.method === 'evaluate' && x.params.idZoneId)!.params.expression;
    const session = JSON.parse(/'tag': ("[^"]+")/.exec(expression)![1]);
    const entry = { id: 'test-flow', startedAt: 1, originalRequest: {}, request: {} };
    const event = (tag: string, value: unknown) => ({
      params: {
        event: { extensionKind: 'flutter_pilot.vm.flow', extensionData: { session: tag, entry: value } },
      },
    });
    rpc.emit('notification', event('another-session', entry));
    rpc.emit('notification', event(session, {}));
    expect(received).toHaveLength(0);
    rpc.emit('notification', event(session, entry));
    expect(received).toEqual([entry]);
    await injector.dispose();
  });
  it('publishes pending requests separately from completed history with the same source identity', async () => {
    const rpc = new FakeRpc();
    const injector = new DioVmInjector(rpc);
    const observed: unknown[] = [],
      history: unknown[] = [];
    injector.on('observation.http', (entry) => observed.push(entry));
    injector.on('history', (entry) => history.push(entry));
    await injector.sync('isolates/1', rules);
    const expression = rpc.calls.find((x) => x.method === 'evaluate' && x.params.idZoneId)!.params.expression;
    expect(expression).toContain("emitEvent('flutter_pilot.vm.request'");
    const session = JSON.parse(/'tag': ("[^"]+")/.exec(expression)![1]);
    const pending = { id: 'pending-flow', startedAt: 1, originalRequest: {}, request: {} };
    const event = (kind: string, tag: string, entry: unknown) => ({
      params: { event: { extensionKind: kind, extensionData: { session: tag, entry } } },
    });
    rpc.emit('notification', event('flutter_pilot.vm.request', 'another-session', pending));
    rpc.emit('notification', event('flutter_pilot.vm.request', session, {}));
    expect(observed).toEqual([]);
    rpc.emit('notification', event('flutter_pilot.vm.request', session, pending));
    expect(observed).toEqual([pending]);
    expect(history).toEqual([]);
    const completed = { ...pending, response: { status: 200 } };
    rpc.emit('notification', event('flutter_pilot.vm.flow', session, completed));
    expect(history).toEqual([completed]);
    expect(observed).toHaveLength(1);
    await injector.dispose();
  });
});

import type { VmRpc } from '../vm/client';

/** Read the same wall clock as Dart capture, without translating IDE time. */
export async function readVmClock(rpc: VmRpc): Promise<number> {
  const vm = await rpc.call<{ isolates?: Array<{ id: string; isSystemIsolate?: boolean }> }>('getVM');
  for (const isolate of vm.isolates ?? []) {
    if (isolate.isSystemIsolate) continue;
    const info = await rpc.call<{ libraries?: Array<{ id: string; uri: string }> }>('getIsolate', {
      isolateId: isolate.id,
    });
    const core = info.libraries?.find((library) => library.uri === 'dart:core');
    if (!core) continue;
    const result = await rpc.call<{ type?: string; valueAsString?: string }>('evaluate', {
      isolateId: isolate.id,
      targetId: core.id,
      expression: 'DateTime.now().microsecondsSinceEpoch / 1000',
      disableBreakpoints: true,
    });
    const clock = Number(result.valueAsString);
    if ((result.type === '@Instance' || result.type === 'Instance') && Number.isFinite(clock) && clock > 0)
      return clock;
    throw new Error('无法读取 App 时钟，尚未建立测试网络观察。');
  }
  throw new Error('当前 Debug VM 没有可读取时钟的 Dart isolate。');
}

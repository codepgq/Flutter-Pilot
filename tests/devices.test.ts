import { beforeEach, describe, expect, it, vi } from 'vitest';

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: command }),
}));
import {
  cleanupAndroidReverses,
  createAndroidReverse,
  discoverConnectionAddresses,
  discoverDevices,
  parseAdbDevices,
  parseIosPhysicalDevices,
  parseIosSimulators,
  removeAndroidReverse,
} from '../src/devices';

beforeEach(() => {
  command.mockReset();
});

describe('设备发现和 Android 转发', () => {
  it('区分授权、离线设备和模拟器', () => {
    expect(
      parseAdbDevices(
        'List of devices attached\nemulator-5554 device product:sdk model:Pixel_9\nreal-id unauthorized usb:1\noffline-id offline\n',
      ),
    ).toEqual([
      { id: 'emulator-5554', name: 'Pixel 9', platform: 'android', kind: 'emulator', state: 'device' },
      { id: 'real-id', name: 'real-id', platform: 'android', kind: 'physical', state: 'unauthorized' },
      { id: 'offline-id', name: 'offline-id', platform: 'android', kind: 'physical', state: 'offline' },
    ]);
  });
  it('解析 iOS 模拟器，不把不可用设备显示为可选', () => {
    expect(
      parseIosSimulators(
        JSON.stringify({
          devices: {
            ios: [
              { udid: 'one', name: 'iPhone', state: 'Booted', isAvailable: true },
              { udid: 'two', name: 'Old', state: 'Shutdown', isAvailable: false },
            ],
          },
        }),
      ),
    ).toEqual([{ id: 'one', name: 'iPhone', platform: 'ios', kind: 'simulator', state: 'Booted' }]);
  });
  it('只发现实际 iOS 真机，不混入 Mac 或模拟器', () => {
    expect(
      parseIosPhysicalDevices(
        '== Devices ==\nDeveloper Mac (1234-ABCD)\nMark iPhone (27.2) (00008120-ABCD1234000)\n== Simulators ==\niPhone Simulator (27.2) (12345678-ABCD)\n',
      ),
    ).toEqual([
      {
        id: '00008120-ABCD1234000',
        name: 'Mark iPhone',
        platform: 'ios',
        kind: 'physical',
        state: 'connected',
      },
    ]);
  });
  it('只移除本会话创建且仍未被改动的转发', async () => {
    command.mockResolvedValueOnce({ stdout: '' }).mockResolvedValueOnce({ stdout: '' });
    expect(await createAndroidReverse('serial', 9123)).toBe(true);
    expect(command.mock.calls[1][1]).toEqual([
      '-s',
      'serial',
      'reverse',
      '--no-rebind',
      'tcp:9123',
      'tcp:9123',
    ]);
    command
      .mockResolvedValueOnce({ stdout: 'serial tcp:9123 tcp:9123\n' })
      .mockResolvedValueOnce({ stdout: '' });
    await removeAndroidReverse('serial', 9123);
    expect(command.mock.calls.at(-1)?.[1]).toEqual(['-s', 'serial', 'reverse', '--remove', 'tcp:9123']);
    command.mockClear();
    await removeAndroidReverse('serial', 9123);
    expect(command).not.toHaveBeenCalled();
  });
  it('不接管和删除已有同端口转发，冲突时不覆盖', async () => {
    command.mockResolvedValueOnce({ stdout: 'serial tcp:9000 tcp:9000\n' });
    expect(await createAndroidReverse('serial', 9000)).toBe(false);
    await removeAndroidReverse('serial', 9000);
    expect(command).toHaveBeenCalledTimes(1);
    command.mockResolvedValueOnce({ stdout: 'serial tcp:9001 tcp:9999\n' });
    await expect(createAndroidReverse('serial', 9001)).rejects.toThrow('未覆盖');
  });
  it('设备发现部分失败时保留其他结果并给出诊断', async () => {
    command.mockImplementation(async (file: string) => {
      if (file.endsWith('adb')) return { stdout: 'List of devices attached\nserial device model:Phone\n' };
      throw new Error('xcrun unavailable');
    });
    const result = await discoverDevices();
    expect(result.devices).toHaveLength(1);
    expect(result.diagnostics[0]).toContain('Xcode');
    expect(discoverConnectionAddresses()[0].host).toBe('127.0.0.1');
  });
  it('拒绝非法端口，清理只操作本会话映射', async () => {
    await expect(createAndroidReverse('serial', 0)).rejects.toThrow('端口');
    await cleanupAndroidReverses();
    expect(command).not.toHaveBeenCalled();
  });
});

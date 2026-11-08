import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const ownedReverses = new Map<string, { serial: string; port: number }>();

export interface Device {
  id: string;
  name: string;
  platform: 'android' | 'ios';
  kind: 'emulator' | 'simulator' | 'physical';
  state: string;
}

export interface DeviceDiscovery {
  devices: Device[];
  diagnostics: string[];
}

async function adbPath(): Promise<string> {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    path.join(os.homedir(), 'Library', 'Android', 'sdk');
  const candidate = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return 'adb';
  }
}

async function adb(args: string[]): Promise<string> {
  return (await executeFile(await adbPath(), args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
}

export function parseAdbDevices(output: string): Device[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith('List of devices') && !line.startsWith('*'))
    .flatMap((line) => {
      const [id, state, ...details] = line.trim().split(/\s+/);
      if (!id || !['device', 'offline', 'unauthorized', 'recovery', 'sideload'].includes(state)) return [];
      const model = details
        .find((value) => value.startsWith('model:'))
        ?.slice(6)
        .replaceAll('_', ' ');
      return [
        {
          id,
          name: model || id,
          platform: 'android' as const,
          kind: id.startsWith('emulator-') ? ('emulator' as const) : ('physical' as const),
          state,
        },
      ];
    });
}

export function parseIosSimulators(output: string): Device[] {
  const parsed = JSON.parse(output) as {
    devices?: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>>;
  };
  return Object.values(parsed.devices ?? {})
    .flat()
    .filter((device) => device.isAvailable !== false)
    .map((device) => ({
      id: device.udid,
      name: device.name,
      platform: 'ios' as const,
      kind: 'simulator' as const,
      state: device.state,
    }));
}

export function parseIosPhysicalDevices(output: string): Device[] {
  const section = output.split('== Simulators ==')[0];
  return section.split(/\r?\n/).flatMap((line) => {
    // xctrace lists the Mac without an OS-version group; an iOS device has both.
    const match = /^(.+?)\s+\((?:iOS\s+)?\d+(?:\.\d+)+(?:[^)]*)\)\s+\(([A-Fa-f0-9-]+)\)\s*$/.exec(
      line.trim(),
    );
    if (!match) return [];
    return [
      {
        id: match[2],
        name: match[1],
        platform: 'ios' as const,
        kind: 'physical' as const,
        state: 'connected',
      },
    ];
  });
}

export async function discoverDevices(): Promise<DeviceDiscovery> {
  const results = await Promise.allSettled([
    adb(['devices', '-l']).then(parseAdbDevices),
    executeFile('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }).then(({ stdout }) => parseIosSimulators(stdout)),
    executeFile('xcrun', ['xctrace', 'list', 'devices'], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }).then(({ stdout }) => parseIosPhysicalDevices(stdout)),
  ]);
  const devices: Device[] = [];
  const diagnostics: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') devices.push(...result.value);
    else
      diagnostics.push(
        index === 0
          ? '无法读取 Android 设备：请安装 Android SDK Platform Tools，检查 USB 调试授权。'
          : index === 1
            ? '无法读取 iOS 模拟器：请安装并选择 Xcode Command Line Tools。'
            : '无法读取 iOS 真机；可手动使用局域网连接，检查 Xcode 配对与设备信任。',
      );
  });
  return { devices, diagnostics };
}

export async function listDevices(): Promise<Device[]> {
  return (await discoverDevices()).devices;
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效的代理端口。');
}

function reverseMappings(output: string): Array<{ local: string; remote: string }> {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const columns = line.trim().split(/\s+/);
      return { local: columns.at(-2) ?? '', remote: columns.at(-1) ?? '' };
    });
}

export async function createAndroidReverse(serial: string, port: number): Promise<boolean> {
  assertPort(port);
  if (!serial.trim()) throw new Error('请选择已授权的 Android 设备。');
  const local = `tcp:${port}`;
  const existing = reverseMappings(await adb(['-s', serial, 'reverse', '--list'])).find(
    (mapping) => mapping.local === local,
  );
  if (existing) {
    if (existing.remote !== local) throw new Error(`Android ${local} 已被其他转发占用，未覆盖现有配置。`);
    return false;
  }
  await adb(['-s', serial, 'reverse', '--no-rebind', local, local]);
  ownedReverses.set(`${serial}\0${port}`, { serial, port });
  return true;
}

export async function removeAndroidReverse(serial: string, port: number): Promise<void> {
  assertPort(port);
  const key = `${serial}\0${port}`;
  if (!ownedReverses.has(key)) return;
  const local = `tcp:${port}`;
  const existing = reverseMappings(await adb(['-s', serial, 'reverse', '--list'])).find(
    (mapping) => mapping.local === local,
  );
  if (existing?.remote === local) await adb(['-s', serial, 'reverse', '--remove', local]);
  ownedReverses.delete(key);
}

export async function cleanupAndroidReverses(): Promise<void> {
  const results = await Promise.allSettled(
    [...ownedReverses.values()].map(({ serial, port }) => removeAndroidReverse(serial, port)),
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new Error('部分 Android 转发未能清理；请连接设备后执行 adb reverse --remove tcp:<端口>。');
}

export function discoverConnectionAddresses(): Array<{ label: string; host: string }> {
  const addresses = [{ label: '本机 / Android USB / iOS 模拟器', host: '127.0.0.1' }];
  const seen = new Set<string>();
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || seen.has(entry.address)) continue;
      seen.add(entry.address);
      addresses.push({ label: `${name} · 局域网真机`, host: entry.address });
    }
  }
  return addresses;
}

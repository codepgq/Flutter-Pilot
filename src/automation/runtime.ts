import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { detectNodeRuntime } from '../mcp/adapters';
import { discoverDevices } from '../devices';
import { findAvailablePort } from '../engine';
import { AutomationError, checkCancelled, pause, type AutomationState } from './model';

export const automationVersions = { appium: '3.9.0', uiautomator2: '8.7.3', xcuitest: '12.22.8' };
export const attachAdapterVersion = 3;
const attachGuard = `
    // Flutter Pilot attach adapter v1: preserve the already running simulator and its preferences.
    if (process.env.FLUTTER_PILOT_ATTACH_ONLY === '1') {
        if (!(await this.device.isRunning())) throw new Error('Flutter Pilot requires an already booted simulator');
        return;
    }
`;
/** Preserve the existing simulator, its preferences, and WDA apps owned by other tools. */
export async function patchManagedSimulatorAttach(root: string) {
  const path = join(root, 'node_modules/appium-xcuitest-driver/build/lib/commands/simulator.js');
  const source = await readFile(path, 'utf8');
  const marker = 'export async function startSim() {';
  if (!source.includes(attachGuard)) {
    if (source.split(marker).length !== 2)
      throw new AutomationError(
        'DRIVER_ADAPTER_MISMATCH',
        'XCUITest 连接适配器与锁定驱动不兼容，请重新准备。',
      );
    await writeFile(path, source.replace(marker, marker + attachGuard));
  }
  const changes = [
    [
      'node_modules/appium-xcuitest-driver/build/lib/commands/wda/startup.js',
      'async function cleanupApps(driver, keepBundleIds = []) {',
      "async function cleanupApps(driver, keepBundleIds = []) {\n    if (process.env.FLUTTER_PILOT_ATTACH_ONLY === '1') return;",
    ],
    [
      'node_modules/appium-xcuitest-driver/build/lib/commands/wda/stop.js',
      'if ((!this.wda.webDriverAgentUrl && this.opts.useNewWDA) || this.wda.canSkipXcodebuild) {',
      "if ((process.env.FLUTTER_PILOT_ATTACH_ONLY === '1' && !this.wda.webDriverAgentUrl) || (!this.wda.webDriverAgentUrl && this.opts.useNewWDA) || this.wda.canSkipXcodebuild) {",
    ],
    [
      'node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/build/lib/utils/processes.js',
      'export async function resetTestProcesses(udid, isSimulator) {',
      "export async function resetTestProcesses(udid, isSimulator) {\n    if (process.env.FLUTTER_PILOT_ATTACH_ONLY === '1') return;",
    ],
  ];
  for (const [relative, before, after] of changes) {
    const file = join(root, relative),
      content = await readFile(file, 'utf8');
    if (content.includes(after)) continue;
    if (content.split(before).length !== 2)
      throw new AutomationError('DRIVER_ADAPTER_MISMATCH', 'WDA 进程清理适配器不匹配。');
    await writeFile(file, content.replace(before, after));
  }
}
export interface RuntimeOptions {
  root: string;
  resources: string;
  nodePath?: string;
  logLevel?: 'debug' | 'error';
  env?: NodeJS.ProcessEnv;
}
export function compatibleNode(version: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = +match[1],
    minor = +match[2];
  return major >= 24 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);
}
export class AutomationRuntime extends EventEmitter {
  private state: AutomationState = {
    status: 'idle',
    installed: false,
    versions: automationVersions,
    devices: [],
    diagnostics: [],
  };
  private installTask?: Promise<void>;
  private child?: ChildProcess;
  private endpoint?: string;
  private nodePath?: string;
  private npmPath?: string;
  private currentRoot?: string;
  private installedMatches = false;
  private disposed = false;
  private serverLog = '';
  get diagnosticLog() {
    return this.serverLog;
  }
  constructor(private readonly options: RuntimeOptions) {
    super();
  }
  get snapshot(): AutomationState {
    return { ...this.state, devices: [...this.state.devices], diagnostics: [...this.state.diagnostics] };
  }
  private set(change: Partial<AutomationState>) {
    this.state = { ...this.state, ...change };
    this.emit('status', this.snapshot);
  }
  private environment(root?: string) {
    return {
      ...process.env,
      ...this.options.env,
      PATH: `${dirname(this.nodePath ?? process.execPath)}${delimiter}${this.options.env?.PATH ?? process.env.PATH ?? ''}`,
      ...(root ? { APPIUM_HOME: root } : {}),
      APPIUM_SKIP_CHROMEDRIVER_INSTALL: '1',
      FLUTTER_PILOT_ATTACH_ONLY: '1',
    };
  }
  private async run(
    file: string,
    args: string[],
    root?: string,
    signal?: AbortSignal,
    timeout = 15000,
  ): Promise<string> {
    checkCancelled(signal);
    return new Promise((resolvePromise, reject) => {
      const child = spawn(file, args, {
        cwd: root,
        env: this.environment(root),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let output = '',
        finished = false,
        stopped: Error | undefined,
        killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (!child.pid) return;
        try {
          process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM');
        } catch {
          /* Already exited. */
        }
      };
      const terminate = (error: Error) => {
        if (finished || stopped) return;
        stopped = error;
        stop();
        killTimer = setTimeout(() => {
          try {
            if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
          } catch {}
        }, 3000);
      };
      const abort = () => terminate(new AutomationError('CANCELLED', '设备环境准备已取消。'));
      const timer = setTimeout(
        () => terminate(new AutomationError('AUTOMATION_SETUP_TIMEOUT', '设备环境操作超时。')),
        timeout,
      );
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolvePromise(output);
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (data) => {
        output = `${output}${data}`.slice(-32768);
      });
      child.stderr?.on('data', (data) => {
        output = `${output}${data}`.slice(-32768);
      });
      child.once('error', () =>
        finish(new AutomationError('AUTOMATION_DEPENDENCY_MISSING', '设备自动化所需的可执行文件不可用。')),
      );
      child.once('close', (code) =>
        finish(
          stopped ??
            (code === 0
              ? undefined
              : new AutomationError(
                  'AUTOMATION_SETUP_FAILED',
                  '设备自动化命令失败，请检查 SDK、工具版本及网络。',
                )),
        ),
      );
      if (signal?.aborted) abort();
    });
  }
  private async hash() {
    const lock = await readFile(join(this.options.resources, 'package-lock.json'));
    return createHash('sha256').update(lock).digest('hex');
  }
  private async findInstallation(requireCurrent = true) {
    try {
      const current = JSON.parse(await readFile(join(this.options.root, 'current.json'), 'utf8'));
      if (
        typeof current.directory !== 'string' ||
        !/^[a-f0-9-]+$/.test(current.directory) ||
        (requireCurrent && current.lockHash !== (await this.hash()))
      )
        return undefined;
      const root = join(this.options.root, 'runtimes', current.directory);
      await access(join(root, 'node_modules', 'appium', 'build', 'lib', 'main.js'));
      const receipt = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'));
      return receipt.lockHash === current.lockHash && receipt.attachAdapterVersion === attachAdapterVersion
        ? root
        : undefined;
    } catch {
      return undefined;
    }
  }
  async inspect(refreshDevices = true): Promise<AutomationState> {
    const preferred = await this.findInstallation();
    const installed = preferred ?? (await this.findInstallation(false));
    this.installedMatches = !!preferred;
    const diagnostics: string[] = [];
    if (installed && !preferred) diagnostics.push('使用上次可用的私有环境；执行准备可升级到当前锁定版本。');
    this.nodePath = await detectNodeRuntime(this.options.nodePath, { ...process.env, ...this.options.env });
    if (!this.nodePath) diagnostics.push('需要可用的 Node.js 和 npm。');
    else {
      try {
        if (!compatibleNode(await this.run(this.nodePath, ['--version'])))
          diagnostics.push('Appium 需要 Node 20.19+、22.12+ 或 24+。');
        const npm = join(dirname(this.nodePath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
        try {
          await access(npm, constants.X_OK);
          this.npmPath = npm;
        } catch {
          this.npmPath = 'npm';
        }
        if (parseInt(await this.run(this.npmPath, ['--version']), 10) < 10)
          diagnostics.push('Appium 需要 npm 10+。');
      } catch {
        diagnostics.push('Node.js/npm 无法运行。');
      }
    }
    const result = refreshDevices
      ? await discoverDevices()
      : { devices: this.state.devices, diagnostics: [] };
    diagnostics.push(...result.diagnostics);
    if (refreshDevices) {
      const platforms = ['android', ...(process.platform === 'darwin' ? ['ios'] : [])] as Array<
        'android' | 'ios'
      >;
      const checks = await Promise.allSettled(platforms.map((platform) => this.checkPlatform(platform)));
      checks.forEach((check, index) => {
        if (check.status === 'rejected')
          diagnostics.push(
            `${platforms[index]} 环境：${check.reason instanceof AutomationError ? check.reason.message : 'SDK 或开发工具不可用。'}`,
          );
      });
    }
    this.currentRoot = installed;
    this.set({
      installed: !!installed,
      versions: installed
        ? JSON.parse(await readFile(join(installed, 'receipt.json'), 'utf8')).versions
        : automationVersions,
      devices: result.devices,
      diagnostics,
      ...(!['installing', 'connecting', 'connected'].includes(this.state.status)
        ? { status: installed ? 'ready' : 'idle' }
        : {}),
    });
    return this.snapshot;
  }
  async checkPlatform(platform: 'android' | 'ios') {
    if (platform === 'ios') {
      if (process.platform !== 'darwin')
        throw new AutomationError('UNSUPPORTED_HOST', 'iOS 自动化需要 macOS 和 Xcode。');
      await this.run('xcodebuild', ['-version']);
    } else {
      const java = await this.run('java', ['-version']);
      const major = /version\s+"(?:1\.)?(\d+)/.exec(java)?.[1];
      if (!major || +major < 17)
        throw new AutomationError('JAVA_UNAVAILABLE', 'Android 自动化需要 JDK 17+。');
      const sdk =
        this.options.env?.ANDROID_HOME ??
        process.env.ANDROID_HOME ??
        process.env.ANDROID_SDK_ROOT ??
        join(homedir(), 'Library', 'Android', 'sdk');
      await this.run(join(sdk, 'platform-tools', 'adb'), ['version']);
    }
  }
  async androidAppProcess(deviceId: string, appId: string, signal?: AbortSignal): Promise<number[]> {
    const sdk =
      this.options.env?.ANDROID_HOME ??
      process.env.ANDROID_HOME ??
      process.env.ANDROID_SDK_ROOT ??
      join(homedir(), 'Library/Android/sdk');
    const output = await this.run(
      join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'),
      ['-s', deviceId, 'shell', 'pidof', appId],
      undefined,
      signal,
    );
    return output.trim().split(/\s+/).map(Number).filter(Number.isSafeInteger);
  }
  async setup(signal?: AbortSignal) {
    if (this.installTask) return this.installTask;
    if (this.disposed) throw new AutomationError('SESSION_INVALIDATED', '设备自动化已关闭。');
    this.installTask = this.install(signal);
    try {
      await this.installTask;
    } finally {
      this.installTask = undefined;
    }
  }
  private async install(signal?: AbortSignal) {
    await this.inspect(false);
    if (!this.nodePath || !this.npmPath || this.state.diagnostics.some((x) => /Node|npm/.test(x)))
      throw new AutomationError('NODE_UNAVAILABLE', this.state.diagnostics.join(' '));
    if (this.currentRoot && this.installedMatches) return;
    await mkdir(join(this.options.root, 'runtimes'), { recursive: true, mode: 0o700 });
    const id = randomUUID(),
      root = join(this.options.root, 'runtimes', id);
    await mkdir(root, { mode: 0o700 });
    this.set({ status: 'installing', progress: '正在安装固定版本的 Appium 与驱动…' });
    try {
      await copyFile(join(this.options.resources, 'package.json'), join(root, 'package.json'));
      await copyFile(join(this.options.resources, 'package-lock.json'), join(root, 'package-lock.json'));
      await this.run(
        this.npmPath,
        ['ci', '--omit=dev', '--no-audit', '--no-fund'],
        root,
        signal,
        10 * 60 * 1000,
      );
      checkCancelled(signal);
      this.set({ progress: '正在注册和检查设备驱动…' });
      await this.registerDrivers(root, signal);
      await patchManagedSimulatorAttach(root);
      await this.run(
        this.nodePath,
        [join(root, 'node_modules', 'appium', 'build', 'lib', 'main.js'), '--version'],
        root,
        signal,
      );
      const lockHash = await this.hash();
      await writeFile(
        join(root, 'receipt.json'),
        JSON.stringify({ versions: automationVersions, lockHash, attachAdapterVersion }),
        { mode: 0o600 },
      );
      const temp = join(this.options.root, `current-${id}.json`);
      await writeFile(temp, JSON.stringify({ directory: id, lockHash }), { mode: 0o600 });
      checkCancelled(signal);
      await rename(temp, join(this.options.root, 'current.json'));
      this.currentRoot = root;
      this.installedMatches = true;
      this.set({ status: 'ready', installed: true, versions: automationVersions, progress: undefined });
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      await rm(join(this.options.root, `current-${id}.json`), { force: true });
      this.set({
        status: 'error',
        progress: undefined,
        diagnostics: ['环境准备失败；已有可用版本保持不变，可重新准备。'],
      });
      throw error;
    }
  }
  private async registerDrivers(root: string, signal?: AbortSignal) {
    // Appium discovers the exact packages installed by npm ci in its private home.
    const appium = join(root, 'node_modules', 'appium', 'build', 'lib', 'main.js');
    const raw = await this.run(
      this.nodePath!,
      [appium, 'driver', 'list', '--installed', '--json'],
      root,
      signal,
      30000,
    );
    const installed = JSON.parse(raw);
    for (const name of ['uiautomator2', 'xcuitest'] as const) {
      if (installed[name]?.version !== automationVersions[name])
        throw new AutomationError('DRIVER_VERSION_MISMATCH', '设备驱动版本与锁定清单不一致。');
    }
  }

  async start(signal?: AbortSignal): Promise<string> {
    if (this.endpoint && this.child && this.child.exitCode === null) return this.endpoint;
    await this.inspect(false);
    if (!this.currentRoot || !this.nodePath)
      throw new AutomationError('AUTOMATION_NOT_PREPARED', '请先准备设备自动化环境。');
    if (this.disposed) throw new AutomationError('SESSION_INVALIDATED', '设备自动化已关闭。');
    checkCancelled(signal);
    const port = await findAvailablePort('127.0.0.1', 0),
      root = this.currentRoot;
    const child = spawn(
      this.nodePath,
      [
        join(root, 'node_modules', 'appium', 'build', 'lib', 'main.js'),
        '--address',
        '127.0.0.1',
        '--port',
        String(port),
        '--use-drivers',
        'uiautomator2,xcuitest',
        '--log-level',
        this.options.logLevel ?? 'error',
        '--log-no-colors',
      ],
      {
        cwd: root,
        env: this.environment(root),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    this.child = child;
    this.serverLog = '';
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (data) => {
        this.serverLog = `${this.serverLog}${data}`.slice(-24000);
        this.emit('log', String(data));
      });
    let failed = false;
    child.on('error', () => {
      failed = true;
    });
    child.on('exit', () => {
      if (this.child === child) {
        this.child = undefined;
        this.endpoint = undefined;
        this.emit('exit');
      }
    });
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      const until = Date.now() + 60000;
      while (Date.now() < until) {
        checkCancelled(signal);
        if (failed || child.exitCode !== null)
          throw new AutomationError('APPIUM_START_FAILED', 'Appium 启动失败，请重新准备环境。');
        try {
          const response = await fetch(`${endpoint}/status`, {
            signal: AbortSignal.timeout(1000),
            redirect: 'error',
          });
          if (response.ok && ((await response.json()) as any).value?.ready) {
            this.endpoint = endpoint;
            return endpoint;
          }
        } catch {
          /* Wait for the owned process only. */
        }
        await pause(200, signal);
      }
      throw new AutomationError('APPIUM_START_TIMEOUT', 'Appium 启动超时。');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop() {
    const child = this.child;
    this.child = undefined;
    this.endpoint = undefined;
    if (!child?.pid || child.exitCode !== null) return;
    const pid = process.platform === 'win32' ? child.pid : -child.pid;
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
        resolvePromise();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        clearTimeout(timer);
        resolvePromise();
      }
    });
  }
  async dispose() {
    this.disposed = true;
    await this.stop();
  }
}

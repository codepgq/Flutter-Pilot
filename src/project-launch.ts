import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { appLaunchConfigurations, validLaunchDeviceId } from './mcp/app-launch';
import type { WebProject } from './discovery';
import { detectNodeRuntime } from './mcp/adapters';
import {
  findPortOwner,
  portOccupied,
  terminatePortOwner,
  type LaunchEndpoint,
  type PortOwner,
} from './launch-port';

export type WebPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface LaunchProfileBase {
  id: string;
  name: string;
}

export interface WebLaunchProfile extends LaunchProfileBase {
  type: 'web';
  root: string;
  packageManager: WebPackageManager;
  script: string;
  args?: string[];
  url: string;
  readyTimeoutMs?: number;
}

export interface FlutterLaunchProfile extends LaunchProfileBase {
  type: 'flutter';
  configuration?: string;
  deviceId?: string;
}

export type ProjectLaunchProfile = WebLaunchProfile | FlutterLaunchProfile;

export interface ProjectLaunchDocument {
  version: 1;
  selectedProfileId?: string;
  profiles: ProjectLaunchProfile[];
}

export class LaunchPortOccupiedError extends Error {}

export interface LaunchPortConflict extends LaunchEndpoint {
  id: string;
  profileId: string;
  pid: number;
  name: string;
}

export interface ProjectLaunchSnapshot {
  file: string;
  profiles: ProjectLaunchProfile[];
  selectedProfileId?: string;
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'failed';
  activeProfileId?: string;
  activeType?: 'web' | 'flutter';
  url?: string;
  output?: string;
  error?: string;
  portConflict?: LaunchPortConflict;
}

interface FlutterSession {
  id: string;
  configurationName?: string;
}

export interface ProjectLaunchOptions {
  workspace: string;
  file: string;
  assertMutable: () => void;
  assertFlutterLaunchable?: (configurationName: string, deviceId?: string) => void;
  flutterConfigurations: () => { name: string }[];
  flutterConfiguration?: (name: string, deviceId?: string) => Record<string, unknown>;
  confirmRestart?: (conflict: LaunchPortConflict) => Promise<boolean>;
  flutterSessions: () => FlutterSession[];
  startFlutter: (configurationName: string, deviceId?: string) => Promise<unknown>;
  stopFlutter: (configurationName: string) => Promise<void>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const profileId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const scriptName = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const packageManagers = ['npm', 'pnpm', 'yarn', 'bun'] as const;

function invalid(message: string): never {
  throw new Error(`项目启动配置无效：${message}。请检查 .flutter-pilot/launch.json`);
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${label} 包含未知字段 ${key}`);
}

function localUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 4096) invalid(`${label} 必须为本地 URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(`${label} 必须为有效 URL`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    invalid(`${label} 只支持不含凭证的本地 HTTP/HTTPS 地址`);
  return url.href;
}

function relativeRoot(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value))
    invalid(`${label} 必须是工作区内的相对目录`);
  const normalized = value.replaceAll('\\', '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../'))
    invalid(`${label} 不能越出工作区`);
  return normalized;
}

function validateProfile(input: unknown, index: number): ProjectLaunchProfile {
  if (!object(input)) invalid(`profiles[${index}] 必须为对象`);
  if (typeof input.id !== 'string' || !profileId.test(input.id))
    invalid(`profiles[${index}].id 只能包含字母、数字、点、下划线和连字符`);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128)
    invalid(`profiles[${index}].name 必须为 1–128 个字符`);
  if (input.type === 'web') {
    assertKeys(
      input,
      ['id', 'name', 'type', 'root', 'packageManager', 'script', 'args', 'url', 'readyTimeoutMs'],
      `profiles[${index}]`,
    );
    if (
      typeof input.packageManager !== 'string' ||
      !packageManagers.includes(input.packageManager as WebPackageManager)
    )
      invalid(`profiles[${index}].packageManager 必须为 npm、pnpm、yarn 或 bun`);
    if (typeof input.script !== 'string' || !scriptName.test(input.script))
      invalid(`profiles[${index}].script 必须为 package.json 中的合法脚本名`);
    const args = input.args;
    if (
      args !== undefined &&
      (!Array.isArray(args) ||
        args.length > 32 ||
        args.some((value) => typeof value !== 'string' || value.length > 512 || /[\r\n\0]/.test(value)))
    )
      invalid(`profiles[${index}].args 必须为最多 32 个无换行参数`);
    if (
      input.readyTimeoutMs !== undefined &&
      (typeof input.readyTimeoutMs !== 'number' ||
        !Number.isInteger(input.readyTimeoutMs) ||
        input.readyTimeoutMs < 5000 ||
        input.readyTimeoutMs > 600000)
    )
      invalid(`profiles[${index}].readyTimeoutMs 必须为 5000–600000 的整数`);
    return {
      id: input.id,
      name: input.name,
      type: 'web',
      root: relativeRoot(input.root, `profiles[${index}].root`),
      packageManager: input.packageManager as WebPackageManager,
      script: input.script,
      ...(args ? { args: [...args] as string[] } : {}),
      url: localUrl(input.url, `profiles[${index}].url`),
      ...(input.readyTimeoutMs !== undefined ? { readyTimeoutMs: input.readyTimeoutMs } : {}),
    };
  }
  if (input.type === 'flutter') {
    assertKeys(input, ['id', 'name', 'type', 'configuration', 'deviceId'], `profiles[${index}]`);
    if (
      input.configuration !== undefined &&
      (typeof input.configuration !== 'string' ||
        !input.configuration.trim() ||
        input.configuration.length > 256)
    )
      invalid(`profiles[${index}].configuration 必须为 Debug 启动配置名称`);
    if (input.deviceId !== undefined && !validLaunchDeviceId(String(input.deviceId)))
      invalid(`profiles[${index}].deviceId 必须为 Flutter 原生设备标识`);
    return {
      id: input.id,
      name: input.name,
      type: 'flutter',
      ...(input.configuration !== undefined ? { configuration: input.configuration as string } : {}),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId as string } : {}),
    };
  }
  invalid(`profiles[${index}].type 必须为 web 或 flutter`);
}

export function validateLaunchDocument(input: unknown): ProjectLaunchDocument {
  if (!object(input)) invalid('根节点必须为对象');
  assertKeys(input, ['version', 'selectedProfileId', 'profiles'], '根节点');
  if (input.version !== 1) invalid('仅支持 version: 1');
  if (!Array.isArray(input.profiles) || input.profiles.length > 50)
    invalid('profiles 必须为最多 50 项的数组');
  const profiles = input.profiles.map(validateProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    invalid('profiles.id 不能重复');
  if (
    input.selectedProfileId !== undefined &&
    (typeof input.selectedProfileId !== 'string' ||
      !profiles.some((profile) => profile.id === input.selectedProfileId))
  )
    invalid('selectedProfileId 必须引用已有 profile');
  return {
    version: 1,
    ...(input.selectedProfileId !== undefined
      ? { selectedProfileId: input.selectedProfileId as string }
      : {}),
    profiles,
  };
}

async function readLaunchDocument(file: string): Promise<ProjectLaunchDocument> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('.flutter-pilot/launch.json 必须为普通文件，不能使用符号链接');
  if (info.size > 1024 * 1024) throw new Error('.flutter-pilot/launch.json 过大');
  return validateLaunchDocument(JSON.parse(await readFile(file, 'utf8')));
}

function within(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}

async function selectedRoot(workspace: string, root: string): Promise<string> {
  const canonicalWorkspace = await realpath(workspace);
  const selected = await realpath(resolve(canonicalWorkspace, root));
  if (selected !== canonicalWorkspace && !within(canonicalWorkspace, selected))
    throw new Error('启动目录不能越出当前工作区');
  return selected;
}

export function launchCommand(profile: WebLaunchProfile): { command: string; args: string[] } {
  const forwarded = profile.args?.length ? ['--', ...profile.args] : [];
  return { command: profile.packageManager, args: ['run', profile.script, ...forwarded] };
}

function packageManagerFor(root: string): WebPackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'profile';
}

/** Build a usable initial file without executing project code. */
export async function suggestedLaunchProfiles(
  workspace: string,
  web?: WebProject,
): Promise<ProjectLaunchProfile[]> {
  const profiles: ProjectLaunchProfile[] = [];
  if (web) {
    const root = await selectedRoot(workspace, web.root);
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      const script = ['dev:pilot', 'dev:web', 'dev', 'start'].find(
        (name) => typeof pkg.scripts?.[name] === 'string',
      );
      if (script)
        profiles.push({
          id: `web-${slug(script)}`,
          name: `Web · ${script}`,
          type: 'web',
          root: web.root,
          packageManager: packageManagerFor(root),
          script,
          url: web.url ?? 'http://localhost:5173/',
          readyTimeoutMs: 120000,
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    const parsed = parseJsonc(await readFile(join(workspace, '.vscode', 'launch.json'), 'utf8'), [], {
      allowTrailingComma: true,
    }) as { configurations?: unknown };
    for (const [index, configuration] of appLaunchConfigurations(parsed.configurations, workspace).entries())
      profiles.push({
        id: `flutter-${slug(configuration.name)}-${index + 1}`,
        name: `Flutter · ${configuration.name}`,
        type: 'flutter',
        configuration: configuration.name,
      });
  } catch {
    // Suggestions are best-effort; launch.json remains the explicit source of truth.
  }
  return profiles.slice(0, 50);
}

interface LaunchPlan {
  profile: ProjectLaunchProfile;
  root?: string;
  configuration?: string;
  flutterConfig?: Record<string, unknown>;
  endpoints: LaunchEndpoint[];
}

function webEndpoints(value: string): LaunchEndpoint[] {
  const url = new URL(value);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (url.hostname === '[::1]') return [{ host: '::1', port }];
  const endpoints: LaunchEndpoint[] = [{ host: '127.0.0.1', port }];
  if (url.hostname === 'localhost') endpoints.push({ host: '::1', port });
  return endpoints;
}

function flutterEndpoints(toolArgs: unknown): LaunchEndpoint[] {
  if (!Array.isArray(toolArgs)) return [];
  const ports = new Map<string, number>();
  let host: LaunchEndpoint['host'] = '127.0.0.1';
  let dds = true;
  for (const [index, arg] of toolArgs.entries()) {
    if (arg === '--') break;
    if (arg === '--ipv6') host = '::1';
    if (arg === '--no-ipv6') host = '127.0.0.1';
    if (arg === '--dds') dds = true;
    if (arg === '--no-dds') dds = false;
    if (typeof arg !== 'string') continue;
    const match = /^--(host-vmservice-port|vm-service-port|dds-port)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const value = match[2] ?? toolArgs[index + 1];
    ports.set(match[1], typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0);
  }
  if (ports.has('host-vmservice-port') && ports.has('vm-service-port')) return [];
  if (!dds) ports.delete('dds-port');
  return [...new Set(ports.values())]
    .filter((port) => port > 0 && port <= 65535)
    .map((port) => ({ host, port }));
}

export class ProjectLaunchController extends EventEmitter {
  private document?: ProjectLaunchDocument;
  private webChild?: ChildProcess;
  private webState: ProjectLaunchSnapshot['status'] = 'idle';
  private activeProfileId?: string;
  private output = '';
  private error?: string;
  private stopping = false;
  private generation = 0;
  private startPending = false;
  private disposed = false;
  private conflict?: { display: LaunchPortConflict; plan: LaunchPlan; owner: PortOwner };

  constructor(private readonly options: ProjectLaunchOptions) {
    super();
  }

  get file() {
    return this.options.file;
  }

  async initialize() {
    try {
      this.document = await readLaunchDocument(this.file);
      this.error = undefined;
    } catch (error) {
      this.error = (error as Error).message;
    }
    this.emit('changed');
    return this.snapshot();
  }

  async reload() {
    if (this.startPending) throw new Error('项目正在启动，请稍后重新读取。');
    this.document = await readLaunchDocument(this.file);
    this.conflict = undefined;
    this.error = undefined;
    const selected = this.document.selectedProfileId;
    if (selected && !this.document.profiles.some((profile) => profile.id === selected))
      throw new Error('selectedProfileId 未引用现有启动项');
    this.emit('changed');
    return this.snapshot();
  }

  snapshot(): ProjectLaunchSnapshot {
    const flutterSessions = this.options.flutterSessions();
    const activeFlutter = this.document?.profiles.find(
      (profile) =>
        profile.type === 'flutter' &&
        flutterSessions.some((session) =>
          profile.configuration
            ? session.configurationName === profile.configuration
            : flutterSessions.length === 1,
        ),
    );
    const activeProfileId = this.webChild || this.startPending ? this.activeProfileId : activeFlutter?.id;
    const activeProfile = this.document?.profiles.find((profile) => profile.id === activeProfileId);
    return {
      file: this.file,
      profiles: this.document?.profiles ?? [],
      selectedProfileId: this.document?.selectedProfileId,
      status: this.webChild
        ? this.webState
        : this.startPending
          ? 'starting'
          : activeFlutter
            ? 'running'
            : this.error
              ? 'failed'
              : 'idle',
      ...(activeProfileId ? { activeProfileId } : {}),
      ...(activeProfile ? { activeType: activeProfile.type } : {}),
      ...(activeProfile?.type === 'web' ? { url: activeProfile.url } : {}),
      ...(this.output ? { output: this.output } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.conflict ? { portConflict: this.conflict.display } : {}),
    };
  }

  start(profileId: string) {
    return this.runStart(profileId);
  }

  restart(profileId: string, conflictId: string) {
    return this.runStart(profileId, conflictId);
  }

  private async runStart(profileId: string, conflictId?: string) {
    this.assertMutable();
    if (this.startPending) throw new Error('已有启动操作进行中。');
    if (this.webChild) throw new Error('已有 Web 启动进程在运行，请先停止。');
    const conflict = this.conflict;
    if (
      conflictId !== undefined &&
      (conflict?.display.id !== conflictId || conflict.display.profileId !== profileId)
    )
      throw new Error('端口占用信息已过期，请重新启动以检查端口。');
    this.startPending = true;
    this.activeProfileId = profileId;
    this.emit('changed');
    try {
      await this.performStart(profileId, conflictId === undefined ? undefined : conflict);
    } catch (error) {
      if (this.conflict === conflict) this.conflict = undefined;
      this.error = (error as Error).message;
      throw error;
    } finally {
      this.startPending = false;
      this.emit('changed');
    }
    return this.snapshot();
  }

  private async performStart(profileId: string, conflict?: NonNullable<ProjectLaunchController['conflict']>) {
    let plan = await this.loadPlan(profileId);
    if (conflict) {
      const assertSamePlan = () => {
        if (JSON.stringify(plan) !== JSON.stringify(conflict.plan) || this.runningFlutter(plan))
          throw new Error('启动配置或调试会话已变化，请重新检查端口。');
        this.assertFlutterLaunchable(plan);
      };
      assertSamePlan();
      if (!(await this.options.confirmRestart?.(conflict.display))) return;
      this.assertMutable();
      plan = await this.loadPlan(profileId);
      assertSamePlan();
      if (plan.profile.type === 'web') await this.checkWebScript(plan.profile, plan.root!);
      await terminatePortOwner(conflict.display, conflict.owner, () => {
        this.assertMutable();
        assertSamePlan();
      });
    }
    this.error = undefined;
    this.conflict = undefined;
    if (this.runningFlutter(plan)) return;
    this.assertFlutterLaunchable(plan);
    for (const endpoint of plan.endpoints) {
      if (!(await portOccupied(endpoint))) continue;
      const owner = await findPortOwner(endpoint);
      if (owner) {
        const { pid, name } = owner;
        const display = { ...endpoint, profileId, id: randomUUID(), pid, name };
        this.conflict = { display, plan, owner };
      }
      const address =
        endpoint.host === '::1' ? `[::1]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`;
      const label =
        plan.profile.type === 'web'
          ? `${plan.profile.url} 已有服务在运行`
          : `Flutter 调试端口 ${address} 已被占用`;
      throw new LaunchPortOccupiedError(
        owner
          ? `${label}（${owner.name}，PID ${owner.pid}）`
          : `${label}。无法确认唯一的占用进程，请检查端口。`,
      );
    }
    this.assertMutable();
    if (plan.profile.type === 'web') await this.startWeb(plan.profile, plan.root!);
    else await this.options.startFlutter(plan.configuration!, plan.profile.deviceId);
  }

  private assertMutable() {
    if (this.disposed) throw new Error('项目会话已关闭。');
    this.options.assertMutable();
  }

  private assertFlutterLaunchable(plan: LaunchPlan) {
    if (plan.profile.type === 'flutter' && plan.configuration)
      this.options.assertFlutterLaunchable?.(plan.configuration, plan.profile.deviceId);
  }

  private runningFlutter(plan: LaunchPlan) {
    return (
      plan.profile.type === 'flutter' &&
      this.options.flutterSessions().some((session) => session.configurationName === plan.configuration)
    );
  }

  private async loadPlan(profileId: string): Promise<LaunchPlan> {
    this.document = await readLaunchDocument(this.file);
    const profile = this.document.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('找不到指定的项目启动项');
    if (profile.type === 'web') {
      const root = await selectedRoot(this.options.workspace, profile.root);
      return { profile, root, endpoints: webEndpoints(profile.url) };
    }
    const capability = this.options.flutterConfigurations();
    const configuration = profile.configuration ?? (capability.length === 1 ? capability[0].name : undefined);
    if (!configuration) throw new Error('请在 launch.json 中填写 Flutter 启动配置 configuration');
    if (!capability.some((item) => item.name === configuration))
      throw new Error(`launch.json 引用的 Flutter 启动配置“${configuration}”不存在`);
    const flutterConfig = this.options.flutterConfiguration?.(configuration, profile.deviceId);
    return { profile, configuration, flutterConfig, endpoints: flutterEndpoints(flutterConfig?.toolArgs) };
  }

  private async checkWebScript(profile: WebLaunchProfile, root: string) {
    let pkg: { scripts?: Record<string, unknown> };
    try {
      pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    } catch {
      throw new Error(`Web 启动目录缺少 package.json：${profile.root}`);
    }
    if (typeof pkg.scripts?.[profile.script] !== 'string')
      throw new Error(`package.json 中不存在启动脚本“${profile.script}”`);
  }

  private async startWeb(profile: WebLaunchProfile, root: string) {
    await this.checkWebScript(profile, root);
    const command = launchCommand(profile);
    const nodePath = await detectNodeRuntime();
    this.assertMutable();
    const generation = ++this.generation;
    this.webState = 'starting';
    this.activeProfileId = profile.id;
    this.error = undefined;
    this.output = '';
    this.stopping = false;
    const child = spawn(command.command, command.args, {
      cwd: root,
      env: {
        ...process.env,
        ...(nodePath ? { PATH: `${dirname(nodePath)}${delimiter}${process.env.PATH ?? ''}` } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: false,
    });
    this.webChild = child;
    const append = (chunk: Buffer | string) => {
      if (generation !== this.generation) return;
      this.output = `${this.output}${String(chunk)}`.slice(-32768);
      this.emit('log', String(chunk).slice(-2048));
      this.emit('changed');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let exited = false;
    child.once('error', (error) => {
      exited = true;
      this.error = `Web 启动失败：${error.message}`;
      this.webState = 'failed';
      this.webChild = undefined;
      this.emit('changed');
    });
    child.once('exit', (code, signal) => {
      exited = true;
      if (generation !== this.generation) return;
      this.webChild = undefined;
      if (this.stopping) {
        this.webState = 'idle';
        this.stopping = false;
      } else {
        this.webState = 'failed';
        this.error = `Web 启动进程已退出（${signal ?? `退出码 ${code ?? '未知'}`}）`;
      }
      this.emit('changed');
    });
    this.emit('changed');
    try {
      await this.waitForUrl(profile.url, profile.readyTimeoutMs ?? 120000, () => exited);
      // Do not mistake an already-running URL for the process we just started.
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (generation !== this.generation || !this.webChild)
        throw new Error(this.error ?? 'Web 启动进程提前退出');
      this.webState = 'running';
      this.emit('changed');
      return this.snapshot();
    } catch (error) {
      if (generation === this.generation) {
        this.error = (error as Error).message;
        this.webState = 'failed';
        await this.stopWeb();
      }
      throw error;
    }
  }

  private async waitForUrl(url: string, timeoutMs: number, exited: () => boolean) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited()) throw new Error(this.error ?? 'Web 启动进程提前退出');
      if (await this.urlReady(url)) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`等待 ${url} 就绪超时，请检查启动脚本、端口和输出日志`);
  }

  private async urlReady(url: string) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      return true;
    } catch {
      return false;
    }
  }

  async stop() {
    if (this.startPending && !this.webChild) throw new Error('启动操作进行中，请等待结果。');
    if (this.webChild) {
      await this.stopWeb();
      this.emit('changed');
      return this.snapshot();
    }
    const active = this.document?.profiles.find((profile) => profile.id === this.activeProfileId);
    if (active?.type === 'flutter' && active.configuration)
      await this.options.stopFlutter(active.configuration);
    this.activeProfileId = undefined;
    this.emit('changed');
    return this.snapshot();
  }

  private async stopWeb() {
    const child = this.webChild;
    if (!child) return;
    this.webState = 'stopping';
    this.stopping = true;
    this.emit('changed');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
        } catch {}
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.webChild = undefined;
    this.webState = 'idle';
    this.stopping = false;
  }

  async dispose() {
    this.disposed = true;
    ++this.generation;
    await this.stopWeb();
  }
}

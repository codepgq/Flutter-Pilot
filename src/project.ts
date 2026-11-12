import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SceneStore } from './scenes';

export interface ProjectConnection {
  mode: 'vm' | 'proxy';
  lan?: boolean;
  connectionHost?: string;
  port?: number;
  configuredPort?: number;
}
export interface ProjectSettings {
  retentionDays?: number;
  maxRecords?: number;
  maxBodyBytes?: number;
  breakpointTimeout?: number;
  autoStart?: boolean;
  autoConnectVm?: boolean;
}
export interface ProjectConfig {
  version: 1;
  projectId: string;
  name: string;
  connection: ProjectConnection;
  settings?: ProjectSettings;
  [key: string]: unknown;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const connectionKeys = ['mode', 'lan', 'connectionHost', 'port', 'configuredPort'] as const;
const ranges = {
  retentionDays: [1, 365],
  maxRecords: [1, 100000],
  maxBodyBytes: [1024, 10485760],
  breakpointTimeout: [10, 300],
} as const;
function invalid(message: string): never {
  throw new Error(`项目配置无效：${message}。请检查 .flutter-pilot/project.json`);
}
function port(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535;
}
function validateConfig(value: unknown): ProjectConfig {
  if (!object(value)) invalid('必须为 JSON 对象');
  if (value.version !== 1) invalid('仅支持 version: 1');
  if (
    typeof value.projectId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.projectId)
  )
    invalid('projectId 必须是有效 UUID');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256)
    invalid('name 必须是非空项目名称');
  if (!object(value.connection) || !['vm', 'proxy'].includes(value.connection.mode as string))
    invalid('connection.mode 必须为 vm 或 proxy');
  const connection = value.connection;
  if (connection.lan !== undefined && typeof connection.lan !== 'boolean')
    invalid('connection.lan 必须是布尔值');
  if (
    connection.connectionHost !== undefined &&
    (typeof connection.connectionHost !== 'string' || !/^[\w.:[\]-]+$/.test(connection.connectionHost))
  )
    invalid('connection.connectionHost 必须是不含协议、路径或凭证的主机地址');
  for (const key of ['port', 'configuredPort'])
    if (connection[key] !== undefined && !port(connection[key]))
      invalid(`connection.${key} 必须是 1024–65535 的整数`);
  if (value.settings !== undefined) {
    if (!object(value.settings)) invalid('settings 必须为对象');
    for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
      const setting = value.settings[key];
      if (
        setting !== undefined &&
        (typeof setting !== 'number' || !Number.isInteger(setting) || setting < minimum || setting > maximum)
      )
        invalid(`settings.${key} 超出允许范围`);
    }
    for (const key of ['autoStart', 'autoConnectVm'])
      if (value.settings[key] !== undefined && typeof value.settings[key] !== 'boolean')
        invalid(`settings.${key} 必须是布尔值`);
  }
  return JSON.parse(JSON.stringify(value)) as ProjectConfig;
}

/** Project files are regular files owned by the selected workspace, never symlink targets. */
async function checkDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('.flutter-pilot 必须是项目内的普通目录，不能使用符号链接');
}
async function readText(file: string, limit: number): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('项目配置和规则必须使用普通文件，不能使用符号链接');
    if (info.size > limit) throw new Error('项目配置或规则文件过大，请缩减内容后重试');
    return await readFile(file, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 不是有效 JSON，请修复文件后重试`);
  }
}
async function readProject(file: string): Promise<ProjectConfig | undefined> {
  const text = await readText(file, 1024 * 1024);
  return text === undefined ? undefined : validateConfig(parseJson(text, '.flutter-pilot/project.json'));
}
async function createOnce(directory: string, file: string, content: string): Promise<void> {
  await checkDirectory(directory);
  const temporary = join(directory, `.create-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
function serialize(value: unknown) {
  return JSON.stringify(value, null, 2) + '\n';
}

export class ProjectBinding {
  readonly file: string;
  readonly rulesDirectory: string;
  private current: ProjectConfig;
  private operations: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    config: ProjectConfig,
  ) {
    this.file = join(directory, 'project.json');
    this.rulesDirectory = directory;
    this.current = config;
  }
  get projectId(): string {
    return this.current.projectId;
  }
  get config(): ProjectConfig {
    return JSON.parse(JSON.stringify(this.current)) as ProjectConfig;
  }
  async reload(): Promise<ProjectConfig> {
    await checkDirectory(this.directory);
    if ((await readText(join(this.rulesDirectory, 'scenes.json'), 64 * 1024 * 1024)) === undefined)
      throw new Error('项目规则文件已移除，请重新打开工作区初始化');
    const config = await readProject(this.file);
    if (!config) throw new Error('项目绑定文件已移除，请重新打开工作区初始化');
    if (config.projectId !== this.current.projectId)
      throw new Error('项目 UUID 已变更，请重新打开工作区以切换数据绑定');
    this.current = config;
    return this.config;
  }
  saveConnection(connection: ProjectConnection): Promise<void> {
    const operation = this.operations.then(async () => {
      await checkDirectory(this.directory);
      const before = await readText(this.file, 1024 * 1024);
      if (before === undefined) throw new Error('项目绑定文件已移除，请重新打开工作区初始化');
      const fresh = validateConfig(parseJson(before, '.flutter-pilot/project.json'));
      if (fresh.projectId !== this.projectId)
        throw new Error('项目 UUID 已变更，请重新打开工作区以切换数据绑定');
      const patch = Object.fromEntries(
        connectionKeys.filter((key) => connection[key] !== undefined).map((key) => [key, connection[key]]),
      );
      const next = validateConfig({ ...fresh, connection: { ...fresh.connection, ...patch } });
      const temporary = join(this.directory, `.project-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, serialize(next), { flag: 'wx', mode: 0o600 });
        await checkDirectory(this.directory);
        if ((await readText(this.file, 1024 * 1024)) !== before)
          throw new Error('项目配置已被其他窗口或编辑器修改，请重试保存');
        await rename(temporary, this.file);
        this.current = next;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    this.operations = operation.catch(() => undefined);
    return operation;
  }
}

/** Creates a stable project UUID and migrates only missing public configuration/rules. */
export async function openProjectBinding(
  workspacePath: string,
  legacyStoragePath: string,
): Promise<ProjectBinding> {
  const root = await realpath(workspacePath);
  const directory = join(root, '.flutter-pilot');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkDirectory(directory);
  const file = join(directory, 'project.json');
  const claimFile = join(legacyStoragePath, 'project-binding.json');
  const previousClaim = await readText(claimFile, 1024 * 1024);
  if (!(await readProject(file))) {
    let connection: ProjectConnection = { mode: 'vm' };
    const legacy = await readText(join(legacyStoragePath, 'connection.json'), 1024 * 1024);
    if (legacy !== undefined && previousClaim === undefined) {
      const saved = parseJson(legacy, '旧版连接配置');
      if (!object(saved)) throw new Error('旧版连接配置无效，请修复后重试迁移');
      connection = {
        mode: saved.mode === 'vm' ? 'vm' : 'proxy',
        ...Object.fromEntries(
          connectionKeys
            .filter((key) => key !== 'mode' && saved[key] !== undefined)
            .map((key) => [key, saved[key]]),
        ),
      };
    }
    const config = validateConfig({ version: 1, projectId: randomUUID(), name: basename(root), connection });
    await createOnce(directory, file, serialize(config));
  }
  const config = await readProject(file);
  if (!config) throw new Error('无法创建项目绑定文件，请检查项目写入权限');
  await mkdir(legacyStoragePath, { recursive: true, mode: 0o700 });
  await checkDirectory(legacyStoragePath);
  await createOnce(legacyStoragePath, claimFile, serialize({ version: 1, projectId: config.projectId }));
  const claim = parseJson((await readText(claimFile, 1024 * 1024))!, '旧项目存储绑定标识');
  if (
    !object(claim) ||
    claim.version !== 1 ||
    typeof claim.projectId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim.projectId)
  )
    throw new Error('旧项目存储绑定标识无效，请修复后重试');
  await new SceneStore(directory).load();
  return new ProjectBinding(directory, config);
}

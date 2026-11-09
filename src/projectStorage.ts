import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const execute = promisify(execFile);
const pending = new Map<string, Promise<unknown>>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function exists(path: string): Promise<boolean> {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink()) throw new Error('项目私有存储不支持符号链接');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function regularFile(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  if (!(await lstat(path)).isFile()) throw new Error('项目私有存储文件无效');
  return true;
}

async function validateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('项目私有存储目录无效');
  for (const entry of await readdir(path)) {
    const child = join(path, entry);
    const value = await lstat(child);
    if (value.isSymbolicLink()) throw new Error('项目私有存储不支持符号链接');
    if (value.isDirectory()) await validateDirectory(child);
    else if (!value.isFile()) throw new Error('项目私有存储包含不支持的文件');
  }
}

async function validateDestination(path: string): Promise<void> {
  for (const name of ['history.sqlite3', 'vm-history.sqlite3', 'ws-history.sqlite3', 'connection.json'])
    await regularFile(join(path, name));
  const ca = join(path, 'ca');
  if (await exists(ca)) await validateDirectory(ca);
}

async function directory(path: string, recursive = false): Promise<void> {
  await mkdir(path, { recursive, mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('项目私有存储目录无效');
  await chmod(path, 0o700);
}

/** Publish a complete file without replacing an existing destination. */
async function publish(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await regularFile(destination);
  } finally {
    await rm(source, { force: true });
  }
}

async function writeMarker(path: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await publish(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function marker(path: string): Promise<Record<string, unknown> | undefined> {
  if (!(await regularFile(path))) return;
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function copyPrivateFile(source: string, destination: string): Promise<void> {
  if (await regularFile(destination)) return;
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('旧项目存储文件无效');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o600);
    await publish(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function copyPrivateDirectory(source: string, destination: string): Promise<void> {
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('旧项目 CA 目录无效');
  await directory(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('旧项目 CA 不支持符号链接');
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyPrivateDirectory(from, to);
    else if (entry.isFile()) await copyPrivateFile(from, to);
    else throw new Error('旧项目 CA 包含不支持的文件');
  }
}

async function copyDatabase(source: string, destination: string): Promise<void> {
  if (await regularFile(destination)) return;
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('旧项目数据库无效');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    // VACUUM INTO uses SQLite's consistent read transaction, including WAL data.
    // The only interpolated SQL value is a generated private path, quoted as data.
    await execute(
      '/usr/bin/sqlite3',
      ['-readonly', source, `VACUUM INTO '${temporary.replace(/'/g, "''")}';`],
      {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
    );
    await chmod(temporary, 0o600);
    await publish(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function prepare(root: string, workspaceHash: string, projectId: string): Promise<string> {
  await directory(root, true);
  const projects = join(root, 'projects');
  const project = join(projects, projectId);
  const destination = join(project, workspaceHash);
  await directory(projects);
  await directory(project);
  await directory(destination);
  await validateDestination(destination);
  const completed = await marker(join(destination, 'migration.json'));
  if (completed) {
    if (
      completed.version !== 1 ||
      completed.projectId !== projectId ||
      completed.workspaceHash !== workspaceHash
    )
      throw new Error('项目私有存储迁移标识不一致');
    return destination;
  }
  const workspaces = join(root, 'workspaces');
  const legacy = join(workspaces, workspaceHash);
  await directory(workspaces);
  await directory(legacy);
  const claimFile = join(legacy, 'project-binding.json');
  await writeMarker(claimFile, { version: 1, projectId });
  const claim = await marker(claimFile);
  if (
    !claim ||
    claim.version !== 1 ||
    typeof claim.projectId !== 'string' ||
    !uuidPattern.test(claim.projectId)
  )
    throw new Error('旧项目存储绑定标识无效');
  if (claim.projectId.toLowerCase() === projectId) {
    for (const name of ['history.sqlite3', 'vm-history.sqlite3']) {
      const source = join(legacy, name);
      if (await exists(source)) await copyDatabase(source, join(destination, name));
    }
    const connection = join(legacy, 'connection.json');
    if (await exists(connection)) await copyPrivateFile(connection, join(destination, 'connection.json'));
    const ca = join(legacy, 'ca');
    if (await exists(ca)) await copyPrivateDirectory(ca, join(destination, 'ca'));
  }
  await writeMarker(join(destination, 'migration.json'), { version: 1, projectId, workspaceHash });
  return destination;
}

/** UUID identifies the project; the URI hash isolates each checkout's local data. */
export async function prepareProjectStorage(
  globalStorageRoot: string,
  workspaceUri: string,
  projectId: string,
): Promise<string> {
  if (!uuidPattern.test(projectId)) throw new Error('项目 UUID 无效');
  let uri: URL;
  try {
    uri = new URL(workspaceUri);
  } catch {
    throw new Error('项目工作区地址无效');
  }
  if (uri.protocol !== 'file:' || uri.search || uri.hash || uri.username || uri.password)
    throw new Error('项目存储仅支持本地文件工作区');
  const root = resolve(globalStorageRoot);
  const workspaceHash = createHash('sha256').update(workspaceUri).digest('hex').slice(0, 24);
  const key = join(root, 'workspaces', workspaceHash);
  if (!pending.has(key) && pending.size >= 128) throw new Error('同时初始化的项目过多，请稍后重试');
  const previous = pending.get(key) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(() => prepare(root, workspaceHash, projectId.toLowerCase()));
  pending.set(key, task);
  try {
    return await task;
  } catch {
    // SQLite and filesystem errors may include SQL or private paths/content.
    throw new Error('无法准备项目私有存储或迁移旧数据；请检查目录权限和数据库状态后重试');
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}

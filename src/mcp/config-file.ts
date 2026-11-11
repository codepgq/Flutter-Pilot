import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

export interface ConfigSnapshot {
  text: string;
  exists: boolean;
  fingerprint: string;
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

/** Reject symlink ancestors as well as symlink files before reading or writing configuration. */
export async function checkConfigPath(path: string): Promise<void> {
  let current = parse(path).root;
  for (const segment of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('配置路径不支持符号链接，请使用实际配置目录');
      if (current !== path && !info.isDirectory()) throw new Error('配置父路径不是目录');
      if (current === path && !info.isFile()) throw new Error('配置路径必须是普通文件');
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
  }
}

export async function readConfig(path: string): Promise<ConfigSnapshot> {
  await checkConfigPath(path);
  try {
    const info = await lstat(path);
    if (info.size > 4 * 1024 * 1024) throw new Error('配置文件超过 4 MiB，无法自动适配');
    const text = await readFile(path, 'utf8');
    return { text, exists: true, fingerprint: fingerprint(text) };
  } catch (error) {
    if (!missing(error)) throw error;
    return { text: '', exists: false, fingerprint: fingerprint('') };
  }
}

/** Serialize our writers, then compare disk again immediately before atomic replacement. */
export async function writeConfig(path: string, before: ConfigSnapshot, text: string): Promise<void> {
  await checkConfigPath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.flutter-pilot.lock`;
  let lockHandle;
  try {
    lockHandle = await open(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('配置正被其他适配操作修改，请重新检测后重试');
    throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const latest = await readConfig(path);
    if (latest.exists !== before.exists || latest.fingerprint !== before.fingerprint)
      throw new Error('配置文件已被外部修改，请重新检测后重试');
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    const final = await readConfig(path);
    if (final.exists !== before.exists || final.fingerprint !== before.fingerprint)
      throw new Error('配置文件已被外部修改，请重新检测后重试');
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
    await lockHandle.close();
    await unlink(lock).catch(() => undefined);
  }
}

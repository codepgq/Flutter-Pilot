import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const maxResourceBytes = 16 * 1024 * 1024;
const maxJournalBytes = 64 * 1024 * 1024;
export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export class SceneConflict extends Error {
  constructor(file: string) {
    super(`配置冲突：${file} 已被修改，请重新读取；保留现有文件与事务供处理。`);
  }
}

/** Validate the configured root and every descendant component. Never follow a config symlink. */
export async function safePath(root: string, path = '', create = false): Promise<string> {
  const base = resolve(root),
    file = resolve(base, path);
  if (isAbsolute(path) || (file !== base && !file.startsWith(base + sep))) throw new Error('配置路径越界');
  const parts = [base, ...relative(base, file).split(sep).filter(Boolean)];
  let current = '';
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory()))
        throw new Error(`配置路径不能使用符号链接或非目录：${current}`);
    } catch (error) {
      if (!missing(error)) throw error;
      if (create && i < parts.length - 1)
        await mkdir(current, { mode: 0o700 }).catch(async (e) => {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          if (!(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink()) throw e;
        });
    }
  }
  return file;
}
export async function readText(
  root: string,
  path: string,
  max = maxResourceBytes,
): Promise<string | undefined> {
  const file = await safePath(root, path);
  try {
    const initial = await lstat(file);
    if (!initial.isFile() || initial.size > max) throw new Error(`资源无效或超过 ${max} 字节：${file}`);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > max) throw new Error(`资源无效或超过 ${max} 字节：${file}`);
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > max) throw new Error(`资源无效或超过 ${max} 字节：${file}`);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, total));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function durable(file: string, text: string) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(file: string) {
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export interface FileChange {
  path: string;
  expected: string | null;
  text: string | null;
}
interface Journal {
  version: 1;
  entries: Array<{ path: string; before: string | null; after: string | null; temporary?: string }>;
}

const digest = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
function resourcePath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('scenes/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))
  )
    throw new Error('事务路径无效');
}
function validateJournal(value: unknown): Journal {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('事务日志损坏，需人工检查');
  const data = value as Record<string, unknown>;
  if (
    data.version !== 1 ||
    !Array.isArray(data.entries) ||
    Object.keys(data).some((key) => !['version', 'entries'].includes(key))
  )
    throw new Error('事务日志损坏，需人工检查');
  const paths = new Set<string>(),
    temporaryPaths = new Set<string>();
  for (const item of data.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('事务条目无效');
    const entry = item as Record<string, unknown>;
    resourcePath(entry.path);
    if (
      Object.keys(entry).some((key) => !['path', 'before', 'after', 'temporary'].includes(key)) ||
      !digest(entry.before) ||
      !digest(entry.after) ||
      entry.before === entry.after ||
      paths.has(entry.path)
    )
      throw new Error('事务条目无效');
    paths.add(entry.path);
    if (entry.after !== null) {
      if (
        typeof entry.temporary !== 'string' ||
        !entry.temporary.startsWith(entry.path + '.') ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(
          entry.temporary.slice(entry.path.length + 1),
        )
      )
        throw new Error('事务临时文件无效');
      resourcePath(entry.temporary);
      if (temporaryPaths.has(entry.temporary)) throw new Error('事务临时文件重复');
      temporaryPaths.add(entry.temporary);
    } else if (entry.temporary !== undefined) throw new Error('删除事务不能包含临时文件');
  }
  if ([...temporaryPaths].some((path) => paths.has(path))) throw new Error('事务文件路径重叠');
  return value as Journal;
}
function lockOwner(raw: string): { pid: number; token: string; released?: boolean } {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('项目写锁损坏，请检查锁文件');
  }
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== 'string' ||
    !value.token ||
    (value.released !== undefined && typeof value.released !== 'boolean')
  )
    throw new Error('项目写锁无效');
  return value;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

/** One project lock shared by IDE processes, with recoverable forward-only transactions. */
export class SceneFiles {
  constructor(
    readonly root: string,
    private readonly fault?: (phase: string, index: number) => void,
  ) {}
  private queue: Promise<unknown> = Promise.resolve();
  locked<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const lock = await safePath(this.root, '.scene-write.lock', true);
      const token = randomUUID();
      const candidate = await safePath(this.root, `.scene-lock-${token}.tmp`);
      await durable(candidate, json({ pid: process.pid, token }));
      let acquired = false;
      try {
        for (let attempt = 0; attempt < 1500; attempt++) {
          try {
            await link(candidate, lock);
            acquired = true;
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const before = await readText(this.root, '.scene-write.lock');
            if (before !== undefined) {
              const owner = lockOwner(before);
              if (!alive(owner.pid)) {
                const claim = await this.claimReclamation(before, candidate);
                if (claim) {
                  try {
                    this.fault?.('reclaim', 0);
                    if ((await readText(this.root, '.scene-write.lock')) === before)
                      await unlink(lock).catch((error) => {
                        if (!missing(error)) throw error;
                      });
                  } finally {
                    // A completed/failed operation relinquishes ownership without deleting its guard.
                    const temporary = `${claim}.${randomUUID()}.tmp`;
                    await durable(temporary, json({ pid: process.pid, token, released: true }));
                    await rename(temporary, claim);
                  }
                  continue;
                }
              }
            }
            await new Promise((done) => setTimeout(done, 20));
          }
        }
      } finally {
        await rm(candidate, { force: true });
      }
      if (!acquired) throw new Error('项目正在由另一进程保存，请稍后重新读取');
      try {
        await this.recover();
        return await task();
      } finally {
        const value = await readText(this.root, '.scene-write.lock');
        if (value && JSON.parse(value).token === token) await unlink(lock);
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async claimReclamation(stale: string, candidate: string) {
    // Claims are never removed, preventing ABA races between competing reclaimers.
    // Dead/released claim owners advance to a new chain link; live owners retain exclusivity.
    let previous = stale;
    for (let depth = 0; depth < 64; depth++) {
      const path = `.scene-lock-reclaim-${hash(previous)}.lock`;
      const claim = await safePath(this.root, path);
      try {
        await link(candidate, claim);
        return claim;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const raw = await readText(this.root, path);
      if (!raw) throw new Error('项目回收锁无效');
      const owner = lockOwner(raw);
      if (!owner.released && alive(owner.pid)) return undefined;
      previous = raw;
    }
    throw new Error('项目回收锁链超过限额，请检查遗留锁文件');
  }
  private async current(path: string) {
    const text = await readText(this.root, path);
    return text === undefined ? null : hash(text);
  }
  async recover() {
    const raw = await readText(this.root, '.scene-transaction.json', maxJournalBytes);
    if (raw === undefined) return;
    let journal: Journal;
    try {
      journal = validateJournal(JSON.parse(raw));
    } catch (error) {
      throw new Error(`事务日志损坏，需人工检查：${error instanceof Error ? error.message : '无效 JSON'}`);
    }
    for (const entry of journal.entries) {
      const current = await this.current(entry.path);
      if (current !== entry.before && current !== entry.after) throw new SceneConflict(entry.path);
      if (entry.temporary) {
        const temporary = await this.current(entry.temporary);
        if (
          (temporary !== null && temporary !== entry.after) ||
          (current !== entry.after && temporary === null)
        )
          throw new SceneConflict(entry.temporary);
      }
    }
    for (const [index, entry] of journal.entries.entries()) {
      const current = await this.current(entry.path);
      if (current === entry.after) continue;
      if (current !== entry.before) throw new SceneConflict(entry.path);
      const file = await safePath(this.root, entry.path, true);
      if (entry.after === null) await unlink(file);
      else {
        if ((await this.current(entry.temporary!)) !== entry.after) throw new SceneConflict(entry.temporary!);
        await rename(await safePath(this.root, entry.temporary!), file);
      }
      await syncDirectory(dirname(file));
      this.fault?.('replace', index);
    }
    for (const entry of journal.entries)
      if ((await this.current(entry.path)) !== entry.after) throw new SceneConflict(entry.path);
    for (const entry of journal.entries)
      if (entry.temporary) {
        const temporary = await this.current(entry.temporary);
        if (temporary !== null && temporary !== entry.after) throw new SceneConflict(entry.temporary);
        await rm(await safePath(this.root, entry.temporary), { force: true });
      }
    await unlink(join(this.root, '.scene-transaction.json'));
    await syncDirectory(this.root);
  }
  /** Caller holds locked(). Expected hashes cover all files read for this edit. */
  async commit(changes: FileChange[], checks: Map<string, string | null> = new Map()) {
    const changed = new Set<string>();
    const texts = new Map<string, string | null>();
    for (const change of changes) {
      resourcePath(change.path);
      if (
        !digest(change.expected) ||
        changed.has(change.path) ||
        (change.text !== null && typeof change.text !== 'string')
      )
        throw new Error('事务保存参数无效或路径重复');
      changed.add(change.path);
      texts.set(change.path, change.text);
      if (
        change.text !== null &&
        (Buffer.byteLength(change.text) > maxResourceBytes ||
          Buffer.from(change.text).toString('utf8') !== change.text)
      )
        throw new Error(`资源无效或超过 ${maxResourceBytes} 字节：${change.path}`);
      checks.set(change.path, change.expected);
    }
    for (const [path, expected] of checks)
      if ((await this.current(path)) !== expected) throw new SceneConflict(path);
    const entries: Journal['entries'] = changes.flatMap((change) => {
      const after = change.text === null ? null : hash(change.text);
      return after === change.expected
        ? []
        : [
            {
              path: change.path,
              before: change.expected,
              after,
              temporary: change.text === null ? undefined : `${change.path}.${randomUUID()}.tmp`,
            },
          ];
    });
    if (!entries.length) return;
    const journalText = json(validateJournal({ version: 1, entries }));
    if (Buffer.byteLength(journalText) > maxJournalBytes) throw new Error('事务日志超过 64 MiB，请拆分保存');
    const journalTemporary = join(this.root, `.scene-journal-${randomUUID()}.tmp`);
    let published = false;
    try {
      for (const entry of entries)
        if (entry.temporary)
          await durable(await safePath(this.root, entry.temporary, true), texts.get(entry.path)!);
      for (const [path, expected] of checks)
        if ((await this.current(path)) !== expected) throw new SceneConflict(path);
      for (const directory of new Set(
        entries.filter((e) => e.temporary).map((e) => dirname(join(this.root, e.temporary!))),
      ))
        await syncDirectory(directory);
      await durable(journalTemporary, journalText);
      await rename(journalTemporary, join(this.root, '.scene-transaction.json'));
      published = true;
      await syncDirectory(this.root);
    } catch (error) {
      if (!published)
        for (const entry of entries)
          if (entry.temporary) await rm(join(this.root, entry.temporary), { force: true });
      await rm(journalTemporary, { force: true });
      throw error;
    }
    this.fault?.('journal', 0);
    await this.recover();
  }
}

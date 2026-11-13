import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AutomationError } from './model';

/** Atomic per-device ownership across extension hosts, independent of project storage. */
export class DeviceLease {
  private owned?: { directory: string; token: string };
  constructor(private readonly root: string) {}
  async acquire(deviceId: string) {
    if (this.owned) throw new AutomationError('DEVICE_BUSY', '本会话已经持有设备租约。');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = join(this.root, createHash('sha256').update(deviceId).digest('hex'));
    const token = randomUUID();
    try {
      await mkdir(directory, { mode: 0o700 });
      try {
        await writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, token }), {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      this.owned = { directory, token };
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Never steal a directory: even a PID/token recheck races another host acquiring it.
      let pid: unknown;
      try {
        pid = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')).pid;
      } catch {}
      throw new AutomationError(
        'DEVICE_BUSY',
        `设备租约被占用${typeof pid === 'number' ? `（PID ${pid}）` : ''}。先断开原会话；若原 IDE 已崩溃，确认其进程及自动化服务均已退出后手动清理 ${directory}。`,
      );
    }
  }
  async release() {
    const owned = this.owned;
    this.owned = undefined;
    if (!owned) return;
    try {
      const owner = JSON.parse(await readFile(join(owned.directory, 'owner.json'), 'utf8'));
      if (owner.token === owned.token) await rm(owned.directory, { recursive: true, force: true });
    } catch {
      /* Never remove another process's lease. */
    }
  }
}

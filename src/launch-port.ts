import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

export interface LaunchEndpoint {
  host: '127.0.0.1' | '::1';
  port: number;
}

export interface PortOwner {
  pid: number;
  name: string;
  identity: string;
}

interface Listener {
  pid: number;
  address: string;
  family?: string;
}

const exec = promisify(execFile);
const commandOptions = { timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true };

/** Probe the local TCP bind, including listeners that do not serve HTTP. */
export function portOccupied({ host, port }: LaunchEndpoint): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(true);
      else if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code ?? '')) resolve(false);
      else reject(error);
    });
    probe.listen({ host, port, ipv6Only: host === '::1', exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolve(false)));
    });
  });
}

function parseLsof(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  let pid = 0;
  let family: string | undefined;
  for (const field of stdout.split('\0').map((value) => value.replace(/^\n/, ''))) {
    if (field.startsWith('p')) pid = Number(field.slice(1));
    if (field.startsWith('f')) family = undefined;
    if (field.startsWith('t')) family = field.slice(1);
    if (field.startsWith('n')) {
      const address = /^(.*):\d+$/.exec(field.slice(1))?.[1];
      if (address) listeners.push({ pid, address: address.replace(/^\[|\]$/g, ''), family });
    }
  }
  return listeners;
}

function powershell(script: string) {
  const executable = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return exec(executable, ['-NoProfile', '-NonInteractive', '-Command', script], commandOptions);
}

function matchesEndpoint(listener: Listener, host: LaunchEndpoint['host']) {
  const address = listener.address.toLowerCase();
  if (host === '::1')
    return address === '::1' || address === '::' || (address === '*' && listener.family === 'IPv6');
  return ['127.0.0.1', '::ffff:127.0.0.1', '0.0.0.0', '::', '*'].includes(address);
}

/** Return only an unambiguous listener with a process identity suitable for revalidation. */
export async function findPortOwner({ host, port }: LaunchEndpoint): Promise<PortOwner | undefined> {
  try {
    let listeners: Listener[];
    if (process.platform === 'win32') {
      const { stdout } = await powershell(
        `Get-NetTCPConnection -State Listen -LocalPort ${port} | ForEach-Object { '{0}|{1}' -f $_.OwningProcess,$_.LocalAddress }`,
      );
      listeners = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const [pid, address = ''] = line.trim().split('|');
          return { pid: Number(pid), address };
        });
    } else {
      const { stdout } = await exec(
        process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof',
        ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-F0pftn'],
        commandOptions,
      );
      listeners = parseLsof(stdout);
    }
    const pids = new Set(listeners.filter((row) => matchesEndpoint(row, host)).map((row) => row.pid));
    const [pid] = pids;
    if (
      pids.size !== 1 ||
      !Number.isSafeInteger(pid) ||
      pid <= 4 ||
      [process.pid, process.ppid].includes(pid)
    )
      return;
    if (process.platform === 'win32') {
      const { stdout } = await powershell(
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { '{0}|{1}' -f $p.CreationDate.ToUniversalTime().Ticks,$p.Name }`,
      );
      const match = /^(\d+)\|([^\r\n]+)$/.exec(stdout.trim());
      if (match) return { pid, identity: match[1], name: match[2] };
    } else {
      const { stdout } = await exec(
        '/bin/ps',
        ['-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'comm='],
        {
          ...commandOptions,
          env: { ...process.env, LC_ALL: 'C' },
        },
      );
      const match = /^(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(stdout.trim());
      if (match && Number(match[1]) === process.getuid?.()) {
        const name = match[3].split('/').at(-1)!;
        return { pid, identity: `${match[2]} ${match[3]}`, name };
      }
    }
  } catch {
    // A missing lookup utility, exited process or inaccessible listener is not safe to terminate.
  }
}

export async function terminatePortOwner(
  endpoint: LaunchEndpoint,
  owner: PortOwner,
  assertMutable: () => void,
): Promise<void> {
  const signal = async (kind: NodeJS.Signals) => {
    if (!(await portOccupied(endpoint))) return;
    const current = await findPortOwner(endpoint);
    if (current?.pid !== owner.pid || current.identity !== owner.identity)
      throw new Error(`端口 ${endpoint.port} 的占用进程已变化，或已无法确认身份。请重新检查启动项。`);
    assertMutable();
    try {
      process.kill(owner.pid, kind);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const waitUntilFree = async () => {
    const deadline = Date.now() + 2000;
    while (await portOccupied(endpoint)) {
      if (Date.now() >= deadline) return false;
      await delay(100);
    }
    return true;
  };
  await signal('SIGTERM');
  if (await waitUntilFree()) return;
  if (process.platform !== 'win32') {
    await signal('SIGKILL');
    if (await waitUntilFree()) return;
  }
  throw new Error(`端口 ${endpoint.port} 仍被占用，请检查进程后重新启动。`);
}

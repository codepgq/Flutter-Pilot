import { createServer, createConnection, type Server, type Socket } from 'node:net';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { McpToolError, parseTool, toolError } from './tools';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST = 512 * 1024;
async function canonicalWorkspace(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path);
    throw error;
  }
}
export interface McpClientInfo {
  name: string;
  version?: string;
  scope?: 'project' | 'global';
  connectionId: string;
  event: 'connected' | 'disconnected';
}
export interface McpSessionOptions {
  registryRoot: string;
  workspace: string;
  sessionId: string;
  name: string;
  describe: () => Record<string, unknown>;
  call: (
    tool: string,
    args: Record<string, unknown>,
    context: { signal: AbortSignal; generation: number },
  ) => Promise<unknown>;
  onClient?: (client: McpClientInfo) => void;
}
export interface SessionDescriptor {
  version: 1;
  workspace: string;
  sessionId: string;
  name: string;
  socket: string;
  token: string;
}
interface IpcRequest {
  token: string;
  workspace: string;
  sessionId: string;
  kind: 'describe' | 'call' | 'client' | 'ping';
  tool?: string;
  args?: Record<string, unknown>;
  client?: McpClientInfo;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
    throw new McpToolError('UNSAFE_REGISTRY', 'MCP 私有目录无效。');
  await chmod(path, 0o700);
}

/** One authenticated request per local socket; the VM credential never leaves the extension. */
export class McpSessionServer {
  private server?: Server;
  private socketDirectory?: string;
  private descriptorFile?: string;
  private descriptor?: SessionDescriptor;
  private generation = 0;
  private running = false;
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Map<string, { client: McpClientInfo; at: number }>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: McpSessionOptions) {}
  get state() {
    return { running: this.running, sessionId: this.options.sessionId };
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.server) throw new McpToolError('BUSY', 'MCP 服务正在启动或停止。');
    await privateDirectory(this.options.registryRoot);
    await pruneStaleSessions(this.options.registryRoot);
    // macOS Unix socket path is limited to 104 bytes; do not use its long TMPDIR.
    this.socketDirectory = await mkdtemp('/tmp/api-mcp-');
    await chmod(this.socketDirectory, 0o700);
    const socketPath = join(this.socketDirectory, 's');
    this.descriptor = {
      version: 1,
      workspace: await canonicalWorkspace(this.options.workspace),
      sessionId: this.options.sessionId,
      name: this.options.name,
      socket: socketPath,
      token: randomBytes(32).toString('hex'),
    };
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((done, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.off('error', reject);
          done();
        });
      });
      await chmod(socketPath, 0o600);
      this.running = true;
      ++this.generation;
      this.descriptorFile = join(
        this.options.registryRoot,
        createHash('sha256').update(this.options.sessionId).digest('hex') + '.json',
      );
      const temp = `${this.descriptorFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(this.descriptor), { mode: 0o600, flag: 'wx' });
        await rename(temp, this.descriptorFile);
      } finally {
        await rm(temp, { force: true });
      }
      this.timer = setInterval(() => {
        for (const [id, value] of this.clients) {
          if (Date.now() - value.at > 45000) {
            this.clients.delete(id);
            this.options.onClient?.({ ...value.client, event: 'disconnected' });
          }
        }
      }, 15000);
      this.timer.unref();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= 128) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const controller = new AbortController();
    socket.setTimeout(45000, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('close', () => {
      controller.abort();
      this.sockets.delete(socket);
    });
    let buffer = Buffer.alloc(0);
    let received = false;
    socket.on('data', (chunk) => {
      if (received) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      received = true;
      void (async () => {
        try {
          const request = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as IpcRequest;
          const data = await this.handle(request, controller.signal);
          if (!socket.destroyed) this.respond(socket, { ok: true, data });
        } catch (error) {
          if (!socket.destroyed) this.respond(socket, { ok: false, error: toolError(error) });
        }
      })();
    });
  }

  private respond(socket: Socket, response: unknown): void {
    let text = JSON.stringify(response);
    if (Buffer.byteLength(text) > MAX_BYTES)
      text = JSON.stringify({
        ok: false,
        error: { code: 'RESULT_TOO_LARGE', message: '结果过大，请缩小查询范围。' },
      });
    socket.end(text + '\n');
  }

  private async handle(request: IpcRequest, signal: AbortSignal): Promise<unknown> {
    if (!this.running || !this.descriptor) throw new McpToolError('MCP_DISABLED', 'MCP 服务已关闭。');
    const supplied = Buffer.from(typeof request?.token === 'string' ? request.token : '');
    const expected = Buffer.from(this.descriptor.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new McpToolError('UNAUTHORIZED', 'MCP 本地认证失败。');
    if (request.workspace !== this.descriptor.workspace || request.sessionId !== this.descriptor.sessionId)
      throw new McpToolError('SESSION_MISMATCH', 'MCP 项目或会话不匹配。');
    if (request.kind === 'ping') return { available: true };
    if (request.kind === 'describe')
      return {
        ...this.options.describe(),
        sessionId: this.options.sessionId,
        workspace: this.descriptor.workspace,
        name: this.options.name,
      };
    if (request.kind === 'client') {
      const client = request.client;
      if (
        !client ||
        typeof client.name !== 'string' ||
        client.name.length > 256 ||
        typeof client.connectionId !== 'string' ||
        client.connectionId.length > 128 ||
        !['connected', 'disconnected'].includes(client.event) ||
        (client.version !== undefined &&
          (typeof client.version !== 'string' || client.version.length > 128)) ||
        (client.scope !== undefined && !['project', 'global'].includes(client.scope))
      )
        throw new McpToolError('INVALID_ARGUMENTS', '客户端信息无效。');
      if (client.name !== 'flutter-pilot-selftest') {
        if (client.event === 'disconnected') {
          if (this.clients.delete(client.connectionId)) this.options.onClient?.(client);
        } else {
          const existed = this.clients.has(client.connectionId);
          this.clients.set(client.connectionId, { client, at: Date.now() });
          if (!existed) this.options.onClient?.(client);
        }
      }
      return { accepted: true };
    }
    if (request.kind !== 'call' || typeof request.tool !== 'string' || request.tool === 'list_sessions')
      throw new McpToolError('INVALID_ARGUMENTS', 'MCP 本地请求无效。');
    const args = parseTool(request.tool, request.args);
    if (args.sessionId !== this.options.sessionId)
      throw new McpToolError('SESSION_MISMATCH', '工具会话不匹配。');
    const generation = this.generation;
    if (signal.aborted) throw new McpToolError('CANCELLED', '操作已取消。');
    const result = await this.options.call(request.tool, args, { signal, generation });
    if (!this.running || generation !== this.generation || signal.aborted)
      throw new McpToolError('CANCELLED', '服务已关闭或连接中断，操作结果未确认；不要自动重试。');
    return result;
  }

  async stop(): Promise<void> {
    this.running = false;
    ++this.generation;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const value of this.clients.values())
      this.options.onClient?.({ ...value.client, event: 'disconnected' });
    this.clients.clear();
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((done) => server.close(() => done()));
    if (this.descriptorFile) await rm(this.descriptorFile, { force: true });
    if (this.socketDirectory) await rm(this.socketDirectory, { recursive: true, force: true });
    this.descriptor = undefined;
  }
}

export async function discoverSessions(
  registryRoot: string,
  workspace?: string,
): Promise<SessionDescriptor[]> {
  let names: string[];
  try {
    const stat = await lstat(registryRoot);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new McpToolError('UNSAFE_REGISTRY', 'MCP 注册目录权限无效。');
    names = await readdir(registryRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: SessionDescriptor[] = [];
  const canonical = workspace && (await canonicalWorkspace(workspace));
  for (const name of names.filter((n) => /^[a-f0-9]{64}\.json$/.test(n)).slice(0, 256)) {
    try {
      const path = join(registryRoot, name);
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 65536 ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        continue;
      const d = JSON.parse(await readFile(path, 'utf8')) as SessionDescriptor;
      if (
        d.version !== 1 ||
        typeof d.sessionId !== 'string' ||
        typeof d.name !== 'string' ||
        typeof d.workspace !== 'string' ||
        !isAbsolute(d.workspace) ||
        typeof d.token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(d.token) ||
        typeof d.socket !== 'string' ||
        !/^\/tmp\/api-mcp-[^/]+\/s$/.test(d.socket)
      )
        continue;
      if (!canonical || (await canonicalWorkspace(d.workspace)) === canonical) found.push(d);
    } catch {
      /* Invalid or stale registry entries never become sessions. */
    }
  }
  return found;
}

/** Remove only validated entries whose socket is definitely gone or refuses connections. */
export async function pruneStaleSessions(registryRoot: string): Promise<void> {
  const descriptors = await discoverSessions(registryRoot);
  await Promise.allSettled(
    descriptors.map(async (descriptor) => {
      const stale = await new Promise<boolean>((done) => {
        const socket = createConnection(descriptor.socket);
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          done(value);
        };
        socket.setTimeout(500, () => finish(false));
        socket.once('connect', () => finish(false));
        socket.once('error', (error: NodeJS.ErrnoException) =>
          finish(['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')),
        );
      });
      if (!stale) return;
      const file = join(
        registryRoot,
        createHash('sha256').update(descriptor.sessionId).digest('hex') + '.json',
      );
      // A new extension host could have replaced the descriptor since discovery.
      const current = JSON.parse(await readFile(file, 'utf8')) as SessionDescriptor;
      if (current.token === descriptor.token && current.socket === descriptor.socket)
        await rm(file, { force: true });
    }),
  );
}

export function requestSession(
  descriptor: SessionDescriptor,
  request: Omit<IpcRequest, 'token' | 'workspace' | 'sessionId'>,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((done, reject) => {
    if (signal?.aborted) {
      reject(new McpToolError('CANCELLED', '操作已取消。'));
      return;
    }
    const socket = createConnection(descriptor.socket);
    let settled = false;
    let buffer = Buffer.alloc(0);
    const finish = (error?: Error, data?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      error ? reject(error) : done(data);
    };
    const abort = () =>
      finish(new McpToolError('CANCELLED', '操作已取消；已执行动作不会回滚，请勿自动重试。'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(request.kind === 'call' ? 40000 : 2000, () =>
      finish(new McpToolError('TIMEOUT', 'MCP 调用超时，执行结果未确认；请勿自动重试。')),
    );
    socket.on('error', () =>
      finish(new McpToolError('SESSION_UNAVAILABLE', '插件 MCP 会话不可用，请确认 IDE 和 MCP 已开启。')),
    );
    socket.on('close', () =>
      finish(new McpToolError('SESSION_CLOSED', 'MCP 会话已关闭，执行结果未确认；请勿自动重试。')),
    );
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({
          ...request,
          token: descriptor.token,
          workspace: descriptor.workspace,
          sessionId: descriptor.sessionId,
        }) + '\n',
      ),
    );
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BYTES) {
        finish(new McpToolError('RESULT_TOO_LARGE', 'MCP 返回结果过大。'));
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (response.ok === true) finish(undefined, response.data);
        else
          finish(
            new McpToolError(
              response.error?.code ?? 'OPERATION_FAILED',
              response.error?.message ?? 'MCP 调用失败。',
            ),
          );
      } catch {
        finish(new McpToolError('INVALID_RESPONSE', 'MCP 返回结果无效。'));
      }
    });
  });
}

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { EngineManager, findAvailablePort, controlFrameLimit, type EngineStartOptions } from '../src/engine';

const temporary: string[] = [];
const engines: EngineManager[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<EngineStartOptions> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flutter-pilot-engine-test-'));
  temporary.push(root);
  const executable = path.join(root, 'fake-mitmdump');
  await fs.writeFile(
    executable,
    `#!${process.execPath}
const net = require('node:net');
const args = process.argv;
const port = Number(args[args.indexOf('--listen-port') + 1]);
const rogue = net.connect(Number(process.env.FLUTTER_PILOT_CONTROL_PORT), '127.0.0.1');
rogue.on('error', () => {});
rogue.on('connect', () => rogue.end(JSON.stringify({event:'hello', protocolVersion:1, token:'wrong'})+'\\n'));
const socket = net.connect(Number(process.env.FLUTTER_PILOT_CONTROL_PORT), '127.0.0.1');
let active = process.env.FLUTTER_PILOT_START_PAUSED !== '1';
const send = (data) => socket.write(JSON.stringify(data)+'\\n');
socket.on('connect', () => send({event:'hello', protocolVersion:1, token:process.env.FLUTTER_PILOT_CONTROL_TOKEN}));
let buffer = '';
socket.on('data', (chunk) => {
 buffer += chunk;
 let newline;
 while((newline = buffer.indexOf('\\n')) !== -1) {
  const msg = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline+1);
  if(msg.method === 'hang') continue;
  if(msg.method === 'crash') { process.exit(7); }
  if(msg.method === 'fail') { send({id:msg.id,error:{message:'测试错误'}}); continue; }
  if(msg.method === 'proxy.start') active = true;
  if(msg.method === 'proxy.stop') active = false;
  if(['health','proxy.start','proxy.stop'].includes(msg.method)) send({id:msg.id,result:{ready:true,proxyPort:port,proxyActive:active,caCertPath:process.env.FLUTTER_PILOT_STORAGE+'/ca/mitmproxy-ca-cert.pem'}});
  else send({id:msg.id,result:{echo:msg.params}});
  if(msg.method === 'event') {
   const bytes = Buffer.from(JSON.stringify({event:'test',data:{text:'中文正常'}})+'\\n');
   const offset = bytes.indexOf(Buffer.from('中文'))+1;
   socket.write(bytes.subarray(0,offset)); setTimeout(() => socket.write(bytes.subarray(offset)), 5);
  }
 }
});
socket.on('error', () => process.exit(0));
process.on('SIGTERM', () => { socket.destroy(); process.exit(0); });
`,
    { mode: 0o700 },
  );
  return {
    executable,
    addonPath: path.join(root, 'addon.py'),
    storagePath: path.join(root, 'private'),
    listenHost: '127.0.0.1',
    preferredPort: 0,
    settings: { retentionDays: 7, maxRecords: 100, maxBodyBytes: 1024, breakpointTimeout: 60 },
  };
}

describe('引擎进程与认证控制协议', () => {
  it('控制帧随正文上限扩容，覆盖六份二进制快照并限制异常配置', () => {
    expect(controlFrameLimit(1024 * 1024)).toBe(64 * 1024 * 1024);
    expect(controlFrameLimit(10 * 1024 * 1024)).toBe(101 * 1024 * 1024);
    expect(controlFrameLimit(10 * 1024 * 1024)).toBeGreaterThan(6 * Math.ceil((10 * 1024 * 1024) / 3) * 4);
    expect(controlFrameLimit(Infinity)).toBe(101 * 1024 * 1024);
    expect(controlFrameLimit(NaN)).toBe(64 * 1024 * 1024);
  });
  it('端口占用时自动寻找另一个可用端口', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const occupied = (server.address() as net.AddressInfo).port;
      expect(await findAvailablePort('127.0.0.1', occupied)).not.toBe(occupied);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('拒绝错误令牌，等待 health 就绪并支持请求和代理暂停/恢复', async () => {
    const manager = new EngineManager();
    engines.push(manager);
    const state = await manager.start({ ...(await fixture()), startPaused: true });
    expect(state.status).toBe('running');
    expect(state.proxyActive).toBe(false);
    expect(state.proxyPort).toBeGreaterThan(0);
    expect(await manager.rpc('echo', { hello: '世界' })).toEqual({ echo: { hello: '世界' } });
    await manager.rpc('proxy.start');
    expect(manager.state.proxyActive).toBe(true);
    await manager.rpc('proxy.stop');
    expect(manager.state.proxyActive).toBe(false);
    await expect(manager.rpc('fail')).rejects.toThrow('测试错误');
    await manager.stop();
    expect(manager.state.status).toBe('stopped');
    await expect(manager.rpc('echo')).rejects.toThrow('尚未连接');
  });
  it('跨 TCP 数据块的 UTF-8 事件不会损坏', async () => {
    const manager = new EngineManager();
    engines.push(manager);
    await manager.start(await fixture());
    const event = new Promise<unknown>((resolve) =>
      manager.on('event', (message) => {
        if (message.event === 'test') resolve(message.data);
      }),
    );
    await manager.rpc('event');
    expect(await event).toEqual({ text: '中文正常' });
  });
  it('启动过程中停止可安全取消，不遗留进程和监听端口', async () => {
    const manager = new EngineManager();
    engines.push(manager);
    const options = await fixture();
    const started = manager.start(options);
    const outcome = started.catch((error) => error);
    await manager.stop();
    expect(await outcome).toBeInstanceOf(Error);
    expect(manager.state.status).toBe('stopped');
    expect(manager.state.proxyActive).toBe(false);
  });
  it('超时清除 pending，进程崩溃使未完成请求及时失败', async () => {
    const manager = new EngineManager();
    engines.push(manager);
    await manager.start(await fixture());
    await expect(manager.rpc('hang', {}, 30)).rejects.toThrow('超时');
    await expect(manager.rpc('crash')).rejects.toThrow(/已退出|已断开/);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(manager.state.status).toBe('error');
    expect(manager.state.proxyActive).toBe(false);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { validateVmUrl, VmConnectionError, VmRpcError, VmServiceClient } from '../src/vm/client';

const clients: VmServiceClient[] = [];
const servers: WebSocketServer[] = [];
const httpServers: Server[] = [];
const rawSockets = new Set<Socket>();
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  for (const socket of rawSockets) socket.destroy();
  rawSockets.clear();
  await Promise.all(
    httpServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});
async function fixture(options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('missing port');
  const client = new VmServiceClient({ timeoutMs: 100, ...options });
  clients.push(client);
  return { server, client, url: `ws://127.0.0.1:${address.port}/secret-auth-token=/ws` };
}

async function httpFixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  httpServers.push(server);
  server.on('connection', (socket) => {
    rawSockets.add(socket);
    socket.on('close', () => rawSockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP port');
  return { server, url: `ws://127.0.0.1:${address.port}/source-secret=/ws` };
}

describe('VM Service WebSocket transport', () => {
  it('validates URLs without exposing authentication data', () => {
    expect(validateVmUrl(' ws://127.0.0.1:1234/token=/ws ')).toBe('ws://127.0.0.1:1234/token=/ws');
    for (const value of [
      'http://localhost/token',
      'ws://user:secret@localhost/ws',
      'not-a-url',
      'ws://localhost/ws#secret',
    ]) {
      expect(() => validateVmUrl(value)).toThrow();
      try {
        validateVmUrl(value);
      } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    }
  });
  it('correlates out-of-order RPC results, carries notifications and sanitizes VM errors', async () => {
    const { server, client, url } = await fixture();
    server.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const request = JSON.parse(raw.toString());
        if (request.method === 'getVM') {
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'streamNotify',
              params: { streamId: 'Extension', event: { extensionKind: 'demo' } },
            }),
          );
          setTimeout(() => socket.send(JSON.stringify({ id: request.id, result: { type: 'VM' } })), 10);
        } else if (request.method === 'fail')
          socket.send(JSON.stringify({ id: request.id, error: { code: 113, message: `contains ${url}` } }));
        else socket.send(JSON.stringify({ id: request.id, result: request.params }));
      }),
    );
    await client.connect(url);
    const notification = once(client, 'notification');
    const first = client.call('getVM');
    expect(await client.call('echo', { text: '中文' })).toEqual({ text: '中文' });
    expect(await first).toEqual({ type: 'VM' });
    expect((await notification)[0].params.streamId).toBe('Extension');
    await expect(client.call('fail')).rejects.toEqual(
      expect.objectContaining({ name: 'VmRpcError', code: 113, method: 'fail' }),
    );
    try {
      await client.call('fail');
    } catch (error) {
      expect(String(error)).not.toContain('secret-auth-token');
      expect(error).toBeInstanceOf(VmRpcError);
    }
  });
  it('times out calls and rejects pending requests when disconnected', async () => {
    const { client, url } = await fixture();
    await client.connect(url);
    await expect(client.call('hang')).rejects.toThrow('等待超时');
    const request = client.call('hang-again');
    const rejected = expect(request).rejects.toThrow('连接已断开');
    client.disconnect();
    await rejected;
    expect(client.connected).toBe(false);
    await expect(client.call('getVM')).rejects.toThrow('尚未连接');
  });
  it('rejects malformed and oversized frames and can reconnect', async () => {
    const { server, client, url } = await fixture({ maxPayloadBytes: 128 });
    let connections = 0;
    server.on('connection', (socket) => {
      connections++;
      socket.on('message', (raw) => {
        const request = JSON.parse(raw.toString());
        socket.send(request.method === 'malformed' ? '{broken' : 'x'.repeat(256));
      });
    });
    await client.connect(url);
    await expect(client.call('malformed')).rejects.toThrow('连接已断开');
    await client.connect(url);
    await expect(client.call('oversized')).rejects.toThrow('连接已断开');
    expect(connections).toBe(2);
  });
  it('follows a local DDS HTTP redirect, keeps its auth path/query and exposes only its final host', async () => {
    const target = await fixture();
    let targetPath = '';
    target.server.on('connection', (socket, request) => {
      targetPath = request.url ?? '';
      socket.on('message', (raw) => {
        const rpc = JSON.parse(String(raw));
        socket.send(JSON.stringify({ id: rpc.id, result: { type: 'VM' } }));
      });
    });
    const destination = new URL(target.url);
    destination.protocol = 'http:';
    destination.pathname = '/dds-secret=/';
    destination.search = '?forward=one';
    const source = await httpFixture((_, response) =>
      response.writeHead(302, { location: destination.toString() }).end(),
    );
    const disconnected: unknown[] = [];
    target.client.on('disconnected', () => disconnected.push(true));
    await target.client.connect(source.url);
    expect(target.client.connected).toBe(true);
    expect(target.client.endpoint).toBe(destination.host);
    expect(target.client.endpoint).not.toContain('secret');
    expect(targetPath).toBe('/dds-secret=/ws?forward=one');
    expect(disconnected).toEqual([]);
    expect(await target.client.call('getVM')).toEqual({ type: 'VM' });
  });
  it('resolves a relative DDS path and preserves an existing /ws suffix', async () => {
    const target = await fixture();
    const source = await httpFixture((request, response) => {
      if (request.url === '/source-secret=/ws')
        response.writeHead(302, { location: '../relative-secret=/?q=2' }).end();
      else {
        expect(request.url).toBe('/relative-secret=/ws?q=2');
        response.writeHead(307, { location: target.url }).end();
      }
    });
    await target.client.connect(source.url);
    expect(target.client.connected).toBe(true);
    expect(target.client.endpoint).toBe(new URL(target.url).host);
  });
  it('rejects external/credential/fragment redirects without exposing auth addresses', async () => {
    for (const destination of [
      'http://example.invalid/redirect-secret=/',
      'http://127.0.0.2:1234/redirect-secret=/',
      'http://user:secret@127.0.0.1:1234/auth=/',
      'ws://127.0.0.1:1234/auth=/#secret',
      'file:///redirect-secret',
    ]) {
      const source = await httpFixture((_, response) =>
        response.writeHead(302, { location: destination }).end(),
      );
      const client = new VmServiceClient();
      clients.push(client);
      await expect(client.connect(source.url)).rejects.toMatchObject({ code: 'redirect' });
      try {
        await client.connect(source.url);
      } catch (error) {
        expect(String(error)).not.toContain('secret');
        expect(String(error)).not.toContain('example.invalid');
        expect(error).toBeInstanceOf(VmConnectionError);
      }
      expect(client.connected).toBe(false);
      expect(client.endpoint).toBeUndefined();
    }
  });
  it('limits redirect loops to two hops', async () => {
    let requests = 0;
    const source = await httpFixture((_, response) => {
      requests++;
      response.writeHead(302, { location: '/loop-secret=/' }).end();
    });
    const client = new VmServiceClient();
    clients.push(client);
    await expect(client.connect(source.url)).rejects.toMatchObject({ code: 'redirect' });
    expect(requests).toBe(3);
    expect(client.connected).toBe(false);
  });
  it('classifies auth and missing-path handshake failures without leaking response bodies', async () => {
    for (const [status, code] of [
      [401, 'authentication'],
      [403, 'authentication'],
      [404, 'path'],
      [500, 'handshake'],
    ] as const) {
      const source = await httpFixture((_, response) =>
        response.writeHead(status).end('secret-body-with-token'),
      );
      const client = new VmServiceClient();
      clients.push(client);
      await expect(client.connect(source.url)).rejects.toMatchObject({ code });
      try {
        await client.connect(source.url);
      } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
      expect(client.connected).toBe(false);
    }
  });
  it('classifies an expired/refused port and clears the endpoint', async () => {
    const source = await httpFixture((_, response) => response.end());
    await new Promise<void>((resolve) => source.server.close(() => resolve()));
    const client = new VmServiceClient();
    clients.push(client);
    await expect(client.connect(source.url)).rejects.toMatchObject({ code: 'refused' });
    expect(client.endpoint).toBeUndefined();
  });
  it('uses a total handshake timeout across redirects and closes the waiting socket', async () => {
    let freshHandshakeBudgetWouldStillBeWaiting = false;
    let marker: NodeJS.Timeout | undefined;
    const target = await httpFixture(() => {
      marker = setTimeout(() => {
        freshHandshakeBudgetWouldStillBeWaiting = true;
      }, 90);
    });
    const source = await httpFixture((_, response) => {
      setTimeout(() => response.writeHead(302, { location: target.url }).end(), 60);
    });
    const client = new VmServiceClient({ connectTimeoutMs: 120 });
    clients.push(client);
    try {
      await expect(client.connect(source.url)).rejects.toMatchObject({ code: 'timeout' });
      expect(freshHandshakeBudgetWouldStillBeWaiting).toBe(false);
    } finally {
      if (marker) clearTimeout(marker);
    }
    expect(client.connected).toBe(false);
    expect(client.endpoint).toBeUndefined();
  });
  it('cancels a pending handshake promptly and a new session can connect immediately', async () => {
    const source = await httpFixture(() => undefined);
    const target = await fixture();
    const requested = once(source.server, 'request');
    const pending = target.client.connect(source.url);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await requested;
    await target.client.connect(target.url);
    await rejected;
    expect(target.client.connected).toBe(true);
    expect(target.client.endpoint).toBe(new URL(target.url).host);
    target.client.disconnect();
    expect(target.client.connected).toBe(false);
    expect(target.client.endpoint).toBeUndefined();
  });
});

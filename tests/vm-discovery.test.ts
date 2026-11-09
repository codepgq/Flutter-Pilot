import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { VmDiscovery, type VmDebugSession, type VmDiscoveryHost } from '../src/vm/discovery';

const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(api?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'vm-discovery-'));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const events = new EventEmitter();
  let roots = [{ id: 'workspace', path: root }];
  const event = (name: string) => (listener: (...args: any[]) => void) => {
    events.on(name, listener);
    return {
      dispose: () => {
        events.off(name, listener);
      },
    };
  };
  const host: VmDiscoveryHost = {
    getWorkspaceRoots: () => roots,
    onCustomEvent: event('custom'),
    onSessionStarted: event('start'),
    onSessionStopped: event('stop'),
    onWorkspaceChanged: event('roots'),
    getDartApi: async () => api,
  };
  const discovery = new VmDiscovery(host, { timeoutMs: 80 });
  disposals.push(() => discovery.dispose());
  const session = (id = 'debug', config: Record<string, unknown> = {}): VmDebugSession => ({
    id,
    name: `App ${id}`,
    type: 'dart',
    workspaceId: 'workspace',
    configuration: { debuggerType: 'Flutter', cwd: root, ...config },
  });
  const send = (
    value = session(),
    body: unknown = { vmServiceUri: 'http://localhost:1234/secret-auth=/' },
    name = 'dart.debuggerUris',
  ) => events.emit('custom', { session: value, event: name, body });
  return {
    root,
    events,
    discovery,
    session,
    send,
    setRoots: (value: typeof roots) => {
      roots = value;
      events.emit('roots');
    },
  };
}
async function daemon(handler: (request: any, socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  disposals.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  let socket: WebSocket | undefined;
  server.on('connection', (client) => {
    socket = client;
    client.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.method === 'streamListen')
        client.send(JSON.stringify({ id: request.id, result: { type: 'Success' } }));
      else handler(request, client);
    });
  });
  const apiEvents = new EventEmitter();
  const api = {
    version: 3,
    dtdUri: `ws://127.0.0.1:${port}/dtd-secret=/ws`,
    onDtdUriChanged: (listener: (uri?: string) => void) => {
      apiEvents.on('uri', listener);
      return {
        dispose: () => {
          apiEvents.off('uri', listener);
        },
      };
    },
  };
  const notify = (streamId: string, eventKind: string, eventData: unknown) =>
    socket!.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'streamNotify', params: { streamId, eventKind, eventData } }),
    );
  return { api, apiEvents, notify, server };
}

describe('VM debugger discovery', () => {
  it('normalizes debugger URIs and exposes only safe candidate summaries', async () => {
    const f = await fixture();
    f.send();
    await until(() => f.discovery.snapshot().candidates.length === 1);
    expect(f.discovery.address('debug')).toBe('ws://localhost:1234/secret-auth=/ws');
    expect(f.discovery.snapshot().candidates[0]).toEqual({
      id: 'debug',
      name: 'App debug',
      workspaceId: 'workspace',
      endpoint: 'localhost:1234',
      source: 'debug-event',
    });
    expect(JSON.stringify(f.discovery.snapshot())).not.toContain('secret-auth');
    let updates = 0;
    f.discovery.subscribe(() => updates++);
    f.send();
    f.send();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updates).toBe(0);
  });
  it('merges Flutter app metadata when the address arrives before Flutter identification', async () => {
    const f = await fixture();
    const session = f.session('debug', { debuggerType: undefined });
    f.send(session);
    expect(f.discovery.snapshot().candidates).toEqual([]);
    f.send(session, { mode: 'debug', deviceId: 'ios-simulator' }, 'flutter.appStart');
    await until(() => f.discovery.snapshot().candidates.length === 1);
    expect(f.discovery.snapshot().candidates[0].device).toBe('ios-simulator');
  });
  it('keeps confirmed Flutter event metadata when the following URI event has private numeric config', async () => {
    const f = await fixture();
    const session = f.session('debug', { debuggerType: 2 });
    f.send(session, { mode: 'debug', deviceId: 'simulator' }, 'flutter.appStart');
    f.send(session);
    await until(() => f.discovery.address('debug') !== undefined);
    expect(f.discovery.snapshot().candidates[0].device).toBe('simulator');
    const profile = f.session('profile', { debuggerType: 2, flutterMode: 'debug' });
    f.send(profile, { mode: 'profile', deviceId: 'simulator' }, 'flutter.appStart');
    f.send(profile);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.discovery.address('profile')).toBeUndefined();
  });
  it('ignores non-Flutter, test, web, profile, release and noDebug sessions', async () => {
    const f = await fixture();
    for (const [index, config] of [
      { debuggerType: 0 },
      { debuggerType: 2 },
      { debuggerType: 3 },
      { debuggerType: 'Web' },
      { flutterMode: 'profile' },
      { flutterMode: 'release' },
      { noDebug: true },
      { deviceId: 'chrome' },
    ].entries())
      f.send(f.session(String(index), config));
    f.send({ ...f.session('node'), type: 'node' });
    f.send(f.session('invalid'), { vmServiceUri: 'ws://user:token@localhost/ws' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.discovery.snapshot().candidates).toEqual([]);
  });
  it('maps a Dart workspace subproject to its containing root and rejects root escape symlinks', async () => {
    const f = await fixture();
    const child = join(f.root, 'packages', 'app');
    await mkdir(child, { recursive: true });
    f.send(f.session('member', { cwd: child }));
    await until(() => f.discovery.snapshot().candidates.length === 1);
    expect(f.discovery.snapshot().candidates[0].workspaceId).toBe('workspace');
    const external = await mkdtemp(join(tmpdir(), 'vm-external-'));
    disposals.push(() => rm(external, { recursive: true, force: true }));
    await symlink(external, join(f.root, 'escape'));
    f.send(f.session('escape', { cwd: join(f.root, 'escape') }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.discovery.address('escape')).toBeUndefined();
  });
  it('uses the most specific root, without connecting mismatched workspace identities', async () => {
    const f = await fixture();
    const child = join(f.root, 'nested');
    await mkdir(child);
    f.setRoots([
      { id: 'workspace', path: f.root },
      { id: 'nested', path: child },
    ]);
    f.send(f.session('mismatch', { cwd: child }));
    f.send({ ...f.session('right', { cwd: child }), workspaceId: 'nested' });
    await until(() => f.discovery.address('right') !== undefined);
    expect(f.discovery.snapshot().candidates.map((s) => s.id)).toEqual(['right']);
  });
  it('keeps a valid workspace discoverable when another workspace directory is missing', async () => {
    const f = await fixture();
    f.setRoots([
      { id: 'workspace', path: f.root },
      { id: 'missing', path: join(f.root, 'removed') },
    ]);
    f.send();
    await until(() => f.discovery.address('debug') !== undefined);
    expect(f.discovery.snapshot().candidates[0].workspaceId).toBe('workspace');
  });
  it('removes disconnected roots and prevents pending or stale events reviving stopped sessions', async () => {
    const f = await fixture();
    f.send();
    f.events.emit('stop', f.session());
    f.send();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.discovery.snapshot().candidates).toEqual([]);
    f.events.emit('start', f.session('new'));
    f.send(f.session('new'));
    await until(() => f.discovery.address('new') !== undefined);
    f.setRoots([]);
    await until(() => f.discovery.snapshot().candidates.length === 0);
  });
  it('degrades gracefully when the public Dart API is unavailable, retaining real-time discovery', async () => {
    const f = await fixture({ version: 2 });
    await f.discovery.start();
    expect(f.discovery.snapshot().status).toBe('unavailable');
    f.send();
    await until(() => f.discovery.address('debug') !== undefined);
    f.discovery.dispose();
    expect(f.events.listenerCount('custom')).toBe(0);
    f.send();
    expect(f.discovery.snapshot().candidates).toEqual([]);
  });
});

describe('DTD existing-session discovery', () => {
  it('queries already-running Flutter sessions and follows Editor start/change/stop notifications', async () => {
    let root = '';
    const dtd = await daemon((request, socket) =>
      socket.send(
        JSON.stringify({
          id: request.id,
          result: {
            debugSessions: [
              {
                id: 'existing',
                name: 'Existing App',
                debuggerType: 'Flutter',
                flutterMode: 'debug',
                projectRootPath: root,
                vmServiceUri: 'ws://localhost:3456/vm-secret=/ws',
                flutterDeviceId: 'ios',
              },
            ],
          },
        }),
      ),
    );
    const f = await fixture(dtd.api);
    root = f.root;
    await f.discovery.start();
    expect(f.discovery.snapshot().status).toBe('ready');
    expect(f.discovery.snapshot().candidates[0]).toMatchObject({
      id: 'existing',
      device: 'ios',
      source: 'dtd',
      endpoint: 'localhost:3456',
    });
    expect(JSON.stringify(f.discovery.snapshot())).not.toContain('secret');
    dtd.notify('Editor', 'debugSessionChanged', {
      debugSession: {
        id: 'existing',
        name: 'Changed',
        debuggerType: 'Flutter',
        flutterMode: 'debug',
        projectRootPath: root,
        vmServiceUri: 'ws://localhost:7890/new-secret=/ws',
      },
    });
    await until(() => f.discovery.snapshot().candidates[0]?.name === 'Changed');
    expect(f.discovery.address('existing')).toContain(':7890/');
    dtd.notify('Editor', 'debugSessionStopped', { debugSessionId: 'existing' });
    await until(() => f.discovery.snapshot().candidates.length === 0);
    dtd.notify('Editor', 'debugSessionChanged', {
      debugSession: {
        id: 'existing',
        name: 'Old',
        debuggerType: 'Flutter',
        projectRootPath: root,
        vmServiceUri: 'ws://localhost:3456/stale=/ws',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.discovery.snapshot().candidates).toEqual([]);
    dtd.notify('Editor', 'debugSessionStarted', {
      debugSession: {
        id: 'existing',
        name: 'Delayed start',
        debuggerType: 'Flutter',
        projectRootPath: root,
        vmServiceUri: 'ws://localhost:3456/stale-start=/ws',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.discovery.snapshot().candidates).toEqual([]);
  });
  it('publishes an existing multi-session snapshot atomically, never as a unique candidate', async () => {
    let root = '';
    const dtd = await daemon((request, socket) =>
      socket.send(
        JSON.stringify({
          id: request.id,
          result: {
            debugSessions: ['first', 'second'].map((id) => ({
              id,
              name: id,
              debuggerType: 'Flutter',
              flutterMode: 'debug',
              projectRootPath: root,
              vmServiceUri: 'ws://localhost:3456/vm-secret=/ws',
            })),
          },
        }),
      ),
    );
    const f = await fixture(dtd.api);
    root = f.root;
    const sizes: number[] = [];
    f.discovery.subscribe((snapshot) => sizes.push(snapshot.candidates.length));
    await f.discovery.start();
    expect(sizes).toContain(2);
    expect(sizes).not.toContain(1);
  });
  it('retries the snapshot when Editor registers after the initial method-not-found response', async () => {
    let calls = 0;
    const dtd = await daemon((request, socket) => {
      calls++;
      socket.send(
        JSON.stringify(
          calls === 1
            ? { id: request.id, error: { code: -32601, message: `sensitive ${dtd.api.dtdUri}` } }
            : { id: request.id, result: { debugSessions: [] } },
        ),
      );
    });
    const f = await fixture(dtd.api);
    await f.discovery.start();
    expect(f.discovery.snapshot().status).toBe('unavailable');
    expect(JSON.stringify(f.discovery.snapshot())).not.toContain('dtd-secret');
    dtd.notify('Service', 'ServiceRegistered', { service: 'Editor', method: 'getDebugSessions' });
    await until(() => f.discovery.snapshot().status === 'ready');
    expect(calls).toBe(2);
  });
  it('waits for a late public DTD URI', async () => {
    const dtd = await daemon((request, socket) =>
      socket.send(JSON.stringify({ id: request.id, result: { debugSessions: [] } })),
    );
    const f = await fixture({ ...dtd.api, dtdUri: undefined });
    await f.discovery.start();
    expect(f.discovery.snapshot().status).toBe('unavailable');
    dtd.apiEvents.emit('uri', dtd.api.dtdUri);
    await until(() => f.discovery.snapshot().status === 'ready');
  });
  it('does not revive a stopped session from an in-flight older snapshot', async () => {
    let pending: any;
    let socket: WebSocket | undefined;
    const dtd = await daemon((request, client) => {
      pending = request;
      socket = client;
    });
    const f = await fixture(dtd.api);
    const start = f.discovery.start();
    await until(() => !!pending);
    f.events.emit('stop', f.session('old'));
    socket!.send(
      JSON.stringify({
        id: pending.id,
        result: {
          debugSessions: [
            {
              id: 'old',
              name: 'Old',
              debuggerType: 'Flutter',
              projectRootPath: f.root,
              vmServiceUri: 'ws://localhost:1234/old=/ws',
            },
          ],
        },
      }),
    );
    await start;
    expect(f.discovery.snapshot().candidates).toEqual([]);
  });
  it('keeps a newer real-time address when an older DTD query completes', async () => {
    let pending: any;
    let socket: WebSocket | undefined;
    const dtd = await daemon((request, client) => {
      pending = request;
      socket = client;
    });
    const f = await fixture(dtd.api);
    const start = f.discovery.start();
    await until(() => !!pending);
    f.send(f.session('same'), { vmServiceUri: 'ws://localhost:8888/new=/ws' });
    await until(() => f.discovery.address('same') !== undefined);
    socket!.send(
      JSON.stringify({
        id: pending.id,
        result: {
          debugSessions: [
            {
              id: 'same',
              name: 'Old',
              debuggerType: 'Flutter',
              projectRootPath: f.root,
              vmServiceUri: 'ws://localhost:1234/old=/ws',
            },
          ],
        },
      }),
    );
    await start;
    expect(f.discovery.address('same')).toBe('ws://localhost:8888/new=/ws');
  });
  it('bounds DTD request timeouts and stays usable for real-time events', async () => {
    const dtd = await daemon(() => {});
    const f = await fixture(dtd.api);
    await f.discovery.start();
    expect(f.discovery.snapshot().status).toBe('unavailable');
    f.send();
    await until(() => f.discovery.address('debug') !== undefined);
  });
  it('disposes all connections and pending queries without publishing a stale result', async () => {
    let pending: any;
    const dtd = await daemon((request) => {
      pending = request;
    });
    const f = await fixture(dtd.api);
    const starting = f.discovery.start();
    await until(() => !!pending);
    let published = 0;
    f.discovery.subscribe(() => published++);
    f.discovery.dispose();
    await starting;
    expect(published).toBe(0);
    expect(f.discovery.snapshot().candidates).toEqual([]);
  });
});

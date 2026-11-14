import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appLaunchConfigurations,
  appLaunchConfiguration,
  appLaunchConfigurationName,
  appLaunchConfigurationNameKey,
  McpAppLaunchController,
  type AppLaunchHost,
  type AppLaunchState,
} from '../src/mcp/app-launch';
import { parseTool } from '../src/mcp/tools';

function fixture() {
  const state: AppLaunchState = { mode: 'vm', connected: false, sessions: [], candidates: [] };
  const listeners = new Set<Parameters<AppLaunchHost['subscribeSessions']>[0]>();
  const event = (kind: 'started' | 'stopped', session: AppLaunchState['sessions'][number]) => {
    for (const listener of listeners) listener({ kind, session });
  };
  const host: AppLaunchHost = {
    workspace: '/project',
    configurations: () => [{ name: 'app', type: 'dart', request: 'launch', cwd: 'apps/app' }],
    state: () => structuredClone(state),
    assertMutable: vi.fn(),
    lifecycleBusy: () => false,
    start: vi.fn(async (_name, deviceId) => {
      state.sessions = [
        { id: 'app-debug', name: 'app', configurationName: 'app', ...(deviceId ? { deviceId } : {}) },
      ];
      state.candidates = [...state.sessions];
      event('started', state.sessions[0]);
      return true;
    }),
    subscribeSessions: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    connect: vi.fn(async (id) => {
      state.connected = true;
      state.connectedSessionId = id;
    }),
    networkStatus: () => ({ http: { status: 'pending' } }),
  };
  return { state, host, event, controller: new McpAppLaunchController(host) };
}
afterEach(() => vi.useRealTimers());

describe('MCP explicit App launch', () => {
  it('publishes unique local Debug configuration names without arguments or secrets', () => {
    const base = { type: 'dart', request: 'launch' };
    expect(
      appLaunchConfigurations(
        [
          {
            ...base,
            name: 'app',
            cwd: '${workspaceFolder}/apps/app',
            program: 'lib/main.dart',
            env: { secret: 'private' },
          },
          { ...base, name: 'profile', flutterMode: 'profile' },
          { ...base, name: 'release-arg', toolArgs: ['--release'] },
          { ...base, name: 'browser', deviceId: 'chrome' },
          { ...base, name: 'external', cwd: '../other' },
          { ...base, name: 'external-main', program: '../other/main.dart' },
          { ...base, name: 'variable', cwd: '${input:directory}' },
          { ...base, name: 'duplicate' },
          { ...base, name: 'duplicate', flutterMode: 'release' },
          { ...base, name: 'attach', request: 'attach' },
          { ...base, name: 'no-debug', noDebug: true },
          { name: 'shell', type: 'node', request: 'launch' },
        ],
        '/project',
      ),
    ).toEqual([{ name: 'app' }]);
  });
  it('accepts only a known configuration name through the public schema', () => {
    expect(parseTool('start_app', { sessionId: 'session', configurationName: 'app' })).toEqual({
      sessionId: 'session',
      configurationName: 'app',
    });
    for (const input of [
      {},
      { sessionId: 'session' },
      { sessionId: 'session', configurationName: 'app', args: ['--release'] },
      { sessionId: 'session', configurationName: 'app', timeoutMs: 30001 },
      ...['chrome', 'edge', 'web-server', '--release', 'sim --release', '${input:device}', '../device'].map(
        (deviceId) => ({ sessionId: 'session', configurationName: 'app', deviceId }),
      ),
    ])
      expect(() => parseTool('start_app', input)).toThrow();
  });
  it('starts exactly once and reports completion only after the matching VM connects', async () => {
    const f = fixture();
    expect(await f.controller.execute('app')).toMatchObject({
      ok: true,
      submitted: true,
      completed: true,
      reused: false,
      debugSessionId: 'app-debug',
      network: { http: { status: 'pending' } },
    });
    expect(f.host.start).toHaveBeenCalledExactlyOnceWith('app', undefined);
    expect(f.host.connect).toHaveBeenCalledExactlyOnceWith('app-debug');
    expect(f.controller.status().busy).toBe(false);
  });
  it('overrides only the device of a validated named configuration without editing it', async () => {
    const configurations = [
      {
        name: 'app',
        type: 'dart',
        request: 'launch',
        cwd: 'apps/app',
        deviceId: 'old-device',
        env: { SECRET: 'private' },
        toolArgs: ['--dart-define=env=dev'],
      },
    ];
    const copy = appLaunchConfiguration(configurations, '/project', 'app', 'simulator-123');
    expect(copy).toEqual({
      ...configurations[0],
      deviceId: 'simulator-123',
      [appLaunchConfigurationNameKey]: 'app',
    });
    copy.env = {};
    expect(configurations[0].deviceId).toBe('old-device');
    expect(configurations[0].env.SECRET).toBe('private');
    expect(() => appLaunchConfiguration(configurations, '/project', 'other', 'sim')).toThrow();
    expect(() => appLaunchConfiguration(configurations, '/project', 'app', '--release')).toThrow();
    expect(appLaunchConfiguration(configurations, '/project', 'app')).toEqual({
      ...configurations[0],
      [appLaunchConfigurationNameKey]: 'app',
    });
    const f = fixture();
    expect(await f.controller.execute('app', 1000, undefined, undefined, 'simulator-123')).toMatchObject({
      ok: true,
      deviceId: 'simulator-123',
    });
    expect(f.host.start).toHaveBeenCalledExactlyOnceWith('app', 'simulator-123');
    expect(
      parseTool('start_app', { sessionId: 'session', configurationName: 'app', deviceId: 'simulator-123' }),
    ).toMatchObject({ deviceId: 'simulator-123' });
  });
  it('preserves the submitted identity when Dart Code mutates configuration.name for a device', () => {
    const saved = [
      { name: 'app (Pilot)', type: 'dart', request: 'launch', cwd: 'apps/app', program: 'lib/pilot.dart' },
    ];
    const runtime = appLaunchConfiguration(saved, '/project', 'app (Pilot)', 'sim');
    runtime.name = 'app (Pilot) (iPhone 17)';
    runtime.deviceName = 'iPhone 17 (ios)';
    runtime.cwd = '/project/apps/app';
    runtime.program = '/project/apps/app/lib/pilot.dart';
    expect(appLaunchConfigurationName(saved, '/project', runtime)).toBe('app (Pilot)');
    expect(saved[0].name).toBe('app (Pilot)');
    expect(saved[0]).not.toHaveProperty(appLaunchConfigurationNameKey);
    expect(
      appLaunchConfigurationName(saved, '/project', { ...runtime, cwd: '/project/other' }),
    ).toBeUndefined();
    expect(
      appLaunchConfigurationName(saved, '/project', {
        ...runtime,
        program: '/project/apps/app/lib/other.dart',
      }),
    ).toBeUndefined();
  });
  it('recovers unmarked adapter names only with an exact known device suffix and matching source', () => {
    const saved = [
      { name: 'app (Pilot)', type: 'dart', request: 'launch', cwd: 'apps/app', program: 'lib/pilot.dart' },
    ];
    const runtime = {
      ...saved[0],
      name: 'app (Pilot) (iPhone 17)',
      cwd: '/project/apps/app',
      program: '/project/apps/app/lib/pilot.dart',
      deviceId: 'sim',
      deviceName: 'iPhone 17 (ios)',
    };
    expect(appLaunchConfigurationName(saved, '/project', runtime)).toBe('app (Pilot)');
    for (const patch of [
      { name: 'app (Pilot) other' },
      { name: 'app (Pilot) (other-device)' },
      { deviceName: undefined },
      { cwd: '/project/other' },
      { program: '/project/apps/app/lib/other.dart' },
      { flutterMode: 'profile' },
      { noDebug: true },
      { [appLaunchConfigurationNameKey]: 'unrecognized' },
    ])
      expect(appLaunchConfigurationName(saved, '/project', { ...runtime, ...patch })).toBeUndefined();
    const collision = [...saved, { ...saved[0], name: runtime.name }];
    expect(appLaunchConfigurationName(collision, '/project', runtime)).toBeUndefined();
    const duplicate = [...saved, { ...saved[0] }];
    expect(appLaunchConfigurationName(duplicate, '/project', runtime)).toBeUndefined();
  });
  it('reuses only a confirmed matching device when a device is explicitly requested', async () => {
    for (const actual of [undefined, 'other-device', 'selected-device']) {
      const f = fixture();
      f.state.sessions = [{ id: 'existing', name: 'app', configurationName: 'app', deviceId: actual }];
      f.state.candidates = [...f.state.sessions];
      const work = f.controller.execute('app', 1000, undefined, undefined, 'selected-device');
      if (actual === 'selected-device')
        expect(await work).toMatchObject({ ok: true, reused: true, submitted: false });
      else {
        await expect(work).rejects.toMatchObject({ code: 'APP_DEVICE_MISMATCH' });
        expect(f.host.connect).not.toHaveBeenCalled();
      }
      expect(f.host.start).not.toHaveBeenCalled();
    }
  });
  it('does not connect to a different device reported during launch', async () => {
    const f = fixture();
    vi.mocked(f.host.start).mockImplementationOnce(async () => {
      f.state.sessions = [{ id: 'app-debug', name: 'app', configurationName: 'app', deviceId: 'different' }];
      f.state.candidates = [...f.state.sessions];
      return true;
    });
    expect(await f.controller.execute('app', 1000, undefined, undefined, 'selected-device')).toMatchObject({
      ok: false,
      code: 'APP_DEVICE_MISMATCH',
    });
    expect(f.host.connect).not.toHaveBeenCalled();
    expect(f.controller.status().busy).toBe(false);
  });
  it('reuses a same-name started session rather than launching or resetting it', async () => {
    const f = fixture();
    f.state.sessions = [{ id: 'existing', name: 'app', configurationName: 'app' }];
    f.state.candidates = [...f.state.sessions];
    expect(await f.controller.execute('app')).toMatchObject({
      ok: true,
      submitted: false,
      reused: true,
      debugSessionId: 'existing',
    });
    expect(f.host.start).not.toHaveBeenCalled();
  });
  it.each(['launch', 'reuse'] as const)(
    'uses the configuration identity for %s when IDE decorates the display name',
    async (mode) => {
      const f = fixture();
      const target = { id: 'decorated', name: 'app (workspace)', configurationName: 'app', deviceId: 'sim' };
      if (mode === 'reuse') {
        f.state.sessions = [target];
        f.state.candidates = [target];
      } else {
        vi.mocked(f.host.start).mockImplementationOnce(async () => {
          f.state.sessions = [target];
          f.state.candidates = [target];
          f.event('started', target);
          return true;
        });
      }
      expect(await f.controller.execute('app', 1000, undefined, undefined, 'sim')).toMatchObject({
        ok: true,
        submitted: mode === 'launch',
        reused: mode === 'reuse',
        debugSessionId: 'decorated',
      });
      expect(f.controller.status()).toMatchObject({ busy: false, sessions: [target] });
      expect(f.controller.status()).not.toHaveProperty('pendingConfiguration');
      expect(f.host.start).toHaveBeenCalledTimes(mode === 'launch' ? 1 : 0);
      expect(f.host.connect).toHaveBeenCalledExactlyOnceWith('decorated');
    },
  );
  it('rejects a display-name match without a confirmed configuration rather than guessing a restored session', async () => {
    const f = fixture();
    f.state.sessions = [{ id: 'restored', name: 'app', deviceId: 'sim' }];
    await expect(f.controller.execute('app')).rejects.toMatchObject({ code: 'APP_SESSION_UNCONFIRMED' });
    expect(f.host.start).not.toHaveBeenCalled();
    expect(f.host.connect).not.toHaveBeenCalled();
  });
  it.each(['other', 'ambiguous', 'manual'] as const)(
    'rejects %s existing connections before IDE dispatch',
    async (scenario) => {
      const f = fixture();
      f.state.sessions =
        scenario === 'manual'
          ? []
          : [
              { id: 'other', name: 'other', configurationName: 'other' },
              ...(scenario === 'ambiguous' ? [{ id: 'second', name: 'app', configurationName: 'app' }] : []),
            ];
      f.state.connected = scenario === 'manual';
      await expect(f.controller.execute('app')).rejects.toMatchObject({
        code: scenario === 'ambiguous' ? 'AMBIGUOUS_DEBUG_SESSION' : 'APP_ALREADY_RUNNING',
      });
      expect(f.host.start).not.toHaveBeenCalled();
    },
  );
  it('rejects environment locks, proxy mode and unknown names before side effects', async () => {
    const f = fixture();
    vi.mocked(f.host.assertMutable).mockImplementationOnce(() => {
      throw Object.assign(new Error('locked'), { code: 'WORKFLOW_BUSY' });
    });
    await expect(f.controller.execute('app')).rejects.toMatchObject({ code: 'WORKFLOW_BUSY' });
    await expect(f.controller.execute('unknown')).rejects.toMatchObject({
      code: 'INVALID_LAUNCH_CONFIGURATION',
    });
    f.state.mode = 'proxy';
    await expect(f.controller.execute('app')).rejects.toMatchObject({ code: 'APP_LAUNCH_UNAVAILABLE' });
    expect(f.host.start).not.toHaveBeenCalled();
  });
  it('rejects concurrent lifecycle or launch requests while IDE submission is pending', async () => {
    const f = fixture();
    f.host.lifecycleBusy = () => true;
    await expect(f.controller.execute('app')).rejects.toMatchObject({ code: 'BUSY' });
    f.host.lifecycleBusy = () => false;
    let finish!: (accepted: boolean) => void;
    vi.mocked(f.host.start).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const work = f.controller.execute('app');
    await expect(f.controller.execute('app')).rejects.toMatchObject({ code: 'BUSY' });
    finish(false);
    expect(await work).toMatchObject({ code: 'APP_LAUNCH_REJECTED' });
    expect(f.host.start).toHaveBeenCalledOnce();
  });
  it('stops on an invalidated project session and does not expose adapter failure details', async () => {
    const f = fixture();
    let current = true;
    vi.mocked(f.host.start).mockImplementationOnce(async () => {
      current = false;
      return true;
    });
    expect(await f.controller.execute('app', 100, undefined, () => current)).toMatchObject({
      code: 'SESSION_INVALIDATED',
      submitted: true,
    });
    expect(f.host.connect).not.toHaveBeenCalled();
    const broken = fixture();
    vi.mocked(broken.host.start).mockRejectedValueOnce(new Error('private-launch-environment'));
    const result = await broken.controller.execute('app');
    expect(result).toMatchObject({ code: 'APP_LAUNCH_FAILED', submitted: true });
    expect(JSON.stringify(result)).not.toContain('private-launch-environment');
    expect(broken.controller.status()).toMatchObject({ busy: false });
    expect(broken.controller.status()).not.toHaveProperty('pendingConfiguration');
    expect(await broken.controller.execute('app')).toMatchObject({ ok: true });
  });
  it('rejects a cancelled or invalidated preflight without IDE dispatch', async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(f.controller.execute('app', 100, abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(f.controller.execute('app', 100, undefined, () => false)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(f.host.start).not.toHaveBeenCalled();
  });
  it('does not mistake IDE acknowledgement for a VM or automatically retry on timeout', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.host.start).mockResolvedValue(true);
    const work = f.controller.execute('app', 100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await work).toMatchObject({ ok: false, submitted: true, completed: false, code: 'TIMEOUT' });
    expect(f.controller.status()).toMatchObject({ busy: false, pendingConfiguration: 'app' });
    await expect(f.controller.execute('app')).rejects.toMatchObject({ code: 'APP_LAUNCH_UNCONFIRMED' });
    expect(f.host.start).toHaveBeenCalledOnce();
    f.state.sessions = [{ id: 'later', name: 'app', configurationName: 'app' }];
    f.state.candidates = [...f.state.sessions];
    expect(await f.controller.execute('app')).toMatchObject({ ok: true, submitted: false, reused: true });
    expect(f.host.start).toHaveBeenCalledOnce();
  });
  it('releases a launch that starts and exits between polling ticks', async () => {
    const f = fixture();
    vi.mocked(f.host.start).mockImplementationOnce(async () => {
      const session = { id: 'brief', name: 'app', configurationName: 'app' };
      f.event('started', session);
      f.event('stopped', session);
      return true;
    });
    expect(await f.controller.execute('app')).toMatchObject({ code: 'APP_EXITED', completed: false });
    expect(f.controller.status()).toMatchObject({ busy: false });
    expect(f.controller.status()).not.toHaveProperty('pendingConfiguration');
    expect(f.host.connect).not.toHaveBeenCalled();
    expect(await f.controller.execute('app')).toMatchObject({ ok: true });
  });
  it('observes late termination after timeout without locking unrelated workbench functions', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.host.start).mockResolvedValueOnce(true);
    const work = f.controller.execute('app', 100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await work).toMatchObject({ code: 'TIMEOUT' });
    expect(f.controller.status()).toMatchObject({ busy: false, pendingConfiguration: 'app' });
    f.event('started', { id: 'brief', name: 'unrelated', configurationName: 'unrelated' });
    expect(f.controller.status()).toHaveProperty('pendingConfiguration');
    f.event('started', { id: 'brief', name: 'app', configurationName: 'app' });
    f.event('stopped', { id: 'brief', name: 'app', configurationName: 'app' });
    expect(f.controller.status()).not.toHaveProperty('pendingConfiguration');
    expect(await f.controller.execute('app')).toMatchObject({ ok: true });
  });
  it.each(['timeout', 'cancel'] as const)(
    'releases the workbench after %s while guarding an unresolved IDE request',
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      const abort = new AbortController();
      let finish!: (accepted: boolean) => void;
      vi.mocked(f.host.start).mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      const work = f.controller.execute('app', 100, abort.signal);
      if (reason === 'cancel') abort.abort();
      else await vi.advanceTimersByTimeAsync(101);
      expect(await work).toMatchObject({ code: reason === 'cancel' ? 'CANCELLED' : 'TIMEOUT' });
      expect(f.controller.status()).toMatchObject({ busy: false, pendingConfiguration: 'app' });
      await expect(f.controller.execute('app')).rejects.toMatchObject({ code: 'APP_LAUNCH_UNCONFIRMED' });
      f.state.sessions = [{ id: 'late', name: 'app', configurationName: 'app' }];
      f.state.candidates = [...f.state.sessions];
      f.event('started', f.state.sessions[0]);
      finish(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.controller.status().busy).toBe(false);
      expect(f.host.connect).not.toHaveBeenCalled();
      expect(f.host.start).toHaveBeenCalledOnce();
    },
  );
  it('unlocks a timed-out IDE submission when its session terminates before the promise settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (accepted: boolean) => void;
    vi.mocked(f.host.start).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const work = f.controller.execute('app', 100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await work).toMatchObject({ code: 'TIMEOUT' });
    expect(f.controller.status().busy).toBe(false);
    f.event('started', { id: 'brief', name: 'app', configurationName: 'app' });
    f.event('stopped', { id: 'brief', name: 'app', configurationName: 'app' });
    expect(f.controller.status().busy).toBe(false);
    expect(f.controller.status()).not.toHaveProperty('pendingConfiguration');
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.host.connect).not.toHaveBeenCalled();
    expect(await f.controller.execute('app')).toMatchObject({ ok: true });
  });
  it('reports launch rejection and cancellation without leaking adapter errors or connecting after cancellation', async () => {
    const f = fixture();
    vi.mocked(f.host.start).mockResolvedValueOnce(false);
    expect(await f.controller.execute('app')).toMatchObject({
      code: 'APP_LAUNCH_REJECTED',
      completed: false,
    });
    const abort = new AbortController();
    vi.mocked(f.host.start).mockImplementationOnce(async () => {
      abort.abort();
      return true;
    });
    expect(await f.controller.execute('app', 100, abort.signal)).toMatchObject({
      code: 'CANCELLED',
      submitted: true,
    });
    expect(f.host.connect).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { startLocalMock } from '../src/browser/local-mock';
import {
  launchCommand,
  ProjectLaunchController,
  suggestedLaunchProfiles,
  validateLaunchDocument,
} from '../src/project-launch';

let root: string;

async function occupyPort(port = 0, host = '127.0.0.1') {
  const fixture = join(root, 'listener.cjs');
  await writeFile(
    fixture,
    `
    const server = require('node:net').createServer((socket) => socket.end());
    server.listen(Number(process.argv[2]), process.argv[3], () => process.send(server.address().port));
  `,
  );
  const child = fork(fixture, [String(port), host], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  try {
    const [listeningPort] = await Promise.race([
      once(child, 'message'),
      exited.then(() => {
        throw new Error('端口夹具提前退出');
      }),
    ]);
    return { port: Number(listeningPort), pid: child.pid, child, exited, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilot-project-launch-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const webProfile = {
  id: 'web-dev',
  name: 'Web 开发',
  type: 'web' as const,
  root: '.',
  packageManager: 'pnpm' as const,
  script: 'dev:pilot',
  url: 'http://localhost:3000/',
};

describe('project launch configuration', () => {
  it('validates and normalizes explicit Web and Flutter profiles', () => {
    expect(
      validateLaunchDocument({
        version: 1,
        selectedProfileId: 'flutter-app',
        profiles: [
          webProfile,
          {
            id: 'flutter-app',
            name: 'Flutter 应用',
            type: 'flutter',
            configuration: 'App (local)',
          },
        ],
      }),
    ).toEqual({
      version: 1,
      selectedProfileId: 'flutter-app',
      profiles: [
        webProfile,
        {
          id: 'flutter-app',
          name: 'Flutter 应用',
          type: 'flutter',
          configuration: 'App (local)',
        },
      ],
    });
  });

  it('keeps the distributable launch example valid', async () => {
    const value = JSON.parse(await readFile(join(process.cwd(), 'resources/example.launch.json'), 'utf8'));
    expect(validateLaunchDocument(value).profiles).toHaveLength(2);
  });

  it.each([
    [{ ...webProfile, root: '../outside' }, '越出'],
    [{ ...webProfile, script: 'dev && rm -rf /' }, 'script'],
    [{ ...webProfile, url: 'https://example.com' }, '本地'],
    [{ ...webProfile, unknown: true }, '未知字段'],
    [{ ...webProfile, mockSceneId: '../other' }, 'mockSceneId'],
    [{ ...webProfile, url: 'https://localhost:3000/', mockSceneId: 'demo' }, 'HTTP URL'],
  ])('rejects unsafe or unknown launch fields', (profile, message) => {
    expect(() => validateLaunchDocument({ version: 1, profiles: [profile] })).toThrow(message);
  });

  it('creates Web and Flutter suggestions without executing project code', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite', 'dev:pilot': 'vite --mode pilot' } }),
    );
    await writeFile(join(root, 'pnpm-lock.yaml'), '');
    await mkdir(join(root, '.vscode'));
    await writeFile(
      join(root, '.vscode/launch.json'),
      JSON.stringify({
        version: '0.2.0',
        configurations: [
          {
            name: 'App (local)',
            type: 'dart',
            request: 'launch',
            program: 'lib/main.dart',
          },
        ],
      }),
    );
    const profiles = await suggestedLaunchProfiles(root, {
      root: '.',
      url: 'http://localhost:3000/',
      framework: 'react',
    });
    expect(profiles).toEqual([
      {
        id: 'web-dev-pilot',
        name: 'Web · dev:pilot',
        type: 'web',
        root: '.',
        packageManager: 'pnpm',
        script: 'dev:pilot',
        url: 'http://localhost:3000/',
        readyTimeoutMs: 120000,
      },
      {
        id: 'flutter-app-local-1',
        name: 'Flutter · App (local)',
        type: 'flutter',
        configuration: 'App (local)',
      },
    ]);
  });

  it('builds package-manager commands without a shell', () => {
    expect(launchCommand({ ...webProfile, args: ['--host', '127.0.0.1'] })).toEqual({
      command: 'pnpm',
      args: ['run', 'dev:pilot', '--', '--host', '127.0.0.1'],
    });
  });

  it('reuses an existing Flutter IDE session instead of launching a duplicate', async () => {
    const file = join(root, 'launch.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id: 'flutter-app',
            name: 'Flutter 应用',
            type: 'flutter',
            configuration: 'App (local)',
          },
        ],
      }),
    );
    const startFlutter = vi.fn();
    const controller = new ProjectLaunchController({
      workspace: root,
      file,
      assertMutable: vi.fn(),
      flutterConfigurations: () => [{ name: 'App (local)' }],
      flutterSessions: () => [{ id: 'session', configurationName: 'App (local)' }],
      startFlutter,
      stopFlutter: vi.fn(),
    });
    await controller.initialize();
    expect(controller.snapshot()).toMatchObject({
      status: 'running',
      activeProfileId: 'flutter-app',
      activeType: 'flutter',
    });
    await controller.start('flutter-app');
    expect(startFlutter).not.toHaveBeenCalled();
    await controller.dispose();
  });

  it.each([false, true])('starts and stops a Web script (ordinary browser Mock: %s)', async (withMock) => {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const value = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(value));
      });
    });
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }));
    await writeFile(
      join(root, 'server.cjs'),
      `const http=require('node:http');const i=process.argv.indexOf('--port');const port=Number(process.argv[i+1]);http.createServer((q,r)=>r.end('ok')).listen(port,'127.0.0.1');`,
    );
    const file = join(root, 'launch.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            ...webProfile,
            packageManager: 'npm',
            script: 'dev',
            args: ['--port', String(port)],
            url: `http://127.0.0.1:${port}/`,
            readyTimeoutMs: 5000,
            ...(withMock ? { mockSceneId: 'demo' } : {}),
          },
        ],
      }),
    );
    const controller = new ProjectLaunchController({
      workspace: root,
      file,
      assertMutable: vi.fn(),
      startWebMock: async (profile) => {
        expect(profile.mockSceneId).toBe('demo');
        return startLocalMock({
          upstream: profile.url,
          rules: [
            {
              id: 'demo-login',
              name: 'Demo',
              enabled: true,
              priority: 1,
              match: { method: 'POST', path: '/login-api' },
              mock: { status: 201, headers: {}, body: 'mock login' },
            },
          ],
        });
      },
      flutterConfigurations: () => [],
      flutterSessions: () => [],
      startFlutter: vi.fn(),
      stopFlutter: vi.fn(),
    });
    await controller.initialize();
    await expect(controller.start('web-dev')).resolves.toMatchObject({
      status: 'running',
      activeProfileId: 'web-dev',
      activeType: 'web',
    });
    await expect(fetch(`http://127.0.0.1:${port}/`)).resolves.toMatchObject({ status: 200 });
    expect(controller.snapshot().output).toContain('server.cjs');
    const mockUrl = controller.snapshot().mockUrl;
    if (withMock) {
      expect(mockUrl).toBeTruthy();
      const response = await fetch(new URL('/login-api', mockUrl!), { method: 'POST' });
      expect(response.status).toBe(201);
      expect(await response.text()).toBe('mock login');
      expect(response.headers.get('x-flutter-pilot-mock-rule')).toBe('demo-login');
      expect(await (await fetch(mockUrl!)).text()).toBe('ok');
    } else expect(mockUrl).toBeUndefined();
    await controller.stop();
    if (mockUrl) await expect(fetch(mockUrl)).rejects.toBeDefined();
    expect(controller.snapshot().mockUrl).toBeUndefined();
    expect(controller.snapshot().status).toBe('idle');
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toBeDefined();
    await controller.dispose();
  });

  it('does not claim an already-running Web URL as the newly started process', async () => {
    const server = createHttpServer((_request, response) => response.end('ok'));
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const file = join(root, 'launch.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            ...webProfile,
            packageManager: 'npm',
            script: 'dev',
            url: `http://127.0.0.1:${port}/`,
            readyTimeoutMs: 5000,
          },
        ],
      }),
    );
    const controller = new ProjectLaunchController({
      workspace: root,
      file,
      assertMutable: vi.fn(),
      flutterConfigurations: () => [],
      flutterSessions: () => [],
      startFlutter: vi.fn(),
      stopFlutter: vi.fn(),
    });
    try {
      await controller.initialize();
      await expect(controller.start('web-dev')).rejects.toThrow('已有服务在运行');
      expect(controller.snapshot().portConflict).toBeUndefined();
    } finally {
      await controller.dispose();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('only terminates the confirmed listener and then starts the same Web script', async () => {
    const owner = await occupyPort();
    const file = join(root, 'launch.json');
    const confirmRestart = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const url = `http://127.0.0.1:${owner.port}/`;
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }));
    await writeFile(
      join(root, 'server.cjs'),
      `require('node:http').createServer((q,r)=>r.end('new')).listen(${owner.port},'127.0.0.1');`,
    );
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        profiles: [{ ...webProfile, packageManager: 'npm', script: 'dev', url }],
      }),
    );
    const controller = new ProjectLaunchController({
      workspace: root,
      file,
      confirmRestart,
      assertMutable: vi.fn(),
      flutterConfigurations: () => [],
      flutterSessions: () => [],
      startFlutter: vi.fn(),
      stopFlutter: vi.fn(),
    });
    try {
      await expect(controller.start('web-dev')).rejects.toThrow('已有服务在运行');
      const conflict = controller.snapshot().portConflict!;
      expect(conflict).toMatchObject({ pid: owner.pid, port: owner.port, profileId: 'web-dev' });
      await expect(controller.restart('web-dev', 'stale')).rejects.toThrow('已过期');
      expect(confirmRestart).not.toHaveBeenCalled();
      await expect(controller.restart('web-dev', conflict.id)).resolves.toMatchObject({
        status: 'failed',
        portConflict: conflict,
      });
      expect(owner.child.signalCode).toBeNull();
      expect(confirmRestart).toHaveBeenCalledWith(conflict);
      await expect(controller.restart('web-dev', conflict.id)).resolves.toMatchObject({ status: 'running' });
      await owner.exited;
      expect(controller.snapshot().portConflict).toBeUndefined();
      expect(await (await fetch(url)).text()).toBe('new');
    } finally {
      await controller.dispose();
      await owner.stop();
    }
  }, 12000);

  it.each(['--host-vmservice-port', '--dds-port', '--vm-service-port'])(
    'releases a fixed Flutter host port set by %s before calling the IDE launch',
    async (flag) => {
      const owner = await occupyPort();
      const file = join(root, 'launch.json');
      const profile = {
        id: 'flutter-app',
        name: 'Flutter',
        type: 'flutter',
        configuration: 'App',
        deviceId: 'device',
      };
      await writeFile(file, JSON.stringify({ version: 1, profiles: [profile] }));
      const startFlutter = vi.fn(async () => {
        await owner.exited;
      });
      const controller = new ProjectLaunchController({
        workspace: root,
        file,
        confirmRestart: vi.fn().mockResolvedValue(true),
        assertMutable: vi.fn(),
        flutterConfigurations: () => [{ name: 'App' }],
        flutterSessions: () => [],
        flutterConfiguration: () => ({
          toolArgs: flag === '--dds-port' ? [flag, String(owner.port)] : [`${flag}=${owner.port}`],
        }),
        startFlutter,
        stopFlutter: vi.fn(),
      });
      try {
        await expect(controller.start(profile.id)).rejects.toThrow('Flutter 调试端口');
        expect(startFlutter).not.toHaveBeenCalled();
        const conflict = controller.snapshot().portConflict!;
        expect(conflict).toMatchObject({ pid: owner.pid, port: owner.port, profileId: profile.id });
        await controller.restart(profile.id, conflict.id);
        expect(startFlutter).toHaveBeenCalledExactlyOnceWith('App', 'device');
        expect(controller.snapshot().portConflict).toBeUndefined();
      } finally {
        await owner.stop();
        await controller.dispose();
      }
    },
    12000,
  );

  it('refuses to end a replacement listener after the confirmation dialog was opened', async () => {
    const owner = await occupyPort();
    let replacement: Awaited<ReturnType<typeof occupyPort>> | undefined;
    const file = join(root, 'launch.json');
    await writeFile(
      file,
      JSON.stringify({ version: 1, profiles: [{ ...webProfile, url: `http://127.0.0.1:${owner.port}/` }] }),
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { [webProfile.script]: 'node server.cjs' } }),
    );
    const controller = new ProjectLaunchController({
      workspace: root,
      file,
      confirmRestart: async () => {
        await owner.stop();
        replacement = await occupyPort(owner.port);
        return true;
      },
      assertMutable: vi.fn(),
      flutterConfigurations: () => [],
      flutterSessions: () => [],
      startFlutter: vi.fn(),
      stopFlutter: vi.fn(),
    });
    try {
      await expect(controller.start('web-dev')).rejects.toThrow('已有服务在运行');
      await expect(controller.restart('web-dev', controller.snapshot().portConflict!.id)).rejects.toThrow(
        '占用进程已变化',
      );
      expect(replacement?.child.signalCode).toBeNull();
      expect(replacement?.child.exitCode).toBeNull();
      expect(controller.snapshot().portConflict).toBeUndefined();
    } finally {
      await owner.stop();
      await replacement?.stop();
      await controller.dispose();
    }
  }, 12000);

  it('does not inspect a device-side VM port or a disabled DDS port', async () => {
    const owner = await occupyPort();
    const file = join(root, 'launch.json');
    await writeFile(
      file,
      JSON.stringify({ version: 1, profiles: [{ id: 'flutter-app', name: 'Flutter', type: 'flutter' }] }),
    );
    const startFlutter = vi.fn();
    const controller = new ProjectLaunchController({
      workspace: root,
      file,
      assertMutable: vi.fn(),
      flutterConfigurations: () => [{ name: 'App' }],
      flutterSessions: () => [],
      flutterConfiguration: () => ({
        toolArgs: [
          `--device-vmservice-port=${owner.port}`,
          `--dds-port=${owner.port}`,
          '--no-dds',
          '--host-vmservice-port=0',
        ],
      }),
      startFlutter,
      stopFlutter: vi.fn(),
    });
    try {
      await controller.start('flutter-app');
      expect(startFlutter).toHaveBeenCalledExactlyOnceWith('App', undefined);
      expect(owner.child.signalCode).toBeNull();
      expect(controller.snapshot().portConflict).toBeUndefined();
    } finally {
      await owner.stop();
      await controller.dispose();
    }
  });
});

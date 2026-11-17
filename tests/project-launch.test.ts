import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import {
  launchCommand,
  ProjectLaunchController,
  suggestedLaunchProfiles,
  validateLaunchDocument,
} from '../src/project-launch';

let root: string;
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

  it('starts and stops a configured Web package script without a shell', async () => {
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
    await controller.initialize();
    await expect(controller.start('web-dev')).resolves.toMatchObject({
      status: 'running',
      activeProfileId: 'web-dev',
      activeType: 'web',
    });
    await expect(fetch(`http://127.0.0.1:${port}/`)).resolves.toMatchObject({ status: 200 });
    expect(controller.snapshot().output).toContain('server.cjs');
    await controller.stop();
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
    } finally {
      await controller.dispose();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

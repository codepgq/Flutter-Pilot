import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJson } from 'jsonc-parser';
import { AgentAdapterManager, detectNodeRuntime } from '../src/mcp/adapters';
import { readConfig, writeConfig } from '../src/mcp/config-file';

describe('MCP Agent configuration adapters', () => {
  let temporary: string;
  let options: ConstructorParameters<typeof AgentAdapterManager>[0];
  let manager: AgentAdapterManager;
  beforeEach(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'flutter-pilot-adapter-')));
    options = {
      workspace: join(temporary, 'project'),
      bridgeRoot: join(temporary, 'bridge'),
      home: join(temporary, 'home'),
      codexHome: join(temporary, 'codex-user'),
      nodePath: process.execPath,
      detectClient: async () => true,
    };
    await mkdir(options.workspace, { recursive: true });
    manager = new AgentAdapterManager(options);
  });
  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it('defaults to project scope and preserves unrelated Claude settings', async () => {
    const path = manager.configPath('claude');
    await writeFile(
      path,
      '{\n  "custom": {"token": "synthetic-secret"},\n  "mcpServers": {"other": {"command": "other"}}\n}\n',
    );
    const state = await manager.adapt('claude');
    expect(state.status).toBe('configured');
    expect(state.scope).toBe('project');
    expect(state.message).not.toContain('synthetic-secret');
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('"custom": {"token": "synthetic-secret"}');
    const document = JSON.parse(raw);
    expect(document.mcpServers.other.command).toBe('other');
    expect(document.mcpServers['flutter-pilot'].args).toEqual([
      join(options.bridgeRoot, 'bridge.cjs'),
      '--registry',
      join(options.bridgeRoot, 'sessions'),
      '--workspace',
      options.workspace,
    ]);
    await expect(readFile(manager.configPath('claude', 'global'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the current CODEX_HOME and shares CLI/App configuration without rewriting it', async () => {
    const state = await manager.adapt('codex-cli');
    expect(state.shared).toBe(true);
    const raw = await readFile(state.path, 'utf8');
    expect((await manager.adapt('codex-app')).path).toBe(state.path);
    expect(await readFile(state.path, 'utf8')).toBe(raw);
    expect(manager.configPath('codex-cli', 'global')).toBe(join(options.codexHome!, 'config.toml'));
    const global = await manager.adapt('codex-cli', 'global');
    expect(
      (parseToml(await readFile(global.path, 'utf8')) as any).mcp_servers['flutter-pilot'].args,
    ).not.toContain('--workspace');
  });

  it('lists Cursor separately with its own project and global configuration paths', async () => {
    const states = await manager.all();
    expect(states.map((state) => state.agent)).toEqual(['claude', 'codex-cli', 'codex-app', 'cursor']);
    expect(states.find((state) => state.agent === 'cursor')).toMatchObject({
      scope: 'project',
      path: join(options.workspace, '.cursor', 'mcp.json'),
      status: 'not-configured',
      shared: false,
    });
    expect(manager.configPath('cursor', 'global')).toBe(join(options.home!, '.cursor', 'mcp.json'));
    expect(manager.configPath('cursor')).not.toBe(manager.configPath('codex-app'));
  });

  it('preserves Cursor JSON comments and trailing commas while keeping Claude JSON strict', async () => {
    const path = manager.configPath('cursor');
    await mkdir(dirname(path), { recursive: true });
    const original =
      '// personal servers\n{\n  "mcpServers": {\n    "other": {"command":"keep",}, // keep this server\n  },\n  /* unrelated preference */\n  "custom": [1,2,],\n}\n';
    await writeFile(path, original);
    expect((await manager.adapt('cursor')).configured).toBe(true);
    const output = await readFile(path, 'utf8');
    expect(output).toContain('// personal servers');
    expect(output).toContain('// keep this server');
    expect(output).toContain('/* unrelated preference */');
    expect(parseJson(output).mcpServers.other).toEqual({ command: 'keep' });
    await manager.remove('cursor');
    expect(parseJson(await readFile(path, 'utf8'))).toEqual(parseJson(original));
    await writeFile(manager.configPath('claude'), original);
    expect((await manager.inspect('claude')).status).toBe('invalid');
  });

  it('recognizes an existing Cursor stdio entry without an explicit type and leaves it intact', async () => {
    const state = await manager.adapt('cursor');
    const document = JSON.parse(await readFile(state.path, 'utf8'));
    delete document.mcpServers['flutter-pilot'].type;
    const legacy = JSON.stringify(document);
    await writeFile(state.path, legacy);
    expect((await manager.adapt('cursor')).configured).toBe(true);
    expect(await readFile(state.path, 'utf8')).toBe(legacy);
  });

  it.each(['project', 'global'] as const)(
    'writes only the Cursor %s service and preserves unrelated settings on adapt and remove',
    async (scope) => {
      const path = manager.configPath('cursor', scope);
      await mkdir(dirname(path), { recursive: true });
      const original =
        '{\n  "custom": {"token": "synthetic-secret"},\n  "mcpServers": {"other": {"command": "other", "env": {"TOKEN": "keep"}}}\n}\n';
      await writeFile(path, original);
      const state = await manager.adapt('cursor', scope);
      expect(state).toMatchObject({ agent: 'cursor', scope, status: 'configured', shared: false });
      expect(JSON.stringify(state)).not.toContain('synthetic-secret');
      const output = await readFile(path, 'utf8');
      expect(output).toContain('"custom": {"token": "synthetic-secret"}');
      const document = JSON.parse(output);
      expect(document.mcp_servers).toBeUndefined();
      expect(document.mcpServers['flutter-pilot']).toEqual({
        type: 'stdio',
        command: process.execPath,
        args: [
          join(options.bridgeRoot, 'bridge.cjs'),
          '--registry',
          join(options.bridgeRoot, 'sessions'),
          ...(scope === 'project' ? ['--workspace', options.workspace] : []),
        ],
      });
      await manager.adapt('cursor', scope);
      expect(await readFile(path, 'utf8')).toBe(output);
      await expect(
        readFile(manager.configPath('cursor', scope === 'project' ? 'global' : 'project')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(manager.configPath('claude', scope))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(manager.configPath('codex-app', scope))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await manager.remove('cursor', scope);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(JSON.parse(original));
    },
  );

  it('preserves TOML comments, unrelated sections and multiline strings when adding and removing', async () => {
    const path = manager.configPath('codex-cli');
    await mkdir(dirname(path), { recursive: true });
    const original =
      '# my settings\nmodel = "custom"\nnote = """\n[mcp_servers.flutter-pilot]\nthis is text\n"""\n\n[mcp_servers.other]\ncommand = "other" # keep\n';
    await writeFile(path, original);
    await manager.adapt('codex-cli');
    expect(await readFile(path, 'utf8')).toContain(original);
    await manager.remove('codex-app');
    expect((parseToml(await readFile(path, 'utf8')) as any).mcp_servers.other.command).toBe('other');
    expect(await readFile(path, 'utf8')).toContain('# keep');
  });

  it.each(['claude', 'cursor'] as const)(
    'does not overwrite a %s conflict until repair and never deletes an unowned entry',
    async (agent) => {
      const path = manager.configPath(agent);
      await mkdir(dirname(path), { recursive: true });
      const original = JSON.stringify({ mcpServers: { 'flutter-pilot': { command: 'custom' } } });
      await writeFile(path, original);
      expect((await manager.inspect(agent)).status).toBe('conflict');
      await expect(manager.adapt(agent)).rejects.toThrow('修复');
      await expect(manager.remove(agent)).rejects.toThrow('不是本插件');
      expect(await readFile(path, 'utf8')).toBe(original);
      await manager.adapt(agent, 'project', true);
      expect((await manager.inspect(agent)).configured).toBe(true);
      await manager.remove(agent);
      expect(JSON.parse(await readFile(path, 'utf8')).mcpServers).toEqual({});
    },
  );

  it('repairs quoted TOML sections and removes nested owned sections only', async () => {
    const path = manager.configPath('codex-cli');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      '# top\n[mcp_servers.\'flutter-pilot\']\ncommand="old"\n[mcp_servers.\'flutter-pilot\'.env]\nTEST="old"\n[mcp_servers.keep]\ncommand="keep"\n',
    );
    await manager.adapt('codex-cli', 'project', true);
    expect((parseToml(await readFile(path, 'utf8')) as any).mcp_servers.keep.command).toBe('keep');
    await manager.remove('codex-cli');
    expect((parseToml(await readFile(path, 'utf8')) as any).mcp_servers['flutter-pilot']).toBeUndefined();
  });

  it('repairs inline and dotted TOML layouts without losing other servers', async () => {
    const path = manager.configPath('codex-cli');
    await mkdir(dirname(path), { recursive: true });
    for (const original of [
      '# preserve\nmcp_servers={ other={command="other"}, "flutter-pilot"={command="old"} }\n',
      '# preserve\n[mcp_servers]\n"flutter-pilot"={command="old"}\nother={command="other"}\n',
      '# preserve\nmcp_servers."flutter-pilot".command="old"\nmcp_servers.other.command="other"\n',
    ]) {
      await writeFile(path, original);
      await manager.adapt('codex-cli', 'project', true);
      const output = await readFile(path, 'utf8');
      expect(output).toContain('# preserve');
      expect((parseToml(output) as any).mcp_servers.other.command).toBe('other');
      expect((await manager.inspect('codex-cli')).configured).toBe(true);
      await manager.remove('codex-cli');
      expect((parseToml(await readFile(path, 'utf8')) as any).mcp_servers.other.command).toBe('other');
    }
  });

  it('honors custom Claude and Codex configuration roots', async () => {
    manager = new AgentAdapterManager({
      ...options,
      codexHome: undefined,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(temporary, 'claude-custom'),
        CODEX_HOME: join(temporary, 'codex-custom'),
      },
    });
    expect(manager.configPath('claude', 'global')).toBe(join(temporary, 'claude-custom', '.claude.json'));
    expect(manager.configPath('codex-app', 'global')).toBe(join(temporary, 'codex-custom', 'config.toml'));
  });

  it('reports project configuration shadowing global even when both entries are managed', async () => {
    for (const agent of ['claude', 'codex-cli'] as const) {
      await manager.adapt(agent, 'global');
      await manager.adapt(agent, 'project');
      const global = await manager.inspect(agent, 'global');
      expect(global.configured).toBe(true);
      expect(global.shadowed).toBe(true);
      expect(global.effectiveScope).toBe('project');
      expect(global.effectivePath).toBe(manager.configPath(agent, 'project'));
      expect(global.effectiveMessage).toContain('策略状态未知');
      expect((await manager.inspect(agent, 'project')).shadowed).toBe(false);
    }
  });

  it('reports both Cursor scopes independently without claiming either configuration is shadowed', async () => {
    await manager.adapt('cursor', 'global');
    await manager.adapt('cursor', 'project');
    for (const scope of ['project', 'global'] as const) {
      const state = await manager.inspect('cursor', scope);
      expect(state.configured).toBe(true);
      expect(state.shadowed).toBe(false);
      expect(state.effectiveScope).toBe(scope);
      expect(state.effectivePath).toBe(manager.configPath('cursor', scope));
      expect(state.effectiveMessage).toContain('可能分别加载');
    }
  });

  it('reports Claude local overrides without returning credentials or command values', async () => {
    await manager.adapt('claude', 'project');
    const path = manager.configPath('claude', 'global');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        oauth: { token: 'secret-credential-fixture' },
        projects: {
          [options.workspace]: {
            mcpServers: {
              'flutter-pilot': { command: 'private-command-fixture', env: { TOKEN: 'secret-fixture' } },
            },
          },
        },
      }),
    );
    const state = await manager.inspect('claude');
    expect(state.shadowed).toBe(true);
    expect(state.effectiveScope).toBe('local');
    expect(state.effectivePath).toBe(path);
    expect(JSON.stringify(state)).not.toContain('secret');
    expect(JSON.stringify(state)).not.toContain('private-command-fixture');
  });

  it('does not claim precedence when another layer cannot be parsed', async () => {
    await manager.adapt('codex-cli', 'project');
    const path = manager.configPath('codex-cli', 'global');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'invalid {{{');
    const state = await manager.inspect('codex-cli');
    expect(state.configured).toBe(true);
    expect(state.effectiveScope).toBeUndefined();
    expect(state.shadowed).toBeUndefined();
    expect(state.effectiveMessage).toContain('无法确认覆盖关系');
  });

  it('rejects invalid files without changing their contents', async () => {
    for (const agent of ['claude', 'codex-cli', 'cursor'] as const) {
      const path = manager.configPath(agent);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'invalid {{{');
      expect((await manager.inspect(agent)).status).toBe('invalid');
      await expect(manager.adapt(agent)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe('invalid {{{');
    }
  });

  it('rejects external modification, writer collisions and symlink destinations', async () => {
    const path = manager.configPath('claude');
    await writeFile(path, '{}');
    const before = await readConfig(path);
    await writeFile(path, '{"changed":true}');
    await expect(writeConfig(path, before, '{"wrong":true}')).rejects.toThrow('外部修改');
    const latest = await readConfig(path);
    await writeFile(`${path}.flutter-pilot.lock`, '');
    await expect(writeConfig(path, latest, '{}')).rejects.toThrow('其他适配');
    await rm(`${path}.flutter-pilot.lock`);
    await rm(path);
    await writeFile(join(temporary, 'target'), '{}');
    await symlink(join(temporary, 'target'), path);
    expect((await manager.inspect('claude')).status).toBe('invalid');
    await expect(manager.adapt('claude')).rejects.toThrow('符号链接');
    expect(await readFile(join(temporary, 'target'), 'utf8')).toBe('{}');
  });

  it('detects a real runtime and reports client absence separately from configuration', async () => {
    expect(await detectNodeRuntime(process.execPath)).toBe(process.execPath);
    manager = new AgentAdapterManager({ ...options, detectClient: async () => false });
    const state = await manager.adapt('claude');
    expect(state.configured).toBe(true);
    expect(state.clientDetected).toBe(false);
    expect(state.message).toContain('未检测到客户端');
  });

  it('rejects a symbolic-link Cursor configuration directory without touching its target', async () => {
    const target = join(temporary, 'cursor-linked');
    await mkdir(target);
    await writeFile(join(target, 'mcp.json'), '{}');
    await symlink(target, join(options.workspace, '.cursor'));
    expect((await manager.inspect('cursor')).status).toBe('invalid');
    await expect(manager.adapt('cursor')).rejects.toThrow('符号链接');
    expect(await readFile(join(target, 'mcp.json'), 'utf8')).toBe('{}');
  });

  it.each(['cli', 'app', 'absent'] as const)(
    'detects Cursor %s without executing the client',
    async (source) => {
      const bin = join(temporary, 'bin');
      const applications = join(temporary, 'Applications');
      await mkdir(bin);
      await mkdir(applications);
      const marker = join(temporary, 'cursor-was-executed');
      if (source === 'cli') {
        const cursor = join(bin, 'cursor');
        await writeFile(cursor, `#!/bin/sh\ntouch '${marker}'\n`);
        await chmod(cursor, 0o700);
      } else if (source === 'app') await mkdir(join(applications, 'Cursor.app'));
      manager = new AgentAdapterManager({
        ...options,
        detectClient: undefined,
        env: { ...process.env, PATH: bin },
        applicationDirectories: [applications],
      });
      const state = await manager.adapt('cursor');
      expect(state.configured).toBe(true);
      expect(state.clientDetected).toBe(source !== 'absent');
      if (source === 'absent') expect(state.message).toContain('未检测到客户端');
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

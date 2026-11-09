import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { AgentAdapterManager, detectNodeRuntime } from '../src/mcp/adapters';
import { readConfig, writeConfig } from '../src/mcp/config-file';

describe('MCP Agent configuration adapters', () => {
  let temporary: string;
  let options: ConstructorParameters<typeof AgentAdapterManager>[0];
  let manager: AgentAdapterManager;
  beforeEach(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'api-mocks-adapter-')));
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
    expect(document.mcpServers['flutter-api-mocks'].args).toEqual([
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
      (parseToml(await readFile(global.path, 'utf8')) as any).mcp_servers['flutter-api-mocks'].args,
    ).not.toContain('--workspace');
  });

  it('preserves TOML comments, unrelated sections and multiline strings when adding and removing', async () => {
    const path = manager.configPath('codex-cli');
    await mkdir(dirname(path), { recursive: true });
    const original =
      '# my settings\nmodel = "custom"\nnote = """\n[mcp_servers.flutter-api-mocks]\nthis is text\n"""\n\n[mcp_servers.other]\ncommand = "other" # keep\n';
    await writeFile(path, original);
    await manager.adapt('codex-cli');
    expect(await readFile(path, 'utf8')).toContain(original);
    await manager.remove('codex-app');
    expect((parseToml(await readFile(path, 'utf8')) as any).mcp_servers.other.command).toBe('other');
    expect(await readFile(path, 'utf8')).toContain('# keep');
  });

  it('does not overwrite a conflict until repair and never deletes an unowned entry', async () => {
    const path = manager.configPath('claude');
    const original = JSON.stringify({ mcpServers: { 'flutter-api-mocks': { command: 'custom' } } });
    await writeFile(path, original);
    expect((await manager.inspect('claude')).status).toBe('conflict');
    await expect(manager.adapt('claude')).rejects.toThrow('修复');
    await expect(manager.remove('claude')).rejects.toThrow('不是本插件');
    expect(await readFile(path, 'utf8')).toBe(original);
    await manager.adapt('claude', 'project', true);
    expect((await manager.inspect('claude')).configured).toBe(true);
    await manager.remove('claude');
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers).toEqual({});
  });

  it('repairs quoted TOML sections and removes nested owned sections only', async () => {
    const path = manager.configPath('codex-cli');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      '# top\n[mcp_servers.\'flutter-api-mocks\']\ncommand="old"\n[mcp_servers.\'flutter-api-mocks\'.env]\nTEST="old"\n[mcp_servers.keep]\ncommand="keep"\n',
    );
    await manager.adapt('codex-cli', 'project', true);
    expect((parseToml(await readFile(path, 'utf8')) as any).mcp_servers.keep.command).toBe('keep');
    await manager.remove('codex-cli');
    expect((parseToml(await readFile(path, 'utf8')) as any).mcp_servers['flutter-api-mocks']).toBeUndefined();
  });

  it('repairs inline and dotted TOML layouts without losing other servers', async () => {
    const path = manager.configPath('codex-cli');
    await mkdir(dirname(path), { recursive: true });
    for (const original of [
      '# preserve\nmcp_servers={ other={command="other"}, "flutter-api-mocks"={command="old"} }\n',
      '# preserve\n[mcp_servers]\n"flutter-api-mocks"={command="old"}\nother={command="other"}\n',
      '# preserve\nmcp_servers."flutter-api-mocks".command="old"\nmcp_servers.other.command="other"\n',
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
              'flutter-api-mocks': { command: 'private-command-fixture', env: { TOKEN: 'secret-fixture' } },
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
    for (const agent of ['claude', 'codex-cli'] as const) {
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
    await writeFile(`${path}.api-mocks.lock`, '');
    await expect(writeConfig(path, latest, '{}')).rejects.toThrow('其他适配');
    await rm(`${path}.api-mocks.lock`);
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
});

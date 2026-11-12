import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProjectBinding } from '../src/project';

let root: string;
let workspace: string;
let legacy: string;
const rule = {
  id: 'saved-rule',
  name: 'Saved example',
  enabled: true,
  priority: 0,
  match: { path: '/sample' },
  mock: { status: 200, headers: {}, body: '{"sample":true}' },
};
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'flutter-pilot-project-'));
  workspace = join(root, 'flutter-project');
  legacy = join(root, 'private-legacy');
  await mkdir(workspace);
  await mkdir(legacy);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('project-local identity and configuration', () => {
  it('preserves and validates the independent project VM auto-connect setting', async () => {
    const binding = await openProjectBinding(workspace, legacy);
    const config = { ...binding.config, settings: { autoStart: true, autoConnectVm: false } };
    await writeFile(binding.file, JSON.stringify(config));
    expect((await binding.reload()).settings).toEqual({ autoStart: true, autoConnectVm: false });
    await binding.saveConnection({ mode: 'proxy' });
    expect((await json(binding.file)).settings.autoConnectVm).toBe(false);
    await writeFile(binding.file, JSON.stringify({ ...config, settings: { autoConnectVm: 'yes' } }));
    await expect(binding.reload()).rejects.toThrow('settings.autoConnectVm 必须是布尔值');
  });
  it('creates a stable UUID with VM default and ordinary private-permission files', async () => {
    const binding = await openProjectBinding(workspace, legacy);
    expect(binding.config).toMatchObject({ version: 1, name: 'flutter-project', connection: { mode: 'vm' } });
    expect(binding.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(binding.rulesDirectory).toBe(join(await realpath(workspace), '.flutter-pilot'));
    expect(await json(join(binding.directory, 'scenes.json'))).toMatchObject({
      version: 1,
      activeSceneId: null,
      scenes: [{ name: '默认场景', httpRules: [], wsRules: [] }],
    });
    const reopened = await openProjectBinding(workspace, legacy);
    expect(reopened.projectId).toBe(binding.projectId);
    expect((await lstat(binding.file)).mode & 0o777).toBe(0o600);
    expect((await lstat(binding.directory)).mode & 0o777).toBe(0o700);
    const copy = binding.config;
    copy.name = 'not persisted';
    expect(binding.config.name).toBe('flutter-project');
  });

  it('imports legacy rules and connection once while retaining the original private files', async () => {
    const connection = {
      lan: false,
      connectionHost: '127.0.0.1',
      port: 8080,
      configuredPort: 8080,
      androidDevices: ['private-serial'],
      wsUrl: 'ws://private-token/ws',
    };
    const document = { version: 1, rules: [rule] };
    await writeFile(join(legacy, 'connection.json'), JSON.stringify(connection));
    await writeFile(join(legacy, 'rules.json'), JSON.stringify(document));
    await mkdir(join(workspace, '.flutter-pilot'));
    await writeFile(join(workspace, '.flutter-pilot', 'rules.json'), JSON.stringify(document));
    const binding = await openProjectBinding(workspace, legacy);
    expect(binding.config.connection).toEqual({
      mode: 'proxy',
      lan: false,
      connectionHost: '127.0.0.1',
      port: 8080,
      configuredPort: 8080,
    });
    expect((await json(join(binding.directory, 'scenes.json'))).scenes[0].httpRules).toEqual([rule]);
    expect(await json(join(legacy, 'rules.json'))).toEqual(document);
    expect(await json(join(legacy, 'connection.json'))).toEqual(connection);
    expect(await readFile(binding.file, 'utf8')).not.toContain('private-');
    await binding.saveConnection({ mode: 'vm' });
    await writeFile(join(legacy, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));
    const reopened = await openProjectBinding(workspace, legacy);
    expect(reopened.config.connection.mode).toBe('vm');
    expect((await json(join(binding.directory, 'scenes.json'))).scenes[0].httpRules).toEqual([rule]);
  });

  it('preserves manually edited settings and unknown fields when saving connection changes', async () => {
    const binding = await openProjectBinding(workspace, legacy);
    await writeFile(
      binding.file,
      JSON.stringify({
        ...binding.config,
        name: 'Team project',
        notes: { text: 'keep me' },
        settings: { retentionDays: 30 },
        connection: { mode: 'vm', futureField: 'keep this too' },
      }),
    );
    await binding.saveConnection({
      mode: 'proxy',
      port: 18080,
      androidDevices: ['never-save'],
      wsUrl: 'ws://never-save/ws',
    } as any);
    expect(await json(binding.file)).toMatchObject({
      name: 'Team project',
      notes: { text: 'keep me' },
      settings: { retentionDays: 30 },
      connection: { mode: 'proxy', port: 18080, futureField: 'keep this too' },
    });
    expect(await readFile(binding.file, 'utf8')).not.toContain('never-save');
    expect((await binding.reload()).name).toBe('Team project');
  });

  it('copied project files retain identity but settings and rules remain local to each directory', async () => {
    const first = await openProjectBinding(workspace, legacy);
    const secondWorkspace = join(root, 'second-copy');
    await cp(workspace, secondWorkspace, { recursive: true });
    const second = await openProjectBinding(secondWorkspace, join(root, 'empty-other-private-storage'));
    expect(first.projectId).toBe(second.projectId);
    expect(first.directory).not.toBe(second.directory);
    await second.saveConnection({ mode: 'proxy' });
    expect((await first.reload()).connection.mode).toBe('vm');
    expect((await second.reload()).connection.mode).toBe('proxy');
    const doc = await json(join(second.directory, 'scenes.json'));
    doc.scenes[0].httpRules = [rule];
    await writeFile(join(second.directory, 'scenes.json'), JSON.stringify(doc));
    expect((await json(join(first.directory, 'scenes.json'))).scenes[0].httpRules).toEqual([]);
  });

  it('concurrent initializers see one winning UUID and leave no temporary files', async () => {
    const bindings = await Promise.all(
      Array.from({ length: 8 }, () => openProjectBinding(workspace, legacy)),
    );
    expect(new Set(bindings.map((binding) => binding.projectId)).size).toBe(1);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(bindings[0].directory)).sort()).toEqual(['project.json', 'scenes.json']);
  });

  it.each([
    ['version', { version: 2 }, 'version'],
    ['UUID', { projectId: '../other-project' }, 'UUID'],
    ['mode', { connection: { mode: 'unsupported' } }, 'mode'],
    ['port', { connection: { mode: 'vm', port: 80 } }, 'port'],
    ['host', { connection: { mode: 'vm', connectionHost: 'ws://secret-token/ws' } }, '主机'],
    ['retention', { settings: { retentionDays: 0 } }, 'retentionDays'],
    ['record count', { settings: { maxRecords: 100001 } }, 'maxRecords'],
    ['body limit', { settings: { maxBodyBytes: 512 } }, 'maxBodyBytes'],
    ['timeout', { settings: { breakpointTimeout: 301 } }, 'breakpointTimeout'],
    ['autoStart', { settings: { autoStart: 'true' } }, 'autoStart'],
  ])('does not reset invalid existing configuration: %s', async (_label, patch, hint) => {
    const binding = await openProjectBinding(workspace, legacy);
    const invalid = JSON.stringify({ ...binding.config, ...patch });
    await writeFile(binding.file, invalid);
    await expect(openProjectBinding(workspace, legacy)).rejects.toThrow(hint);
    expect(await readFile(binding.file, 'utf8')).toBe(invalid);
  });

  it('does not expose malformed JSON contents or overwrite invalid existing rules', async () => {
    const binding = await openProjectBinding(workspace, legacy);
    await writeFile(binding.file, '{"private-authentication-value": invalid');
    await expect(openProjectBinding(workspace, legacy)).rejects.not.toThrow('private-authentication-value');
    await writeFile(binding.file, JSON.stringify(binding.config));
    await writeFile(join(binding.directory, 'scenes.json'), '{"private-rule-value": invalid');
    await expect(openProjectBinding(workspace, legacy)).rejects.toThrow('有效 JSON');
    expect(await readFile(join(binding.directory, 'scenes.json'), 'utf8')).toContain('private-rule-value');
  });

  it('rejects a changed UUID during reload or save until the workspace is reopened', async () => {
    const binding = await openProjectBinding(workspace, legacy);
    const { randomUUID } = await import('node:crypto');
    await writeFile(binding.file, JSON.stringify({ ...binding.config, projectId: randomUUID() }));
    await expect(binding.reload()).rejects.toThrow('UUID 已变更');
    await expect(binding.saveConnection({ mode: 'proxy' })).rejects.toThrow('UUID 已变更');
  });

  it.each(['directory', 'project', 'rules'])(
    'rejects a %s symlink and leaves the external target untouched',
    async (kind) => {
      const outside = join(root, 'outside');
      await mkdir(outside);
      if (kind === 'directory') await symlink(outside, join(workspace, '.flutter-pilot'));
      else {
        const binding = await openProjectBinding(workspace, legacy);
        const file = join(binding.directory, kind === 'project' ? 'project.json' : 'scenes.json');
        const target = join(outside, 'target.json');
        await writeFile(target, 'untouched');
        await rm(file);
        await symlink(target, file);
      }
      await expect(openProjectBinding(workspace, legacy)).rejects.toThrow('符号链接');
      if (kind !== 'directory')
        expect(await readFile(join(outside, 'target.json'), 'utf8')).toBe('untouched');
    },
  );

  it('reload rejects rules replaced by a symlink after initialization', async () => {
    const binding = await openProjectBinding(workspace, legacy);
    const rules = join(binding.directory, 'scenes.json');
    const target = join(root, 'external-rules.json');
    await writeFile(target, JSON.stringify({ version: 1, rules: [rule] }));
    await rm(rules);
    await symlink(target, rules);
    await expect(binding.reload()).rejects.toThrow('符号链接');
    expect((await json(target)).rules).toEqual([rule]);
  });

  it('recreated project cannot reimport legacy rules or connection claimed by the old UUID', async () => {
    await writeFile(join(legacy, 'rules.json'), JSON.stringify({ version: 1, rules: [rule] }));
    await writeFile(join(legacy, 'connection.json'), JSON.stringify({ mode: 'proxy' }));
    const first = await openProjectBinding(workspace, legacy);
    expect((await json(join(first.directory, 'scenes.json'))).scenes[0].httpRules).toEqual([]);
    await rm(first.directory, { recursive: true });
    const recreated = await openProjectBinding(workspace, legacy);
    expect(recreated.projectId).not.toBe(first.projectId);
    expect(recreated.config.connection.mode).toBe('vm');
    expect((await json(join(recreated.directory, 'scenes.json'))).scenes[0].httpRules).toEqual([]);
    expect((await json(join(legacy, 'project-binding.json'))).projectId).toBe(first.projectId);
    expect((await json(join(legacy, 'rules.json'))).rules).toEqual([rule]);
  });

  it('changing project UUID cannot import the old claimed rules when project rules are missing', async () => {
    const { randomUUID } = await import('node:crypto');
    await writeFile(join(legacy, 'rules.json'), JSON.stringify({ version: 1, rules: [rule] }));
    const first = await openProjectBinding(workspace, legacy);
    const nextId = randomUUID();
    await writeFile(first.file, JSON.stringify({ ...first.config, projectId: nextId }));
    await rm(join(first.directory, 'scenes.json'));
    const reopened = await openProjectBinding(workspace, legacy);
    expect(reopened.projectId).toBe(nextId);
    expect((await json(join(reopened.directory, 'scenes.json'))).scenes[0].httpRules).toEqual([]);
    expect((await json(join(legacy, 'project-binding.json'))).projectId).toBe(first.projectId);
  });

  it('reload rejects missing rules instead of allowing an empty in-memory overwrite', async () => {
    const binding = await openProjectBinding(workspace, legacy);
    await rm(join(binding.directory, 'scenes.json'));
    await expect(binding.reload()).rejects.toThrow('规则文件已移除');
  });
});

import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateRuleDocument } from './model';
import { validateWsRuleDocument } from './ws/model';
import { validateSceneDocument, type Scene, type SceneDocument } from './scene-model';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const maxBytes = 64 * 1024 * 1024;

/** Copy a scene group while keeping explicit calls inside the copied group. */
export function cloneScenes(scenes: Scene[]): Scene[] {
  const sceneIds = new Map(scenes.map((scene) => [scene.id, randomUUID()]));
  return structuredClone(scenes).map((scene) => {
    scene.id = sceneIds.get(scene.id)!;
    for (const rule of [...scene.httpRules, ...scene.wsRules]) rule.id = randomUUID();
    for (const action of scene.actions ?? [])
      for (const step of action.steps)
        if (step.type === 'call' && step.sceneId !== undefined && sceneIds.has(step.sceneId))
          step.sceneId = sceneIds.get(step.sceneId)!;
    return scene;
  });
}

/** Single project-owned source for Mock rules and Scene actions. Legacy network rules are read only once. */
export class SceneStore {
  readonly file: string;
  private operations: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {
    this.file = join(directory, 'scenes.json');
  }
  private async text(file = this.file): Promise<string | undefined> {
    try {
      const directory = await lstat(this.directory);
      const info = await lstat(file);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !info.isFile() || info.isSymbolicLink())
        throw new Error('场景目录和文件必须是普通目录和文件，不能使用符号链接');
      if (info.size > maxBytes) throw new Error('场景文件最多 64 MiB');
      return await readFile(file, 'utf8');
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  private json(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('场景或旧规则文件不是有效 JSON，请修复后读取项目文件');
    }
  }
  private parse(text: string) {
    return validateSceneDocument(this.json(text));
  }
  async read(): Promise<SceneDocument> {
    const text = await this.text();
    if (text === undefined) throw new Error('场景文件已移除，请恢复文件后重新读取');
    return this.parse(text);
  }
  async load(): Promise<SceneDocument> {
    const existing = await this.text();
    if (existing !== undefined) return this.parse(existing);
    const http = await this.text(join(this.directory, 'rules.json'));
    const ws = await this.text(join(this.directory, 'ws-rules.json'));
    const document: SceneDocument = {
      version: 1,
      activeSceneId: null,
      scenes: [
        {
          id: randomUUID(),
          name: '默认场景',
          httpRules: http === undefined ? [] : validateRuleDocument(this.json(http)).rules,
          wsRules: ws === undefined ? [] : validateWsRuleDocument(this.json(ws), false).rules,
        },
      ],
    };
    validateSceneDocument(document);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('场景目录无效');
    const temporary = join(this.directory, `.scenes-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      try {
        await link(temporary, this.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return this.parse((await this.text())!);
  }
  save(input: unknown, expected: SceneDocument): Promise<SceneDocument> {
    const document = validateSceneDocument(input);
    const serialized = JSON.stringify(document, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > maxBytes) return Promise.reject(new Error('场景文件最多 64 MiB'));
    const snapshot = JSON.stringify(expected);
    const operation = this.operations.then(async () => {
      const before = await this.text();
      if (before === undefined || JSON.stringify(this.parse(before)) !== snapshot)
        throw new Error('场景文件已被修改，请先读取项目文件，再编辑场景');
      const temporary = join(this.directory, `.scenes-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
        if ((await this.text()) !== before) throw new Error('场景文件已被修改，请先读取项目文件');
        await rename(temporary, this.file);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return document;
    });
    this.operations = operation.catch(() => undefined);
    return operation;
  }
}

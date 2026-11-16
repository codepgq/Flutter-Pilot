import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateSceneDocument, type SceneDocument } from './scene-model';
import { compileSceneAction } from './workflows/model';
import { SceneStore } from './scenes';
import { hash, json, readText, safePath, SceneFiles } from './scene-files';

const normalized = (doc: SceneDocument) =>
  doc.scenes.map((scene) => ({ ...scene, targets: scene.targets ?? {}, actions: scene.actions ?? [] }));
/** Explicit v1 conversion; never activated implicitly and never replaces an existing v2 directory. */
export async function migrateScenes(directory: string, apply = false) {
  const original = await readText(directory, 'scenes.json', 64 * 1024 * 1024);
  if (original === undefined) throw new Error('没有可迁移的 scenes.json');
  const doc = validateSceneDocument(JSON.parse(original));
  const stageName = `.scene-migration-${randomUUID()}`,
    stage = join(directory, stageName);
  await safePath(directory, stageName);
  await mkdir(stage, { mode: 0o700 });
  try {
    const repository = new SceneStore(stage);
    await repository.load();
    await repository.importPackage({ version: 2, scenes: doc.scenes }, false);
    const pkg = await repository.exportPackage();
    const assembled: SceneDocument = { version: 1, activeSceneId: null, scenes: pkg.scenes };
    if (!isDeepStrictEqual(normalized(doc), normalized(assembled))) throw new Error('迁移装配校验失败');
    let actions = 0,
      bodyBytes = 0;
    for (const scene of doc.scenes) {
      for (const rule of scene.httpRules)
        for (const body of [rule.request?.body, rule.response?.body, rule.mock?.body])
          if (body !== undefined) bodyBytes += Buffer.byteLength(body);
      for (const rule of scene.wsRules)
        if (rule.action.text !== undefined) bodyBytes += Buffer.byteLength(rule.action.text);
      for (const action of scene.actions ?? []) {
        const inputs = Object.fromEntries(
          Object.entries(action.inputs ?? {}).map(([name, spec]) => [
            name,
            spec.default ?? 'migration-sample',
          ]),
        );
        const before = compileSceneAction(doc, scene.id, action.id, inputs),
          after = compileSceneAction(assembled, scene.id, action.id, inputs);
        if (!isDeepStrictEqual(before, after)) throw new Error(`操作展开不一致：${scene.id}/${action.id}`);
        actions++;
      }
    }
    const report = {
      version: 2,
      mode: apply ? 'apply' : 'preflight',
      source: join(directory, 'scenes.json'),
      root: join(directory, 'scenes', 'index.json'),
      sourceHash: hash(original),
      sceneCount: doc.scenes.length,
      actionCount: actions,
      bodyBytes,
      previousActiveSceneId: doc.activeSceneId,
      activeSceneId: null,
      verified: true,
    };
    if (apply)
      await new SceneFiles(directory).locked(async () => {
        if ((await readText(directory, 'scenes.json', 64 * 1024 * 1024)) !== original)
          throw new Error('迁移期间旧文件已被修改，请重新预检');
        const target = await safePath(directory, 'scenes');
        // Reserve with mkdir (exclusive); rename cannot replace any pre-existing user directory.
        await mkdir(target, { mode: 0o700 });
        try {
          await rename(join(stage, 'scenes'), target);
        } catch (error) {
          await rmdir(target).catch(() => undefined);
          throw error;
        }
        await writeFile(join(directory, `scene-migration-${randomUUID()}.json`), json(report), {
          flag: 'wx',
          mode: 0o600,
        });
      });
    return report;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

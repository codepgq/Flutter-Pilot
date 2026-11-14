import { validateRuleDocument, type Rule } from './model';
import { validateWsRuleDocument, type WsRule } from './ws/model';
import type { Selector } from './automation/model';
import { validateSceneActions, type SceneAction } from './workflows/model';

export interface Scene {
  id: string;
  name: string;
  httpRules: Rule[];
  wsRules: WsRule[];
  targets?: Record<string, Selector>;
  actions?: SceneAction[];
}
export interface SceneDocument {
  version: 1;
  activeSceneId: string | null;
  scenes: Scene[];
}
export type SceneDomainStatus = 'unneeded' | 'pending' | 'applied' | 'error' | 'unsupported' | 'paused';
export interface SceneRuntime {
  revision: number;
  http: { status: SceneDomainStatus; message?: string };
  ws: { status: SceneDomainStatus; message?: string };
}

export function validateSceneDocument(input: unknown): SceneDocument {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('场景文件必须为对象');
  const doc = input as SceneDocument;
  if (
    Object.keys(doc).some((key) => !['version', 'activeSceneId', 'scenes'].includes(key)) ||
    doc.version !== 1
  )
    throw new Error('场景文件仅支持 version: 1 和 activeSceneId、scenes');
  if (!Array.isArray(doc.scenes) || doc.scenes.length > 1000)
    throw new Error('scenes 必须为数组，最多 1000 个场景');
  const ids = new Set<string>();
  const ruleIds = { http: new Set<string>(), ws: new Set<string>() };
  for (const scene of doc.scenes) {
    if (
      !scene ||
      typeof scene !== 'object' ||
      Array.isArray(scene) ||
      Object.keys(scene).some(
        (key) => !['id', 'name', 'httpRules', 'wsRules', 'targets', 'actions'].includes(key),
      )
    )
      throw new Error('场景包含无效或未知字段');
    if (typeof scene.id !== 'string' || !scene.id.trim() || scene.id.length > 128 || ids.has(scene.id))
      throw new Error('场景 ID 无效或重复');
    ids.add(scene.id);
    if (typeof scene.name !== 'string' || !scene.name.trim() || scene.name.length > 256)
      throw new Error('场景名称不能为空，最多 256 字符');
    validateRuleDocument({ version: 1, rules: scene.httpRules });
    validateWsRuleDocument({ version: 1, rules: scene.wsRules }, false);
    for (const [domain, rules] of [
      ['http', scene.httpRules],
      ['ws', scene.wsRules],
    ] as const) {
      for (const rule of rules) {
        if (ruleIds[domain].has(rule.id)) throw new Error(`${domain} 规则 ID 在场景之间重复`);
        ruleIds[domain].add(rule.id);
      }
    }
  }
  if (doc.activeSceneId !== null && (typeof doc.activeSceneId !== 'string' || !ids.has(doc.activeSceneId)))
    throw new Error('activeSceneId 必须为 null 或已有场景 ID');
  return structuredClone(validateSceneActions(doc));
}

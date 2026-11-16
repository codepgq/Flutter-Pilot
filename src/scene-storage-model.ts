import { z } from 'zod';
import type { Rule } from './model';
import type { WsRule } from './ws/model';
import type { Scene } from './scene-model';
import type { SceneAction } from './workflows/model';

const id = z.string().min(1).max(128);
const file = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !/[\\/\x00-\x1f]/.test(v) && v !== '.' && v !== '..', '必须为单个普通文件名');
const mapping = (kind: string) =>
  z.object({ id, file: file.refine((v) => v.endsWith('.json'), `${kind} 必须是 JSON 文件`) }).strict();
export const indexSchema = z
  .object({ version: z.literal(2), scenes: z.array(z.object({ id, directory: file }).strict()) })
  .strict();
export const manifestSchema = z
  .object({
    id,
    name: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0, '名称不能为空'),
    http: z.array(mapping('HTTP')),
    ws: z.array(mapping('WS')),
    actions: z.array(mapping('action')),
  })
  .strict();
export type SceneIndex = z.infer<typeof indexSchema>;
export type SceneManifest = z.infer<typeof manifestSchema>;
export type ResourceKind = 'http' | 'ws' | 'actions' | 'targets' | 'scene';
export interface ResourceAddress {
  sceneId: string;
  kind: ResourceKind;
  id?: string;
}
export interface Resource<T> {
  address: ResourceAddress;
  value: T;
  file: string;
  hash: string;
  version: number;
  files: Record<string, string>;
}
export type StoredHttpRule = Omit<Rule, 'request' | 'response' | 'mock'> & {
  request?: Omit<NonNullable<Rule['request']>, 'body'> & { body?: string; bodyFile?: string };
  response?: Omit<NonNullable<Rule['response']>, 'body'> & { body?: string; bodyFile?: string };
  mock?: Omit<NonNullable<Rule['mock']>, 'body'> & { body?: string; bodyFile?: string };
};
export type StoredWsRule = Omit<WsRule, 'action'> & {
  action: { type: 'replace' | 'drop'; text?: string; textFile?: string };
};
export interface RuleSummary {
  overview?: Rule | WsRule;
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  file: string;
  hash: string;
}
export interface ActionSummary {
  id: string;
  name: string;
  description?: string;
  inputs?: SceneAction['inputs'];
  stepCount: number;
  file: string;
  hash: string;
  blocked?: string;
}
export interface SceneSummary {
  id: string;
  name: string;
  directory: string;
  file: string;
  hash: string;
  httpRuleCount: number;
  wsRuleCount: number;
  actionCount: number;
  targetCount: number;
  enabledHttpRuleCount: number;
  enabledWsRuleCount: number;
  health: 'valid' | 'error';
  errors: string[];
}
export interface ScenePage {
  version: 2;
  revision: number;
  root: string;
  total: number;
  offset: number;
  limit: number;
  search: string;
  scenes: SceneSummary[];
  error?: string;
  warning?: string;
  activeSceneId?: string | null;
  activeScene?: { id: string; name: string };
}
export interface SceneDetail {
  id: string;
  name: string;
  file: string;
  hash: string;
  version: number;
  directory: string;
  http: RuleSummary[];
  ws: RuleSummary[];
  actions: ActionSummary[];
  targets: Scene['targets'];
  health: SceneSummary['health'];
  errors: string[];
}
export interface ScenePackage {
  version: 2;
  scenes: Scene[];
}

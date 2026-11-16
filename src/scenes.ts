import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateRuleDocument, type Rule } from './model';
import { validateWsRuleDocument, type WsRule } from './ws/model';
import { validateSceneDocument, type Scene, type SceneDocument } from './scene-model';
import {
  sceneActionSchema,
  validateSceneActions,
  type ActionReference,
  type SceneAction,
} from './workflows/model';
import {
  hash,
  json,
  missing,
  readText,
  safePath,
  SceneConflict,
  SceneFiles,
  type FileChange,
} from './scene-files';
import {
  indexSchema,
  manifestSchema,
  type SceneIndex,
  type SceneManifest,
  type SceneSummary,
  type ScenePage,
  type SceneDetail,
  type ResourceAddress,
  type Resource,
  type ResourceKind,
  type RuleSummary,
  type ActionSummary,
  type ScenePackage,
} from './scene-storage-model';
export type { ScenePage, SceneDetail, ResourceAddress, Resource } from './scene-storage-model';

export function cloneScenes(scenes: Scene[]): Scene[] {
  const ids = new Map(scenes.map((scene) => [scene.id, randomUUID()]));
  return structuredClone(scenes).map((scene) => {
    scene.id = ids.get(scene.id)!;
    for (const rule of [...scene.httpRules, ...scene.wsRules]) rule.id = randomUUID();
    for (const action of scene.actions ?? [])
      for (const step of action.steps)
        if (step.type === 'call' && step.sceneId !== undefined && ids.has(step.sceneId))
          step.sceneId = ids.get(step.sceneId)!;
    return scene;
  });
}
interface Cached {
  signature: string;
  hash: string;
  value: any;
}
interface Entry {
  manifest?: SceneManifest;
  summary: SceneSummary;
  http: RuleSummary[];
  ws: RuleSummary[];
  actions: ActionSummary[];
  targets: Scene['targets'];
  sourceErrors?: string[];
  dependencies: Map<string, ActionReference[]>;
}
const key = (ref: ActionReference) => JSON.stringify([ref.sceneId, ref.actionId]);
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const message = (error: unknown) => (error instanceof Error ? error.message : '配置读取失败');
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} 重复`);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function bodySlots(
  rule: any,
  kind: 'http' | 'ws',
): Array<{ owner: any; field: 'body' | 'text'; ref: 'bodyFile' | 'textFile' }> {
  if (!object(rule)) throw new Error('规则必须是对象');
  return kind === 'http'
    ? ['request', 'response', 'mock'].flatMap((name) =>
        rule[name] === undefined
          ? []
          : [{ owner: rule[name], field: 'body' as const, ref: 'bodyFile' as const }],
      )
    : [{ owner: rule.action, field: 'text', ref: 'textFile' }];
}
function bodyPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^bodies\/[^/\\\x00-\x1f]+$/.test(value) ||
    ['.', '..'].includes(value.slice(7))
  )
    throw new Error('正文路径必须指向所属 Scene 的 bodies 普通文件');
  return value;
}
function inlineForValidation(value: any, kind: 'http' | 'ws') {
  const result = structuredClone(value);
  for (const slot of bodySlots(result, kind)) {
    if (!object(slot.owner)) throw new Error('规则正文容器无效');
    if (slot.owner[slot.ref] !== undefined) {
      bodyPath(slot.owner[slot.ref]);
      if (slot.owner[slot.field] !== undefined) throw new Error(`${slot.field} 与 ${slot.ref} 互斥`);
      delete slot.owner[slot.ref];
      slot.owner[slot.field] = '';
    }
  }
  if (kind === 'http') return validateRuleDocument({ version: 1, rules: [result] }).rules[0];
  return validateWsRuleDocument({ version: 1, rules: [result] }, false).rules[0];
}

/** Directory-backed resources. Bodies are read only for an individual rule or execution snapshot. */
export class SceneStore {
  readonly file: string;
  readonly files: SceneFiles;
  revision = 0;
  error?: string;
  activeSceneId: string | null = null;
  private index: SceneIndex = { version: 2, scenes: [] };
  private indexHash: string | null = null;
  private entries = new Map<string, Entry>();
  private cache = new Map<string, Cached>();
  private initialized = false;
  private activationWarning?: string;
  private loadedCaches = new Set<string>();
  private dirtyCaches = new Set<string>();
  private bodyErrors = new Map<string, { signature: string; error: string }>();
  private names = new Map<string, { name: string; sceneId: string; sceneName: string }>();
  readonly metrics = { reads: 0, bodyReads: 0, bytes: 0 };
  constructor(
    readonly directory: string,
    readonly privateDirectory = join(directory, '.private-scenes'),
    fault?: (phase: string, index: number) => void,
  ) {
    this.file = join(directory, 'scenes', 'index.json');
    this.files = new SceneFiles(directory, fault);
  }
  private async text(path: string, checks?: Map<string, string | null>): Promise<string> {
    const value = await readText(this.directory, path);
    this.metrics.reads++;
    if (path.includes('/bodies/')) this.metrics.bodyReads++;
    if (value === undefined) throw new Error(`配置文件缺失：${join(this.directory, path)}`);
    this.metrics.bytes += Buffer.byteLength(value);
    if (checks?.has(path) && checks.get(path) !== hash(value)) throw new SceneConflict(path);
    checks?.set(path, hash(value));
    return value;
  }
  private async metadata(path: string, transform: (value: any) => any = (value) => value): Promise<Cached> {
    const info = await lstat(await safePath(this.directory, path));
    if (!info.isFile()) throw new Error(`资源不是普通文件：${path}`);
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = this.cache.get(path);
    if (cached?.signature === signature) return cached;
    const raw = await this.text(path);
    let value: any;
    try {
      value = transform(JSON.parse(raw));
    } catch (error) {
      throw new Error(`${path}：${error instanceof SyntaxError ? '无效 JSON' : message(error)}`);
    }
    const next = { signature, hash: hash(raw), value };
    this.cache.set(path, next);
    this.dirtyCaches.add(path.split('/')[1]);
    return next;
  }
  private async privateWrite(name: string, value: unknown) {
    const file = await safePath(this.privateDirectory, name, true);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, json(value), { flag: 'wx', mode: 0o600 });
    await rename(tmp, file);
  }
  async load() {
    if (!this.initialized) {
      try {
        const active = JSON.parse((await readText(this.privateDirectory, 'scene-active.json')) ?? 'null');
        if (active !== null && (!object(active) || (active.id !== null && typeof active.id !== 'string')))
          throw new Error('激活记录格式无效');
        this.activeSceneId = active?.id ?? null;
      } catch (error) {
        this.activeSceneId = null;
        this.activationWarning = `私有激活记录读取失败，未激活场景：${message(error)}`;
      }
    }
    await this.files.locked(async () => {
      if ((await readText(this.directory, 'scenes/index.json')) === undefined) {
        if (this.initialized) throw new Error('根清单已移除，请恢复后重新读取');
        if ((await readText(this.directory, 'scenes.json', 64 * 1024 * 1024)) !== undefined)
          throw new Error('发现旧 scenes.json，请先运行 Scene v1 → v2 迁移工具；未创建空配置');
        const scenesDirectory = await lstat(await safePath(this.directory, 'scenes')).catch((error) => {
          if (!missing(error)) throw error;
          return undefined;
        });
        if (scenesDirectory) return;
        await this.files.commit([
          { path: 'scenes/index.json', expected: null, text: json({ version: 2, scenes: [] }) },
        ]);
      }
    });
    try {
      await this.reload();
    } catch (error) {
      if ((error as Error).message !== this.error) throw error;
    }
    this.initialized = true;
    return this.listScenes();
  }
  reload() {
    return this.files.locked(() => this.scan());
  }
  private async scan(changed?: Set<string>, fallback?: { index: SceneIndex; hash: string }) {
    let index: SceneIndex, indexHash: string;
    try {
      const raw = fallback ? json(fallback.index) : await this.text('scenes/index.json');
      index = indexSchema.parse(JSON.parse(raw));
      indexHash = fallback?.hash ?? hash(raw);
      unique(
        index.scenes.map((s) => s.id),
        'Scene ID',
      );
      unique(
        index.scenes.map((s) => s.directory),
        'Scene 目录',
      );
    } catch (error) {
      const failure =
        error instanceof SyntaxError ? 'Scene 根清单不是有效 JSON，请修复后重新读取' : message(error);
      if (!this.entries.size && !fallback) {
        try {
          const saved = JSON.parse(
            (await readText(this.privateDirectory, 'scene-directory-snapshot.json', 16 * 1024 * 1024)) ??
              '{}',
          );
          if (saved.root === this.file && typeof saved.hash === 'string')
            await this.scan(undefined, { index: indexSchema.parse(saved.index), hash: saved.hash });
        } catch {
          /* A missing/corrupt derived snapshot cannot replace source health. */
        }
      }
      this.error = failure;
      ++this.revision;
      throw new Error(failure);
    }
    const entries = new Map<string, Entry>();
    for (let start = 0; start < index.scenes.length; start += 16) {
      const batch = await Promise.all(
        index.scenes.slice(start, start + 16).map(async (mapping): Promise<[string, Entry]> => {
          const base = `scenes/${mapping.directory}`;
          if (!this.loadedCaches.has(mapping.directory)) {
            this.loadedCaches.add(mapping.directory);
            try {
              const cached = JSON.parse(
                (await readText(
                  this.privateDirectory,
                  `scene-cache/${mapping.directory}.json`,
                  64 * 1024 * 1024,
                )) ?? '{}',
              );
              if (
                cached.version === 4 &&
                cached.root === this.file &&
                Array.isArray(cached.entries) &&
                cached.checksum === hash(json(cached.entries)) &&
                cached.entries.every(
                  (pair: unknown) =>
                    Array.isArray(pair) &&
                    pair.length === 2 &&
                    typeof pair[0] === 'string' &&
                    object(pair[1]) &&
                    typeof pair[1].signature === 'string' &&
                    typeof pair[1].hash === 'string' &&
                    object(pair[1].value),
                )
              )
                for (const [path, data] of cached.entries)
                  if (typeof path === 'string' && path.startsWith(base + '/')) this.cache.set(path, data);
            } catch {
              /* Disposable cache; source validation rebuilds it. */
            }
          }
          const previous = this.entries.get(mapping.id);
          if (
            changed &&
            !changed.has(mapping.id) &&
            previous &&
            previous.summary.directory === join(this.directory, base)
          )
            return [
              mapping.id,
              {
                ...previous,
                summary: {
                  ...previous.summary,
                  health: previous.sourceErrors?.length ? 'error' : 'valid',
                  errors: [...(previous.sourceErrors ?? [])],
                },
                actions: previous.actions.map((a) => ({ ...a, blocked: undefined })),
              },
            ];
          const entry: Entry = {
            summary: {
              id: mapping.id,
              name: mapping.id,
              directory: join(this.directory, base),
              file: join(this.directory, base, 'scene.json'),
              hash: '',
              httpRuleCount: 0,
              wsRuleCount: 0,
              actionCount: 0,
              targetCount: 0,
              enabledHttpRuleCount: 0,
              enabledWsRuleCount: 0,
              health: 'valid',
              errors: [],
            },
            http: [],
            ws: [],
            actions: [],
            targets: {},
            dependencies: new Map(),
          };
          try {
            const meta = await this.metadata(`${base}/scene.json`, (v) => manifestSchema.parse(v));
            const manifest = (entry.manifest = meta.value as SceneManifest);
            if (manifest.id !== mapping.id) throw new Error('Scene ID 与根清单不一致');
            entry.summary.name = manifest.name;
            entry.summary.hash = meta.hash;
            for (const kind of ['http', 'ws', 'actions'] as const) {
              unique(
                manifest[kind].map((r) => r.id),
                `${kind} ID`,
              );
              unique(
                manifest[kind].map((r) => r.file),
                `${kind} 文件`,
              );
            }
            entry.summary.httpRuleCount = manifest.http.length;
            entry.summary.wsRuleCount = manifest.ws.length;
            entry.summary.actionCount = manifest.actions.length;
            entry.targets = (
              await this.metadata(
                `${base}/targets.json`,
                (v) =>
                  validateSceneActions({
                    version: 1,
                    activeSceneId: null,
                    scenes: [{ id: mapping.id, name: manifest.name, httpRules: [], wsRules: [], targets: v }],
                  }).scenes[0].targets,
              )
            ).value;
            entry.summary.targetCount = Object.keys(entry.targets ?? {}).length;
            for (const kind of ['http', 'ws', 'actions'] as const)
              for (const resource of manifest[kind]) {
                const path = `${base}/${kind}/${resource.file}`;
                try {
                  const data = await this.metadata(path, (value) => {
                    if (kind === 'actions') {
                      const action = sceneActionSchema.parse(value);
                      const { steps: _steps, ...summary } = action;
                      return {
                        ...summary,
                        inputs: Object.fromEntries(
                          Object.entries(action.inputs ?? {}).map(([k, spec]) => [
                            k,
                            {
                              ...spec,
                              ...(spec.secret && spec.default !== undefined ? { default: '[REDACTED]' } : {}),
                            },
                          ]),
                        ),
                        stepCount: action.steps.length,
                        dependencies: action.steps.flatMap((step) =>
                          step.type === 'call'
                            ? [{ sceneId: step.sceneId ?? mapping.id, actionId: step.actionId }]
                            : [],
                        ),
                      };
                    }
                    const rule = inlineForValidation(value, kind);
                    const overview = structuredClone(rule);
                    for (const slot of bodySlots(overview, kind))
                      if (slot.owner[slot.field] !== undefined) slot.owner[slot.field] = '';
                    return {
                      id: rule.id,
                      name: rule.name,
                      enabled: rule.enabled,
                      priority: rule.priority,
                      overview,
                      bodyFiles: bodySlots(value, kind).flatMap((slot) =>
                        slot.owner[slot.ref] !== undefined ? [bodyPath(slot.owner[slot.ref])] : [],
                      ),
                    };
                  });
                  if (kind !== 'actions')
                    for (const body of data.value.bodyFiles ?? []) {
                      const info = await lstat(await safePath(this.directory, `${base}/${body}`)).catch(
                        (error) => {
                          if (missing(error)) throw new Error(`正文文件缺失：${base}/${body}`);
                          throw error;
                        },
                      );
                      if (!info.isFile() || info.size > 16 * 1024 * 1024)
                        throw new Error(`正文文件无效：${base}/${body}`);
                      const failure = this.bodyErrors.get(`${base}/${body}`);
                      if (
                        failure?.signature ===
                        `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
                      )
                        throw new Error(failure.error);
                      this.bodyErrors.delete(`${base}/${body}`);
                    }
                  if (data.value.id !== resource.id) throw new Error('资源 ID 与清单不一致');
                  const summary = { ...data.value, file: join(this.directory, path), hash: data.hash };
                  delete summary.bodyFiles;
                  if (kind === 'actions') {
                    entry.dependencies.set(resource.id, summary.dependencies);
                    delete summary.dependencies;
                    entry.actions.push(summary);
                  } else entry[kind].push(summary);
                } catch (error) {
                  entry.summary.errors.push(message(error));
                }
              }
            // Validate constraints shared across rules without loading external body contents.
            validateRuleDocument({ version: 1, rules: entry.http.map((rule) => rule.overview) });
            validateWsRuleDocument({ version: 1, rules: entry.ws.map((rule) => rule.overview) }, false);
            entry.summary.enabledHttpRuleCount = entry.http.filter((r) => r.enabled).length;
            entry.summary.enabledWsRuleCount = entry.ws.filter((r) => r.enabled).length;
          } catch (error) {
            entry.summary.errors.push(message(error));
          }
          entry.sourceErrors = [...entry.summary.errors];
          if (entry.summary.errors.length) entry.summary.health = 'error';
          return [mapping.id, entry];
        }),
      );
      for (const [id, entry] of batch) entries.set(id, entry);
    }
    // IDs come from manifests as well as parsed resources, so a corrupt rule cannot hide a conflict.
    for (const kind of ['http', 'ws'] as const) {
      const owners = new Map<string, Entry[]>();
      for (const entry of entries.values())
        for (const rule of entry.manifest?.[kind] ?? [])
          owners.set(rule.id, [...(owners.get(rule.id) ?? []), entry]);
      for (const [id, group] of owners)
        if (group.length > 1)
          for (const entry of group) {
            entry.summary.health = 'error';
            entry.summary.errors.push(`${kind} 规则 ID 全局重复：${id}`);
          }
    }
    this.refreshBlocked(entries);
    const indexChanged = this.indexHash !== indexHash;
    this.index = index;
    this.indexHash = indexHash;
    this.entries = entries;
    this.names.clear();
    for (const [sceneId, entry] of entries)
      for (const rule of [...entry.http, ...entry.ws])
        this.names.set(rule.id, { name: rule.name, sceneId, sceneName: entry.summary.name });
    this.error = undefined;
    ++this.revision;
    if (indexChanged && !fallback)
      await this.privateWrite('scene-directory-snapshot.json', {
        root: this.file,
        index,
        hash: indexHash,
      }).catch(() => undefined);
    const dirty = [...this.dirtyCaches];
    const shards = new Map(dirty.map((directory) => [directory, [] as Array<[string, Cached]>]));
    for (const pair of this.cache) shards.get(pair[0].split('/')[1])?.push(pair);
    await Promise.all(
      dirty.map(async (directory) => {
        try {
          await this.privateWrite(`scene-cache/${directory}.json`, {
            version: 4,
            root: this.file,
            entries: shards.get(directory),
            checksum: hash(json(shards.get(directory))),
          });
          this.dirtyCaches.delete(directory);
        } catch {
          /* Cache persistence never invalidates source data. */
        }
      }),
    );
    return this.listScenes();
  }
  private refreshBlocked(entries = this.entries) {
    const checked = new Map<string, string | undefined>();
    const blocked = (ref: ActionReference, visiting = new Set<string>()): string | undefined => {
      const id = key(ref);
      if (visiting.has(id)) return '子操作存在循环引用';
      if (visiting.size >= 16) return '子操作嵌套最多 16 层';
      if (checked.has(id)) return checked.get(id);
      const owner = entries.get(ref.sceneId);
      if (!owner || owner.summary.health === 'error' || !owner.dependencies.has(ref.actionId))
        return `依赖不可用：${ref.sceneId}/${ref.actionId}`;
      visiting.add(id);
      let error: string | undefined;
      for (const child of owner.dependencies.get(ref.actionId)!) {
        error = blocked(child, visiting);
        if (error) break;
      }
      visiting.delete(id);
      checked.set(id, error);
      return error;
    };
    for (const [sceneId, entry] of entries)
      for (const action of entry.actions) action.blocked = blocked({ sceneId, actionId: action.id });
  }
  listScenes(query: { offset?: number; limit?: number; search?: string } = {}): ScenePage {
    const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50))),
      offset = Math.max(0, Math.trunc(query.offset ?? 0)),
      search = (query.search ?? '').slice(0, 1000);
    const filtered = [...this.entries.values()].filter((entry) =>
      [
        entry.summary.id,
        entry.summary.name,
        ...entry.http.map((r) => r.name),
        ...entry.ws.map((r) => r.name),
        ...entry.actions.map((a) => a.name),
      ]
        .join('\n')
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
    return {
      version: 2,
      revision: this.revision,
      root: this.file,
      total: filtered.length,
      offset,
      limit,
      search,
      scenes: filtered.slice(offset, offset + limit).map((e) => structuredClone(e.summary)),
      ...(this.error ? { error: this.error } : {}),
      ...(this.activationWarning ? { warning: this.activationWarning } : {}),
      activeSceneId: this.activeSceneId,
      activeScene: this.activeSceneId
        ? {
            id: this.activeSceneId,
            name: this.entries.get(this.activeSceneId)?.summary.name ?? this.activeSceneId,
          }
        : undefined,
    };
  }
  private entry(sceneId: string, requireHealthy = true) {
    if (this.error && requireHealthy) throw new Error(this.error);
    const entry = this.entries.get(sceneId);
    if (!entry) throw new Error(`场景不存在：${sceneId}`);
    if (requireHealthy && entry.summary.health === 'error') throw new Error(entry.summary.errors.join('；'));
    return entry;
  }
  getScene(sceneId: string): SceneDetail {
    const entry = this.entry(sceneId, false);
    return structuredClone({
      id: sceneId,
      name: entry.summary.name,
      file: entry.summary.file,
      directory: entry.summary.directory,
      hash: entry.summary.hash,
      version: this.revision,
      http: entry.http,
      ws: entry.ws,
      actions: entry.actions,
      targets: entry.targets,
      health: entry.summary.health,
      errors: entry.summary.errors,
    });
  }
  /** Light history attribution, independent of loaded rules and bodies. */
  ruleNames(ids: string[]) {
    return Object.fromEntries(ids.flatMap((id) => (this.names.has(id) ? [[id, this.names.get(id)!]] : [])));
  }

  private path(address: ResourceAddress): string {
    const entry = this.entry(address.sceneId);
    const base = relative(this.directory, entry.summary.directory);
    if (address.kind === 'scene') return `${base}/scene.json`;
    if (address.kind === 'targets') return `${base}/targets.json`;
    const mapping = entry.manifest![address.kind].find((r) => r.id === address.id);
    if (!mapping) throw new Error(`资源不存在：${address.sceneId}/${address.id}`);
    return `${base}/${address.kind}/${mapping.file}`;
  }
  private async resource<T>(
    address: ResourceAddress,
    bodies: boolean,
    checks = new Map<string, string | null>(),
  ): Promise<Resource<T>> {
    const path = this.path(address),
      raw = await this.text(path, checks);
    let value = JSON.parse(raw);
    const cached = this.cache.get(path);
    if (cached && hash(raw) !== cached.hash) throw new SceneConflict(path);
    if (address.kind === 'http' || address.kind === 'ws') {
      inlineForValidation(value, address.kind);
      for (const slot of bodySlots(value, address.kind))
        if (slot.owner[slot.ref] !== undefined) {
          const ref = bodyPath(slot.owner[slot.ref]);
          if (bodies) {
            const base = relative(this.directory, this.entry(address.sceneId).summary.directory);
            try {
              slot.owner[slot.field] = await this.text(`${base}/${ref}`, checks);
            } catch (error) {
              const entry = this.entry(address.sceneId, false);
              const failure = `${base}/${ref}：${message(error)}`;
              const info = await lstat(await safePath(this.directory, `${base}/${ref}`)).catch(
                () => undefined,
              );
              if (info)
                this.bodyErrors.set(`${base}/${ref}`, {
                  signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
                  error: failure,
                });
              entry.summary.health = 'error';
              if (!entry.summary.errors.includes(failure)) entry.summary.errors.push(failure);
              entry.sourceErrors = [...entry.summary.errors];
              this.refreshBlocked();
              ++this.revision;
              throw error;
            }
            delete slot.owner[slot.ref];
          }
        }
      if (bodies)
        value =
          address.kind === 'http'
            ? validateRuleDocument({ version: 1, rules: [value] }).rules[0]
            : validateWsRuleDocument({ version: 1, rules: [value] }, false).rules[0];
    } else if (address.kind === 'actions') value = sceneActionSchema.parse(value);
    return {
      address,
      value,
      file: join(this.directory, path),
      hash: hash(json([...checks])),
      files: Object.fromEntries(checks) as Record<string, string>,
      version: this.revision,
    };
  }
  getRule(sceneId: string, kind: 'http' | 'ws', id: string) {
    return this.resource<Rule | WsRule>({ sceneId, kind, id }, true);
  }
  getAction(sceneId: string, id: string) {
    return this.resource<SceneAction>({ sceneId, kind: 'actions', id }, false);
  }
  prepareSnapshot(
    references: ActionReference[] = [],
    mockSceneId: string | null = null,
    resolveMock?: (actions: SceneDocument) => string | null,
  ): Promise<SceneDocument> {
    return this.files.locked(() => this.collectSnapshot(references, mockSceneId, resolveMock));
  }
  private async collectSnapshot(
    references: ActionReference[],
    mockSceneId: string | null,
    resolveMock?: (actions: SceneDocument) => string | null,
    checks = new Map<string, string | null>(),
  ): Promise<SceneDocument> {
    checks.set('scenes/index.json', this.indexHash);
    const scenes = new Map<string, Scene>();
    const owner = async (sceneId: string, withTargets = true) => {
      const existing = scenes.get(sceneId);
      if (existing) return existing;
      const entry = this.entry(sceneId),
        base = relative(this.directory, entry.summary.directory);
      checks.set(`${base}/scene.json`, entry.summary.hash);
      let targets = {};
      if (withTargets) {
        const targetPath = `${base}/targets.json`,
          targetRaw = await this.text(targetPath, checks);
        if (this.cache.get(targetPath)?.hash !== hash(targetRaw)) throw new SceneConflict(targetPath);
        targets = JSON.parse(targetRaw);
      }
      const scene: Scene = {
        id: sceneId,
        name: entry.summary.name,
        httpRules: [],
        wsRules: [],
        targets,
        actions: [],
      };
      scenes.set(sceneId, scene);
      return scene;
    };
    const visited = new Set<string>();
    const collect = async (ref: ActionReference, depth: number) => {
      if (depth > 16) throw new Error('子操作嵌套最多 16 层');
      const id = key(ref);
      if (visited.has(id)) return;
      if (visited.size >= 1000) throw new Error('单次快照最多 1000 个操作资源');
      visited.add(id);
      const scene = await owner(ref.sceneId),
        action = (
          await this.resource<SceneAction>(
            { sceneId: ref.sceneId, kind: 'actions', id: ref.actionId },
            false,
            checks,
          )
        ).value;
      scene.actions!.push(action);
      for (const step of action.steps)
        if (step.type === 'call')
          await collect({ sceneId: step.sceneId ?? ref.sceneId, actionId: step.actionId }, depth + 1);
    };
    for (const ref of references) await collect(ref, 1);
    if (resolveMock)
      mockSceneId = resolveMock({ version: 1, activeSceneId: null, scenes: [...scenes.values()] });
    if (mockSceneId !== null) {
      const scene = await owner(mockSceneId, false),
        entry = this.entry(mockSceneId);
      for (const rule of entry.manifest!.http)
        scene.httpRules.push(
          (await this.resource<Rule>({ sceneId: mockSceneId, kind: 'http', id: rule.id }, true, checks))
            .value,
        );
      for (const rule of entry.manifest!.ws)
        scene.wsRules.push(
          (await this.resource<WsRule>({ sceneId: mockSceneId, kind: 'ws', id: rule.id }, true, checks))
            .value,
        );
    }
    for (const scene of scenes.values()) {
      validateRuleDocument({ version: 1, rules: scene.httpRules });
      validateWsRuleDocument({ version: 1, rules: scene.wsRules }, false);
    }
    const doc = validateSceneActions({
      version: 1,
      activeSceneId: mockSceneId,
      scenes: [...scenes.values()],
    });
    for (const [path, expected] of checks)
      if (hash(await this.text(path)) !== expected) throw new SceneConflict(path);
    return freeze(doc);
  }
  async activate(id: string | null) {
    if (id !== null) this.entry(id);
    await this.privateWrite('scene-active.json', { id });
    this.activeSceneId = id;
    this.activationWarning = undefined;
  }
  private externalize(value: any, kind: 'http' | 'ws', base: string, changes: FileChange[]) {
    const stored = structuredClone(value);
    inlineForValidation(stored, kind);
    for (const slot of bodySlots(stored, kind))
      if (typeof slot.owner[slot.field] === 'string' && slot.owner[slot.field].length) {
        const ref = `bodies/${randomUUID()}.txt`;
        changes.push({ path: `${base}/${ref}`, expected: null, text: slot.owner[slot.field] });
        delete slot.owner[slot.field];
        slot.owner[slot.ref] = ref;
      }
    return stored;
  }
  private async ruleManifests(checks: Map<string, string | null>) {
    const manifests: Array<{ sceneId: string; manifest: SceneManifest }> = [];
    for (const mapping of this.index.scenes) {
      const path = `scenes/${mapping.directory}/scene.json`;
      try {
        const manifest = manifestSchema.parse(JSON.parse(await this.text(path, checks)));
        manifests.push({ sceneId: mapping.id, manifest });
      } catch (error) {
        if (error instanceof SceneConflict) throw error;
        // Unreadable Scenes are quarantined. If repaired, reload checks their IDs against all owners.
      }
    }
    return manifests;
  }
  async saveResource(address: ResourceAddress, value: unknown, expectedHash: string | null) {
    await this.files.locked(async () => {
      const entry = this.entry(address.sceneId),
        base = relative(this.directory, entry.summary.directory),
        manifest = structuredClone(entry.manifest!);
      const changes: FileChange[] = [],
        checks = new Map<string, string | null>([
          ['scenes/index.json', this.indexHash],
          [`${base}/scene.json`, entry.summary.hash],
        ]);
      let path: string, current: Resource<unknown> | undefined;
      if (expectedHash !== null) {
        current = await this.resource(address, address.kind === 'http' || address.kind === 'ws');
        if (current.hash !== expectedHash) throw new SceneConflict(current.file);
        for (const [path, value] of Object.entries(current.files)) checks.set(path, value);
        path = relative(this.directory, current.file);
      } else {
        if (!['http', 'ws', 'actions'].includes(address.kind) || !address.id)
          throw new Error('新增资源必须指定类型和 ID');
        const kind = address.kind as 'http' | 'ws' | 'actions';
        if (kind !== 'actions') {
          for (const other of await this.ruleManifests(checks))
            if (other.sceneId !== address.sceneId && other.manifest[kind].some((r) => r.id === address.id))
              throw new Error(`${kind} 规则 ID 全局重复：${address.id}`);
        }
        if (manifest[kind].some((r) => r.id === address.id)) throw new SceneConflict(entry.summary.file);
        const file = `${randomUUID()}.json`;
        path = `${base}/${kind}/${file}`;
        manifest[kind].push({ id: address.id, file });
      }
      let stored = value;
      if (address.kind === 'http' || address.kind === 'ws') {
        if ((value as Rule)?.id !== address.id) throw new Error('资源 ID 不能通过保存修改');
        stored = this.externalize(value, address.kind, base, changes);
        const resolved = structuredClone(stored);
        for (const slot of bodySlots(resolved, address.kind))
          if (slot.owner[slot.ref] !== undefined) {
            const body = `${base}/${bodyPath(slot.owner[slot.ref])}`;
            slot.owner[slot.field] =
              changes.find((change) => change.path === body)?.text ?? (await this.text(body, checks));
            delete slot.owner[slot.ref];
          }
        const validated = inlineForValidation(resolved, address.kind);
        const group = entry[address.kind]
          .filter((rule) => rule.id !== address.id)
          .map((rule) => rule.overview);
        group.push(validated);
        if (address.kind === 'http') validateRuleDocument({ version: 1, rules: group });
        else validateWsRuleDocument({ version: 1, rules: group }, false);
      } else if (address.kind === 'actions') {
        stored = sceneActionSchema.parse(value);
        if ((stored as SceneAction).id !== address.id) throw new Error('操作 ID 不一致');
      } else if (address.kind === 'scene') {
        stored = manifestSchema.parse(value);
        if ((stored as SceneManifest).id !== address.sceneId) throw new Error('Scene ID 不一致');
      } else
        validateSceneActions({
          version: 1,
          activeSceneId: null,
          scenes: [
            {
              id: address.sceneId,
              name: entry.summary.name,
              targets: value as Scene['targets'],
              httpRules: [],
              wsRules: [],
            },
          ],
        });
      changes.push({ path, expected: current ? current.files[path] : null, text: json(stored) });
      if (expectedHash === null)
        changes.push({ path: `${base}/scene.json`, expected: entry.summary.hash, text: json(manifest) });
      await this.files.commit(changes, checks);
      await this.scan(new Set([address.sceneId]));
    });
    return this.resource(address, address.kind === 'http' || address.kind === 'ws');
  }
  async renameScene(id: string, name: string, expectedHash: string) {
    const address: ResourceAddress = { sceneId: id, kind: 'scene' },
      resource = await this.resource<SceneManifest>(address, false);
    if (resource.files[relative(this.directory, resource.file)] !== expectedHash)
      throw new SceneConflict(resource.file);
    return this.saveResource(address, { ...resource.value, name }, resource.hash);
  }
  async reorderRules(
    sceneId: string,
    kind: 'http' | 'ws',
    firstId: string,
    secondId: string,
    first: Resource<Rule | WsRule>,
    second: Resource<Rule | WsRule>,
  ) {
    await this.files.locked(async () => {
      const entry = this.entry(sceneId),
        manifest = structuredClone(entry.manifest!);
      const a = manifest[kind].findIndex((r) => r.id === firstId),
        b = manifest[kind].findIndex((r) => r.id === secondId);
      if (a < 0 || b < 0) throw new Error('排序资源不存在');
      [manifest[kind][a], manifest[kind][b]] = [manifest[kind][b], manifest[kind][a]];
      const base = relative(this.directory, entry.summary.directory),
        changes: FileChange[] = [
          { path: `${base}/scene.json`, expected: entry.summary.hash, text: json(manifest) },
        ];
      const checks = new Map([
        ['scenes/index.json', this.indexHash],
        ...Object.entries(first.files),
        ...Object.entries(second.files),
      ]);
      // Stable array order breaks equal priorities. Swapping distinct priorities preserves UI/runtime agreement.
      if (first.value.priority !== second.value.priority)
        for (const [resource, priority] of [
          [first, second.value.priority],
          [second, first.value.priority],
        ] as const) {
          const path = relative(this.directory, resource.file),
            stored = JSON.parse(await this.text(path));
          stored.priority = priority;
          changes.push({ path, expected: resource.files[path], text: json(stored) });
        }
      await this.files.commit(changes, checks);
      await this.scan(new Set([sceneId]));
    });
  }
  async deleteResource(address: ResourceAddress, expectedHash: string) {
    if (!['http', 'ws', 'actions'].includes(address.kind)) throw new Error('不能删除固定资源');
    await this.files.locked(async () => {
      const resource = await this.resource(address, true);
      if (resource.hash !== expectedHash) throw new SceneConflict(resource.file);
      const entry = this.entry(address.sceneId),
        manifest = structuredClone(entry.manifest!),
        kind = address.kind as 'http' | 'ws' | 'actions';
      manifest[kind] = manifest[kind].filter((r) => r.id !== address.id);
      const base = relative(this.directory, entry.summary.directory),
        path = relative(this.directory, resource.file);
      await this.files.commit(
        [
          { path, expected: resource.files[path], text: null },
          { path: `${base}/scene.json`, expected: entry.summary.hash, text: json(manifest) },
        ],
        new Map([['scenes/index.json', this.indexHash], ...Object.entries(resource.files)]),
      );
      await this.scan(new Set([address.sceneId]));
    });
  }
  async deleteScene(id: string, expectedHash: string) {
    await this.files.locked(async () => {
      const entry = this.entry(id, false);
      if (entry.summary.hash !== expectedHash) throw new SceneConflict(entry.summary.file);
      await this.files.commit(
        [
          {
            path: 'scenes/index.json',
            expected: this.indexHash,
            text: json({ version: 2, scenes: this.index.scenes.filter((s) => s.id !== id) }),
          },
        ],
        new Map([[relative(this.directory, entry.summary.file), expectedHash]]),
      );
    });
    // Unreferenced directories are deliberately retained: external edits and shared body references survive.
    if (this.activeSceneId === id) await this.activate(null);
    await this.reload();
  }
  async importPackage(input: unknown, remap = true) {
    const pkg = validateScenePackage(input),
      scenes = remap ? cloneScenes(pkg.scenes) : pkg.scenes;
    await this.files.locked(async () => {
      const next = structuredClone(this.index),
        changes: FileChange[] = [],
        checks = new Map<string, string | null>();
      const incoming = {
        http: new Set(scenes.flatMap((scene) => scene.httpRules.map((rule) => rule.id))),
        ws: new Set(scenes.flatMap((scene) => scene.wsRules.map((rule) => rule.id))),
      };
      for (const { manifest } of await this.ruleManifests(checks))
        for (const kind of ['http', 'ws'] as const)
          if (manifest[kind].some((rule) => incoming[kind].has(rule.id)))
            throw new Error(`${kind} 规则 ID 全局重复`);
      for (const scene of scenes) {
        if (next.scenes.some((s) => s.id === scene.id)) throw new Error('Scene ID 重复');
        const directory = randomUUID(),
          base = `scenes/${directory}`;
        const manifest: SceneManifest = { id: scene.id, name: scene.name, http: [], ws: [], actions: [] };
        next.scenes.push({ id: scene.id, directory });
        for (const [kind, values] of [
          ['http', scene.httpRules],
          ['ws', scene.wsRules],
          ['actions', scene.actions ?? []],
        ] as const)
          for (const value of values) {
            const file = `${randomUUID()}.json`;
            manifest[kind].push({ id: value.id, file });
            changes.push({
              path: `${base}/${kind}/${file}`,
              expected: null,
              text: json(kind === 'actions' ? value : this.externalize(value, kind, base, changes)),
            });
          }
        changes.push(
          { path: `${base}/scene.json`, expected: null, text: json(manifest) },
          { path: `${base}/targets.json`, expected: null, text: json(scene.targets ?? {}) },
        );
      }
      changes.push({ path: 'scenes/index.json', expected: this.indexHash, text: json(next) });
      await this.files.commit(changes, checks);
    });
    await this.reload();
    return scenes.map((scene) => scene.id);
  }
  async exportPackage(ids = this.index.scenes.map((s) => s.id)): Promise<ScenePackage> {
    return this.files.locked(async () => {
      const requested = new Set(ids),
        scenes: Scene[] = [],
        checks = new Map<string, string | null>();
      for (const id of requested) {
        const entry = this.entry(id),
          refs = entry.actions.map((a) => ({ sceneId: id, actionId: a.id }));
        const doc = await this.collectSnapshot(refs, id, undefined, checks);
        const exported = structuredClone(doc.scenes.find((s) => s.id === id)!);
        const targetPath = `${relative(this.directory, entry.summary.directory)}/targets.json`;
        exported.targets = JSON.parse(await this.text(targetPath, checks));
        if (checks.get(targetPath) !== this.cache.get(targetPath)?.hash) throw new SceneConflict(targetPath);
        scenes.push(exported);
        for (const scene of doc.scenes) if (scene.id !== id) requested.add(scene.id);
      }
      for (const [path, expected] of checks)
        if (hash(await this.text(path)) !== expected) throw new SceneConflict(path);
      return validateScenePackage({ version: 2, scenes });
    });
  }
}
export function validateScenePackage(value: unknown): ScenePackage {
  if (
    !object(value) ||
    value.version !== 2 ||
    Object.keys(value).some((k) => !['version', 'scenes'].includes(k)) ||
    !Array.isArray(value.scenes)
  )
    throw new Error('导入需要 version:2 自包含 Scene 交换包');
  // Runtime document is a compiler model, not a persistence format. No library-wide count limit.
  const scenes = value.scenes as Scene[];
  unique(
    scenes.map((s) => s.id),
    'Scene ID',
  );
  const rules = { http: new Set<string>(), ws: new Set<string>() };
  for (const scene of scenes) {
    validateSceneDocument({ version: 1, activeSceneId: null, scenes: [{ ...scene, actions: [] }] });
    for (const [kind, values] of [
      ['http', scene.httpRules],
      ['ws', scene.wsRules],
    ] as const)
      for (const rule of values) {
        if (rules[kind].has(rule.id)) throw new Error('规则 ID 全局重复');
        rules[kind].add(rule.id);
      }
  }
  return { version: 2, scenes: validateSceneActions({ version: 1, activeSceneId: null, scenes }).scenes };
}

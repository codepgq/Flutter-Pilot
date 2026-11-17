import { randomUUID } from 'node:crypto';
import { validateRuleDocument, type Rule } from './model';
import { validateWsRuleDocument, type WsRule } from './ws/model';
import type { Scene, SceneDocument, SceneRuntime } from './scene-model';
import { cloneScenes, SceneStore } from './scenes';
import type { SceneDetail, ResourceAddress } from './scene-storage-model';
import { RuntimeTargetError } from './runtime/targets';

type Domain = 'http' | 'ws';
export interface SceneHost {
  snapshot(): {
    key: string;
    /** Fixed runtime identity and generation, excluding capture and Mock state. */
    targetKey?: string;
    mode: 'vm' | 'proxy';
    connected: boolean;
    /** The proxy may still serve rules, but its control connection is unavailable. */
    proxyRulesUnreachable?: boolean;
    httpApplied: boolean;
    wsApplied: boolean;
    httpError?: string;
    wsError?: string;
  };
  disable(domain: Domain): Promise<void>;
  project(http: Rule[], ws: WsRule[]): Promise<void>;
  enable(domain: Domain): Promise<void>;
  capture(domain: Domain, enabled: boolean): Promise<void>;
  stopUnreachableProxy?(): Promise<void>;
  changed(): void;
}

/** Owns scene selection, persistence and serialized replacement of runtime rules. */
export class SceneController {
  private activeScene?: Scene;
  detail?: SceneDetail;
  stale?: string;
  get activeSceneId() {
    return this.store.activeSceneId;
  }
  selectedSceneId?: string;
  private temporary: WsRule[] = [];
  private revision = 0;
  private appliedKey?: string;
  private errors: Partial<Record<Domain, string>> = {};
  private paused = new Set<Domain>();
  private pendingCaptures = new Map<Domain, boolean>();
  private operations: Promise<unknown> = Promise.resolve();
  private operationTargetKey?: string;
  private pendingCaptureTargetKey?: string;
  private loaded = false;
  private applying = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private run?: {
    id: string;
    targetKey?: string;
    scene: Scene;
    paused: Set<Domain>;
    pendingCaptures: Map<Domain, boolean>;
    temporary: WsRule[];
    restoring?: boolean;
  };
  constructor(
    readonly store: SceneStore,
    private readonly host: SceneHost,
  ) {}
  get active() {
    if (this.run && !this.run.restoring) return this.run.scene;
    return this.activeScene;
  }
  summary(query: { offset?: number; limit?: number; search?: string } = {}) {
    return {
      ...this.store.listScenes(query),
      ...(this.stale && this.activeScene
        ? {
            activeSceneId: this.activeScene.id,
            activeScene: { id: this.activeScene.id, name: this.activeScene.name },
          }
        : {}),
      runtimeRunId: this.run?.id,
      runtime: this.runtime,
      stale: this.stale,
    };
  }
  get selected() {
    return this.detail;
  }
  wsRules(scene: Scene | undefined = this.active) {
    return [...(scene?.wsRules ?? []), ...(scene?.id === this.active?.id ? this.temporary : [])];
  }
  select(id: string) {
    this.detail = this.store.getScene(id);
    this.selectedSceneId = id;
    this.host.changed();
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const targetKey = this.host.snapshot().targetKey;
    const next = this.operations.then(async () => {
      this.operationTargetKey = targetKey;
      try {
        this.assertTarget();
        const result = await operation();
        this.assertTarget();
        return result;
      } finally {
        this.operationTargetKey = undefined;
      }
    });
    this.operations = next.catch(() => undefined);
    return next;
  }
  private assertTarget(expected = this.operationTargetKey) {
    if (expected === undefined || expected === this.host.snapshot().targetKey) return;
    this.appliedKey = undefined;
    this.pendingCaptures.clear();
    this.pendingCaptureTargetKey = undefined;
    this.temporary = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    throw new RuntimeTargetError(
      'TARGET_STALE',
      '运行目标代次已失效，操作已停止；请重新发现目标，不会自动重放。',
    );
  }
  private async targetOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertTarget();
    try {
      const result = await operation();
      this.assertTarget();
      return result;
    } catch (error) {
      this.assertTarget();
      throw error;
    }
  }
  async initialize() {
    await this.store.load();
    if (!this.store.error && !this.store.listScenes().total) await this.create('默认场景');
    this.stale = this.store.error;
    this.loaded = true;
    const initial = this.activeSceneId ?? this.store.listScenes().scenes[0]?.id;
    if (initial) {
      try {
        this.select(initial);
      } catch {
        /* A stale active ID is reported below. */
      }
    }
    if (this.activeSceneId) {
      try {
        this.activeScene = (await this.store.prepareSnapshot([], this.activeSceneId)).scenes[0];
      } catch (error) {
        this.stale = (error as Error).message;
      }
    }
    await this.reconcile();
  }
  private ensureNoRun() {
    if (this.run) throw new Error(`测试运行 ${this.run.id} 正在使用场景，请等待结束或取消后再修改`);
  }
  /** Apply an in-memory test environment without persisting or changing activeSceneId. */
  beginRun(
    runId: string,
    sceneId?: string,
    httpOverrides: Rule[] = [],
    options: { deferWs?: boolean; snapshot?: SceneDocument } = {},
  ) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      if (!runId || runId.trim().length === 0 || runId.length > 128 || /[\x00-\x1f\x7f]/.test(runId))
        throw new Error('运行 ID 无效');
      if (!this.loaded) throw new Error('场景尚未初始化');
      const snapshot = this.host.snapshot();
      if (!snapshot.connected || snapshot.proxyRulesUnreachable)
        throw new Error('测试环境尚未连接，不能开始测试');
      const mockId = sceneId ?? this.activeSceneId;
      const snapshotDoc =
        options.snapshot ?? (await this.targetOperation(() => this.store.prepareSnapshot([], mockId)));
      const source = snapshotDoc.scenes.find((scene) => scene.id === mockId);
      if (sceneId !== undefined && !source) throw new Error('测试场景不存在');
      const scene: Scene = source
        ? structuredClone(source)
        : { id: `run-${randomUUID()}`, name: '测试临时场景', httpRules: [], wsRules: [] };
      // Each group retains descending priority and stable tie order. Dense ranks
      // ensure overrides outrank even a base rule using MAX_SAFE_INTEGER.
      const ordered = [httpOverrides, scene.httpRules].flatMap((rules) =>
        rules.slice().sort((a, b) => b.priority - a.priority),
      );
      scene.httpRules = validateRuleDocument({
        version: 1,
        rules: ordered.map((rule, index) => ({ ...rule, priority: ordered.length - index })),
      }).rules;
      this.run = {
        id: runId,
        targetKey: this.operationTargetKey,
        scene,
        paused: new Set(this.paused),
        pendingCaptures: new Map(this.pendingCaptures),
        temporary: structuredClone(this.temporary),
      };
      if (source?.id !== this.activeSceneId) this.temporary = [];
      this.paused.clear();
      // Login/setup may be responsible for creating the target socket. HTTP
      // fixtures are ready before setup; WS activation follows the ready hook.
      if (options.deferWs) this.paused.add('ws');
      this.pendingCaptures.clear();
      // Keep ownership on failure so endRun can remove partially applied rules.
      await this.apply(true);
      if (Object.keys(this.errors).length)
        throw new Error(`测试场景应用失败：${Object.values(this.errors).join('；')}`);
      if (!this.host.snapshot().connected) throw new Error('应用测试场景时连接已断开');
      this.host.changed();
    });
  }
  /** Resume this run's WS domain without detaching HTTP or resetting fixture state. */
  activateRunWs(runId: string) {
    return this.enqueue(async () => {
      if (!this.run || this.run.id !== runId || this.run.restoring)
        throw new Error('当前测试未持有可激活的 WS 场景');
      this.assertTarget(this.run.targetKey);
      const before = this.host.snapshot();
      if (!before.connected || before.proxyRulesUnreachable) throw new Error('测试 WS 环境尚未连接');
      if (this.appliedKey !== this.applicationKey(before) || this.errors.http)
        throw new Error('测试环境在 setup 期间发生变化，不能继续激活 WS');
      if (this.run.scene.httpRules.some((rule) => rule.enabled) && (!before.httpApplied || before.httpError))
        throw new Error('测试 HTTP 环境尚未实际接入，不能继续激活 WS');
      if (!this.paused.has('ws')) return;
      const needed = this.wsRules(this.run.scene).some((rule) => rule.enabled);
      if (needed && before.mode !== 'vm') throw new Error('代理模式不支持测试 WS Mock');
      try {
        if (needed) await this.targetOperation(() => this.host.enable('ws'));
        const after = this.host.snapshot();
        if (!after.connected || after.key !== before.key || after.proxyRulesUnreachable)
          throw new Error('激活测试 WS 时连接发生变化');
        this.paused.delete('ws');
        delete this.errors.ws;
        this.appliedKey = this.applicationKey(after);
        ++this.revision;
      } catch (error) {
        this.assertTarget();
        this.errors.ws = (error as Error).message;
        throw error;
      } finally {
        this.host.changed();
      }
    });
  }
  /** Restore the saved environment. Failed restoration can be retried by the owner. */
  endRun(runId: string) {
    return this.enqueue(async () => {
      if (!this.run) return;
      if (this.run.id !== runId) throw new Error('不能结束其他测试运行的场景');
      const run = this.run;
      this.assertTarget(run.targetKey);
      run.restoring = true;
      this.paused = new Set(run.paused);
      this.pendingCaptures = new Map(run.pendingCaptures);
      this.temporary = structuredClone(run.temporary);
      if (this.host.snapshot().proxyRulesUnreachable) {
        if (!this.host.stopUnreachableProxy)
          throw new Error('代理控制连接已断开，无法确认测试规则已移除；请停止代理后重试恢复');
        await this.targetOperation(() => this.host.stopUnreachableProxy!());
        if (this.host.snapshot().proxyRulesUnreachable)
          throw new Error('代理仍无法控制，无法确认测试规则已移除');
      }
      await this.apply(true);
      if (this.host.snapshot().proxyRulesUnreachable)
        throw new Error('恢复测试场景时代理控制连接已断开，测试规则移除结果未确认');
      if (Object.keys(this.errors).length)
        throw new Error(`测试场景恢复失败：${Object.values(this.errors).join('；')}`);
      this.run = undefined;
      this.host.changed();
    });
  }
  /** Drop only local ownership after its target expires; never restore onto the successor. */
  abandonInvalidatedRun(runId: string) {
    if (!this.run || this.run.id !== runId || this.run.targetKey === undefined) return false;
    if (this.run.targetKey === this.host.snapshot().targetKey) return false;
    this.run = undefined;
    this.temporary = [];
    this.paused.clear();
    this.pendingCaptures.clear();
    this.pendingCaptureTargetKey = undefined;
    this.appliedKey = undefined;
    this.errors = {};
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.host.changed();
    return true;
  }
  private ensureSafeChange() {
    if (this.host.snapshot().proxyRulesUnreachable)
      throw new Error('代理控制连接已断开，旧规则可能仍在生效。请等待重连或停止代理后再更改激活场景。');
  }
  private async confirmCommittedChange() {
    try {
      if (!this.host.snapshot().proxyRulesUnreachable) return;
      if (!this.host.stopUnreachableProxy)
        throw new Error('配置已保存，但代理控制连接已断开，旧规则可能仍在生效；请停止代理后重新读取');
      await this.targetOperation(() => this.host.stopUnreachableProxy!());
      if (this.host.snapshot().proxyRulesUnreachable)
        throw new Error('配置已保存，但无法确认代理已停止，旧规则可能仍在生效；请停止代理后重新读取');
    } catch (error) {
      this.stale = (error as Error).message;
      this.host.changed();
      throw error;
    }
  }
  reload() {
    return this.enqueue(() => this.reloadNow(true));
  }
  private async reloadNow(readDisk = false) {
    this.ensureNoRun();
    try {
      if (readDisk) await this.store.reload();
      if (this.selectedSceneId) {
        try {
          this.detail = this.store.getScene(this.selectedSceneId);
        } catch {
          this.detail = undefined;
          this.selectedSceneId = undefined;
        }
      }
      if (this.activeSceneId) {
        const next = (await this.store.prepareSnapshot([], this.activeSceneId)).scenes[0];
        if (JSON.stringify(next) !== JSON.stringify(this.activeScene)) this.ensureSafeChange();
        this.activeScene = next;
      } else if (this.activeScene) {
        this.ensureSafeChange();
        this.activeScene = undefined;
        this.temporary = [];
      }
      this.stale = undefined;
      await this.apply();
    } catch (error) {
      this.stale = (error as Error).message;
      throw error;
    } finally {
      this.host.changed();
    }
  }
  activate(id: string | null) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      this.ensureSafeChange();
      const next =
        id === null
          ? undefined
          : (await this.targetOperation(() => this.store.prepareSnapshot([], id))).scenes[0];
      await this.targetOperation(() => this.store.activate(id));
      await this.confirmCommittedChange();
      this.activeScene = next;
      this.stale = undefined;
      this.temporary = [];
      this.paused.clear();
      this.pendingCaptures.clear();
      await this.apply(true);
      this.host.changed();
    });
  }
  async create(name: string, source?: Scene) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      const scene = source
        ? cloneScenes([source])[0]
        : { id: randomUUID(), name, httpRules: [], wsRules: [] };
      scene.name = name;
      const ids = await this.store.importPackage({ version: 2, scenes: [scene] }, false);
      this.select(ids[0]);
    });
  }
  async rename(id: string, name: string, hash: string) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      await this.store.renameScene(id, name, hash);
      await this.reloadNow();
    });
  }
  async remove(id: string, hash: string) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      const wasActive = id === this.activeSceneId;
      if (wasActive) this.ensureSafeChange();
      await this.store.deleteScene(id, hash);
      if (wasActive) await this.confirmCommittedChange();
      if (wasActive) {
        this.activeScene = undefined;
        this.temporary = [];
        this.paused.clear();
        this.pendingCaptures.clear();
      }
      await this.reloadNow();
    });
  }
  async saveResource(address: ResourceAddress, value: unknown, hash: string | null) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      if (address.sceneId === this.activeSceneId) this.ensureSafeChange();
      await this.store.saveResource(address, value, hash);
      if (address.sceneId === this.activeSceneId) await this.confirmCommittedChange();
      await this.reloadNow();
    });
  }
  async deleteResource(address: ResourceAddress, hash: string) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      if (address.sceneId === this.activeSceneId) this.ensureSafeChange();
      await this.store.deleteResource(address, hash);
      if (address.sceneId === this.activeSceneId) await this.confirmCommittedChange();
      await this.reloadNow();
    });
  }
  async saveTemporary(rules: WsRule[], sceneId = this.activeSceneId) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      this.ensureSafeChange();
      if (!this.active || !sceneId || sceneId !== this.activeSceneId || sceneId !== this.active.id)
        throw new Error('临时 WS 规则只能保存到当前激活场景');
      const validated = validateWsRuleDocument({ version: 1, rules }).rules;
      if (validated.some((rule) => !rule.match.connectionId)) throw new Error('临时 WS 规则必须绑定当前连接');
      validateWsRuleDocument({ version: 1, rules: [...this.active.wsRules, ...validated] });
      this.temporary = validated;
      await this.apply();
      this.host.changed();
    });
  }
  expireTemporary(ids: string[]) {
    this.temporary = this.temporary.filter((rule) => ids.includes(rule.match.connectionId!));
    if (this.run)
      this.run.temporary = this.run.temporary.filter((rule) => ids.includes(rule.match.connectionId!));
  }
  dispose() {
    this.loaded = false;
    ++this.revision;
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }
  setCapture(domain: Domain, enabled: boolean) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      if (domain === 'http' && this.host.snapshot().proxyRulesUnreachable)
        throw new Error('代理控制连接已断开，旧规则可能仍在生效。请等待重连或停止代理后再调整采集。');
      this.pendingCaptures.set(domain, enabled);
      this.pendingCaptureTargetKey = this.operationTargetKey;
      let failure: unknown;
      try {
        if (!enabled) {
          try {
            await this.targetOperation(() => this.host.disable(domain));
          } catch (error) {
            this.assertTarget();
            failure = error;
          }
        }
        try {
          await this.applyCapture(domain, enabled);
        } catch (error) {
          this.assertTarget();
          failure ??= error;
        }
        await this.apply(true);
        if (failure) {
          this.errors[domain] = (failure as Error).message;
          this.scheduleLeaseRetry();
          throw failure;
        }
      } finally {
        this.host.changed();
      }
    });
  }
  reconcile() {
    return this.enqueue(async () => {
      if (
        this.pendingCaptureTargetKey !== undefined &&
        this.pendingCaptureTargetKey !== this.host.snapshot().targetKey
      ) {
        this.pendingCaptures.clear();
        this.pendingCaptureTargetKey = undefined;
      }
      const failures: Partial<Record<Domain, string>> = {};
      for (const [domain, enabled] of this.pendingCaptures) {
        try {
          await this.applyCapture(domain, enabled);
        } catch (error) {
          this.assertTarget();
          failures[domain] = (error as Error).message;
        }
      }
      await this.apply();
      if (Object.keys(failures).length) {
        Object.assign(this.errors, failures);
        this.scheduleLeaseRetry();
        this.host.changed();
      }
    });
  }
  private async applyCapture(domain: Domain, enabled: boolean) {
    await this.targetOperation(() => this.host.capture(domain, enabled));
    if (enabled) this.paused.delete(domain);
    else this.paused.add(domain);
    this.pendingCaptures.delete(domain);
    delete this.errors[domain];
  }
  private scheduleLeaseRetry() {
    if (!Object.values(this.errors).some((error) => /租约|等待.*秒/.test(error ?? ''))) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const targetKey = this.host.snapshot().targetKey;
    this.retryTimer = setTimeout(() => {
      if (targetKey !== this.host.snapshot().targetKey) return;
      this.appliedKey = undefined;
      void this.reconcile().catch(() => undefined);
    }, 16100);
    this.retryTimer.unref?.();
  }
  private applicationKey(snapshot: ReturnType<SceneHost['snapshot']>) {
    const scene = this.active;
    return JSON.stringify([
      snapshot.key,
      snapshot.targetKey,
      snapshot.connected,
      scene?.id,
      scene?.httpRules ?? [],
      scene ? this.wsRules(scene) : [],
      [...this.paused],
    ]);
  }
  private async apply(force = false) {
    if (!this.loaded) return;
    this.assertTarget();
    if (this.run) this.assertTarget(this.run.targetKey);
    const snapshot = this.host.snapshot();
    if (snapshot.proxyRulesUnreachable) return;
    const scene = this.active;
    const http = scene?.httpRules ?? [];
    const ws = scene ? this.wsRules(scene) : [];
    const key = this.applicationKey(snapshot);
    if (!force && key === this.appliedKey) return;
    this.appliedKey = key;
    const revision = ++this.revision;
    this.applying = true;
    try {
      this.errors = {};
      if (this.retryTimer) clearTimeout(this.retryTimer);
      for (const domain of ['http', 'ws'] as const) {
        try {
          await this.targetOperation(() => this.host.disable(domain));
        } catch (error) {
          this.assertTarget();
          this.errors[domain] = String((error as Error).message);
        }
      }
      try {
        await this.targetOperation(() => this.host.project(http, ws));
      } catch (error) {
        this.assertTarget();
        this.errors.http ??= (error as Error).message;
        this.errors.ws ??= (error as Error).message;
      }
      for (const domain of ['http', 'ws'] as const) {
        const needed = (domain === 'http' ? http : ws).some((rule) => rule.enabled);
        if (revision !== this.revision || key !== this.applicationKey(this.host.snapshot())) return;
        if (
          !needed ||
          !snapshot.connected ||
          this.errors[domain] ||
          this.paused.has(domain) ||
          (domain === 'ws' && snapshot.mode === 'proxy')
        )
          continue;
        try {
          await this.targetOperation(() => this.host.enable(domain));
        } catch (error) {
          this.assertTarget();
          this.errors[domain] = (error as Error).message;
        }
      }
      this.scheduleLeaseRetry();
    } finally {
      this.applying = false;
      this.host.changed();
    }
  }
  get runtime(): SceneRuntime {
    const state = this.host.snapshot();
    let sourceError = this.store.error;
    if (this.activeScene && !sourceError) {
      try {
        const detail = this.store.getScene(this.activeScene.id);
        if (detail.health === 'error') sourceError = detail.errors.join('；');
      } catch {
        sourceError = '当前运行场景已从磁盘配置移除，请重新读取';
      }
    }
    const stale = this.stale ?? sourceError;
    const status = (domain: Domain) => {
      const rules =
        domain === 'http' ? (this.active?.httpRules ?? []) : this.active ? this.wsRules(this.active) : [];
      if (state.proxyRulesUnreachable && this.active)
        return { status: 'error' as const, message: stale ?? '代理控制连接已断开，旧规则可能仍在生效' };
      if (this.errors[domain]) return { status: 'error' as const, message: this.errors[domain] };
      const error = domain === 'http' ? state.httpError : state.wsError;
      if (error) return { status: 'error' as const, message: error };
      if (
        this.active &&
        rules.some((rule) => rule.enabled) &&
        state.connected &&
        this.appliedKey !== this.applicationKey(state)
      )
        return { status: 'pending' as const, message: '等待同步场景' };
      if (!this.active || !rules.some((rule) => rule.enabled)) return { status: 'unneeded' as const };
      if (this.paused.has(domain)) return { status: 'paused' as const, message: '采集已关闭' };
      if (domain === 'ws' && state.mode === 'proxy')
        return { status: 'unsupported' as const, message: '代理模式不支持 WS Mock' };
      if (!state.connected) return { status: 'pending' as const, message: '待连接' };
      if (this.applying) return { status: 'pending' as const, message: '正在同步场景' };
      const applied = domain === 'http' ? state.httpApplied : state.wsApplied;
      return {
        status: applied ? ('applied' as const) : ('pending' as const),
        message: applied
          ? '以新请求/消息验证实际命中'
          : domain === 'http'
            ? '等待 Dio 实例接入'
            : '等待目标 WS 连接接入',
      };
    };
    return {
      revision: this.revision,
      http: status('http'),
      ws: status('ws'),
      ...(stale ? { stale } : {}),
    };
  }
}

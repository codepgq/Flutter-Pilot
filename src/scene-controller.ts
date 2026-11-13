import { randomUUID } from 'node:crypto';
import { validateRuleDocument, type Rule } from './model';
import type { WsRule } from './ws/model';
import type { Scene, SceneDocument, SceneRuntime } from './scene-model';
import { SceneStore } from './scenes';

type Domain = 'http' | 'ws';
export interface SceneHost {
  snapshot(): {
    key: string;
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
  document: SceneDocument = { version: 1, activeSceneId: null, scenes: [] };
  selectedSceneId?: string;
  private temporary: WsRule[] = [];
  private revision = 0;
  private appliedKey?: string;
  private errors: Partial<Record<Domain, string>> = {};
  private paused = new Set<Domain>();
  private pendingCaptures = new Map<Domain, boolean>();
  private operations: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private applying = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private run?: {
    id: string;
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
    return this.document.scenes.find((scene) => scene.id === this.document.activeSceneId);
  }
  summary() {
    return {
      version: this.document.version,
      activeSceneId: this.document.activeSceneId,
      runtimeRunId: this.run?.id,
      scenes: this.document.scenes.map((scene) => ({
        id: scene.id,
        name: scene.name,
        httpRuleCount: scene.httpRules.length,
        wsRuleCount: scene.wsRules.length,
        enabledHttpRuleCount: scene.httpRules.filter((rule) => rule.enabled).length,
        enabledWsRuleCount: scene.wsRules.filter((rule) => rule.enabled).length,
      })),
      runtime: this.runtime,
    };
  }
  get selected(): Scene | undefined {
    return (
      this.document.scenes.find((scene) => scene.id === this.selectedSceneId) ??
      this.active ??
      this.document.scenes[0]
    );
  }
  wsRules(scene: Scene | undefined = this.selected) {
    return [...(scene?.wsRules ?? []), ...(scene?.id === this.active?.id ? this.temporary : [])];
  }
  select(id: string) {
    if (!this.document.scenes.some((scene) => scene.id === id)) throw new Error('场景不存在');
    this.selectedSceneId = id;
    this.host.changed();
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation);
    this.operations = next.catch(() => undefined);
    return next;
  }
  async initialize() {
    this.document = await this.store.load();
    this.selectedSceneId = this.document.activeSceneId ?? this.document.scenes[0]?.id;
    this.loaded = true;
    await this.reconcile();
  }
  private ensureNoRun() {
    if (this.run) throw new Error(`测试运行 ${this.run.id} 正在使用场景，请等待结束或取消后再修改`);
  }
  /** Apply an in-memory test environment without persisting or changing activeSceneId. */
  beginRun(runId: string, sceneId?: string, httpOverrides: Rule[] = [], options: { deferWs?: boolean } = {}) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      if (!runId || runId.trim().length === 0 || runId.length > 128 || /[\x00-\x1f\x7f]/.test(runId))
        throw new Error('运行 ID 无效');
      if (!this.loaded) throw new Error('场景尚未初始化');
      const snapshot = this.host.snapshot();
      if (!snapshot.connected || snapshot.proxyRulesUnreachable)
        throw new Error('测试环境尚未连接，不能开始测试');
      const source =
        sceneId === undefined ? this.active : this.document.scenes.find((scene) => scene.id === sceneId);
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
        scene,
        paused: new Set(this.paused),
        pendingCaptures: new Map(this.pendingCaptures),
        temporary: structuredClone(this.temporary),
      };
      if (source?.id !== this.document.activeSceneId) this.temporary = [];
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
        if (needed) await this.host.enable('ws');
        const after = this.host.snapshot();
        if (!after.connected || after.key !== before.key || after.proxyRulesUnreachable)
          throw new Error('激活测试 WS 时连接发生变化');
        this.paused.delete('ws');
        delete this.errors.ws;
        this.appliedKey = this.applicationKey(after);
        ++this.revision;
      } catch (error) {
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
      run.restoring = true;
      this.paused = new Set(run.paused);
      this.pendingCaptures = new Map(run.pendingCaptures);
      this.temporary = structuredClone(run.temporary);
      if (this.host.snapshot().proxyRulesUnreachable) {
        if (!this.host.stopUnreachableProxy)
          throw new Error('代理控制连接已断开，无法确认测试规则已移除；请停止代理后重试恢复');
        await this.host.stopUnreachableProxy();
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
  private ensureSafeChange(next: SceneDocument) {
    if (!this.host.snapshot().proxyRulesUnreachable) return;
    const activeRules = (doc: SceneDocument) => {
      const scene = doc.scenes.find((item) => item.id === doc.activeSceneId);
      return [doc.activeSceneId, scene?.httpRules ?? [], scene?.wsRules ?? []];
    };
    if (JSON.stringify(activeRules(this.document)) !== JSON.stringify(activeRules(next)))
      throw new Error('代理控制连接已断开，旧规则可能仍在生效。请等待重连或停止代理后再更改激活场景。');
  }
  private async stopIfDisconnectedDuringSave(next: SceneDocument) {
    try {
      this.ensureSafeChange(next);
    } catch (error) {
      // The connection can drop while the file save is in flight. The new
      // selection is already persisted, so stop the still-serving process.
      if (!this.host.stopUnreachableProxy) throw error;
      await this.host.stopUnreachableProxy();
    }
  }
  reload() {
    return this.enqueue(async () => {
      this.ensureNoRun();
      const doc = await this.store.read();
      this.ensureSafeChange(doc);
      if (doc.activeSceneId !== this.document.activeSceneId) {
        this.temporary = [];
        this.paused.clear();
        this.pendingCaptures.clear();
      }
      this.document = doc;
      if (!doc.scenes.some((scene) => scene.id === this.selectedSceneId))
        this.selectedSceneId = doc.activeSceneId ?? doc.scenes[0]?.id;
      await this.apply();
      this.host.changed();
    });
  }
  change(edit: (document: SceneDocument) => void, force = false, resetPaused = false) {
    return this.enqueue(async () => {
      this.ensureNoRun();
      const before = this.document;
      const next = structuredClone(before);
      edit(next);
      this.ensureSafeChange(next);
      const saved = await this.store.save(next, before);
      if (this.host.snapshot().proxyRulesUnreachable) await this.stopIfDisconnectedDuringSave(saved);
      this.document = saved;
      if (resetPaused) {
        this.paused.clear();
        this.pendingCaptures.clear();
      }
      if (before.activeSceneId !== next.activeSceneId) this.temporary = [];
      if (!next.scenes.some((scene) => scene.id === this.selectedSceneId))
        this.selectedSceneId = next.activeSceneId ?? next.scenes[0]?.id;
      await this.apply(force);
      this.host.changed();
    });
  }
  activate(id: string | null) {
    return this.change(
      (doc) => {
        doc.activeSceneId = id;
      },
      true,
      true,
    );
  }
  create(name: string, source?: Scene) {
    const scene: Scene = source ? structuredClone(source) : { id: '', name, httpRules: [], wsRules: [] };
    scene.id = randomUUID();
    scene.name = name;
    for (const rule of [...scene.httpRules, ...scene.wsRules]) rule.id = randomUUID();
    return this.change((doc) => {
      doc.scenes.push(scene);
    }).then(() => this.select(scene.id));
  }
  saveHttp(rules: Rule[], id = this.selected?.id) {
    return this.change((doc) => {
      const scene = doc.scenes.find((scene) => scene.id === id);
      if (!scene) throw new Error('请选择目标场景');
      scene.httpRules = rules;
    });
  }
  saveWs(rules: WsRule[], id = this.selected?.id) {
    const temporary = rules.filter((rule) => rule.match.connectionId);
    if (temporary.length && id !== this.active?.id)
      return Promise.reject(new Error('临时连接规则只能加入当前激活场景'));
    return this.enqueue(async () => {
      this.ensureNoRun();
      const doc = structuredClone(this.document);
      const scene = doc.scenes.find((scene) => scene.id === id);
      if (!scene) throw new Error('请选择目标场景');
      scene.wsRules = rules.filter((rule) => !rule.match.connectionId);
      this.ensureSafeChange(doc);
      if (
        id === this.active?.id &&
        this.host.snapshot().proxyRulesUnreachable &&
        JSON.stringify(temporary) !== JSON.stringify(this.temporary)
      )
        throw new Error('代理控制连接已断开，旧规则可能仍在生效。请等待重连或停止代理后再更改激活场景。');
      const saved = await this.store.save(doc, this.document);
      if (this.host.snapshot().proxyRulesUnreachable) await this.stopIfDisconnectedDuringSave(saved);
      this.document = saved;
      if (id === this.active?.id) this.temporary = temporary;
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
      let failure: unknown;
      try {
        if (!enabled) {
          try {
            await this.host.disable(domain);
          } catch (error) {
            failure = error;
          }
        }
        try {
          await this.applyCapture(domain, enabled);
        } catch (error) {
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
      const failures: Partial<Record<Domain, string>> = {};
      for (const [domain, enabled] of this.pendingCaptures) {
        try {
          await this.applyCapture(domain, enabled);
        } catch (error) {
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
    await this.host.capture(domain, enabled);
    if (enabled) this.paused.delete(domain);
    else this.paused.add(domain);
    this.pendingCaptures.delete(domain);
    delete this.errors[domain];
  }
  private scheduleLeaseRetry() {
    if (!Object.values(this.errors).some((error) => /租约|等待.*秒/.test(error ?? ''))) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.appliedKey = undefined;
      void this.reconcile().catch(() => undefined);
    }, 16100);
    this.retryTimer.unref?.();
  }
  private applicationKey(snapshot: ReturnType<SceneHost['snapshot']>) {
    const scene = this.active;
    return JSON.stringify([
      snapshot.key,
      snapshot.connected,
      scene?.id,
      scene?.httpRules ?? [],
      scene ? this.wsRules(scene) : [],
      [...this.paused],
    ]);
  }
  private async apply(force = false) {
    if (!this.loaded) return;
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
          await this.host.disable(domain);
        } catch (error) {
          this.errors[domain] = String((error as Error).message);
        }
      }
      try {
        await this.host.project(http, ws);
      } catch (error) {
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
          await this.host.enable(domain);
        } catch (error) {
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
    const status = (domain: Domain) => {
      const rules =
        domain === 'http' ? (this.active?.httpRules ?? []) : this.active ? this.wsRules(this.active) : [];
      if (
        this.active &&
        rules.some((rule) => rule.enabled) &&
        state.connected &&
        this.appliedKey !== this.applicationKey(state)
      )
        return { status: 'pending' as const, message: '等待同步场景' };
      if (this.errors[domain]) return { status: 'error' as const, message: this.errors[domain] };
      if (!this.active || !rules.some((rule) => rule.enabled)) return { status: 'unneeded' as const };
      if (this.paused.has(domain)) return { status: 'paused' as const, message: '采集已关闭' };
      if (domain === 'ws' && state.mode === 'proxy')
        return { status: 'unsupported' as const, message: '代理模式不支持 WS Mock' };
      if (!state.connected) return { status: 'pending' as const, message: '待连接' };
      if (this.applying) return { status: 'pending' as const, message: '正在同步场景' };
      const error = domain === 'http' ? state.httpError : state.wsError;
      if (error) return { status: 'error' as const, message: error };
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
    return { revision: this.revision, http: status('http'), ws: status('ws') };
  }
}

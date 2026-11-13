import { randomUUID } from 'node:crypto';
import type { Rule } from './model';
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
  constructor(
    readonly store: SceneStore,
    private readonly host: SceneHost,
  ) {}
  get active() {
    return this.document.scenes.find((scene) => scene.id === this.document.activeSceneId);
  }
  summary() {
    return {
      version: this.document.version,
      activeSceneId: this.document.activeSceneId,
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
  }
  dispose() {
    this.loaded = false;
    ++this.revision;
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }
  setCapture(domain: Domain, enabled: boolean) {
    return this.enqueue(async () => {
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

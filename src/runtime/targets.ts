/** Public runtime identities contain no VM RPC or browser objects. */
export type RuntimeKind = 'flutter' | 'proxy' | 'browser';

export interface RuntimeProjectRef {
  readonly projectId: string;
  /** Canonical workspace path supplied by project discovery. */
  readonly workspacePath: string;
}

export interface RuntimeTargetRef extends RuntimeProjectRef {
  readonly runtimeId: string;
  readonly generation: number;
}

export type RuntimeCapabilityName =
  | 'http.history'
  | 'http.capture'
  | 'http.mock'
  | 'ws.history'
  | 'ws.capture'
  | 'ws.mock'
  | 'ws.send'
  | 'ws.inject'
  | 'ui.actions'
  | 'ui.screenshot';

export type RuntimeCapability =
  | { readonly supported: true; readonly coverage?: readonly string[] }
  | { readonly supported: false; readonly reason: string };

export interface RuntimeTarget extends RuntimeTargetRef {
  readonly kind: RuntimeKind;
  readonly connected: boolean;
  /** Legacy Flutter session identity, never interpreted as a proxy/browser identity. */
  readonly sessionId?: string;
  readonly label?: string;
  /** Resource shared by executions, such as a device or browser Context. */
  readonly executionScope?: string;
  readonly capabilities: Readonly<Partial<Record<RuntimeCapabilityName, RuntimeCapability>>>;
}

export interface RuntimeTargetSelector extends Partial<RuntimeProjectRef> {
  readonly runtimeId?: string;
  readonly generation?: number;
  readonly sessionId?: string;
  readonly kind?: RuntimeKind;
}

export type RuntimeTargetErrorCode =
  'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS' | 'TARGET_DISCONNECTED' | 'TARGET_STALE' | 'TARGET_UNSUPPORTED';

export class RuntimeTargetError extends Error {
  constructor(
    readonly code: RuntimeTargetErrorCode,
    message: string,
    readonly target?: RuntimeTargetRef,
  ) {
    super(message);
    this.name = 'RuntimeTargetError';
  }
}

/** Scope keys include the actual workspace, even when project UUIDs were copied. */
export function runtimeProjectKey(project: RuntimeProjectRef): string {
  return JSON.stringify([project.projectId, project.workspacePath]);
}

export function runtimeTargetKey(target: Omit<RuntimeTargetRef, 'generation'>): string {
  return JSON.stringify([target.projectId, target.workspacePath, target.runtimeId]);
}

/** Use for history, activation and temporary execution state belonging to one incarnation. */
export function runtimeGenerationKey(target: RuntimeTargetRef): string {
  return JSON.stringify([target.projectId, target.workspacePath, target.runtimeId, target.generation]);
}

export function runtimeExecutionKey(target: RuntimeTarget): string {
  return JSON.stringify([target.projectId, target.workspacePath, target.executionScope ?? target.runtimeId]);
}

function snapshot(target: RuntimeTarget): RuntimeTarget {
  const capabilities = Object.fromEntries(
    Object.entries(target.capabilities).map(([name, value]) => [
      name,
      Object.freeze({
        ...value,
        ...('coverage' in value && value.coverage ? { coverage: Object.freeze([...value.coverage]) } : {}),
      }),
    ]),
  );
  return Object.freeze({ ...target, capabilities: Object.freeze(capabilities) });
}

/**
 * Explicit selection and generation validation shared by all runtime adapters.
 * Registration starts a new incarnation; ordinary status reads never register or reconnect.
 */
export class RuntimeTargetRegistry {
  private readonly targets = new Map<string, RuntimeTarget>();

  register(target: Omit<RuntimeTarget, 'generation' | 'connected'> & { connected?: boolean }) {
    const key = runtimeTargetKey(target);
    const previous = this.targets.get(key);
    const current = snapshot({
      ...target,
      connected: target.connected ?? true,
      generation: (previous?.generation ?? 0) + 1,
    });
    this.targets.set(key, current);
    return current;
  }

  list(selector: RuntimeTargetSelector = {}): RuntimeTarget[] {
    return [...this.targets.values()].filter(
      (target) =>
        (selector.projectId === undefined || selector.projectId === target.projectId) &&
        (selector.workspacePath === undefined || selector.workspacePath === target.workspacePath) &&
        (selector.runtimeId === undefined || selector.runtimeId === target.runtimeId) &&
        (selector.kind === undefined || selector.kind === target.kind) &&
        (selector.sessionId === undefined ||
          (target.kind === 'flutter' && selector.sessionId === target.sessionId)),
    );
  }

  resolve(selector: RuntimeTargetSelector = {}, capability?: RuntimeCapabilityName): RuntimeTarget {
    const candidates = this.list(selector);
    // An explicit identity must report its disconnection instead of choosing another target.
    const explicit = selector.runtimeId !== undefined || selector.sessionId !== undefined;
    const eligible = explicit ? candidates : candidates.filter((target) => target.connected);
    if (!eligible.length) {
      throw new RuntimeTargetError('TARGET_NOT_FOUND', '未找到运行目标，请先发现并明确选择目标。');
    }
    if (eligible.length !== 1) {
      throw new RuntimeTargetError(
        'TARGET_AMBIGUOUS',
        '存在多个运行目标，请指定项目和 runtimeId 或 Flutter sessionId。',
      );
    }
    const target = eligible[0];
    if (selector.generation !== undefined && selector.generation !== target.generation) {
      throw new RuntimeTargetError('TARGET_STALE', '运行目标代次已失效，请重新发现目标。', target);
    }
    return this.assertCurrent(target, capability);
  }

  assertCurrent(ref: RuntimeTargetRef, capability?: RuntimeCapabilityName): RuntimeTarget {
    const target = this.targets.get(runtimeTargetKey(ref));
    if (!target) {
      throw new RuntimeTargetError('TARGET_NOT_FOUND', '运行目标不存在，请重新发现目标。', ref);
    }
    if (target.generation !== ref.generation) {
      throw new RuntimeTargetError('TARGET_STALE', '运行目标代次已失效，请重新发现目标。', ref);
    }
    if (!target.connected) {
      throw new RuntimeTargetError('TARGET_DISCONNECTED', '运行目标已断开，不会自动重放操作。', ref);
    }
    if (capability) {
      const support = target.capabilities[capability];
      if (!support?.supported) {
        throw new RuntimeTargetError(
          'TARGET_UNSUPPORTED',
          support && !support.supported ? support.reason : `运行目标不支持 ${capability}。`,
          ref,
        );
      }
    }
    return target;
  }

  /** A late disconnect for a replaced connection cannot invalidate its successor. */
  invalidate(ref: RuntimeTargetRef): boolean {
    const key = runtimeTargetKey(ref);
    const current = this.targets.get(key);
    if (!current || current.generation !== ref.generation || !current.connected) return false;
    this.targets.set(key, snapshot({ ...current, connected: false }));
    return true;
  }

  /** Pin before invoking the adapter and reject responses from disconnected or replaced targets. */
  async run<T>(
    ref: RuntimeTargetRef,
    capability: RuntimeCapabilityName,
    operation: (target: RuntimeTarget) => Promise<T>,
  ): Promise<T> {
    const target = this.assertCurrent(ref, capability);
    const result = await operation(target);
    this.assertCurrent(ref, capability);
    return result;
  }
}

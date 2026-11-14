import { z } from 'zod';
import { automationMcpTools, uiSelectorSchema } from '../automation/tools';
import type { Backend, Selector } from '../automation/model';
import type { Scene, SceneDocument } from '../scene-model';

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const inputName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const text = z.string().max(16384);
const timeout = z.number().int().min(100).max(30000).optional();
const selector = uiSelectorSchema.superRefine((value, ctx) => {
  if (value.ref !== undefined || value.ancestor?.ref !== undefined)
    ctx.addIssue({ code: 'custom', message: '场景操作只能保存稳定选择器，不能保存快照 ref。' });
});
const input = z
  .object({ required: z.boolean().optional(), default: text.optional(), secret: z.boolean().optional() })
  .strict();
const step = z.discriminatedUnion('type', [
  z.object({ id: name, type: z.literal('tap'), target: name, timeoutMs: timeout }).strict(),
  z.object({ id: name, type: z.literal('enter_text'), target: name, text, timeoutMs: timeout }).strict(),
  z
    .object({
      id: name,
      type: z.literal('wait_for_widget'),
      target: name,
      timeoutMs: timeout,
      state: z
        .enum([
          'present',
          'absent',
          'visible',
          'enabled',
          'actionable',
          'text_equals',
          'text_contains',
          'text_changed',
        ])
        .optional(),
      text: z.string().max(1024).optional(),
    })
    .strict(),
  z
    .object({
      id: name,
      type: z.literal('scroll'),
      target: name,
      untilTarget: name.optional(),
      timeoutMs: timeout,
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      distance: z.number().finite().min(1).max(2000).optional(),
      durationMs: z.number().int().min(40).max(10000).optional(),
      maxSteps: z.number().int().min(1).max(30).optional(),
    })
    .strict(),
  z
    .object({
      id: name,
      type: z.literal('call'),
      sceneId: z.string().min(1).max(128).optional(),
      actionId: name,
      inputs: z.record(inputName, text).optional(),
    })
    .strict(),
]);
const action = z
  .object({
    id: name,
    name: z.string().trim().min(1).max(256),
    description: z.string().max(16384).optional(),
    inputs: z
      .record(inputName, input)
      .refine((value) => Object.keys(value).length <= 64)
      .optional(),
    steps: z.array(step).min(1).max(500),
  })
  .strict();
const sceneOperations = z
  .object({
    targets: z.record(name, selector).optional(),
    actions: z.array(action).max(200).optional(),
  })
  .strict();

export interface ActionReference {
  sceneId: string;
  actionId: string;
}
export type SceneAction = z.infer<typeof action>;
export type WorkflowStep = z.infer<typeof step>;
export type WorkflowInput = z.infer<typeof input>;
export type WorkflowTool = 'tap' | 'enter_text' | 'wait_for_widget' | 'scroll';
export interface CompiledWorkflowStep {
  id: string;
  path: string;
  sceneId: string;
  actionId: string;
  target: string;
  tool: WorkflowTool;
  args: Record<string, unknown>;
}
export interface CompiledWorkflow {
  sceneId: string;
  action: SceneAction;
  inputs: Record<string, string>;
  secrets: string[];
  steps: CompiledWorkflowStep[];
}

export class WorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new WorkflowError('INVALID_SCENE_ACTION', message);
}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Only named string inputs can be interpolated; no expressions or executable templates. */
function interpolate(value: string, values: Record<string, string>): string {
  return value.replace(/\$\{([^}]*)\}/g, (_whole, expression: string) => {
    const match = /^inputs\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(expression);
    if (!match || !own(values, match[1])) invalid('模板只能引用已声明且有值的 ${inputs.name}。');
    return values[match[1]];
  });
}
function validateTemplates(value: unknown, inputs?: Record<string, WorkflowInput>) {
  if (typeof value === 'string') {
    if (value.replace(/\$\{[^}]*\}/g, '').includes('${')) invalid('模板表达式缺少结束符。');
    for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
      const expression = /^inputs\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(match[1]);
      if (!expression || (inputs && !own(inputs, expression[1])))
        invalid('模板引用了未知输入，或使用了不支持的表达式。');
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) validateTemplates(item, inputs);
  }
}
function bindSelector(value: Selector, inputs: Record<string, string>): Selector {
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === 'string'
        ? interpolate(item, inputs)
        : item && typeof item === 'object'
          ? bindSelector(item as Selector, inputs)
          : item,
    ]),
  );
  const parsed = selector.safeParse(result);
  if (!parsed.success) invalid('输入替换后选择器无效。');
  return parsed.data;
}

const referenceKey = (sceneId: string, actionId: string) => JSON.stringify([sceneId, actionId]);
const actionPath = (sceneId: string, actionId: string) => `${encodeURIComponent(sceneId)}/${actionId}`;
interface LocatedAction {
  scene: Scene;
  action: SceneAction;
}

/** Validate and normalize action definitions without modifying the source snapshot. */
export function validateSceneActions(doc: SceneDocument): SceneDocument {
  const normalized = { ...doc, scenes: doc.scenes.map((scene) => ({ ...scene })) };
  const all = new Map<string, LocatedAction>();
  let stepCount = 0;
  for (const scene of normalized.scenes) {
    const parsed = sceneOperations.safeParse({
      ...(scene.targets !== undefined ? { targets: scene.targets } : {}),
      ...(scene.actions !== undefined ? { actions: scene.actions } : {}),
    });
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.join('.') || 'actions';
      invalid(`场景操作配置格式无效（${scene.id}/${path}）；请检查字段、步骤类型及稳定选择器。`);
    }
    Object.assign(scene, parsed.data);
    // Targets may be stored before an action is authored. Check syntax now;
    // declarations are checked only for the actions that actually use a target.
    validateTemplates(scene.targets);
    for (const value of scene.actions ?? []) {
      const key = referenceKey(scene.id, value.id);
      if (all.has(key)) invalid(`操作 ID 重复：${scene.id}/${value.id}`);
      all.set(key, { scene, action: value });
      stepCount += value.steps.length;
      if (stepCount > 5000) invalid('场景文件最多包含 5000 个操作步骤。');
      const ids = new Set<string>();
      for (const item of value.steps) {
        if (ids.has(item.id)) invalid(`步骤 ID 重复：${scene.id}/${value.id}/${item.id}`);
        ids.add(item.id);
        if (item.type !== 'call') {
          const targets = scene.targets ?? {};
          if (!own(targets, item.target)) invalid(`目标不存在：${scene.id}/${value.id}/${item.target}`);
          validateTemplates(targets[item.target], value.inputs ?? {});
          if (item.type === 'scroll' && item.untilTarget) {
            if (!own(targets, item.untilTarget))
              invalid(`滚动目标不存在：${scene.id}/${value.id}/${item.untilTarget}`);
            validateTemplates(targets[item.untilTarget], value.inputs ?? {});
          }
          if (item.type === 'wait_for_widget' && item.state?.startsWith('text_') && item.text === undefined)
            invalid(`文字等待条件缺少 text：${scene.id}/${value.id}/${item.id}`);
        }
        validateTemplates(
          item.type === 'call' ? item.inputs : 'text' in item ? item.text : undefined,
          value.inputs ?? {},
        );
      }
    }
  }
  const depths = new Map<string, number>(),
    visiting = new Set<string>();
  const visit = (key: string): number => {
    if (visiting.has(key)) invalid('子操作存在循环引用。');
    const cached = depths.get(key);
    if (cached !== undefined) return cached;
    if (visiting.size >= 16) invalid('子操作嵌套最多 16 层。');
    const parent = all.get(key)!;
    visiting.add(key);
    let depth = 1;
    for (const item of parent.action.steps) {
      if (item.type !== 'call') continue;
      const sceneId = item.sceneId ?? parent.scene.id;
      const childKey = referenceKey(sceneId, item.actionId),
        child = all.get(childKey);
      if (!child) invalid(`引用的子操作不存在：${sceneId}/${item.actionId}`);
      for (const inputName of Object.keys(item.inputs ?? {}))
        if (!own(child.action.inputs ?? {}, inputName))
          invalid(`子操作输入不存在：${sceneId}/${item.actionId}/${inputName}`);
      for (const [inputName, spec] of Object.entries(child.action.inputs ?? {}))
        if (spec.required && spec.default === undefined && !own(item.inputs ?? {}, inputName))
          invalid(`子操作缺少必填输入：${sceneId}/${item.actionId}/${inputName}`);
      depth = Math.max(depth, 1 + visit(childKey));
      if (depth > 16) invalid('子操作嵌套最多 16 层。');
    }
    visiting.delete(key);
    depths.set(key, depth);
    return depth;
  };
  for (const key of all.keys()) visit(key);
  return normalized;
}

/** Bind one named action and expand its calls using the same immutable scene snapshot. */
export function compileSceneAction(
  doc: SceneDocument,
  sceneId: string,
  actionId: string,
  supplied: Record<string, string> = {},
  backend: Backend = 'auto',
): CompiledWorkflow {
  doc = validateSceneActions(doc);
  const scene = doc.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new WorkflowError('SCENE_NOT_FOUND', '指定场景不存在，请先调用 list_scenes。');
  const root = scene.actions?.find((item) => item.id === actionId);
  if (!root)
    throw new WorkflowError('SCENE_ACTION_NOT_FOUND', '指定操作不存在，请先调用 list_scene_actions。');
  if (!['auto', 'flutter', 'device'].includes(backend)) invalid('场景操作输入后端无效。');
  const secrets = new Set<string>();
  const bind = (value: SceneAction, values: Record<string, string>) => {
    for (const key of Object.keys(values)) {
      if (!own(value.inputs ?? {}, key)) invalid(`未声明的运行参数：${value.id}/${key}`);
      if (typeof values[key] !== 'string' || values[key].length > 16384)
        invalid('运行参数必须是最多 16384 字符的字符串。');
    }
    const result: Record<string, string> = Object.create(null);
    for (const [key, spec] of Object.entries(value.inputs ?? {})) {
      const inputValue = own(values, key) ? values[key] : spec.default;
      if (inputValue === undefined) {
        if (spec.required) invalid(`缺少必填输入：${value.id}/${key}`);
        continue;
      }
      result[key] = inputValue;
      if (spec.secret && inputValue) secrets.add(inputValue);
    }
    return result;
  };
  const rootInputs = bind(root, supplied),
    steps: CompiledWorkflowStep[] = [];
  const expand = (
    owner: Scene,
    value: SceneAction,
    inputs: Record<string, string>,
    prefix: string,
    depth: number,
  ) => {
    if (depth > 16) invalid('子操作嵌套最多 16 层。');
    for (const item of value.steps) {
      const path = `${prefix}/${item.id}`;
      if (item.type === 'call') {
        const childScene = doc.scenes.find((candidate) => candidate.id === (item.sceneId ?? owner.id))!;
        const child = childScene.actions!.find((candidate) => candidate.id === item.actionId)!;
        const values = Object.fromEntries(
          Object.entries(item.inputs ?? {}).map(([key, inputValue]) => [
            key,
            interpolate(inputValue, inputs),
          ]),
        );
        expand(
          childScene,
          child,
          bind(child, values),
          `${path}/${actionPath(childScene.id, child.id)}`,
          depth + 1,
        );
        continue;
      }
      if (steps.length >= 1000) invalid('一次运行展开后最多 1000 个操作步骤。');
      const { id: _id, type, target, ...rest } = item;
      const args: Record<string, unknown> = {
        selector: bindSelector(owner.targets![target] as Selector, inputs),
        backend,
        ...rest,
      };
      if ('text' in args && typeof args.text === 'string') args.text = interpolate(args.text, inputs);
      if (item.type === 'scroll') {
        delete args.untilTarget;
        if (item.untilTarget)
          args.targetSelector = bindSelector(owner.targets![item.untilTarget] as Selector, inputs);
      }
      const checked = automationMcpTools[type].schema.safeParse({ sessionId: 'scene-action', ...args });
      if (!checked.success) invalid(`步骤参数无效：${path}`);
      const { sessionId: _session, ...validated } = checked.data;
      steps.push({
        id: item.id,
        path,
        sceneId: owner.id,
        actionId: value.id,
        target: item.target,
        tool: type,
        args: validated,
      });
    }
  };
  expand(scene, root, rootInputs, actionPath(scene.id, root.id), 1);
  return { sceneId, action: root, inputs: rootInputs, secrets: [...secrets], steps };
}

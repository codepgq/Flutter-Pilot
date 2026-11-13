import { z } from 'zod';
import { automationMcpTools, uiSelectorSchema } from '../automation/tools';
import type { Backend, Selector } from '../automation/model';

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const inputName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const text = z.string().max(16384);
const timeout = z.number().int().min(100).max(30000).optional();
const selector = uiSelectorSchema.superRefine((value, ctx) => {
  if (value.ref !== undefined || value.ancestor?.ref !== undefined)
    ctx.addIssue({ code: 'custom', message: '工作流只能保存稳定选择器，不能保存快照 ref。' });
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
      workflowId: name,
      inputs: z.record(inputName, text).optional(),
    })
    .strict(),
]);
const workflow = z
  .object({
    id: name,
    name: z.string().trim().min(1).max(256),
    inputs: z.record(inputName, input).optional(),
    targets: z.record(name, selector),
    steps: z.array(step).min(1).max(500),
  })
  .strict();
const document = z.object({ version: z.literal(1), workflows: z.array(workflow).max(200) }).strict();

export type WorkflowDocument = z.infer<typeof document>;
export type Workflow = z.infer<typeof workflow>;
export type WorkflowStep = z.infer<typeof step>;
export type WorkflowInput = z.infer<typeof input>;
export type WorkflowTool = 'tap' | 'enter_text' | 'wait_for_widget' | 'scroll';
export interface CompiledWorkflowStep {
  id: string;
  path: string;
  workflowId: string;
  target: string;
  tool: WorkflowTool;
  args: Record<string, unknown>;
}
export interface CompiledWorkflow {
  workflow: Workflow;
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
  throw new WorkflowError('INVALID_WORKFLOW', message);
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
function validateTemplates(value: unknown, inputs: Record<string, WorkflowInput>) {
  if (typeof value === 'string') {
    if (value.replace(/\$\{[^}]*\}/g, '').includes('${')) invalid('模板表达式缺少结束符。');
    for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
      const expression = /^inputs\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(match[1]);
      if (!expression || !own(inputs, expression[1])) invalid('模板引用了未知输入，或使用了不支持的表达式。');
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

/** Validate the entire document, including references and recursion, before any UI action. */
export function validateWorkflowDocument(value: unknown): WorkflowDocument {
  const parsed = document.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join('.') || 'document';
    invalid(`工作流配置格式无效（${path}）；请检查字段、步骤类型及稳定选择器。`);
  }
  const doc = parsed.data;
  const all = new Map<string, Workflow>();
  let stepCount = 0;
  for (const flow of doc.workflows) {
    if (all.has(flow.id)) invalid(`工作流 ID 重复：${flow.id}`);
    all.set(flow.id, flow);
    stepCount += flow.steps.length;
    if (stepCount > 5000) invalid('工作流文件最多包含 5000 个步骤。');
    const ids = new Set<string>();
    for (const item of flow.steps) {
      if (ids.has(item.id)) invalid(`步骤 ID 重复：${flow.id}/${item.id}`);
      ids.add(item.id);
      if (item.type !== 'call') {
        if (!own(flow.targets, item.target)) invalid(`目标不存在：${flow.id}/${item.target}`);
        if (item.type === 'scroll' && item.untilTarget && !own(flow.targets, item.untilTarget))
          invalid(`滚动目标不存在：${flow.id}/${item.untilTarget}`);
        if (item.type === 'wait_for_widget' && item.state?.startsWith('text_') && item.text === undefined)
          invalid(`文字等待条件缺少 text：${flow.id}/${item.id}`);
      }
      validateTemplates(
        item.type === 'call' ? item.inputs : 'text' in item ? item.text : undefined,
        flow.inputs ?? {},
      );
    }
    validateTemplates(flow.targets, flow.inputs ?? {});
  }
  const visited = new Set<string>(),
    visiting = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (depth > 16) invalid('子流程嵌套最多 16 层。');
    if (visiting.has(id)) invalid(`子流程存在循环：${id}`);
    if (visited.has(id)) return;
    const flow = all.get(id);
    if (!flow) invalid(`引用的子流程不存在：${id}`);
    visiting.add(id);
    for (const item of flow.steps)
      if (item.type === 'call') {
        const child = all.get(item.workflowId);
        if (!child) invalid(`引用的子流程不存在：${item.workflowId}`);
        for (const key of Object.keys(item.inputs ?? {}))
          if (!own(child.inputs ?? {}, key)) invalid(`子流程输入不存在：${item.workflowId}/${key}`);
        for (const [key, spec] of Object.entries(child.inputs ?? {}))
          if (spec.required && spec.default === undefined && !own(item.inputs ?? {}, key))
            invalid(`子流程缺少必填输入：${item.workflowId}/${key}`);
        visit(item.workflowId, depth + 1);
      }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of all.keys()) visit(id, 1);
  return doc;
}

export function compileWorkflow(
  doc: WorkflowDocument,
  workflowId: string,
  supplied: Record<string, string> = {},
  backend: Backend = 'auto',
): CompiledWorkflow {
  const flows = new Map(doc.workflows.map((flow) => [flow.id, flow]));
  const root = flows.get(workflowId);
  if (!root) throw new WorkflowError('WORKFLOW_NOT_FOUND', '指定工作流不存在，请先调用 list_workflows。');
  if (!['auto', 'flutter', 'device'].includes(backend)) invalid('工作流输入后端无效。');
  const secrets = new Set<string>();
  const bind = (flow: Workflow, values: Record<string, string>) => {
    for (const key of Object.keys(values)) {
      if (!own(flow.inputs ?? {}, key)) invalid(`未声明的运行参数：${flow.id}/${key}`);
      if (typeof values[key] !== 'string' || values[key].length > 16384)
        invalid('运行参数必须是最多 16384 字符的字符串。');
    }
    const result: Record<string, string> = Object.create(null);
    for (const [key, spec] of Object.entries(flow.inputs ?? {})) {
      const value = own(values, key) ? values[key] : spec.default;
      if (value === undefined) {
        if (spec.required) invalid(`缺少必填输入：${flow.id}/${key}`);
        continue;
      }
      result[key] = value;
      if (spec.secret && value) secrets.add(value);
    }
    return result;
  };
  const rootInputs = bind(root, supplied),
    steps: CompiledWorkflowStep[] = [];
  const expand = (flow: Workflow, inputs: Record<string, string>, prefix: string, depth: number) => {
    if (depth > 16) invalid('子流程嵌套最多 16 层。');
    for (const item of flow.steps) {
      const path = `${prefix}/${item.id}`;
      if (item.type === 'call') {
        const child = flows.get(item.workflowId);
        if (!child) invalid(`引用的子流程不存在：${item.workflowId}`);
        const values = Object.fromEntries(
          Object.entries(item.inputs ?? {}).map(([key, value]) => [key, interpolate(value, inputs)]),
        );
        expand(child, bind(child, values), path, depth + 1);
        continue;
      }
      if (steps.length >= 1000) invalid('一次运行展开后最多 1000 个操作步骤。');
      const { id: _id, type, target, ...rest } = item;
      const args: Record<string, unknown> = {
        selector: bindSelector(flow.targets[target] as Selector, inputs),
        backend,
        ...rest,
      };
      if ('text' in args && typeof args.text === 'string') args.text = interpolate(args.text, inputs);
      if (item.type === 'scroll') {
        delete args.untilTarget;
        if (item.untilTarget)
          args.targetSelector = bindSelector(flow.targets[item.untilTarget] as Selector, inputs);
      }
      const checked = automationMcpTools[type].schema.safeParse({ sessionId: 'workflow', ...args });
      if (!checked.success) invalid(`步骤参数无效：${path}`);
      const { sessionId: _session, ...validated } = checked.data;
      steps.push({
        id: item.id,
        path,
        workflowId: flow.id,
        target: item.target,
        tool: type,
        args: validated,
      });
    }
  };
  expand(root, rootInputs, root.id, 1);
  return { workflow: root, inputs: rootInputs, secrets: [...secrets], steps };
}

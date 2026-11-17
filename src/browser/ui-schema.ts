import { z } from 'zod';
import { browserPageSchema } from './protocol';
const id = z.string().min(1).max(512);
const frame = z.object({ testId: id }).strict();
export const webSelectorSchema = z.union([
  z.object({ source: z.literal('web'), testId: id, frame: frame.optional() }).strict(),
  z
    .object({ source: z.literal('web'), role: id, name: z.string().max(1024), frame: frame.optional() })
    .strict(),
]);
export type WebSelector = z.infer<typeof webSelectorSchema>;
const common = {
  sessionId: id,
  target: browserPageSchema,
  backend: z.literal('auto').optional(),
  timeoutMs: z.number().int().min(100).max(30000).optional(),
};
const selected = { ...common, selector: webSelectorSchema };
export const webUiTools = {
  get_ui_snapshot: {
    description: 'Web: read bounded DOM structure on an explicit Page; no stored refs.',
    schema: z
      .object({ ...common, source: z.literal('web'), maxNodes: z.number().int().min(1).max(1000).optional() })
      .strict(),
  },
  find_widget: {
    description:
      'Web: unique testId or explicit role/name, optionally scoped to an iframe testId. No fallback.',
    schema: z.object(selected).strict(),
  },
  tap: {
    description:
      'Web: real pointer click; disabled, obscured or ambiguous targets fail. Never force or replay.',
    schema: z.object(selected).strict(),
  },
  enter_text: {
    description: 'Web: fill the unique editable DOM control through browser input events.',
    schema: z
      .object({ ...selected, text: z.string().max(16384), mode: z.enum(['replace', 'append']).optional() })
      .strict(),
  },
  press_key: {
    description: 'Web: send an explicit key to the selected Page focus. No device or IME emulation.',
    schema: z
      .object({
        ...common,
        keyName: z.string().min(1).max(32),
        modifiers: z
          .array(z.enum(['Control', 'Shift', 'Alt', 'Meta']))
          .max(4)
          .optional(),
      })
      .strict(),
  },
  scroll: {
    description: 'Web: wheel only the uniquely selected scrollable region; no fallback to the document.',
    schema: z
      .object({
        ...selected,
        direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        distance: z.number().min(1).max(2000).optional(),
        durationMs: z.number().int().min(40).max(10000).optional(),
        targetSelector: webSelectorSchema.optional(),
        maxSteps: z.number().int().min(1).max(30).optional(),
      })
      .strict(),
  },
  wait_for_widget: {
    description: 'Web: wait for real DOM state; failure includes selector, condition and last observation.',
    schema: z
      .object({
        ...selected,
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
      .strict()
      .refine((a) => !a.state?.startsWith('text_') || a.text !== undefined, 'Text state requires text'),
  },
  take_screenshot: {
    description:
      'Web: viewport or full-page PNG of the exact Page; 16384px per side, 32M pixels and 12MiB limit. Flutter long screenshots remain separate.',
    schema: z.object({ ...common, source: z.literal('web'), mode: z.enum(['screen', 'full_page']) }).strict(),
  },
} as const;

export function validateWebAction(tool: string, args: Record<string, any>) {
  const definition = webUiTools[tool as keyof typeof webUiTools];
  if (!definition) return false;
  return definition.schema.safeParse({
    sessionId: 'preflight',
    target: { runtimeId: 'preflight', generation: 1, pageId: 'preflight' },
    ...args,
  }).success;
}

import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { webSelectorSchema } from '../src/browser/ui-schema';
import { compileSceneAction } from '../src/workflows/model';
import { validateScenePackage } from '../src/scenes';
import { parseTool } from '../src/mcp/tools';
it('rejects mixed and temporary Web selectors and requires an explicit Page', () => {
  for (const selector of [
    { source: 'web', testId: 'x', key: 'x' },
    { source: 'web', testId: 'x', role: 'button', name: 'X' },
    { source: 'web', role: 'button' },
    { source: 'web', testId: 'x', ref: 'temporary' },
  ])
    expect(webSelectorSchema.safeParse(selector).success).toBe(false);
  expect(() => parseTool('tap', { sessionId: 's', selector: { source: 'web', testId: 'x' } })).toThrow();
  expect(() =>
    parseTool('take_screenshot', {
      sessionId: 's',
      source: 'web',
      mode: 'long',
      target: { runtimeId: 'r', generation: 1, pageId: 'p' },
    }),
  ).toThrow();
});
it('compiles shipped Web actions through the production Scene compiler and preserves secrets', async () => {
  const pkg = validateScenePackage(JSON.parse(await readFile('resources/example.web-scenes.json', 'utf8')));
  const doc = { ...pkg, version: 1 as const, activeSceneId: null };
  const result = compileSceneAction(doc, 'web-form', 'submit', { value: 'fixture-secret' });
  expect(result.steps.map((s) => s.tool)).toEqual(['enter_text', 'tap', 'wait_for_widget']);
  expect(result.secrets).toContain('fixture-secret');
  expect(result.steps[0].args.selector).toEqual({ source: 'web', testId: 'entry' });
  expect(() =>
    compileSceneAction(doc, 'web-form', 'submit', { value: 'fixture-secret' }, 'flutter'),
  ).toThrow();
});

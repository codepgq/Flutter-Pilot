import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateSceneDocument } from '../src/scene-model';
import { compileSceneAction } from '../src/workflows/model';

const loadExamples = async () =>
  validateSceneDocument(JSON.parse(await readFile('resources/example.scenes.json', 'utf8')));

describe('archived Scene action examples', () => {
  it('compiles every shipped action with explicit string inputs', async () => {
    const doc = await loadExamples();
    for (const scene of doc.scenes) {
      for (const action of scene.actions ?? []) {
        const supplied = Object.fromEntries(
          Object.entries(action.inputs ?? {}).map(([name, input]) => [
            name,
            input.default ?? `${name}-fixture`,
          ]),
        );
        const compiled = compileSceneAction(doc, scene.id, action.id, supplied, 'flutter');
        expect(compiled.steps.length).toBeGreaterThan(0);
        expect(compiled.steps.every((step) => step.args.backend === 'flutter')).toBe(true);
      }
    }
  });

  it('shares the same keyed email core across both explicit entry pages without changing Mock', async () => {
    const doc = await loadExamples();
    doc.activeSceneId = 'example-orders';
    const before = structuredClone(doc);
    const inputs = { email: 'fixture@example.test', code: '654321' };
    const first = compileSceneAction(doc, 'email_entrypoints', 'email_login_to_home', inputs, 'flutter');
    const recent = compileSceneAction(
      doc,
      'email_entrypoints',
      'switch_account_login_to_home',
      inputs,
      'flutter',
    );
    const core = compileSceneAction(
      doc,
      'email_operations',
      'complete_email_login_to_home',
      inputs,
      'flutter',
    );
    const home = compileSceneAction(doc, 'email_operations', 'open_home', {}, 'flutter');
    const commands = (run: typeof core) =>
      run.steps.map((step) => ({ sceneId: step.sceneId, actionId: step.actionId, args: step.args }));
    expect(first.steps).toHaveLength(15);
    expect(recent.steps).toHaveLength(15);
    expect(core.steps).toHaveLength(10);
    expect(home.steps).toHaveLength(4);
    expect(commands(first).slice(5)).toEqual(commands(core));
    expect(commands(recent).slice(5)).toEqual(commands(core));
    expect(first.steps[2].args.selector).toMatchObject({
      source: 'flutter',
      key: 'registrationLogin.otherOptions',
    });
    expect(recent.steps[2].args.selector).toMatchObject({
      source: 'flutter',
      key: 'registrationLogin.switchAccount',
    });
    for (const compiled of [first, recent, core]) {
      expect(compiled.secrets).toContain(inputs.code);
      expect(compiled.steps.find((step) => step.id === 'fill_email')?.args).toMatchObject({
        selector: { source: 'flutter', key: 'emailEntry.input' },
        text: inputs.email,
      });
      expect(compiled.steps.find((step) => step.id === 'fill_code')?.args.text).toBe(inputs.code);
    }
    expect(doc).toEqual(before);
    expect(doc.activeSceneId).toBe('example-orders');
  });

  it('requires caller-provided email/code and uses mounted-widget waits around keyboard dismissal', async () => {
    const doc = await loadExamples();
    for (const actionId of ['email_login_to_home', 'switch_account_login_to_home']) {
      expect(() => compileSceneAction(doc, 'email_entrypoints', actionId)).toThrow();
      expect(() =>
        compileSceneAction(doc, 'email_entrypoints', actionId, { email: 'fixture@example.test' }),
      ).toThrow();
    }
    const core = compileSceneAction(doc, 'email_operations', 'complete_email_login_to_home', {
      email: 'fixture@example.test',
      code: '654321',
    });
    const keyboard = core.steps.findIndex((step) => step.tool === 'hide_keyboard');
    expect(core.steps[keyboard - 1].tool).toBe('enter_text');
    expect(core.steps[keyboard + 1]).toMatchObject({
      tool: 'wait_for_widget',
      args: { state: 'actionable', selector: { key: 'emailEntry.continue' } },
    });
    expect(core.steps[keyboard + 2]).toMatchObject({
      tool: 'tap',
      args: { selector: { key: 'emailEntry.continue' } },
    });
    for (const sceneId of ['email_operations', 'email_entrypoints']) {
      const scene = doc.scenes.find((candidate) => candidate.id === sceneId)!;
      expect(scene.httpRules).toEqual([]);
      expect(scene.wsRules).toEqual([]);
      for (const target of Object.values(scene.targets ?? {})) {
        expect(target).toEqual({ source: 'flutter', key: expect.any(String) });
      }
    }
  });
});

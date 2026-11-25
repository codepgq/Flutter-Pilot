import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { SceneStore } from '../scenes';
import { validateRuleDocument, type HistoryEntry, type Rule } from '../model';
import { DynamicHttp } from './dynamic-http';
import { installHttp } from './interception';

/** Attach the production interception engine to a Playwright-owned Chromium Context. */
export async function attachScene(context: BrowserContext, directory: string, sceneId: string) {
  await access(join(directory, 'scenes', 'index.json'));
  const temporary = await mkdtemp(join(tmpdir(), 'pilot-test-context-'));
  const snapshot = await (async () => {
    const store = new SceneStore(directory, temporary);
    try {
      await store.load();
      return await store.prepareSnapshot([], sceneId);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  })();
  const base = snapshot.scenes.find((scene) => scene.id === sceneId)!.httpRules;
  const dynamic = new DynamicHttp();
  const states = new Map<string, string>();
  const history: HistoryEntry[] = [];
  let rules = base;
  if (
    rules.some((rule) => rule.breakpoint) ||
    snapshot.scenes.some((scene) => scene.wsRules.some((rule) => rule.enabled))
  )
    throw new Error('Playwright adapter supports HTTP rules without interactive breakpoints.');
  dynamic.configure(rules);
  const pages = new WeakMap<Page, Promise<void>>();
  const attach = (page: Page) => {
    if (pages.has(page)) return;
    const ready = installHttp(
      context,
      page,
      () => ({ capture: true, mock: true, rules, states, dynamic }),
      (entry) => {
        history.push(entry);
        if (history.length > 128) history.shift();
      },
    );
    ready.catch(() => {});
    pages.set(page, ready);
  };
  context.on('page', attach);
  for (const page of context.pages()) attach(page);
  return {
    ready(page: Page) {
      attach(page);
      return pages.get(page)!;
    },
    history,
    override(extra: Rule[]) {
      const updated = validateRuleDocument({
        version: 1,
        rules: [...extra, ...base.filter((rule) => !extra.some((override) => override.id === rule.id))],
      }).rules;
      if (updated.some((rule) => rule.breakpoint))
        throw new Error('Interactive breakpoints are unsupported.');
      dynamic.configure(updated);
      const live = new Set(updated.flatMap((rule) => (rule.scenario ? [rule.scenario.id] : [])));
      for (const id of states.keys()) if (!live.has(id)) states.delete(id);
      rules = updated;
    },
  };
}

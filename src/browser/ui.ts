import type { Page, Locator } from 'playwright';
import { BrowserError } from './protocol';
import { webSelectorSchema, type WebSelector } from './ui-schema';
import { pause } from '../automation/model';

async function locator(page: Page, input: unknown): Promise<Locator> {
  const selector = webSelectorSchema.parse(input);
  let scope: any = page;
  if (selector.frame) {
    const frame = page.getByTestId(selector.frame.testId);
    const count = await frame.count();
    if (count !== 1)
      throw new BrowserError(
        count ? 'AMBIGUOUS_FRAME' : 'FRAME_NOT_FOUND',
        'Frame testId must resolve to one iframe.',
      );
    if (await frame.evaluate((el) => el.tagName !== 'IFRAME'))
      throw new BrowserError('FRAME_INVALID', 'Frame selector is not an iframe.');
    scope = frame.contentFrame();
  }
  return 'testId' in selector
    ? scope.getByTestId(selector.testId)
    : scope.getByRole(selector.role, { name: selector.name, exact: true });
}
async function unique(page: Page, selector: unknown) {
  const value = await locator(page, selector),
    count = await value.count();
  if (count !== 1)
    throw new BrowserError(
      count ? 'AMBIGUOUS_TARGET' : 'NOT_FOUND',
      `Expected one DOM target; found ${count}.`,
    );
  return value;
}
async function observation(value: Locator) {
  const count = await value.count();
  if (count > 1) throw new BrowserError('AMBIGUOUS_TARGET', `Found ${count} DOM targets.`);
  if (!count)
    return { code: 'NOT_FOUND', present: false, visible: false, enabled: false, actionable: false, text: '' };
  const visible = await value.isVisible(),
    enabled = await value.isEnabled();
  const detail = await value.evaluate((el) => {
    const box = el.getBoundingClientRect(),
      x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    const hit = el.ownerDocument.elementFromPoint(x, y);
    return { hit: !!hit && (el === hit || el.contains(hit)), text: el.textContent ?? '' };
  });
  return {
    code: 'OBSERVED',
    present: true,
    visible,
    enabled,
    actionable: visible && enabled && detail.hit,
    text: detail.text,
  };
}
export async function executeWebUi(page: Page, tool: string, args: any, signal: AbortSignal) {
  const started = performance.now(),
    timeout = args.timeoutMs ?? 5000;
  signal.throwIfAborted();
  const result = (extra: Record<string, unknown> = {}) => ({
    ok: true,
    backend: 'web',
    ...extra,
    timings: { totalMs: performance.now() - started },
  });
  if (tool === 'get_ui_snapshot') {
    const nodes = await page.locator('body *').evaluateAll(
      (elements, max) =>
        elements.slice(0, max).map((el) => {
          const r = el.getBoundingClientRect(),
            style = getComputedStyle(el);
          return {
            type: el.tagName.toLowerCase(),
            testId: el.getAttribute('data-testid') ?? undefined,
            role: el.getAttribute('role') ?? undefined,
            text: (el.textContent ?? '').slice(0, 256),
            visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden',
            enabled: !el.matches(':disabled'),
            bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
          };
        }),
      args.maxNodes ?? 200,
    );
    return result({ nodes, widgets: nodes, url: page.url() });
  }
  if (tool === 'take_screenshot') {
    const dimensions = await page.evaluate(
      (full) => ({
        width: full ? Math.max(document.documentElement.scrollWidth, innerWidth) : innerWidth,
        height: full ? Math.max(document.documentElement.scrollHeight, innerHeight) : innerHeight,
      }),
      args.mode === 'full_page',
    );
    if (
      dimensions.width > 16384 ||
      dimensions.height > 16384 ||
      dimensions.width * dimensions.height > 32_000_000
    )
      throw new BrowserError('SCREENSHOT_LIMIT', 'Screenshot exceeds 16384px or 32 million pixels.');
    const png = await page.screenshot({
      type: 'png',
      fullPage: args.mode === 'full_page',
      timeout,
      scale: 'css',
    });
    if (png.length > 12 * 1024 * 1024) throw new BrowserError('SCREENSHOT_LIMIT', 'PNG exceeds 12 MiB.');
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20);
    if (width > 16384 || height > 16384 || width * height > 32_000_000)
      throw new BrowserError('SCREENSHOT_LIMIT', 'Page dimensions changed beyond screenshot limit.');
    return result({
      width,
      height,
      mode: args.mode,
      source: 'web',
      image: { mimeType: 'image/png', data: png.toString('base64') },
    });
  }
  if (tool === 'press_key') {
    await page.keyboard.press([...(args.modifiers ?? []), args.keyName].join('+'));
    signal.throwIfAborted();
    return result({ inputMethod: 'browser-keyboard' });
  }
  if (tool === 'wait_for_widget') {
    const selector = webSelectorSchema.parse(args.selector),
      condition = args.state ?? 'present';
    const deadline = performance.now() + timeout;
    let attempts = 0,
      last: any = { code: 'NOT_FOUND' };
    do {
      signal.throwIfAborted();
      attempts++;
      last = await observation(await locator(page, selector));
      last.textMatches =
        condition === 'text_equals'
          ? last.text === args.text
          : condition === 'text_contains'
            ? last.text.includes(args.text)
            : condition === 'text_changed'
              ? last.text !== args.text
              : undefined;
      const matched =
        condition === 'absent'
          ? !last.present
          : condition.startsWith('text_')
            ? last.present && last.textMatches
            : last[condition];
      if (matched) return result({ condition, attempts });
      if (performance.now() >= deadline) break;
      await pause(Math.min(50, Math.max(1, deadline - performance.now())), signal);
    } while (true);
    const { text: _text, ...lastObservation } = last;
    return {
      ok: false,
      backend: 'web',
      code: 'WAIT_TIMEOUT',
      message: 'DOM condition was not met before the deadline.',
      diagnostics: { selector, condition, timeoutMs: timeout, attempts, lastObservation },
    };
  }
  const value = await unique(page, args.selector);
  if (tool === 'find_widget') return result({ selector: args.selector, ...(await observation(value)) });
  if (tool === 'tap' || tool === 'enter_text') {
    try {
      await value.click({ trial: true, timeout });
    } catch {
      throw new BrowserError('NOT_ACTIONABLE', 'DOM target is disabled, covered or not actionable.');
    }
    signal.throwIfAborted();
  }
  if (tool === 'tap') await value.click({ timeout });
  else if (tool === 'enter_text') {
    if (!(await value.isEditable())) throw new BrowserError('NOT_EDITABLE', 'DOM target is not editable.');
    const text = args.mode === 'append' ? (await value.inputValue()) + args.text : args.text;
    await value.fill(text, { timeout });
  } else if (tool === 'scroll') {
    const direction = args.direction ?? 'down',
      horizontal = direction === 'left' || direction === 'right',
      distance = (args.distance ?? 400) * (direction === 'up' || direction === 'left' ? -1 : 1);
    for (let step = 0; step < (args.targetSelector ? (args.maxSteps ?? 10) : 1); step++) {
      signal.throwIfAborted();
      const region = await unique(page, args.selector);
      const before = await region.evaluate(
        (el, h) => ({
          position: h ? el.scrollLeft : el.scrollTop,
          limit: h ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight,
          overflow: h ? getComputedStyle(el).overflowX : getComputedStyle(el).overflowY,
        }),
        horizontal,
      );
      if (before.limit <= 0 || !['auto', 'scroll', 'overlay'].includes(before.overflow))
        throw new BrowserError('NOT_SCROLLABLE', 'Selected region is not scrollable in this direction.');
      if ((distance > 0 && before.position >= before.limit) || (distance < 0 && before.position <= 0))
        throw new BrowserError('SCROLL_BOUNDARY', 'Selected region is at its boundary; no parent scrolling.');
      await region.scrollIntoViewIfNeeded({ timeout });
      const point = await region.evaluate((el, h) => {
        const r = el.getBoundingClientRect();
        for (const fx of [0.5, 0.15, 0.85])
          for (const fy of [0.5, 0.15, 0.85]) {
            const x = r.x + r.width * fx,
              y = r.y + r.height * fy;
            let hit = el.ownerDocument.elementFromPoint(x, y);
            if (!hit || !el.contains(hit)) continue;
            while (hit && hit !== el) {
              const style = getComputedStyle(hit);
              if (
                ['auto', 'scroll', 'overlay'].includes(h ? style.overflowX : style.overflowY) &&
                (h ? hit.scrollWidth > hit.clientWidth : hit.scrollHeight > hit.clientHeight)
              )
                break;
              hit = hit.parentElement;
            }
            if (hit === el) return { x, y };
          }
        return null;
      }, horizontal);
      if (!point)
        throw new BrowserError(
          'NOT_ACTIONABLE',
          'No unobscured pointer position belongs to the selected scroll region.',
        );
      const delta =
        Math.sign(distance) *
        Math.min(Math.abs(distance), distance > 0 ? before.limit - before.position : before.position);
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(horizontal ? delta : 0, horizontal ? 0 : delta);
      await region.evaluate(async (el, h) => {
        await new Promise<void>((resolve) => {
          let last = h ? el.scrollLeft : el.scrollTop,
            stable = 0,
            frames = 0;
          const tick = () => {
            const next = h ? el.scrollLeft : el.scrollTop;
            stable = next === last ? stable + 1 : 0;
            last = next;
            if (++frames >= 120 || stable >= 3) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      }, horizontal);
      if (!args.targetSelector) return result({ inputMethod: 'browser-wheel' });
      const found = await locator(page, args.targetSelector);
      if ((await found.count()) === 1 && (await found.isVisible()))
        return result({ inputMethod: 'browser-wheel' });
    }
    throw new BrowserError('SCROLL_TARGET_NOT_FOUND', 'Target was not found in the bounded selected region.');
  } else throw new BrowserError('TARGET_UNSUPPORTED', 'This browser UI operation is unsupported.');
  signal.throwIfAborted();
  return result({ inputMethod: tool === 'tap' ? 'browser-pointer' : 'browser-input' });
}

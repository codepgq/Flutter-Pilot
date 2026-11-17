import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Browser, BrowserServer, BrowserContext, Page } from 'playwright';
import { validateRuleDocument, type Rule, type HistoryEntry, type HistoryQuery } from '../model';
import { BrowserError, browserUrl, type BrowserContextState } from './protocol';
import { installHttp } from './interception';
import { executeWebUi } from './ui';
import { BrowserSockets } from './websocket';
import { validateWsRuleDocument } from '../ws/model';
import { trustedProfile } from './trust';
const token = process.env.FLUTTER_PILOT_BROWSER_TOKEN ?? '';
const generation = Number(process.env.FLUTTER_PILOT_BROWSER_GENERATION);
if (!token || !Number.isSafeInteger(generation) || !process.send)
  throw new Error('Worker requires authenticated parent IPC.');
interface Context {
  sockets: BrowserSockets;
  id: string;
  context: BrowserContext;
  pages: Map<string, Page>;
  ready: Map<Page, Promise<void>>;
  history: HistoryEntry[];
  historyBytes: number;
  capture: boolean;
  mock: boolean;
  rules: Rule[];
  states: Map<string, string>;
}
const contexts = new Map<string, Context>();
const pending = new Map<string, AbortController>();
let browser: Browser | undefined;
let browserServer: BrowserServer | undefined;
let launching: Promise<void> | undefined;
let trustedFingerprints: string[] = [];
let closing = false;
const clock = () => performance.timeOrigin + performance.now();
const send = (value: Record<string, unknown>) => {
  if (process.connected) process.send?.({ token, generation, ...value });
};
function state(c: Context): BrowserContextState {
  return {
    runtimeId: c.id,
    generation,
    backend: 'direct',
    trustedFingerprints,
    serviceWorkers: 'block',
    cache: 'routing_disables_http_cache',
    pages: [...c.pages].map(([pageId, page]) => ({ pageId, url: page.url() })),
  };
}
function save(c: Context, value: HistoryEntry, pageId?: string) {
  if (!contexts.has(c.id) || !c.capture) return;
  value.duration = clock() - value.startedAt;
  const record = { ...value, runtimeId: c.id, generation, pageId };
  c.history.unshift(record);
  c.historyBytes += Buffer.byteLength(JSON.stringify(record));
  while (c.history.length > 1000 || c.historyBytes > 32 * 1024 * 1024) {
    const removed = c.history.pop();
    if (removed) c.historyBytes -= Buffer.byteLength(JSON.stringify(removed));
    else break;
  }
  send({ event: 'http', runtimeId: c.id, pageId, entry: record });
}
async function dispatch(method: string, args: any, signal: AbortSignal) {
  signal.throwIfAborted();
  if (method === 'status')
    return {
      contexts: [...contexts.values()].map(state),
      pid: process.pid,
      browserPid: browserServer?.process().pid,
    };
  if (method === 'clock') return clock();
  if (method === 'create') {
    if ((browser || launching) && args.trustedCertificates?.length)
      throw new BrowserError(
        'TRUST_ALREADY_FIXED',
        'Certificate trust is fixed when the Worker browser starts. Close/recreate the Worker before changing trust.',
      );
    if (!browser) {
      launching ??= (async () => {
        const dependencyRoot = process.env.FLUTTER_PILOT_BROWSER_DEPENDENCIES!;
        const { chromium } = createRequire(join(dependencyRoot, 'package.json'))('playwright');
        const trust = args.trustedCertificates?.length
          ? await trustedProfile(args.trustedCertificates)
          : undefined;
        trustedFingerprints = trust?.fingerprints ?? [];
        browserServer = await chromium.launchServer({
          headless: args.headless ?? true,
          executablePath: process.env.FLUTTER_PILOT_BROWSER_EXECUTABLE,
          args: ['--disable-crash-reporter'],
          ...(trust
            ? {
                ignoreDefaultArgs: true,
                args: [
                  `--user-data-dir=${trust.profile}`,
                  '--remote-debugging-pipe',
                  '--no-first-run',
                  '--no-default-browser-check',
                  '--disable-crash-reporter',
                  '--password-store=basic',
                  '--use-mock-keychain',
                  '--disable-background-networking',
                  '--no-startup-window',
                  ...(args.headless === false ? [] : ['--headless=new']),
                ],
              }
            : {}),
        });
        send({ event: 'ownedProcess', pid: browserServer!.process().pid });
        browser = await chromium.connect(browserServer!.wsEndpoint());
        browser!.on('disconnected', () => {
          if (!closing) process.exit(1);
        });
      })();
      try {
        await launching;
      } finally {
        launching = undefined;
      }
    }
    const context = await browser!.newContext({ serviceWorkers: 'block' });
    const c: Context = {
      sockets: new BrowserSockets(send),
      id: randomUUID(),
      context,
      pages: new Map(),
      ready: new Map(),
      history: [],
      historyBytes: 0,
      capture: true,
      mock: false,
      rules: [],
      states: new Map(),
    };
    contexts.set(c.id, c);
    // Register before any page can navigate, including popups.
    context.on('page', (page) => {
      const id = randomUUID();
      c.pages.set(id, page);
      const ready = Promise.all([
        c.sockets.install(page, id, c.id, generation),
        installHttp(
          context,
          page,
          () => ({ capture: c.capture, mock: c.mock, rules: c.rules, states: c.states }),
          (value) => save(c, value, id),
        ),
      ]).then(() => {});
      c.ready.set(page, ready);
      ready.catch(() => {
        void page.close();
      });
      page.on('close', () => {
        c.pages.delete(id);
        c.ready.delete(page);
        send({ event: 'pages', runtimeId: c.id, state: state(c) });
      });
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) send({ event: 'pages', runtimeId: c.id, state: state(c) });
      });
      send({ event: 'pages', runtimeId: c.id, state: state(c) });
    });
    if (signal.aborted) {
      await context.close();
      contexts.delete(c.id);
      signal.throwIfAborted();
    }
    return state(c);
  }
  const target = args.target;
  if (target?.generation !== generation)
    throw new BrowserError('TARGET_STALE', 'Browser generation expired.');
  const c = contexts.get(target.runtimeId);
  if (!c) throw new BrowserError('TARGET_DISCONNECTED', 'Browser Context is closed.');
  if (method === 'close') {
    await c.context.close();
    contexts.delete(c.id);
    return { closed: true };
  }
  if (method === 'configure') {
    const rules = validateRuleDocument({ version: 1, rules: args.rules }).rules;
    if (rules.some((rule) => rule.breakpoint))
      throw new BrowserError(
        'TARGET_UNSUPPORTED',
        'Browser direct interception does not support interactive breakpoints.',
      );
    c.rules = rules;
    c.capture = args.capture;
    c.mock = args.mock;
    c.sockets.rules = validateWsRuleDocument({ version: 1, rules: args.wsRules ?? [] }).rules;
    c.sockets.capture = !!args.wsCapture;
    c.sockets.mock = !!args.wsCapture && !!args.wsMock;
    const live = new Set(rules.flatMap((rule) => (rule.scenario ? [rule.scenario.id] : [])));
    for (const id of c.states.keys()) if (!live.has(id)) c.states.delete(id);
    return { capture: c.capture, mock: c.mock };
  }
  if (method === 'ws.connections') return c.sockets.list();
  if (method === 'ws.messages') return c.sockets.history(args.query);
  if (method === 'ws.message') return c.sockets.get(args.id);
  if (method === 'ws.send' || method === 'ws.inject')
    return c.sockets.deliver(args.connectionId, args.text, method === 'ws.send' ? 'outbound' : 'inbound');
  if (method === 'history.list') {
    const q = args.query as HistoryQuery;
    const rows = c.history.filter(
      (row) =>
        (!q.method || row.method === q.method) &&
        (!q.host || row.host === q.host) &&
        (!q.path || row.path === q.path) &&
        (q.mocked === undefined || row.mocked === q.mocked) &&
        (!q.ruleId || row.requestRuleId === q.ruleId || row.responseRuleId === q.ruleId) &&
        (!q.from || row.startedAt >= q.from) &&
        (!q.to || row.startedAt <= q.to) &&
        (!q.status || row.response?.status === q.status) &&
        (!q.search || JSON.stringify(row).includes(q.search)),
    );
    return {
      items: rows.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 30)).map((row) => {
        const {
          originalRequest,
          automaticRequest,
          request,
          originalResponse,
          automaticResponse,
          response,
          ...summary
        } = row;
        return { ...summary, status: response?.status };
      }),
      total: rows.length,
    };
  }
  if (method === 'history.get') {
    const value = c.history.find((row) => row.id === args.id);
    if (!value) throw new BrowserError('NOT_FOUND', 'Request does not belong to this runtime.');
    return value;
  }
  if (method === 'open') {
    const page = await c.context.newPage();
    await c.ready.get(page);
    const pageId = [...c.pages].find(([, value]) => value === page)![0];
    if (args.url) await page.goto(browserUrl(args.url), { waitUntil: 'domcontentloaded', timeout: 30000 });
    signal.throwIfAborted();
    return { pageId, ...state(c) };
  }
  const page = c.pages.get(target.pageId);
  if (!page || page.isClosed())
    throw new BrowserError('PAGE_STALE', 'Page is closed or does not belong to the selected Context.');
  if (method === 'ui') return executeWebUi(page, args.tool, args.args, signal);
  if (method === 'navigate')
    await page.goto(browserUrl(args.url), { waitUntil: 'domcontentloaded', timeout: 30000 });
  else if (method === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  else if (method === 'page.close') await page.close();
  else throw new BrowserError('UNKNOWN_TOOL', 'Unknown browser operation.');
  signal.throwIfAborted();
  return state(c);
}
process.on('message', async (value: any) => {
  const supplied = Buffer.from(typeof value?.token === 'string' ? value.token : '');
  const expected = Buffer.from(token);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected) ||
    value.generation !== generation
  )
    return;
  if (value.cancel) {
    pending.get(value.cancel)?.abort();
    return;
  }
  if (typeof value.id !== 'string' || typeof value.method !== 'string') return;
  const controller = new AbortController();
  pending.set(value.id, controller);
  try {
    const result = await dispatch(value.method, value.args, controller.signal);
    send({ id: value.id, result });
  } catch (error) {
    send({
      id: value.id,
      error: {
        code:
          (error as BrowserError).code ??
          (controller.signal.aborted ? 'CANCELLED' : 'BROWSER_OPERATION_FAILED'),
        message: (error as Error).message,
        uncertain:
          controller.signal.aborted ||
          (!(error instanceof BrowserError) && ['open', 'navigate', 'reload', 'ui'].includes(value.method)),
      },
    });
  } finally {
    pending.delete(value.id);
  }
});
async function shutdown() {
  if (closing) return;
  closing = true;
  await browser?.close().catch(() => {});
  await browserServer?.close().catch(() => {});
  process.exit(0);
}
process.on('disconnect', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
send({ event: 'ready' });

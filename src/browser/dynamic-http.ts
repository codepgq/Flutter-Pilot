import { randomUUID, createHash } from 'node:crypto';
import jsonata from 'jsonata';
import type { RequestSnapshot, Rule } from '../model';
import { bodyLimit } from './http';

interface MockResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Store {
  key: string;
  state: unknown;
  startedAt: number;
}

function json(value: unknown) {
  const visit = (item: unknown, depth: number) => {
    if (depth > 32) throw new Error('JSON nesting exceeds 32.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || !item) throw new Error('Expected JSON data.');
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > bodyLimit) throw new Error('JSON exceeds 1 MiB.');
  return raw;
}

/** One transaction at a time across all pages owned by the Context. */
export class DynamicHttp {
  private stores = new Map<string, Store>();
  private rules = new Map<string, { store: Store; program: jsonata.Expression; source: string }>();
  private pending: Promise<unknown> = Promise.resolve();
  private queued = 0;

  constructor(private readonly now = Date.now) {}

  configure(rules: Rule[]) {
    const definitions = rules.filter((rule) => rule.enabled && rule.dynamic);
    const initial = new Map<string, string>();
    for (const { dynamic: spec } of definitions) {
      if (spec!.initial === undefined) continue;
      const seed = json(JSON.parse(spec!.initial));
      if (initial.has(spec!.store) && initial.get(spec!.store) !== seed)
        throw new Error(`Conflicting initial data for HTTP Mock store ${spec!.store}.`);
      initial.set(spec!.store, seed);
    }
    const stores = new Map<string, Store>();
    const programs = new Map<string, { store: Store; program: jsonata.Expression; source: string }>();
    for (const { id, dynamic: spec } of definitions) {
      const { store: name, expression, library } = spec!;
      if (!stores.has(name)) {
        const seed = initial.get(name) ?? '{}';
        const prior = this.stores.get(name);
        stores.set(
          name,
          prior?.key === seed ? prior : { key: seed, state: JSON.parse(seed), startedAt: this.now() },
        );
      }
      const store = stores.get(name)!;
      const source = library ? `(\n${library};\n${expression}\n)` : expression;
      const previous = this.rules.get(id);
      if (previous?.store === store && previous.source === source) {
        programs.set(id, previous);
        continue;
      }
      let program: jsonata.Expression;
      try {
        program = jsonata(source, {
          timeout: 500,
          stack: 300,
          sequence: 10000,
        });
        // Expressions operate solely on JSON and explicit pure helpers.
        program.assign('eval', null);
      } catch {
        throw new Error(`Invalid dynamic HTTP Mock expression in rule ${id}.`);
      }
      programs.set(id, { store, program, source });
    }
    this.rules = programs;
    this.stores = stores;
  }

  run<T>(id: string, request: RequestSnapshot, deliver: (mock: MockResult) => Promise<T>): Promise<T> {
    if (this.queued >= 128) return Promise.reject(new Error('Dynamic HTTP Mock queue is full.'));
    ++this.queued;
    const configured = this.rules.get(id);
    const task = this.pending.then(async () => {
      if (!configured || this.rules.get(id) !== configured)
        throw new Error(`Dynamic HTTP Mock rule ${id} changed before execution.`);
      const { store, program } = configured;
      const url = new URL(request.url);
      const headers = Object.fromEntries(request.headers.map(([key, value]) => [key.toLowerCase(), value]));
      let body: unknown = null;
      if (/^(?:application\/json|text\/json|[^;]+\+json)(?:\s*;|$)/i.test(headers['content-type'] ?? '')) {
        try {
          body = JSON.parse(request.body);
        } catch {
          // Rule can reply with the same 400 as the mocked API.
        }
      }
      let mock: MockResult;
      let next: unknown;
      try {
        const result = await program.evaluate(
          {
            request: {
              body,
              method: request.method,
              path: url.pathname,
              query: Object.fromEntries([...url.searchParams].reverse()),
              headers,
            },
            state: structuredClone(store.state),
            now: this.now(),
            startedAt: store.startedAt,
          },
          {
            uuid: () => randomUUID(),
            digest: (value: string) =>
              typeof value === 'string' ? createHash('sha256').update(value).digest('hex') : '',
          },
        );
        if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599)
          throw new Error('Expected a valid response status.');
        next = Object.hasOwn(result, 'state') ? JSON.parse(json(result.state)) : store.state;
        const text = typeof result.text === 'string';
        const content = text ? result.text : json(result.body);
        if (Buffer.byteLength(content) > bodyLimit) throw new Error('Response exceeds 1 MiB.');
        if (this.rules.get(id) !== configured) throw new Error('Rules changed during execution.');
        mock = {
          status: result.status,
          headers: {
            'content-type': text ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            ...(text
              ? { 'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" }
              : {}),
          },
          body: content,
        };
      } catch (error) {
        // Avoid including request data, passwords or tokens in evaluation diagnostics.
        const code =
          error && typeof error === 'object' && 'code' in error && /^[A-Z]\d{4}$/.test(String(error.code))
            ? ` (${String(error.code)})`
            : '';
        throw new Error(`Dynamic HTTP Mock rule ${id} failed${code}.`, { cause: error });
      }
      // Preserve Chromium cancellation diagnostics and only commit after successful delivery.
      const response = await deliver(mock);
      store.state = next;
      return response;
    });
    this.pending = task
      .catch(() => {})
      .finally(() => {
        --this.queued;
      });
    return task;
  }
}

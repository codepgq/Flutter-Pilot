import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bodyLimit } from '../src/browser/http';
import { startLocalMock } from '../src/browser/local-mock';
import type { Rule } from '../src/model';

const route: Rule = {
  id: 'login',
  name: 'Login',
  enabled: true,
  priority: 1,
  match: { method: 'POST', path: '/login-api', host: '127.0.0.1', bodyJson: { user: 'demo' } },
  dynamic: {
    store: 'demo',
    initial: '{"count":0}',
    expression: '($n := state.count+1; {"status":200,"body":{"count":$n},"state":{"count":$n}})',
  },
};
let upstream: string;
let base: string;
let mock: Awaited<ReturnType<typeof startLocalMock>>;
let hits: [string, number][];
let upstreamCalls: string[];
const backend = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  upstreamCalls.push(req.url!);
  if (req.url === '/redirect') return res.writeHead(302, { location: `${upstream}/login` }).end();
  res.writeHead(200, {
    'content-type': 'application/json',
    'set-cookie': 'service=not-for-chrome',
    'x-flutter-pilot-mock-rule': 'spoof',
  });
  res.end(JSON.stringify({ body, url: req.url, cookie: req.headers.cookie ?? null }));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  upstream = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});
beforeEach(async () => {
  hits = [];
  upstreamCalls = [];
  mock = await startLocalMock({
    upstream: `${upstream}/login`,
    rules: [route],
    onHit: (...args) => hits.push(args),
  });
  base = new URL(mock.url).origin;
});
afterEach(async () => mock.stop());
const login = (body = '{"user":"demo"}', headers = {}) =>
  fetch(`${base}/login-api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

it('shares state across parallel requests and reports rule hits without reaching the upstream', async () => {
  expect(new URL(mock.url).pathname).toBe('/login');
  const replies = await Promise.all([login(), login()]);
  for (const reply of replies) {
    expect(reply.status).toBe(200);
    expect(reply.headers.get('x-flutter-pilot-mock-rule')).toBe('login');
    expect(reply.headers.get('cache-control')).toBe('no-store');
  }
  const counts = await Promise.all(replies.map(async (reply) => (await reply.json()).count));
  expect(counts.sort()).toEqual([1, 2]);
  expect(hits).toEqual([
    ['login', 200],
    ['login', 200],
  ]);
  expect(upstreamCalls).toEqual([]);
});

it('retains unmatched body and query, rewrites upstream redirects, and isolates loopback cookies', async () => {
  const reply = await login('{"user":"other"}', { cookie: 'unrelated=value' });
  expect(await reply.json()).toEqual({ body: '{"user":"other"}', url: '/login-api', cookie: null });
  expect(reply.headers.has('set-cookie')).toBe(false);
  expect(reply.headers.has('x-flutter-pilot-mock-rule')).toBe(false);
  expect((await (await fetch(`${base}/asset.js?v=2`)).json()).url).toBe('/asset.js?v=2');
  const redirect = await fetch(`${base}/redirect`, { redirect: 'manual' });
  expect(redirect.headers.get('location')).toBe(`${base}/login`);
  expect(hits).toEqual([]);
});

it('rejects foreign origins, forged Host, and out-of-scope upstreams without touching state', async () => {
  expect((await login(undefined, { origin: 'http://localhost:9999' })).status).toBe(403);
  expect((await login(undefined, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
  const address = new URL(base);
  const status = await new Promise((resolve, reject) => {
    request({ hostname: address.hostname, port: address.port, headers: { host: 'other.test' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    })
      .on('error', reject)
      .end();
  });
  expect(status).toBe(400);
  await expect(startLocalMock({ upstream: 'https://localhost:3000', rules: [route] })).rejects.toThrow(
    '本机 HTTP',
  );
  await expect(startLocalMock({ upstream: 'http://example.test', rules: [route] })).rejects.toThrow(
    '本机 HTTP',
  );
  expect((await (await login()).json()).count).toBe(1);
});

it('bounds matching request bodies, isolates runtimes and stops without leaving a listener', async () => {
  expect((await login('x'.repeat(bodyLimit + 1))).status).toBe(413);
  expect((await (await login()).json()).count).toBe(1);
  const other = await startLocalMock({ upstream, rules: [route] });
  try {
    const reply = await fetch(`${other.url}login-api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"user":"demo"}',
    });
    expect((await reply.json()).count).toBe(1);
    expect((await (await login()).json()).count).toBe(2);
  } finally {
    await other.stop();
  }
  await mock.stop();
  await expect(fetch(`${base}/login`)).rejects.toThrow();
});

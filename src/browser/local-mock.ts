import { createServer, request, validateHeaderName, validateHeaderValue } from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Rule } from '../model';
import { DynamicHttp } from './dynamic-http';
import { bodyLimit, bodySnapshot, matchesHttp, selectHttp } from './http';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const hopByHop = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function end(response: ServerResponse, status: number, text: string) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(text);
}

function forwardHeaders(raw: IncomingMessage['headers']): OutgoingHttpHeaders {
  const headers = { ...raw };
  const blocked =
    raw.connection
      ?.toLowerCase()
      .split(',')
      .map((part) => part.trim()) ?? [];
  for (const name of [...hopByHop, ...blocked]) delete headers[name];
  return headers;
}

function deliver(response: ServerResponse, method: string, mock: NonNullable<Rule['mock']>) {
  if (response.destroyed) return Promise.reject(new Error('Client disconnected.'));
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(mock.headers)) {
    const lower = name.toLowerCase();
    if (
      !hopByHop.includes(lower) &&
      !['content-length', 'content-encoding', 'set-cookie', 'x-flutter-pilot-mock-rule'].includes(lower)
    ) {
      validateHeaderName(lower);
      validateHeaderValue(lower, value);
      headers[lower] = value;
    }
  }
  headers['cache-control'] = 'no-store';
  const noBody = [204, 205, 304].includes(mock.status);
  if (!noBody) headers['content-length'] = Buffer.byteLength(mock.body);
  return new Promise<void>((resolve, reject) => {
    const aborted = () => reject(new Error('Client disconnected.'));
    response.once('close', aborted);
    response.writeHead(mock.status, headers);
    response.end(noBody || method === 'HEAD' ? undefined : mock.body, () => {
      response.off('close', aborted);
      resolve();
    });
  });
}

/** Explicit, project-local HTTP reverse gateway; never a general-purpose browser proxy. */
export async function startLocalMock(options: {
  upstream: string;
  rules: Rule[];
  onHit?: (rule: string, status: number) => void;
  onFailure?: (rule: string) => void;
}) {
  const upstream = new URL(options.upstream);
  if (
    upstream.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(upstream.hostname) ||
    upstream.username ||
    upstream.password
  )
    throw new Error('普通浏览器 HTTP Mock 只支持无凭证的本机 HTTP 启动 URL。');
  const rules = structuredClone(options.rules.filter((rule) => rule.enabled));
  if (
    !rules.length ||
    rules.some(
      ({ mock, dynamic, breakpoint, request, redirect, response }) =>
        (!mock && !dynamic) || breakpoint || request || redirect || response,
    )
  )
    throw new Error('请选择包含静态或动态直接响应的 Scene；不支持断点、重定向或请求/响应改写。');
  const dynamic = new DynamicHttp();
  dynamic.configure(rules);
  const states = new Map<string, string>();
  const ruleHost = upstream.hostname;
  const dialHost = ruleHost === 'localhost' ? '127.0.0.1' : ruleHost.replace(/^\[|\]$/g, '');
  let origin: string;
  const server = createServer({ headersTimeout: 10_000, requestTimeout: 30_000 }, (incoming, response) => {
    void handle(incoming, response).catch(() => {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else end(response, 502, 'Flutter Pilot: local HTTP Mock request failed.');
    });
  });
  server.maxConnections = 128;
  server.setTimeout(30_000, (socket) => socket.destroy());
  async function handle(incoming: IncomingMessage, response: ServerResponse) {
    const method = incoming.method ?? 'GET';
    const path = incoming.url ?? '';
    if (incoming.headers.host !== new URL(origin).host || !/^\/(?!\/)/.test(path) || path.includes('\\')) {
      end(response, 400, 'Flutter Pilot: invalid local gateway request.');
      return;
    }
    const browserOrigin = incoming.headers.origin;
    const foreign = ['cross-site', 'same-site'].includes(incoming.headers['sec-fetch-site'] ?? '');
    const navigation =
      incoming.headers['sec-fetch-mode'] === 'navigate' && incoming.headers['sec-fetch-dest'] === 'document';
    if (
      (browserOrigin !== undefined && browserOrigin !== origin) ||
      (foreign && (!navigation || !safeMethods.has(method)))
    ) {
      end(response, 403, 'Flutter Pilot: foreign origin.');
      return;
    }
    const url = new URL(path, upstream.origin);
    if (url.origin !== upstream.origin) {
      end(response, 400, 'Flutter Pilot: invalid upstream path.');
      return;
    }
    const pairs: [string, string][] = [];
    for (let i = 0; i < incoming.rawHeaders.length; i += 2)
      if (incoming.rawHeaders[i].toLowerCase() !== 'cookie')
        pairs.push([incoming.rawHeaders[i], incoming.rawHeaders[i + 1]]);
    const snapshot = (body: Buffer, limitation?: string) => ({
      ...bodySnapshot(pairs, body, limitation),
      url: url.href,
      method,
    });
    const empty = snapshot(Buffer.alloc(0));
    const candidate = rules.some((rule) =>
      matchesHttp(
        { ...rule, scenario: undefined, match: { ...rule.match, bodyJson: undefined, bodyRegex: undefined } },
        empty,
        states,
      ),
    );
    if (!candidate) return forward();
    if (foreign) {
      end(response, 403, 'Flutter Pilot: foreign navigation cannot trigger a Mock rule.');
      return;
    }
    if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity')
      return forward();
    if (Number(incoming.headers['content-length']) > bodyLimit) {
      response.setHeader('connection', 'close');
      end(response, 413, 'Flutter Pilot: HTTP Mock request body exceeds 1 MiB.');
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    // Do not destroy the socket when leaving iteration early: first send the bounded error.
    for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
      const data = Buffer.from(chunk);
      bytes += data.length;
      if (bytes > bodyLimit) {
        response.setHeader('connection', 'close');
        end(response, 413, 'Flutter Pilot: HTTP Mock request body exceeds 1 MiB.');
        return;
      }
      chunks.push(data);
    }
    const body = Buffer.concat(chunks, bytes);
    const original = snapshot(body);
    const rule = original.editable ? selectHttp(rules, original, 'request', states) : undefined;
    if (!rule) return forward(body);
    try {
      const send = async (mock: NonNullable<Rule['mock']>) => {
        response.setHeader('x-flutter-pilot-mock-rule', rule.id);
        await deliver(response, method, mock);
        if (rule.scenario?.next) states.set(rule.scenario.id, rule.scenario.next);
        options.onHit?.(rule.id, mock.status);
      };
      if (rule.dynamic) await dynamic.run(rule.id, original, send);
      else await send(rule.mock!);
    } catch {
      options.onFailure?.(rule.id);
      throw new Error('Mock delivery failed.');
    }

    function forward(body?: Buffer) {
      const headers = forwardHeaders(incoming.headers);
      delete headers.cookie;
      headers.host = upstream.host;
      if (browserOrigin === origin) headers.origin = upstream.origin;
      if (body) headers['content-length'] = body.length;
      const upstreamRequest = request(
        {
          method,
          hostname: dialHost,
          port: upstream.port || 80,
          path: `${url.pathname}${url.search}`,
          headers,
          timeout: 25_000,
        },
        (reply) => {
          const replyHeaders = forwardHeaders(reply.headers);
          delete replyHeaders['x-flutter-pilot-mock-rule'];
          delete replyHeaders['set-cookie'];
          if (typeof replyHeaders.location === 'string') {
            try {
              const redirect = new URL(replyHeaders.location, upstream.origin);
              if (redirect.origin === upstream.origin)
                replyHeaders.location = `${origin}${redirect.pathname}${redirect.search}${redirect.hash}`;
            } catch {
              // Do not rewrite a Location value that cannot be parsed.
            }
          }
          reply.once('error', () => response.destroy());
          response.writeHead(reply.statusCode ?? 502, replyHeaders);
          reply.pipe(response);
        },
      );
      upstreamRequest.once('timeout', () => upstreamRequest.destroy(new Error('Upstream timeout.')));
      upstreamRequest.once('error', () => {
        if (response.destroyed) return;
        if (response.headersSent) response.destroy();
        else end(response, 502, 'Flutter Pilot: cannot reach the configured local development server.');
      });
      response.once('close', () => upstreamRequest.destroy());
      if (body) upstreamRequest.end(body);
      else incoming.pipe(upstreamRequest);
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Local gateway has no port.'));
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let closing: Promise<void> | undefined;
  return {
    url: `${origin!}${upstream.pathname}${upstream.search}${upstream.hash}`,
    stop: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      })),
  };
}

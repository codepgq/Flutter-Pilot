import { globRegex } from '../glob';
import {
  fullBodyRegex,
  type Rule,
  type RequestSnapshot,
  type ResponseSnapshot,
  type HistoryEntry,
  type HeaderPatch,
} from '../model';
import { randomUUID } from 'node:crypto';
export const bodyLimit = 1024 * 1024;
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function jsonEquals(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => jsonEquals(actual[index], value))
    );
  }
  if (isObject(expected)) {
    return (
      isObject(actual) &&
      Object.keys(actual).length === Object.keys(expected).length &&
      matchesFields(actual, expected)
    );
  }
  return actual === expected;
}
function matchesFields(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(
    ([key, value]) => Object.hasOwn(actual, key) && jsonEquals(actual[key], value),
  );
}
function matchesBody(request: RequestSnapshot, { bodyJson, bodyRegex }: Rule['match']) {
  if (!bodyJson && !bodyRegex) return true;
  if (!request.editable || request.truncated || request.bodyEncoding !== 'text') return false;
  const mime = request.headers
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!mime || !(mime === 'application/json' || mime === 'text/json' || mime.endsWith('+json'))) return false;
  try {
    const actual: unknown = JSON.parse(request.body);
    return (
      isObject(actual) &&
      matchesFields(actual, bodyJson ?? {}) &&
      Object.entries(bodyRegex ?? {}).every(([key, pattern]) => {
        const value = actual[key];
        return Object.hasOwn(actual, key) && typeof value === 'string' && fullBodyRegex(pattern).test(value);
      })
    );
  } catch {
    return false;
  }
}
export function matchesHttp(rule: Rule, request: RequestSnapshot, states: Map<string, string>) {
  const match = rule.match,
    url = new URL(request.url);
  if (rule.scenario && (states.get(rule.scenario.id) ?? rule.scenario.initial) !== rule.scenario.when)
    return false;
  return (
    (!match.method || match.method === '*' || match.method.toUpperCase() === request.method.toUpperCase()) &&
    (!match.host || match.host === '*' || match.host.toLowerCase() === url.hostname.toLowerCase()) &&
    (!match.path || new RegExp(globRegex(match.path)).test(url.pathname)) &&
    Object.entries(match.query ?? {}).every(([key, value]) => url.searchParams.getAll(key).includes(value)) &&
    Object.entries(match.headers ?? {}).every(([key, value]) =>
      request.headers.some(([name, text]) => name.toLowerCase() === key.toLowerCase() && text === value),
    ) &&
    matchesBody(request, match)
  );
}
export function selectHttp(
  rules: Rule[],
  request: RequestSnapshot,
  stage: 'request' | 'response',
  states: Map<string, string>,
) {
  return rules
    .filter(
      (rule) =>
        rule.enabled &&
        matchesHttp(rule, request, states) &&
        (stage === 'request' ? rule.request || rule.redirect || rule.mock : rule.response),
    )
    .sort((a, b) => b.priority - a.priority)[0];
}
export function patchHeaders(headers: [string, string][], patch: HeaderPatch = {}) {
  const result = headers.filter(
    ([key]) => !Object.keys(patch).some((name) => name.toLowerCase() === key.toLowerCase()),
  );
  for (const [key, value] of Object.entries(patch)) if (value !== null) result.push([key, value]);
  return result;
}
export function bodySnapshot(headers: [string, string][], body: Buffer, limitation?: string) {
  const type = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  const binary = !!type && !/json|text|xml|javascript|x-www-form-urlencoded/i.test(type);
  const truncated = body.length > bodyLimit;
  return {
    headers,
    body: body.subarray(0, bodyLimit).toString(binary ? 'base64' : 'utf8'),
    bodyEncoding: binary ? ('base64' as const) : ('text' as const),
    bodyBytes: body.length,
    truncated,
    editable: !binary && !truncated && !limitation,
    ...(limitation ? { limitation } : {}),
  };
}
export function entry(request: RequestSnapshot, startedAt: number): HistoryEntry {
  const url = new URL(request.url);
  return {
    id: randomUUID(),
    startedAt,
    duration: 0,
    method: request.method,
    host: url.hostname,
    path: url.pathname,
    url: url.href,
    targetUrl: url.href,
    originalRequest: structuredClone(request),
    automaticRequest: structuredClone(request),
    request: structuredClone(request),
    mocked: false,
    note: '',
    tags: [],
  };
}
export function patchRequest(original: RequestSnapshot, rule?: Rule): RequestSnapshot {
  const request = structuredClone(original),
    patch = rule?.request;
  if (patch?.method) request.method = patch.method;
  const url = new URL(rule?.redirect?.url ?? patch?.url ?? request.url, request.url);
  for (const [key, value] of Object.entries(patch?.query ?? {})) {
    url.searchParams.delete(key);
    if (value !== null) url.searchParams.append(key, value);
  }
  request.url = url.href;
  if (new URL(original.url).origin !== url.origin)
    request.headers = request.headers.filter(
      ([key]) => !['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase()),
    );
  request.headers = patchHeaders(request.headers, patch?.headers).filter(
    ([key]) => !['host', 'content-length'].includes(key.toLowerCase()),
  );
  if (patch?.body !== undefined) {
    request.body = patch.body;
    request.bodyBytes = Buffer.byteLength(patch.body);
  }
  return request;
}
export function patchResponse(original: ResponseSnapshot, rule?: Rule): ResponseSnapshot {
  const patch = rule?.response;
  return {
    ...original,
    status: patch?.status ?? original.status,
    headers: patchHeaders(original.headers, patch?.headers),
    ...(patch?.body !== undefined
      ? { body: patch.body, bodyBytes: Buffer.byteLength(patch.body), bodyEncoding: 'text' as const }
      : {}),
  };
}

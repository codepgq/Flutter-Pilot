import { globRegex } from '../glob';
import type { Rule, RequestSnapshot, ResponseSnapshot, HistoryEntry, HeaderPatch } from '../model';
import { randomUUID } from 'node:crypto';
export const bodyLimit = 1024 * 1024;
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
    )
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
  const binary = !!type && !/json|text|xml|javascript|x-www-form-urlencoded/.test(type);
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

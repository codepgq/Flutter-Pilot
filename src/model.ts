export type HeaderPatch = Record<string, string | null>;
export interface Match {
  method?: string;
  host?: string;
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}
export interface RequestPatch {
  method?: string;
  url?: string;
  headers?: HeaderPatch;
  query?: HeaderPatch;
  body?: string;
}
export interface ResponsePatch {
  status?: number;
  headers?: HeaderPatch;
  body?: string;
}
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: Match;
  request?: RequestPatch;
  redirect?: { url: string };
  mock?: { status: number; headers: Record<string, string>; body: string };
  response?: ResponsePatch;
  breakpoint?: { request?: boolean; response?: boolean; timeout?: number };
}
export interface RuleDocument {
  version: 1;
  rules: Rule[];
}
export interface BodySnapshot {
  headers: [string, string][];
  body: string;
  bodyEncoding: 'text' | 'base64';
  bodyBytes: number;
  truncated: boolean;
  editable: boolean;
  limitation?: string;
}
export interface RequestSnapshot extends BodySnapshot {
  method: string;
  url: string;
}
export interface ResponseSnapshot extends BodySnapshot {
  status: number;
}
export interface HistoryEntry {
  source?: 'proxy' | 'vm' | 'vm-dio';
  id: string;
  startedAt: number;
  duration: number;
  method: string;
  host: string;
  path: string;
  url: string;
  targetUrl: string;
  originalRequest: RequestSnapshot;
  request: RequestSnapshot;
  automaticRequest?: RequestSnapshot;
  originalResponse?: ResponseSnapshot;
  response?: ResponseSnapshot;
  automaticResponse?: ResponseSnapshot;
  requestRuleId?: string;
  responseRuleId?: string;
  mocked: boolean;
  error?: string;
  note: string;
  tags: string[];
}
export interface HistoryQuery {
  host?: string;
  path?: string;
  search?: string;
  method?: string;
  status?: number;
  mocked?: boolean;
  ruleId?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}
export interface HistoryResult {
  items: HistoryEntry[];
  total: number;
}
export interface PendingBreakpoint {
  id: string;
  flowId: string;
  stage: 'request' | 'response';
  expiresAt: number;
  original: RequestSnapshot | ResponseSnapshot;
  current: RequestSnapshot | ResponseSnapshot;
}
export interface ApiCatalogEntry {
  method: string;
  host: string;
  path: string;
  count: number;
  firstAt?: number;
  lastAt: number;
}
export interface WorkbenchState {
  mcp?: import('./mcp/model').McpWorkbenchState;
  vmDiscovery?: {
    enabled: boolean;
    status: 'waiting' | 'ready' | 'unavailable';
    message?: string;
    candidates: {
      id: string;
      name: string;
      device?: string;
      endpoint: string;
      source: 'debug-event' | 'dtd';
      status: 'available' | 'connecting' | 'connected' | 'paused' | 'failed';
      error?: string;
    }[];
    connectedSessionId?: string;
  };
  ws?: import('./ws/model').WsState;
  project?: {
    id: string;
    name: string;
    configPath: string;
    rulesPath: string;
    notice?: string;
  };
  mode?: 'proxy' | 'vm';
  vm?: {
    captureEnabled?: boolean;
    status: 'disconnected' | 'connecting' | 'connected';
    endpoint?: string;
    isolates: number;
    recorded: number;
    instances: number;
    mockEnabled: boolean;
    warnings: string[];
    error?: string;
  };
  rules: Rule[];
  history: HistoryResult;
  apis?: ApiCatalogEntry[];
  pending: PendingBreakpoint[];
  engine: { status: string; proxyPort?: number; listenHost?: string; caCertPath?: string; error?: string };
  proxyActive: boolean;
  lan: boolean;
  addresses: { label: string; host: string }[];
  devices: {
    id?: string;
    serial?: string;
    name?: string;
    platform?: string;
    kind?: string;
    state?: string;
    [key: string]: unknown;
  }[];
  connectionHost: string;
  workspace: string;
  logs: string[];
  busy: boolean;
  lastError?: string;
  setup?: unknown;
  ruleSyncError?: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function fields(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) assert(allowed.includes(key), `${label} 包含未知字段 ${key}`);
}
function stringMap(value: unknown, label: string, nullable = false) {
  assert(object(value), `${label} 必须是键值对象`);
  for (const [key, v] of Object.entries(value)) {
    assert(key.length > 0 && !/[\r\n]/.test(key), `${label} 的键不能为空或包含换行`);
    assert(
      typeof v === 'string' || (nullable && v === null),
      `${label}.${key} 必须是字符串${nullable ? '或 null' : ''}`,
    );
    if (typeof v === 'string') assert(!/[\r\n]/.test(v), `${label}.${key} 不能包含换行`);
  }
}
function url(value: unknown, label: string) {
  assert(typeof value === 'string' && !/\s/.test(value), `${label} 必须是不含空白字符的字符串`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} 必须是完整 HTTP/HTTPS 地址`);
  }
  assert(
    ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password,
    `${label} 仅支持不含内嵌凭证的 HTTP/HTTPS 地址`,
  );
}
function redirectUrl(value: unknown) {
  assert(
    typeof value === 'string' && value.length > 0 && !/[\s\x00-\x1f\x7f\\#]/.test(value),
    'redirect.url 必须为不含空白、控制字符、反斜杠或 fragment 的路径或 HTTP/HTTPS 地址',
  );
  if (value.startsWith('/')) {
    assert(!value.startsWith('//'), 'redirect.url 路径必须以单个 / 开头');
    return;
  }
  assert(/^https?:\/\/[^/]+/i.test(value), 'redirect.url 必须为 /path 或完整 HTTP/HTTPS 地址');
  const authority = value.slice(value.indexOf('://') + 3).split(/[/?]/)[0];
  assert(!authority.includes('@'), 'redirect.url 不能包含内嵌凭证');
  url(value, 'redirect.url');
}
function status(value: unknown) {
  assert(
    typeof value === 'number' && Number.isInteger(value) && value >= 200 && value <= 599,
    '响应状态码必须为 200–599 的整数',
  );
}
function patch(value: unknown, label: 'request' | 'response') {
  assert(object(value), `${label} 必须为对象`);
  fields(
    value,
    label === 'request' ? ['method', 'url', 'headers', 'query', 'body'] : ['status', 'headers', 'body'],
    label,
  );
  if (value.headers !== undefined) stringMap(value.headers, `${label}.headers`, true);
  if (value.query !== undefined) stringMap(value.query, `${label}.query`, true);
  if (value.body !== undefined)
    assert(typeof value.body === 'string', `${label}.body 必须为字符串，JSON 请先序列化`);
  if (value.url !== undefined) url(value.url, `${label}.url`);
  if (value.method !== undefined)
    assert(typeof value.method === 'string' && /^[A-Za-z]+$/.test(value.method), '请求方法无效');
  if (value.status !== undefined) status(value.status);
}
export function validateRuleDocument(input: unknown): RuleDocument {
  assert(object(input), '规则文件必须为对象');
  fields(input, ['version', 'rules'], '规则文件');
  assert(input.version === 1, '不支持的规则文件版本，仅支持 version: 1');
  assert(Array.isArray(input.rules), 'rules 必须是数组');
  assert(input.rules.length <= 1000, '规则最多 1000 条');
  const ids = new Set<string>();
  for (const [index, item] of input.rules.entries()) {
    assert(object(item), `第 ${index + 1} 条规则必须是对象`);
    fields(
      item,
      ['id', 'name', 'enabled', 'priority', 'match', 'request', 'redirect', 'mock', 'response', 'breakpoint'],
      '规则',
    );
    assert(typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128, '规则 ID 无效');
    assert(!ids.has(item.id), '规则 ID 重复');
    ids.add(item.id);
    assert(typeof item.name === 'string' && item.name.trim().length > 0, '规则名称不能为空');
    assert(typeof item.enabled === 'boolean', 'enabled 必须是布尔值');
    assert(typeof item.priority === 'number' && Number.isSafeInteger(item.priority), 'priority 必须是整数');
    assert(object(item.match), 'match 必须为对象');
    fields(item.match, ['method', 'host', 'path', 'query', 'headers'], 'match');
    for (const key of ['method', 'host', 'path'])
      if (item.match[key] !== undefined)
        assert(typeof item.match[key] === 'string', `match.${key} 必须是字符串`);
    if (item.match.query !== undefined) stringMap(item.match.query, 'match.query');
    if (item.match.headers !== undefined) stringMap(item.match.headers, 'match.headers');
    if (item.request !== undefined) patch(item.request, 'request');
    if (item.response !== undefined) patch(item.response, 'response');
    if (item.redirect !== undefined) {
      assert(object(item.redirect), 'redirect 必须为对象');
      fields(item.redirect, ['url'], 'redirect');
      redirectUrl(item.redirect.url);
    }
    if (item.mock !== undefined) {
      assert(object(item.mock), 'mock 必须为对象');
      fields(item.mock, ['status', 'headers', 'body'], 'mock');
      status(item.mock.status);
      stringMap(item.mock.headers, 'mock.headers');
      assert(typeof item.mock.body === 'string', 'mock.body 必须为字符串');
    }
    assert(!(item.mock !== undefined && item.redirect !== undefined), '同一规则不能同时直接 Mock 和转发');
    if (item.breakpoint !== undefined) {
      assert(object(item.breakpoint), 'breakpoint 必须为对象');
      fields(item.breakpoint, ['request', 'response', 'timeout'], 'breakpoint');
      assert(
        item.breakpoint.request === true || item.breakpoint.response === true,
        '断点必须选择请求或响应阶段',
      );
      for (const key of ['request', 'response'])
        if (item.breakpoint[key] !== undefined)
          assert(typeof item.breakpoint[key] === 'boolean', `breakpoint.${key} 必须是布尔值`);
      if (item.breakpoint.timeout !== undefined)
        assert(
          typeof item.breakpoint.timeout === 'number' &&
            Number.isInteger(item.breakpoint.timeout) &&
            item.breakpoint.timeout >= 10 &&
            item.breakpoint.timeout <= 300,
          '断点超时必须为 10–300 秒',
        );
    }
    assert(
      item.request !== undefined ||
        item.response !== undefined ||
        item.mock !== undefined ||
        item.redirect !== undefined ||
        (object(item.breakpoint) && (item.breakpoint.request || item.breakpoint.response)),
      '规则至少需要一个动作',
    );
  }
  return JSON.parse(JSON.stringify(input)) as RuleDocument;
}
export function ruleFromHistory(
  entry: HistoryEntry,
  kind: 'mock' | 'request' | 'response' | 'redirect',
  id: string,
): Rule {
  const rule: Rule = {
    id,
    name: `${entry.method} ${entry.path}`,
    enabled: false,
    priority: 0,
    match: { method: entry.method, host: entry.host, path: entry.path },
  };
  const headers = (pairs: [string, string][]) =>
    Object.fromEntries(
      pairs.filter(
        ([k]) =>
          ![
            'authorization',
            'cookie',
            'set-cookie',
            'proxy-authorization',
            'content-length',
            'transfer-encoding',
            'content-encoding',
            'host',
          ].includes(k.toLowerCase()),
      ),
    );
  if (kind === 'mock') {
    const r = entry.response;
    rule.mock = {
      status: r?.status ?? 200,
      headers: headers(r?.headers ?? [['content-type', 'application/json']]),
      body: r?.editable ? r.body : '{}',
    };
  }
  if (kind === 'response') {
    const r = entry.response;
    rule.response = {
      status: r?.status ?? 200,
      headers: headers(r?.headers ?? []),
      ...(r?.editable ? { body: r.body } : {}),
    };
  }
  if (kind === 'request')
    rule.request = {
      method: entry.request.method,
      headers: headers(entry.request.headers),
      ...(entry.request.editable ? { body: entry.request.body } : {}),
    };
  if (kind === 'redirect') rule.redirect = { url: entry.targetUrl || entry.url };
  return rule;
}

/** Submit only edited header fields so untouched duplicate headers survive. */
export function headerChanges(
  original: [string, string][],
  edited: Record<string, string | null>,
): HeaderPatch {
  const before = new Map<string, { name: string; value: string }>();
  for (const [name, value] of original) before.set(name.toLowerCase(), { name, value });
  const after = new Map(Object.entries(edited).map(([name, value]) => [name.toLowerCase(), { name, value }]));
  const patch: HeaderPatch = {};
  for (const [key, item] of after) if (before.get(key)?.value !== item.value) patch[item.name] = item.value;
  for (const [key, item] of before) if (!after.has(key)) patch[item.name] = null;
  return patch;
}

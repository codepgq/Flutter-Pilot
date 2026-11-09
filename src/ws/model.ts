import type { HistoryEntry } from '../model';

export type WsDirection = 'outbound' | 'inbound';
export interface WsConnection {
  id: string;
  isolateId: string;
  endpoint: string;
  url?: string;
  status: 'open' | 'closed' | 'disconnected';
  capture: 'attached' | 'unsupported';
  openedAt: number;
  closedAt?: number;
  sent: number;
  received: number;
  warning?: string;
  handshake?: HistoryEntry;
}
export interface WsMessage {
  id: string;
  connectionId: string;
  timestamp: number;
  direction: WsDirection;
  kind: 'text' | 'binary';
  original: string;
  effective?: string;
  encoding: 'text' | 'base64';
  bytes: number;
  truncated: boolean;
  outcome: 'original' | 'replaced' | 'dropped' | 'synthetic';
  ruleId?: string;
}
export interface WsMessageSummary extends Omit<WsMessage, 'original' | 'effective'> {
  preview: string;
}
export interface WsMessageQuery {
  connectionId?: string;
  direction?: WsDirection;
  search?: string;
  limit?: number;
  offset?: number;
}
export interface WsMessageResult {
  items: WsMessageSummary[];
  total: number;
}
export interface WsRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: {
    url?: string;
    connectionId?: string;
    direction?: WsDirection;
    contains?: string;
  };
  action: { type: 'replace' | 'drop'; text?: string };
}
export interface WsRuleDocument {
  version: 1;
  rules: WsRule[];
}
export interface WsHandshake {
  isolateId: string;
  url: string;
  localPort: number;
  remotePort: number;
  remoteAddress: string;
  timestamp: number;
  entry?: HistoryEntry;
}
export interface WsState {
  captureEnabled: boolean;
  mockEnabled: boolean;
  status: 'off' | 'active' | 'unsupported' | 'error';
  connections: WsConnection[];
  messages: WsMessageResult;
  rules: WsRule[];
  omitted: number;
  warnings: string[];
  error?: string;
  ruleSyncError?: string;
}

const maxDocumentBytes = 2 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function fields(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) assert(allowed.includes(key), `${label} 包含未知字段 ${key}`);
}
function nonempty(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

/** Validate both persistent URL rules and session-only connection rules. */
export function validateWsRuleDocument(input: unknown, allowTemporary = true): WsRuleDocument {
  assert(object(input), 'WS 规则文件必须为对象');
  fields(input, ['version', 'rules'], 'WS 规则文件');
  assert(input.version === 1, 'WS 规则仅支持 version: 1');
  assert(Array.isArray(input.rules) && input.rules.length <= 1000, 'WS 规则必须为数组，最多 1000 条');
  const ids = new Set<string>();
  for (const rule of input.rules) {
    assert(object(rule), 'WS 规则必须为对象');
    fields(rule, ['id', 'name', 'enabled', 'priority', 'match', 'action'], 'WS 规则');
    assert(nonempty(rule.id, 128) && !ids.has(rule.id), 'WS 规则 ID 无效或重复');
    ids.add(rule.id);
    assert(nonempty(rule.name), 'WS 规则名称不能为空，最多 256 字符');
    assert(typeof rule.enabled === 'boolean', 'WS 规则 enabled 必须是布尔值');
    assert(Number.isSafeInteger(rule.priority), 'WS 规则 priority 必须是安全整数');
    assert(object(rule.match), 'WS 规则 match 必须为对象');
    fields(rule.match, ['url', 'connectionId', 'direction', 'contains'], 'WS 规则 match');
    const hasUrl = rule.match.url !== undefined;
    const hasConnection = rule.match.connectionId !== undefined;
    assert(hasUrl !== hasConnection, 'WS 规则必须且只能选择 URL 或当前连接');
    if (hasUrl) {
      assert(nonempty(rule.match.url, 4096), 'WS URL 匹配不能为空');
      const pattern = rule.match.url;
      if (pattern !== '*') {
        assert(/^wss?:\/\//.test(pattern) && !/\s/.test(pattern), 'WS URL 匹配须使用 ws:// 或 wss://');
        let parsed: URL;
        try {
          parsed = new URL(pattern);
        } catch {
          throw new Error('WS URL 匹配格式无效');
        }
        assert(!parsed.username && !parsed.password && !parsed.hash, 'WS URL 匹配不能包含用户信息或片段');
      }
    }
    if (hasConnection) {
      assert(allowTemporary, '当前连接规则仅本次会话有效，不能写入项目文件');
      assert(nonempty(rule.match.connectionId, 512), 'WS 连接 ID 无效');
    }
    if (rule.match.direction !== undefined)
      assert(
        typeof rule.match.direction === 'string' && ['inbound', 'outbound'].includes(rule.match.direction),
        'WS 消息方向无效',
      );
    if (rule.match.contains !== undefined)
      assert(
        typeof rule.match.contains === 'string' && rule.match.contains.length <= 16384,
        'WS 文本匹配最多 16384 字符',
      );
    assert(object(rule.action), 'WS 规则 action 必须为对象');
    fields(rule.action, ['type', 'text'], 'WS 规则 action');
    assert(
      typeof rule.action.type === 'string' && ['replace', 'drop'].includes(rule.action.type),
      'WS 规则动作必须为 replace 或 drop',
    );
    if (rule.action.type === 'replace') {
      assert(typeof rule.action.text === 'string', 'WS 替换消息必须是字符串');
      assert(new TextEncoder().encode(rule.action.text).length <= 256 * 1024, 'WS 替换消息最多 256 KiB');
    } else assert(rule.action.text === undefined, 'WS 丢弃动作不接受替换消息');
  }
  const serialized = JSON.stringify(input);
  assert(new TextEncoder().encode(serialized).length <= maxDocumentBytes, 'WS 规则文档最多 2 MiB');
  return JSON.parse(serialized) as WsRuleDocument;
}

/** URL wildcard matching is anchored, with only * and ? as metacharacters. */
export function wsUrlMatches(pattern: string, url: string | undefined): boolean {
  if (!url) return false;
  const expression = [...pattern]
    .map((character) =>
      character === '*' ? '.*' : character === '?' ? '.' : character.replace(/[\\^$+?.()|{}[\]]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${expression}$`).test(url);
}

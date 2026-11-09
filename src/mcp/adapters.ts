import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { applyEdits, modify, parse as parseJson, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { readConfig, writeConfig, type ConfigSnapshot } from './config-file';

export type AgentId = 'claude' | 'codex-cli' | 'codex-app';
export type AdapterScope = 'project' | 'global';
export const MCP_SERVER_NAME = 'flutter-api-mocks';
export interface AgentAdapterState {
  agent: AgentId;
  scope: AdapterScope;
  path: string;
  status: 'unavailable' | 'not-configured' | 'configured' | 'conflict' | 'invalid';
  configured: boolean;
  managed: boolean;
  clientDetected: boolean;
  shared: boolean;
  message: string;
  difference?: { commandMatches: boolean; argumentsMatch: boolean };
  nodePath?: string;
  effectiveScope?: 'local' | 'project' | 'global';
  effectivePath?: string;
  shadowed?: boolean;
  effectiveMessage?: string;
}
export interface AgentAdapterOptions {
  workspace: string;
  bridgeRoot: string;
  nodePath?: string;
  home?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  detectClient?: (agent: AgentId) => Promise<boolean>;
}
const execute = promisify(execFile);
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function executable(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, 1);
      return candidate;
    } catch {
      // Continue through the configured PATH; never invoke a login shell.
    }
  }
}

/** Find a real Node.js 20+ binary; the VS Code Electron executable is not a Node runtime. */
export async function detectNodeRuntime(
  preferred?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const candidates = [preferred, await executable('node', env)];
  if (/^node(?:js)?$/.test(basename(process.execPath))) candidates.push(process.execPath);
  for (const candidate of [...new Set(candidates)]) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      const result = await execute(candidate, ['--version'], { env, timeout: 3000, maxBuffer: 1024 });
      if (/^v(?:2\d|[3-9]\d|\d{3,})\./.test(result.stdout.trim())) return candidate;
    } catch {
      // A broken runtime is reported by the adapter without installing software.
    }
  }
}

function parseDocument(text: string, toml: boolean): Record<string, any> {
  if (!text.trim()) return {};
  if (toml) {
    const document = parseToml(text);
    if (!object(document)) throw new Error('配置必须是对象');
    return document;
  }
  const errors: ParseError[] = [];
  const value = parseJson(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length || !object(value)) throw new Error('配置不是有效 JSON 对象');
  return value;
}

/** Recognize a TOML header by parsing its keys instead of comparing its quote style. */
function headerKeys(header: string): string[] | undefined {
  try {
    const document = parseToml(`${header}\napi_mocks_probe = true\n`);
    const keys: string[] = [];
    let current: any = document;
    while (
      (object(current) && Object.keys(current).length === 1) ||
      (Array.isArray(current) && current.length === 1)
    ) {
      if (Array.isArray(current)) {
        current = current[0];
        continue;
      }
      const name = Object.keys(current)[0];
      if (name === 'api_mocks_probe') return keys;
      keys.push(name);
      current = current[name];
    }
  } catch {
    // Non-header lines are ignored by the caller.
  }
}

interface TomlStatement {
  start: number;
  end: number;
  text: string;
}

/** Split only at newlines outside strings/arrays/inline tables. TOML is fully validated first. */
function tomlStatements(text: string): TomlStatement[] {
  const statements: TomlStatement[] = [];
  let start = 0;
  let quote = '';
  let triple = false;
  let depth = 0;
  let comment = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (comment) {
      if (character !== '\n') continue;
      comment = false;
    } else if (quote) {
      if (quote === '"' && character === '\\') {
        i++;
        continue;
      }
      if (triple && text.slice(i, i + 3) === quote.repeat(3)) {
        quote = '';
        triple = false;
        i += 2;
      } else if (!triple && character === quote) quote = '';
    } else if (character === '#') comment = true;
    else if (character === '"' || character === "'") {
      quote = character;
      triple = text.slice(i, i + 3) === character.repeat(3);
      if (triple) i += 2;
    } else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') depth--;
    if (character === '\n' && !quote && depth === 0) {
      statements.push({ start, end: i + 1, text: text.slice(start, i + 1) });
      start = i + 1;
    }
  }
  if (start < text.length) statements.push({ start, end: text.length, text: text.slice(start) });
  return statements;
}

function assignmentKeys(statement: string): string[] | undefined {
  let quote = '';
  for (let i = 0; i < statement.length; i++) {
    const character = statement[i];
    if (quote) {
      if (quote === '"' && character === '\\') i++;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '#') return;
    else if (character === '=') return headerKeys(`[${statement.slice(0, i).trim()}]`);
  }
}

function editToml(text: string, entry: Record<string, unknown> | undefined): string {
  const document = parseDocument(text, true);
  const statements = tomlStatements(text);
  const ranges: Array<{ start: number; end: number }> = [];
  let section: string[] = [];
  let wholeMap = false;
  for (const statement of statements) {
    const trimmed = statement.text.trim();
    if (trimmed.startsWith('[')) section = headerKeys(trimmed) ?? [];
    if (section[0] === 'mcp_servers' && section[1] === MCP_SERVER_NAME) {
      if (trimmed && !trimmed.startsWith('#')) ranges.push(statement);
      continue;
    }
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
    const keys = [...section, ...(assignmentKeys(statement.text) ?? [])];
    if (keys[0] !== 'mcp_servers') continue;
    if (keys[1] === MCP_SERVER_NAME) ranges.push(statement);
    else if (keys.length === 1) {
      ranges.push(statement);
      wholeMap = true;
    }
  }
  let output = text;
  for (const range of [...ranges].reverse()) output = output.slice(0, range.start) + output.slice(range.end);
  if (wholeMap) {
    const remaining = { ...(document.mcp_servers ?? {}) };
    delete remaining[MCP_SERVER_NAME];
    if (Object.keys(remaining).length) output += `\n${stringifyToml({ mcp_servers: remaining })}\n`;
  }
  if (entry) {
    const block = `[mcp_servers."${MCP_SERVER_NAME}"]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;
    output = `${output}${output && !output.endsWith('\n') ? '\n' : ''}${output ? '\n' : ''}${block}`;
  }
  parseDocument(output, true);
  return output;
}

function editDocument(
  before: ConfigSnapshot,
  toml: boolean,
  entry: Record<string, unknown> | undefined,
): string {
  if (!toml) {
    const text = before.text.trim() ? before.text : '{}\n';
    const edits = modify(text, ['mcpServers', MCP_SERVER_NAME], entry, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
    });
    const output = applyEdits(text, edits);
    parseDocument(output, false);
    return output.endsWith('\n') ? output : output + '\n';
  }
  return editToml(before.text, entry);
}

export class AgentAdapterManager {
  private readonly options: AgentAdapterOptions;
  constructor(options: AgentAdapterOptions) {
    if (!isAbsolute(options.workspace) || !isAbsolute(options.bridgeRoot))
      throw new Error('项目及 MCP 桥接目录必须为绝对路径');
    this.options = options;
  }
  configPath(agent: AgentId, scope: AdapterScope = 'project'): string {
    const home = this.options.home ?? homedir();
    if (agent === 'claude')
      return scope === 'project'
        ? join(this.options.workspace, '.mcp.json')
        : join(this.options.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? home, '.claude.json');
    return scope === 'project'
      ? join(this.options.workspace, '.codex', 'config.toml')
      : join(
          this.options.codexHome ??
            this.options.env?.CODEX_HOME ??
            process.env.CODEX_HOME ??
            join(home, '.codex'),
          'config.toml',
        );
  }
  private async detected(agent: AgentId): Promise<boolean> {
    if (this.options.detectClient) return this.options.detectClient(agent);
    const env = this.options.env ?? process.env;
    if (agent !== 'codex-app') return !!(await executable(agent === 'claude' ? 'claude' : 'codex', env));
    const home = this.options.home ?? homedir();
    for (const app of ['Codex.app']) {
      for (const directory of ['/Applications', join(home, 'Applications')]) {
        try {
          await access(join(directory, app));
          return true;
        } catch {
          /* Next application. */
        }
      }
    }
    return false;
  }
  private async expected(scope: AdapterScope): Promise<Record<string, unknown> | undefined> {
    const node = await detectNodeRuntime(this.options.nodePath, this.options.env ?? process.env);
    if (!node) return;
    return {
      command: node,
      args: [
        join(this.options.bridgeRoot, 'bridge.cjs'),
        '--registry',
        join(this.options.bridgeRoot, 'sessions'),
        ...(scope === 'project' ? ['--workspace', this.options.workspace] : []),
      ],
    };
  }
  private managed(entry: unknown): boolean {
    if (!object(entry) || !Array.isArray(entry.args)) return false;
    return (
      entry.args[0] === join(this.options.bridgeRoot, 'bridge.cjs') &&
      entry.args[1] === '--registry' &&
      entry.args[2] === join(this.options.bridgeRoot, 'sessions')
    );
  }
  /** Determine file-layer precedence only; client trust, policies and loaded state remain unknown. */
  private async effective(
    agent: AgentId,
    scope: AdapterScope,
  ): Promise<Pick<AgentAdapterState, 'effectiveScope' | 'effectivePath' | 'shadowed' | 'effectiveMessage'>> {
    const projectPath = this.configPath(agent, 'project');
    const globalPath = this.configPath(agent, 'global');
    let project: Record<string, any>, global: Record<string, any>;
    try {
      // Keep only existence of the named service; no credential values escape this method.
      project = parseDocument((await readConfig(projectPath)).text, agent !== 'claude');
      global = parseDocument((await readConfig(globalPath)).text, agent !== 'claude');
    } catch {
      return {
        effectiveMessage: '其他配置层无法读取或解析，无法确认覆盖关系；客户端信任、批准及策略状态未知。',
      };
    }
    const serversKey = agent === 'claude' ? 'mcpServers' : 'mcp_servers';
    const exists = (document: unknown): boolean =>
      object(document) &&
      object(document[serversKey]) &&
      Object.hasOwn(document[serversKey], MCP_SERVER_NAME);
    const local =
      agent === 'claude' && object(global.projects) ? global.projects[this.options.workspace] : undefined;
    const effectiveScope = exists(local)
      ? 'local'
      : exists(project)
        ? 'project'
        : exists(global)
          ? 'global'
          : undefined;
    const effectivePath =
      effectiveScope === 'project' ? projectPath : effectiveScope ? globalPath : undefined;
    const selectedExists = scope === 'project' ? exists(project) : exists(global);
    const shadowed = selectedExists && effectiveScope !== undefined && effectiveScope !== scope;
    return {
      effectiveScope,
      effectivePath,
      shadowed,
      effectiveMessage: effectiveScope
        ? `${shadowed ? '当前范围被更高优先级同名配置覆盖；' : ''}按文件配置优先级，候选来源为${effectiveScope === 'local' ? 'Claude 当前项目 local 配置' : effectiveScope === 'project' ? '项目配置' : '全局配置'}。客户端信任、批准及策略状态未知，实际加载以握手为准。`
        : '未发现此服务的候选配置；客户端信任、批准及策略状态未知。',
    };
  }
  async inspect(agent: AgentId, scope: AdapterScope = 'project'): Promise<AgentAdapterState> {
    const path = this.configPath(agent, scope);
    const clientDetected = await this.detected(agent);
    const expected = await this.expected(scope);
    const state: AgentAdapterState = {
      agent,
      scope,
      path,
      status: 'not-configured',
      configured: false,
      managed: false,
      clientDetected,
      shared: agent !== 'claude',
      message: '',
      nodePath: expected?.command as string | undefined,
    };
    try {
      const snapshot = await readConfig(path);
      const document = parseDocument(snapshot.text, agent !== 'claude');
      const servers = document[agent === 'claude' ? 'mcpServers' : 'mcp_servers'];
      if (servers !== undefined && !object(servers)) throw new Error('MCP 配置必须是对象');
      const entry = servers?.[MCP_SERVER_NAME];
      if (entry !== undefined) {
        state.managed = this.managed(entry);
        state.configured =
          !!expected &&
          object(entry) &&
          equal(entry.command, expected.command) &&
          equal(entry.args, expected.args) &&
          !entry.url &&
          entry.enabled !== false &&
          entry.disabled !== true &&
          (!entry.type || entry.type === 'stdio');
        state.status = state.configured ? 'configured' : 'conflict';
        state.difference = {
          commandMatches: equal(entry?.command, expected?.command),
          argumentsMatch: equal(entry?.args, expected?.args),
        };
        state.message = state.configured
          ? '配置已就绪，等待客户端加载；请在客户端批准项目 MCP，必要时重连或新建会话。'
          : '同名 MCP 配置与当前桥接设置不同；仅点击“修复”才会替换。';
      } else state.message = '尚未配置此范围的 MCP。';
      if (!expected) {
        state.status = 'unavailable';
        state.message = '未找到 Node.js 20+；请先安装或配置绝对路径，再重新检测。';
      } else if (!clientDetected) {
        state.message += ' 未检测到客户端，可写入配置后安装客户端并重新检测。';
      }
    } catch (error) {
      state.status = 'invalid';
      state.message =
        error instanceof Error && /配置|MCP/.test(error.message)
          ? error.message
          : '配置文件无法读取或解析；请修复文件后重试。';
    }
    return { ...state, ...(await this.effective(agent, scope)) };
  }
  async all(scope: AdapterScope = 'project'): Promise<AgentAdapterState[]> {
    return Promise.all(
      (['claude', 'codex-cli', 'codex-app'] as const).map((agent) => this.inspect(agent, scope)),
    );
  }
  async adapt(agent: AgentId, scope: AdapterScope = 'project', repair = false): Promise<AgentAdapterState> {
    const state = await this.inspect(agent, scope);
    if (state.status === 'invalid' || state.status === 'unavailable') throw new Error(state.message);
    if (state.configured) return state;
    if (state.status === 'conflict' && !repair) throw new Error('存在同名 MCP 配置，请查看差异并点击“修复”');
    const expected = await this.expected(scope);
    if (!expected) throw new Error('未找到 Node.js 20+');
    const before = await readConfig(state.path);
    const document = parseDocument(before.text, agent !== 'claude');
    const existing = document[agent === 'claude' ? 'mcpServers' : 'mcp_servers']?.[MCP_SERVER_NAME];
    if (existing !== undefined && !repair) throw new Error('配置已变化，请重新检测后重试');
    const entry = agent === 'claude' ? { type: 'stdio', ...expected } : expected;
    await writeConfig(state.path, before, editDocument(before, agent !== 'claude', entry));
    return this.inspect(agent, scope);
  }
  async remove(agent: AgentId, scope: AdapterScope = 'project'): Promise<AgentAdapterState> {
    const path = this.configPath(agent, scope);
    const before = await readConfig(path);
    const document = parseDocument(before.text, agent !== 'claude');
    const entry = document[agent === 'claude' ? 'mcpServers' : 'mcp_servers']?.[MCP_SERVER_NAME];
    if (entry === undefined) return this.inspect(agent, scope);
    if (!this.managed(entry)) throw new Error('此同名 MCP 不是本插件管理的配置，未执行删除');
    await writeConfig(path, before, editDocument(before, agent !== 'claude', undefined));
    return this.inspect(agent, scope);
  }
}

import type { HistoryQuery, HistoryResult, HistoryEntry, Rule } from '../model';
import type { WsMessageQuery, WsMessageResult, WsRule } from '../ws/model';

export interface NetworkHost {
  httpRulesPath: string;
  wsRulesPath: string;
  readHttpRules(): Promise<Rule[]>;
  readWsRules(): Promise<WsRule[]>;
  applyHttpRules(rules: Rule[]): Promise<void>;
  applyWsRules(rules: WsRule[]): Promise<void>;
  status(): Record<string, unknown>;
  listHttp(query: HistoryQuery): Promise<HistoryResult>;
  getHttp(id: string): Promise<HistoryEntry>;
  connections(): Promise<unknown>;
  messages(query: WsMessageQuery): Promise<WsMessageResult>;
  setCapture(domain: 'http' | 'ws', enabled: boolean): Promise<void>;
  setMock(domain: 'http' | 'ws', enabled: boolean): Promise<void>;
}

/** File-backed rules and runtime controls shared by MCP and the workbench. */
export class McpNetworkController {
  private revisions = { http: 0, ws: 0 };
  private loaded: Record<string, unknown> = {};
  constructor(private readonly host: NetworkHost) {}

  status() {
    return {
      ...this.host.status(),
      files: { http: this.host.httpRulesPath, ws: this.host.wsRulesPath },
      loaded: this.loaded,
      instructions:
        '规则格式和操作示例见 get_usage_guide(topic=http/ws)；编辑 files 指定的文件后调用 reload_rules，再显式开启相应采集/Mock 并验证新记录。',
    };
  }

  async reload(domain: 'http' | 'ws' | 'all' = 'all') {
    const results: Record<string, unknown> = {};
    for (const item of domain === 'all' ? (['http', 'ws'] as const) : [domain]) {
      let count: number | undefined;
      try {
        // Read/validate before touching the last valid in-memory rules.
        if (item === 'http') {
          const rules = await this.host.readHttpRules();
          count = rules.length;
          await this.host.applyHttpRules(rules);
        } else {
          const rules = await this.host.readWsRules();
          count = rules.length;
          await this.host.applyWsRules(rules);
        }
        const runtime = this.host.status();
        const domainState = runtime[item] as { mockEnabled?: boolean; runtimeApplied?: boolean } | undefined;
        const runtimeApplied =
          runtime.vmConnected === true && (domainState?.runtimeApplied ?? domainState?.mockEnabled) === true;
        results[item] = {
          loaded: true,
          synchronized: true,
          runtimeApplied,
          pending: !runtimeApplied,
          message: runtimeApplied ? '规则已加载并同步到运行时' : '规则已加载；连接 VM 并开启对应 Mock 后应用',
          count,
          revision: ++this.revisions[item],
          at: Date.now(),
        };
      } catch (error) {
        results[item] = {
          loaded: count !== undefined,
          synchronized: false,
          runtimeApplied: false,
          count,
          error: error instanceof Error ? error.message : '规则读取或同步失败',
        };
      }
      this.loaded = { ...this.loaded, [item]: results[item] };
    }
    return { ok: Object.values(results).every((r: any) => r.synchronized), results, status: this.status() };
  }

  async execute(tool: string, args: Record<string, any>) {
    const { sessionId: _, ...query } = args;
    switch (tool) {
      case 'get_network_status':
        return this.status();
      case 'reload_rules':
        return this.reload(args.domain ?? 'all');
      case 'get_requests':
        return this.host.listHttp(query);
      case 'get_request':
        return this.host.getHttp(args.id);
      case 'get_ws_connections':
        return this.host.connections();
      case 'get_ws_messages':
        return this.host.messages(query);
      case 'set_capture_enabled':
        await this.host.setCapture(args.domain, args.enabled);
        return this.status();
      case 'set_mock_enabled':
        await this.host.setMock(args.domain, args.enabled);
        return this.status();
      default:
        throw new Error('未知网络工具');
    }
  }
}

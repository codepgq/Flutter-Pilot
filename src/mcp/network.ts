import type { HistoryQuery, HistoryResult, HistoryEntry } from '../model';
import type { WsMessageQuery, WsMessageResult } from '../ws/model';
import { encodeWsMessage } from './tools';

export interface NetworkHost {
  scenesPath: string;
  testsPath?: string;
  listScenes(query?: { offset?: number; limit?: number; search?: string }): unknown;
  activateScene(id: string | null): Promise<void>;
  reloadScenes(): Promise<void>;
  status(): Record<string, unknown>;
  listHttp(query: HistoryQuery): Promise<HistoryResult>;
  getHttp(id: string): Promise<HistoryEntry>;
  clearHttp(): Promise<unknown>;
  clearWs(): Promise<unknown>;
  connections(): Promise<unknown>;
  messages(query: WsMessageQuery): Promise<WsMessageResult>;
  setCapture(domain: 'http' | 'ws', enabled: boolean): Promise<void>;
  injectWs(connectionId: string, text: string, signal?: AbortSignal): Promise<void>;
  sendWs(connectionId: string, text: string, signal?: AbortSignal): Promise<void>;
}

/** File-backed rules and runtime controls shared by MCP and the workbench. */
export class McpNetworkController {
  private loaded: Record<string, unknown> = {};
  constructor(private readonly host: NetworkHost) {}

  status() {
    return {
      ...this.host.status(),
      storageVersion: 2,
      files: {
        scenes: this.host.scenesPath,
        ...(this.host.testsPath ? { tests: this.host.testsPath } : {}),
      },
      loaded: this.loaded,
      instructions:
        'files.scenes 是 v2 根清单；按清单编辑独立资源后调用 reload_rules；旧 scenes.json 需显式迁移；用 list_scenes / activate_scene / deactivate_scene 统一控制 HTTP/WS Mock，并以新记录验证命中。',
    };
  }

  async reload() {
    try {
      await this.host.reloadScenes();
      this.loaded = { loaded: true, revision: Number(this.loaded.revision ?? 0) + 1, at: Date.now() };
      return { ok: true, ...this.loaded, status: this.status() };
    } catch (error) {
      return { ok: false, loaded: false, error: (error as Error).message, status: this.status() };
    }
  }

  async execute(tool: string, args: Record<string, any>, signal?: AbortSignal) {
    const { sessionId: _, target: _target, ...query } = args;
    switch (tool) {
      case 'get_network_status':
        return this.status();
      case 'reload_rules':
        return this.reload();
      case 'list_scenes':
        return this.host.listScenes(query);
      case 'activate_scene':
        await this.host.activateScene(args.sceneId);
        return this.host.listScenes();
      case 'deactivate_scene':
        await this.host.activateScene(null);
        return this.host.listScenes();
      case 'get_requests':
        return this.host.listHttp(query);
      case 'get_request':
        return this.host.getHttp(args.id);
      case 'clear_network_history': {
        if (args.confirm !== true) throw new Error('清理历史必须显式传 confirm:true。');
        const domain = args.domain as 'http' | 'ws' | 'all';
        const state = this.host.status();
        if (domain !== 'http' && (state.ws as { supported?: boolean } | undefined)?.supported === false)
          throw new Error('当前运行目标不支持 WS 历史清理；未清理任何记录。');
        signal?.throwIfAborted();
        const requested = domain === 'all' ? (['http', 'ws'] as const) : ([domain] as const);
        const operations = await Promise.allSettled(
          requested.map((item) => (item === 'http' ? this.host.clearHttp() : this.host.clearWs())),
        );
        const cleared = requested.filter((_, index) => operations[index].status === 'fulfilled');
        const errors = operations.flatMap((result, index) =>
          result.status === 'rejected'
            ? [{ domain: requested[index], message: (result.reason as Error)?.message ?? '清理失败' }]
            : [],
        );
        return {
          ok: errors.length === 0,
          cleared,
          ...(errors.length ? { errors } : {}),
          scope: 'current-target',
          message:
            errors.length === 0
              ? '指定运行目标的网络历史已清理；API 目录、规则、Scene、配置和在线连接均保留。'
              : '部分网络历史未能清理；请根据 errors 核对结果，已完成的删除不可恢复。',
        };
      }
      case 'get_ws_connections':
        return this.host.connections();
      case 'get_ws_messages':
        return this.host.messages(query);
      case 'inject_ws_message':
      case 'send_ws_message': {
        const text = encodeWsMessage(args);
        const injection = tool === 'inject_ws_message';
        signal?.throwIfAborted();
        if (injection) await this.host.injectWs(args.connectionId, text, signal);
        else await this.host.sendWs(args.connectionId, text, signal);
        return {
          ok: true,
          submitted: true,
          connectionId: args.connectionId,
          direction: injection ? 'inbound' : 'outbound',
          bytes: Buffer.byteLength(text, 'utf8'),
          message: injection
            ? '模拟消息已注入 App；请查询新 WS 记录并按 Key 验证页面结果。'
            : '消息已提交到 App 连接；outbound 规则可能替换或丢弃，请查询新 WS 记录和业务响应确认结果。',
        };
      }
      case 'set_capture_enabled':
        await this.host.setCapture(args.domain, args.enabled);
        return this.status();
      default:
        throw new Error('未知网络工具');
    }
  }
}

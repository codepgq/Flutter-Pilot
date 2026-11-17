import { z } from 'zod';
export const browserTargetSchema = z
  .object({ runtimeId: z.string().min(1).max(256), generation: z.number().int().positive() })
  .strict();
export const browserPageSchema = z
  .object({ ...browserTargetSchema.shape, pageId: z.string().min(1).max(256) })
  .strict();
export type BrowserTarget = z.infer<typeof browserTargetSchema>;
export type BrowserPage = z.infer<typeof browserPageSchema>;
export class BrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
export function browserUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new BrowserError(
      'INVALID_ARGUMENTS',
      'Browser navigation requires an HTTP/HTTPS URL without credentials.',
    );
  return url.href;
}
export interface BrowserContextState extends BrowserTarget {
  trustedFingerprints?: string[];
  backend: 'direct';
  serviceWorkers: 'block';
  cache: 'routing_disables_http_cache';
  pages: { pageId: string; url: string }[];
}
export const browserMcpTools = {
  get_browser_ws_message: {
    description:
      'Read the original/effective text or bounded binary snapshot of one owned browser WS message; read-only, no replay.',
    schema: z
      .object({ sessionId: z.string(), target: browserTargetSchema, id: z.string().min(1).max(256) })
      .strict(),
  },
  get_browser_status: {
    description:
      '只读浏览器依赖/Worker 状态；不下载或启动。支持托管 Chromium、Service Worker 阻止和独立 Context；不附着日常 Profile。',
    schema: z.object({ sessionId: z.string() }).strict(),
  },
  prepare_browser: {
    description:
      '显式按锁定清单准备私有 Playwright/Chromium 依赖，可取消并重新调用重试；查询和离线指南不准备。',
    schema: z.object({ sessionId: z.string() }).strict(),
  },
  create_browser_context: {
    description:
      '在独立 Worker 新建隔离的 Chromium Context，在首次 Page 导航前安装 HTTP 拦截；仅 direct 后端，不叠加代理 Mock。返回固定运行目标。',
    schema: z
      .object({
        sessionId: z.string(),
        headless: z.boolean().optional(),
        trustedCertificates: z
          .array(z.string().min(1).max(16384))
          .max(8)
          .optional()
          .describe(
            'Explicit PEM CA certificates for the first Context in a fresh Worker only; disposable private Profile, no system trust changes. macOS verified. Omit for normal TLS.',
          ),
      })
      .strict(),
  },
  list_browser_pages: {
    description: '只读列出自有运行时 Context/Page 身份、代次和 URL；不按焦点猜测页面。',
    schema: z.object({ sessionId: z.string() }).strict(),
  },
  open_browser_page: {
    description:
      '在明确 Context 创建 Page，可显式导航 HTTP/HTTPS；首次导航前规则已安装，不使用用户日常浏览器。',
    schema: z
      .object({ sessionId: z.string(), target: browserTargetSchema, url: z.string().max(4096).optional() })
      .strict(),
  },
  navigate_browser_page: {
    description: '显式导航准确 Page；过期、断开或歧义不改操作其他页，取消/超时不重放。',
    schema: z
      .object({ sessionId: z.string(), target: browserPageSchema, url: z.string().max(4096) })
      .strict(),
  },
  reload_browser_page: {
    description: '显式刷新准确 Page；reload_rules/激活/重连不会隐式刷新。',
    schema: z.object({ sessionId: z.string(), target: browserPageSchema }).strict(),
  },
  close_browser_page: {
    description: '关闭明确的自有 Page，使旧 Page 身份失效；不关闭其他 Context 或 Flutter。',
    schema: z.object({ sessionId: z.string(), target: browserPageSchema }).strict(),
  },
  close_browser_context: {
    description: '关闭明确的自有 Context 与页面，释放 Worker 资源并作废旧目标；不清用户浏览器数据。',
    schema: z.object({ sessionId: z.string(), target: browserTargetSchema }).strict(),
  },
} as const;

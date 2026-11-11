import type { ApiCatalogEntry, Rule } from '../src/model';
import { globRegex } from '../src/glob';

const labels = {
  mock: 'Mock',
  redirect: '转发',
  request: '修改请求',
  response: '修改响应',
  breakpoint: '断点',
};
export interface ApiRuleTag {
  kind: keyof typeof labels;
  label: string;
  conditional: boolean;
  title: string;
}

/** Catalog entries have no query or headers, so describe configuration, not historical hits. */
export function apiRuleTags(api: ApiCatalogEntry, rules: Rule[]): ApiRuleTag[] {
  const tags = new Map<string, ApiRuleTag>();
  for (const rule of [...rules].sort((a, b) => b.priority - a.priority)) {
    const { method, host, path, query, headers } = rule.match;
    if (!rule.enabled) continue;
    if (method && method !== '*' && method.toUpperCase() !== api.method.toUpperCase()) continue;
    if (host && host !== '*' && host.toLowerCase() !== api.host.toLowerCase()) continue;
    if (path && !new RegExp(globRegex(path)).test(api.path)) continue;
    const conditions = [
      ...(Object.keys(query ?? {}).length ? [`查询参数：${Object.keys(query!).join('、')}`] : []),
      ...(Object.keys(headers ?? {}).length ? [`请求头：${Object.keys(headers!).join('、')}`] : []),
    ];
    const conditional = conditions.length > 0;
    const description = `${rule.name}（优先级 ${rule.priority}）${conditional ? `；需满足${conditions.join('；')}` : ''}`;
    const kinds = (Object.keys(labels) as ApiRuleTag['kind'][]).filter((kind) =>
      kind === 'breakpoint'
        ? rule.breakpoint?.request || rule.breakpoint?.response
        : rule[kind] !== undefined,
    );
    for (const kind of kinds) {
      const key = `${kind}:${conditional}`;
      const existing = tags.get(key);
      if (existing) existing.title += `\n${description}`;
      else
        tags.set(key, {
          kind,
          label: labels[kind] + (conditional ? ' · 条件' : ''),
          conditional,
          title: `已启用的规则配置；实际命中按每阶段优先级决定，需开启对应运行时拦截。\n${description}`,
        });
    }
  }
  return [...tags.values()];
}

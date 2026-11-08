import { test, expect, Page } from '@playwright/test';
const body = {
  headers: [['content-type', 'application/json']] as [string, string][],
  body: '{"orders":[{"id":1001,"state":"paid"}]}',
  bodyEncoding: 'text',
  bodyBytes: 40,
  truncated: false,
  editable: true,
};
const request = { ...body, method: 'GET', url: 'https://api.example.test/v1/orders', body: '' };
const response = { ...body, status: 200 };
const entry = {
  id: 'history-1',
  startedAt: Date.now(),
  duration: 42,
  method: 'GET',
  host: 'api.example.test',
  path: '/v1/orders',
  url: request.url,
  targetUrl: request.url,
  originalRequest: request,
  automaticRequest: request,
  request,
  originalResponse: { ...response, body: '{"orders":[]}' },
  automaticResponse: response,
  response,
  mocked: true,
  requestRuleId: 'orders',
  note: '订单空列表场景',
  tags: ['测试'],
};
const rule = {
  id: 'orders',
  name: '订单列表 · 已支付',
  enabled: true,
  priority: 10,
  match: { method: 'GET', host: 'api.example.test', path: '/v1/orders' },
  mock: { status: 200, headers: { 'content-type': 'application/json' }, body: body.body },
};
const fixture = {
  rules: [rule],
  history: { items: [{ ...entry, status: 200 }], total: 1 },
  apis: [{ method: 'GET', host: 'api.example.test', path: '/v1/orders', count: 1, lastAt: Date.now() }],
  pending: [],
  engine: { status: 'running', proxyPort: 8080, listenHost: '127.0.0.1' },
  proxyActive: true,
  lan: false,
  addresses: [
    { label: '本机', host: '127.0.0.1' },
    { label: 'Wi-Fi', host: '192.168.1.8' },
  ],
  devices: [],
  connectionHost: '127.0.0.1',
  workspace: '/Users/developer/commerce_app',
  logs: ['mitmproxy 12.3.1 ready', '代理已启动：127.0.0.1:8080'],
  busy: false,
};
async function state(page: Page, overrides = {}, selected?: unknown) {
  await page.evaluate(({ state, selected }) => window.postMessage({ type: 'state', state, selected }, '*'), {
    state: { ...fixture, ...overrides },
    selected,
  });
}
async function messages(page: Page) {
  return page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages);
}
test('连接引导、代理控制与局域网开关', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await expect(page.getByRole('heading', { name: '让接口调试，从连接开始' })).toBeVisible();
  await page.getByRole('button', { name: '停止代理', exact: true }).click();
  expect(await messages(page)).toContainEqual({ action: 'stop', payload: {} });
  await page.getByRole('switch').click();
  expect(await messages(page)).toContainEqual({ action: 'setLan', payload: { enabled: true } });
  await page.screenshot({ path: 'artifacts/workbench-connection.png', fullPage: true });
});
test('规则表单校验、JSON编辑与 CRUD 消息', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await page.getByRole('button', { name: 'Mock 规则' }).click();
  await page.getByRole('button', { name: '新建规则' }).click();
  await page.getByRole('button', { name: '保存规则' }).click();
  await expect(page.getByRole('alert')).toContainText('规则名称不能为空');
  await page.getByLabel('规则名称', { exact: true }).fill('错误场景');
  await page.getByLabel('匹配主机').fill('api.example.test');
  await page.getByLabel('响应状态码', { exact: true }).fill('503');
  await page.getByLabel('Body · JSON / 文本', { exact: true }).fill('{"message":"服务维护"}');
  await page.getByRole('button', { name: '保存规则' }).click();
  const out = (await messages(page)) as { action: string; payload: { rule?: typeof rule } }[];
  expect(out.find((m) => m.action === 'rules.save')?.payload.rule?.mock?.status).toBe(503);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '完整 JSON', exact: true }).click();
  await expect(page.getByLabel('规则 JSON', { exact: true })).toContainText('订单列表');
  await page.screenshot({ path: 'artifacts/workbench-rule-editor.png', fullPage: true });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  expect(await messages(page)).toContainEqual({ action: 'rules.duplicate', payload: { id: 'orders' } });
  expect(await messages(page)).toContainEqual({ action: 'rules.delete', payload: { id: 'orders' } });
});
test('历史详情、对比、生成规则及备注', async ({ page }) => {
  await page.goto('/');
  await state(page, {}, entry);
  await page.getByRole('button', { name: 'API 与历史' }).click();
  await expect(page.getByText('最终响应', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '生成 Mock', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'history.toRule',
    payload: { id: entry.id, kind: 'mock' },
  });
  await page.getByRole('button', { name: '修改对比', exact: true }).click();
  await expect(page.getByText('请求 · 原始 → 自动规则 → 最终')).toBeVisible();
  await page.getByRole('button', { name: '备注与信息', exact: true }).click();
  await page.getByLabel('历史备注').fill('测试已完成');
  await page.getByLabel('历史标签').fill('已验证, Android');
  await page.getByRole('button', { name: '保存备注' }).click();
  expect(await messages(page)).toContainEqual({
    action: 'history.update',
    payload: { id: entry.id, note: '测试已完成', tags: ['已验证', 'Android'] },
  });
  await page.getByRole('button', { name: '响应', exact: true }).click();
  await page.screenshot({ path: 'artifacts/workbench-history.png', fullPage: true });
});
test('并发断点、编辑放行和终止', async ({ page }) => {
  await page.goto('/');
  const bp = {
    id: 'bp1',
    flowId: entry.id,
    stage: 'response',
    expiresAt: Date.now() + 60000,
    original: response,
    current: response,
  };
  await state(page, {
    pending: [
      bp,
      { ...bp, id: 'bp2', flowId: 'second', stage: 'request', original: request, current: request },
    ],
  });
  await page.getByRole('button', { name: '断点队列' }).click();
  await page.getByLabel('断点响应状态码').fill('201');
  await page.getByLabel('断点 Body', { exact: true }).fill('{"edited":true}');
  await page.getByRole('button', { name: '编辑后放行', exact: true }).click();
  const out = (await messages(page)) as {
    action: string;
    payload: { patch?: { status: number; body: string } };
  }[];
  expect(out.find((m) => m.action === 'breakpoint.resolve')?.payload.patch).toMatchObject({
    status: 201,
    body: '{"edited":true}',
  });
  await page.getByRole('button', { name: '终止请求', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'breakpoint.resolve',
    payload: { id: 'bp1', action: 'abort' },
  });
  await page.screenshot({ path: 'artifacts/workbench-breakpoints.png', fullPage: true });
});
test('窄面板与浅色主题不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 920 });
  await page.goto('/');
  await state(page);
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--vscode-editor-background', '#fafafa'),
  );
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--vscode-editor-foreground', '#252b33'),
  );
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--vscode-sideBar-background', '#f1f3f5'),
  );
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--vscode-input-background', '#ffffff'),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Mock 规则' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/workbench-narrow-light.png', fullPage: true });
});

test('仅改请求头保留正文，关闭全部断点仍可保存 Mock', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await page.getByRole('button', { name: 'Mock 规则' }).click();
  await page.getByRole('button', { name: '修改请求', exact: true }).click();
  await page.getByLabel('规则名称', { exact: true }).fill('只修改请求头');
  await page.getByLabel('Headers JSON', { exact: true }).fill('{"x-debug":"true"}');
  await expect(page.getByLabel('Body · JSON / 文本', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保存规则' }).click();
  const sent = (await messages(page)) as {
    action: string;
    payload: { rule?: { request?: unknown; breakpoint?: unknown } };
  }[];
  const saved = sent.find((m) => m.action === 'rules.save')?.payload.rule;
  expect(saved?.request).toEqual({ headers: { 'x-debug': 'true' }, query: {} });
  await state(page, { rules: [{ ...rule, breakpoint: { request: true, response: false, timeout: 60 } }] });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('请求发送前暂停').uncheck();
  await page.getByRole('button', { name: '保存规则' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const all = (await messages(page)) as typeof sent;
  expect(all.filter((m) => m.action === 'rules.save').at(-1)?.payload.rule).not.toHaveProperty('breakpoint');
});

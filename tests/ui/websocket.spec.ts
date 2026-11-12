import { test, expect, type Page } from '@playwright/test';

const connection = {
  id: 'ws:session:main:1',
  isolateId: 'isolates/main',
  endpoint: '127.0.0.1:9000',
  url: 'wss://stream.example.test/prices?market=all',
  status: 'open',
  capture: 'attached',
  openedAt: 1794000000000,
  sent: 3,
  received: 4,
};
const unknown = { ...connection, id: 'ws:session:main:2', url: undefined, endpoint: '192.0.2.1:443' };
const rule = {
  id: 'ws-rule-1',
  name: '行情替换',
  enabled: true,
  priority: 10,
  match: { url: 'wss://stream.example.test/*', direction: 'inbound', contains: 'price' },
  action: { type: 'replace', text: '{"price":123}' },
};
const message = {
  id: 'ws-message-1',
  connectionId: connection.id,
  timestamp: 1794000000123,
  direction: 'inbound',
  kind: 'text',
  original: '{"price":10,"id":9007199254740993}',
  effective: '{"price":123,"id":9007199254740993}',
  encoding: 'text',
  bytes: 40,
  truncated: false,
  outcome: 'replaced',
  ruleId: rule.id,
};
const summary = { ...message, original: undefined, effective: undefined, preview: '{"price":123}' };
const ws = {
  captureEnabled: true,
  mockEnabled: true,
  status: 'active',
  connections: [connection, unknown],
  messages: { items: [summary], total: 1 },
  rules: [rule],
  omitted: 0,
  warnings: [],
};
const fixture = {
  mode: 'vm',
  vm: {
    status: 'connected',
    endpoint: '127.0.0.1:12345',
    isolates: 1,
    recorded: 0,
    instances: 1,
    mockEnabled: true,
    warnings: [],
  },
  rules: [],
  history: { items: [], total: 0 },
  apis: [],
  pending: [],
  engine: { status: 'stopped' },
  proxyActive: false,
  lan: false,
  addresses: [{ label: '本机', host: '127.0.0.1' }],
  devices: [],
  connectionHost: '127.0.0.1',
  workspace: '/workspace/test',
  logs: [],
  busy: false,
  ws,
};
async function state(page: Page, wsOverrides = {}, overrides = {}) {
  await page.evaluate((state) => window.postMessage({ type: 'state', state }, '*'), {
    ...fixture,
    ...overrides,
    scenes: {
      version: 1,
      activeSceneId: 'scene',
      scenes: [
        {
          id: 'scene',
          name: '默认场景',
          httpRules: [],
          wsRules: (wsOverrides as { rules?: unknown[] }).rules ?? ws.rules,
        },
      ],
    },
    selectedSceneId: 'scene',
    ws: { ...ws, ...wsOverrides },
  });
}
async function lightTheme(page: Page) {
  await page.evaluate(() => {
    const style = document.documentElement.style;
    style.setProperty('--vscode-editor-background', '#fafafa');
    style.setProperty('--vscode-editor-foreground', '#252b33');
    style.setProperty('--vscode-sideBar-background', '#f1f3f5');
    style.setProperty('--vscode-input-background', '#ffffff');
    style.setProperty('--vscode-panel-background', '#ffffff');
    style.setProperty('--vscode-panel-border', '#d7dde3');
    style.setProperty('--vscode-descriptionForeground', '#637181');
    style.setProperty('color-scheme', 'light');
  });
}
async function messages(page: Page) {
  return page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages);
}
async function open(page: Page, wsOverrides = {}, overrides = {}) {
  await page.goto('/');
  await state(page, wsOverrides, overrides);
  await page.locator('nav').getByRole('button', { name: 'WebSocket' }).click();
}

test('WS 采集与场景状态分开，手动推送不依赖场景，断线及代理模式阻止推送', async ({ page }) => {
  await open(page, { captureEnabled: false, mockEnabled: false, status: 'off' });
  await expect(page.getByRole('heading', { name: 'WebSocket', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新发现连接' })).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'WebSocket 消息', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'WS Mock', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '开启 WS 采集', exact: true }).click();
  expect(await messages(page)).toContainEqual({ action: 'ws.capture', payload: { enabled: true } });
  await state(page, { mockEnabled: false });
  await expect(page.getByText('场景 WS Mock 未开启', { exact: true })).toBeVisible();
  await state(page, { mockEnabled: false });
  await page.getByText('采集设置与说明', { exact: true }).click();
  await page.getByRole('button', { name: '重新发现连接' }).click();
  await page.getByRole('button', { name: '关闭 WS 采集' }).click();
  expect(await messages(page)).toEqual(
    expect.arrayContaining([
      { action: 'ws.rescan', payload: {} },
      { action: 'ws.capture', payload: { enabled: false } },
    ]),
  );
  await page.getByRole('button', { name: connection.url, exact: true }).click();
  await page.getByLabel('模拟推送内容').fill('{"price":789}');
  await page.getByRole('button', { name: '推送到 App' }).click();
  expect(await messages(page)).toContainEqual({
    action: 'ws.push',
    payload: { connectionId: connection.id, text: '{"price":789}' },
  });
  await state(
    page,
    { captureEnabled: false, mockEnabled: false, status: 'off' },
    { vm: { ...fixture.vm, status: 'disconnected' } },
  );
  await expect(page.getByRole('button', { name: '开启 WS 采集' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '推送到 App' })).toBeDisabled();
  await expect(page.getByLabel('模拟推送内容')).toBeDisabled();
  await state(page, { captureEnabled: false, status: 'off' }, { mode: 'proxy' });
  await expect(page.getByRole('region', { name: 'WebSocket 采集控制' })).toContainText(
    '请先在“连接与诊断”切换到 VM 模式',
  );
});

test('WS 消息查询、分页和原始生效内容对比保留大整数', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, { messages: { items: [summary], total: 65 } });
  await page.getByRole('button', { name: connection.url, exact: true }).click();
  await expect
    .poll(async () => messages(page))
    .toContainEqual({
      action: 'ws.query',
      payload: { connectionId: connection.id, search: '', limit: 30, offset: 0 },
    });
  await page.getByLabel('WS 消息方向').selectOption('inbound');
  await page.getByLabel('搜索 WS 消息').fill('price');
  await expect
    .poll(async () => messages(page))
    .toContainEqual({
      action: 'ws.query',
      payload: { connectionId: connection.id, direction: 'inbound', search: 'price', limit: 30, offset: 0 },
    });
  await page.getByRole('button', { name: '下一页' }).click();
  await expect
    .poll(async () => messages(page))
    .toContainEqual({
      action: 'ws.query',
      payload: { connectionId: connection.id, direction: 'inbound', search: 'price', limit: 30, offset: 30 },
    });
  await page.getByRole('button', { name: /服务端 → App 已替换/ }).click();
  expect(await messages(page)).toContainEqual({ action: 'ws.select', payload: { id: message.id } });
  await page.evaluate((message) => window.postMessage({ type: 'ws.detail', message }, '*'), message);
  const detail = page.getByRole('region', { name: 'WS 消息详情' });
  await expect(detail.getByRole('region', { name: '原始内容' }).locator('pre')).toContainText(
    '9007199254740993',
  );
  await expect(detail.getByRole('region', { name: '生效内容' }).locator('pre')).toContainText('123');
  await detail.getByRole('button', { name: '复制生效内容' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('9007199254740993');
  await detail.getByRole('region', { name: '原始内容' }).getByRole('button', { name: '显示原文' }).click();
  await expect(detail.getByRole('region', { name: '原始内容' }).locator('pre')).toHaveText(message.original);
  await page.getByRole('button', { name: '清空当前连接历史' }).click();
  expect(await messages(page)).toContainEqual({
    action: 'ws.clear',
    payload: { connectionId: connection.id },
  });
});

test('WS 规则编辑、启停、排序与未知 URL 的临时规则', async ({ page }) => {
  await open(page, { rules: [rule, { ...rule, id: 'ws-rule-2', name: '第二条规则' }] });
  await page
    .getByRole('button', { name: 'WS 规则', exact: false })
    .filter({ hasText: /^WS 规则/ })
    .first()
    .click();
  await page.getByRole('switch', { name: `启用 WS 规则 ${rule.name}` }).click();
  expect(await messages(page)).toContainEqual({
    action: 'ws.rules.toggle',
    payload: { id: rule.id, sceneId: 'scene' },
  });
  await page.getByRole('switch', { name: `启用 WS 规则 ${rule.name}` }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: `下移 WS 规则 ${rule.name}` }).click();
  expect(await messages(page)).toContainEqual({
    action: 'ws.rules.move',
    payload: { id: rule.id, delta: 1, sceneId: 'scene' },
  });
  const card = page
    .locator('.ws-rule')
    .filter({ has: page.getByRole('heading', { name: rule.name, exact: true }) });
  await card.getByRole('button', { name: '复制', exact: true }).click();
  await card.getByRole('button', { name: '删除', exact: true }).click();
  expect(await messages(page)).toEqual(
    expect.arrayContaining([
      { action: 'ws.rules.duplicate', payload: { id: rule.id, sceneId: 'scene' } },
      { action: 'ws.rules.delete', payload: { id: rule.id, sceneId: 'scene' } },
    ]),
  );
  await page.getByRole('button', { name: '新建 WS 规则', exact: true }).click();
  await page.getByRole('button', { name: '保存 WS 规则' }).click();
  await expect(page.getByRole('alert')).toContainText('规则名称不能为空');
  await page.getByLabel('WS 规则名称', { exact: true }).fill('服务端消息替换');
  await page.getByLabel('WS 连接 URL', { exact: true }).fill('wss://stream.example.test/*');
  await page.getByLabel('WS 规则方向').selectOption('inbound');
  await page.getByLabel('WS 包含文本').fill('price');
  await page.getByLabel('WS 替换文本').fill('{"price":789}');
  await page.setViewportSize({ width: 680, height: 920 });
  await page.screenshot({ path: 'artifacts/workbench-ws-rules-dark.png', fullPage: true });
  await lightTheme(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/workbench-ws-rules-light.png', fullPage: true });
  await page.getByRole('button', { name: '保存 WS 规则' }).click();
  expect(await messages(page)).toContainEqual({
    action: 'ws.rules.save',
    payload: {
      sceneId: 'scene',
      targetSceneId: 'scene',
      rule: expect.objectContaining({
        name: '服务端消息替换',
        match: { url: 'wss://stream.example.test/*', direction: 'inbound', contains: 'price' },
        action: { type: 'replace', text: '{"price":789}' },
      }),
    },
  });
  await page.locator('nav').getByRole('button', { name: 'WebSocket' }).click();
  await page.getByRole('button', { name: unknown.endpoint, exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'WebSocket 连接' })).toContainText('URL 未知');
  await page.getByRole('button', { name: '为此连接新建规则' }).click();
  await expect(page.getByLabel('WS 匹配范围')).toHaveValue('connection');
  await expect(page.getByLabel('WS 临时连接')).toHaveValue(unknown.id);
  await page.getByLabel('WS 规则名称', { exact: true }).fill('临时丢弃');
  await page.getByLabel('WS 规则动作').selectOption('drop');
  await expect(page.getByLabel('WS 替换文本')).toHaveCount(0);
  await page.getByRole('button', { name: '保存 WS 规则' }).click();
  expect(await messages(page)).toContainEqual({
    action: 'ws.rules.save',
    payload: {
      sceneId: 'scene',
      targetSceneId: 'scene',
      rule: expect.objectContaining({
        name: '临时丢弃',
        match: { connectionId: unknown.id },
        action: { type: 'drop' },
      }),
    },
  });
});

test('取消和保存连接生成的 WS 草稿后切换页面不会重新打开', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: connection.url, exact: true }).click();
  await page.getByRole('button', { name: '为此连接新建规则' }).click();
  await expect(page.getByLabel('WS 规则名称')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: 'WebSocket' }).click();
  await page.getByRole('button', { name: /WS 规则/ }).click();
  await expect(page.getByLabel('WS 规则名称')).toHaveCount(0);
  await page.locator('nav').getByRole('button', { name: 'WebSocket' }).click();
  await page.getByRole('button', { name: connection.url, exact: true }).click();
  await page.getByRole('button', { name: '为此连接新建规则' }).click();
  await page.getByLabel('WS 规则名称').fill('已保存的连接规则');
  await page.getByRole('button', { name: '保存 WS 规则' }).click();
  const sent = (await messages(page)) as Array<{ action: string; payload: { rule?: typeof rule } }>;
  const saved = sent.filter((item) => item.action === 'ws.rules.save').at(-1)!.payload.rule!;
  await state(page, { rules: [...ws.rules, saved] });
  await expect(page.getByLabel('WS 规则名称')).toHaveCount(0);
  await page.locator('nav').getByRole('button', { name: 'WebSocket' }).click();
  await page.getByRole('button', { name: /WS 规则/ }).click();
  await expect(page.getByLabel('WS 规则名称')).toHaveCount(0);
});

test('WS 二进制、截断和模拟消息明确标记，窄面板无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 920 });
  const binary = {
    ...message,
    id: 'binary',
    original: 'AAECAwQ=',
    effective: undefined,
    encoding: 'base64',
    kind: 'binary',
    outcome: 'original',
    truncated: true,
  };
  await open(page, {
    connections: [{ ...unknown, endpoint: '192.0.2.123:443', warning: '接入前已建立连接，URL 未知。' }],
    messages: { items: [{ ...binary, preview: binary.original }], total: 1 },
    omitted: 12,
  });
  await page.getByRole('button', { name: /服务端 → App 原始/ }).click();
  await page.evaluate((message) => window.postMessage({ type: 'ws.detail', message }, '*'), binary);
  const detail = page.getByRole('region', { name: 'WS 消息详情' });
  await expect(detail).toContainText('Base64 · 只读');
  await expect(detail).toContainText('已截断');
  await expect(detail.getByRole('button', { name: '显示原文' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '已遗漏 12 条记录' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/workbench-ws-narrow.png', fullPage: true });
  await lightTheme(page);
  await page.screenshot({ path: 'artifacts/workbench-ws-messages-light.png', fullPage: true });
  const synthetic = { ...message, id: 'push-1', outcome: 'synthetic', original: '{"price":789}' };
  await state(page, { messages: { items: [{ ...synthetic, preview: synthetic.original }], total: 1 } });
  await page.getByRole('button', { name: /服务端 → App 模拟推送/ }).click();
  await page.evaluate((message) => window.postMessage({ type: 'ws.detail', message }, '*'), synthetic);
  await expect(detail).toContainText('未发送给真实服务器');
  await expect(detail.getByRole('region', { name: '模拟内容' })).toBeVisible();
  await state(page, {
    connections: [{ ...connection, url: 'wss://example.test/' + 'long-path-'.repeat(50) }],
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

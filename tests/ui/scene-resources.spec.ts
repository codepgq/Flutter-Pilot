import { test, expect, type Page } from '@playwright/test';

const summary = (id: string) => ({
  id,
  name: `场景 ${id}`,
  file: `/scenes/${id}/scene.json`,
  directory: `/scenes/${id}`,
  hash: `manifest-${id}`,
  health: 'valid',
  errors: [],
  httpRuleCount: 1,
  wsRuleCount: 1,
  actionCount: 1,
  targetCount: 0,
  enabledHttpRuleCount: 1,
  enabledWsRuleCount: 1,
});
const http = {
  id: 'http',
  name: '订单列表',
  enabled: true,
  priority: 0,
  match: { path: '/orders' },
  mock: { status: 200, headers: {}, body: '' },
};
const ws = {
  id: 'ws',
  name: '订单事件',
  enabled: true,
  priority: 0,
  match: { url: 'wss://api.test/orders' },
  action: { type: 'replace', text: '' },
};
const action = {
  id: 'submit',
  name: '提交订单',
  inputs: { password: { secret: true } },
  stepCount: 1,
  file: '/actions/submit.json',
  hash: 'action',
};
const detail = (id: string) => ({
  ...summary(id),
  version: 1,
  targets: {},
  http: [{ ...http, file: `/scenes/${id}/http/a.json`, hash: 'http-meta', overview: http }],
  ws: [{ ...ws, file: `/scenes/${id}/ws/a.json`, hash: 'ws-meta', overview: ws }],
  actions: [action],
});
const pageData = {
  version: 2,
  revision: 1,
  root: '/scenes/index.json',
  offset: 0,
  limit: 50,
  total: 1000,
  search: '',
  activeSceneId: null,
  scenes: [summary('a'), summary('b')],
};
const base = {
  mode: 'vm',
  rules: [],
  history: { items: [], total: 0 },
  pending: [],
  engine: { status: 'stopped' },
  proxyActive: false,
  lan: false,
  addresses: [],
  devices: [],
  connectionHost: '127.0.0.1',
  workspace: '/project',
  logs: [],
  busy: false,
  selectedSceneId: 'a',
  sceneActions: { running: false, locked: false },
  vm: { status: 'connected', warnings: [], captureEnabled: true },
  ws: {
    status: 'off',
    connections: [],
    rules: [],
    messages: { items: [], total: 0 },
    warnings: [],
    omitted: 0,
  },
  tests: {
    file: '/tests.json',
    catalogue: {
      tests: [
        {
          id: 'order',
          name: '订单测试',
          action: { sceneId: 'off-page', actionId: 'submit' },
          assertionCount: 0,
        },
      ],
    },
    running: false,
    locked: false,
  },
};
async function post(page: Page, message: unknown) {
  await page.evaluate((message) => window.postMessage(message, '*'), message);
}
async function last(page: Page, name: string) {
  await expect
    .poll(() =>
      page.evaluate((name) => (window as any).__messages.filter((m: any) => m.action === name).length, name),
    )
    .toBeGreaterThan(0);
  return page.evaluate(
    (name) => (window as any).__messages.filter((m: any) => m.action === name).at(-1).payload,
    name,
  );
}
async function open(page: Page) {
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => (window as any).__messages.some((m: any) => m.action === 'ready')))
    .toBe(true);
  await post(page, { type: 'state', state: base });
  await post(page, { type: 'scene.page', page: pageData });
  await page
    .getByRole('button', { name: /Mock 场景/ })
    .first()
    .click();
}
async function select(page: Page, id: string) {
  await page.getByRole('button', { name: `查看场景 场景 ${id}` }).click();
  const request = await last(page, 'scenes.select');
  await post(page, { type: 'scene.detail', requestId: request.requestId, version: 1, detail: detail(id) });
  return request;
}
async function respondRule(page: Page, kind: 'http' | 'ws', body: string, token: string) {
  const request = await last(page, 'scenes.resource');
  const value =
    kind === 'http'
      ? { ...http, mock: { ...http.mock, body } }
      : { ...ws, action: { type: 'replace', text: body } };
  await post(page, {
    type: 'scene.resource',
    requestId: request.requestId,
    resource: {
      address: { sceneId: request.sceneId, kind, id: kind },
      value,
      hash: token,
      version: 1,
      files: {},
      file: '/rule.json',
    },
  });
}

test('v2 switches reject stale details, fetch rule bodies and preserve the editor fingerprint', async ({
  page,
}) => {
  await open(page);
  const old = await select(page, 'a');
  await select(page, 'b');
  await post(page, { type: 'scene.detail', requestId: old.requestId, version: 1, detail: detail('a') });
  await expect(page.getByLabel('场景名称')).toHaveValue('场景 b');
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await respondRule(page, 'http', '正文来自独立资源', 'body-fingerprint');
  await expect(page.getByLabel('Body · JSON / 文本')).toHaveValue('正文来自独立资源');
  await page.getByLabel('Body · JSON / 文本').fill('新正文');
  await page.getByText('更多匹配条件', { exact: true }).click();
  await page.getByLabel('请求体字段完全匹配 JSON').fill('{"email":"aaaa@example.test"}');
  await page.getByLabel('请求体字段正则匹配 JSON').fill('{"password":"Demo[0-9]{3}"}');
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  expect(await last(page, 'rules.save')).toMatchObject({
    expectedHash: 'body-fingerprint',
    targetSceneId: 'b',
    rule: {
      mock: { body: '新正文' },
      match: { bodyJson: { email: 'aaaa@example.test' }, bodyRegex: { password: 'Demo[0-9]{3}' } },
    },
  });
  await post(page, { type: 'scene.saved', sceneId: 'b', id: 'http' });
  await expect(page.getByRole('button', { name: '保存规则', exact: true })).toHaveCount(0);
});

test('v2 WS save acknowledgement closes the editor without sending full definitions', async ({ page }) => {
  await open(page);
  await select(page, 'a');
  await page.getByRole('button', { name: '编辑', exact: true }).last().click();
  await respondRule(page, 'ws', '独立 WS 正文', 'ws-fingerprint');
  await expect(page.getByLabel('WS 替换文本')).toHaveValue('独立 WS 正文');
  await page.getByRole('button', { name: '保存 WS 规则' }).click();
  expect(await last(page, 'ws.rules.save')).toMatchObject({
    expectedHash: 'ws-fingerprint',
    targetSceneId: 'a',
  });
  await post(page, { type: 'scene.saved', sceneId: 'a', id: 'ws' });
  await expect(page.getByRole('button', { name: '保存 WS 规则' })).toHaveCount(0);
});

test('v2 paginates/searches and loads test input metadata for an action outside the current page', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  expect(await last(page, 'scenes.query')).toMatchObject({ offset: 50 });
  await page.getByLabel('搜索场景').fill('公共');
  await expect.poll(() => last(page, 'scenes.query')).toMatchObject({ search: '公共', offset: 0 });
  await page
    .getByRole('button', { name: /业务测试/ })
    .first()
    .click();
  await page.getByLabel('选择测试').selectOption('order');
  const request = await last(page, 'tests.action');
  expect(request).toMatchObject({ sceneId: 'off-page', actionId: 'submit' });
  await post(page, { type: 'test.action', ...request, sceneName: '公共操作', action });
  await page.getByLabel('测试参数 password').fill('private-test-input');
  await page.getByRole('button', { name: '运行测试', exact: true }).click();
  expect(await last(page, 'tests.run')).toEqual({
    testId: 'order',
    inputs: { password: 'private-test-input' },
  });
  await expect(page.getByLabel('测试参数 password')).toHaveValue('');
});

async function respondAction(page: Page, request: any, version = 1) {
  await post(page, {
    type: 'scene.resource',
    requestId: request.requestId,
    resource: {
      address: { sceneId: request.sceneId, kind: 'actions', id: 'submit' },
      value: {
        id: 'submit',
        name: '提交订单',
        inputs: action.inputs,
        steps: [{ id: 'hide', type: 'hide_keyboard' }],
      },
      hash: `action-${version}`,
      version,
      files: {},
      file: '/actions/submit.json',
    },
  });
}

test('v2 reloads the selected action after details refresh and shows dependency failures', async ({
  page,
}) => {
  await open(page);
  const selection = await select(page, 'a');
  await page.getByLabel('选择场景操作').selectOption('submit');
  const first = await last(page, 'scenes.resource');
  await respondAction(page, first);
  await expect(page.getByRole('button', { name: '运行操作', exact: true })).toBeEnabled();
  await expect(page.getByText('查看操作步骤（1）', { exact: true })).toBeVisible();
  await post(page, { type: 'scene.page', page: { ...pageData, revision: 2 } });
  await post(page, {
    type: 'scene.detail',
    requestId: selection.requestId,
    version: 2,
    detail: { ...detail('a'), version: 2 },
  });
  await expect.poll(async () => (await last(page, 'scenes.resource')).requestId).not.toBe(first.requestId);
  const refreshed = await last(page, 'scenes.resource');
  await expect(page.getByRole('button', { name: '运行操作', exact: true })).toBeDisabled();
  await respondAction(page, refreshed, 2);
  await expect(page.getByRole('button', { name: '运行操作', exact: true })).toBeEnabled();
  await expect(page.getByText('查看操作步骤（1）', { exact: true })).toBeVisible();
  await post(page, {
    type: 'scene.detail',
    requestId: selection.requestId,
    version: 2,
    detail: { ...detail('a'), version: 2, actions: [{ ...action, blocked: '依赖不可用：deleted/action' }] },
  });
  await expect(page.getByRole('alert')).toContainText('依赖不可用：deleted/action');
  await expect(page.getByRole('button', { name: '运行操作', exact: true })).toBeDisabled();
});

test('v2 search preserves typing while IPC is delayed and rejects reversed query responses', async ({
  page,
}) => {
  await open(page);
  const input = page.getByLabel('搜索场景');
  await input.pressSequentially('orders', { delay: 10 });
  await expect(input).toHaveValue('orders');
  await expect.poll(async () => (await last(page, 'scenes.query')).search).toBe('orders');
  const old = await last(page, 'scenes.query');
  await input.fill('payments');
  await expect.poll(async () => (await last(page, 'scenes.query')).search).toBe('payments');
  const latest = await last(page, 'scenes.query');
  expect(latest.requestId).toBeGreaterThan(old.requestId);
  await post(page, {
    type: 'scene.page',
    requestId: latest.requestId,
    page: { ...pageData, search: 'payments', scenes: [summary('payments')] },
  });
  await expect(page.getByRole('button', { name: '查看场景 场景 payments' })).toBeVisible();
  await post(page, {
    type: 'scene.page',
    requestId: old.requestId,
    page: { ...pageData, search: 'orders', scenes: [summary('orders')] },
  });
  await expect(input).toHaveValue('payments');
  await expect(page.getByRole('button', { name: '查看场景 场景 payments' })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看场景 场景 orders' })).toHaveCount(0);
});

test('v2 closing a Scene cancels rule responses still in flight', async ({ page }) => {
  await open(page);
  await select(page, 'a');
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await page.getByLabel('关闭场景详情').click();
  await respondRule(page, 'http', 'late body', 'late-token');
  const selection = await select(page, 'a');
  await expect(page.getByLabel('场景名称')).toHaveValue('场景 a');
  await expect(page.getByLabel('Body · JSON / 文本')).toHaveCount(0);
  await page.getByLabel('关闭场景详情').click();
  // The host can select a newly created Scene without another explicit selection request.
  await post(page, { type: 'state', state: { ...base, selectedSceneId: 'created' } });
  await post(page, {
    type: 'scene.detail',
    requestId: selection.requestId,
    version: 1,
    detail: detail('created'),
  });
  await expect(page.getByLabel('场景名称')).toHaveValue('场景 created');
});

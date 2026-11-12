import { test, expect, type Page } from '@playwright/test';
const http = {
  id: 'http',
  name: '订单列表',
  enabled: true,
  priority: 0,
  match: { method: 'GET', host: 'api.test', path: '/orders' },
  mock: { status: 200, headers: {}, body: '[]' },
};
const ws = {
  id: 'ws',
  name: '订单事件',
  enabled: true,
  priority: 0,
  match: { url: 'wss://api.test/orders' },
  action: { type: 'drop' },
};
const scene = { id: 'default', name: '默认场景', httpRules: [http], wsRules: [ws] };
const fixture = {
  mode: 'vm',
  rules: [http],
  scenes: {
    version: 1,
    activeSceneId: 'default',
    scenes: [scene, { id: 'other', name: '下单失败', httpRules: [], wsRules: [] }],
  },
  selectedSceneId: 'default',
  sceneRuntime: { revision: 1, http: { status: 'applied' }, ws: { status: 'pending', message: '待连接' } },
  history: { items: [], total: 0 },
  apis: [],
  pending: [],
  engine: { status: 'stopped' },
  proxyActive: false,
  vm: {
    status: 'connected',
    isolates: 1,
    instances: 1,
    recorded: 0,
    mockEnabled: true,
    captureEnabled: true,
    warnings: [],
  },
  ws: {
    status: 'off',
    captureEnabled: false,
    mockEnabled: false,
    connections: [],
    rules: [ws],
    messages: { items: [], total: 0 },
    omitted: 0,
    warnings: [],
  },
  lan: false,
  addresses: [],
  devices: [],
  connectionHost: '127.0.0.1',
  workspace: '/workspace/test',
  logs: [],
  busy: false,
};
async function state(page: Page, overrides = {}) {
  await page.evaluate((state) => window.postMessage({ type: 'state', state }, '*'), {
    ...fixture,
    ...overrides,
  });
}
async function messages(page: Page) {
  return page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages);
}
async function open(page: Page, overrides = {}) {
  await page.goto('/');
  await state(page, overrides);
  await page.getByRole('button', { name: 'Mock 场景', exact: false }).first().click();
}

test('默认展示场景列表，浏览详情与激活分开', async ({ page }) => {
  await open(page);
  const list = page.getByRole('region', { name: '场景列表' });
  await expect(list.getByRole('button', { name: '查看场景 默认场景' })).toContainText('已激活');
  await expect(list.getByRole('button', { name: '查看场景 默认场景' })).toContainText('HTTP 1 / WS 1');
  await expect(list.getByRole('button', { name: '查看场景 下单失败' })).toContainText('HTTP 0 / WS 0');
  await expect(page.getByRole('region', { name: '场景详情' })).toHaveCount(0);
  await page.getByRole('button', { name: '查看场景 默认场景' }).click();
  await expect(page.getByRole('heading', { name: /HTTP 规则/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'WS 消息规则' })).toBeVisible();
  await expect(page.getByRole('region', { name: '场景运行状态' })).toContainText('尚未全部应用');
  await page.getByRole('button', { name: '查看场景 下单失败' }).click();
  expect(await messages(page)).toContainEqual({ action: 'scenes.select', payload: { id: 'other' } });
  expect(await messages(page)).not.toContainEqual({ action: 'scenes.activate', payload: { id: 'other' } });
  await state(page, { selectedSceneId: 'other' });
  await expect(page.getByLabel('场景名称')).toHaveValue('下单失败');
  await page.getByRole('button', { name: '激活此场景', exact: true }).click();
  expect(await messages(page)).toContainEqual({ action: 'scenes.activate', payload: { id: 'other' } });
});

test('场景列表开关控制激活状态，规则开关保持独立', async ({ page }) => {
  await open(page);
  const activeSwitch = page.getByRole('switch', { name: '启用场景 默认场景' });
  const otherSwitch = page.getByRole('switch', { name: '启用场景 下单失败' });
  await expect(activeSwitch).toBeChecked();
  await expect(otherSwitch).not.toBeChecked();

  await otherSwitch.click();
  expect(await messages(page)).toContainEqual({ action: 'scenes.activate', payload: { id: 'other' } });
  await expect(page.getByRole('region', { name: '场景详情' })).toHaveCount(0);
  expect(await messages(page)).not.toContainEqual({ action: 'scenes.select', payload: { id: 'other' } });

  await state(page, { scenes: { ...fixture.scenes, activeSceneId: 'other' } });
  await expect(activeSwitch).not.toBeChecked();
  await expect(otherSwitch).toBeChecked();
  await otherSwitch.click();
  expect(await messages(page)).toContainEqual({ action: 'scenes.deactivate', payload: {} });
  await expect(page.getByRole('region', { name: '场景详情' })).toHaveCount(0);

  await page.getByRole('button', { name: '查看场景 默认场景' }).click();
  await expect(page.getByRole('switch', { name: '启用 订单列表' })).toBeChecked();
  await state(page, { busy: true });
  await expect(activeSwitch).toBeDisabled();
  await expect(otherSwitch).toBeDisabled();
});

test('场景数据异步到达时仍默认显示列表', async ({ page }) => {
  await open(page, { scenes: { version: 1, activeSceneId: null, scenes: [] }, selectedSceneId: undefined });
  await state(page);
  await expect(page.getByRole('button', { name: '查看场景 默认场景' })).toBeVisible();
  await expect(page.getByRole('region', { name: '场景详情' })).toHaveCount(0);
});

test('场景创建、重命名、复制、删除与停用入口', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '新建场景', exact: true }).click();
  await page.getByRole('button', { name: '查看场景 默认场景' }).click();
  await page.getByLabel('场景名称').fill('账户异常');
  await page.getByRole('button', { name: '保存名称' }).click();
  await page.getByRole('button', { name: '复制场景', exact: true }).click();
  await page.getByRole('button', { name: '删除场景', exact: true }).click();
  await page.getByRole('button', { name: '停用场景', exact: true }).click();
  expect(await messages(page)).toEqual(
    expect.arrayContaining([
      { action: 'scenes.create', payload: { name: '新场景' } },
      { action: 'scenes.rename', payload: { id: 'default', name: '账户异常' } },
      { action: 'scenes.duplicate', payload: { id: 'default' } },
      { action: 'scenes.delete', payload: { id: 'default' } },
      { action: 'scenes.deactivate', payload: {} },
    ]),
  );
});

test('新建场景后自动打开新场景详情', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '新建场景', exact: true }).click();
  const created = { id: 'new', name: '新场景', httpRules: [], wsRules: [] };
  await state(page, {
    scenes: { ...fixture.scenes, scenes: [...fixture.scenes.scenes, created] },
    selectedSceneId: 'new',
  });
  await expect(page.getByLabel('场景名称')).toHaveValue('新场景');
  await expect(page.getByRole('button', { name: '查看场景 新场景' })).toHaveAttribute('aria-pressed', 'true');
});

test('规则保存携带目标场景，失败保留 HTTP 草稿', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '查看场景 默认场景' }).click();
  await page.getByRole('button', { name: '新建规则', exact: true }).click();
  await page.getByLabel('规则名称', { exact: true }).fill('新接口');
  await expect(page.getByLabel('保存到场景', { exact: true })).toHaveValue('default');
  await page.getByLabel('保存到场景', { exact: true }).selectOption('other');
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'rules.save',
    payload: {
      sceneId: 'default',
      targetSceneId: 'other',
      rule: expect.objectContaining({ name: '新接口' }),
    },
  });
  await state(page, { lastError: '场景文件已被修改，请先读取项目文件' });
  await expect(page.getByLabel('规则名称', { exact: true })).toHaveValue('新接口');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '新建 WS 规则', exact: true }).click();
  await page.getByLabel('WS 规则名称').fill('新事件');
  await page.getByLabel('WS 连接 URL').fill('wss://api.test/events');
  await expect(page.getByLabel('WS 保存到场景')).toHaveValue('default');
  await page.getByLabel('WS 保存到场景').selectOption('other');
  await page.getByRole('button', { name: '保存 WS 规则', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'ws.rules.save',
    payload: {
      sceneId: 'default',
      targetSceneId: 'other',
      rule: expect.objectContaining({ name: '新事件' }),
    },
  });
});

test('连接与 WebSocket 页面统一跳转场景，保留采集', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await expect(page.getByRole('switch', { name: '开启运行时 Dio Mock' })).toHaveCount(0);
  await page.getByRole('button', { name: '管理 Mock 场景' }).click();
  await expect(page.getByRole('region', { name: '场景列表' })).toBeVisible();
  await page.getByRole('button', { name: 'WebSocket', exact: false }).click();
  await expect(page.getByRole('switch', { name: 'WS Mock', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '开启 WS 采集' }).click();
  expect(await messages(page)).toContainEqual({ action: 'ws.capture', payload: { enabled: true } });
  await page.getByRole('button', { name: /WS 规则/ }).click();
  await expect(page.getByRole('region', { name: '场景列表' })).toBeVisible();
});

test('历史规则筛选跨场景保留，删除规则后仍显示准确 ID', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await page.getByRole('button', { name: '请求历史', exact: false }).first().click();
  await page.getByRole('button', { name: /筛选/ }).click();
  await page.getByLabel('筛选命中规则').selectOption('http');
  const inactive = { ...fixture.scenes, activeSceneId: 'other' };
  await state(page, { scenes: inactive, rules: [] });
  await expect(page.getByLabel('筛选命中规则')).toHaveValue('http');
  await expect(page.getByLabel('筛选命中规则').locator('option:checked')).toHaveText('订单列表');
  await state(page, { scenes: { ...inactive, scenes: inactive.scenes.slice(1) }, rules: [] });
  await expect(page.getByLabel('筛选命中规则').locator('option:checked')).toHaveText('已删除规则（http）');
  await expect
    .poll(() => messages(page))
    .toContainEqual({
      action: 'history.query',
      payload: expect.objectContaining({ ruleId: 'http' }),
    });
});

for (const width of [1280, 390])
  test(`场景页面 ${width}px 无横向溢出并明确展示分域错误`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, {
      sceneRuntime: {
        revision: 2,
        http: { status: 'applied' },
        ws: { status: 'error', message: '旧租约尚未到期，请等待后重试。' },
      },
    });
    await expect(page.getByRole('region', { name: '场景运行状态' })).toContainText('WS：失败');
    await expect(page.getByRole('region', { name: '场景运行状态' })).toContainText('尚未全部应用');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '查看场景 默认场景' }).click();
    await expect(page.getByRole('region', { name: '场景详情' })).toBeVisible();
    if (width <= 760)
      await expect(page.getByRole('region', { name: '场景列表', includeHidden: true })).toBeHidden();
    else await expect(page.getByRole('region', { name: '场景列表' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/scenes-detail-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: '关闭场景详情' }).click();
    await expect(page.getByRole('region', { name: '场景详情' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '场景列表' })).toBeVisible();
    await page.screenshot({ path: `artifacts/scenes-${width}.png`, fullPage: true });
  });

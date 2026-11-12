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
  mode: 'proxy',
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
    state: {
      ...fixture,
      ...overrides,
      scenes: {
        version: 1,
        activeSceneId: 'scene',
        scenes: [
          {
            id: 'scene',
            name: '默认场景',
            httpRules: (overrides as { rules?: unknown[] }).rules ?? fixture.rules,
            wsRules: [],
          },
        ],
      },
      selectedSceneId: 'scene',
    },
    selected,
  });
}
async function messages(page: Page) {
  return page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages);
}
test('设置和本地引擎入口使用原生命令链接，不向扩展宿主请求打开设置', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await page.getByText('工作区与连接', { exact: true }).click();
  const settings = page.getByRole('link', { name: '设置', exact: true });
  const href = await settings.getAttribute('href');
  expect(href?.split('?')[0]).toBe('command:workbench.action.openSettings');
  expect(JSON.parse(decodeURIComponent(href!.split('?')[1]))).toEqual(['@ext:flutter-pilot.flutter-pilot']);
  // Chromium has no IDE command handler; stop navigation after React handlers have run.
  await page.evaluate(() => document.addEventListener('click', (event) => event.preventDefault()));
  await settings.click();
  await page.getByRole('button', { name: '连接与诊断', exact: true }).click();
  const engine = page.getByRole('link', { name: '选择本地引擎', exact: true });
  await expect(engine).toHaveAttribute('href', href!);
  await engine.click();
  expect(await messages(page)).not.toContainEqual({ action: 'settings.open', payload: {} });
});
test('项目绑定展示 UUID 并打开配置、规则和读取项目文件', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 920 });
  await page.goto('/');
  const project = {
    id: 'edb038d8-0a2a-4b1f-a974-d39e1a5af278',
    name: 'commerce_app_'.repeat(15),
    configPath: '/workspace/.flutter-pilot/project.json',
    rulesPath: '/workspace/.flutter-pilot/rules.json',
  };
  await state(page, { project });
  const card = page.getByRole('region', { name: '当前绑定项目' });
  await card.getByText('项目配置与规则文件', { exact: true }).click();
  await expect(card).toContainText(project.id);
  await expect(card).toContainText(project.name);
  await card.getByRole('button', { name: '项目配置', exact: true }).click();
  await card.getByRole('button', { name: '规则文件', exact: true }).click();
  await card.getByRole('button', { name: '读取项目文件', exact: true }).click();
  expect(await messages(page)).toEqual(
    expect.arrayContaining([
      { action: 'project.open', payload: { kind: 'config' } },
      { action: 'project.open', payload: { kind: 'rules' } },
      { action: 'project.reload', payload: {} },
    ]),
  );
  await state(page, { project: { ...project, notice: '项目文件已读取，规则已同步' } });
  await expect(card.getByRole('status')).toContainText('规则已同步');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/workbench-project-binding.png', fullPage: true });
});
test('规则启停只显示 switch，支持鼠标和键盘，繁忙时禁用', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await page.getByRole('button', { name: 'Mock 场景' }).click();
  const toggle = page.getByRole('switch', { name: `启用 ${rule.name}`, exact: true });
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveText('');
  await toggle.click();
  expect(await messages(page)).toContainEqual({
    action: 'rules.toggle',
    payload: { id: rule.id, sceneId: 'scene' },
  });
  await state(page, { rules: [{ ...rule, enabled: false }] });
  await expect(toggle).not.toBeChecked();
  await toggle.focus();
  const before = (await messages(page)).length;
  await page.keyboard.press('Space');
  expect((await messages(page)).slice(before)).toContainEqual({
    action: 'rules.toggle',
    payload: { id: rule.id, sceneId: 'scene' },
  });
  await page.screenshot({ path: 'artifacts/rule-switch-dark.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 680, height: 920 });
  await page.evaluate(() => {
    const style = document.documentElement.style;
    style.setProperty('--vscode-editor-background', '#fafafa');
    style.setProperty('--vscode-editor-foreground', '#252b33');
    style.setProperty('--vscode-sideBar-background', '#f1f3f5');
    style.setProperty('--vscode-input-background', '#ffffff');
    style.setProperty('--vscode-panel-background', '#ffffff');
    style.setProperty('--vscode-panel-border', '#d7dde3');
    style.setProperty('--vscode-descriptionForeground', '#637181');
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/rule-switch-narrow.png', fullPage: true, animations: 'disabled' });
  await state(page, { busy: true });
  await expect(toggle).toBeDisabled();
});
test('规则卡片紧凑布局与长地址在桌面和窄窗口可用', async ({ page }) => {
  await page.goto('/');
  await state(page, {
    rules: [
      {
        ...rule,
        name: '当前账号模拟为 Market Maker',
        match: { ...rule.match, path: '/api/v1/user/info/' + 'long-path/'.repeat(20) },
      },
      { ...rule, id: 'second', name: 'PD配置重定向至临时接口' },
    ],
  });
  await page.getByRole('button', { name: 'Mock 场景' }).click();
  for (const width of [1280, 680, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const card = page.locator('.rule-card').first();
    const bounds = await card.boundingBox();
    expect(bounds!.height).toBeLessThanOrEqual(width === 390 ? 125 : 85);
    await expect(card.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
    expect(await card.locator('code').getAttribute('title')).toContain('long-path/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: `artifacts/rules-compact-${width}.png`, fullPage: true });
  }
});
test('连接引导、代理控制与局域网开关', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await expect(page.getByRole('heading', { name: '连接与诊断' })).toBeVisible();
  await page.getByText('工作区与连接', { exact: true }).click();
  await page.getByRole('button', { name: '停止代理', exact: true }).click();
  await page.getByText('工作区与连接', { exact: true }).click();
  expect(await messages(page)).toContainEqual({ action: 'stop', payload: {} });
  await page.getByRole('switch').click();
  expect(await messages(page)).toContainEqual({ action: 'setLan', payload: { enabled: true } });
  await page.screenshot({ path: 'artifacts/workbench-connection.png', fullPage: true });
});
test('转发规则支持路径及完整 URL 并说明凭证保留', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await page.getByRole('button', { name: 'Mock 场景' }).click();
  for (const target of ['/api/private/new', 'https://target.example.test/private?x=1']) {
    await page.getByRole('button', { name: '新建规则' }).click();
    await page.getByLabel('规则名称', { exact: true }).fill('私有接口转发');
    await page.getByLabel('规则动作', { exact: true }).selectOption('redirect');
    await page.getByLabel('目标地址', { exact: true }).fill(target);
    await expect(page.getByText('发送真实请求，保留方法、正文及', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '保存规则' }).click();
    expect(await messages(page)).toContainEqual({
      action: 'rules.save',
      payload: {
        rule: expect.objectContaining({ redirect: { url: target } }),
        sceneId: 'scene',
        targetSceneId: 'scene',
      },
    });
    await page.getByRole('button', { name: '取消', exact: true }).click();
  }
});
test('规则表单校验、JSON编辑与 CRUD 消息', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await page.getByRole('button', { name: 'Mock 场景' }).click();
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
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '完整 JSON', exact: true }).click();
  await expect(page.getByLabel('规则 JSON', { exact: true })).toContainText('订单列表');
  await page.screenshot({ path: 'artifacts/workbench-rule-editor.png', fullPage: true });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'rules.duplicate',
    payload: { id: 'orders', sceneId: 'scene' },
  });
  expect(await messages(page)).toContainEqual({
    action: 'rules.delete',
    payload: { id: 'orders', sceneId: 'scene' },
  });
});
test('历史详情、对比、生成规则及备注', async ({ page }) => {
  await page.goto('/');
  await state(page, {}, entry);
  await page.getByRole('button', { name: '请求历史' }).click();
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
  await page.getByRole('button', { name: 'Mock 场景' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/workbench-narrow-light.png', fullPage: true });
});

test('仅改请求头保留正文，关闭全部断点仍可保存 Mock', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await page.getByRole('button', { name: 'Mock 场景' }).click();
  await page.getByText('规则模板与说明', { exact: true }).click();
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
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await state(page, { rules: [{ ...rule, breakpoint: { request: true, response: false, timeout: 60 } }] });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('请求发送前暂停').uncheck();
  await page.getByRole('button', { name: '保存规则' }).click();
  const savedRule = ((await messages(page)) as { action: string; payload: { rule?: unknown } }[])
    .filter((message) => message.action === 'rules.save')
    .at(-1)!.payload.rule;
  await state(page, { rules: [savedRule] });
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const all = (await messages(page)) as typeof sent;
  expect(all.filter((m) => m.action === 'rules.save').at(-1)?.payload.rule).not.toHaveProperty('breakpoint');
});

test('显示自动后台记录状态与关闭工作台后的行为', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await expect(page.getByText('自动记录中', { exact: true })).toBeVisible();
  await page.getByText('工作区与连接', { exact: true }).click();
  await expect(page.getByText('后台记录中 · 关闭工作台继续记录', { exact: true })).toBeVisible();
  await page.getByText('工作区与连接', { exact: true }).click();
  await page.getByRole('button', { name: '断点队列' }).click();
  await page.getByText('断点使用说明', { exact: true }).click();
  await expect(
    page.getByText('工作台打开时可处理手动断点；关闭后自动跳过人工暂停，继续后台记录和自动规则。'),
  ).toBeVisible();
});

test('请求历史为空仍保留独立 API 目录与累计调用统计', async ({ page }) => {
  await page.goto('/');
  await state(page, {
    history: { items: [], total: 0 },
    apis: [{ ...fixture.apis[0], count: 12, firstAt: Date.now() - 86400000 }],
  });
  await page.getByRole('button', { name: 'API 请求' }).click();
  const api = page.getByRole('button', { name: '查看 API GET api.example.test/v1/orders', exact: true });
  await expect(api).toBeVisible();
  await expect(api).toContainText('12 次');
  await expect(api).toHaveAttribute('title', /首次发现：[\s\S]*最近调用：/);
  await expect(page.locator('.request-row:visible')).toHaveCount(0);
  await api.click();
  await expect(page.getByRole('heading', { name: '该 API 暂无请求历史' })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看调用历史', exact: true })).toBeVisible();
  expect(await messages(page)).toContainEqual({
    action: 'api.select',
    payload: { method: 'GET', host: 'api.example.test', path: '/v1/orders' },
  });
  await page.getByRole('button', { name: '请求历史' }).click();
  await expect(page.getByRole('heading', { name: '暂无请求历史' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^查看 API / })).toHaveCount(0);
});

test('清空记录常驻历史页，筛选结果为空仍可清空全部历史，繁忙时禁用', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await page.getByRole('button', { name: '请求历史' }).click();
  const clear = page.getByRole('button', { name: '清空记录', exact: true });
  await expect(clear).toBeVisible();
  await expect(page.getByLabel('筛选状态码')).not.toBeVisible();
  await expect(clear).toHaveAttribute('title', /全部 HTTP.*包含筛选外记录.*保留 API 目录和 Mock 规则/);
  await page.getByRole('textbox', { name: '搜索请求', exact: true }).fill('no-matching-records');
  await state(page, { history: { items: [], total: 0 } });
  await clear.click();
  expect(await messages(page)).toContainEqual({ action: 'history.clear', payload: {} });
  await state(page, { busy: true });
  await expect(clear).toBeDisabled();
  await page.getByRole('button', { name: 'API 请求' }).click();
  await expect(page.getByRole('button', { name: /^查看 API / })).toHaveCount(1);
  await expect(clear).not.toBeVisible();
});

for (const width of [1280, 760, 680, 390]) {
  test(`请求历史在 ${width}px 下全宽展示，点击详情后可返回列表`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const records = Array.from({ length: 18 }, (_, i) => ({
      ...entry,
      id: `compact-${i}`,
      path: `/webapp/common/${'very-long-path/'.repeat(i === 0 ? 20 : 1)}${i}.png`,
      host: 'exio-cms-dev.oss-ap-southeast-1.aliyuncs.com',
      startedAt: entry.startedAt - i * 1000,
    }));
    const overrides = { history: { items: records, total: records.length } };
    await state(page, overrides);
    await page.getByRole('button', { name: '请求历史' }).click();
    const rows = page.locator('.request-row');
    const list = page.locator('.request-list');
    await expect(rows).toHaveCount(18);
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    const pane = await list.boundingBox();
    expect(pane!.width).toBeGreaterThanOrEqual(width - 4);
    expect(first!.height).toBeLessThanOrEqual(68);
    expect(first!.height).toBe(second!.height);
    await expect(page.locator('.request-detail')).not.toBeVisible();
    await expect(rows.nth(0).locator('strong')).toHaveAttribute('title', entry.url);
    expect(
      await rows
        .nth(0)
        .locator('strong')
        .evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    const tenth = await rows.nth(9).boundingBox();
    expect(tenth!.y + tenth!.height).toBeLessThanOrEqual(pane!.y + pane!.height);
    expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/http-layout-${width}.png`, fullPage: true });
    await rows.nth(0).click();
    expect(await messages(page)).toContainEqual({ action: 'history.select', payload: { id: 'compact-0' } });
    await state(page, overrides, records[0]);
    await expect(page.getByRole('region', { name: '最终响应', exact: true })).toBeVisible();
    if (width <= 760) await expect(list).not.toBeVisible();
    else await expect(list).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(list).toBeVisible();
    await expect(page.locator('.request-detail')).not.toBeVisible();
    expect((await list.boundingBox())!.width).toBeGreaterThanOrEqual(width - 4);
  });

  test(`API 请求在 ${width}px 下紧凑全宽展示，点击查看最新请求详情`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const apis = Array.from({ length: 18 }, (_, i) => ({
      ...fixture.apis[0],
      path: i === 0 ? entry.path : `/v1/products/${'long-path/'.repeat(8)}${i}`,
      count: 47 - i,
      firstAt: entry.startedAt - 86400000,
      lastAt: entry.startedAt - i * 1000,
    }));
    const overrides = { apis };
    await state(page, overrides);
    await page.getByRole('button', { name: 'API 请求' }).click();
    const list = page.locator('.api-sidebar');
    const rows = page.getByRole('button', { name: /^查看 API / });
    await expect(rows).toHaveCount(18);
    await expect(page.locator('.request-row:visible')).toHaveCount(0);
    const pane = await list.boundingBox();
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    expect(pane!.width).toBeGreaterThanOrEqual(width - 4);
    expect(first!.height).toBeLessThanOrEqual(68);
    expect(second!.height).toBeLessThanOrEqual(68);
    const tenth = await rows.nth(9).boundingBox();
    expect(tenth!.y + tenth!.height).toBeLessThanOrEqual(pane!.y + pane!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/api-layout-${width}.png`, fullPage: true });
    await rows.nth(0).click();
    expect(await messages(page)).toContainEqual({
      action: 'api.select',
      payload: { method: 'GET', host: entry.host, path: entry.path },
    });
    await state(page, overrides, entry);
    await expect(page.getByRole('region', { name: '最终响应', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '查看调用历史', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(list).toBeVisible();
    expect((await list.boundingBox())!.width).toBeGreaterThanOrEqual(width - 4);
  });
}

test('API 规则 tag 随启停、修改和删除更新，清空历史不影响配置状态', async ({ page }) => {
  await page.goto('/');
  const redirect = {
    ...rule,
    id: 'redirect',
    name: '订单转发',
    priority: 20,
    mock: undefined,
    redirect: { url: '/v2/orders' },
  };
  const conditional = {
    ...rule,
    id: 'conditional',
    name: '第一页订单',
    match: { ...rule.match, query: { page: '1' } },
  };
  const overrides = { rules: [rule, redirect, conditional], history: { items: [], total: 0 } };
  await state(page, overrides);
  await page.getByRole('button', { name: 'API 请求' }).click();
  const api = page.getByRole('button', { name: `查看 API GET ${entry.host}${entry.path}`, exact: true });
  await expect(api.locator('.api-rule-tag')).toHaveText('转发');
  await expect(api.locator('.api-rule-tag')).toHaveAttribute('title', /订单转发/);
  await expect(api.locator('.api-rule-more')).toHaveText('+2');
  await expect(api.locator('.api-rule-more')).toHaveAttribute('title', /第一页订单.*需满足查询参数：page/s);
  await api.click();
  const detail = page.locator('.api-detail-overview');
  await expect(detail.locator('.api-rule-tag')).toHaveText(['转发', 'Mock', 'Mock · 条件']);
  await state(page, { ...overrides, rules: [{ ...rule, enabled: false }, redirect] });
  await expect(detail.locator('.api-rule-tag')).toHaveText(['转发']);
  await expect(api.locator('.api-rule-more')).toHaveCount(0);
  await state(page, { ...overrides, rules: [{ ...redirect, match: { path: '/other' } }] });
  await expect(api.locator('.api-rule-tags')).toHaveCount(0);
  await expect(detail.locator('.api-rule-tags')).toHaveCount(0);
  await state(page, { ...overrides, rules: [] });
  await expect(api.locator('.api-rule-tags')).toHaveCount(0);
});

test('API 规则 tag 在桌面和窄窗口保持紧凑且不溢出', async ({ page }) => {
  await page.goto('/');
  await state(page, {
    rules: [{ ...rule, match: { ...rule.match, query: { page: '1' } } }],
    apis: [fixture.apis[0], { ...fixture.apis[0], path: '/v1/other' }],
  });
  await page.getByRole('button', { name: 'API 请求' }).click();
  for (const width of [1280, 680, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const row = page.locator('.api-group').first();
    const tag = row.locator('.api-rule-tag');
    await expect(tag).toHaveText('Mock · 条件');
    await expect(tag).toBeVisible();
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(68);
    const rowBounds = (await row.boundingBox())!;
    const tagBounds = (await tag.boundingBox())!;
    expect(tagBounds.x + tagBounds.width).toBeLessThan(rowBounds.x + rowBounds.width - 20);
    await expect(page.locator('.api-group').nth(1).locator('.api-rule-tags')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/api-rule-tags-${width}.png`, fullPage: true });
  }
});

test('目录删除只发送移除目录消息，保留请求历史', async ({ page }) => {
  await page.goto('/');
  await state(page);
  await page.getByRole('button', { name: 'API 请求' }).click();
  const api = page.getByRole('button', { name: '查看 API GET api.example.test/v1/orders', exact: true });
  const before = (await messages(page)).length;
  await page.getByRole('button', { name: '删除 API GET api.example.test/v1/orders', exact: true }).click();
  expect((await messages(page)).slice(before)).toEqual([
    { action: 'api.delete', payload: { method: 'GET', host: 'api.example.test', path: '/v1/orders' } },
  ]);
  await expect(api).toHaveAttribute('aria-pressed', 'false');
  await state(page, { apis: [] });
  await expect(api).not.toBeVisible();
  await page.getByRole('button', { name: '请求历史' }).click();
  await expect(page.locator('.request-row')).toHaveCount(1);
});

test('API 目录和请求历史各自按最近时间倒序，乱序输入也保持新到旧', async ({ page }) => {
  await page.goto('/');
  const time = Date.now();
  const records = [
    { ...entry, id: 'older', path: '/v1/older', startedAt: time - 20000 },
    { ...entry, id: 'latest', path: '/v1/latest', startedAt: time },
    { ...entry, id: 'middle', path: '/v1/middle', startedAt: time - 10000 },
  ];
  await state(page, {
    history: { items: records, total: records.length },
    apis: records.map((record) => ({
      method: record.method,
      host: record.host,
      path: record.path,
      count: 1,
      lastAt: record.startedAt,
    })),
  });
  await page.getByRole('button', { name: 'API 请求' }).click();
  const catalog = page.getByRole('button', { name: /^查看 API / });
  await expect(catalog).toHaveCount(3);
  await expect(catalog.nth(0)).toHaveAttribute('aria-label', '查看 API GET api.example.test/v1/latest');
  await expect(catalog.nth(1)).toHaveAttribute('aria-label', '查看 API GET api.example.test/v1/middle');
  await expect(catalog.nth(2)).toHaveAttribute('aria-label', '查看 API GET api.example.test/v1/older');
  await page.getByRole('button', { name: '请求历史' }).click();
  const requests = page.locator('.request-row');
  await expect(requests.nth(0)).toContainText('/v1/latest');
  await expect(requests.nth(1)).toContainText('/v1/middle');
  await expect(requests.nth(2)).toContainText('/v1/older');
  await requests.nth(0).click();
  expect(await messages(page)).toContainEqual({ action: 'history.select', payload: { id: 'latest' } });
});

test('API 搜索和方法独立筛选，从详情进入历史时按该 API 查询', async ({ page }) => {
  await page.goto('/');
  await state(page, {
    apis: [fixture.apis[0], { ...fixture.apis[0], method: 'POST', path: '/v1/submit' }],
  });
  await page.getByRole('button', { name: 'API 请求' }).click();
  const api = page.getByRole('button', { name: '查看 API GET api.example.test/v1/orders', exact: true });
  await page.getByRole('textbox', { name: '搜索 API 目录', exact: true }).fill('orders');
  await page.getByLabel('筛选 API 方法', { exact: true }).selectOption('GET');
  await expect(page.getByRole('button', { name: /^查看 API / })).toHaveCount(1);
  const before = (await messages(page)).length;
  await api.click();
  expect((await messages(page)).slice(before)).toContainEqual({
    action: 'api.select',
    payload: { method: 'GET', host: 'api.example.test', path: '/v1/orders' },
  });
  expect((await messages(page)).slice(before)).not.toContainEqual(
    expect.objectContaining({ action: 'history.query' }),
  );
  await state(page, {}, entry);
  await page.getByRole('button', { name: '查看调用历史', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索请求', exact: true })).toBeVisible();
  await expect
    .poll(() => messages(page))
    .toContainEqual({
      action: 'history.query',
      payload: { method: 'GET', host: 'api.example.test', path: '/v1/orders', offset: 0 },
    });
  await page.getByRole('button', { name: 'API 请求' }).click();
  await expect(page.getByRole('textbox', { name: '搜索 API 目录', exact: true })).toHaveValue('orders');
  await expect(page.getByLabel('筛选 API 方法', { exact: true })).toHaveValue('GET');
});

test('浏览 API 详情保留请求历史的搜索条件和分页', async ({ page }) => {
  await page.goto('/');
  await state(page, { history: { items: [entry], total: 65 } });
  await page.getByRole('button', { name: '请求历史' }).click();
  await page.getByRole('textbox', { name: '搜索请求', exact: true }).fill('/orders');
  await page.getByLabel('筛选请求方法', { exact: true }).selectOption('GET');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  const expectedQuery = { search: '/orders', method: 'GET', offset: 30 };
  await expect.poll(() => messages(page)).toContainEqual({ action: 'history.query', payload: expectedQuery });
  await page.getByRole('button', { name: 'API 请求' }).click();
  const before = (await messages(page)).length;
  await page.getByRole('button', { name: '查看 API GET api.example.test/v1/orders', exact: true }).click();
  expect((await messages(page)).slice(before)).toEqual([
    { action: 'api.select', payload: { method: 'GET', host: 'api.example.test', path: '/v1/orders' } },
  ]);
  await page.getByRole('button', { name: '请求历史' }).click();
  await expect(page.getByRole('textbox', { name: '搜索请求', exact: true })).toHaveValue('/orders');
  await expect(page.getByLabel('筛选请求方法', { exact: true })).toHaveValue('GET');
  await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeEnabled();
  await expect(page.locator('.pagination:visible')).toContainText('31–60 / 65');
  await expect
    .poll(async () => (await messages(page)).at(-1))
    .toEqual({ action: 'history.query', payload: expectedQuery });
});

test('清空历史清除两个 Tab 缓存的详情，API 统计继续保留', async ({ page }) => {
  await page.goto('/');
  await state(page, {}, entry);
  await page.getByRole('button', { name: '请求历史' }).click();
  await expect(page.getByRole('region', { name: '最终响应', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'API 请求' }).click();
  await page.getByRole('button', { name: '查看 API GET api.example.test/v1/orders', exact: true }).click();
  await state(page, {}, entry);
  await expect(page.getByRole('region', { name: '最终响应', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '请求历史' }).click();
  await page.getByRole('button', { name: '清空记录', exact: true }).click();
  await state(page, { history: { items: [], total: 0 } }, null);
  await expect(page.getByRole('region', { name: '最终响应', exact: true })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '暂无请求历史' })).toBeVisible();
  await page.getByRole('button', { name: 'API 请求' }).click();
  await expect(page.getByRole('heading', { name: '该 API 暂无请求历史' })).toBeVisible();
  await expect(page.getByRole('region', { name: '最终响应', exact: true })).not.toBeVisible();
  await expect(page.locator('.api-facts')).toContainText('累计调用1 次');
});

test('跨 Tab 读取详情按宿主来源分发，较早的 API 结果不覆盖历史选择', async ({ page }) => {
  await page.goto('/');
  const second = { ...entry, id: 'second-request', path: '/v1/payments' };
  const overrides = { history: { items: [entry, second], total: 2 } };
  await state(page, overrides);
  await page.getByRole('button', { name: 'API 请求' }).click();
  await page.getByRole('button', { name: '查看 API GET api.example.test/v1/orders', exact: true }).click();
  await page.getByRole('button', { name: '请求历史' }).click();
  await page.locator('.request-row').filter({ hasText: '/v1/payments' }).click();
  const publish = async (selected: unknown, selectedSource: string) =>
    page.evaluate((message) => window.postMessage(message, '*'), {
      type: 'state',
      state: {
        ...fixture,
        ...overrides,
        scenes: {
          version: 1,
          activeSceneId: 'scene',
          scenes: [
            {
              id: 'scene',
              name: '默认场景',
              httpRules: (overrides as { rules?: unknown[] }).rules ?? fixture.rules,
              wsRules: [],
            },
          ],
        },
        selectedSceneId: 'scene',
      },
      selected,
      selectedSource,
    });
  await publish(entry, 'apis');
  await expect(page.getByRole('region', { name: '请求详情', exact: true })).not.toBeVisible();
  await publish(second, 'history');
  await expect(page.locator('.request-detail:visible .detail-heading > div:first-child')).toContainText(
    '/v1/payments',
  );
  await page.getByRole('button', { name: 'API 请求' }).click();
  await expect(page.locator('.request-detail:visible .detail-heading > div:first-child')).toContainText(
    '/v1/orders',
  );
  await page.getByRole('button', { name: '请求历史' }).click();
  await expect(page.locator('.request-detail:visible .detail-heading > div:first-child')).toContainText(
    '/v1/payments',
  );
});

test('响应自动格式化 JSON，原文切换不改变请求事实，新记录优先响应', async ({ page }) => {
  await page.goto('/');
  await state(page, {}, entry);
  await page.getByRole('button', { name: '请求历史' }).click();
  const responseView = page.getByRole('region', { name: '最终响应', exact: true });
  await expect(responseView).toBeVisible();
  await expect(responseView.locator('.body-content')).toHaveJSProperty(
    'textContent',
    JSON.stringify(JSON.parse(body.body), null, 2),
  );
  await responseView.getByRole('button', { name: '原文', exact: true }).click();
  await expect(responseView.locator('.body-content')).toHaveJSProperty('textContent', body.body);
  await responseView.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(responseView.locator('.body-content')).toHaveJSProperty(
    'textContent',
    JSON.stringify(JSON.parse(body.body), null, 2),
  );
  await page.getByRole('button', { name: '请求', exact: true }).click();
  await expect(page.getByRole('region', { name: '最终请求', exact: true })).toBeVisible();
  const next = {
    ...entry,
    id: 'history-2',
    response: { ...response, body: '{"ok":true,"data":null}' },
  };
  await state(page, { history: { items: [next, entry], total: 2 } }, next);
  await expect(responseView).toBeVisible();
  await expect(responseView.locator('.body-content')).toHaveText('{\n  "ok": true,\n  "data": null\n}');
  expect(
    (await messages(page)).some((message) => (message as { action?: string }).action === 'history.update'),
  ).toBe(false);
});

test('未声明 JSON 的正文仍尝试解析，非法 JSON 回退原文并明确提示', async ({ page }) => {
  await page.goto('/');
  const textJson = {
    ...response,
    headers: [['content-type', 'text/plain']],
    body: '{"nested":{"items":[1,2]}}',
  };
  await state(page, {}, { ...entry, response: textJson });
  await page.getByRole('button', { name: '请求历史' }).click();
  const responseView = page.getByRole('region', { name: '最终响应', exact: true });
  await expect(responseView.locator('.body-content')).toHaveJSProperty(
    'textContent',
    JSON.stringify(JSON.parse(textJson.body), null, 2),
  );
  const invalid = '<html><body>Bad Gateway</body></html>';
  await state(page, {}, { ...entry, id: 'invalid-json', response: { ...response, body: invalid } });
  await expect(responseView).toContainText('无法解析为 JSON，已显示原文');
  await expect(responseView.locator('.body-content')).toHaveText(invalid);
  await expect(responseView.locator('.body-content').locator('*')).toHaveCount(0);
});

test('空正文、二进制、截断与无响应记录不会误报成 JSON 或成功响应', async ({ page }) => {
  await page.goto('/');
  await state(page, {}, { ...entry, response: { ...response, status: 204, body: '', bodyBytes: 0 } });
  await page.getByRole('button', { name: '请求历史' }).click();
  const responseView = page.getByRole('region', { name: '最终响应', exact: true });
  await expect(responseView).toContainText('空正文');
  await expect(responseView).not.toContainText('无法解析为 JSON');
  await state(
    page,
    {},
    {
      ...entry,
      id: 'binary',
      response: { ...response, body: 'eyJvayI6dHJ1ZX0=', bodyEncoding: 'base64', editable: false },
    },
  );
  await expect(responseView).toContainText('Base64');
  await expect(responseView.locator('.body-content')).toHaveText('eyJvayI6dHJ1ZX0=');
  await expect(responseView).not.toContainText('无法解析为 JSON');
  await state(
    page,
    {},
    {
      ...entry,
      id: 'truncated',
      response: {
        ...response,
        body: '{"items":[',
        truncated: true,
        editable: false,
        limitation: '正文超过记录上限，保持直通',
      },
    },
  );
  await expect(responseView).toContainText('正文超过记录上限，保持直通');
  await expect(responseView.locator('.body-content')).toHaveText('{"items":[');
  await state(
    page,
    {},
    {
      ...entry,
      id: 'no-response',
      response: undefined,
      originalResponse: undefined,
      automaticResponse: undefined,
      error: 'client disconnected',
    },
  );
  await expect(page.locator('.request-detail')).toContainText('client disconnected');
  await expect(page.locator('.request-detail')).toContainText(/尚未收到|未收到响应|无响应/);
  await expect(page.locator('.request-detail')).not.toContainText('HTTP 200');
});

test('窄面板点击 API 后查看长地址和响应正文，关闭详情恢复列表', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 920 });
  await page.goto('/');
  const path = `/v1/${'long-api-segment-'.repeat(30)}`;
  const url = `https://api.example.test${path}?cursor=${'x'.repeat(300)}`;
  const long = {
    ...entry,
    path,
    url,
    targetUrl: url,
    request: { ...request, url },
    response: { ...response, body: JSON.stringify({ data: 'long-response-'.repeat(300) }) },
  };
  const overrides = {
    history: { items: [long], total: 1 },
    apis: [{ ...fixture.apis[0], path }],
  };
  await state(page, overrides);
  await page.getByRole('button', { name: 'API 请求' }).click();
  const api = page.getByRole('button', { name: `查看 API GET api.example.test${path}`, exact: true });
  await expect(api).toBeVisible();
  await api.click();
  await state(page, overrides, long);
  await expect(page.getByRole('region', { name: '最终响应', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/workbench-api-narrow.png', fullPage: true });
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(api).toBeVisible();
});

test('放大详情隐藏列表并保留响应，返回后恢复请求列表', async ({ page }) => {
  await page.goto('/');
  await state(page, {}, entry);
  await page.getByRole('button', { name: '请求历史' }).click();
  const list = page.locator('.request-list');
  const responseView = page.getByRole('region', { name: '最终响应', exact: true });
  await expect(list).toBeVisible();
  await page.getByRole('button', { name: '放大详情', exact: true }).click();
  await expect(list).not.toBeVisible();
  await expect(responseView).toBeVisible();
  await expect(responseView.locator('.body-content')).toHaveJSProperty(
    'textContent',
    JSON.stringify(JSON.parse(body.body), null, 2),
  );
  await page.screenshot({ path: 'artifacts/workbench-api-focused.png', fullPage: true });
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(list).toBeVisible();
  await expect(responseView).toBeVisible();
});

test('复制正文遵循 JSON 与原文模式，复制失败显示提示且不修改历史', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          const clipboardState = window as unknown as { __copiedBody?: string; __rejectCopy?: boolean };
          if (clipboardState.__rejectCopy) throw new Error('Clipboard unavailable');
          clipboardState.__copiedBody = text;
        },
      },
    });
  });
  await page.goto('/');
  await state(page, {}, entry);
  await page.getByRole('button', { name: '请求历史' }).click();
  const responseView = page.getByRole('region', { name: '最终响应', exact: true });
  const copy = responseView.getByRole('button', { name: '复制正文', exact: true });
  const copiedBody = () => page.evaluate(() => (window as unknown as { __copiedBody?: string }).__copiedBody);
  await copy.click();
  await expect.poll(copiedBody).toBe(JSON.stringify(JSON.parse(body.body), null, 2));
  await expect(responseView.getByRole('status')).toHaveText('已复制');
  await responseView.getByRole('button', { name: '原文', exact: true }).click();
  await copy.click();
  await expect.poll(copiedBody).toBe(body.body);
  await page.evaluate(() => {
    (window as unknown as { __rejectCopy?: boolean }).__rejectCopy = true;
  });
  await copy.click();
  await expect(responseView.getByRole('status')).toHaveText('复制失败，请选中正文复制');
  await expect.poll(copiedBody).toBe(body.body);
  expect(
    (await messages(page)).some((message) => (message as { action?: string }).action === 'history.update'),
  ).toBe(false);
});

test('VM 模式无需代理引擎，连接地址仅提交一次并清空输入', async ({ page }) => {
  await page.goto('/');
  await state(page, { engine: { status: 'stopped' }, proxyActive: false });
  await page.getByRole('button', { name: /^VM 连接/ }).click();
  expect(await messages(page)).toContainEqual({ action: 'connection.mode', payload: { mode: 'vm' } });
  const disconnected = {
    status: 'disconnected',
    endpoint: undefined,
    isolates: 0,
    recorded: 0,
    instances: 0,
    mockEnabled: false,
    warnings: [],
  };
  await state(page, { mode: 'vm', vm: disconnected, engine: { status: 'stopped' }, proxyActive: false });
  await expect(page.getByRole('heading', { name: '连接与诊断' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '准备代理引擎' })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '信任 HTTPS 证书' })).not.toBeVisible();
  const input = page.getByLabel('VM WebSocket 地址', { exact: true });
  const connect = page.getByRole('button', { name: '连接并记录', exact: true });
  await expect(input).toHaveAttribute('type', 'password');
  await expect(connect).toBeDisabled();
  await input.fill('  ws://127.0.0.1:1234/synthetic-auth/ws  ');
  await connect.click();
  expect(await messages(page)).toContainEqual({
    action: 'vm.connect',
    payload: { url: 'ws://127.0.0.1:1234/synthetic-auth/ws' },
  });
  await expect(input).toHaveValue('');
  await expect(connect).toBeDisabled();
  await expect(page.locator('body')).not.toContainText('synthetic-auth');
  expect(
    (await messages(page)).some((message) => (message as { action?: string }).action === 'install'),
  ).toBe(false);
  await page.getByRole('button', { name: /^代理连接/ }).click();
  expect(await messages(page)).toContainEqual({ action: 'connection.mode', payload: { mode: 'proxy' } });
});

test('首次打开默认推荐 VM，代理标记为备用且无需先准备引擎', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '连接与诊断' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^VM 连接/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^VM 连接/ })).toContainText('推荐');
  await expect(page.getByRole('button', { name: /^代理连接/ })).toContainText('备用方案');
  await expect(page.getByRole('heading', { name: '准备代理引擎' })).not.toBeVisible();
  await page.getByText('工作区与连接', { exact: true }).click();
  await expect(page.getByRole('button', { name: '连接 VM', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: '开启运行时 Dio Mock' })).toHaveCount(0);
});

test('VM 由场景控制 Mock，采集、重新发现和断开入口保留', async ({ page }) => {
  await page.goto('/');
  const vm = {
    status: 'connected',
    endpoint: '127.0.0.1:1234',
    isolates: 1,
    recorded: 2,
    instances: 1,
    mockEnabled: true,
    captureEnabled: true,
    warnings: [],
  };
  const overrides = { mode: 'vm', vm, engine: { status: 'stopped' }, proxyActive: false };
  await state(page, overrides);
  await expect(page.getByRole('switch', { name: '开启运行时 Dio Mock' })).toHaveCount(0);
  await page.getByRole('button', { name: '重新发现并同步', exact: true }).click();
  await page.getByRole('button', { name: '关闭 HTTP 采集' }).click();
  expect(await messages(page)).toEqual(
    expect.arrayContaining([
      { action: 'vm.rescan', payload: {} },
      { action: 'vm.capture', payload: { enabled: false } },
    ]),
  );
  await state(page, { ...overrides, busy: true });
  await expect(page.getByRole('button', { name: '关闭 HTTP 采集' })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 900 });
  await state(page, overrides);
  const card = page.getByRole('region', { name: '场景 Mock 控制' });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await state(page, { ...overrides, proxyActive: true });
  await page.getByRole('button', { name: '停止旧代理', exact: true }).click();
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  expect(await messages(page)).toEqual(
    expect.arrayContaining([
      { action: 'proxy.stop', payload: {} },
      { action: 'vm.disconnect', payload: {} },
    ]),
  );
});

test('VM 连接中、成功、断开和失败状态一致，已连接时禁止重复连接', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 920 });
  await page.goto('/');
  const vm = {
    status: 'disconnected',
    isolates: 0,
    recorded: 0,
    instances: 0,
    mockEnabled: false,
    warnings: [],
  };
  const overrides = { mode: 'vm', vm, engine: { status: 'stopped' }, proxyActive: false };
  await state(page, overrides);
  const input = page.getByLabel('VM WebSocket 地址', { exact: true });
  await input.fill('ws://127.0.0.1:1234/synthetic-auth/ws');
  await page.getByRole('button', { name: '连接并记录', exact: true }).click();
  await state(page, { ...overrides, vm: { ...vm, status: 'connecting', endpoint: 'old-endpoint:1234' } });
  await expect(input).toBeDisabled();
  await page.getByText('工作区与连接', { exact: true }).click();
  await expect(page.getByRole('button', { name: '连接中…', exact: true })).toHaveCount(2);
  for (const button of await page.getByRole('button', { name: '连接中…', exact: true }).all()) {
    await expect(button).toBeDisabled();
  }
  await expect(page.locator('.workspace-menu-panel')).toContainText('VM · 连接中');
  await expect(page.locator('.workspace-menu-panel')).not.toContainText('old-endpoint');
  const connected = { ...vm, status: 'connected', endpoint: '127.0.0.1:1234', isolates: 1 };
  await state(page, { ...overrides, vm: connected });
  await expect(page.getByRole('status', { name: 'VM 已连接' })).toContainText('已连接 · 127.0.0.1:1234');
  await expect(page.locator('.status-pill')).toHaveText('VM 记录中');
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: '连接并记录', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '连接 VM', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '断开连接', exact: true })).toBeEnabled();
  expect(
    (await messages(page)).filter((m) => (m as { action: string }).action === 'vm.connect'),
  ).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({
    path: 'artifacts/workbench-vm-connected.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByText('工作区与连接', { exact: true }).click();
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  expect(await messages(page)).toContainEqual({ action: 'vm.disconnect', payload: {} });
  await state(page, { ...overrides, vm: { ...vm, endpoint: 'old-endpoint:1234' } });
  await expect(input).toBeEnabled();
  await expect(page.getByRole('status', { name: 'VM 已连接' })).not.toBeVisible();
  await expect(page.locator('.workspace-menu-panel')).toContainText('VM · 未连接');
  await expect(page.locator('.workspace-menu-panel')).not.toContainText('old-endpoint');
  await expect(page.getByRole('button', { name: '连接并记录', exact: true })).toBeDisabled();
  await input.fill('ws://127.0.0.1:4321/new-synthetic-auth/ws');
  await expect(page.getByRole('button', { name: '连接并记录', exact: true })).toBeEnabled();
  await state(page, { ...overrides, vm: { ...vm, error: 'VM 端口未监听，请复制当前调试地址。' } });
  await expect(page.getByRole('alert')).toContainText('端口未监听');
  await expect(page.locator('.status-pill')).toHaveText('VM 未连接');
  await expect(input).toBeEnabled();
});

test('VM 在引擎未运行时查询历史，窄面板可用并明确不支持手动断点', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 920 });
  await page.goto('/');
  await state(
    page,
    {
      mode: 'vm',
      vm: {
        status: 'connected',
        endpoint: '127.0.0.1:1234',
        isolates: 1,
        recorded: 2,
        instances: 1,
        mockEnabled: true,
        warnings: ['实验功能：仅 Debug / Dio 5'],
      },
      engine: { status: 'stopped' },
      proxyActive: false,
    },
    entry,
  );
  await expect(page.getByRole('heading', { name: '连接与诊断' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/workbench-vm.png', fullPage: true });
  await page.getByRole('button', { name: '请求历史' }).click();
  await expect
    .poll(async () => messages(page))
    .toContainEqual({ action: 'history.query', payload: { offset: 0 } });
  await expect(page.getByRole('region', { name: '最终响应', exact: true })).toBeVisible();
  await page.getByLabel('搜索请求', { exact: true }).fill('/orders');
  await expect
    .poll(async () => messages(page))
    .toContainEqual({ action: 'history.query', payload: { search: '/orders', offset: 0 } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: '断点队列' }).click();
  await page.getByText('VM 模式 · 手动断点需使用代理', { exact: true }).click();
  await expect(page.getByText(/VM 模式暂不支持手动断点/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('VM 自动发现展示候选并只提交选中的会话 ID', async ({ page }) => {
  await page.goto('/');
  const vm = {
    status: 'disconnected',
    isolates: 0,
    recorded: 0,
    instances: 0,
    mockEnabled: false,
    warnings: [],
  };
  const candidates = [
    {
      id: 'ios-debug',
      name: 'Flutter iOS',
      device: 'iPhone 18 Pro',
      endpoint: '127.0.0.1:41001',
      source: 'debug-event',
      status: 'available',
    },
    {
      id: 'android-debug',
      name: 'Flutter Android',
      device: 'Pixel 9',
      endpoint: '127.0.0.1:41002',
      source: 'dtd',
      status: 'available',
    },
  ];
  const overrides = {
    mode: 'vm',
    vm,
    engine: { status: 'stopped' },
    proxyActive: false,
    vmDiscovery: { enabled: true, status: 'ready', candidates },
  };
  await state(page, overrides);
  const discovery = page.getByRole('region', { name: '已发现的 Flutter 调试会话' });
  await expect(discovery).toContainText('自动连接已开启');
  await expect(discovery).toContainText('iPhone 18 Pro · 调试事件 · 127.0.0.1:41001');
  await expect(discovery).toContainText('Pixel 9 · 已有调试会话 · 127.0.0.1:41002');
  expect(
    (await messages(page)).some(
      (message) => (message as { action?: string }).action === 'vm.discovery.connect',
    ),
  ).toBe(false);
  await discovery.getByRole('button', { name: '连接 Flutter Android', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'vm.discovery.connect',
    payload: { id: 'android-debug' },
  });
  await expect(page.getByLabel('VM WebSocket 地址', { exact: true })).toBeEnabled();
  await expect(page.getByRole('switch', { name: '开启运行时 Dio Mock' })).toHaveCount(0);
  await state(page, {
    ...overrides,
    vm: { ...vm, status: 'connecting' },
    vmDiscovery: {
      enabled: true,
      status: 'ready',
      candidates: [{ ...candidates[0], status: 'connecting' }, candidates[1]],
    },
  });
  for (const button of await discovery.getByRole('button').all()) await expect(button).toBeDisabled();
  await state(page, { ...overrides, vm: { ...vm, status: 'connected', endpoint: '127.0.0.1:41002' } });
  for (const button of await discovery.getByRole('button').all()) await expect(button).toBeDisabled();
  await state(page, { ...overrides, busy: true });
  for (const button of await discovery.getByRole('button').all()) await expect(button).toBeDisabled();
});

test('VM 自动发现失败和暂停后允许显式重连，窄面板可展示长会话', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 920 });
  await page.goto('/');
  const name = 'Flutter workspace 项目调试'.repeat(10);
  const candidates = [
    {
      id: 'failed-debug',
      name,
      device: 'iPhone 18 Pro',
      endpoint: '127.0.0.1:41001',
      source: 'dtd',
      status: 'failed',
      error: 'VM 端口未监听，请重试连接。',
    },
    {
      id: 'paused-debug',
      name: 'Flutter 手动断开的会话',
      endpoint: '127.0.0.1:41002',
      source: 'debug-event',
      status: 'paused',
    },
  ];
  await state(page, {
    mode: 'vm',
    vm: { status: 'disconnected', isolates: 0, recorded: 0, instances: 0, mockEnabled: false, warnings: [] },
    engine: { status: 'stopped' },
    proxyActive: false,
    vmDiscovery: { enabled: true, status: 'ready', candidates },
  });
  const discovery = page.getByRole('region', { name: '已发现的 Flutter 调试会话' });
  await expect(discovery.getByRole('alert')).toContainText('VM 端口未监听');
  await expect(discovery).toContainText('已暂停自动连接');
  await discovery.getByRole('button', { name: `重试连接 ${name}`, exact: true }).click();
  await discovery.getByRole('button', { name: '重新连接 Flutter 手动断开的会话', exact: true }).click();
  expect(await messages(page)).toEqual(
    expect.arrayContaining([
      { action: 'vm.discovery.connect', payload: { id: 'failed-debug' } },
      { action: 'vm.discovery.connect', payload: { id: 'paused-debug' } },
    ]),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/workbench-vm-discovery-narrow.png', fullPage: true });
});

test('VM 自动发现等待、关闭自动连接和补查不可用时保留手动入口', async ({ page }) => {
  await page.goto('/');
  const overrides = { mode: 'vm', engine: { status: 'stopped' }, proxyActive: false };
  await state(page, {
    ...overrides,
    vmDiscovery: { enabled: true, status: 'waiting', candidates: [] },
  });
  const discovery = page.getByRole('region', { name: '已发现的 Flutter 调试会话' });
  await expect(discovery).toContainText('等待当前项目的 Flutter Debug 调试会话');
  await state(page, {
    ...overrides,
    vmDiscovery: {
      enabled: false,
      status: 'unavailable',
      message: 'Dart 扩展暂不支持已有会话查询。',
      candidates: [],
    },
  });
  await expect(discovery).toContainText('自动连接已关闭');
  await expect(discovery).toContainText('autoConnectVm');
  await expect(discovery.getByRole('status')).toContainText('Dart 扩展暂不支持已有会话查询');
  await expect(discovery).toContainText('可重新启动 Flutter 调试，或手动填写本次 VM 地址');
  await expect(page.getByLabel('VM WebSocket 地址', { exact: true })).toBeEnabled();
});

for (const width of [1280, 390]) {
  test(`所有 Tab 在 ${width}px 下优先显示内容，低频区域按需展开`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/');
    await state(
      page,
      {
        mode: 'vm',
        proxyActive: false,
        vm: {
          status: 'connected',
          endpoint: '127.0.0.1:58004',
          isolates: 1,
          recorded: 1754,
          instances: 1,
          mockEnabled: false,
          warnings: [],
        },
        ruleSyncError: '规则已保存；仅采集模式不执行 Mock。',
        project: {
          id: 'test-project',
          name: 'commerce_app',
          configPath: '/workspace/.flutter-pilot/project.json',
          rulesPath: '/workspace/.flutter-pilot/rules.json',
        },
      },
      entry,
    );
    const panels = [
      ['连接与诊断', '.vm-card'],
      ['API 请求', '.api-layout'],
      ['请求历史', '.history-layout'],
      ['WebSocket', '.ws-workspace'],
      ['Mock 场景', '.scene-runtime'],
      ['断点队列', '.breakpoints-page .empty'],
      ['MCP', '.mcp-agents'],
    ];
    for (const [name, selector] of panels) {
      await page.locator('nav').getByRole('button', { name }).click();
      const content = page.locator(selector).first();
      await expect(content).toBeVisible();
      const main = await page.locator('main').boundingBox();
      const box = await content.boundingBox();
      expect(main!.y).toBeLessThan(120);
      expect(box!.y).toBeLessThan(width === 1280 ? 310 : 390);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('main').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: `artifacts/compact-${width}-${selector.replace(/[^a-z-]/g, '')}.png` });
    }
    await page.getByRole('button', { name: '请求历史' }).click();
    await expect(page.getByLabel('筛选状态码')).not.toBeVisible();
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByLabel('筛选状态码').fill('503');
    await page.getByLabel('筛选 Mock', { exact: true }).selectOption('false');
    await expect
      .poll(() => messages(page))
      .toContainEqual({ action: 'history.query', payload: { status: 503, mocked: false, offset: 0 } });
    await page.getByRole('button', { name: '筛选 2', exact: true }).click();
    await expect(page.getByLabel('筛选状态码')).not.toBeVisible();
    await page.getByRole('button', { name: '筛选 2', exact: true }).click();
    await expect(page.getByLabel('筛选状态码')).toHaveValue('503');
    await page.getByRole('button', { name: 'Mock 场景' }).click();
    await page.getByRole('button', { name: '导入场景', exact: true }).click();
    expect(await messages(page)).toContainEqual({ action: 'rules.import', payload: {} });
  });
}

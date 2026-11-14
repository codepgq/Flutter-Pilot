import { test, expect, type Page } from '@playwright/test';

const action = {
  id: 'submit',
  name: '提交订单',
  description: '填写价格并提交订单',
  inputs: { price: { required: true }, password: { secret: true } },
  steps: [
    { id: 'fillPrice', type: 'enter_text', target: 'price', text: '${inputs.price}' },
    { id: 'submit', type: 'tap', target: 'submit' },
  ],
};
const commonScene = {
  id: 'common',
  name: '公共操作',
  httpRules: [],
  wsRules: [],
  targets: { price: { key: 'order.price' }, submit: { key: 'order.submit' } },
  actions: [action],
};
const mockScene = { id: 'insufficient', name: '余额不足', httpRules: [], wsRules: [] };
const base: any = {
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
  scenes: { version: 1, activeSceneId: mockScene.id, scenes: [commonScene, mockScene] },
  selectedSceneId: commonScene.id,
  sceneActions: { running: false, locked: false },
  tests: {
    file: '/project/.flutter-pilot/tests.json',
    catalogue: {
      tests: [
        {
          id: 'pending',
          name: '本轮订单 pending',
          action: { sceneId: 'common', actionId: 'submit' },
          assertionCount: 2,
        },
      ],
    },
    running: false,
    locked: false,
  },
};
async function update(page: Page, patch: any = {}) {
  await page.evaluate((state) => window.postMessage({ type: 'state', state }, '*'), { ...base, ...patch });
}
async function openActions(page: Page, patch: any = {}) {
  await page.goto('/');
  await update(page, patch);
  await page
    .getByRole('button', { name: /Mock 场景/ })
    .first()
    .click();
  await page.getByRole('button', { name: '查看场景 公共操作' }).click();
  return page.getByRole('region', { name: '场景辅助操作' });
}
async function messages(page: Page) {
  return page.evaluate(() => (window as any).__messages);
}

test('Scene action preserves current Mock, exact inputs and secret clearing without a standalone workflow page', async ({
  page,
}) => {
  const panel = await openActions(page);
  await expect(page.getByRole('button', { name: /业务流程/ })).toHaveCount(0);
  await expect(panel.getByText('操作来源：公共操作 · 当前 Mock：余额不足')).toBeVisible();
  await panel.getByLabel('选择场景操作').selectOption('submit');
  await expect(panel.getByText('填写价格并提交订单')).toBeVisible();
  await expect(panel.getByRole('button', { name: '运行操作', exact: true })).toBeDisabled();
  await panel.getByLabel('操作参数 price').fill('0.0012300');
  await panel.getByLabel('操作参数 password').fill('fixture-secret');
  await expect(panel.getByLabel('操作参数 password')).toHaveAttribute('type', 'password');
  await panel.getByRole('button', { name: '运行操作', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'scenes.actions.run',
    payload: {
      sceneId: 'common',
      actionId: 'submit',
      inputs: { price: '0.0012300', password: 'fixture-secret' },
      backend: 'auto',
    },
  });
  expect((await messages(page)).some((message: any) => message.action === 'scenes.activate')).toBe(false);
  await expect(panel.getByLabel('操作参数 password')).toHaveValue('');
  await expect(panel.getByLabel('操作参数 price')).toHaveValue('0.0012300');
});

test('clearing a secret override uses its configured default, and an action can run without active Mock', async ({
  page,
}) => {
  const panel = await openActions(page, {
    scenes: {
      ...base.scenes,
      activeSceneId: null,
      scenes: [
        {
          ...commonScene,
          actions: [{ ...action, inputs: { password: { secret: true, default: 'hidden-default' } } }],
        },
      ],
    },
  });
  await expect(panel.getByText('操作来源：公共操作 · 当前 Mock：未激活 Mock')).toBeVisible();
  await panel.getByLabel('选择场景操作').selectOption('submit');
  await expect(panel.getByLabel('操作参数 password')).toHaveValue('');
  await panel.getByLabel('操作参数 password').fill('temporary');
  await panel.getByLabel('操作参数 password').clear();
  await panel.getByRole('button', { name: '运行操作', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'scenes.actions.run',
    payload: { sceneId: 'common', actionId: 'submit', inputs: {}, backend: 'auto' },
  });
});

test('named actions keep independent inputs and targets-only Scenes offer configuration', async ({
  page,
}) => {
  const panel = await openActions(page, {
    scenes: {
      ...base.scenes,
      scenes: [
        {
          ...commonScene,
          actions: [
            action,
            { id: 'refresh', name: '刷新列表', steps: [{ id: 'tap', type: 'tap', target: 'submit' }] },
          ],
        },
        mockScene,
      ],
    },
  });
  await panel.getByLabel('选择场景操作').selectOption('submit');
  await panel.getByLabel('操作参数 price').fill('100.00');
  await panel.getByLabel('选择场景操作').selectOption('refresh');
  await expect(panel.getByLabel('操作参数 price')).toHaveCount(0);
  await panel.getByRole('button', { name: '运行操作', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'scenes.actions.run',
    payload: { sceneId: 'common', actionId: 'refresh', inputs: {}, backend: 'auto' },
  });
  await update(page, {
    scenes: { ...base.scenes, scenes: [{ ...commonScene, actions: undefined }, mockScene] },
  });
  await expect(panel.getByText('0 个操作 · 2 个目标')).toBeVisible();
  await expect(panel.getByRole('button', { name: '运行操作', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '打开场景配置', exact: true }).click();
  expect(await messages(page)).toContainEqual({ action: 'scenes.open', payload: {} });
});

test('running action locks environment controls but browsing and cancellation stay available', async ({
  page,
}) => {
  await openActions(page, {
    sceneActions: {
      running: true,
      locked: true,
      run: {
        runId: 'action-active',
        sceneId: 'common',
        actionId: 'submit',
        mockSceneId: 'insufficient',
        name: '提交订单',
        status: 'running',
        message: '正在执行',
        cancelRequested: false,
        metrics: { totalMs: 20, resolveMs: 2, inputMs: 3, waitMs: 5, stepsCompleted: 0 },
        steps: [],
      },
    },
  });
  await expect(page.getByRole('switch', { name: '启用场景 余额不足' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存名称', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '新建场景', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '查看场景 余额不足' }).click();
  const result = page.getByRole('region', { name: '场景操作运行结果' });
  await expect(result.getByText('操作来源：公共操作 · 本轮 Mock：余额不足')).toBeVisible();
  await result.getByRole('button', { name: '取消操作', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'scenes.actions.cancel',
    payload: { runId: 'action-active' },
  });
});

test('action completion differs from business test success, and uncertain tests expose evidence', async ({
  page,
}) => {
  await openActions(page, {
    sceneActions: {
      ...base.sceneActions,
      run: {
        runId: 'action-1',
        sceneId: 'common',
        actionId: 'submit',
        mockSceneId: 'insufficient',
        name: '提交订单',
        status: 'completed',
        message: '操作完成',
        metrics: { totalMs: 20, resolveMs: 2, inputMs: 3, waitMs: 5, stepsCompleted: 0 },
        steps: [],
      },
    },
  });
  await expect(
    page.getByRole('region', { name: '场景操作运行结果' }).getByText('操作完成', { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText('测试通过', { exact: true })).toHaveCount(0);
  await update(page, {
    tests: {
      ...base.tests,
      run: {
        runId: 'test-1',
        name: '本轮订单 pending',
        status: 'uncertain',
        message: '操作结果未确认',
        cancelRequested: false,
        steps: [],
        assertions: [
          { id: 'request', kind: 'http', status: 'passed', evidence: { httpId: 'request-1' } },
          { id: 'pending', kind: 'ui', status: 'failed', message: '订单行未出现' },
        ],
        events: [{ id: 'pendingEvent', status: 'uncertain' }],
        failure: { code: 'WS_INJECTION_UNCONFIRMED', message: '消息结果未确认' },
      },
    },
  });
  await page.getByRole('button', { name: /业务测试/ }).click();
  const result = page.getByRole('region', { name: '测试运行结果' });
  await expect(result.getByText('结果未确认', { exact: true }).first()).toBeVisible();
  await expect(result.getByText('证据 request-1')).toBeVisible();
  await expect(result.getByText('订单行未出现')).toBeVisible();
  await expect(result.getByText(/操作可能已经发生/)).toBeVisible();
});

test('test controls resolve Scene action inputs, respect ownership and cancel on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await update(page);
  await page.getByRole('button', { name: /业务测试/ }).click();
  await page.getByLabel('选择测试').selectOption('pending');
  await expect(page.getByText('操作来源：公共操作 / 提交订单')).toBeVisible();
  await page.getByLabel('测试参数 price').fill('100.00');
  await page.getByRole('button', { name: '运行测试', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'tests.run',
    payload: { testId: 'pending', inputs: { price: '100.00' } },
  });
  await update(page, {
    tests: {
      ...base.tests,
      running: true,
      locked: true,
      run: {
        runId: 'active',
        name: '本轮订单 pending',
        status: 'running',
        message: '正在运行',
        cancelRequested: false,
        steps: [],
        assertions: [],
        events: [],
      },
    },
  });
  await expect(page.getByRole('button', { name: '运行测试', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消测试', exact: true }).click();
  expect(await messages(page)).toContainEqual({ action: 'tests.cancel', payload: { runId: 'active' } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Scene operation controls and results fit a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openActions(page);
  await panel.getByLabel('选择场景操作').selectOption('submit');
  await panel.getByLabel('操作参数 price').fill('100.00');
  await panel.getByLabel('场景操作通道').selectOption('flutter');
  await panel.getByRole('button', { name: '运行操作', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'scenes.actions.run',
    payload: { sceneId: 'common', actionId: 'submit', inputs: { price: '100.00' }, backend: 'flutter' },
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('failed action shows the actual Key, expected state and final observation with readable timings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const failure = {
    code: 'WAIT_TIMEOUT',
    message: '等待目标状态超时。',
    uncertain: false,
    diagnostics: {
      selector: {
        key: 'app.shell.root',
        source: 'flutter',
        text: 'never-render-observed-selector-text',
        ancestor: { semantics: 'never-render-observed-ancestor' },
      },
      condition: 'visible',
      timeoutMs: 30000,
      attempts: 74,
      lastObservation: {
        code: 'FOUND',
        message: '目标存在，但等待条件尚未满足。',
        present: true,
        visible: false,
        enabled: true,
        actionable: false,
      },
    },
  };
  const path = 'entry/open_home/open_home/common/open_home/wait_app_shell';
  await openActions(page, {
    sceneActions: {
      ...base.sceneActions,
      run: {
        runId: 'failed-1',
        sceneId: 'common',
        actionId: 'open_home',
        mockSceneId: 'insufficient',
        name: '进入主页',
        status: 'failed',
        message: '场景操作已在失败步骤停止。',
        metrics: {
          totalMs: 30173.1,
          resolveMs: 10995.851160984486,
          inputMs: 0,
          waitMs: 30158.2,
          stepsCompleted: 0,
        },
        failure,
        steps: [
          {
            id: 'wait_app_shell',
            path,
            sceneId: 'common',
            actionId: 'open_home',
            target: 'appShell',
            tool: 'wait_for_widget',
            status: 'failed',
            durationMs: 30158.2,
            failure,
          },
          {
            id: 'open_home',
            path: 'entry/open_home/common/open_home/tap_home',
            sceneId: 'common',
            actionId: 'open_home',
            target: 'homeTab',
            tool: 'tap',
            status: 'skipped',
          },
        ],
      },
    },
  });
  const result = page.getByRole('region', { name: '场景操作运行结果' });
  const diagnostic = result.getByRole('alert');
  await expect(diagnostic).toContainText('第 1 步失败：等待控件 · appShell');
  await expect(diagnostic).toContainText('Widget Key：app.shell.root · 来源：Flutter VM');
  await expect(diagnostic).toContainText('期望状态：可见 · 超时：30000 ms');
  await expect(diagnostic).toContainText(
    '最后观测：已找到目标 · 不可见 · 已启用 · 不可操作（已检查 74 次）。',
  );
  await expect(diagnostic).toContainText('定位结果：FOUND · 目标存在，但等待条件尚未满足。');
  await expect(result).toContainText('定位 10996 ms');
  await expect(result).toContainText('等待（含定位） 30158 ms');
  await expect(result).not.toContainText('10995.851');
  await expect(result).not.toContainText('never-render-observed-selector-text');
  await expect(result).not.toContainText('never-render-observed-ancestor');
  await expect(result.getByText(`调用路径：${path}`, { exact: true })).not.toBeVisible();
  await result.getByText('步骤：wait_app_shell', { exact: true }).click();
  await expect(result.getByText(`调用路径：${path}`, { exact: true })).toBeVisible();
  await diagnostic.getByRole('button', { name: '打开场景配置', exact: true }).click();
  expect((await messages(page)).at(-1)).toEqual({ action: 'scenes.open', payload: {} });
  expect((await messages(page)).some((message: any) => message.action === 'scenes.actions.run')).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await result.getByText('步骤：wait_app_shell', { exact: true }).click();
  await result.screenshot({ path: 'artifacts/scene-action-failure-390.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await result.screenshot({ path: 'artifacts/scene-action-failure-1280.png' });
});

test('failed locator observations distinguish absence from an unconfirmed error and always show its code', async ({
  page,
}) => {
  const failure = (code: string) => ({
    code: 'WAIT_TIMEOUT',
    message: '等待目标状态超时。',
    uncertain: false,
    diagnostics: {
      selector: { key: 'app.shell.root', source: 'flutter' },
      condition: 'visible',
      timeoutMs: 5000,
      attempts: 8,
      lastObservation: { code },
    },
  });
  const patch = (code: string) => ({
    sceneActions: {
      ...base.sceneActions,
      run: {
        runId: 'locator-failed',
        sceneId: 'common',
        actionId: 'open_home',
        mockSceneId: null,
        name: '进入主页',
        status: 'failed',
        message: '场景操作已在失败步骤停止。',
        failure: failure(code),
        metrics: { totalMs: 5000, resolveMs: 20, inputMs: 0, waitMs: 5000, stepsCompleted: 0 },
        steps: [
          {
            id: 'wait',
            path: 'common/open_home/wait',
            sceneId: 'common',
            actionId: 'open_home',
            target: 'appShell',
            tool: 'wait_for_widget',
            status: 'failed',
            durationMs: 5000,
            failure: failure(code),
          },
        ],
      },
    },
  });
  await openActions(page, patch('AMBIGUOUS_SELECTOR'));
  const diagnostic = page.getByRole('region', { name: '场景操作运行结果' }).getByRole('alert');
  for (const code of ['AMBIGUOUS_SELECTOR', 'UI_UNAVAILABLE']) {
    await update(page, patch(code));
    await expect(diagnostic).toContainText('最后观测：定位未确认');
    await expect(diagnostic).toContainText(`定位结果：${code}`);
    await expect(diagnostic).not.toContainText('未找到目标');
  }
  await update(page, patch('NOT_FOUND'));
  await expect(diagnostic).toContainText('最后观测：未找到目标');
  await expect(diagnostic).toContainText('定位结果：NOT_FOUND');
});

test('older failed runs preserve the error without inventing observations from current targets', async ({
  page,
}) => {
  const failure = { code: 'WAIT_TIMEOUT', message: '等待目标状态超时。', uncertain: false };
  await openActions(page, {
    sceneActions: {
      ...base.sceneActions,
      run: {
        runId: 'old-failure',
        sceneId: 'common',
        actionId: 'submit',
        mockSceneId: null,
        name: '提交订单',
        status: 'failed',
        message: '场景操作已在失败步骤停止。',
        failure,
        metrics: { totalMs: 5000, resolveMs: 20, inputMs: 0, waitMs: 5000, stepsCompleted: 0 },
        steps: [
          {
            id: 'wait',
            path: 'common/submit/wait',
            sceneId: 'common',
            actionId: 'submit',
            target: 'price',
            tool: 'wait_for_widget',
            status: 'failed',
            durationMs: 5000,
            failure,
          },
        ],
      },
    },
  });
  const result = page.getByRole('region', { name: '场景操作运行结果' });
  await expect(result.getByRole('alert')).toContainText('WAIT_TIMEOUT · 等待目标状态超时。');
  await expect(result).not.toContainText('Widget Key：order.price');
  await expect(result).not.toContainText('最后观测');
});

test('reloaded test actions discard removed input overrides and disable unresolved references', async ({
  page,
}) => {
  await page.goto('/');
  await update(page);
  await page.getByRole('button', { name: /业务测试/ }).click();
  await page.getByLabel('选择测试').selectOption('pending');
  await page.getByLabel('测试参数 price').fill('100.00');
  await page.getByLabel('测试参数 password').fill('stale-secret');
  await update(page, {
    scenes: {
      ...base.scenes,
      scenes: [
        { ...commonScene, actions: [{ ...action, inputs: { quantity: { required: true } } }] },
        mockScene,
      ],
    },
  });
  await expect(page.getByLabel('测试参数 price')).toHaveCount(0);
  await expect(page.getByLabel('测试参数 password')).toHaveCount(0);
  await page.getByLabel('测试参数 quantity').fill('2');
  await page.getByRole('button', { name: '运行测试', exact: true }).click();
  expect(await messages(page)).toContainEqual({
    action: 'tests.run',
    payload: { testId: 'pending', inputs: { quantity: '2' } },
  });
  await update(page);
  await expect(page.getByLabel('测试参数 password')).toHaveValue('');
  await expect(page.getByLabel('测试参数 price')).toHaveValue('');
  await update(page, { scenes: { ...base.scenes, scenes: [mockScene] } });
  await expect(page.getByRole('alert')).toHaveText('测试引用的场景操作不存在，请检查配置并重新加载场景。');
  await expect(page.getByRole('button', { name: '运行测试', exact: true })).toBeDisabled();
});

test('reloaded action inputs use new defaults and secret flags while ordinary updates preserve edits', async ({
  page,
}) => {
  const scenes = (spec: { default: string; secret?: boolean }) => ({
    ...base.scenes,
    scenes: [{ ...commonScene, actions: [{ ...action, inputs: { price: spec } }] }, mockScene],
  });
  const initial = scenes({ default: '100' });
  const panel = await openActions(page, { scenes: initial });
  await panel.getByLabel('选择场景操作').selectOption('submit');
  await expect(panel.getByLabel('操作参数 price')).toHaveValue('100');
  await panel.getByLabel('操作参数 price').fill('150');
  await update(page, { scenes: initial });
  await expect(panel.getByLabel('操作参数 price')).toHaveValue('150');

  await update(page, { scenes: scenes({ default: '200' }) });
  await expect(panel.getByLabel('操作参数 price')).toHaveValue('200');
  await panel.getByRole('button', { name: '运行操作', exact: true }).click();
  expect((await messages(page)).at(-1)).toEqual({
    action: 'scenes.actions.run',
    payload: { sceneId: 'common', actionId: 'submit', inputs: { price: '200' }, backend: 'auto' },
  });

  await panel.getByLabel('操作参数 price').fill('stale-override');
  await update(page, { scenes: scenes({ default: '[REDACTED]', secret: true }) });
  await expect(panel.getByLabel('操作参数 price')).toHaveAttribute('type', 'password');
  await expect(panel.getByLabel('操作参数 price')).toHaveValue('');
  await panel.getByRole('button', { name: '运行操作', exact: true }).click();
  expect((await messages(page)).at(-1)).toEqual({
    action: 'scenes.actions.run',
    payload: { sceneId: 'common', actionId: 'submit', inputs: {}, backend: 'auto' },
  });
});

test('manual workflow resolves target aliases to Widget Keys without exposing text selectors or secrets', async ({
  page,
}) => {
  const panel = await openActions(page, {
    scenes: {
      ...base.scenes,
      scenes: [
        {
          ...commonScene,
          targets: {
            ...commonScene.targets,
            price: {
              key: 'order.price',
              source: 'flutter',
              text: 'never-render-this-selector-text',
              ancestor: { semantics: 'never-render-this-ancestor-semantics' },
            },
            list: { source: 'device', accessibilityId: 'never-render-this-device-selector' },
          },
          actions: [
            {
              ...action,
              inputs: { password: { secret: true, default: 'never-render-this-default' } },
              steps: [
                { id: 'fillPassword', type: 'enter_text', target: 'price', text: 'never-render-this-text' },
                { id: 'wait', type: 'wait_for_widget', target: 'submit', state: 'visible' },
                { id: 'scroll', type: 'scroll', target: 'list', untilTarget: 'submit' },
                { id: 'commonStep', type: 'call', sceneId: 'insufficient', actionId: 'finish' },
                { id: 'hide', type: 'hide_keyboard' },
              ],
            },
          ],
        },
        {
          ...mockScene,
          actions: [{ id: 'finish', name: '等待主页', steps: [{ id: 'wait', type: 'tap', target: 'home' }] }],
        },
      ],
    },
  });
  await expect(panel.getByRole('heading', { name: 'UI 操作（Workflow）' })).toBeVisible();
  await panel.getByLabel('选择场景操作').selectOption('submit');
  await panel.getByText('查看操作步骤（5）', { exact: true }).click();
  const preview = panel.getByRole('list', { name: '操作步骤预览' });
  await expect(preview.getByRole('listitem')).toHaveCount(5);
  await expect(preview).toContainText('输入文本 · price');
  await expect(preview).toContainText('等待控件 · submit');
  await expect(preview.getByRole('listitem').nth(0)).toContainText(
    'price → Widget Key：order.price · 来源：Flutter VM',
  );
  await expect(preview.getByRole('listitem').nth(1)).toContainText(
    'submit → Widget Key：order.submit · 来源：跟随操作通道',
  );
  await expect(preview.getByRole('listitem').nth(2)).toContainText(
    'list → 其他选择器（详见场景配置） · 来源：设备',
  );
  await expect(preview.getByRole('listitem').nth(2)).toContainText('submit → Widget Key：order.submit');
  await expect(preview).toContainText('调用操作 · 余额不足 / 等待主页');
  await expect(preview.getByRole('listitem').nth(4)).toHaveText('收起键盘hide');
  await expect(preview).not.toContainText('undefined');
  await expect(panel).not.toContainText('never-render-this-default');
  await expect(panel).not.toContainText('never-render-this-text');
  await expect(panel).not.toContainText('never-render-this-selector-text');
  await expect(panel).not.toContainText('never-render-this-ancestor-semantics');
  await expect(panel).not.toContainText('never-render-this-device-selector');
  await expect(panel.getByLabel('操作参数 password')).toHaveValue('');
  await panel.getByRole('button', { name: '运行操作', exact: true }).click();
  expect((await messages(page)).filter((item: any) => item.action === 'scenes.actions.run')).toEqual([
    {
      action: 'scenes.actions.run',
      payload: { sceneId: 'common', actionId: 'submit', inputs: {}, backend: 'auto' },
    },
  ]);
});

test('empty UI workflow explains configuration and provides explicit reload', async ({ page }) => {
  const panel = await openActions(page, {
    scenes: { ...base.scenes, scenes: [{ ...commonScene, actions: undefined }, mockScene] },
  });
  await expect(panel.getByText('尚未配置 UI 操作', { exact: true })).toBeVisible();
  await expect(panel).toContainText('targets 和 actions');
  await expect(panel).toContainText('激活场景、重连和重新加载均不会自动执行');
  await panel.getByRole('button', { name: '重新加载场景配置', exact: true }).click();
  expect((await messages(page)).at(-1)).toEqual({ action: 'project.reload', payload: {} });
  await expect(panel.getByRole('button', { name: '运行操作', exact: true })).toHaveCount(0);
  await update(page, { sceneActions: { running: true, locked: true } });
  await expect(panel.getByRole('button', { name: '重新加载场景配置', exact: true })).toBeDisabled();
});

import { test, expect } from '@playwright/test';

const workflow = {
  id: 'submit',
  name: '提交订单',
  inputs: { price: { required: true }, password: { secret: true } },
  stepCount: 2,
};
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
  workflows: {
    file: '/project/.flutter-pilot/workflows.json',
    catalogue: { workflows: [workflow] },
    running: false,
    locked: false,
  },
  tests: {
    file: '/project/.flutter-pilot/tests.json',
    catalogue: {
      tests: [{ id: 'pending', name: '本轮订单 pending', workflowId: 'submit', assertionCount: 2 }],
    },
    running: false,
    locked: false,
  },
};
async function update(page: any, patch: any = {}) {
  await page.evaluate((state: any) => window.postMessage({ type: 'state', state }, '*'), {
    ...base,
    ...patch,
  });
}
test('saved flow preserves decimal strings and clears secret inputs after starting', async ({ page }) => {
  await page.goto('/');
  await update(page);
  await page.getByRole('button', { name: /业务流程/ }).click();
  await page.getByLabel('选择流程').selectOption('submit');
  await expect(page.getByRole('button', { name: '运行流程', exact: true })).toBeDisabled();
  await page.getByLabel('流程参数 price').fill('0.0012300');
  await page.getByLabel('流程参数 password').fill('fixture-secret');
  await expect(page.getByLabel('流程参数 password')).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '运行流程', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__messages)).toContainEqual({
    action: 'workflows.run',
    payload: {
      workflowId: 'submit',
      inputs: { price: '0.0012300', password: 'fixture-secret' },
      backend: 'auto',
    },
  });
  await expect(page.getByLabel('流程参数 password')).toHaveValue('');
});
test('clearing a secret workflow override uses its configured default', async ({ page }) => {
  await page.goto('/');
  await update(page, {
    workflows: {
      ...base.workflows,
      catalogue: {
        workflows: [
          {
            ...workflow,
            inputs: { password: { secret: true, default: '[REDACTED]' } },
          },
        ],
      },
    },
  });
  await page.getByRole('button', { name: /业务流程/ }).click();
  await page.getByLabel('选择流程').selectOption('submit');
  await page.getByLabel('流程参数 password').fill('temporary');
  await page.getByLabel('流程参数 password').clear();
  await page.getByRole('button', { name: '运行流程', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__messages)).toContainEqual({
    action: 'workflows.run',
    payload: { workflowId: 'submit', inputs: {}, backend: 'auto' },
  });
});
test('workflow completion is distinct from business test success, and uncertain tests expose evidence', async ({
  page,
}) => {
  await page.goto('/');
  await update(page, {
    workflows: {
      ...base.workflows,
      run: {
        runId: 'flow-1',
        name: '提交订单',
        status: 'completed',
        message: '操作完成',
        metrics: { totalMs: 20, resolveMs: 2, inputMs: 3, waitMs: 5, stepsCompleted: 0 },
        steps: [],
      },
    },
  });
  await page.getByRole('button', { name: /业务流程/ }).click();
  await expect(
    page.getByRole('region', { name: '流程运行结果' }).getByText('操作完成', { exact: true }).first(),
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
test('test controls run explicitly, respect ownership and cancel independently on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await update(page);
  await page.getByRole('button', { name: /业务测试/ }).click();
  await page.getByLabel('选择测试').selectOption('pending');
  await page.getByLabel('测试参数 price').fill('100.00');
  await page.getByRole('button', { name: '运行测试', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__messages)).toContainEqual({
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
  expect(await page.evaluate(() => (window as any).__messages)).toContainEqual({
    action: 'tests.cancel',
    payload: { runId: 'active' },
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

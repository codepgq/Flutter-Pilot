import { expect, test } from '@playwright/test';

const connected = {
  mode: 'vm',
  workspace: '/workspace/demo',
  busy: false,
  rules: [],
  pending: [],
  history: { items: [], total: 0 },
  engine: { status: 'stopped' },
  proxyActive: false,
  lan: false,
  addresses: [],
  devices: [],
  connectionHost: '127.0.0.1',
  logs: [],
  vm: { status: 'connected', isolates: 1, recorded: 0, instances: 0, mockEnabled: false, warnings: [] },
};
async function update(page: import('@playwright/test').Page, overrides = {}) {
  await page.evaluate((state) => window.postMessage({ type: 'state', state }, '*'), {
    ...connected,
    ...overrides,
  });
}
test('header screenshot targets the connected App and respects unavailable and busy states', async ({
  page,
}) => {
  await page.goto('/');
  const button = page.getByRole('button', { name: '截图', exact: true });
  await expect(button).toBeDisabled();
  await update(page);
  await button.click();
  expect(await page.evaluate(() => (window as any).__messages)).toContainEqual({
    action: 'screenshot.capture',
    payload: {},
  });
  await update(page, { busy: true });
  await expect(button).toBeDisabled();
  await update(page, { vm: { ...connected.vm, status: 'disconnected' } });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', '请先连接 Flutter Debug VM');
  await update(page, { mode: 'proxy' });
  await expect(button).toBeDisabled();
});
test('screenshot remains visible and usable on a narrow workbench', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await update(page);
  await expect(page.getByRole('button', { name: '截图', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/screenshot-entry-narrow.png', fullPage: true });
});

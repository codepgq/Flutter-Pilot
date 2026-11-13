import { test, expect } from '@playwright/test';

const mcp = {
  enabled: false,
  running: false,
  scope: 'project',
  clients: [],
  ui: { supported: false, reason: '尚未探测' },
  agents: ['claude', 'codex-cli', 'codex-app'].map((agent) => ({
    agent,
    scope: 'project',
    status: 'not-configured',
    configured: false,
    clientDetected: true,
    shared: agent !== 'claude',
    configPath: agent === 'claude' ? '/project/.mcp.json' : '/project/.codex/config.toml',
  })),
};
async function load(page: any, override = {}) {
  await page.goto('/');
  await page.evaluate(
    ({ mcp, override }: any) =>
      window.postMessage(
        {
          type: 'state',
          state: {
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
            vm: { status: 'disconnected', warnings: [] },
            mcp,
            ...override,
          },
        },
        '*',
      ),
    { mcp, override },
  );
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
}
test('MCP defaults to project scope and emits explicit adapter/enable controls', async ({ page }) => {
  await load(page);
  await expect(page.getByLabel('适配范围')).toHaveValue('project');
  await expect(page.getByRole('button', { name: '探测 UI 能力' })).not.toBeVisible();
  await expect(page.getByText('topic: workflow', { exact: true })).not.toBeVisible();
  await page.getByText('服务诊断与 UI 探测', { exact: true }).click();
  await expect(page.getByRole('button', { name: '探测 UI 能力' })).toBeVisible();
  await expect(page.getByRole('button', { name: '探测 UI 能力' })).toBeDisabled();
  await page.getByText('服务诊断与 UI 探测', { exact: true }).click();
  const toggle = page.getByRole('switch', { name: '开启 MCP' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await page
    .getByRole('article', { name: 'Claude Code CLI' })
    .getByRole('button', { name: '一键适配' })
    .click();
  expect(await page.evaluate(() => (window as any).__messages)).toEqual(
    expect.arrayContaining([
      { action: 'mcp.enable', payload: { enabled: true } },
      { action: 'mcp.adapt', payload: { agent: 'claude', scope: 'project' } },
    ]),
  );
  await page.getByLabel('适配范围').selectOption('global');
  expect(await page.evaluate(() => (window as any).__messages)).toContainEqual({
    action: 'mcp.inspect',
    payload: { scope: 'global' },
  });
});
test('device automation prepares explicitly and connects only an identified app and device', async ({
  page,
}) => {
  await load(page, {
    automation: {
      status: 'ready',
      installed: true,
      diagnostics: [],
      devices: [
        { id: 'android-test', name: 'Fixture phone', platform: 'android', kind: 'physical', state: 'device' },
      ],
    },
  });
  const panel = page.getByRole('region', { name: '设备自动化', exact: true });
  await expect(panel.getByRole('button', { name: '连接设备自动化', exact: true })).toBeDisabled();
  await panel.getByLabel('自动化设备').selectOption('android-test');
  await panel.getByLabel('App 包名 / Bundle ID').fill('dev.fixture.app');
  await panel.getByRole('button', { name: '连接设备自动化', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__messages)).toContainEqual({
    action: 'automation.connect',
    payload: { deviceId: 'android-test', appId: 'dev.fixture.app' },
  });
});
test('iOS physical devices show signed WDA requirements and remain usable at narrow width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page, {
    automation: {
      status: 'ready',
      installed: true,
      diagnostics: [],
      devices: [
        { id: 'ios-test', name: 'Fixture iPhone', platform: 'ios', kind: 'physical', state: 'connected' },
      ],
    },
  });
  await page.getByLabel('自动化设备').selectOption('ios-test');
  await page.getByLabel('App 包名 / Bundle ID').fill('dev.fixture.ios');
  await expect(page.getByLabel('已签名 WDA 路径')).toBeVisible();
  await expect(page.getByRole('button', { name: '连接设备自动化', exact: true })).toBeDisabled();
  await page.getByLabel('已签名 WDA 路径').fill('/tmp/fixture.app');
  await page.getByLabel('WDA Bundle ID').fill('dev.fixture.wda');
  await expect(page.getByRole('button', { name: '连接设备自动化', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('configured status does not imply loaded and conflicts require explicit repair', async ({ page }) => {
  await load(page, {
    mcp: {
      ...mcp,
      enabled: true,
      running: true,
      agents: [
        { ...mcp.agents[0], status: 'configured', configured: true },
        { ...mcp.agents[1], status: 'conflict' },
        mcp.agents[2],
      ],
    },
  });
  const claude = page.getByRole('article', { name: 'Claude Code CLI' });
  await expect(claude).toContainText('待客户端连接');
  await expect(claude.getByRole('button', { name: '移除适配' })).not.toBeVisible();
  await claude.getByText('配置与维护', { exact: true }).click();
  await claude.getByRole('button', { name: '查看配置' }).click();
  expect(await page.evaluate(() => (window as any).__messages)).toContainEqual({
    action: 'mcp.config.open',
    payload: { agent: 'claude', scope: 'project' },
  });
  await page
    .getByRole('article', { name: 'Codex CLI', exact: true })
    .getByRole('button', { name: '修复本插件配置' })
    .click();
  expect(await page.evaluate(() => (window as any).__messages)).toContainEqual({
    action: 'mcp.adapt',
    payload: { agent: 'codex-cli', scope: 'project', repair: true },
  });
});
test('MCP settings remain usable at narrow width and are disabled during mutation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await load(page, { busy: true });
  await expect(page.getByRole('switch', { name: '开启 MCP' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/mcp-tab-narrow.png', fullPage: true });
});

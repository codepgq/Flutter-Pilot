import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Run against an already running local Admin dev server. The Chrome session uses no HTTP interception.
const [root, upstream] = process.argv.slice(2);
if (!root || !upstream)
  throw new Error('Usage: node scripts/local-browser-admin-smoke.mjs ADMIN_ROOT ADMIN_LOGIN_URL');
const temporary = await mkdtemp(join(tmpdir(), 'pilot-local-chrome-'));
const seen = [];
let gateway, browser;
try {
  const entry = join(temporary, 'gateway.cjs');
  await build({
    stdin: {
      contents: `export { startLocalMock } from './src/browser/local-mock'; export { SceneStore } from './src/scenes';`,
      resolveDir: process.cwd(),
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const { SceneStore, startLocalMock } = createRequire(import.meta.url)(entry);
  const store = new SceneStore(resolve(root, '.flutter-pilot'), join(temporary, 'storage'));
  await store.load();
  const scene = (await store.prepareSnapshot([], 'admin-stateful')).scenes[0];
  const direct = await fetch(new URL('/back-office/v1/operator-sessions', upstream), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(direct.status, 404);
  gateway = await startLocalMock({
    upstream,
    rules: scene.httpRules,
    onHit: (rule, status) => seen.push({ rule, status }),
  });
  const origin = new URL(gateway.url).origin;
  browser = await chromium.launch({ channel: 'chrome', args: ['--no-proxy-server'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(gateway.url);
  await page.getByTestId('access-email').fill('admin@savvi.test');
  await page.getByTestId('access-password').fill('SavviDemo123');
  const login = page.waitForResponse((reply) => reply.url().endsWith('/back-office/v1/operator-sessions'));
  const list = page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === '/admin/v1/expert-applications',
  );
  await page.getByTestId('access-submit').click();
  const loginResponse = await login;
  assert.equal(loginResponse.status(), 200);
  assert.equal(loginResponse.headers()['x-flutter-pilot-mock-rule'], 'admin-stateful-login-admin');
  const listResponse = await list;
  assert.equal(listResponse.status(), 200);
  assert.equal(listResponse.headers()['x-flutter-pilot-mock-rule'], 'admin-stateful-application-list');
  await page.getByText('Noura Mohammed Al Salem', { exact: true }).waitFor();
  await page.goto(`${origin}/accounts`);
  const email = 'chrome-smoke@savvi.test';
  await page.getByTestId('account-create').click();
  await page.getByTestId('account-email').fill(email);
  await page.getByTestId('account-display-name').fill('Chrome Mock Smoke');
  await page.getByTestId('account-editor-submit').click();
  await page.getByTestId('account-table').getByText(email, { exact: true }).waitFor();
  const recipient = await context.newPage();
  await recipient.goto(`${origin}/__mock/inbox`);
  await recipient.getByRole('row').filter({ hasText: email }).getByRole('link').click();
  await recipient.getByTestId('access-password').fill('LocalChromeMock123');
  await recipient.getByTestId('access-confirm').fill('LocalChromeMock123');
  await recipient.getByTestId('access-submit').click();
  await recipient.getByTestId('operator-access-success').waitFor();
  await recipient.getByTestId('access-back').click();
  await recipient.getByTestId('access-email').fill(email);
  await recipient.getByTestId('access-password').fill('LocalChromeMock123');
  await recipient.getByTestId('access-submit').click();
  await recipient.getByTestId('admin-account-name').getByText('Chrome Mock Smoke').waitFor();
  assert.ok(seen.some(({ rule, status }) => rule === 'admin-stateful-account-invite' && status === 201));
  assert.ok(seen.some(({ rule, status }) => rule === 'admin-stateful-inbox' && status === 200));
  console.log(
    JSON.stringify(
      {
        chrome: browser.version(),
        directStatus: direct.status,
        finalPath: new URL(recipient.url()).pathname,
        seen,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(JSON.stringify({ seen }));
  throw error;
} finally {
  await browser?.close();
  await gateway?.stop();
  await rm(temporary, { recursive: true, force: true });
}

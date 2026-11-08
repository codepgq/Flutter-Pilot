import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/ui',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4179',
    browserName: 'chromium',
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'node scripts/ui-server.mjs',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});

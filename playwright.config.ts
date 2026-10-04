import { defineConfig } from '@playwright/test';
const baseURL = `https://localhost:${process.env.CALENDAR_TEST_PORT ?? '4173'}`;
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1,
  use: { baseURL, ignoreHTTPSErrors: true, timezoneId: 'Europe/Prague', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'firefox', use: { browserName: 'firefox' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: { command: 'npm run build && npm run dev:certs && node_modules/.bin/tsx tests/browser/server.ts', url: `${baseURL}/healthz`, ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 60000 },
});

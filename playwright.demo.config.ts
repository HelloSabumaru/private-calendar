import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4184/calendar/';
export default defineConfig({
  testDir: './tests/demo-browser', fullyParallel: false, workers: 1,
  use: { baseURL, timezoneId: 'Europe/Prague', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'firefox', use: { browserName: 'firefox' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: { command: 'npm run build:demo && node_modules/.bin/vite preview --mode demo --host 127.0.0.1 --port 4184 --strictPort --base /calendar/', url: baseURL, reuseExistingServer: false, timeout: 60000 },
});

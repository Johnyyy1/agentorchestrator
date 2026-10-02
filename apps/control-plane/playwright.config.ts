import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'smoke.spec.ts', timeout: 60000, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3107', browserName: 'chromium', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run fixtures --workspace @jonas-os/control-plane -- --port 3107', cwd: '../..', url: 'http://127.0.0.1:3107', timeout: 120000, reuseExistingServer: false },
});

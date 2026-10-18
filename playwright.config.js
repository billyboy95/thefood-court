import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  workers: 1,
  use: {
    viewport: { width: 390, height: 844 },
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'rm -f data/e2e.sqlite && node server/index.js',
    port: 4173,
    env: { ...process.env, PORT: '4173', HOST: '127.0.0.1', DATABASE_PATH: 'data/e2e.sqlite' },
    reuseExistingServer: false,
  },
});

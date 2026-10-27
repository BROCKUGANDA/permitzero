import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end suite against a live stack: the real API (own database,
 * deterministic model provider) plus the real Next.js app. Global setup
 * recreates and seeds the e2e database; specs only ever touch fixtures.
 */
const WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? 3100);
const API_PORT = Number(process.env['E2E_API_PORT'] ?? 3101);
const API_URL = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: './test-results',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  globalSetup: './tests/e2e/global-setup.ts',
  projects: [{ name: 'chromium', use: { viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: 'npx tsx tests/e2e/ensure-db.ts && npx tsx ../../apps/api/src/server.ts',
      cwd: webRoot,
      port: API_PORT,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(API_PORT),
        APP_ENV: 'test',
        DATABASE_URL: process.env['E2E_DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:5432/permitzero_e2e',
        PERMIT_SIGNING_KEY: process.env['E2E_PERMIT_SIGNING_KEY'] ?? 'e2e-signing-key-0123456789abcdef',
        PERMIT_SIGNING_KEY_ID: 'k-e2e',
        MODEL_PROVIDER: 'disabled',
        RATE_LIMIT_MAX: '100000',
      },
    },
    {
      command: `npx next dev -p ${WEB_PORT}`,
      cwd: webRoot,
      port: WEB_PORT,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: { NEXT_PUBLIC_API_URL: API_URL },
    },
  ],
});

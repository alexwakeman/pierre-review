import { defineConfig, devices } from '@playwright/test';

// E2E regression suite for the My Turn / Feed / Focus-mode UX flows. The specs intercept
// every /api/** request with deterministic fixtures (see apps/frontend/e2e/mock-api.ts),
// so only the Vite dev server is needed — no backend, DB, or gh. Locally it reuses an
// already-running `pnpm dev` (port 5173); on CI it boots the frontend dev server itself.
export default defineConfig({
  testDir: './apps/frontend/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1600, height: 1000 },
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @pierre-review/frontend dev',
    url: 'http://localhost:5173/app/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

import { defineConfig, devices } from '@playwright/test';

/**
 * Focused config for the service-worker offline/update suites (ADR-005 Decision 9).
 *
 * These specs serve their own two-build fixture server (the ADR's server-swap harness), so the
 * shared `npm run build` + `vite preview` webServer from playwright.config.ts is deliberately
 * NOT started here — the SW suites stay runnable even while other cards' builds are mid-flight.
 * `npm run e2e` (CI) runs the same specs under the main config as well.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /(?:offline|update)(?:-[\w-]+)?\.spec\.ts/u,
  globalSetup: './tests/e2e/fixtures/global-setup.mjs',
  fullyParallel: true,
  forbidOnly: process.env['CI'] === 'true',
  retries: process.env['CI'] === 'true' ? 1 : 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

import { defineConfig, devices } from '@playwright/test';

/**
 * Focused config for the E7 organization QA probes (test card t_ed1fa949).
 *
 * Like playwright.data-safety.config.ts, the shared `npm run build` +
 * `vite preview` webServer is deliberately NOT started: the harness builds and
 * serves its own fixture (REAL `src/storage` engine in a real Chromium page),
 * so the migration + rename-timing probes stay runnable while sibling cards'
 * builds are mid-flight in this workspace.
 */

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /e7-organization-probe\.spec\.ts/u,
  fullyParallel: false,
  forbidOnly: process.env['CI'] === 'true',
  retries: process.env['CI'] === 'true' ? 1 : 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

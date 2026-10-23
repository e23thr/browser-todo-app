import { defineConfig, devices } from '@playwright/test';

import { APP_URL, BASE_PATH, PREVIEW_PORT } from './tests/e2e/helpers';

/**
 * Playwright config (ADR-001 §6).
 *
 * `webServer` builds the production bundle under the configured base path and serves it with
 * `vite preview`, so every E2E run also proves the non-root base path works end to end.
 * `reuseExistingServer` is ALWAYS false (QA defect D3): reusing a server left over from an older
 * run let local E2E test a stale `dist`. A port already in use now fails the run loudly instead
 * of silently serving old bytes. CI is unaffected — it already forced a fresh build.
 * CI jobs install a single browser (`npm run e2e:install`); the cross-browser matrix lives in
 * .github/workflows/nightly.yml.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: process.env['CI'] === 'true',
  retries: process.env['CI'] === 'true' ? 1 : 0,
  reporter: process.env['CI'] === 'true' ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // ADR-005 Decision 9: the offline/update suites need their two-marked-build fixtures; build
  // them once per run (workers must never build the same directories concurrently).
  globalSetup: './tests/e2e/fixtures/global-setup.mjs',
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // Thai-locale pass (§8): exercises system-font Thai rendering / reflow under th-TH.
    { name: 'chromium-th', use: { ...devices['Desktop Chrome'], locale: 'th-TH' } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${String(PREVIEW_PORT)} --strictPort`,
    url: APP_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { BASE_PATH: BASE_PATH },
  },
});

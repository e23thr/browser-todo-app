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
 *
 * The preview MUST bind `--host 127.0.0.1` (t_46622f83): the readiness poll and every test hit
 * `http://127.0.0.1:<port>` (APP_URL below), but `vite preview` with no `--host` binds
 * `listen(port, 'localhost')` — a SINGLE address chosen by the host's DNS lookup order for
 * `localhost`. Where that resolves to `::1` first (GitHub Actions runners), the server listens on
 * `[::1]` only, the 127.0.0.1 poll gets ECONNREFUSED forever, and Playwright fails with
 * "Timed out waiting 180000ms from config.webServer." (CI run 40194624821, e2e-smoke +
 * a11y-axe). Pinning the bind address to the poll address makes startup deterministic
 * regardless of resolver order.
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
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${String(PREVIEW_PORT)} --strictPort`,
    url: APP_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { BASE_PATH: BASE_PATH },
  },
});

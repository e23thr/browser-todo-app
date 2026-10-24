import { defineConfig, devices } from '@playwright/test';

/**
 * Focused config for the E3 drill + UX real-storage suites (test cards t_f0702c05,
 * t_b1595f03).
 *
 * `tests/e2e/data-safety-journey.spec.ts` and `tests/e2e/data-safety-ux.spec.ts` build and
 * serve their own harnesses (real `src/portability` + `src/storage` engine, and the real
 * Preact data-safety surface, in a real Chromium page), so — like playwright.sw.config.ts —
 * the shared `npm run build` + `vite preview` webServer is deliberately NOT started here:
 * the corruption/data-loss drills and the real-StorageManager pass stay runnable while
 * sibling cards' builds are mid-flight. `npm run e2e` (nightly matrix) runs the same
 * specs under the main config as well.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /data-safety-(journey|ux)\.spec\.ts/u,
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

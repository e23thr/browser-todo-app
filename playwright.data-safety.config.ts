import { defineConfig, devices } from '@playwright/test';

/**
 * Focused config for the E3 data-engine drill suite (test card t_f0702c05).
 *
 * `tests/e2e/data-safety-journey.spec.ts` builds and serves its own engine harness
 * (real `src/portability` + `src/storage` in a real Chromium page), so — like
 * playwright.sw.config.ts — the shared `npm run build` + `vite preview` webServer is
 * deliberately NOT started here: the corruption/data-loss drills stay runnable while
 * sibling cards' builds are mid-flight. `npm run e2e` (nightly matrix) runs the same
 * specs under the main config as well.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /data-safety-journey\.spec\.ts/u,
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

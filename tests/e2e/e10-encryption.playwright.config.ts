/**
 * E10-only Playwright config (test card t_0a8e0c42) — app-server-free run of
 * `e10-encryption.spec.ts`.
 *
 * The main `playwright.config.ts` starts a global `webServer` that runs
 * `npm run build` (= `tsc -b` + vite). This config exists so the E10 encryption
 * drills can run WITHOUT the production bundle, because:
 *   - the drills do not exercise the app shell at all: they build their own
 *     harness (pure vite, no tsc — see tests/e2e/encryption/vite.config.mjs)
 *     and serve it from the ADR-005 fixture server, exactly as
 *     `data-safety-journey.spec.ts` does; and
 *   - `tsc -b` is red in the shared worktree from a SIBLING card's in-flight
 *     recurrence edits (`src/domain/recurrence.ts`, `src/features/tasks/*` —
 *     recorded as `preexisting_not_mine` in the E10 impl handoff), which is
 *     unrelated to encryption and out of this card's scope.
 *
 * The spec remains fully covered by the standard `npm run e2e` through
 * `playwright.config.ts`'s `testDir: './tests/e2e'` once the tree is clean —
 * this file is an additional, narrower entry point, not a replacement.
 *
 * Run: npx playwright test --config tests/e2e/e10-encryption.playwright.config.ts
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'e10-encryption.spec.ts',
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

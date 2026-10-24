import type { Page } from '@playwright/test';

/**
 * Single source of truth for the preview server address used by the E2E suite.
 *
 * The suite deliberately runs against a NON-ROOT base path (`/<repo>/`) because that is what
 * GitHub Pages project pages serve (§9.5) — it is the only way the base-path wiring stays tested.
 */
/**
 * Preview port for the suite. 4173 is the agreed default (CI and the docs assume it);
 * `E2E_PORT` overrides it so two checkouts on the same host can run the suite concurrently
 * instead of racing for the port and serving each other a stale build.
 */
export const PREVIEW_PORT = Number(process.env['E2E_PORT'] ?? 4173);

export const BASE_PATH = process.env['BASE_PATH'] ?? '/browser-todo-app/';

export const APP_ORIGIN = `http://127.0.0.1:${String(PREVIEW_PORT)}`;

/** Absolute URL of the app under the configured base path. */
export const APP_URL = `${APP_ORIGIN}${BASE_PATH}`;

/** Routes exercised by the smoke and a11y suites. */
export const CORE_ROUTES = [
  '',
  '#/today',
  '#/week',
  '#/all',
  '#/completed',
  '#/search',
  '#/list/01TESTLIST',
  '#/settings',
] as const;

/**
 * Seed E3's first-run onboarding as already completed, before any page script runs.
 *
 * A fresh browser profile (exactly what CI runs) paints the first-run onboarding screen
 * ("Your data lives in this browser") INSTEAD of the app shell until its "Get started" CTA is
 * taken, so any spec whose subject is the shell — not the first-run journey itself — must take
 * that handshake first. Seeding the durable ADR-002 Decision 7 marker is the black-box way to
 * do it: the literal `todo:prefs:v1:onboardingStep` → `'done'` contract from
 * `src/features/data-safety/flags.ts`, never imported from `src/` (tests stay black-box), and
 * try-guarded like every prefs write so a hardened/private storage degrades to the real
 * first-run journey rather than crashing the init script.
 *
 * A seeded zero-task profile boots `normal`, not `wiped` — since 2e6da03 the §3.4 row-1 wipe
 * discriminator requires evidence the profile once HELD rows, so this seed cannot route a test
 * into the recovery screen.
 */
export async function seedOnboardingDone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
    } catch {
      /* hardened/private mode: storage unavailable, the app degrades the same way */
    }
  });
}

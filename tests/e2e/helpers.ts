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

/**
 * Install the `securitypolicyviolation` collector behind the runtime-CSP assertions
 * (ADR-005 Decision 9 test 9 "no CSP violations…", smoke's "no CSP violation fires…").
 *
 * Attribution contract (t_e20c2adb — run 40216306668's webkit reds): the collector records the
 * violations THE DOCUMENT caused, not every event the engine emits. WebKit 26.5–27.2
 * (Playwright 1.63 → 1.65-alpha; WebKit r2365–r2380) fires a `style-src-attr` violation from
 * inside `<select>`'s UA shadow tree — a UA `text-overflow: inherit` slot style attribute the
 * page never authored — merely on `<select>` creation (upstream: WebKit PR WebKit/WebKit#77544
 * for bug 327212; Playwright #43416 / #43497 / #43617; fixed only from WebKit r2383+). No
 * released Playwright ships a WebKit carrying that fix together with the offline-navigation
 * fix (r2370): verified empirically 2026-10-26 against webkit-2359/2361/2370/2380 — 2359 and
 * 2361 crash on `setOffline` navigations, 2370 and 2380 report the false positive — so the
 * harness cannot pin its way out, and the product's §7.2 CSP must not be loosened to mask a
 * browser bug. The collector therefore attributes each violation before recording it.
 *
 * Soundness (verified empirically on BOTH chromium and webkit with
 * `scripts/diag-discriminator.mjs`): every page-authored path to a style-attribute violation —
 * HTML parsing of `style="…"` or `setAttribute('style', …)` — still carries that attribute on
 * the target element when the event fires, while the UA-shadow violation's target carries no
 * style attribute (it is the retargeted `<select>` host, or the document). So a `style-src-attr`
 * violation counts as page-authored only when its target carries a `style` attribute; every
 * other directive always counts. A genuine app-authored inline style therefore still fails the
 * `toEqual([])` assertions on every engine — this narrows WHAT is attributed, not what is
 * asserted.
 */
export async function installCspCollector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      const target = event.target;
      const pageAuthored =
        event.violatedDirective !== 'style-src-attr' ||
        (target instanceof Element && target.hasAttribute('style'));
      if (pageAuthored) {
        violations.push(`${event.violatedDirective} blocked=${event.blockedURI}`);
      }
    });
  });
}

/** Read the collected page-authored CSP violations. */
export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
  );
}

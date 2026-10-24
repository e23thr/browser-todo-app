import { expect, test, type Page } from '@playwright/test';

import { APP_URL, seedOnboardingDone } from './helpers';

/**
 * No-flash theme boot (M7 / design §5.2): the hashed inline `#theme-boot` snippet must paint
 * the correct theme on `<html>` BEFORE first paint, in all three preference modes.
 *
 * How this is proven: an init script installs a MutationObserver on `documentElement[data-theme]`
 * before any page script runs, timestamps the first non-null value, and a PerformanceObserver
 * records first-contentful-paint. The test asserts the theme was applied at-or-before FCP — a
 * late application (the flash the spec forbids) would land after it.
 *
 * First-run handshake (E3): a fresh profile's true first paint is the onboarding screen, so the
 * shell-bound scenarios take `seedOnboardingDone()` on boot (the probe below is untouched); the
 * 'absent preference' scenario additionally proves the ONBOARDING screen's own first paint is
 * flash-free via the real, unseeded first-run journey.
 */

const THEME_KEY = 'todo:prefs:v1:theme';
/** The suite's seeded first-run handshake marker (ADR-002 Decision 7) — not an app write. */
const ONBOARDING_KEY = 'todo:prefs:v1:onboardingStep';

interface ThemeEvent {
  readonly value: string | null;
  readonly time: number;
}

interface ThemeProbe {
  readonly events: ThemeEvent[];
  fcp: number | null;
}

interface WindowWithProbe {
  __themeProbe?: ThemeProbe;
}

interface DocumentState {
  readonly theme: string | null;
  readonly colorScheme: string;
  readonly storageKeys: readonly string[];
}

async function instrument(
  page: Page,
  pref: string | null,
  systemScheme: 'light' | 'dark',
): Promise<void> {
  await page.emulateMedia({ colorScheme: systemScheme });
  await page.addInitScript(
    ({ key, value }: { key: string; value: string | null }) => {
      if (value === null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, value);
      }

      const probe: ThemeProbe = { events: [], fcp: null };
      (window as WindowWithProbe).__themeProbe = probe;

      const record = (): void => {
        probe.events.push({
          value: document.documentElement.dataset['theme'] ?? null,
          time: performance.now(),
        });
      };

      const watchPaint = (): void => {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') probe.fcp = entry.startTime;
          }
        }).observe({ type: 'paint', buffered: true });
      };

      const install = (root: HTMLElement): void => {
        new MutationObserver(record).observe(root, {
          attributes: true,
          attributeFilter: ['data-theme'],
        });
        record();
        watchPaint();
      };

      // Playwright's init script runs before parsing starts, so `document.documentElement`
      // can still be null (the DOM type lies about this); install the observer as soon as the
      // root element exists — always before the inline #theme-boot snippet could have painted.
      const root = document.documentElement as HTMLElement | null;
      if (root !== null) {
        install(root);
      } else {
        const rootObserver = new MutationObserver(() => {
          const next = document.documentElement as HTMLElement | null;
          if (next === null) return;
          rootObserver.disconnect();
          install(next);
        });
        rootObserver.observe(document, { childList: true });
      }
    },
    { key: THEME_KEY, value: pref },
  );
}

async function expectThemePaintedBeforeFirstPaint(
  page: Page,
  expected: 'light' | 'dark',
): Promise<void> {
  await page.goto(APP_URL);
  await expect(page.getByRole('heading', { level: 1, name: 'Today', exact: true })).toBeVisible();

  const probe = await page.evaluate(() => (window as WindowWithProbe).__themeProbe ?? null);
  expect(probe, 'the pre-paint probe must have been installed').not.toBeNull();
  expect(probe?.fcp, 'first-contentful-paint must have been observed').not.toBeNull();

  const painted = probe?.events.find((event) => event.value !== null);
  expect(painted, 'the inline boot snippet must set data-theme').toBeTruthy();
  expect(painted?.value).toBe(expected);
  // No flash: the theme landed before (or exactly at) the first painted frame.
  expect(painted?.time).toBeLessThanOrEqual(probe?.fcp ?? Number.POSITIVE_INFINITY);

  const state = await page.evaluate((): DocumentState => ({
    theme: document.documentElement.dataset['theme'] ?? null,
    colorScheme: document.documentElement.style.colorScheme,
    storageKeys: Object.keys(window.localStorage),
  }));
  expect(state.theme).toBe(expected);
  expect(state.colorScheme).toBe(expected);
  // localStorage holds nothing but the boot-prefs mirror plus this suite's seeded first-run
  // handshake marker (a harness init-script write, never an app one); the mirror itself is
  // only written once a preference has actually been stored (ADR-002 Decision 7).
  expect(state.storageKeys.filter((key) => key !== THEME_KEY && key !== ONBOARDING_KEY)).toEqual(
    [],
  );
}

test('explicit light preference paints light even when the OS is dark', async ({ page }) => {
  await instrument(page, 'light', 'dark');
  await seedOnboardingDone(page);
  await expectThemePaintedBeforeFirstPaint(page, 'light');
});

test('explicit dark preference paints dark even when the OS is light', async ({ page }) => {
  await instrument(page, 'dark', 'light');
  await seedOnboardingDone(page);
  await expectThemePaintedBeforeFirstPaint(page, 'dark');
});

test('system preference follows a dark OS colour scheme', async ({ page }) => {
  await instrument(page, 'system', 'dark');
  await seedOnboardingDone(page);
  await expectThemePaintedBeforeFirstPaint(page, 'dark');
});

test('system preference follows a light OS colour scheme', async ({ page }) => {
  await instrument(page, 'system', 'light');
  await seedOnboardingDone(page);
  await expectThemePaintedBeforeFirstPaint(page, 'light');
});

test('an absent preference behaves like system', async ({ page, browser }) => {
  await instrument(page, null, 'dark');
  await seedOnboardingDone(page);
  await expectThemePaintedBeforeFirstPaint(page, 'dark');

  // The true first paint on a fresh profile is the onboarding screen, so it must be
  // flash-free too: replay the real, UNSEEDED first-run journey and check the probe
  // BEFORE dismissing it.
  const firstRun = await browser.newContext();
  const onboardingPage = await firstRun.newPage();
  await onboardingPage.emulateMedia({ colorScheme: 'dark' });
  await instrument(onboardingPage, null, 'dark');
  await onboardingPage.goto(APP_URL);

  await expect(
    onboardingPage.getByRole('heading', {
      level: 1,
      name: 'Your data lives in this browser',
      exact: true,
    }),
  ).toBeVisible();

  // The existing shell-bound helper reads the probe only after the shell's heavier render, so
  // the PerformanceObserver has always delivered FCP by then; the onboarding surface paints
  // fast enough to race it, so wait for the delivery before reading (assertions unchanged).
  await onboardingPage.waitForFunction(
    () => ((window as WindowWithProbe).__themeProbe ?? null)?.fcp != null,
  );

  const probe = await onboardingPage.evaluate(
    () => (window as WindowWithProbe).__themeProbe ?? null,
  );
  expect(probe, 'the pre-paint probe must have been installed').not.toBeNull();
  expect(probe?.fcp, 'first-contentful-paint must have been observed').not.toBeNull();
  const painted = probe?.events.find((event) => event.value !== null);
  expect(painted, 'the inline boot snippet must set data-theme').toBeTruthy();
  expect(painted?.value).toBe('dark');
  // No flash on the onboarding screen's own first paint either.
  expect(painted?.time).toBeLessThanOrEqual(probe?.fcp ?? Number.POSITIVE_INFINITY);

  const state = await onboardingPage.evaluate((): Omit<DocumentState, 'storageKeys'> => ({
    theme: document.documentElement.dataset['theme'] ?? null,
    colorScheme: document.documentElement.style.colorScheme,
  }));
  expect(state.theme).toBe('dark');
  expect(state.colorScheme).toBe('dark');

  // The handshake completes exactly as a real first run: the shell mounts after "Get started".
  await onboardingPage.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(
    onboardingPage.getByRole('heading', { level: 1, name: 'Today', exact: true }),
  ).toBeVisible();

  await firstRun.close();
});

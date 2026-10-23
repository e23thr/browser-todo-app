import { expect, test, type Page } from '@playwright/test';

import { APP_ORIGIN, APP_URL } from './helpers';

/**
 * E2E smoke (ADR-001 §6 / §7 CI matrix): boots under the GitHub-Pages-style base path, proves
 * hash deep links resolve, proves the CSP meta policy holds at runtime, and proves the app makes
 * zero third-party requests (§7.2).
 */

interface WindowWithDiagnostics {
  __cspViolations?: string[];
}

function collectRequests(page: Page): () => string[] {
  const origins = new Set<string>();
  page.on('request', (request) => {
    origins.add(new URL(request.url()).origin);
  });
  return () => [...origins];
}

test('boots under a non-root base path with no failed asset requests', async ({ page }) => {
  const failed: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failed.push(`${String(response.status())} ${response.url()}`);
  });

  await page.goto(APP_URL);

  await expect(page.getByRole('heading', { name: 'Today', level: 2 })).toBeVisible();
  expect(failed).toEqual([]);
});

test('hash deep links resolve without a server rewrite', async ({ page }) => {
  await page.goto(`${APP_URL}#/settings`);

  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  await expect(page).toHaveURL(`${APP_URL}#/settings`);

  // The settings route is a lazy chunk: navigating it must not require a full page reload.
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: 'Today', level: 2 })).toBeVisible();
  await expect(page).toHaveURL(`${APP_URL}#/today`);
});

test('an unknown hash renders the not-found view instead of a broken page', async ({ page }) => {
  await page.goto(`${APP_URL}#/nowhere`);

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Today' })).toBeVisible();
});

test('the skip link is the first focusable element', async ({ page }) => {
  await page.goto(APP_URL);
  await page.keyboard.press('Tab');

  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skipLink).toBeFocused();

  await skipLink.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('no CSP violation fires while the app boots and navigates', async ({ page }) => {
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as WindowWithDiagnostics).__cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective} blocked=${event.blockedURI}`);
    });
  });

  await page.goto(APP_URL);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: 'Today', level: 2 })).toBeVisible();

  const violations = await page.evaluate(
    () => (window as WindowWithDiagnostics).__cspViolations ?? [],
  );
  expect(violations).toEqual([]);
});

test('makes zero third-party requests at runtime', async ({ page }) => {
  const requestOrigins = collectRequests(page);

  await page.goto(APP_URL);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();

  const foreign = requestOrigins().filter((origin) => origin !== APP_ORIGIN);
  expect(foreign).toEqual([]);
});

test('the document ships the section 7.2 CSP meta tag without frame-ancestors', async ({
  page,
}) => {
  await page.goto(APP_URL);

  const content =
    (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')) ??
    '';
  expect(content).not.toBe('');
  expect(content).toContain("default-src 'self'");
  expect(content).toContain("script-src 'self'");
  expect(content).toContain("style-src 'self'");
  expect(content).toContain("img-src 'self' data: blob:");
  expect(content).toContain("connect-src 'self'");
  expect(content).toContain("object-src 'none'");
  expect(content).toContain("base-uri 'none'");
  expect(content).not.toContain('frame-ancestors');
});

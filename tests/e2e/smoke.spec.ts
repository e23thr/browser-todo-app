import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test, type Page } from '@playwright/test';

import { APP_ORIGIN, APP_URL, seedOnboardingDone } from './helpers';

/**
 * E2E smoke (ADR-001 §6 / §7 CI matrix): boots under the GitHub-Pages-style base path, proves
 * hash deep links resolve, proves the CSP meta policy holds at runtime, and proves the app makes
 * zero third-party requests (§7.2).
 *
 * First-run split (E3): on a fresh browser profile — exactly what CI runs — the first paint is
 * the onboarding screen, not the shell, so every test whose SUBJECT is the shell takes
 * `seedOnboardingDone(page)` first, and the two tests whose subject is the first-run journey
 * (the base-path boot and the "shows once and never again" reload) run unseeded on purpose.
 *
 * Locator policy: EVERY getByRole(..., { name }) in tests/e2e/ carries `exact: true`.
 * Playwright's default name matching is case-insensitive SUBSTRING matching, which silently
 * accepted a broken label — renaming the Today heading to "Todayy" passed the whole suite 7/7
 * (QA defect D1, docs/qa/e1-scaffold-gates.md §2.7). Never drop `exact: true`.
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

  // Deliberately NOT seeded: this test owns the TRUE first paint under the GitHub-Pages base
  // path, which on a fresh profile is the onboarding screen — so it walks the real journey.
  await page.goto(APP_URL);

  await expect(
    page.getByRole('heading', { name: 'Your data lives in this browser', level: 1, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();
  expect(failed).toEqual([]);
});

test('hash deep links resolve without a server rewrite', async ({ page }) => {
  await seedOnboardingDone(page);
  await page.goto(`${APP_URL}#/settings`);

  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${APP_URL}#/settings`);

  // The settings route is a lazy chunk: navigating it must not require a full page reload.
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${APP_URL}#/today`);
});

test('an unknown hash renders the not-found view instead of a broken page', async ({ page }) => {
  await seedOnboardingDone(page);
  await page.goto(`${APP_URL}#/nowhere`);

  await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Today', exact: true })).toBeVisible();
});

test('the skip link is the first focusable element', async ({ page }) => {
  await seedOnboardingDone(page);
  await page.goto(APP_URL);
  // The app mounts once initLocale() has settled (it lazy-loads the locale pack before the
  // first render), so wait for the first view before asserting keyboard order.
  await expect(page.getByRole('heading', { level: 1, name: 'Today', exact: true })).toBeVisible();
  await page.keyboard.press('Tab');

  const skipLink = page.getByRole('link', { name: 'Skip to main content', exact: true });
  await expect(skipLink).toBeFocused();

  await skipLink.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('no CSP violation fires while the app boots and navigates', async ({ page }) => {
  await seedOnboardingDone(page);
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as WindowWithDiagnostics).__cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective} blocked=${event.blockedURI}`);
    });
  });

  await page.goto(APP_URL);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();

  const violations = await page.evaluate(
    () => (window as WindowWithDiagnostics).__cspViolations ?? [],
  );
  expect(violations).toEqual([]);
});

test('makes zero third-party requests at runtime', async ({ page }) => {
  const requestOrigins = collectRequests(page);

  await seedOnboardingDone(page);
  await page.goto(APP_URL);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  ).toBeVisible();

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
  expect(content).toContain("object-src 'none'");
  expect(content).toContain("base-uri 'none'");
  expect(content).not.toContain('frame-ancestors');

  // connect-src is pinned EXACTLY (ADR-006 Addendum A): widened once for V1 WebDAV sync to
  // the engine's own allow-list (`assertSecureRemote`) and never narrower — and never wider:
  // plain-HTTP egress to non-loopback hosts must stay out of the source list.
  const directives = new Map(
    content.split(';').map((part) => {
      const [name = '', ...rest] = part.trim().split(' ');
      return [name, rest.join(' ')];
    }),
  );
  expect(directives.get('connect-src')).toBe("'self' https: http://localhost:* http://127.0.0.1:*");
});

test('connect-src admits a user-provided WebDAV origin and still blocks plain-HTTP egress', async ({
  page,
}) => {
  // Regression guard for E8 defect B2: `connect-src 'self'` silently blocked EVERY request to a
  // user-provided WebDAV origin (surfaced to users as a CORS/server error). jsdom cannot see CSP,
  // so this is proven against the built artifact in a real browser: a cross-origin loopback host
  // (any port is cross-origin for the app) receives a WebDAV-style PROPFIND with an Authorization
  // header — which forces a CORS preflight — while a plain-HTTP external URL stays refused with
  // exactly one `connect-src` violation, proving the listener is live and the policy is still
  // tight. Loopback is used on purpose: the test must never depend on an external network.
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(
      `${req.method ?? ''} ${req.url ?? ''} authorization=${req.headers['authorization'] === undefined ? 'no' : 'yes'} origin=${req.headers['origin'] ?? ''}`,
    );
    res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Depth, If-Match');
    res.statusCode = 200;
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  try {
    await seedOnboardingDone(page);
    await page.addInitScript(() => {
      const violations: string[] = [];
      (window as WindowWithDiagnostics).__cspViolations = violations;
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push(`${event.violatedDirective} blocked=${event.blockedURI}`);
      });
    });
    await page.goto(APP_URL);
    await expect(page.getByRole('heading', { level: 1, name: 'Today', exact: true })).toBeVisible();

    const outcome = await page.evaluate(
      async (davOrigin) => {
        const statusOf = async (request: Promise<Response>): Promise<number> =>
          request.then(
            (response) => response.status,
            () => -1,
          );
        return {
          control: await statusOf(fetch('./manifest.webmanifest')),
          // Same shape as the sync engine's PROPFIND (src/sync/webdav.ts): non-simple method +
          // Depth + Basic auth headers, so the browser must preflight before it may leave.
          cross: await statusOf(
            fetch(`${davOrigin}/probe`, {
              method: 'PROPFIND',
              headers: {
                Authorization: `Basic ${btoa('alice:secret')}`,
                Depth: '1',
                'Content-Type': 'application/xml',
              },
              body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"/>',
            }),
          ),
          blocked: await statusOf(fetch('http://example.com/')),
        };
      },
      `http://127.0.0.1:${String(port)}`,
    );

    // Control: same-origin still works.
    expect(outcome.control).toBe(200);
    // The cross-origin WebDAV request LEFT the browser: the fake host answered it.
    expect(outcome.cross).toBe(200);
    expect(seen).toContain('PROPFIND /probe authorization=yes origin=' + APP_ORIGIN);
    // Tightness: plain-HTTP egress to a non-loopback host is still refused.
    expect(outcome.blocked).toBe(-1);

    const violations = await page.evaluate(
      () => (window as WindowWithDiagnostics).__cspViolations ?? [],
    );
    // Exactly the one deliberate violation — and it is connect-src, not something else.
    expect(violations).toEqual(['connect-src blocked=http://example.com/']);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

test('first-run onboarding shows once and never again', async ({ page }) => {
  // Each Playwright test gets its own fresh browser context — the CI profile, in other words —
  // so this is a genuine first run, unseeded.
  await page.goto(APP_URL);
  await expect(
    page.getByRole('heading', { name: 'Your data lives in this browser', level: 1, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();

  // The `todo:prefs:v1:onboardingStep` → 'done' marker the CTA wrote is durable, so the very
  // next boot goes straight to the shell. This is also the regression guard for the §3.4
  // wipe-discriminator defect (t_88e35359): a profile with onboarding done and ZERO tasks must
  // classify `normal` — reload before the first task must NOT surface the recovery screen.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Your data lives in this browser', level: 1, exact: true }),
  ).toHaveCount(0);
});

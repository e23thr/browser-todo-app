/**
 * First-install silence — regression for the spurious `update-ready` toast (t_f6f3cb6b).
 *
 * On a single-build origin (byte-identical `sw.js`, no update possible) the "Update available"
 * toast appeared intermittently on FIRST loads, which made `offline.spec.ts`'s Decision 6
 * silence assertion flaky (`[data-update-notice]` count 1 instead of 0).
 *
 * Root cause (ADR-005 Decision 5 rule 3, amended): the `installed` handler classified the
 * install as an update when `navigator.serviceWorker.controller` was non-null at handler time.
 * Under load, webkit delivers the first worker's `statechange: installed` AFTER the page has
 * been claimed by that very worker (captured probe: `state: 'installed'`, `controller:
 * <installing worker>`, `active: null`), so the handler-time controller test is a race and the
 * first install announced a version to update TO. The deterministic reproduction below forces
 * that exact interleaving and asserts the app stays silent. The pure classification contract is
 * unit-tested in `tests/unit/update-flow-runtime.test.ts`.
 */

import { expect, test } from '@playwright/test';

import { FIXTURES, ensureFixtures } from './fixtures/build-fixtures.mjs';
import type { StaticServer } from './fixtures/static-server.mjs';
import { BASE_PATH } from './helpers';
import {
  completeFirstRunOnboarding,
  startFixtureServer,
  updateNotice,
  waitForControlled,
} from './sw-utils';

let server: StaticServer;
let appUrl = '';

test.beforeAll(async () => {
  await ensureFixtures({ basePath: BASE_PATH });
  server = await startFixtureServer(BASE_PATH);
  server.setRoot(FIXTURES.vA);
  appUrl = `${server.origin}${BASE_PATH}`;
});

test.afterAll(async () => {
  await server.close();
});

test('a first install announces nothing, even when claimed before `installed` is delivered', async ({
  page,
}) => {
  await page.addInitScript(() => {
    type AnyListener = EventListenerOrEventListenerObject;
    const marker = window as unknown as { __claimAtInstallExercised?: boolean };
    marker.__claimAtInstallExercised = false;

    // Force the webkit interleaving the loaded runners hit (t_f6f3cb6b): when the installing
    // worker reaches `installed`, the app's `statechange` callback is invoked with the page
    // ALREADY claimed by that worker — `navigator.serviceWorker.controller` is non-null and the
    // worker still reads `state: 'installed'`.
    const container = navigator.serviceWorker;
    const originalRegister = container.register.bind(container);
    const emulatedRegister = (...args: Parameters<typeof originalRegister>) =>
      originalRegister(...args).then((registration) => {
        const registrationAdd = registration.addEventListener.bind(registration);
        const emulatedRegistrationAdd = (
          type: string,
          listener: AnyListener,
          options?: boolean | AddEventListenerOptions,
        ): void => {
          if (type !== 'updatefound' || typeof listener !== 'function') {
            registrationAdd(type, listener, options);
            return;
          }
          registrationAdd('updatefound', (event: Event) => {
            const installing = registration.installing;
            if (installing === null) {
              listener(event);
              return;
            }
            const workerAdd = installing.addEventListener.bind(installing);
            const emulatedWorkerAdd = (
              workerType: string,
              workerListener: AnyListener,
              workerOptions?: boolean | AddEventListenerOptions,
            ): void => {
              if (workerType !== 'statechange' || typeof workerListener !== 'function') {
                workerAdd(workerType, workerListener, workerOptions);
                return;
              }
              workerAdd('statechange', () => {
                if (installing.state !== 'installed') return;
                const seenState = installing.state;
                Object.defineProperty(container, 'controller', {
                  get: () => installing,
                  configurable: true,
                });
                Object.defineProperty(installing, 'state', {
                  get: () => seenState,
                  configurable: true,
                });
                marker.__claimAtInstallExercised = true;
                workerListener(new Event('statechange'));
                delete (installing as unknown as Record<string, unknown>)['state'];
                delete (container as unknown as Record<string, unknown>)['controller'];
              });
            };
            installing.addEventListener = emulatedWorkerAdd as typeof installing.addEventListener;
            listener(event);
          });
        };
        registration.addEventListener =
          emulatedRegistrationAdd as typeof registration.addEventListener;
        return registration;
      });
    container.register = emulatedRegister;
  });

  await page.goto(appUrl);
  await waitForControlled(page);

  // The race window was genuinely exercised: the app's handler ran claimed-but-not-activated.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __claimAtInstallExercised?: boolean })
              .__claimAtInstallExercised === true,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);

  // …and the first install still announced nothing (Decision 5 rule 3, amended).
  await completeFirstRunOnboarding(page);
  await page.waitForTimeout(1500);
  await expect(updateNotice(page)).toHaveCount(0);
});

test('a plain first install never shows the update notice (offline:128 scenario)', async ({
  page,
}) => {
  await page.goto(appUrl);
  await waitForControlled(page);
  await completeFirstRunOnboarding(page);
  await page.waitForTimeout(1500);
  await expect(updateNotice(page)).toHaveCount(0);
});

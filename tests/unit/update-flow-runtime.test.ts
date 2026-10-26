import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkForUpdate,
  initUpdateFlow,
  updateState,
  type UpdateState,
} from '../../src/app/update';

/**
 * ADR-005 Decision 5 rule 3 (amended, t_f6f3cb6b): the RUNTIME driver must announce
 * `installed-waiting` only when a real update is waiting — a new worker installing alongside a
 * DIFFERENT running version. Regression for the spurious "Update available" toast on a
 * single-build origin (broke `tests/e2e/offline.spec.ts` "a failing update check is completely
 * silent"): `clients.claim()` on a first install can give the page a controller BEFORE the
 * `statechange: installed` task is delivered (runner load), and a first install also parks in
 * `registration.waiting` for a moment before it activates.
 */

class FakeWorker extends EventTarget {
  state = 'installing';
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  readonly update = vi.fn(async () => {});
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
}

let container: FakeContainer;
let dispose: (() => void) | null = null;

function installContainer(): FakeContainer {
  container = new FakeContainer();
  Object.defineProperty(navigator, 'serviceWorker', {
    value: container,
    configurable: true,
  });
  return container;
}

/** Drive `updatefound` + the installing worker's `statechange` like a browser would. */
function driveInstall(registration: FakeRegistration, worker: FakeWorker): void {
  registration.installing = worker;
  registration.dispatchEvent(new Event('updatefound'));
  worker.dispatchEvent(new Event('statechange'));
}

beforeEach(() => {
  installContainer();
  updateState.value = 'idle';
});

afterEach(() => {
  dispose?.();
  dispose = null;
});

describe('initUpdateFlow — which installs may announce `update-ready` (Decision 5 rule 3)', () => {
  function toState(): UpdateState {
    return updateState.value;
  }

  it('a first install whose `installed` lands after claim is silent (the spurious-toast race)', () => {
    const worker = new FakeWorker();
    const registration = new FakeRegistration();
    registration.installing = worker;
    dispose = initUpdateFlow({
      registration: registration as unknown as ServiceWorkerRegistration,
      controller: false,
    });

    // The app starts tracking the installing worker on `updatefound`…
    registration.dispatchEvent(new Event('updatefound'));
    // …then the install completes and the page is claimed BEFORE the `statechange` task reaches
    // the app — the exact webkit interleaving captured in the t_f6f3cb6b probe run: the handler
    // sees `state: 'installed'`, `controller: <this very worker>`, `active: null`, and the first
    // install's transient `waiting` slot still set.
    worker.state = 'installed';
    registration.waiting = worker;
    registration.active = null;
    container.controller = worker;
    worker.dispatchEvent(new Event('statechange'));

    expect(toState()).toBe('idle');
  });

  it('a first install whose `installed` lands after activation is silent too', () => {
    const worker = new FakeWorker();
    const registration = new FakeRegistration();
    registration.installing = worker;
    dispose = initUpdateFlow({
      registration: registration as unknown as ServiceWorkerRegistration,
      controller: false,
    });

    registration.dispatchEvent(new Event('updatefound'));
    worker.state = 'installed';
    registration.waiting = null;
    registration.active = worker;
    container.controller = worker;
    worker.dispatchEvent(new Event('statechange'));

    expect(toState()).toBe('idle');
  });

  it('a first install delivered promptly (nothing claimed yet) is silent', () => {
    const worker = new FakeWorker();
    const registration = new FakeRegistration();
    dispose = initUpdateFlow({
      registration: registration as unknown as ServiceWorkerRegistration,
      controller: false,
    });

    // Transient window: the first worker parks in `waiting` before it activates (active is null).
    worker.state = 'installed';
    registration.waiting = worker;
    registration.active = null;
    driveInstall(registration, worker);

    expect(toState()).toBe('idle');
  });

  it('a real update — a new worker alongside a running version — announces the toast', () => {
    const running = new FakeWorker();
    running.state = 'activated';
    const worker = new FakeWorker();
    const registration = new FakeRegistration();
    registration.active = running;
    container.controller = running;
    dispose = initUpdateFlow({
      registration: registration as unknown as ServiceWorkerRegistration,
      controller: true,
    });

    worker.state = 'installed';
    registration.waiting = worker;
    driveInstall(registration, worker);

    expect(toState()).toBe('update-ready');
  });

  it('an update applied elsewhere before delivery announces only `applied-elsewhere`', () => {
    const running = new FakeWorker();
    running.state = 'activated';
    const worker = new FakeWorker();
    const registration = new FakeRegistration();
    registration.active = running;
    container.controller = running;
    dispose = initUpdateFlow({
      registration: registration as unknown as ServiceWorkerRegistration,
      controller: true,
    });

    // The sibling tab applied the update: the new worker is active by the time ours runs.
    worker.state = 'installed';
    registration.waiting = null;
    registration.active = worker;
    driveInstall(registration, worker);
    expect(toState()).toBe('idle');

    container.dispatchEvent(new Event('controllerchange'));
    expect(toState()).toBe('applied-elsewhere');
  });

  it('init adopts a worker waiting behind a RUNNING version (Decision 5 rule 4)', () => {
    const running = new FakeWorker();
    running.state = 'activated';
    const waiting = new FakeWorker();
    waiting.state = 'installed';
    const registration = new FakeRegistration();
    registration.active = running;
    registration.waiting = waiting;

    dispose = initUpdateFlow({
      registration: registration as unknown as ServiceWorkerRegistration,
      controller: true,
    });

    expect(toState()).toBe('update-ready');
  });

  it('init ignores a first install parked in the transient `waiting` slot', () => {
    const waiting = new FakeWorker();
    waiting.state = 'installed';
    const registration = new FakeRegistration();
    registration.active = null;
    registration.waiting = waiting;

    dispose = initUpdateFlow({
      registration: registration as unknown as ServiceWorkerRegistration,
      controller: false,
    });

    expect(toState()).toBe('idle');
  });

  it('a redundant worker is still a silent check failure (Decision 6)', () => {
    const running = new FakeWorker();
    running.state = 'activated';
    const worker = new FakeWorker();
    const registration = new FakeRegistration();
    registration.active = running;
    container.controller = running;
    dispose = initUpdateFlow({
      registration: registration as unknown as ServiceWorkerRegistration,
      controller: true,
    });

    worker.state = 'redundant';
    driveInstall(registration, worker);

    expect(toState()).toBe('check-failed');
  });
});

describe('checkForUpdate — nothing to update until a version runs (t_f6f3cb6b)', () => {
  it('skips the check while the first install is still the only worker', async () => {
    const worker = new FakeWorker();
    const registration = new FakeRegistration();
    registration.installing = worker;
    dispose = initUpdateFlow({
      registration: registration as unknown as ServiceWorkerRegistration,
      controller: false,
    });

    await expect(checkForUpdate({ force: true })).resolves.toBe(false);
    expect(registration.update).not.toHaveBeenCalled();
    expect(updateState.value).toBe('idle');
  });

  it('checks normally once a version is running', async () => {
    const running = new FakeWorker();
    running.state = 'activated';
    const registration = new FakeRegistration();
    registration.active = running;
    dispose = initUpdateFlow({
      registration: registration as unknown as ServiceWorkerRegistration,
      controller: true,
    });

    await expect(checkForUpdate({ force: true })).resolves.toBe(true);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import {
  ANNOUNCE_DELAY_MS,
  announce,
  DEFERRED_ANNOUNCE_DELAY_MS,
  registerLiveRegions,
} from '../../src/app/announce';

function mountRegions(): { polite: HTMLElement; assertive: HTMLElement; dispose: () => void } {
  const polite = document.createElement('div');
  const assertive = document.createElement('div');
  document.body.append(polite, assertive);
  const dispose = registerLiveRegions({ polite, assertive });
  return { polite, assertive, dispose };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  document.body.replaceChildren();
  registerLiveRegions({ polite: null, assertive: null });
});

describe('global announcer (design §11.2)', () => {
  it('delivers a polite message into the polite region', async () => {
    const { polite, dispose } = mountRegions();

    announce('View: Today');
    expect(polite.textContent).toBe(''); // cleared first so repeats are re-announced

    await tick(120);
    expect(polite.textContent).toBe('View: Today');
    dispose();
  });

  it('delivers assertive messages into the assertive region only', async () => {
    const { polite, assertive, dispose } = mountRegions();

    announce("Couldn't save changes. Your input is kept.", 'assertive');
    await tick(120);

    expect(assertive.textContent).toContain("Couldn't save");
    expect(polite.textContent).toBe('');
    dispose();
  });

  it('silently drops announcements made before the shell registers its regions', async () => {
    announce('too early');
    await tick(120);
    expect(document.body.textContent).toBe('');
  });

  it('keeps only the newest message when announcements race', async () => {
    const { polite, dispose } = mountRegions();

    announce('first');
    announce('second');
    await tick(120);

    expect(polite.textContent).toBe('second');
    dispose();
  });

  it('can re-announce an identical message', async () => {
    const { polite, dispose } = mountRegions();

    announce('Task completed');
    await tick(120);
    announce('Task completed');
    await tick(120);

    expect(polite.textContent).toBe('Task completed');
    dispose();
  });

  it('cancels an in-flight announcement when the regions unregister', async () => {
    const { polite, dispose } = mountRegions();

    announce('gone');
    dispose();
    await tick(120);

    expect(polite.textContent).toBe('');
  });

  it('ignores empty messages', async () => {
    const { polite, dispose } = mountRegions();

    announce('');
    await tick(120);

    expect(polite.textContent).toBe('');
    dispose();
  });

  it('lands a deferred message after the window instead of superseding the one in flight', async () => {
    const { polite, dispose } = mountRegions();

    // M13-B1 / E2 F-1: the composer's first capture and E3's first-write notice fire in
    // the same tick — the notice must wait the capture confirmation out, not cancel it.
    announce('Task added: Buy milk');
    announce('This browser did not grant extra protection.', 'polite', { deferred: true });

    // Still inside the hold: the capture message is on screen, untouched.
    await tick(DEFERRED_ANNOUNCE_DELAY_MS - ANNOUNCE_DELAY_MS);
    expect(polite.textContent).toBe('Task added: Buy milk');

    // …and after the hold the notice has landed too — neither message was lost.
    await tick(DEFERRED_ANNOUNCE_DELAY_MS + ANNOUNCE_DELAY_MS);
    expect(polite.textContent).toBe('This browser did not grant extra protection.');
    dispose();
  });

  it('cancels a deferred message when the regions unregister', async () => {
    const { polite, dispose } = mountRegions();

    announce('never spoken', 'polite', { deferred: true });
    dispose();
    await tick(DEFERRED_ANNOUNCE_DELAY_MS + ANNOUNCE_DELAY_MS);

    expect(polite.textContent).toBe('');
  });
});

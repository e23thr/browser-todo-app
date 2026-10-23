import { afterEach, describe, expect, it } from 'vitest';

import { announce, registerLiveRegions } from '../../src/app/announce';

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
});

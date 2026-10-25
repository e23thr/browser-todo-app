/**
 * ADR-008 Decision 3 (unit): the install-prompt state machine.
 *
 * Pins the four promises the card makes: (1) the offer never appears before the first task of
 * the session, (2) dismissal is permanent and survives a reload, (3) each browser gets the
 * tier its platform actually supports — never dead UI (§9.4), and (4) the already-installed
 * app never shows the offer again (post-launch behaviour).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFlags, wasInstallPromptDismissed } from '../../src/features/data-safety/flags';
import {
  bootInstallFlow,
  dismissInstall,
  installSurface,
  installTier,
  isIosPlatform,
  noteTaskCreated,
  promptInstall,
  resetInstallFlow,
} from '../../src/features/install/installPrompt';

interface FakePrompt {
  readonly prompt: ReturnType<typeof vi.fn>;
  readonly event: Event;
}

function fakeBeforeInstallPrompt(
  choice: Promise<{ outcome: 'accepted' | 'dismissed' }>,
): FakePrompt {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(event, { prompt, userChoice: choice });
  return { prompt, event };
}

/** matchMedia double: everything unmatched unless the query is listed as matching. */
function stubMedia(matching: string[]): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matching.some((pattern) => query.includes(pattern)),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
}

function stubNavigator(overrides: Partial<Navigator>): void {
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
    ...overrides,
  });
}

let dispose: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  resetFlags();
  resetInstallFlow();
  stubMedia([]);
  stubNavigator({});
  dispose = bootInstallFlow();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  vi.unstubAllGlobals();
});

describe('install offer timing (acceptance: only after first task creation)', () => {
  it('stays silent before the first task, even when the browser offers install', async () => {
    const { event } = fakeBeforeInstallPrompt(Promise.resolve({ outcome: 'accepted' }));
    globalThis.dispatchEvent(event);

    expect(installSurface.value).toBe('none');
    noteTaskCreated();
    expect(installSurface.value).toBe('prompt');
  });

  it('raises exactly one offer per session once the first task exists', () => {
    expect(installSurface.value).toBe('none');
    const { event } = fakeBeforeInstallPrompt(Promise.resolve({ outcome: 'accepted' }));
    globalThis.dispatchEvent(event);
    noteTaskCreated();
    noteTaskCreated();
    expect(installSurface.value).toBe('prompt');
    expect(installTier()).toBe('prompt');
  });

  it('waits for the browser event when it has not fired yet (no dead Install button)', () => {
    noteTaskCreated();
    expect(installSurface.value).toBe('none');
    expect(installTier()).toBe('unsupported');
  });
});

describe('support tiers (§9.4 graceful degradation)', () => {
  it('shows the manual tier on iOS — there is no beforeinstallprompt there', () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
    });
    expect(isIosPlatform()).toBe(true);
    expect(installTier()).toBe('manual');

    noteTaskCreated();
    expect(installSurface.value).toBe('manual');
  });

  it('treats iPadOS desktop-UA browsers as iOS (MacIntel + touch points)', () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });
    expect(isIosPlatform()).toBe(true);
  });

  it('renders nothing where install is unsupported', () => {
    noteTaskCreated();
    expect(installSurface.value).toBe('none');
  });
});

describe('dismissal (acceptance: remembered across sessions, never nagging)', () => {
  it('remembers "No thanks" across a reload and never asks again', () => {
    const first = fakeBeforeInstallPrompt(Promise.resolve({ outcome: 'accepted' }));
    globalThis.dispatchEvent(first.event);
    noteTaskCreated();
    expect(installSurface.value).toBe('prompt');
    dismissInstall();
    expect(installSurface.value).toBe('none');
    expect(wasInstallPromptDismissed()).toBe(true);

    // New session: fresh machine state, same durable flags.
    resetInstallFlow();
    const { event } = fakeBeforeInstallPrompt(Promise.resolve({ outcome: 'accepted' }));
    globalThis.dispatchEvent(event);
    noteTaskCreated();
    expect(installSurface.value).toBe('none');
  });

  it('counts a declined native install dialog as a dismissal', async () => {
    const { event, prompt } = fakeBeforeInstallPrompt(Promise.resolve({ outcome: 'dismissed' }));
    globalThis.dispatchEvent(event);
    noteTaskCreated();
    expect(installSurface.value).toBe('prompt');

    await promptInstall();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(installSurface.value).toBe('none');
    expect(wasInstallPromptDismissed()).toBe(true);
  });

  it('closes the surface when the native dialog is accepted and waits for appinstalled', async () => {
    const { event } = fakeBeforeInstallPrompt(Promise.resolve({ outcome: 'accepted' }));
    globalThis.dispatchEvent(event);
    noteTaskCreated();

    await promptInstall();
    expect(installSurface.value).toBe('none');
    expect(wasInstallPromptDismissed()).toBe(false);

    globalThis.dispatchEvent(new Event('appinstalled'));
    expect(installSurface.value).toBe('none');
  });

  it('falls back to dismissal when prompt() throws (never a stuck surface)', async () => {
    const prompt = vi.fn().mockRejectedValue(new Error('not allowed'));
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    globalThis.dispatchEvent(event);
    noteTaskCreated();
    expect(installSurface.value).toBe('prompt');

    await promptInstall();
    expect(installSurface.value).toBe('none');
    expect(wasInstallPromptDismissed()).toBe(true);
  });
});

describe('post-install launch (installed home-screen app)', () => {
  it('never offers install in display-mode standalone', () => {
    stubMedia(['display-mode: standalone']);
    noteTaskCreated();
    expect(installSurface.value).toBe('none');
  });

  it('never offers install on iOS standalone (navigator.standalone)', () => {
    stubNavigator({ standalone: true } as Partial<Navigator>);
    noteTaskCreated();
    expect(installSurface.value).toBe('none');
  });

  it('stays silent after install even if the browser keeps firing beforeinstallprompt', () => {
    noteTaskCreated();
    globalThis.dispatchEvent(new Event('appinstalled'));

    // New session in the installed app: display-mode is standalone, and a hostile (late)
    // beforeinstallprompt must still not resurrect the offer.
    resetInstallFlow();
    stubMedia(['display-mode: standalone']);
    dispose?.();
    dispose = bootInstallFlow();
    const { event } = fakeBeforeInstallPrompt(Promise.resolve({ outcome: 'accepted' }));
    globalThis.dispatchEvent(event);
    noteTaskCreated();
    expect(installSurface.value).toBe('none');
  });
});

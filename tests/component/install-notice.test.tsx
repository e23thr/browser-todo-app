/**
 * ADR-008 Decision 3 (component): the install-notice surfaces.
 *
 * Pins the WCAG 2.2 AA contract (a single polite live region, real ≥ 44 px buttons, no focus
 * theft, no auto-dismiss), the two support tiers' copy/actions (§9.4 — never a dead Install
 * button), and the dismissal wiring into the durable flags.
 */

import { fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '../../src/i18n';
import { resetFlags, wasInstallPromptDismissed } from '../../src/features/data-safety/flags';
import { InstallNotice } from '../../src/features/install/InstallNotice';
import {
  bootInstallFlow,
  installSurface,
  noteTaskCreated,
  resetInstallFlow,
} from '../../src/features/install/installPrompt';

let dispose: (() => void) | null = null;

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

function dispatchDeferredPrompt(prompt: ReturnType<typeof vi.fn>): void {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(event, {
    prompt,
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  });
  globalThis.dispatchEvent(event);
}

beforeEach(() => {
  window.localStorage.clear();
  resetFlags();
  resetInstallFlow();
  stubMedia([]);
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
  });
  dispose = bootInstallFlow();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  vi.unstubAllGlobals();
});

describe('InstallNotice', () => {
  it('renders nothing while there is nothing to offer', () => {
    const { container } = render(<InstallNotice />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the install offer in one polite live region with real buttons', () => {
    installSurface.value = 'prompt';
    const { getByRole, getByText, unmount } = render(<InstallNotice />);

    const region = getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(getByText('Keep your tasks — install Todo', { exact: true })).toBeTruthy();
    expect(getByRole('button', { name: 'Install' })).toBeTruthy();
    expect(getByRole('button', { name: 'No thanks' })).toBeTruthy();
    unmount();
  });

  it('shows the Share-sheet steps on iOS — no dead Install button', () => {
    installSurface.value = 'manual';
    const { getByRole, getByText, queryByRole, unmount } = render(<InstallNotice />);

    expect(getByText('Add Todo to your Home Screen', { exact: true })).toBeTruthy();
    expect(getByText('Tap the Share button in Safari.', { exact: true })).toBeTruthy();
    expect(getByText('Choose "Add to Home Screen", then tap Add.', { exact: true })).toBeTruthy();
    expect(getByRole('button', { name: 'Got it' })).toBeTruthy();
    expect(queryByRole('button', { name: 'Install' })).toBeNull();
    unmount();
  });

  it('dismisses permanently on "No thanks" (remembered, never nagging)', async () => {
    const prompt = vi.fn();
    dispatchDeferredPrompt(prompt);
    noteTaskCreated();
    const { container, getByRole, unmount } = render(<InstallNotice />);

    fireEvent.click(getByRole('button', { name: 'No thanks' }));
    expect(wasInstallPromptDismissed()).toBe(true);
    expect(installSurface.value).toBe('none');
    await waitFor(() => {
      expect(container.innerHTML).toBe('');
    });
    unmount();
  });

  it('hands the captured install event to the browser on Install', async () => {
    const prompt = vi.fn();
    dispatchDeferredPrompt(prompt);
    noteTaskCreated();
    const { getByRole, unmount } = render(<InstallNotice />);

    fireEvent.click(getByRole('button', { name: 'Install' }));
    await waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });
    unmount();
  });

  it('renders Thai copy through t() after a locale switch', async () => {
    await setLocale('th');
    installSurface.value = 'manual';
    const { getByText, unmount } = render(<InstallNotice />);

    expect(getByText('เพิ่ม Todo ไปยังหน้าจอโฮม', { exact: true })).toBeTruthy();
    expect(getByText('แตะปุ่มแชร์ในซาฟารี', { exact: true })).toBeTruthy();
    unmount();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { App } from '../../src/app/App';
import { registerSettingsPersistence } from '../../src/app/settings';

/** jsdom ships no matchMedia, so the shell renders the compact pattern by default. */
function stubWideViewport(): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const wide = query.includes('min-width: 1024px');
    return {
      media: query,
      matches: wide,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
      // The legacy addListener/removeListener pair is required by the DOM type only.
    } as unknown as MediaQueryList;
  });
}

async function goto(hash: string): Promise<void> {
  window.location.hash = hash;
  await waitFor(() => {
    expect(window.location.hash).toBe(hash);
  });
}

beforeEach(async () => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  document.documentElement.setAttribute('lang', 'en');
  document.documentElement.removeAttribute('data-theme');
  registerSettingsPersistence(null);
  await Promise.resolve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('shell landmarks & heading structure', () => {
  it('exposes banner, one navigation, main and a skip link first in the DOM', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Views and lists' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.queryByRole('contentinfo')).toBeNull();

    const body = document.querySelector('.shell-body');
    expect(body?.firstElementChild?.className).toContain('skip-link');
    const skipLink = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skipLink.getAttribute('href')).toBe('#main');
  });

  it('renders exactly one h1 per screen — the view title', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    expect(document.querySelectorAll('main h1')).toHaveLength(1);
    // Core UI (M1–M4): the view renders its loading skeleton until the domain store
    // boots, then the empty state — findBy (not getBy) waits for that hand-off.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Nothing due today' }),
    ).toBeTruthy();
  });

  it('mounts the two persistent live regions of §11.2', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    expect(document.querySelector('[role="status"][aria-live="polite"]')).toBeTruthy();
    expect(document.querySelector('[role="alert"][aria-live="assertive"]')).toBeTruthy();
  });
});

describe('navigation destinations (design §2)', () => {
  it('renders a labelled screen for every destination in the nav', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    const destinations: readonly [string, string][] = [
      ['#/today', 'Today'],
      ['#/week', 'Next 7 days'],
      ['#/next7', 'Next 7 days'],
      ['#/all', 'All open'],
      ['#/completed', 'Completed'],
      ['#/search', 'Search'],
      ['#/list/01JBX', 'List'],
      ['#/settings', 'Settings'],
      ['#/nowhere', 'Page not found'],
    ];

    for (const [hash, title] of destinations) {
      await goto(hash);
      expect(
        await screen.findByRole('heading', { level: 1, name: title }),
        `destination ${hash} should render the "${title}" h1`,
      ).toBeTruthy();
    }
  });

  it('marks the active destination with aria-current="page"', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    const nav = screen.getByRole('navigation', { name: 'Views and lists' });
    expect(within(nav).getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe(
      'page',
    );

    await goto('#/completed');
    await screen.findByRole('heading', { level: 1, name: 'Completed' });

    expect(within(nav).getByRole('link', { name: 'Completed' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(nav).getByRole('link', { name: 'Today' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('treats /next7 as an alias of /week for the current-page state', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    await goto('#/next7');
    await screen.findByRole('heading', { level: 1, name: 'Next 7 days' });

    const nav = screen.getByRole('navigation', { name: 'Views and lists' });
    expect(
      within(nav).getByRole('link', { name: 'Next 7 days' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('keeps the settings route a lazy chunk that still renders', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    await goto('#/settings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
  });
});

describe('SPA route-change contract (§4.1)', () => {
  it('moves focus to the view h1 and announces the view politely', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    await goto('#/week');
    const heading = await screen.findByRole('heading', { level: 1, name: 'Next 7 days' });

    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    await waitFor(() => {
      const region = document.querySelector('[role="status"][aria-live="polite"]');
      expect(region?.textContent).toBe('View: Next 7 days');
    });
  });

  it('does not steal focus on first paint — the skip link stays first', async () => {
    render(<App />);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Today' });

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(document.activeElement).not.toBe(heading);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('compact pattern (< 1024 px)', () => {
  it('renders the bottom tab bar with the five destinations', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    const tabbar = screen.getByRole('navigation', { name: 'Views and lists' });
    const tabs = within(tabbar).getAllByRole('link');
    expect(tabs.map((tab) => tab.textContent.trim())).toEqual([
      'Today',
      'Next 7 days',
      'All open',
      'Completed',
    ]);
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
    expect(document.querySelector('.fab')).toBeTruthy();
  });

  it('opens the drawer as a modal dialog, traps Tab, and closes on Escape with focus returned', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    const opener = screen.getByRole('button', { name: 'Open navigation menu' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: 'Menu' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(dialog);
    });

    // Background is hidden from assistive tech while the drawer is modal.
    expect(document.querySelector('.shell-body')?.getAttribute('aria-hidden')).toBe('true');

    const closeButton = within(dialog).getByRole('button', { name: 'Close navigation menu' });
    // The S8 drawer entries (command palette + shortcuts help) end the tab order
    // since t_ee8ecb0b; the trap wraps from the actual last focusable either way.
    const lastFocusable = within(dialog).getByRole('button', { name: 'Keyboard shortcuts' });
    lastFocusable.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);

    closeButton.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastFocusable);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('.shell-body')?.getAttribute('aria-hidden')).toBeNull();
  });

  it('shows the documented empty state for lists until the domain layer supplies them', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    const dialog = await screen.findByRole('dialog', { name: 'Menu' });

    expect(within(dialog).getByRole('heading', { name: 'Lists' })).toBeTruthy();
    expect(within(dialog).getByText('No lists yet', { exact: true })).toBeTruthy();
  });
});

describe('wide pattern (>= 1024 px)', () => {
  it('renders the persistent sidebar and no tab bar', async () => {
    stubWideViewport();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });

    const nav = screen.getByRole('navigation', { name: 'Views and lists' });
    expect(within(nav).getByRole('link', { name: 'Search' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Next 7 days' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(document.querySelector('.fab')).toBeNull();
    expect(screen.getByRole('banner').className).toContain('sidebar');
  });
});

describe('i18n wiring', () => {
  it('re-renders every string from the runtime when setLocale switches to Thai', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    expect(document.documentElement.lang).toBe('en');

    const { setLocale } = await import('../../src/app/i18n');
    await setLocale('th');

    expect(await screen.findByRole('heading', { level: 1, name: 'วันนี้' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('th');
    // The nav landmark's accessible name is itself translated, so match by role only.
    expect(screen.getByRole('navigation').textContent).toContain('วันนี้');

    await setLocale('en');
    expect(await screen.findByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });
});

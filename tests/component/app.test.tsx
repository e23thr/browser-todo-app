import { beforeEach, describe, expect, it } from 'vitest';

import { render, screen } from '@testing-library/preact';

import { App } from '../../src/app/App';

beforeEach(() => {
  // Reset the hash without firing a navigation, so every test starts on the default route.
  window.history.replaceState(null, '', '/');
});

describe('app shell', () => {
  it('renders the landmark structure and the Today view', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Today' })).toBeTruthy();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Skip to main content' }).getAttribute('href')).toBe(
      '#main',
    );
  });

  it('marks the current nav link with aria-current', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 2, name: 'Today' });

    expect(screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBeNull();
  });

  it('lazy-loads the settings route as a separate chunk', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 2, name: 'Today' });

    window.location.hash = '#/settings';

    expect(await screen.findByRole('heading', { level: 2, name: 'Settings' })).toBeTruthy();
  });

  it('renders the not-found view for an unknown hash', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 2, name: 'Today' });

    window.location.hash = '#/nowhere';

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});

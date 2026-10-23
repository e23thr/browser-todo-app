import { afterEach, beforeEach } from 'vitest';

import { cleanup } from '@testing-library/preact';

import { setLocale } from '../src/i18n';

/**
 * @testing-library/preact only auto-cleans when Vitest globals are enabled; this project keeps
 * `globals: false` so every test imports what it uses, so cleanup is wired explicitly here.
 */
afterEach(() => {
  cleanup();
});

/**
 * Locale packs are lazy (§9.2), so without priming, `t()` in a freshly rendered component
 * would resolve to raw keys. Prime the boot catalog before every test and hand each test a
 * deterministic locale, even after a test switched to `th`.
 */
beforeEach(async () => {
  await setLocale('en');
});

import { afterEach } from 'vitest';

import { cleanup } from '@testing-library/preact';

/**
 * @testing-library/preact only auto-cleans when Vitest globals are enabled; this project keeps
 * `globals: false` so every test imports what it uses, so cleanup is wired explicitly here.
 */
afterEach(() => {
  cleanup();
});

import { render } from 'preact';

import { App } from './App';
import { registerSettingsPersistence } from './settings';
import { createIdbSettingsPersistence } from './settingsPersistence';
import { bootServiceWorker } from './sw-boot';
import { initLocale, registerLocalePersistence } from '../i18n';
import { createSettingsLocalePersistence } from '../i18n/settingsPersistence';
import '../styles/global.css';

// Durable settings live in the ADR-002 `settings` record (IndexedDB); register the adapter
// before mount so the first `loadSettings()` — an effect of App — reads it. The theme mirror
// in localStorage is what the inline boot snippet painted from.
registerSettingsPersistence(createIdbSettingsPersistence());
// Locale is durable in the same record (ADR-002 `settings.locale`), never in localStorage
// (Decision 7's closed key list has no locale key).
registerLocalePersistence(createSettingsLocalePersistence());

const container = document.getElementById('app');
if (container === null) {
  throw new Error('Missing #app mount point in index.html');
}

/**
 * Boot order: locale first, then mount. `initLocale` lazy-loads the pack and sets
 * `document.documentElement.lang` (§8), and is bounded so a slow or missing pack can never
 * block paint — if it times out the UI mounts with key fallbacks and the strings self-heal
 * when the pack lands.
 */
async function start(root: HTMLElement): Promise<void> {
  await initLocale({ timeoutMs: 2000 });
  render(<App />, root);
  // Service-worker registration + update flow (ADR-005) — after first render so the shell is
  // interactive before any SW work; also records the `app:interactive` mark (§9.1 budget).
  bootServiceWorker();
}

void start(container);

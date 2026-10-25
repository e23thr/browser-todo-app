import { render } from 'preact';

import { App } from './App';
import { wireDataReplacedRefresh } from './dataReplace';
import { registerSettingsPersistence } from './settings';
import { createIdbSettingsPersistence } from './settingsPersistence';
import { bootServiceWorker } from './sw-boot';
import { initLocale, registerLocalePersistence } from '../i18n';
import { installDocumentMeta } from '../i18n/documentMeta';
import { createSettingsLocalePersistence } from '../i18n/settingsPersistence';
import { beginPriorUseProbe } from '../features/data-safety/probe';
import { initFirstRunFlag } from '../features/data-safety/state';
import { mountInstallNotice } from '../features/install/InstallNotice';
import { bootInstallFlow } from '../features/install/installPrompt';
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
 *
 * The prior-use probe starts FIRST (before anything can call `boot()`) and is awaited before
 * render: the eviction/long-absence classifier needs `meta.lastOpenedAt` as it was BEFORE
 * boot's step 5 stamps the current time (§3.4). It is bounded at 1.5 s, so a broken IndexedDB
 * degrades the classification instead of blocking paint.
 */
async function start(root: HTMLElement): Promise<void> {
  const probe = beginPriorUseProbe();
  await initLocale({ timeoutMs: 2000 });
  // QA D1: the tab title and meta description are catalog strings too. Applied after
  // initLocale (active locale known), then kept in step by the catalog signal — a pack
  // that lands after the bounded-boot timeout self-heals them, as does every switch.
  installDocumentMeta();
  await probe;
  // First-run screen (§6.1): the durable marker decides BEFORE the first paint.
  initFirstRunFlag();
  // Post-import/post-restore UI refresh (finding F1, fix card t_85e19c39): the
  // engine announces a wholesale data replacement; the shell re-reads the store
  // and settings so the restored data is visible WITHOUT a page reload.
  wireDataReplacedRefresh();
  render(<App />, root);
  // PWA install flow (ADR-008 Decision 3, S13): capture `beforeinstallprompt` from the first
  // moment it can fire (the offer itself only becomes eligible at the first task creation) and
  // mount its non-modal surface into its own body-level container.
  bootInstallFlow();
  mountInstallNotice();
  // Service-worker registration + update flow (ADR-005) — after first render so the shell is
  // interactive before any SW work; also records the `app:interactive` mark (§9.1 budget).
  bootServiceWorker();
  // Data-safety engine (ADR-004 wiring + boot classification): lazy chunk, right after paint.
  void import('../features/data-safety/boot')
    .then((module) => module.startDataSafety())
    .catch((error: unknown) => {
      console.warn('data-safety: boot failed', error);
    });
}

void start(container);

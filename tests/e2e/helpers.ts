/**
 * Single source of truth for the preview server address used by the E2E suite.
 *
 * The suite deliberately runs against a NON-ROOT base path (`/<repo>/`) because that is what
 * GitHub Pages project pages serve (§9.5) — it is the only way the base-path wiring stays tested.
 */
export const PREVIEW_PORT = 4173;

export const BASE_PATH = process.env['BASE_PATH'] ?? '/browser-todo-app/';

export const APP_ORIGIN = `http://127.0.0.1:${String(PREVIEW_PORT)}`;

/** Absolute URL of the app under the configured base path. */
export const APP_URL = `${APP_ORIGIN}${BASE_PATH}`;

/** Routes exercised by the smoke and a11y suites. */
export const CORE_ROUTES = ['', '#/settings'] as const;

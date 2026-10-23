import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale, t } from '../../src/i18n';
import { installDocumentMeta } from '../../src/i18n/documentMeta';
import en from '../../src/i18n/en.json';
import th from '../../src/i18n/th.json';

/**
 * QA defect D1 (docs/qa/e5-i18n.md): the tab `<title>` and the meta description must come
 * from the catalogs (`app.documentTitle` / `app.metaDescription`) — applied once after
 * `initLocale()` (boot) and again on every locale switch. The static English strings in
 * `index.html` are the pre-boot paint fallback only: before the first pack lands the module
 * must leave them alone (never flash a raw key into the tab) and self-heal the moment the
 * pack arrives, exactly like the rest of the UI (main.tsx bounded-boot contract).
 *
 * `tests/setup.ts` primes the `en` catalog before every test, so the self-healing case runs
 * against a freshly reset module registry (a real un-primed boot).
 */

const STATIC_TITLE = 'Todo — local-first';
const STATIC_DESCRIPTION =
  'A local-first, privacy-preserving todo app that runs entirely in your browser.';

let dispose: (() => void) | null = null;

function seedStaticHead(): void {
  // What index.html ships before the module boots (English pre-paint fallback).
  document.head.insertAdjacentHTML(
    'beforeend',
    `<meta name="description" content="${STATIC_DESCRIPTION}"><title>${STATIC_TITLE}</title>`,
  );
}

function metaDescription(): string | null {
  return document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  seedStaticHead();
});

afterEach(() => {
  if (dispose !== null) {
    dispose();
    dispose = null;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('installDocumentMeta — boot (after initLocale)', () => {
  it('applies the English title and description from the catalogs', () => {
    dispose = installDocumentMeta();

    expect(document.title).toBe(en['app.documentTitle']);
    expect(document.title).toBe('Todo — local-first'); // same text index.html shipped
    expect(metaDescription()).toBe(en['app.metaDescription']);
    expect(metaDescription()).toBe(STATIC_DESCRIPTION);
  });
});

describe('installDocumentMeta — locale switch', () => {
  it('moves title and description to Thai and back to English', async () => {
    dispose = installDocumentMeta();

    await setLocale('th');
    expect(document.title).toBe(th['app.documentTitle']);
    expect(metaDescription()).toBe(th['app.metaDescription']);
    expect(document.title).toBe(t('app.documentTitle'));

    await setLocale('en');
    expect(document.title).toBe(en['app.documentTitle']);
    expect(metaDescription()).toBe(en['app.metaDescription']);
  });

  it('keeps updating after a disposed installation is replaced (dispose stops updates)', async () => {
    dispose = installDocumentMeta();
    dispose(); // effect unsubscribed
    dispose = null;

    await setLocale('th');
    expect(document.title).toBe(STATIC_TITLE); // frozen at the static English fallback
  });

  it('updates the title even when the description element is missing (no throw)', async () => {
    document.querySelector('meta[name="description"]')?.remove();
    dispose = installDocumentMeta();

    await expect(setLocale('th')).resolves.toBeUndefined();
    expect(document.title).toBe(th['app.documentTitle']);
    expect(metaDescription()).toBeNull();
  });
});

describe('installDocumentMeta — self-heal when the pack lands late (bounded boot)', () => {
  it('keeps the static English before any pack, then heals to Thai when the pack lands', async () => {
    vi.resetModules();
    const freshI18n = await import('../../src/i18n');
    const freshMeta = await import('../../src/i18n/documentMeta');
    const warn = vi.spyOn(console, 'warn');
    dispose = freshMeta.installDocumentMeta();

    // No pack has landed: t() falls back to the raw key — the static English must survive.
    expect(document.title).toBe(STATIC_TITLE);
    expect(metaDescription()).toBe(STATIC_DESCRIPTION);

    await freshI18n.setLocale('th');
    expect(document.title).toBe(th['app.documentTitle']);
    expect(metaDescription()).toBe(th['app.metaDescription']);

    // Only the expected pre-pack fallback warnings (once per key, deduped) — nothing else.
    const messages = warn.mock.calls.map((call) => String(call[0] ?? ''));
    expect(messages.filter((m) => m.includes('missing key')).length).toBeLessThanOrEqual(2);
  });
});

/**
 * ADR-008 Decision 1 (unit): web app manifest generation.
 *
 * The manifest is generated at build time precisely so `start_url`/`scope`/icon URLs can carry
 * the configured base path — and the binding invariant is that they AGREE with the ADR-005
 * Decision 8 service-worker scope (`${BASE_URL}`, slash-terminated). These tests pin that
 * agreement for the root base and the GitHub Pages project-page base.
 */

import { describe, expect, it } from 'vitest';

import { buildWebManifest, normalizeBase, renderWebManifest } from '../../scripts/webmanifest.mjs';

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: string;
}

interface ManifestShape {
  readonly id: string;
  readonly name: string;
  readonly short_name: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly icons: readonly ManifestIcon[];
}

function manifestFor(base: string): ManifestShape {
  return buildWebManifest(base) as unknown as ManifestShape;
}

describe('normalizeBase (must match vite.config.ts exactly)', () => {
  it('defaults to root and keeps slash-terminated forms', () => {
    expect(normalizeBase(undefined)).toBe('/');
    expect(normalizeBase('')).toBe('/');
    expect(normalizeBase('/')).toBe('/');
    expect(normalizeBase('./')).toBe('./');
    expect(normalizeBase('/browser-todo-app/')).toBe('/browser-todo-app/');
    expect(normalizeBase('/browser-todo-app')).toBe('/browser-todo-app/');
    expect(normalizeBase('browser-todo-app')).toBe('/browser-todo-app/');
    expect(normalizeBase(' /browser-todo-app/ ')).toBe('/browser-todo-app/');
  });
});

describe('manifest shape', () => {
  it.each(['/', '/browser-todo-app/', '/deep/project-page/'])(
    'keeps id, start_url and scope equal to the base %s',
    (base) => {
      const manifest = manifestFor(base);
      expect(manifest.id).toBe(base);
      expect(manifest.start_url).toBe(base);
      expect(manifest.scope).toBe(base);
    },
  );

  it('pins the install identity to the scope so two bases never collide', () => {
    expect(manifestFor('/browser-todo-app/').id).toBe('/browser-todo-app/');
    expect(manifestFor('/').id).toBe('/');
  });

  it('declares standalone display with the app name and short name', () => {
    const manifest = manifestFor('/browser-todo-app/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.name).toBe('Todo — local-first');
    expect(manifest.short_name).toBe('Todo');
  });

  it('lists self-hosted any + maskable icons at the 192/512 installability sizes', () => {
    const manifest = manifestFor('/browser-todo-app/');
    const purposes = manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`).sort();
    expect(purposes).toEqual([
      '192x192 any',
      '192x192 maskable',
      '512x512 any',
      '512x512 maskable',
    ]);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      expect(icon.src.startsWith('/browser-todo-app/icons/')).toBe(true);
      // Zero third-party bytes (§7.2 / binding decision): never an absolute URL.
      expect(icon.src).not.toMatch(/^https?:/u);
    }
  });

  it('prefixes every URL with the base, including the root case', () => {
    const root = manifestFor('/');
    for (const icon of root.icons) expect(icon.src.startsWith('/icons/')).toBe(true);
    expect(root.start_url).toBe('/');
    expect(root.scope).toBe('/');
  });

  it('renders as parseable JSON with a trailing newline', () => {
    const text = renderWebManifest('/browser-todo-app/');
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text) as ManifestShape;
    expect(parsed.scope).toBe('/browser-todo-app/');
  });

  it('is deterministic (byte-stable across builds — no churn)', () => {
    expect(renderWebManifest('/browser-todo-app/')).toBe(renderWebManifest('/browser-todo-app/'));
  });
});

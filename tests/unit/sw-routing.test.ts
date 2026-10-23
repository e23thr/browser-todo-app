import { describe, expect, it } from 'vitest';

import {
  baseSlugFromScope,
  cacheKeyFor,
  isShellCacheNameForSlug,
  routeRequest,
  shellCacheName,
} from '../../src/sw/routing';

/**
 * ADR-005 Decision 9 (unit): the routing decision table (Decision 4) is pure and fully covered
 * here — every row of the table, plus the cache-name rules from Decisions 3 and 8.
 */

const REPO_SCOPE = 'https://example.test/browser-todo-app/';

describe('routeRequest — in-scope GET navigations (ADR-005 Decision 4)', () => {
  it('serves the shell URL cache-first', () => {
    expect(
      routeRequest({
        url: `${REPO_SCOPE}index.html`,
        method: 'GET',
        scope: REPO_SCOPE,
        mode: 'navigate',
      }),
    ).toEqual({
      kind: 'shell-document',
      cacheUrl: 'https://example.test/browser-todo-app/index.html',
      reason: 'shell',
    });
  });

  it('treats a bare scope navigation as the shell document', () => {
    expect(
      routeRequest({ url: REPO_SCOPE, method: 'GET', scope: REPO_SCOPE, mode: 'navigate' }),
    ).toEqual({
      kind: 'shell-document',
      cacheUrl: 'https://example.test/browser-todo-app/index.html',
      reason: 'shell',
    });
  });

  it('falls back to the cached shell for any other in-scope navigation (hash-router deep link)', () => {
    expect(
      routeRequest({
        url: `${REPO_SCOPE}somewhere/deep`,
        method: 'GET',
        scope: REPO_SCOPE,
        destination: 'document',
      }),
    ).toEqual({
      kind: 'shell-document',
      cacheUrl: 'https://example.test/browser-todo-app/index.html',
      reason: 'navigation-fallback',
    });
  });

  it('ignores search strings when deciding the shell document', () => {
    expect(
      routeRequest({
        url: `${REPO_SCOPE}index.html?ref=1`,
        method: 'GET',
        scope: REPO_SCOPE,
        mode: 'navigate',
      }),
    ).toEqual({
      kind: 'shell-document',
      cacheUrl: 'https://example.test/browser-todo-app/index.html',
      reason: 'shell',
    });
  });
});

describe('routeRequest — in-scope GET assets (ADR-005 Decision 4)', () => {
  it('routes hashed assets cache-first with a query-stripped cache key', () => {
    expect(
      routeRequest({
        url: `${REPO_SCOPE}assets/index-abc123.js`,
        method: 'GET',
        scope: REPO_SCOPE,
        destination: 'script',
      }),
    ).toEqual({
      kind: 'asset',
      cacheUrl: 'https://example.test/browser-todo-app/assets/index-abc123.js',
    });
    expect(
      routeRequest({
        url: `${REPO_SCOPE}assets/index-abc123.js?v=2`,
        method: 'GET',
        scope: REPO_SCOPE,
        destination: 'script',
      }),
    ).toEqual({
      kind: 'asset',
      cacheUrl: 'https://example.test/browser-todo-app/assets/index-abc123.js',
    });
  });

  it('routes icons and locale chunks as assets', () => {
    for (const path of ['favicon.svg', 'assets/locale-th-xyz.js', 'assets/style-123.css']) {
      expect(
        routeRequest({ url: `${REPO_SCOPE}${path}`, method: 'GET', scope: REPO_SCOPE }).kind,
      ).toBe('asset');
    }
  });
});

describe('routeRequest — passthrough rules (ADR-005 Decision 4)', () => {
  it('passes non-GET requests through to the network', () => {
    expect(
      routeRequest({ url: `${REPO_SCOPE}assets/a.js`, method: 'POST', scope: REPO_SCOPE }),
    ).toEqual({ kind: 'passthrough', reason: 'method' });
    expect(
      routeRequest({ url: `${REPO_SCOPE}assets/a.js`, method: 'HEAD', scope: REPO_SCOPE }),
    ).toEqual({ kind: 'passthrough', reason: 'method' });
  });

  it('passes cross-origin and out-of-scope requests through (§7.2: nothing external is cached)', () => {
    expect(
      routeRequest({ url: 'https://other.test/asset.js', method: 'GET', scope: REPO_SCOPE }),
    ).toEqual({ kind: 'passthrough', reason: 'scope' });
    expect(
      routeRequest({
        url: 'https://example.test/other-repo/asset.js',
        method: 'GET',
        scope: REPO_SCOPE,
      }),
    ).toEqual({ kind: 'passthrough', reason: 'scope' });
  });

  it('never intercepts the worker script itself (browser-managed update fetch)', () => {
    expect(routeRequest({ url: `${REPO_SCOPE}sw.js`, method: 'GET', scope: REPO_SCOPE })).toEqual({
      kind: 'passthrough',
      reason: 'worker-script',
    });
  });

  it('does not treat a sibling path with a shared prefix as in scope', () => {
    expect(
      routeRequest({
        url: 'https://example.test/browser-todo-app-extra/asset.js',
        method: 'GET',
        scope: REPO_SCOPE,
      }),
    ).toEqual({ kind: 'passthrough', reason: 'scope' });
  });
});

describe('cache naming (ADR-005 Decisions 3 and 8)', () => {
  it('namespaces cache names by the base-path slug', () => {
    expect(baseSlugFromScope('https://example.test/')).toBe('root');
    expect(baseSlugFromScope('https://example.test/browser-todo-app/')).toBe('browser-todo-app');
    expect(baseSlugFromScope('https://example.test/team/project/')).toBe('team-project');
    expect(baseSlugFromScope('https://example.test/my repo%20name/')).toBe('my-repo-name');
    expect(shellCacheName('browser-todo-app', 'a1b2c3')).toBe(
      'todo-shell:browser-todo-app:v:a1b2c3',
    );
  });

  it("recognises only THIS app's caches as purgeable (activate purge scoping)", () => {
    expect(isShellCacheNameForSlug('todo-shell:root:v:1', 'root')).toBe(true);
    expect(isShellCacheNameForSlug('todo-shell:browser-todo-app:v:2', 'browser-todo-app')).toBe(
      true,
    );
    expect(
      isShellCacheNameForSlug('workbox-precache-v2-https://example.test/', 'browser-todo-app'),
    ).toBe(false);
    expect(isShellCacheNameForSlug('other-cache', 'browser-todo-app')).toBe(false);
  });

  it("never matches a sibling app's cache on the shared origin (QA defect D1 regression)", () => {
    // The exact names from the D1 evidence (QA card t_be7f0810) — the sibling must survive.
    expect(
      isShellCacheNameForSlug('todo-shell:other-app:v:1111111111111111', 'browser-todo-app'),
    ).toBe(false);
    expect(
      isShellCacheNameForSlug('todo-shell:browser-todo-app:v:a421e35055099eb7', 'browser-todo-app'),
    ).toBe(true);
    // A slug that merely shares the string prefix is a different app and must not match.
    expect(
      isShellCacheNameForSlug(
        'todo-shell:browser-todo-app-extra:v:0000000000000000',
        'browser-todo-app',
      ),
    ).toBe(false);
    // A root-hosted sibling on the same origin is not this app either.
    expect(isShellCacheNameForSlug('todo-shell:root:v:1', 'browser-todo-app')).toBe(false);
  });

  it('requires the `todo-shell:<slug>:v:<version>` shape (no empty version segment)', () => {
    expect(isShellCacheNameForSlug('todo-shell:browser-todo-app:v:', 'browser-todo-app')).toBe(
      false,
    );
    expect(isShellCacheNameForSlug('todo-shell:browser-todo-app:', 'browser-todo-app')).toBe(false);
    expect(isShellCacheNameForSlug('todo-shell:browser-todo-app', 'browser-todo-app')).toBe(false);
    // The current cache name itself still matches — the purge subtracts it (`name !== shellCache`).
    expect(
      isShellCacheNameForSlug(
        shellCacheName('browser-todo-app', 'a421e35055099eb7'),
        'browser-todo-app',
      ),
    ).toBe(true);
  });

  it('normalises cache keys to origin + pathname', () => {
    expect(cacheKeyFor('https://example.test/repo/a.js?x=1#y')).toBe(
      'https://example.test/repo/a.js',
    );
  });
});

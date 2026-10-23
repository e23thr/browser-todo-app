/**
 * Pure request-routing decision table for the service worker (ADR-005 Decision 4).
 *
 * No service-worker globals are touched here: every input is passed in, which is what makes the
 * decision table unit-testable without a SW runtime (ADR-005 Decision 9, unit tests).
 *
 * Decision 4 table (normative):
 * - in-scope GET navigation to the shell document      -> cache-first of `index.html`
 * - any other in-scope GET navigation                  -> navigation fallback to cached `index.html`
 * - in-scope GET static assets (hashed JS/CSS/icons)   -> cache-first, write-through on miss
 * - `sw.js`                                            -> passthrough (browser-managed update fetch)
 * - everything else (non-GET, out of scope, cross-origin) -> passthrough network
 */

/** Prefix of every cache this app owns. Purged on activate except the current version. */
export const SHELL_CACHE_PREFIX = 'todo-shell:';

/** File name of the service worker inside its scope (ADR-005 Decision 8: never move it). */
export const SW_SCRIPT_NAME = 'sw.js';

export interface RouteRequestInput {
  /** Absolute URL of the request (`request.url`). */
  readonly url: string;
  /** HTTP method (`request.method`). */
  readonly method: string;
  /** The registration scope, always slash-terminated (e.g. `https://host/repo-name/`). */
  readonly scope: string;
  /** `request.mode` when available (`'navigate'` for document loads). */
  readonly mode?: string | undefined;
  /** `request.destination` when available (`'document'` for document loads). */
  readonly destination?: string | undefined;
}

export type RouteDecision =
  | {
      readonly kind: 'shell-document';
      /** Cache key to serve: always the scope's `index.html`. */
      readonly cacheUrl: string;
      /** `shell` = the shell URL itself; `navigation-fallback` = any other in-scope document. */
      readonly reason: 'shell' | 'navigation-fallback';
    }
  | {
      readonly kind: 'asset';
      /** Cache key for the asset: origin + pathname (search never participates in cache keys). */
      readonly cacheUrl: string;
    }
  | {
      readonly kind: 'passthrough';
      readonly reason: 'method' | 'scope' | 'worker-script';
    };

/** Cache keys are origin + pathname: content-hashed assets never carry meaningful queries. */
export function cacheKeyFor(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function withTrailingSlash(pathname: string): string {
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

/**
 * Derive the cache-name slug from a registration scope (ADR-005 Decision 3/8).
 *
 * CacheStorage is per-origin and `*.github.io` hosts several project pages on one origin, so
 * every cache name is namespaced by the base path: `/` -> `root`, `/repo-name/` -> `repo-name`.
 */
export function baseSlugFromScope(scope: string): string {
  let pathname = withTrailingSlash(new URL(scope).pathname);
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // A malformed escape sequence keeps the raw pathname; the sanitizer below handles the rest.
  }
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return 'root';
  const slug = segments
    .join('-')
    .replaceAll(/[^A-Za-z0-9._-]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
  return slug === '' ? 'root' : slug;
}

/** `todo-shell:<baseSlug>:v:<shellVersion>` — one cache per build (ADR-005 Decision 3). */
export function shellCacheName(baseSlug: string, shellVersion: string): string {
  return `${SHELL_CACHE_PREFIX}${baseSlug}:v:${shellVersion}`;
}

/**
 * True when a CacheStorage name is a shell cache of THIS app — `todo-shell:<baseSlug>:v:<version>`
 * (ADR-005 Decision 3). Purgeable on activate (minus the current version).
 *
 * The match is exact on the slug: slugs never contain `:` (see `baseSlugFromScope`), so a sibling
 * project page's cache on the shared origin (`todo-shell:other-app:v:…`) — or a slug that merely
 * shares a prefix (`todo-shell:<slug>-extra:v:…`) — never matches and is never purged.
 */
export function isShellCacheNameForSlug(name: string, baseSlug: string): boolean {
  const prefix = `${SHELL_CACHE_PREFIX}${baseSlug}:v:`;
  return name.startsWith(prefix) && name.length > prefix.length;
}

/**
 * Decide how a request must be served (the pure half of the SW fetch handler).
 *
 * @returns the strategy for this request; `passthrough` means "do not call respondWith".
 */
export function routeRequest(input: RouteRequestInput): RouteDecision {
  const scopeUrl = new URL(input.scope);
  const requestUrl = new URL(input.url);
  const scopePath = withTrailingSlash(scopeUrl.pathname);

  if (input.method.toUpperCase() !== 'GET') {
    return { kind: 'passthrough', reason: 'method' };
  }
  if (requestUrl.origin !== scopeUrl.origin) {
    return { kind: 'passthrough', reason: 'scope' };
  }
  if (!requestUrl.pathname.startsWith(scopePath)) {
    return { kind: 'passthrough', reason: 'scope' };
  }
  if (requestUrl.pathname === `${scopePath}${SW_SCRIPT_NAME}`) {
    return { kind: 'passthrough', reason: 'worker-script' };
  }

  const isNavigation = input.mode === 'navigate' || input.destination === 'document';
  if (isNavigation) {
    const shellUrl = `${scopeUrl.origin}${scopePath}index.html`;
    const key = cacheKeyFor(input.url);
    const isShellDocument = key === shellUrl || requestUrl.pathname === scopePath;
    return {
      kind: 'shell-document',
      cacheUrl: shellUrl,
      reason: isShellDocument ? 'shell' : 'navigation-fallback',
    };
  }

  return { kind: 'asset', cacheUrl: cacheKeyFor(input.url) };
}

/**
 * In-house hash router (ADR-001 §2) — no router dependency.
 *
 * GitHub Pages serves static files with no rewrite rules, so deep links like `/repo/settings`
 * would 404 while `/#/settings` always resolves. Hash routing is therefore independent of the
 * configurable asset base path (`BASE_PATH`).
 *
 * Pure and framework-free: every browser touch point is injectable, which is what makes this
 * unit-testable without a DOM.
 */

/** A resolved route: the pattern that matched, the normalised path, and its `:params`. */
export interface RouteMatch {
  readonly path: string;
  readonly pattern: string;
  readonly params: Readonly<Record<string, string>>;
}

/** Called with the best match for the current hash, or `null` when no pattern matches. */
export type RouteListener = (match: RouteMatch | null) => void;

/** Injectable browser seams. Defaults target `window.location` + the `hashchange` event. */
export interface RouterOptions {
  readonly getHash: () => string;
  readonly setHash: (hash: string, replace: boolean) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface NavigateOptions {
  readonly replace?: boolean;
}

export interface Router {
  readonly start: () => void;
  readonly navigate: (path: string, options?: NavigateOptions) => void;
  readonly dispose: () => void;
}

/** Collapse duplicate slashes, guarantee a leading slash, drop a trailing slash (except root). */
export function normalizePath(path: string): string {
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/gu, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.slice(0, -1);
  return collapsed;
}

/**
 * Convert a location hash into a routable path.
 *
 * Returns `''` for in-page anchors (`#main` skip link) so the router leaves the current view
 * alone instead of treating them as unknown routes.
 */
export function hashToPath(hash: string): string {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  if (withoutHash === '') return '/';
  if (!withoutHash.startsWith('/')) return '';
  const pathOnly = withoutHash.split('?')[0] ?? '';
  return normalizePath(pathOnly);
}

/**
 * Match a pattern such as `/list/:id` against a normalised path.
 *
 * @returns the captured params, or `null` when the pattern does not match.
 */
export function matchPath(pattern: string, path: string): Readonly<Record<string, string>> | null {
  const normalizedPattern = normalizePath(pattern);
  const normalizedPath = normalizePath(path);
  const patternSegments = normalizedPattern === '/' ? [] : normalizedPattern.slice(1).split('/');
  const pathSegments = normalizedPath === '/' ? [] : normalizedPath.slice(1).split('/');

  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (const [index, segment] of patternSegments.entries()) {
    const actual = pathSegments[index];
    if (actual === undefined) return null;
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (segment !== actual) return null;
  }
  return params;
}

function browserRouterOptions(): RouterOptions {
  return {
    getHash: () => window.location.hash,
    setHash: (hash, replace) => {
      if (replace) {
        window.location.replace(hash);
      } else {
        window.location.hash = hash;
      }
    },
    subscribe: (listener) => {
      window.addEventListener('hashchange', listener);
      return () => {
        window.removeEventListener('hashchange', listener);
      };
    },
  };
}

/**
 * Create a router over `location.hash`.
 *
 * @param patterns route patterns to match against, in priority order
 * @param onMatch listener invoked on every hash change
 * @param options injectable browser seams (defaults to the real `window`)
 */
export function createRouter(
  patterns: readonly string[],
  onMatch: RouteListener,
  options: RouterOptions = browserRouterOptions(),
): Router {
  let unsubscribe: (() => void) | null = null;
  let started = false;

  const findMatch = (path: string): RouteMatch | null => {
    for (const pattern of patterns) {
      const params = matchPath(pattern, path);
      if (params !== null) return { path, pattern, params };
    }
    return null;
  };

  const resolve = (): void => {
    const path = hashToPath(options.getHash());
    if (path === '') return; // in-page anchor — keep the current view
    onMatch(findMatch(path));
  };

  return {
    start: () => {
      if (started) return;
      started = true;
      unsubscribe = options.subscribe(resolve);
      resolve();
    },
    navigate: (path, navigateOptions) => {
      const target = `#${normalizePath(path)}`;
      if (options.getHash() === target) {
        resolve(); // same hash fires no `hashchange`; resolve explicitly
        return;
      }
      options.setHash(target, navigateOptions?.replace ?? false);
    },
    dispose: () => {
      unsubscribe?.();
      unsubscribe = null;
      started = false;
    },
  };
}

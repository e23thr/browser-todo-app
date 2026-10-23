/// <reference lib="webworker" />
/**
 * Service worker — ADR-005 Decisions 2–4 (hand-written, dependency-free, no Workbox).
 *
 * - install: atomically populate the versioned shell cache from the generated precache manifest
 *   (all-or-nothing — a failed entry fails the install and the previous version keeps serving).
 * - activate: `clients.claim()` + purge this app's OTHER `todo-shell:<slug>:v:*` caches (old
 *   versions). The purge is scoped to the base-path slug in the name (ADR-005 Decision 3), so a
 *   sibling project page's cache on the shared origin is never touched.
 * - fetch: cache-first for everything in scope (Decision 4 table, implemented in `routing.ts`),
 *   write-through only on the rare cache miss; `sw.js` itself and everything out of scope passes
 *   through to the network. The ONLY intentional network use is the browser's own update check
 *   (`registration.update()` from the page) — app data never touches the network (§6.1).
 * - message: `SKIP_WAITING` — the single `self.skipWaiting()` call site in the codebase
 *   (ADR-005 Decision 5 rule 6; lint-restricted to this handler).
 */

import { PRECACHE_ENTRIES, SHELL_VERSION } from './precache-manifest';
import {
  baseSlugFromScope,
  isShellCacheNameForSlug,
  routeRequest,
  shellCacheName,
  type RouteDecision,
} from './routing';

declare const self: ServiceWorkerGlobalScope;

/** The registration scope is the base path (`/<repo>/` on GitHub Pages) — ADR-005 Decision 8. */
const scope = self.registration.scope;
const baseSlug = baseSlugFromScope(scope);
const shellCache = shellCacheName(baseSlug, SHELL_VERSION);

function precacheUrl(entryUrl: string): string {
  return new URL(entryUrl, scope).href;
}

/** Install: populate the cache atomically (Decision 2). No `skipWaiting` here — updates wait. */
async function installShell(): Promise<void> {
  const cache = await caches.open(shellCache);
  await cache.addAll(PRECACHE_ENTRIES.map((entry) => precacheUrl(entry.url)));
}

/**
 * Activate (after the user applied, or first install): claim + purge this app's OTHER shell
 * caches. The purge is scoped to the current base slug (ADR-005 Decision 3): only
 * `todo-shell:<thisSlug>:v:*` names other than the current cache are deleted, so a sibling
 * project page's cache on the shared origin survives this app's update.
 */
async function activateShell(): Promise<void> {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => isShellCacheNameForSlug(name, baseSlug) && name !== shellCache)
      .map((name) => caches.delete(name)),
  );
  await self.clients.claim();
}

/** The decision kinds the fetch handler serves from cache (everything except passthrough). */
type CacheableDecision = Extract<RouteDecision, { readonly cacheUrl: string }>;

/**
 * Serve from the versioned cache; on the rare miss, fetch through and cache successes only.
 *
 * Cache keys are origin + pathname (see `routing.ts`): content-hashed assets never carry
 * meaningful queries, and error responses are never cached (no cache poisoning across versions).
 */
async function serve(decision: CacheableDecision, request: Request): Promise<Response> {
  const cache = await caches.open(shellCache);
  const cached = await cache.match(decision.cacheUrl);
  if (cached !== undefined) return cached;

  // Documents fetch the shell URL (deep links must not 404); assets fetch the real request.
  const response = await fetch(decision.kind === 'asset' ? request : decision.cacheUrl);
  if (response.ok) {
    await cache.put(decision.cacheUrl, response.clone());
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(installShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(activateShell());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const decision = routeRequest({
    url: request.url,
    method: request.method,
    scope,
    mode: request.mode,
    destination: request.destination,
  });
  if (decision.kind === 'passthrough') return; // no respondWith: the browser handles it
  event.respondWith(serve(decision, request));
});

interface SkipWaitingMessage {
  readonly type: 'SKIP_WAITING';
}

function isSkipWaitingMessage(data: unknown): data is SkipWaitingMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { readonly type?: unknown }).type === 'SKIP_WAITING'
  );
}

self.addEventListener('message', (event) => {
  if (!isSkipWaitingMessage(event.data)) return;
  // ADR-005 Decision 5 rule 6: the single `skipWaiting()` call site — user-gated Apply only.
  event.waitUntil(self.skipWaiting());
});

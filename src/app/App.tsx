import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentType, JSX } from 'preact';

import { NotFoundView } from './NotFoundView';
import { createRouter, hashToPath, type RouteMatch } from './router';
import { TodayView } from '../features/today/TodayView';

/** A route view: a component that renders itself with no props. */
export type ViewComponent = ComponentType;

type RouteEntry =
  | { readonly kind: 'static'; readonly Component: ViewComponent }
  | { readonly kind: 'lazy'; readonly load: () => Promise<{ default: ViewComponent }> };

/**
 * Route table.
 *
 * Only the core loop (`/` → `/today`) is statically imported: it is part of the initial JS
 * closure that the `initial-js` budget gate measures. Everything beyond it is a lazy chunk,
 * which is how the route-level code-splitting requirement of §9.2 is satisfied structurally.
 */
const routes: Readonly<Record<string, RouteEntry>> = {
  '/': { kind: 'static', Component: TodayView },
  '/today': { kind: 'static', Component: TodayView },
  '/settings': {
    kind: 'lazy',
    load: () => import('../features/settings/SettingsView'),
  },
};

const routePatterns = Object.keys(routes);

type ViewState =
  | { readonly kind: 'ready'; readonly Component: ViewComponent }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'not-found'; readonly path: string };

function isCurrentRoute(route: RouteMatch | null, patterns: readonly string[]): boolean {
  return route !== null && patterns.includes(route.pattern);
}

export function App(): JSX.Element {
  const [route, setRoute] = useState<RouteMatch | null>(null);
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    const handleMatch = (match: RouteMatch | null): void => {
      setRoute(match);

      if (match === null) {
        setView({ kind: 'not-found', path: hashToPath(window.location.hash) });
        return;
      }

      const entry = routes[match.pattern];
      if (entry === undefined) {
        setView({ kind: 'not-found', path: match.path });
        return;
      }
      if (entry.kind === 'static') {
        setView({ kind: 'ready', Component: entry.Component });
        return;
      }

      setView({ kind: 'loading' });
      entry
        .load()
        .then((module) => {
          if (mounted.current) setView({ kind: 'ready', Component: module.default });
        })
        .catch(() => {
          if (mounted.current) setView({ kind: 'error' });
        });
    };

    const router = createRouter(routePatterns, handleMatch);
    router.start();

    return () => {
      mounted.current = false;
      router.dispose();
    };
  }, []);

  const currentView = (() => {
    switch (view.kind) {
      case 'ready':
        return <view.Component />;
      case 'loading':
        return (
          <p role="status" aria-live="polite">
            Loading…
          </p>
        );
      case 'error':
        return (
          <p role="alert">
            This view failed to load. Try refreshing the page, or{' '}
            <a href="#/today">go back to Today</a>.
          </p>
        );
      case 'not-found':
        return <NotFoundView path={view.path} />;
    }
  })();

  return (
    <div class="app">
      <a class="skip-link" href="#main">
        Skip to main content
      </a>
      <header class="app-header">
        <h1 class="app-title">
          <a href="#/today">Todo</a>
        </h1>
        <nav class="app-nav" aria-label="Primary">
          <ul>
            <li>
              <a
                href="#/today"
                aria-current={isCurrentRoute(route, ['/', '/today']) ? 'page' : undefined}
              >
                Today
              </a>
            </li>
            <li>
              <a
                href="#/settings"
                aria-current={isCurrentRoute(route, ['/settings']) ? 'page' : undefined}
              >
                Settings
              </a>
            </li>
          </ul>
        </nav>
      </header>
      <main id="main" class="app-main" tabindex={-1}>
        {currentView}
      </main>
      <footer class="app-footer">
        <p>All data stays on this device.</p>
      </footer>
    </div>
  );
}

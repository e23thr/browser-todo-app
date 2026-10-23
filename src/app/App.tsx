import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentType, JSX } from 'preact';

import { announce } from './announce';
import { t } from './i18n';
import { NotFoundView } from './NotFoundView';
import { createRouter, hashToPath, type RouteMatch } from './router';
import { Shell } from './Shell';
import { loadSettings } from './settings';
import { AllOpenView } from '../features/all/AllOpenView';
import { CompletedView } from '../features/completed/CompletedView';
import { ListView } from '../features/lists/ListView';
import { SearchView } from '../features/search/SearchView';
import { TodayView } from '../features/today/TodayView';
import { WeekView } from '../features/week/WeekView';

/** Props every route view receives; `ListView` reads `params.id`, the rest ignore them. */
export interface ViewProps {
  readonly params: Readonly<Record<string, string>>;
}

/** A route view. */
export type ViewComponent = ComponentType<ViewProps>;

type RouteEntry =
  | { readonly kind: 'static'; readonly Component: ViewComponent }
  | { readonly kind: 'lazy'; readonly load: () => Promise<{ default: ViewComponent }> };

/**
 * Route table (design §2).
 *
 * Only the core loop (`/` → `/today` plus its sibling views) is statically imported: that is
 * the initial-JS closure the §9.2 budget measures. Settings stays a lazy chunk (§9.2
 * route-level code splitting).
 *
 * `/next7` is registered as an alias of `/week`: the two design specs disagree on that path
 * (ux-foundation §2 says `/week`, core-domain §4.1 says `#/next7`) and the shell serves both
 * rather than breaking a link — the nav uses `/week`.
 */
const routes: Readonly<Record<string, RouteEntry>> = {
  '/': { kind: 'static', Component: TodayView },
  '/today': { kind: 'static', Component: TodayView },
  '/week': { kind: 'static', Component: WeekView },
  '/next7': { kind: 'static', Component: WeekView },
  '/all': { kind: 'static', Component: AllOpenView },
  '/completed': { kind: 'static', Component: CompletedView },
  '/search': { kind: 'static', Component: SearchView },
  '/list/:id': { kind: 'static', Component: ListView },
  '/settings': {
    kind: 'lazy',
    load: () => import('../features/settings/SettingsView'),
  },
};

const routePatterns = Object.keys(routes);

type ViewState =
  | {
      readonly kind: 'ready';
      readonly Component: ViewComponent;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'not-found'; readonly path: string };

export function App(): JSX.Element {
  const [route, setRoute] = useState<RouteMatch | null>(null);
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const mounted = useRef(true);
  const firstPaint = useRef(true);

  // Settings boot: mirror first (pre-paint state), then the durable ADR-002 record wins.
  useEffect(() => {
    void loadSettings();
  }, []);

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
        setView({ kind: 'ready', Component: entry.Component, params: match.params });
        return;
      }

      setView({ kind: 'loading' });
      entry
        .load()
        .then((module) => {
          if (mounted.current) {
            setView({ kind: 'ready', Component: module.default, params: match.params });
          }
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

  // SPA route-change contract (§4.1): move focus to the view's h1 and announce the view.
  // Skipped on the very first paint so the skip link stays the first focusable element.
  useEffect(() => {
    if (view.kind !== 'ready') return;
    if (firstPaint.current) {
      firstPaint.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const heading = document.querySelector<HTMLElement>('main [data-view-title]');
      if (heading === null) return;
      heading.focus();
      announce(t('a11y.viewChanged', { view: heading.textContent.trim() }));
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [route?.path, view.kind]);

  const currentPattern = route?.pattern ?? null;

  const currentView = ((): JSX.Element => {
    switch (view.kind) {
      case 'ready': {
        const View = view.Component;
        return <View params={view.params} />;
      }
      case 'loading':
        return (
          <p role="status" aria-live="polite">
            {t('shell.loading')}
          </p>
        );
      case 'error':
        return (
          <p role="alert">
            {t('error.viewLoad.title')} {t('error.viewLoad.body')}
            <a href="#/today">{t('error.viewLoad.back')}</a>
          </p>
        );
      case 'not-found':
        return <NotFoundView path={view.path} />;
    }
  })();

  return <Shell pattern={currentPattern}>{currentView}</Shell>;
}

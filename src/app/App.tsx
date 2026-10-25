import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentType, JSX } from 'preact';

import { announce } from './announce';
import { t } from './i18n';
import { NotFoundView } from './NotFoundView';
import { registerQuickAddHandler, startQuickAdd } from './quickAdd';
import { createRouter, hashToPath, type RouteMatch } from './router';
import { Shell } from './Shell';
import { loadSettings } from './settings';
import { notifyChunkLoadFailure } from './stale-tab';
import { CommandPalette } from '../features/commands/CommandPalette';
import { registerCommandOpeners } from '../features/commands/openers';
import { installShortcutLayer } from '../features/commands/shortcutLayer';
import { ShortcutsHelpDialog } from '../features/commands/ShortcutsHelpDialog';
import type { Task } from '../domain/model';
import { AllOpenView } from '../features/all/AllOpenView';
import { CompletedView } from '../features/completed/CompletedView';
import { DataSafetyHost } from '../features/data-safety/DataSafetyHost';
import { markRecoveryStarted, writeOnboardingDone } from '../features/data-safety/flags';
import { requestImportPick } from '../features/data-safety/importFlow';
import { Onboarding } from '../features/data-safety/Onboarding';
import { RecoveryScreen } from '../features/data-safety/RecoveryScreen';
import { dataSafetyState, patchState } from '../features/data-safety/state';
import { ListsManageView } from '../features/lists/ListsManageView';
import { ListView } from '../features/lists/ListView';
import { startReminders } from '../features/notifications/reminders';
import { ReminderDialog } from '../features/notifications/ReminderDialog';
import { SearchView } from '../features/search/SearchView';
import { Composer, inlineComposerFocus } from '../features/tasks/Composer';
import { MoveToListDialog } from '../features/tasks/MoveToListDialog';
import { liveLists, moveTaskTo, startTaskStore, state as taskState } from '../features/tasks/store';
import { ToastHost } from '../features/tasks/ToastHost';
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
  '/lists': { kind: 'static', Component: ListsManageView },
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
  const [composerSheet, setComposerSheet] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [moveTask, setMoveTask] = useState<Task | null>(null);
  const [reminderTask, setReminderTask] = useState<Task | null>(null);
  const mounted = useRef(true);
  const firstPaint = useRef(true);

  const safety = dataSafetyState.value;
  // S1 first run (§7 "shown before task UI") and S5 recovery (§6.5) replace the
  // WHOLE shell — the global shortcut layer and command openers are live only
  // while the shell is.
  const shellVisible =
    !safety.onboarding && !(safety.status === 'ready' && safety.classification.kind === 'wiped');

  // Settings boot: mirror first (pre-paint state), then the durable ADR-002 record wins.
  useEffect(() => {
    void loadSettings();
  }, []);

  // Core UI (M1–M4): boot the domain store (ADR-002 → repos → MutationRunner) once.
  useEffect(() => {
    void startTaskStore();
  }, []);

  // Quick-add seam (F1 "from any view"): focus the wide inline composer when one is
  // mounted, otherwise open the compact sheet. Never a dead control.
  useEffect(
    () =>
      registerQuickAddHandler(() => {
        if (inlineComposerFocus.current !== null) {
          inlineComposerFocus.current();
          return;
        }
        setComposerSheet(true);
      }),
    [],
  );

  // S8: the global shortcut layer + command openers live exactly as long as the
  // shell does (onboarding / recovery replace it — see `shellVisible` above).
  useEffect(() => {
    if (!shellVisible) return;
    return installShortcutLayer({
      palette: () => {
        setPaletteOpen(true);
      },
      quickAdd: () => {
        startQuickAdd();
      },
      search: () => {
        window.location.hash = '#/search';
      },
      help: () => {
        setHelpOpen(true);
      },
    });
  }, [shellVisible]);

  useEffect(() => {
    if (!shellVisible) return;
    return registerCommandOpeners({
      palette: () => {
        setPaletteOpen(true);
      },
      help: () => {
        setHelpOpen(true);
      },
    });
  }, [shellVisible]);

  // S5: local reminder scheduling. Reads permission state only — it never
  // prompts (first-use permission is requested by user gestures, never here).
  useEffect(() => startReminders(), []);

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
          // ADR-005 Decision 3 (stale-tab guard): when a lazy chunk vanished because an update
          // was applied in another tab, show the explained refresh notice — never auto-reload (E9).
          notifyChunkLoadFailure();
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
  // A view that marks its own autofocus target (S5 search input, F8.1) wins over the h1.
  useEffect(() => {
    if (view.kind !== 'ready') return;
    if (firstPaint.current) {
      firstPaint.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const heading = document.querySelector<HTMLElement>('main [data-view-title]');
      if (heading === null) return;
      const autofocus = [...document.querySelectorAll<HTMLElement>('main [data-autofocus]')].find(
        (el) => el.closest('.dialog') === null,
      );
      (autofocus ?? heading).focus();
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

  // S1 first run (§7 "shown before task UI") and S5 recovery (§6.5) replace the WHOLE shell:
  // there is no background content for focus or a screen reader to land on.
  if (safety.onboarding) {
    return (
      <Onboarding
        onDone={() => {
          writeOnboardingDone();
          patchState({ onboarding: false });
        }}
      />
    );
  }

  if (safety.status === 'ready' && safety.classification.kind === 'wiped') {
    const lastBackupAt = safety.classification.lastBackupAt;
    const dismiss = (): void => {
      patchState({ classification: { kind: 'normal' }, onboarding: false });
    };
    return (
      <RecoveryScreen
        lastBackupAt={lastBackupAt}
        onRestore={() => {
          // No acknowledgement here: if the user backs out of the import, the next boot
          // shows the screen again while the store is still empty (§3.4 honest detection).
          dismiss();
          window.location.hash = '#/settings';
          requestImportPick();
        }}
        onStartFresh={() => {
          markRecoveryStarted();
          dismiss();
          window.location.hash = '#/today';
        }}
      />
    );
  }

  return (
    <Shell pattern={currentPattern}>
      <DataSafetyHost />
      <ToastHost />
      {currentView}
      {composerSheet ? (
        <Composer
          variant="sheet"
          onClose={() => {
            setComposerSheet(false);
          }}
        />
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          onClose={() => {
            setPaletteOpen(false);
          }}
          onOpenHelp={() => {
            setPaletteOpen(false);
            setHelpOpen(true);
          }}
          onMoveTask={(task) => {
            setPaletteOpen(false);
            setMoveTask(task);
          }}
          onSetReminder={(task) => {
            setPaletteOpen(false);
            setReminderTask(task);
          }}
        />
      ) : null}
      {helpOpen ? (
        <ShortcutsHelpDialog
          onClose={() => {
            setHelpOpen(false);
          }}
        />
      ) : null}
      {moveTask !== null ? (
        <MoveToListDialog
          task={moveTask}
          lists={liveLists(taskState.value)}
          onMove={(targetListId) => {
            const task = moveTask;
            const listName = taskState.value.lists.get(targetListId)?.name ?? '';
            setMoveTask(null);
            void moveTaskTo(task.id, targetListId, 'last').then((result) => {
              if (result.ok) {
                announce(t('a11y.taskMovedToList', { title: task.title, list: listName }));
              }
            });
          }}
          onCancel={() => {
            setMoveTask(null);
          }}
        />
      ) : null}
      {reminderTask !== null ? (
        <ReminderDialog
          task={reminderTask}
          onClose={() => {
            setReminderTask(null);
          }}
        />
      ) : null}
    </Shell>
  );
}

/**
 * Command palette (V1 S8) — fuzzy action + task navigation covering the core
 * loop: add, complete, move, search, settings (binding decision on t_ee8ecb0b).
 *
 * Interaction model (fully keyboard-operable — WCAG 2.2 AA):
 *  - `Dialog` supplies the modal shell: focus trap, Escape, focus return (§9.6).
 *  - The input is a `combobox` over a `listbox`; `↑`/`↓` (and Home/End) move the
 *    active option announced via `aria-activedescendant`, `Enter` runs it.
 *  - A task entry drills into a second stage (Open / Complete / Move to list…);
 *    Escape there steps back to the root stage instead of closing, so the
 *    "complete" and "move" core-loop commands are always one keystroke deep.
 *  - Results are capped (`RESULT_LIMIT`) and ranked by `paletteIndex`, so a 10k
 *    task list stays inside the §9.1 INP budget (pinned in the unit suite AND
 *    on this component path in tests/component/commands.test.tsx — review N3).
 *  - The row table is memoized on the store snapshot + stage, and the ranked
 *    ids resolve through a `Map`, so a keystroke costs one rank pass and no
 *    per-row scans (review N3).
 */

import { useId, useMemo, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';

import { announce } from '../../app/announce';
import { t } from '../../app/i18n';
import { Dialog } from '../../components/Dialog';
import type { Task } from '../../domain/model';
import { setTaskDone, state } from '../tasks/store';
import { startQuickAdd } from '../../app/quickAdd';
import { rankEntries, type PaletteEntry } from './paletteIndex';

const RESULT_LIMIT = 20;

type Stage = { readonly kind: 'root' } | { readonly kind: 'task'; readonly task: Task };

interface Row {
  readonly entry: PaletteEntry;
  readonly run: () => void;
}

/** Focus a task's row without selector interpolation (ids are app-generated). */
function focusTaskRow(taskId: string): void {
  const row = [...document.querySelectorAll<HTMLElement>('[data-task-id]')].find(
    (element) => element.dataset['taskId'] === taskId,
  );
  row?.focus();
}

export interface CommandPaletteProps {
  readonly onClose: () => void;
  /** Swap to the shortcuts help dialog (the palette closes first). */
  readonly onOpenHelp: () => void;
  /** Host renders the move-to-list dialog for this task. */
  readonly onMoveTask: (task: Task) => void;
  /** Host renders the reminder dialog for this task (S5). */
  readonly onSetReminder: (task: Task) => void;
}

export function CommandPalette({
  onClose,
  onOpenHelp,
  onMoveTask,
  onSetReminder,
}: CommandPaletteProps): JSX.Element {
  const listId = useId();
  const hintId = `${listId}-hint`;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [stage, setStage] = useState<Stage>({ kind: 'root' });

  // One snapshot per store revision: `state` is replaced (not mutated) on every
  // mutation, so this memo is fresh whenever the data is and untouched by
  // keystrokes.
  const storeState = state.value;
  const rows: Row[] = useMemo(() => {
    if (stage.kind === 'task') {
      const task = stage.task;
      const done = task.status === 'done';
      const stageRows: Row[] = [
        {
          entry: {
            id: 'open',
            kind: 'action',
            label: t('palette.task.open'),
            haystack: t('palette.group.tasks'),
          },
          run: () => {
            onClose();
            window.location.hash = `#/list/${encodeURIComponent(task.listId)}`;
            setTimeout(() => {
              focusTaskRow(task.id);
            }, 0);
          },
        },
        {
          entry: {
            id: 'toggle',
            kind: 'action',
            label: done ? t('palette.task.reopen') : t('palette.task.complete'),
            haystack: t('palette.group.tasks'),
          },
          run: () => {
            onClose();
            void setTaskDone(task.id, !done).then((result) => {
              if (result.ok) announce(t(done ? 'a11y.taskReopened' : 'a11y.taskCompleted'));
            });
          },
        },
        {
          entry: {
            id: 'move',
            kind: 'action',
            label: t('palette.task.move'),
            haystack: t('palette.group.tasks'),
          },
          run: () => {
            onMoveTask(task);
          },
        },
        {
          entry: {
            id: 'remind',
            kind: 'action',
            label: t('palette.task.remind'),
            haystack: t('palette.group.tasks'),
          },
          run: () => {
            onSetReminder(task);
          },
        },
      ];
      return stageRows;
    }

    const actionRows: Row[] = [
      {
        entry: {
          id: 'add',
          kind: 'action',
          label: t('palette.action.addTask'),
          haystack: t('palette.group.actions'),
        },
        run: () => {
          onClose();
          startQuickAdd();
        },
      },
      {
        entry: {
          id: 'search',
          kind: 'action',
          label: t('palette.action.search'),
          haystack: t('palette.group.actions'),
        },
        run: () => {
          onClose();
          window.location.hash = '#/search';
        },
      },
      {
        entry: {
          id: 'settings',
          kind: 'action',
          label: t('palette.action.settings'),
          haystack: t('palette.group.actions'),
        },
        run: () => {
          onClose();
          window.location.hash = '#/settings';
        },
      },
      ...(
        [
          ['goToday', '#/today', 'palette.action.goToday'],
          ['goWeek', '#/week', 'palette.action.goWeek'],
          ['goAll', '#/all', 'palette.action.goAll'],
          ['goCompleted', '#/completed', 'palette.action.goCompleted'],
          ['goLists', '#/lists', 'palette.action.goLists'],
        ] as const
      ).map(([id, href, labelKey]) => ({
        entry: {
          id,
          kind: 'action' as const,
          label: t(labelKey),
          haystack: t('palette.group.actions'),
        },
        run: () => {
          onClose();
          window.location.hash = href;
        },
      })),
      {
        entry: {
          id: 'help',
          kind: 'action',
          label: t('palette.action.shortcutHelp'),
          haystack: t('palette.group.actions'),
        },
        run: () => {
          onOpenHelp();
        },
      },
    ];

    const taskRows: Row[] = [...storeState.tasks.values()]
      .filter((task) => task.deletedAt === null)
      .map((task) => ({
        entry: {
          id: task.id,
          kind: 'task' as const,
          label: task.title,
          haystack: storeState.lists.get(task.listId)?.name ?? '',
        },
        run: () => {
          setStage({ kind: 'task', task });
          setQuery('');
          setActive(0);
        },
      }));

    return [...actionRows, ...taskRows];
    // The row closures capture the host handlers, which are semantically stable
    // across renders (they route to module-level store actions and host state).
  }, [storeState, stage]);

  const visible = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.entry.id, row]));
    return rankEntries(
      query,
      rows.map((row) => row.entry),
      RESULT_LIMIT,
    ).map((entry) => byId.get(entry.id) as Row);
  }, [rows, query]);
  const activeIndex = visible.length === 0 ? -1 : Math.min(active, visible.length - 1);

  const runActive = (): void => {
    const row = visible[activeIndex];
    if (row !== undefined) row.run();
  };

  const onInputKeyDown = (event: TargetedEvent<HTMLInputElement, KeyboardEvent>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((index) => Math.min(index + 1, Math.max(visible.length - 1, 0)));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
        return;
      case 'Home':
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        event.preventDefault();
        setActive(Math.max(visible.length - 1, 0));
        return;
      case 'Enter':
        event.preventDefault();
        runActive();
        return;
      default:
    }
  };

  // Escape/`onClose` steps back out of the task stage first (Dialog routes its
  // Escape + scrim through here); from the root stage it closes the palette.
  const handleClose = (): void => {
    if (stage.kind === 'task') {
      setStage({ kind: 'root' });
      setQuery('');
      setActive(0);
      return;
    }
    onClose();
  };

  return (
    <Dialog
      label={t('palette.title')}
      panelClass="command-palette"
      describedById={hintId}
      onClose={handleClose}
    >
      <label class="visually-hidden" htmlFor={`${listId}-input`}>
        {t('palette.title')}
      </label>
      <input
        id={`${listId}-input`}
        class="input palette-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeIndex >= 0 ? `${listId}-opt-${String(activeIndex)}` : undefined
        }
        data-autofocus=""
        autocomplete="off"
        placeholder={t('palette.placeholder')}
        value={query}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={onInputKeyDown}
      />
      <p class="palette-hint" id={hintId}>
        {t('palette.hint')}
      </p>
      <ul class="palette-list" id={listId} role="listbox" aria-label={t('palette.listLabel')}>
        {visible.map((row, index) => (
          <li
            key={row.entry.id}
            id={`${listId}-opt-${String(index)}`}
            class="palette-option"
            role="option"
            aria-selected={index === activeIndex}
            data-active={index === activeIndex ? 'true' : undefined}
            data-kind={row.entry.kind}
            onMouseEnter={() => {
              setActive(index);
            }}
            onClick={row.run}
            onKeyDown={(event) => {
              // The listbox is driven from the combobox input (aria-activedescendant);
              // this keeps a focused option operable for the a11y lint contract too.
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                row.run();
              }
            }}
          >
            <span class="palette-option-label">{row.entry.label}</span>
            {row.entry.kind === 'task' ? (
              <span class="palette-option-group">{t('palette.group.tasks')}</span>
            ) : (
              <span class="palette-option-group">{t('palette.group.actions')}</span>
            )}
          </li>
        ))}
        {visible.length === 0 ? (
          <li class="palette-empty" role="presentation">
            {t('palette.empty')}
          </li>
        ) : null}
      </ul>
    </Dialog>
  );
}

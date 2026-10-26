/**
 * S6 archive UI (E9) — the retention view's interaction contract on the real
 * TaskScreen: localized retention/archived group headers, the row-menu
 * Archive item (done rows) and Restore item (archived rows), the
 * checkbox-on-archived = RESTORE binding, and the polite announcements.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

import { TaskScreen } from '../../src/features/tasks/TaskScreen';
import { state } from '../../src/features/tasks/store';
import { makeList, makeTask, regions, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

const DAY = 24 * 60 * 60 * 1000;
/** Seeded completion instant of the archived fixture (asserted after restore). */
const ARCH_COMPLETED = Date.now() - 2 * DAY;

function completedScreen(): ReturnType<typeof render> {
  return render(
    <TaskScreen
      view={{ kind: 'completed' }}
      title="Completed"
      emptyIcon="check-circle"
      emptyTitle="Nothing completed yet"
      emptyBody="Completed tasks will collect here."
    />,
  );
}

async function seedHistory(): Promise<void> {
  await seed({
    lists: [makeList({ id: 'L1', name: 'Personal' })],
    tasks: [
      makeTask({
        id: 'DONE1',
        listId: 'L1',
        title: 'recent done',
        status: 'done',
        completedAt: Date.now() - DAY,
      }),
      makeTask({
        id: 'OLD1',
        listId: 'L1',
        title: 'old done',
        status: 'done',
        completedAt: Date.now() - 40 * DAY,
      }),
      makeTask({
        id: 'ARCH1',
        listId: 'L1',
        title: 'archived thing',
        status: 'archived',
        completedAt: ARCH_COMPLETED,
      }),
    ],
  });
}

function openRowMenu(title: string): void {
  fireEvent.click(screen.getByRole('button', { name: `Actions for "${title}"` }));
}

describe('S6 retention view: group headers', () => {
  beforeEach(() => {
    setUpCoreUi();
  });
  afterEach(() => {
    tearDownCoreUi();
  });

  it('renders the localized recent / older / archived group titles with counts', async () => {
    await seedHistory();
    completedScreen();
    expect(
      screen.getByRole('heading', { name: 'Recently completed (last 7 days) (1)' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Older (1)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Archived (1)' })).toBeTruthy();
  });
});

describe('S6 row menu: Archive', () => {
  beforeEach(() => {
    setUpCoreUi();
  });
  afterEach(() => {
    tearDownCoreUi();
  });

  it('archives a done row from its menu and announces it; the row moves to the Archived group', async () => {
    await seedHistory();
    completedScreen();

    openRowMenu('recent done');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));

    await waitFor(() => {
      expect(state.value.tasks.get('DONE1')?.status).toBe('archived');
    });
    // completedAt is preserved — the archived group still shows the finish date.
    const archivedRow = state.value.tasks.get('DONE1');
    expect(archivedRow?.completedAt).toBeDefined();
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task archived');
    });
    // The row now lives under the Archived header, not the recent one.
    expect(screen.getByRole('heading', { name: 'Archived (2)' })).toBeTruthy();
  });

  it('does NOT offer Archive on an open row (list view)', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'O1', listId: 'L1', title: 'open thing', status: 'open' })],
    });
    render(
      <TaskScreen
        view={{ kind: 'list', listId: 'L1' }}
        title="Personal"
        emptyIcon="folder"
        emptyTitle="Empty"
        emptyBody="Nothing"
      />,
    );
    openRowMenu('open thing');
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
  });
});

describe('S6 archived rows: restore bindings', () => {
  beforeEach(() => {
    setUpCoreUi();
  });
  afterEach(() => {
    tearDownCoreUi();
  });

  it('renders the archived row CHECKED with the restore checkbox label', async () => {
    await seedHistory();
    completedScreen();
    const check = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Restore "archived thing" from the archive',
    });
    expect(check.checked).toBe(true);
  });

  it('checkbox-on-archived RESTORES (never reopens) and announces it', async () => {
    await seedHistory();
    completedScreen();
    const check = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Restore "archived thing" from the archive',
    });
    fireEvent.click(check);

    await waitFor(() => {
      expect(state.value.tasks.get('ARCH1')?.status).toBe('done');
    });
    // Restore keeps the original completedAt (backfill only when missing).
    expect(state.value.tasks.get('ARCH1')?.completedAt).toBe(ARCH_COMPLETED);
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task restored');
    });
  });

  it('the row-menu Restore item runs the same restore path', async () => {
    await seedHistory();
    completedScreen();

    openRowMenu('archived thing');
    const restore = screen.getByRole('menuitem', { name: 'Restore' });
    fireEvent.click(restore);

    await waitFor(() => {
      expect(state.value.tasks.get('ARCH1')?.status).toBe('done');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task restored');
    });
  });

  it('a done row menu carries Restore nowhere (only Archive)', async () => {
    await seedHistory();
    completedScreen();
    openRowMenu('recent done');
    expect(screen.queryByRole('menuitem', { name: 'Restore' })).toBeNull();
  });
});

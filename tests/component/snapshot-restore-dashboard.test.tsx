/**
 * S11 acceptance: the storage dashboard's snapshot list RESTORES — the visible
 * "Restore" button on a dashboard row drives the engine's existing
 * `restoreSnapshot` path (prepare → restore-confirm dialog → pre-import
 * snapshot + atomic replace), i.e. the dashboard adds no second restore logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

import { bindDataSafetyDb, takeSnapshot } from '../../src/portability';
import type { AppDBImpl } from '../../src/storage/db';
import { SnapshotList } from '../../src/features/data-safety/SnapshotList';
import { answerDialog, currentDialog, resetDialogs } from '../../src/features/data-safety/notices';
import { resetFlags } from '../../src/features/data-safety/flags';
import { restoreSnapshot } from '../../src/features/data-safety/importFlow';
import { refreshSnapshots } from '../../src/features/data-safety/snapshots';
import { resetState } from '../../src/features/data-safety/state';
import { resetStorageInfo } from '../../src/features/data-safety/storageInfo';
import { resetPendingWrites } from '../../src/features/data-safety/pendingWrites';
import {
  makeList,
  makeSettings,
  makeTask,
  openFixtureDb,
  uniqueDbName,
} from '../unit/storage/fixtures';

const opened: AppDBImpl[] = [];

beforeEach(async () => {
  window.localStorage.clear();
  resetFlags();
  resetState();
  resetDialogs();
  resetStorageInfo();
  resetPendingWrites();

  const db = await openFixtureDb(uniqueDbName('dash-restore'));
  opened.push(db);
  await db.put('settings', makeSettings());
  // The task must reference the REAL seeded list — Stage B's referential pass
  // quarantines orphans, and a restore must round-trip a coherent corpus.
  const list = makeList();
  await db.put('lists', list);
  await db.put('tasks', makeTask({ listId: list.id, title: 'original title' }));
  bindDataSafetyDb(db);
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe('<SnapshotList> dashboard restore (S11)', () => {
  it('Restore → confirm → the snapshot data is back (existing pipeline, one path)', async () => {
    const db = opened[0];
    expect(db).toBeDefined();
    if (db === undefined) return;

    // 1. Snapshot the seeded state (this is what the dashboard row will offer).
    const snap = await takeSnapshot('manual', { db });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    // 2. Diverge: the user's data changes after the snapshot.
    const before = await db.getAll('tasks');
    expect(before.ok && before.value[0]?.title).toBe('original title');
    const changed = before.ok ? before.value[0] : undefined;
    expect(changed).toBeDefined();
    if (changed === undefined) return;
    const put = await db.put('tasks', { ...changed, title: 'changed after snapshot' });
    expect(put.ok).toBe(true);
    const mid = await db.getAll('tasks');
    expect(mid.ok && mid.value[0]?.title).toBe('changed after snapshot');

    // 3. The dashboard row: snapshot metadata loaded the same way the panel loads it.
    const rows = await refreshSnapshots();
    expect(rows).toHaveLength(1);

    const onDownload = vi.fn();
    render(
      <SnapshotList
        snapshots={rows}
        now={Date.now()}
        onRestore={(id) => {
          void restoreSnapshot(id);
        }}
        onDownload={onDownload}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    // 4. The EXISTING restore-confirm dialog appears (not a bespoke dashboard dialog).
    await waitFor(() => {
      expect(currentDialog()).not.toBeNull();
    });
    expect(currentDialog()?.request.kind).toBe('restore-confirm');
    answerDialog(true);

    // 5. The snapshot's data is back — full round trip through the import pipeline.
    await waitFor(async () => {
      const after = await db.getAll('tasks');
      expect(after.ok && after.value[0]?.title).toBe('original title');
    });
    // The confirm dialog closes once the write it authorised is over.
    await waitFor(() => {
      expect(currentDialog()).toBeNull();
    });
  });
});

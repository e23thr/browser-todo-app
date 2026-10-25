/**
 * Concurrent-tab coordination (ADR-003 Decision 8): BroadcastChannel transport
 * + the `by_updatedAt` watermark sweep backstop. The message is ADVERSORY ONLY
 * — receivers re-read from IDB (the single source of truth) via `reconcile`,
 * never write on receipt, and never rebroadcast what they received.
 *
 * WATERMARK RULE (review finding D4, Decision 8.2 corrected): the watermark
 * advances ONLY after a full sweep, to the max `updatedAt` actually observed in
 * it. Own commits (`announce`) and targeted refreshes (`refresh`) must NOT move
 * it — a bump there would leapfrog rows written by another tab with an older
 * `updatedAt`, hiding them from `changedSince(> watermark)` forever and
 * breaking eventual consistency under interleaved activity.
 *
 * Wiring (composition root):
 *   const runner = new MutationRunner({ ..., onCommitted: (c) => tabSync.announce(c) });
 *   const tabSync = createTabSync({ runner, reads, clock, tabId, channelFactory? });
 *   tabSync.start();
 */

import type { AppError, Result } from '../domain/kernel';
import type { List, Settings, Task } from '../domain/model';
import type { MutationRunner } from '../domain/pipeline';
import type { Clock } from '../domain/ports';
import {
  isBroadcastMessage,
  isOwnMessage,
  reconcile,
  TAB_SYNC_CHANNEL,
  type BroadcastMessage,
  type ChangeAnnouncement,
  type FreshRows,
  type TabId,
} from '../domain/sync';

export type BroadcastChannelLike = {
  postMessage(data: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
};

export type TabSyncReads = {
  loadAll(): Promise<Result<{ tasks: Task[]; lists: List[]; settings: Settings }, AppError>>;
  getSettings(): Promise<Result<Settings, AppError>>;
  readRows(
    taskIds: readonly string[],
    listIds: readonly string[],
  ): Promise<
    Result<{ tasks: Map<string, Task | null>; lists: Map<string, List | null> }, AppError>
  >;
  tasksChangedSince(since: number): Promise<Result<Task[], AppError>>;
  listsChangedSince(since: number): Promise<Result<List[], AppError>>;
};

export type TabSyncDeps = {
  runner: MutationRunner;
  reads: TabSyncReads;
  clock: Clock;
  tabId: TabId;
  /** Test seam; defaults to `globalThis.BroadcastChannel` when available. */
  channelFactory?: (name: string) => BroadcastChannelLike;
};

export type TabSync = {
  start(): void;
  stop(): void;
  /** Broadcast AFTER commit (wired via `MutationRunner.onCommitted`). */
  announce(change: ChangeAnnouncement): void;
  /**
   * Wholesale data replacement (import / snapshot restore / wipe): re-read the whole
   * store through the SAME path receivers use for `change: 'all'`, then announce `'all'`
   * so every other tab runs that path too (ADR-003 Decision 8.1 rule 2). The acting tab
   * gets its refresh locally — no page reload — and D4 stands: nothing here moves the
   * watermark (a replace is not a sweep, and neither is its receipt).
   */
  replaceAll(): Promise<void>;
  /** Watermark sweep (also bound to `visibilitychange -> visible` while started). */
  sweep(): Promise<void>;
  readonly watermark: number;
};

function defaultChannelFactory(name: string): BroadcastChannelLike | null {
  const BC = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike })
    .BroadcastChannel;
  return BC === undefined ? null : new BC(name);
}

export function createTabSync(deps: TabSyncDeps): TabSync {
  const { runner, reads, clock, tabId } = deps;
  let channel: BroadcastChannelLike | null = null;
  let started = false;
  let watermark = clock();

  const onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void sweep();
    }
  };

  function apply(update: { rows: FreshRows; msg: BroadcastMessage }): void {
    const merged = reconcile(runner.getState(), update.msg, update.rows);
    if (
      (merged.tasks?.length ?? 0) === 0 &&
      (merged.lists?.length ?? 0) === 0 &&
      (merged.evictTasks?.length ?? 0) === 0 &&
      (merged.evictLists?.length ?? 0) === 0 &&
      merged.settings === undefined
    ) {
      return;
    }
    runner.applyExternal(merged);
  }

  async function refresh(msg: BroadcastMessage): Promise<void> {
    // NOTE (D4): a receive never advances the watermark — it only re-reads the
    // rows the sender named (or the whole store for `'all'`), which says
    // nothing about rows this tab has NOT observed.
    if (msg.change === 'all') {
      const all = await reads.loadAll();
      if (!all.ok) return; // read failure: keep local state; next sweep retries
      const rows: FreshRows = {
        tasks: new Map(all.value.tasks.map((t) => [t.id, t])),
        lists: new Map(all.value.lists.map((l) => [l.id, l])),
        settings: all.value.settings,
      };
      apply({ rows, msg });
      return;
    }
    const ids = await reads.readRows(msg.change.tasks ?? [], msg.change.lists ?? []);
    if (!ids.ok) return;
    // `settings: true` = targeted settings reload (Decision 8.1 rule 2).
    let settings: Settings | null | undefined;
    if (msg.change.settings === true) {
      const s = await reads.getSettings();
      settings = s.ok ? s.value : null;
    }
    apply({
      rows: {
        tasks: ids.value.tasks,
        lists: ids.value.lists,
        ...(settings !== undefined ? { settings } : {}),
      },
      msg,
    });
  }

  async function sweep(): Promise<void> {
    const [tasks, lists] = await Promise.all([
      reads.tasksChangedSince(watermark),
      reads.listsChangedSince(watermark),
    ]);
    if (!tasks.ok || !lists.ok) return;
    const taskRows = tasks.value;
    const listRows = lists.value;
    if (taskRows.length === 0 && listRows.length === 0) return;
    const msg: BroadcastMessage = {
      v: 1,
      type: 'data-changed',
      origin: tabId,
      at: clock(),
      change: {
        tasks: taskRows.map((t) => t.id),
        lists: listRows.map((l) => l.id),
      },
    };
    const rows: FreshRows = {
      tasks: new Map(taskRows.map((t) => [t.id, t.deletedAt !== null ? null : t])),
      lists: new Map(listRows.map((l) => [l.id, l.deletedAt !== null ? null : l])),
    };
    apply({ rows, msg });
    // D4: the ONLY place the watermark moves. A full sweep observed every row
    // with `updatedAt > watermark`, so everything at or below the max observed
    // row has been seen — anything newer stays visible to the next sweep.
    for (const t of taskRows) watermark = Math.max(watermark, t.updatedAt);
    for (const l of listRows) watermark = Math.max(watermark, l.updatedAt);
  }

  function announce(change: ChangeAnnouncement): void {
    if (
      change !== 'all' &&
      (change.tasks?.length ?? 0) === 0 &&
      (change.lists?.length ?? 0) === 0 &&
      change.settings !== true
    ) {
      return;
    }
    channel?.postMessage({
      v: 1,
      type: 'data-changed',
      origin: tabId,
      at: clock(),
      change,
    } satisfies BroadcastMessage);
    // D4: NO watermark bump — this tab's own commit says nothing about rows
    // written by other tabs that it has not observed yet.
  }

  async function replaceAll(): Promise<void> {
    // The acting tab's own re-read goes through the receiver path ('all' → full
    // reload) so both sides converge through exactly one code path.
    await refresh({
      v: 1,
      type: 'data-changed',
      origin: tabId,
      at: clock(),
      change: 'all',
    } satisfies BroadcastMessage);
    announce('all');
  }

  return {
    start() {
      if (started) return;
      started = true;
      const factory = deps.channelFactory ?? defaultChannelFactory;
      channel = factory(TAB_SYNC_CHANNEL);
      if (channel !== null) {
        channel.onmessage = (ev) => {
          const msg: unknown = ev.data;
          if (!isBroadcastMessage(msg)) return;
          if (isOwnMessage(msg, tabId)) return;
          void refresh(msg);
        };
      }
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility);
      }
    },
    stop() {
      if (!started) return;
      started = false;
      channel?.close();
      channel = null;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
    announce,
    replaceAll,
    sweep,
    get watermark() {
      return watermark;
    },
  };
}

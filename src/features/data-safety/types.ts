/**
 * Shared types for the data-safety surface (no runtime code — kept separate so `state.ts`,
 * `notices.ts` and the components can all reference them without import cycles).
 */

import type { Snapshot } from '../../storage/types';

/** Row inventory used by the confirm dialogs and the shrink probe (tombstones excluded). */
export interface DataCounts {
  readonly lists: number;
  readonly tasks: number;
  readonly doneTasks: number;
  /** `true` when the store holds at least one live row (drives the nudge's "data exists"). */
  readonly hasData: boolean;
}

/**
 * Boot classification (§3.4 table). Exactly one wins per boot, in this order:
 * wiped → long-absence → shrunken → normal.
 */
export type BootClassification =
  | { readonly kind: 'normal' }
  | {
      readonly kind: 'wiped';
      /** What the settings record remembered, surfaced on the recovery screen (§6.5). */
      readonly lastBackupAt: number | null;
    }
  | {
      readonly kind: 'long-absence';
      readonly absentDays: number;
      readonly lastBackupAt: number | null;
    }
  | {
      readonly kind: 'shrunken';
      /** Fraction of records that disappeared (0.31 = "31% smaller than the snapshot"). */
      readonly dropped: number;
      readonly baseline: DataCounts;
    };

/** §5.7 `ImportPreview` — what the confirm dialog shows before anything changes. */
export interface ImportPreview {
  readonly schemaVersion: number;
  readonly counts: {
    readonly lists: number;
    readonly tasks: number;
    readonly doneTasks: number;
    readonly snapshots: number;
  };
  /** From the file; `null` when the document carries no usable timestamp. */
  readonly exportedAt: number | null;
  readonly fileSizeBytes: number;
}

/** §5.1 / §10 panel-level async state. */
export type PanelState = 'idle' | 'export-loading' | 'import-loading' | 'persist-loading';

/** §5.4 `BackupRowProps.exportState`. */
export type ExportState = 'idle' | 'saving' | 'saved' | 'error';

/** Snapshot metadata the panel renders (a subset of the ADR-002 `Snapshot` row). */
export type SnapshotMeta = Pick<Snapshot, 'id' | 'takenAt' | 'kind' | 'reason' | 'sizeBytes'>;

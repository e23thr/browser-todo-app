/**
 * Foreign-format importers (S12, ADR-004 "V1 importers will reuse this
 * pipeline's validate/quarantine stages").
 *
 * A converter's only job is text → records + per-line rejects. It never touches
 * the database and never decides what is accepted: the records go into an ADR-004
 * backup document and are validated, quarantined and applied by the SAME
 * `prepareImport`/`applyImport` stages a JSON backup goes through (size cap →
 * Stage A → upgrade → Stage B → confirm → pre-import snapshot → atomic replace).
 *
 * Hostile-input rules (E8) hold here too: no `eval`, no dynamic code, bounded
 * work per line, and every line that cannot become a record is carried into the
 * recovery file instead of being dropped.
 */

import type { List, Task } from '../../storage/types';

/** The V1 importers (Q8: JSON only in MVP). */
export type ForeignFormat = 'todotxt' | 'csv';

/** Every importable source the picker can route to. */
export type ImportFormat = 'json' | ForeignFormat;

/** Shared inputs both converters need (injected — converters stay pure). */
export type ConvertContext = {
  /** The TARGET profile's `meta.deviceId` (records land in this profile). */
  readonly deviceId: string;
  /** Epoch ms used for `createdAt`/`updatedAt` of records the source cannot date. */
  readonly now: number;
  /** Fallback target list name (formats without a list column / empty cells). */
  readonly listName: string;
};

/** A source line/row that could not become a task — never dropped silently (E4). */
export type RejectedRow = {
  /** 1-based line number in the source file (counting blank lines). */
  readonly line: number;
  /** The source text verbatim — enough to repair the file by hand. */
  readonly text: string;
  /** `RecoveryEntry.issues` shape: `"<field>: <reason>"` strings. */
  readonly issues: readonly string[];
};

/** Converter output: accepted records, target lists, and the rejects to quarantine. */
export type Conversion = {
  readonly lists: List[];
  readonly tasks: Task[];
  readonly rejected: RejectedRow[];
  /** Non-fatal notes carried into `ImportPlan.warnings` (local log only). */
  readonly notes: string[];
};

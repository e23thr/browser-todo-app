/**
 * Data-safety state (single signal, §5.1/§10 handoff).
 *
 * Everything the panel, the banners and the dialogs read lives here so there is exactly one
 * place that decides "what does this profile's storage look like right now". Writers are
 * `boot.ts` (once per session), `actions.ts` (after export/import/restore) and the panel
 * container (after a persist() request).
 */

import { signal } from '@preact/signals';

import { ONBOARDING_DONE } from './constants';
import { readOnboardingStep } from './flags';
import type {
  BootClassification,
  DataCounts,
  ExportState,
  PanelState,
  SnapshotMeta,
} from './types';

export interface DataSafetyState {
  /** `idle` → boot hasn't classified yet; `failed` → the DB never came up (§9.4 degrade). */
  readonly status: 'idle' | 'ready' | 'failed';
  readonly classification: BootClassification;
  /** `null` until the row inventory has been read. */
  readonly counts: DataCounts | null;
  /** Live rows exist? Cheap probe at boot, kept separate from the exact `counts`. */
  readonly hasData: boolean;
  /** `settings.lastBackupAt` (epoch ms), `null` = never. */
  readonly lastBackupAt: number | null;
  readonly snapshots: readonly SnapshotMeta[];
  /** Evidence that this profile has used the app before (§3.4 "fresh profile" discriminator). */
  readonly priorUse: boolean;
  /** First-run screen (S1) — only ever `true` when there is no prior-use evidence. */
  readonly onboarding: boolean;
  readonly exportState: ExportState;
  /** §5.1 panel-level async state (export / import / persist in flight). */
  readonly panelState: PanelState;
}

const INITIAL: DataSafetyState = {
  status: 'idle',
  classification: { kind: 'normal' },
  counts: null,
  hasData: false,
  lastBackupAt: null,
  snapshots: [],
  priorUse: false,
  // Decided by `initFirstRunFlag()` from main.tsx BEFORE the first render, so the first-run
  // screen is up on paint (§7 "shown before task UI") — but a directly rendered <App/>
  // (unit tests) stays a normal app shell until told otherwise.
  onboarding: false,
  exportState: 'idle',
  panelState: 'idle',
};

export const dataSafetyState = signal<DataSafetyState>({ ...INITIAL });

/**
 * Seed the first-run flag from the durable ADR-002 onboarding marker. Called by `main.tsx`
 * before `render()`; harmless to call more than once.
 */
export function initFirstRunFlag(): void {
  if (readOnboardingStep() === ONBOARDING_DONE) return;
  if (dataSafetyState.value.status !== 'idle') return; // boot already classified — it wins
  patchState({ onboarding: true });
}

/** Shallow-merge a patch into the store (all writers go through this). */
export function patchState(patch: Partial<DataSafetyState>): void {
  dataSafetyState.value = { ...dataSafetyState.value, ...patch };
}

/** Test seam: back to the untouched initial state. */
export function resetState(): void {
  dataSafetyState.value = { ...INITIAL };
}

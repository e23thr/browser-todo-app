/**
 * Conflict-copy surfacing (E8 S9) — every visible "Conflict copy of <task>"
 * with its three resolve actions. The list renders the ENGINE's summaries only
 * (§6.2 is pre-decided; there is nothing here that could re-merge), and each
 * action is handed back to the panel as bookkeeping.
 */

import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { absoluteDateTime } from '../data-safety/format';
import type { ConflictSummary } from '../../sync';
import type { ResolveAction } from './conflicts';

export interface ConflictListProps {
  readonly conflicts: readonly ConflictSummary[];
  readonly onResolve: (summary: ConflictSummary, action: ResolveAction) => void;
}

export function ConflictList({ conflicts, onResolve }: ConflictListProps): JSX.Element {
  return (
    <section
      class="sync-conflicts"
      data-testid="sync-conflicts"
      aria-labelledby="sync-conflicts-heading"
    >
      <h3 class="sync-conflicts-heading" id="sync-conflicts-heading">
        {t('sync.conflicts.heading', { count: conflicts.length })}
      </h3>
      <p class="sync-conflicts-body">{t('sync.conflicts.body')}</p>
      <ol class="sync-conflict-list">
        {conflicts.map((entry) => (
          <li class="sync-conflict" key={entry.copyId}>
            <p class="sync-conflict-title">{t('sync.conflicts.copyOf', { title: entry.title })}</p>
            <p class="field-hint">
              {t('sync.conflicts.other', { time: absoluteDateTime(entry.lostTo.updatedAt) })}
            </p>
            <div class="sync-resolve-actions">
              <button
                type="button"
                class="button button-secondary"
                onClick={() => {
                  onResolve(entry, 'keep-both');
                }}
              >
                {t('sync.resolve.keepBoth')}
              </button>
              <button
                type="button"
                class="button button-secondary"
                onClick={() => {
                  onResolve(entry, 'keep-copy');
                }}
              >
                {t('sync.resolve.keepCopy')}
              </button>
              <button
                type="button"
                class="button button-secondary"
                onClick={() => {
                  onResolve(entry, 'discard-copy');
                }}
              >
                {t('sync.resolve.discardCopy')}
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

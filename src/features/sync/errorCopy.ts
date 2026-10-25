/**
 * Error-code → catalog copy (ADR-006 Decision 6: the code maps 1:1 onto the
 * UI copy; the engine's English `message`/`detail` never replaces it — the
 * `detail` is appended verbatim as a technical footnote only).
 *
 * Every `sync.error.<slug>.*` key exists in BOTH locale catalogs (en+th);
 * `SLUG` is the closed code→key bridge, so a new engine code fails loudly here
 * rather than rendering a raw key.
 */

import { t } from '../../app/i18n';
import type { SyncError, SyncErrorCode } from '../../sync';

const SLUG: Readonly<Record<SyncErrorCode, string>> = {
  CONFIG: 'config',
  AUTH: 'auth',
  CORS: 'cors',
  NETWORK: 'network',
  REMOTE_MISSING: 'remoteMissing',
  CONFLICT_WRITE: 'conflictWrite',
  CORRUPT_REMOTE: 'corruptRemote',
  SYNC_FORMAT_UNKNOWN: 'syncFormatUnknown',
  SYNC_FORMAT_NEWER: 'syncFormatNewer',
  REMOTE_FULL: 'remoteFull',
  LOCAL_STORAGE: 'localStorage',
  LOCKED: 'locked',
  ABORTED: 'aborted',
};

export interface SyncErrorCopy {
  readonly title: string;
  readonly body: string;
  /** Engine-supplied specifics (artifact names, server detail) — shown as-is. */
  readonly detail?: string;
}

export function syncErrorCopy(error: SyncError): SyncErrorCopy {
  const slug = SLUG[error.code];
  const body = t(`sync.error.${slug}.body`);
  return {
    title: t(`sync.error.${slug}.title`),
    body,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  };
}

/** Title only — for announcement messages (`a11y.sync.failed`). */
export function syncErrorTitle(code: SyncErrorCode): string {
  return t(`sync.error.${SLUG[code]}.title`);
}

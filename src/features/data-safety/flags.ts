/**
 * Durable flags for the data-safety surface — ADR-002 Decision 7 only.
 *
 * The design spec names its own storage keys (`nudge.backup.snoozedUntil`, `warned.private`,
 * `onboarding.step`), but ADR-002 Decision 7 is the binding localStorage contract: three
 * allowed keys, all `todo:prefs:v1:`-namespaced, total budget 4 KiB, every access
 * try-guarded (Safari private mode can throw on ANY localStorage call — the app must survive
 * without mirrors).
 *
 * Encoding, inside the two keys this surface is allowed to use:
 *   - `todo:prefs:v1:onboardingStep`  → `'done'` once the first-run screen is finished. It is
 *     also the durable "this profile has used the app before" marker: if IndexedDB is evicted
 *     while localStorage survives, this is what tells the boot classifier "prior use, store
 *     empty" (§3.4 wiped row) instead of "fresh profile".
 *   - `todo:prefs:v1:dismissedBanners` → JSON array of strings:
 *       `'backup-reminder'`            permanently dismissed
 *       `'backup-reminder@1793000000000'` snoozed until that epoch-ms
 *     One-shot acknowledgements (private-browsing, recovery "start fresh") are plain ids here
 *     too, so the key list stays closed and the budget stays tiny.
 *
 * Nothing user-authored is ever written here (Decision 7: never task/list data).
 */

import { NOTICE_MARKS, ONBOARDING_DONE, PREFS_KEYS, SNOOZE_DAYS } from './constants';

/** In-memory mirror: localStorage can be unavailable, so it is read once and re-written whole. */
let onboarding: string | null = null;
let dismissed: string[] = [];
let loaded = false;

function safeStorage(): Storage | null {
  try {
    // Touching the getter can throw in hardened/private contexts, and `localStorage` itself
    // is not guaranteed to exist (§9.4).
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;

  const store = safeStorage();
  if (store === null) return;

  try {
    onboarding = store.getItem(PREFS_KEYS.onboarding);
  } catch {
    onboarding = null;
  }

  try {
    const raw = store.getItem(PREFS_KEYS.dismissed);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      dismissed = parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch {
    // Corrupt or unreadable flags degrade to "nothing dismissed" — never to a crash.
    dismissed = [];
  }
}

function persistDismissed(): void {
  const store = safeStorage();
  if (store === null) return;
  try {
    store.setItem(PREFS_KEYS.dismissed, JSON.stringify(dismissed));
  } catch {
    // Budget/quota/private-mode failure: snoozes then only last for this session.
  }
}

/** Test seam: forget the in-memory mirror so the next read hits localStorage again. */
export function resetFlags(): void {
  loaded = false;
  onboarding = null;
  dismissed = [];
}

/** `'done'` when the first-run screen was completed, otherwise `null`. */
export function readOnboardingStep(): string | null {
  load();
  return onboarding;
}

/** Mark the first-run screen finished (fires once, try-guarded like every prefs write). */
export function writeOnboardingDone(): void {
  load();
  onboarding = ONBOARDING_DONE;
  const store = safeStorage();
  if (store === null) return;
  try {
    store.setItem(PREFS_KEYS.onboarding, ONBOARDING_DONE);
  } catch {
    // Not fatal: the worst case is the first-run screen reappearing after a reload.
  }
}

/** The raw `dismissedBanners` entries (mostly useful for tests/diagnostics). */
export function readDismissed(): readonly string[] {
  load();
  return [...dismissed];
}

/** `id@<epoch ms>` when snoozed, `'id'` when dismissed for good, `null` when active. */
function entryFor(id: string): string | null {
  load();
  return dismissed.find((entry) => entry === id || entry.startsWith(`${id}@`)) ?? null;
}

/** Is `id` suppressed right now (permanently dismissed, or snoozed into the future)? */
export function isSuppressed(id: string, now: number): boolean {
  const entry = entryFor(id);
  if (entry === null) return false;
  if (entry === id) return true;
  const until = Number(entry.slice(id.length + 1));
  return Number.isFinite(until) && until > now;
}

/** Snooze `id` for `days` (banner close and "Remind me later" both land here). */
export function snooze(id: string, days: number = SNOOZE_DAYS, now: number = Date.now()): void {
  load();
  setEntry(id, `${id}@${String(now + days * 86_400_000)}`);
}

/** Suppress `id` for good (used for one-shot acknowledgements). */
export function dismissForever(id: string): void {
  load();
  setEntry(id, id);
}

/** Re-enable `id` (e.g. a condition re-armed after a successful export). */
export function restore(id: string): void {
  load();
  setEntry(id, null);
}

/**
 * Replace whatever `prefix` recorded with `entry` (`null` clears it) and prune expired
 * snoozes, so the array stays inside Decision 7's 4 KiB budget.
 */
function setEntry(prefix: string, entry: string | null): void {
  const now = Date.now();
  const kept = dismissed.filter((existing) => {
    if (existing === prefix || existing.startsWith(`${prefix}@`)) return false;
    const at = existing.indexOf('@');
    if (at === -1) return true;
    const until = Number(existing.slice(at + 1));
    return Number.isFinite(until) && until > now;
  });
  dismissed = entry === null ? kept : [...kept, entry];
  persistDismissed();
}

/* ------------------------- one-shot acknowledgements ------------------------- */

/** Has the private-browsing dialog been shown once for this profile (§3.5)? */
export function wasPrivateWarned(): boolean {
  return entryFor(NOTICE_MARKS.privateWarned) !== null;
}

/** Remember that the private-browsing dialog was shown. */
export function markPrivateWarned(): void {
  load();
  dismissForever(NOTICE_MARKS.privateWarned);
}

/** Epoch ms of the "Start fresh" acknowledgement, or `null` (§6.5 recovery screen). */
export function recoveryStartedAt(): number | null {
  const entry = entryFor(NOTICE_MARKS.recoveryStarted);
  if (entry === null) return null;
  const at = entry.indexOf('@');
  if (at === -1) return null;
  const value = Number(entry.slice(at + 1));
  return Number.isFinite(value) ? value : null;
}

/** Remember that the user chose "Start fresh" (value carries the moment it happened). */
export function markRecoveryStarted(now: number = Date.now()): void {
  load();
  setEntry(NOTICE_MARKS.recoveryStarted, `${NOTICE_MARKS.recoveryStarted}@${String(now)}`);
}

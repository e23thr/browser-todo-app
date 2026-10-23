/**
 * Data-safety constants (E3, docs/design/data-safety.md §2/§3/§9).
 *
 * Every threshold named by the design spec or PROJECT_ANALYSIS §5.5 lives here as a CODE
 * CONSTANT — there is deliberately no user-facing setting for any of them (OQ-4: the 14-day
 * backup nudge is a constant, not a preference).
 *
 * `localStorage` keys are NOT mine to invent: ADR-002 Decision 7 is the single decider for the
 * localStorage contract and its allowed list is closed (`theme`, `dismissedBanners`,
 * `onboardingStep`). Everything this surface remembers across a reload therefore rides in
 * those keys — see `flags.ts`.
 */

/** Backup-reminder nudge threshold (§3.2 `BACKUP_NUDGE_DAYS`, PROJECT_ANALYSIS §5.5 default 14). */
export const BACKUP_NUDGE_DAYS = 14;

/** "Remind me later" / banner close snooze (§6.3, §9 snooze bookkeeping). */
export const SNOOZE_DAYS = 7;

/** First run after a gap this long counts as "long absence" (§3.4, iOS 7-day rule). */
export const LONG_ABSENCE_DAYS = 7;

/** Quota meter tiers (§4.3): < 80% ok, 80–89% warn, >= 90% crit. */
export const QUOTA_WARN_RATIO = 0.8;
export const QUOTA_CRIT_RATIO = 0.9;

/** `estimate().quota` below this plus a denied persist() reads as ephemeral storage (§3.5). */
export const PRIVATE_QUOTA_BYTES = 50 * 1024 * 1024;

/** A > 30% record-count drop against the newest snapshot reads as "shrunken" (§3.4). */
export const SHRINK_RATIO = 0.3;

/** §2: never stack more than two T1/T2 banners; the rest collapse into "N more notices". */
export const MAX_VISIBLE_BANNERS = 2;

/** T4 toast lifetime (§9); the undo toast has its own no-auto-dismiss rule (§5.8). */
export const TOAST_LIFETIME_MS = 8000;

/**
 * Shrunken detection parses the newest snapshot payload — skip payloads above this size so a
 * large history can never stall boot (§9.1: boot work is bounded).
 */
export const MAX_SHRINK_PROBE_BYTES = 8 * 1024 * 1024;

/** ADR-002 Decision 7 allowed keys (closed list — namespaced `todo:prefs:v1:`). */
export const PREFS_KEYS = {
  /** Mirror of `settings.theme`, plus the onboarding step marker. */
  onboarding: 'todo:prefs:v1:onboardingStep',
  /** JSON string array of banner ids (`id` = dismissed, `id@<epoch ms>` = snoozed). */
  dismissed: 'todo:prefs:v1:dismissedBanners',
} as const;

/** `onboardingStep` values. Anything else (absent, corrupt) means "onboarding not finished". */
export const ONBOARDING_DONE = 'done';

/**
 * Banner ids in §2 escalation priority (highest first). Order is normative: when more than
 * `MAX_VISIBLE_BANNERS` would show, the earliest ids win and the rest become the overflow
 * "N more notices" control.
 */
export const BANNER_PRIORITY = [
  'long-absence',
  'shrunken',
  'quota-pending',
  'quota-warn',
  'persist-denied',
  'backup-reminder',
] as const;

export type BannerId = (typeof BANNER_PRIORITY)[number];

/** Is `id` a known banner (guards against a stray id reaching the priority list)? */
export function isBannerId(id: string): id is BannerId {
  return (BANNER_PRIORITY as readonly string[]).includes(id);
}

/** Sentinel entries stored inside `dismissedBanners` for one-shot acknowledgements. */
export const NOTICE_MARKS = {
  /** The private-browsing dialog has been shown once for this profile (§3.5). */
  privateWarned: 'private-browsing',
  /** "Start fresh" was chosen on the recovery screen (§6.5) — value: `id@<epoch ms>`. */
  recoveryStarted: 'recovery-started',
} as const;
